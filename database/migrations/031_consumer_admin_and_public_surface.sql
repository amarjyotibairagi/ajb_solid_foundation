-- Migration 031: B2C administration from the admin panel, catalog-driven
-- B2C plans, and public-surface settings.
--
--   * platform.plan_catalog gains presentation fields; the public app's plan
--     list now comes from the catalog (audience b2c/both) instead of code.
--   * shared_state.public_surface_config(): the only platform data the
--     public BFF (consumer_bff_login) may read: product name, its own public
--     origin (configurable here when PUBLIC_PUBLIC_ORIGIN is unset), and the
--     active B2C plans.
--   * consumer.admin_* functions, owned by a NOLOGIN BYPASSRLS role with
--     narrow grants (the pattern of migration 013), let the platform BFF list
--     and manage individual users without any direct consumer-table access.

begin;

-- 1. Plan presentation ---------------------------------------------------------

alter table platform.plan_catalog
  add column if not exists description text not null default '',
  add column if not exists price_monthly numeric(12, 2) check (price_monthly is null or price_monthly >= 0),
  add column if not exists highlights jsonb not null default '[]'::jsonb check (jsonb_typeof(highlights) = 'array'),
  add column if not exists sort_order integer not null default 100;

insert into platform.plan_catalog (plan_code, display_name, audience, description, price_monthly, highlights, sort_order)
values
  ('free', 'Free Individual', 'b2c', 'Essential tools for individual creators.', 0,
   '["1 workspace project", "500MB storage", "Community support"]', 10),
  ('plus', 'Plus Creator', 'b2c', 'More capacity for active individual work.', 12,
   '["5 active projects", "10GB storage", "Priority support"]', 20),
  ('pro', 'Pro Engineer', 'b2c', 'Advanced tools and collaboration.', 29,
   '["Unlimited projects", "100GB storage", "Shared workspaces"]', 30),
  ('ultra', 'Ultra Master', 'b2c', 'Dedicated capacity and premium support.', 79,
   '["All Pro features", "1TB storage", "24/7 support"]', 40)
on conflict (plan_code) do nothing;

