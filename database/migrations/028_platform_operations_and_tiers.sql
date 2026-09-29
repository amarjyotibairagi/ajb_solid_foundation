-- Migration 028: Background operations and the pooled connection tier.
--
--   * New job types run by the provisioning worker and started from the
--     admin panel: 'migrate' (tenant schema upgrade), 'relocate_database'
--     (move tenant data between the VDS and a tenant-supplied PostgreSQL),
--     'relocate_storage' (move stored objects to the active storage backend).
--   * Lifecycle state 'relocating': the tenant is briefly in maintenance
--     while its data moves; the tenant BFF answers 503 meanwhile.
--   * connection_tier: 'dedicated' (default; own login role, credential file
--     and PgBouncer entry) or 'pooled' (shares tenant_pool_login and one
--     PgBouncer pool). Both keep schema-per-tenant isolation, per-tenant
--     runtime roles and forced RLS; pooled trades the per-tenant login
--     credential for connection reuse. See docs/architecture/adr-001.

begin;

alter table platform.tenant_provisioning_job
  add column if not exists job_params jsonb not null default '{}'::jsonb
    check (jsonb_typeof(job_params) = 'object');

alter table platform.tenant_provisioning_job
  drop constraint if exists tenant_provisioning_job_job_type_check;
alter table platform.tenant_provisioning_job
  add constraint tenant_provisioning_job_job_type_check
    check (job_type in ('provision', 'deprovision', 'migrate', 'relocate_database', 'relocate_storage'));

alter table platform.tenant_registry
  drop constraint if exists tenant_registry_lifecycle_status_check;
alter table platform.tenant_registry
  add constraint tenant_registry_lifecycle_status_check
    check (lifecycle_status in (
      'provisioning', 'active', 'suspended', 'migration_failed', 'relocating',
      'provisioning_failed', 'deleting', 'deletion_failed', 'deleted'
    ));

alter table platform.tenant_registry
  add column if not exists connection_tier text not null default 'dedicated'
    check (connection_tier in ('dedicated', 'pooled'));

-- Shared login for pooled tenants. It holds no privileges of its own; the
-- provisioner grants it membership (SET only, no INHERIT) in each pooled
-- tenant's runtime role. Its password is set outside migrations, like every
-- other login role (scripts/bootstrap-runtime-roles.mjs).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'tenant_pool_login') then
    create role tenant_pool_login nologin noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end
$$;
alter role tenant_pool_login noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
alter role tenant_pool_login set statement_timeout = '30s';
alter role tenant_pool_login set lock_timeout = '5s';
alter role tenant_pool_login set idle_in_transaction_session_timeout = '15s';
grant connect on database platform_db to tenant_pool_login;

-- Identity invariants: a pooled tenant's login_role is the shared pool login;
-- a dedicated tenant keeps <schema>_login. The tier itself is immutable.
create or replace function platform.enforce_tenant_immutability()
returns trigger as $$
begin
  if tg_op = 'INSERT' then
    if new.identity_scheme = 'tenant_key_v1' then
      if new.schema_identifier <> ('tenant_' || lower(new.tenant_key)) or
         new.db_role <> (new.schema_identifier || '_runtime') or
         new.credential_ref <> new.tenant_key or
         (new.connection_tier = 'dedicated' and new.login_role <> (new.schema_identifier || '_login')) or
         (new.connection_tier = 'pooled' and new.login_role <> 'tenant_pool_login') then
        raise exception 'Tenant identity scheme tenant_key_v1 requires schema=tenant_<key>, db_role=<schema>_runtime, credential_ref=<key>, and login_role=<schema>_login (dedicated) or tenant_pool_login (pooled).'
          using errcode = '23514';
      end if;
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if old.tenant_id is distinct from new.tenant_id or
       old.tenant_key is distinct from new.tenant_key or
       old.schema_identifier is distinct from new.schema_identifier or
       old.db_role is distinct from new.db_role or
       old.login_role is distinct from new.login_role or
       old.credential_ref is distinct from new.credential_ref or
       old.identity_scheme is distinct from new.identity_scheme or
       old.connection_tier is distinct from new.connection_tier then
      raise exception 'Tenant immutable identity fields (tenant_id, tenant_key, schema_identifier, db_role, login_role, credential_ref, identity_scheme, connection_tier) cannot be modified.'
        using errcode = '55000';
    end if;
    return new;
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = platform, pg_catalog;

