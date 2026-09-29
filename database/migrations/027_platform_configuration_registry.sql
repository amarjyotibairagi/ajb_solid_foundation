-- Migration 027: Control-plane configuration registry.
--
-- One declarative model for everything an operator can switch or tune from
-- the admin panel, and that application modules can extend:
--
--   config_definition  what may be configured: key, kind (feature | limit |
--                      setting), value type, bounds, default, the scopes at
--                      which it may be overridden, and whether tenant admins
--                      may edit it or tenant browsers may see it.
--   config_value       overrides at platform, plan, or tenant scope.
--
-- Resolution order (lowest to highest precedence):
--   definition default -> platform -> plan (tenant's current subscription)
--   -> tenant override (platform operator) -> tenant-local value
-- The last layer lives in each tenant schema's tenant_setting table and is
-- honoured by the tenant BFF only for tenant_editable keys.
--
-- plan_catalog.entitlements (migration 003) and each tenant schema's
-- subscription_entitlement table were never read by any code. Plan
-- entitlements are now config_value rows at plan scope; both legacy columns
-- are left in place, unused, to keep this migration non-destructive.

begin;

create table if not exists platform.config_definition (
  config_key text primary key check (config_key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$' and length(config_key) <= 96),
  kind text not null check (kind in ('feature', 'limit', 'setting')),
  value_type text not null check (value_type in ('boolean', 'integer', 'string', 'string_list')),
  label text not null check (length(btrim(label)) between 1 and 120),
  description text not null default '',
  category text not null default 'general' check (category ~ '^[a-z][a-z0-9_]{0,40}$'),
  module_code text check (module_code is null or module_code ~ '^[a-z][a-z0-9_]{1,40}$'),
  default_value jsonb not null,
  min_value numeric,
  max_value numeric,
  max_length integer check (max_length is null or max_length between 1 and 10000),
  allowed_values jsonb check (allowed_values is null or jsonb_typeof(allowed_values) = 'array'),
  scopes text[] not null default array['platform', 'plan', 'tenant']
    check (scopes <@ array['platform', 'plan', 'tenant'] and cardinality(scopes) >= 1),
  tenant_editable boolean not null default false,
  is_public boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind <> 'feature' or value_type = 'boolean'),
  check (kind <> 'limit' or value_type = 'integer'),
  check (min_value is null or max_value is null or min_value <= max_value),
  check (not tenant_editable or 'tenant' = any(scopes))
);

create table if not exists platform.config_value (
  value_id uuid primary key default gen_random_uuid(),
  scope_type text not null check (scope_type in ('platform', 'plan', 'tenant')),
  plan_id uuid references platform.plan_catalog(plan_id) on delete cascade,
  tenant_id uuid references platform.tenant_registry(tenant_id) on delete cascade,
  config_key text not null references platform.config_definition(config_key) on delete cascade,
  value jsonb not null,
  updated_by uuid references platform.platform_user(id) on delete set null,
  updated_at timestamptz not null default now(),
  check (
    (scope_type = 'platform' and plan_id is null and tenant_id is null)
    or (scope_type = 'plan' and plan_id is not null and tenant_id is null)
    or (scope_type = 'tenant' and tenant_id is not null and plan_id is null)
  )
);

create unique index if not exists config_value_scope_uidx
  on platform.config_value (
    scope_type,
    coalesce(plan_id, tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
    config_key
  );
create index if not exists config_value_tenant_idx on platform.config_value (tenant_id) where tenant_id is not null;
create index if not exists config_value_plan_idx on platform.config_value (plan_id) where plan_id is not null;

alter table platform.config_definition owner to platform_owner;
alter table platform.config_value owner to platform_owner;
revoke all on platform.config_definition, platform.config_value from public;
grant select on platform.config_definition, platform.config_value to platform_bff_runtime;

drop trigger if exists config_definition_set_updated_at on platform.config_definition;
create trigger config_definition_set_updated_at
  before update on platform.config_definition
  for each row execute function platform.set_updated_at();

-- Type and bounds validation shared by every write path. The tenant BFF
-- repeats the same checks for tenant-local values (it cannot call this, and a
-- tenant value never reaches the platform schema).
create or replace function platform.validate_config_value(p_key text, p_value jsonb)
returns void
language plpgsql
stable
set search_path = platform, pg_catalog
as $$
declare
  d config_definition%rowtype;
  v_number numeric;
  v_item jsonb;
begin
  select * into d from config_definition where config_key = p_key;
  if not found then
    raise exception 'Unknown configuration key %.', p_key using errcode = '22023';
  end if;

  if d.value_type = 'boolean' then
    if jsonb_typeof(p_value) <> 'boolean' then
      raise exception '% must be true or false.', p_key using errcode = '22023';
    end if;
  elsif d.value_type = 'integer' then
    if jsonb_typeof(p_value) <> 'number' then
      raise exception '% must be a whole number.', p_key using errcode = '22023';
    end if;
    v_number := (p_value #>> '{}')::numeric;
    if v_number <> trunc(v_number) then
      raise exception '% must be a whole number.', p_key using errcode = '22023';
    end if;
    if (d.min_value is not null and v_number < d.min_value) or (d.max_value is not null and v_number > d.max_value) then
      raise exception '% must be between % and %.', p_key, coalesce(d.min_value::text, '-inf'), coalesce(d.max_value::text, 'inf')
        using errcode = '22023';
    end if;
  elsif d.value_type = 'string' then
    if jsonb_typeof(p_value) <> 'string' then
      raise exception '% must be text.', p_key using errcode = '22023';
    end if;
    if d.max_length is not null and length(p_value #>> '{}') > d.max_length then
      raise exception '% must be at most % characters.', p_key, d.max_length using errcode = '22023';
    end if;
  elsif d.value_type = 'string_list' then
    if jsonb_typeof(p_value) <> 'array' then
      raise exception '% must be a list of text values.', p_key using errcode = '22023';
    end if;
    for v_item in select * from jsonb_array_elements(p_value) loop
      if jsonb_typeof(v_item) <> 'string' or (d.max_length is not null and length(v_item #>> '{}') > d.max_length) then
        raise exception '% contains an invalid entry.', p_key using errcode = '22023';
      end if;
    end loop;
  end if;

  if d.allowed_values is not null then
    if d.value_type = 'string_list' then
      if exists (select 1 from jsonb_array_elements(p_value) e where not d.allowed_values @> jsonb_build_array(e)) then
        raise exception '% contains a value that is not allowed.', p_key using errcode = '22023';
      end if;
    elsif not d.allowed_values @> jsonb_build_array(p_value) then
      raise exception '% is not one of the allowed values.', p_key using errcode = '22023';
    end if;
  end if;
end
$$;

create or replace function platform.config_value_validate_tg()
returns trigger
language plpgsql
set search_path = platform, pg_catalog
as $$
declare
  v_scopes text[];
begin
  select scopes into v_scopes from config_definition where config_key = new.config_key;
  if not (new.scope_type = any(v_scopes)) then
    raise exception '% cannot be set at % scope.', new.config_key, new.scope_type using errcode = '22023';
  end if;
  perform validate_config_value(new.config_key, new.value);
  new.updated_at := now();
  return new;
end
$$;

drop trigger if exists config_value_validate on platform.config_value;
create trigger config_value_validate
  before insert or update on platform.config_value
  for each row execute function platform.config_value_validate_tg();

-- Resolves every definition for one tenant. Returns values, the layer each
-- came from, and the metadata the tenant BFF needs to validate tenant-local
-- edits and filter what browsers may see.
create or replace function platform.resolve_tenant_config(p_tenant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = platform, pg_catalog
as $$
  with current_plan as (
    select s.plan_id, p.plan_code
      from tenant_subscription s
      join plan_catalog p on p.plan_id = s.plan_id
     where s.tenant_id = p_tenant_id
       and s.status in ('trialing', 'active', 'past_due', 'paused')
     order by s.created_at desc
     limit 1
  ),
  layered as (
    select d.config_key,
           d.default_value,
           pv.value as platform_value,
           lv.value as plan_value,
           tv.value as tenant_value,
           d.value_type, d.kind, d.tenant_editable, d.is_public,
           d.min_value, d.max_value, d.max_length, d.allowed_values
      from config_definition d
      left join config_value pv on pv.config_key = d.config_key and pv.scope_type = 'platform'
      left join config_value lv on lv.config_key = d.config_key and lv.scope_type = 'plan'
        and lv.plan_id = (select plan_id from current_plan)
      left join config_value tv on tv.config_key = d.config_key and tv.scope_type = 'tenant'
        and tv.tenant_id = p_tenant_id
  )
  select jsonb_build_object(
    'planCode', (select plan_code from current_plan),
    'values', coalesce(jsonb_object_agg(config_key, coalesce(tenant_value, plan_value, platform_value, default_value)), '{}'::jsonb),
    'sources', coalesce(jsonb_object_agg(config_key,
      case when tenant_value is not null then 'tenant'
           when plan_value is not null then 'plan'
           when platform_value is not null then 'platform'
           else 'default' end), '{}'::jsonb),
    'definitions', coalesce(jsonb_object_agg(config_key, jsonb_strip_nulls(jsonb_build_object(
      'kind', kind,
      'valueType', value_type,
      'tenantEditable', tenant_editable,
      'isPublic', is_public,
      'min', min_value,
      'max', max_value,
      'maxLength', max_length,
      'allowed', allowed_values
    ))), '{}'::jsonb)
  )
  from layered
$$;

create or replace function platform.resolve_platform_config()
returns jsonb
language sql
stable
security definer
set search_path = platform, pg_catalog
as $$
  select coalesce(jsonb_object_agg(d.config_key, coalesce(pv.value, d.default_value)), '{}'::jsonb)
    from config_definition d
    left join config_value pv on pv.config_key = d.config_key and pv.scope_type = 'platform'
$$;

-- Write path. p_scope_ref is NULL for platform scope, a plan_code for plan
-- scope, or a tenant_key for tenant scope. A NULL p_value clears the override.
create or replace function platform.set_config_value(
  p_scope_type text,
  p_scope_ref text,
  p_key text,
  p_value jsonb,
  p_actor_user_id uuid
) returns boolean
language plpgsql
security definer
set search_path = platform, pg_catalog
as $$
declare
  v_plan_id uuid;
  v_tenant_id uuid;
  v_scope_id uuid;
begin
  if p_scope_type = 'plan' then
    select plan_id into v_plan_id from plan_catalog where plan_code = p_scope_ref;
    if not found then raise exception 'Unknown plan %.', p_scope_ref using errcode = '22023'; end if;
  elsif p_scope_type = 'tenant' then
    select tenant_id into v_tenant_id from tenant_registry
     where tenant_key = p_scope_ref and lifecycle_status not in ('deleting', 'deleted');
    if not found then raise exception 'Unknown tenant %.', p_scope_ref using errcode = '22023'; end if;
  elsif p_scope_type <> 'platform' or p_scope_ref is not null then
    raise exception 'Invalid configuration scope.' using errcode = '22023';
  end if;
  v_scope_id := coalesce(v_plan_id, v_tenant_id, '00000000-0000-0000-0000-000000000000'::uuid);

  if p_value is null or p_value = 'null'::jsonb then
    delete from config_value
     where scope_type = p_scope_type
       and coalesce(plan_id, tenant_id, '00000000-0000-0000-0000-000000000000'::uuid) = v_scope_id
       and config_key = p_key;
  else
    insert into config_value (scope_type, plan_id, tenant_id, config_key, value, updated_by)
    values (p_scope_type, v_plan_id, v_tenant_id, p_key, p_value, p_actor_user_id)
    on conflict (scope_type, coalesce(plan_id, tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), config_key)
    do update set value = excluded.value, updated_by = excluded.updated_by;
  end if;

  insert into platform_audit (user_id, tenant_id, feature, action, status, resource_type, resource_id, policy_decision)
  values (
    p_actor_user_id, v_tenant_id, 'configuration',
    case when p_value is null or p_value = 'null'::jsonb then 'config_cleared' else 'config_set' end,
    'SUCCESS', 'config:' || p_scope_type, left(coalesce(p_scope_ref || ':', '') || p_key, 200), 'allow'
  );
  return true;
end
$$;

-- Plans ----------------------------------------------------------------------

create or replace function platform.upsert_plan(
  p_plan_code text,
  p_display_name text,
  p_audience text,
  p_is_active boolean,
  p_actor_user_id uuid
) returns uuid
language plpgsql
security definer
set search_path = platform, pg_catalog
as $$
declare
  v_plan_id uuid;
begin
  insert into plan_catalog (plan_code, display_name, audience, is_active)
  values (p_plan_code, btrim(p_display_name), p_audience, coalesce(p_is_active, true))
  on conflict (plan_code) do update
    set display_name = excluded.display_name,
        audience = excluded.audience,
        is_active = excluded.is_active,
        version = plan_catalog.version + 1
  returning plan_id into v_plan_id;
  insert into platform_audit (user_id, feature, action, status, resource_type, resource_id, policy_decision)
  values (p_actor_user_id, 'plans', 'plan_saved', 'SUCCESS', 'plan', p_plan_code, 'allow');
  return v_plan_id;
end
$$;

create or replace function platform.assign_tenant_plan(
  p_tenant_key text,
  p_plan_code text,
  p_status text,
  p_actor_user_id uuid
) returns boolean
language plpgsql
security definer
set search_path = platform, pg_catalog
as $$
declare
  v_tenant_id uuid;
  v_plan_id uuid;
begin
  if p_status not in ('trialing', 'active', 'past_due', 'paused') then
    raise exception 'Invalid subscription status.' using errcode = '22023';
  end if;
  select tenant_id into v_tenant_id from tenant_registry
   where tenant_key = p_tenant_key and lifecycle_status not in ('deleting', 'deleted')
   for update;
  if not found then return false; end if;
  select plan_id into v_plan_id from plan_catalog where plan_code = p_plan_code and is_active;
  if not found then raise exception 'Plan % is not available.', p_plan_code using errcode = '22023'; end if;

  update tenant_subscription
     set status = 'cancelled', period_end = greatest(coalesce(period_start, now()) + interval '1 microsecond', now())
   where tenant_id = v_tenant_id and status in ('trialing', 'active', 'past_due', 'paused');

  insert into tenant_subscription (tenant_id, plan_id, status, entitlement_version, period_start)
  select v_tenant_id, v_plan_id, p_status, version, now() from plan_catalog where plan_id = v_plan_id;

  insert into platform_audit (user_id, tenant_id, feature, action, status, resource_type, resource_id, policy_decision)
  values (p_actor_user_id, v_tenant_id, 'plans', 'tenant_plan_assigned:' || p_plan_code, 'SUCCESS', 'tenant', p_tenant_key, 'allow');
  return true;
end
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'platform.validate_config_value(text, jsonb)',
    'platform.config_value_validate_tg()',
    'platform.resolve_tenant_config(uuid)',
    'platform.resolve_platform_config()',
    'platform.set_config_value(text, text, text, jsonb, uuid)',
    'platform.upsert_plan(text, text, text, boolean, uuid)',
    'platform.assign_tenant_plan(text, text, text, uuid)'
  ] loop
    execute format('alter function %s owner to platform_owner', fn);
    execute format('revoke all on function %s from public', fn);
  end loop;
end
$$;

grant execute on function
  platform.resolve_tenant_config(uuid),
  platform.resolve_platform_config(),
  platform.set_config_value(text, text, text, jsonb, uuid),
  platform.upsert_plan(text, text, text, boolean, uuid),
  platform.assign_tenant_plan(text, text, text, uuid)
  to platform_bff_runtime;

grant execute on function platform.resolve_tenant_config(uuid) to tenant_registry_reader_login;

-- Foundation definitions ------------------------------------------------------
-- Application modules add their own rows in later migrations. Changing a
-- default here changes behaviour for every tenant without an override.

insert into platform.config_definition
  (config_key, kind, value_type, label, description, category, module_code,
   default_value, min_value, max_value, max_length, scopes, tenant_editable, is_public)
values
  ('feature.user_invitations', 'feature', 'boolean', 'User invitations',
   'Tenant administrators may invite users who then set their own password.', 'identity', null,
   'true', null, null, null, array['platform', 'plan', 'tenant'], false, true),
  ('module.delegations', 'feature', 'boolean', 'Capability delegation module',
   'Example application module: per-user delegation of allow-listed permissions to managers.', 'modules', 'delegations',
   'false', null, null, null, array['platform', 'plan', 'tenant'], false, true),
  ('limit.users.max', 'limit', 'integer', 'Maximum users',
   'Maximum non-departed user accounts per tenant. 0 means unlimited.', 'limits', null,
   '0', 0, 1000000, null, array['platform', 'plan', 'tenant'], false, false),
  ('auth.session_ttl_minutes', 'setting', 'integer', 'Session lifetime (minutes)',
   'How long a tenant sign-in lasts.', 'security', null,
   '480', 15, 10080, null, array['platform', 'plan', 'tenant'], true, false),
  ('auth.lockout.max_failures', 'setting', 'integer', 'Failed sign-ins before lockout',
   'Consecutive failures for one account within the window before it is locked.', 'security', null,
   '10', 3, 100, null, array['platform', 'plan', 'tenant'], false, false),
  ('auth.lockout.duration_minutes', 'setting', 'integer', 'Lockout duration (minutes)',
   'How long an account stays locked after too many failures.', 'security', null,
   '15', 1, 1440, null, array['platform', 'plan', 'tenant'], false, false),
  ('auth.password.min_length', 'setting', 'integer', 'Minimum password length',
   'Applied when users set a password through an invitation.', 'security', null,
   '12', 12, 128, null, array['platform', 'plan', 'tenant'], true, true),
  ('invitations.ttl_hours', 'setting', 'integer', 'Invitation lifetime (hours)',
   'How long invitation links stay valid.', 'identity', null,
   '72', 1, 720, null, array['platform', 'plan', 'tenant'], false, false),
  ('branding.support_email', 'setting', 'string', 'Support email',
   'Shown to users on the sign-in page.', 'branding', null,
   '""', null, null, 320, array['platform', 'plan', 'tenant'], true, true),
  ('platform.product_name', 'setting', 'string', 'Product name',
   'Shown in the admin panel and tenant sign-in pages.', 'branding', null,
   '"Skeleton Platform"', null, null, 80, array['platform'], false, true),
  ('tenancy.reserved_subdomains', 'setting', 'string_list', 'Reserved subdomains',
   'Labels that can never be assigned to a tenant.', 'tenancy', null,
   '["www","api","admin","platform","app","mail","smtp","ftp","support","status","cdn","assets","static","auth","login","billing","docs","dev","test","staging","user","public"]',
   null, null, 63, array['platform'], false, false)
on conflict (config_key) do nothing;

insert into platform.plan_catalog (plan_code, display_name, audience)
values ('standard', 'Standard', 'b2b')
on conflict (plan_code) do nothing;

insert into platform.schema_migration (migration_key, migration_scope)
values ('027_platform_configuration_registry:v1', 'platform')
on conflict (migration_key) do nothing;

commit;