create or replace function platform.update_plan_presentation(
  p_plan_code text,
  p_description text,
  p_price_monthly numeric,
  p_highlights jsonb,
  p_sort_order integer,
  p_actor_user_id uuid
) returns boolean
language plpgsql
security definer
set search_path = platform, pg_catalog
as $$
begin
  if p_highlights is not null and (jsonb_typeof(p_highlights) <> 'array' or jsonb_array_length(p_highlights) > 20
     or exists (select 1 from jsonb_array_elements(p_highlights) e where jsonb_typeof(e) <> 'string' or length(e #>> '{}') > 120)) then
    raise exception 'Highlights must be up to 20 short text items.' using errcode = '22023';
  end if;
  update plan_catalog
     set description = coalesce(left(p_description, 500), description),
         price_monthly = p_price_monthly,
         highlights = coalesce(p_highlights, highlights),
         sort_order = coalesce(p_sort_order, sort_order)
   where plan_code = p_plan_code;
  if not found then return false; end if;
  insert into platform_audit (user_id, feature, action, status, resource_type, resource_id, policy_decision)
  values (p_actor_user_id, 'plans', 'plan_presentation_saved', 'SUCCESS', 'plan', p_plan_code, 'allow');
  return true;
end
$$;
alter function platform.update_plan_presentation(text, text, numeric, jsonb, integer, uuid) owner to platform_owner;
revoke all on function platform.update_plan_presentation(text, text, numeric, jsonb, integer, uuid) from public;
grant execute on function platform.update_plan_presentation(text, text, numeric, jsonb, integer, uuid) to platform_bff_runtime;

-- 2. Public surface ------------------------------------------------------------

insert into platform.config_definition
  (config_key, kind, value_type, label, description, category, module_code,
   default_value, min_value, max_value, max_length, scopes, tenant_editable, is_public)
values
  ('surfaces.public_origin', 'setting', 'string', 'Public app origin',
   'https origin of the individual-user (B2C) app, e.g. https://user.example.com. Used when PUBLIC_PUBLIC_ORIGIN is not set.',
   'surfaces', null, '""', null, null, 255, array['platform'], false, false)
on conflict (config_key) do nothing;

create or replace function shared_state.public_surface_config()
returns jsonb
language sql
stable
security definer
set search_path = platform, pg_catalog
as $$
  select jsonb_build_object(
    'productName', coalesce(
      (select value #>> '{}' from config_value where scope_type = 'platform' and config_key = 'platform.product_name'),
      (select default_value #>> '{}' from config_definition where config_key = 'platform.product_name')),
    'publicOrigin', coalesce(
      (select value #>> '{}' from config_value where scope_type = 'platform' and config_key = 'surfaces.public_origin'), ''),
    'plans', coalesce((
      select jsonb_agg(jsonb_build_object(
               'code', plan_code, 'name', display_name, 'priceMonthly', price_monthly,
               'description', description, 'features', highlights, 'version', version)
             order by sort_order, plan_code)
        from plan_catalog where is_active and audience in ('b2c', 'both')), '[]'::jsonb)
  )
$$;
alter function shared_state.public_surface_config() owner to platform_owner;
revoke all on function shared_state.public_surface_config() from public;
grant execute on function shared_state.public_surface_config() to consumer_bff_login, platform_bff_runtime;

-- 3. Consumer administration -----------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'consumer_admin_function_owner') then
    create role consumer_admin_function_owner nologin noinherit nosuperuser nocreatedb nocreaterole bypassrls;
  end if;
end
$$;
alter role consumer_admin_function_owner nologin noinherit nosuperuser nocreatedb nocreaterole bypassrls;
comment on role consumer_admin_function_owner is
  'NOLOGIN owner of consumer.admin_* functions called by the platform BFF. Crosses FORCE RLS for operator actions only.';

grant usage on schema consumer to consumer_admin_function_owner;
grant select on consumer.user_account, consumer.subscription, consumer.workspace_project,
  consumer.group_membership, consumer.audit_event to consumer_admin_function_owner;
grant update (account_status, updated_at) on consumer.user_account to consumer_admin_function_owner;
grant select, delete on consumer.user_session to consumer_admin_function_owner;
grant insert on consumer.subscription to consumer_admin_function_owner;
grant update (status, period_end, updated_at) on consumer.subscription to consumer_admin_function_owner;
grant insert on consumer.audit_event to consumer_admin_function_owner;
grant usage on schema platform to consumer_admin_function_owner;
grant select on platform.plan_catalog to consumer_admin_function_owner;

create or replace function consumer.admin_list_users(
  p_search text,
  p_status text,
  p_plan_code text,
  p_limit integer,
  p_offset integer
) returns table (
  user_id uuid, username text, display_name text, email text, account_status text,
  plan_code text, subscription_status text, created_at timestamptz, active_sessions integer, total_count bigint
)
language sql
stable
security definer
set search_path = consumer, pg_catalog
as $$
  select u.user_id, u.username, u.display_name, u.email_normalized, u.account_status,
         s.plan_code, s.status, u.created_at,
         (select count(*)::int from user_session us where us.user_id = u.user_id and us.expires_at > now()),
         count(*) over ()
    from user_account u
    left join lateral (
      select plan_code, status from subscription
       where subscription.user_id = u.user_id and status in ('trialing', 'active', 'past_due', 'paused')
       order by created_at desc limit 1
    ) s on true
   where u.account_status <> 'deleted'
     and (p_search is null or lower(u.username) like '%' || lower(p_search) || '%'
          or lower(u.display_name) like '%' || lower(p_search) || '%'
          or lower(coalesce(u.email_normalized, '')) like '%' || lower(p_search) || '%')
     and (p_status is null or u.account_status = p_status)
     and (p_plan_code is null or s.plan_code = p_plan_code)
   order by u.created_at desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

create or replace function consumer.admin_get_user(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = consumer, pg_catalog
as $$
  select jsonb_build_object(
    'user', jsonb_build_object('userId', u.user_id, 'username', u.username, 'displayName', u.display_name,
                               'email', u.email_normalized, 'status', u.account_status, 'createdAt', u.created_at),
    'subscriptions', coalesce((select jsonb_agg(jsonb_build_object('planCode', s.plan_code, 'status', s.status,
                                 'periodStart', s.period_start, 'periodEnd', s.period_end, 'createdAt', s.created_at)
                               order by s.created_at desc)
                               from subscription s where s.user_id = u.user_id), '[]'::jsonb),
    'projects', (select count(*) from workspace_project p where p.owner_user_id = u.user_id),
    'groups', (select count(*) from group_membership g where g.user_id = u.user_id),
    'activeSessions', (select count(*) from user_session us where us.user_id = u.user_id and us.expires_at > now()),
    'recentEvents', coalesce((select jsonb_agg(e order by e.occurred_at desc) from (
        select action, outcome, occurred_at from audit_event
         where actor_user_id = u.user_id or resource_id = u.user_id
         order by occurred_at desc limit 20) e), '[]'::jsonb)
  )
  from user_account u where u.user_id = p_user_id
$$;

create or replace function consumer.admin_set_user_status(p_user_id uuid, p_status text)
returns boolean
language plpgsql
security definer
set search_path = consumer, pg_catalog
as $$
declare
  v_current text;
begin
  if p_status not in ('active', 'suspended') then
    raise exception 'Status must be active or suspended.' using errcode = '22023';
  end if;
  select account_status into v_current from user_account where user_id = p_user_id for update;
  if not found then return false; end if;
  if v_current not in ('active', 'suspended', 'pending') then
    raise exception 'Account is % and cannot be changed here.', v_current using errcode = '55000';
  end if;
  update user_account set account_status = p_status, updated_at = now() where user_id = p_user_id;
  if p_status = 'suspended' then
    delete from user_session where user_id = p_user_id;
  end if;
  insert into audit_event (actor_user_id, action, resource_type, resource_id, outcome)
  values (null, case when p_status = 'suspended' then 'admin:suspend' else 'admin:reactivate' end, 'user_account', p_user_id, 'success');
  return true;
end
$$;

create or replace function consumer.admin_revoke_sessions(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = consumer, pg_catalog
as $$
declare
  v_count integer;
begin
  delete from user_session where user_id = p_user_id;
  get diagnostics v_count = row_count;
  insert into audit_event (actor_user_id, action, resource_type, resource_id, outcome)
  values (null, 'admin:revoke_sessions', 'user_account', p_user_id, 'success');
  return v_count;
end
$$;

create or replace function consumer.admin_set_plan(p_user_id uuid, p_plan_code text, p_status text)
returns boolean
language plpgsql
security definer
set search_path = consumer, pg_catalog
as $$
declare
  v_version integer;
begin
  if p_status not in ('trialing', 'active', 'past_due', 'paused') then
    raise exception 'Invalid subscription status.' using errcode = '22023';
  end if;
  select version into v_version from platform.plan_catalog
   where plan_code = p_plan_code and is_active and audience in ('b2c', 'both');
  if not found then
    raise exception 'Plan % is not an active individual plan.', p_plan_code using errcode = '22023';
  end if;
  perform 1 from user_account where user_id = p_user_id and account_status <> 'deleted' for update;
  if not found then return false; end if;
  update subscription
     set status = 'cancelled', period_end = greatest(coalesce(period_start, now()) + interval '1 microsecond', now()), updated_at = now()
   where user_id = p_user_id and status in ('trialing', 'active', 'past_due', 'paused');
  insert into subscription (user_id, plan_code, status, entitlement_version, period_start)
  values (p_user_id, p_plan_code, p_status, v_version, now());
  insert into audit_event (actor_user_id, action, resource_type, resource_id, outcome)
  values (null, 'admin:set_plan:' || p_plan_code, 'subscription', p_user_id, 'success');
  return true;
end
$$;

create or replace function consumer.admin_stats()
returns jsonb
language sql
stable
security definer
set search_path = consumer, pg_catalog
as $$
  select jsonb_build_object(
    'total', (select count(*) from user_account where account_status <> 'deleted'),
    'byStatus', coalesce((select jsonb_object_agg(account_status, n) from (
        select account_status, count(*) n from user_account group by account_status) x), '{}'::jsonb),
    'byPlan', coalesce((select jsonb_object_agg(plan_code, n) from (
        select plan_code, count(*) n from subscription
         where status in ('trialing', 'active', 'past_due', 'paused') group by plan_code) y), '{}'::jsonb),
    'activeSessions', (select count(*) from user_session where expires_at > now())
  )
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'consumer.admin_list_users(text, text, text, integer, integer)',
    'consumer.admin_get_user(uuid)',
    'consumer.admin_set_user_status(uuid, text)',
    'consumer.admin_revoke_sessions(uuid)',
    'consumer.admin_set_plan(uuid, text, text)',
    'consumer.admin_stats()'
  ] loop
    execute format('alter function %s owner to consumer_admin_function_owner', fn);
    execute format('revoke all on function %s from public', fn);
    execute format('grant execute on function %s to platform_bff_runtime', fn);
  end loop;
end
$$;

grant usage on schema consumer to platform_bff_runtime;

insert into platform.schema_migration (migration_key, migration_scope)
values ('031_consumer_admin_and_public_surface:v1', 'platform')
on conflict (migration_key) do nothing;

commit;