-- Lifecycle integrity (migration 023) must not demand that a pooled tenant's
-- login role disappear on deletion: it is the shared tenant_pool_login.
create or replace function platform.enforce_tenant_lifecycle_integrity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, platform
as $$
begin
  if new.lifecycle_status = 'active' and new.lifecycle_status is distinct from old.lifecycle_status then
    if not exists (select 1 from pg_namespace where nspname = new.schema_identifier) then
      raise exception 'Tenant % cannot be marked active: schema % does not exist.',
        new.tenant_key, new.schema_identifier using errcode = '55000';
    end if;
    if not exists (select 1 from pg_roles where rolname = new.login_role) then
      raise exception 'Tenant % cannot be marked active: login role % does not exist.',
        new.tenant_key, new.login_role using errcode = '55000';
    end if;
  end if;

  if new.lifecycle_status = 'deleted' and new.lifecycle_status is distinct from old.lifecycle_status then
    if exists (select 1 from pg_namespace where nspname = new.schema_identifier) then
      raise exception 'Tenant % cannot be marked deleted: schema % still exists. Run the deprovisioning pipeline.',
        new.tenant_key, new.schema_identifier using errcode = '55000';
    end if;
    if exists (select 1 from pg_roles where rolname = new.db_role)
       or (new.connection_tier = 'dedicated' and exists (select 1 from pg_roles where rolname = new.login_role)) then
      raise exception 'Tenant % cannot be marked deleted: database roles still exist. Run the deprovisioning pipeline.',
        new.tenant_key using errcode = '55000';
    end if;
  end if;

  return new;
end
$$;

-- Enqueues a background operation for a tenant. Step codes and messages come
-- from the caller (they are defined next to the worker code that runs them).
-- One open job per tenant is enforced by tenant_provisioning_one_open_job_uidx.
create or replace function platform.enqueue_tenant_operation(
  p_tenant_key text,
  p_job_type text,
  p_params jsonb,
  p_steps jsonb,
  p_actor_user_id uuid,
  p_actor_label text
) returns uuid
language plpgsql
security definer
set search_path = platform, pg_catalog
as $$
declare
  v_tenant_id uuid;
  v_status text;
  v_job_id uuid;
  v_step jsonb;
  v_order integer := 0;
begin
  if p_job_type not in ('migrate', 'relocate_database', 'relocate_storage') then
    raise exception 'Unsupported operation %.', p_job_type using errcode = '22023';
  end if;
  if jsonb_typeof(p_steps) <> 'array' or jsonb_array_length(p_steps) = 0 then
    raise exception 'Operation steps are required.' using errcode = '22023';
  end if;
  select tenant_id, lifecycle_status into v_tenant_id, v_status
    from tenant_registry where tenant_key = p_tenant_key for update;
  if not found then
    raise exception 'Tenant % not found.', p_tenant_key using errcode = '22023';
  end if;
  if p_job_type = 'migrate' and v_status not in ('active', 'suspended', 'migration_failed') then
    raise exception 'Tenant must be active, suspended or migration_failed to upgrade (is %).', v_status using errcode = '55000';
  end if;
  if p_job_type in ('relocate_database', 'relocate_storage') and v_status <> 'active' then
    raise exception 'Tenant must be active to move its data (is %).', v_status using errcode = '55000';
  end if;

  begin
    insert into tenant_provisioning_job (tenant_id, requested_by, correlation_id, status, job_type, job_params)
    values (v_tenant_id, p_actor_user_id, gen_random_uuid(), 'pending', p_job_type, coalesce(p_params, '{}'::jsonb))
    returning job_id into v_job_id;
  exception when unique_violation then
    raise exception 'Another operation is already running for this tenant.' using errcode = '55000';
  end;

  for v_step in select * from jsonb_array_elements(p_steps) loop
    v_order := v_order + 1;
    insert into tenant_provisioning_step (job_id, step_code, step_order, display_message)
    values (v_job_id, v_step->>'code', v_order, v_step->>'message');
  end loop;

  insert into platform_audit (user_id, tenant_id, feature, action, status, resource_type, resource_id, policy_decision)
  values (p_actor_user_id, v_tenant_id, 'tenant_operations', p_job_type || '_requested', 'SUCCESS',
          'provisioning_job', v_job_id::text, 'allow');
  return v_job_id;
end
$$;

alter function platform.enqueue_tenant_operation(text, text, jsonb, jsonb, uuid, text) owner to platform_owner;
revoke all on function platform.enqueue_tenant_operation(text, text, jsonb, jsonb, uuid, text) from public;
grant execute on function platform.enqueue_tenant_operation(text, text, jsonb, jsonb, uuid, text)
  to platform_bff_runtime, tenant_registry_reader_login;

-- Tenant owners follow their own operations' progress (filtered by tenant in
-- the tenant BFF).
grant select on platform.tenant_provisioning_job, platform.tenant_provisioning_step to tenant_registry_reader_login;

-- Registry reader needs the tier to pick the connection path.
grant select on platform.tenant_registry to tenant_registry_reader_login;

insert into platform.config_definition
  (config_key, kind, value_type, label, description, category, module_code,
   default_value, min_value, max_value, max_length, allowed_values, scopes, tenant_editable, is_public)
values
  ('tenancy.default_connection_tier', 'setting', 'string', 'Connection tier for new tenants',
   'dedicated: own database login and pool (strongest isolation). pooled: shared login and pool for many small tenants; schemas, runtime roles and RLS stay per tenant.',
   'tenancy', null, '"dedicated"', null, null, 16, '["dedicated","pooled"]', array['platform', 'plan'], false, false)
on conflict (config_key) do nothing;

insert into platform.schema_migration (migration_key, migration_scope)
values ('028_platform_operations_and_tiers:v1', 'platform')
on conflict (migration_key) do nothing;

commit;
