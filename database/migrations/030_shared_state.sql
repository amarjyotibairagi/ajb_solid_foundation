-- Migration 030: Shared throttle and rate-limit counters.
--
-- Login lockouts and request rate limits used to live in each Node process,
-- which is only correct with one process per surface. With
-- SHARED_STATE_BACKEND=postgres the BFFs keep them here instead, so any
-- number of processes (or hosts) enforce the same limits.
--
-- UNLOGGED: counters are cheap to lose on a crash and not worth WAL traffic.
-- Callers never touch the table; they call SECURITY DEFINER functions that
-- prefix every key with session_user (the authenticated login role; current_user
-- inside a SECURITY DEFINER function would be the owner), so the platform, public and tenant BFFs
-- cannot read, reset or exhaust each other's counters.

begin;

create schema if not exists shared_state authorization platform_owner;
revoke all on schema shared_state from public;

create unlogged table if not exists shared_state.counter (
  counter_key text primary key check (length(counter_key) <= 512),
  window_started_at timestamptz not null,
  window_ms integer not null check (window_ms > 0),
  hits integer not null default 0,
  locked_until timestamptz,
  expires_at timestamptz not null
);
create index if not exists shared_state_counter_expiry_idx on shared_state.counter (expires_at);
alter table shared_state.counter owner to platform_owner;
revoke all on shared_state.counter from public;

create or replace function shared_state.purge_expired()
returns void
language sql
security definer
set search_path = shared_state, pg_catalog
as $$
  delete from counter where expires_at < now()
$$;

-- Fixed-window request counter.
create or replace function shared_state.rate_hit(p_key text, p_window_ms integer)
returns table (hits integer, ttl_ms integer)
language plpgsql
security definer
set search_path = shared_state, pg_catalog
as $$
declare
  v_key text := session_user || ':' || p_key;
  v_row counter%rowtype;
begin
  if p_window_ms is null or p_window_ms < 1 then
    raise exception 'Window must be positive.' using errcode = '22023';
  end if;
  insert into counter as c (counter_key, window_started_at, window_ms, hits, expires_at)
  values (v_key, now(), p_window_ms, 1, now() + make_interval(secs => p_window_ms / 1000.0))
  on conflict (counter_key) do update
    set hits = case when c.window_started_at + make_interval(secs => c.window_ms / 1000.0) <= now() then 1 else c.hits + 1 end,
        window_started_at = case when c.window_started_at + make_interval(secs => c.window_ms / 1000.0) <= now() then now() else c.window_started_at end,
        window_ms = excluded.window_ms,
        expires_at = case when c.window_started_at + make_interval(secs => c.window_ms / 1000.0) <= now()
                          then excluded.expires_at else c.expires_at end
  returning * into v_row;
  if random() < 0.01 then perform purge_expired(); end if;
  hits := v_row.hits;
  ttl_ms := greatest(0, (extract(epoch from (v_row.expires_at - now())) * 1000)::integer);
  return next;
end
$$;

create or replace function shared_state.rate_peek(p_key text)
returns table (hits integer, ttl_ms integer)
language sql
stable
security definer
set search_path = shared_state, pg_catalog
as $$
  select coalesce(max(c.hits), 0)::integer,
         coalesce(max(greatest(0, (extract(epoch from (c.expires_at - now())) * 1000)::integer)), 0)::integer
    from counter c
   where c.counter_key = session_user || ':' || p_key and c.expires_at > now()
$$;

create or replace function shared_state.throttle_locked(p_key text)
returns boolean
language sql
stable
security definer
set search_path = shared_state, pg_catalog
as $$
  select exists (
    select 1 from counter
     where counter_key = session_user || ':' || p_key and locked_until > now()
  )
$$;

-- Records a failed attempt; returns true when the key is now locked.
create or replace function shared_state.throttle_failure(p_key text, p_window_ms integer, p_max integer, p_lockout_ms integer)
returns boolean
language plpgsql
security definer
set search_path = shared_state, pg_catalog
as $$
declare
  v_row counter%rowtype;
begin
  perform rate_hit(p_key, p_window_ms);
  update counter
     set locked_until = case when hits >= p_max then now() + make_interval(secs => p_lockout_ms / 1000.0) else locked_until end,
         expires_at = greatest(expires_at, case when hits >= p_max then now() + make_interval(secs => p_lockout_ms / 1000.0) else expires_at end)
   where counter_key = session_user || ':' || p_key
  returning * into v_row;
  return v_row.locked_until is not null and v_row.locked_until > now();
end
$$;

create or replace function shared_state.throttle_clear(p_key text)
returns void
language sql
security definer
set search_path = shared_state, pg_catalog
as $$
  delete from counter where counter_key = session_user || ':' || p_key
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'shared_state.purge_expired()',
    'shared_state.rate_hit(text, integer)',
    'shared_state.rate_peek(text)',
    'shared_state.throttle_locked(text)',
    'shared_state.throttle_failure(text, integer, integer, integer)',
    'shared_state.throttle_clear(text)'
  ] loop
    execute format('alter function %s owner to platform_owner', fn);
    execute format('revoke all on function %s from public', fn);
  end loop;
end
$$;

grant usage on schema shared_state to platform_bff_runtime, consumer_bff_login, tenant_registry_reader_login;
grant execute on function
  shared_state.rate_hit(text, integer),
  shared_state.rate_peek(text),
  shared_state.throttle_locked(text),
  shared_state.throttle_failure(text, integer, integer, integer),
  shared_state.throttle_clear(text)
  to platform_bff_runtime, consumer_bff_login, tenant_registry_reader_login;

insert into platform.schema_migration (migration_key, migration_scope)
values ('030_shared_state:v1', 'platform')
on conflict (migration_key) do nothing;

commit;
