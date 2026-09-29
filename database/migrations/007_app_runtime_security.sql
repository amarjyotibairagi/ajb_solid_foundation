-- Runtime authentication/session support for the public and tenant BFFs.
-- Login roles must be created before this migration is applied.

begin;

create table if not exists consumer.user_session (
  session_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references consumer.user_account(user_id) on delete cascade,
  token_hash text not null unique,
  csrf_hash text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check (expires_at > created_at)
);

create index if not exists consumer_user_session_expiry_idx
  on consumer.user_session (expires_at);

alter table consumer.user_session owner to consumer_owner;
revoke all on consumer.user_session from public, consumer_runtime;
grant usage on schema consumer to consumer_bff_login;
grant select, insert, update, delete on consumer.user_session to consumer_bff_login;

create or replace function consumer.lookup_login_candidate(login_identifier text)
returns table (
  user_id uuid,
  username text,
  display_name text,
  email_normalized text,
  password_hash text,
  account_status text,
  plan_code text,
  subscription_status text
)
language sql
stable
security definer
set search_path = pg_catalog, consumer
as $$
  select
    u.user_id,
    u.username,
    u.display_name,
    u.email_normalized,
    u.password_hash,
    u.account_status,
    coalesce(s.plan_code, 'free'),
    coalesce(s.status, 'active')
  from consumer.user_account u
  left join consumer.subscription s on s.user_id = u.user_id
  where lower(u.username) = lower(login_identifier)
     or lower(u.email_normalized) = lower(login_identifier)
  order by s.updated_at desc nulls last
  limit 1
$$;

alter function consumer.lookup_login_candidate(text) owner to consumer_owner;
revoke all on function consumer.lookup_login_candidate(text) from public, consumer_runtime;
grant execute on function consumer.lookup_login_candidate(text) to consumer_bff_login;

-- Tenant schemas get user_session and their permission catalog from the
-- versioned tenant migrations (database/migrations/tenant/versions).

insert into platform.schema_migration (migration_key, migration_scope)
values ('007_app_runtime_security:v1', 'grants')
on conflict (migration_key) do nothing;

commit;
