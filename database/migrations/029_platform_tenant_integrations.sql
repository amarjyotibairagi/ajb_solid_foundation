-- Migration 029: Bring-your-own storage and database integrations.
--
-- By default a tenant's objects live on the VDS disk and its data in a VDS
-- schema. A tenant (or an operator on its behalf) may register:
--   kind 'storage'  / provider 's3'          an S3-compatible bucket + folder
--   kind 'database' / provider 'postgresql'  a PostgreSQL database + schema
--
-- Credentials are sealed with AES-256-GCM by the application
-- (INTEGRATION_SECRET_KEY) and bound to tenant, integration and kind; the
-- database stores only ciphertext. Nothing becomes active until a connection
-- test passed for exactly the stored settings (settings_fingerprint =
-- tested_fingerprint) within the last 30 minutes.
--
-- tenant_registry.storage_integration_id: where NEW objects are written
--   (NULL = VDS). Existing objects keep a per-object backend reference, so a
--   switch never breaks reads; a relocate_storage job moves them later.
-- tenant_registry.data_integration_id: where the tenant's data lives
--   (NULL = VDS). Changed only by the relocate_database job.

begin;

create table if not exists platform.tenant_integration (
  integration_id uuid primary key,
  tenant_id uuid not null references platform.tenant_registry(tenant_id) on delete cascade,
  kind text not null check (kind in ('storage', 'database')),
  provider text not null check (provider in ('s3', 'postgresql')),
  display_name text not null check (length(btrim(display_name)) between 1 and 120),
  settings jsonb not null check (jsonb_typeof(settings) = 'object'),
  secret_ciphertext text not null check (secret_ciphertext like 'v1.%'),
  settings_fingerprint text not null check (settings_fingerprint ~ '^[0-9a-f]{64}$'),
  status text not null default 'draft'
    check (status in ('draft', 'verified', 'failed', 'active', 'retired')),
  last_test_at timestamptz,
  last_test_ok boolean,
  last_test_report jsonb,
  tested_fingerprint text,
  created_by text not null,
  activated_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'storage') = (provider = 's3'))
);

create index if not exists tenant_integration_tenant_idx on platform.tenant_integration (tenant_id, kind, created_at desc);
create unique index if not exists tenant_integration_one_active_uidx
  on platform.tenant_integration (tenant_id, kind) where status = 'active';

drop trigger if exists tenant_integration_set_updated_at on platform.tenant_integration;
create trigger tenant_integration_set_updated_at before update on platform.tenant_integration
  for each row execute function platform.set_updated_at();

alter table platform.tenant_integration owner to platform_owner;
revoke all on platform.tenant_integration from public;
-- Reading ciphertext is harmless without INTEGRATION_SECRET_KEY, which only
-- the services that use integrations hold.
grant select on platform.tenant_integration to platform_bff_runtime, tenant_registry_reader_login, tenant_provisioner;
grant update (status, activated_at, retired_at) on platform.tenant_integration to tenant_provisioner;

alter table platform.tenant_registry
  add column if not exists storage_integration_id uuid references platform.tenant_integration(integration_id),
  add column if not exists data_integration_id uuid references platform.tenant_integration(integration_id);

-- Create or update a non-active integration. Updating settings or secret
-- invalidates any earlier test.
create or replace function platform.save_tenant_integration(
  p_tenant_id uuid,
  p_integration_id uuid,
  p_kind text,
  p_provider text,
  p_display_name text,
  p_settings jsonb,
  p_secret_ciphertext text,
  p_fingerprint text,
  p_actor text
) returns uuid
language plpgsql
security definer
set search_path = platform, pg_catalog
as $$
declare
  v_existing tenant_integration%rowtype;
begin
  select * into v_existing from tenant_integration where integration_id = p_integration_id for update;
  if found then
    if v_existing.tenant_id <> p_tenant_id or v_existing.kind <> p_kind or v_existing.provider <> p_provider then
      raise exception 'Integration does not belong to this tenant.' using errcode = '42501';
    end if;
    if v_existing.status in ('active', 'retired') then
      raise exception 'Active or retired integrations cannot be edited; create a new one.' using errcode = '55000';
    end if;
    update tenant_integration
       set display_name = p_display_name,
           settings = p_settings,
           secret_ciphertext = coalesce(p_secret_ciphertext, secret_ciphertext),
           settings_fingerprint = p_fingerprint,
           status = case when tested_fingerprint = p_fingerprint then status else 'draft' end
     where integration_id = p_integration_id;
  else
    if p_secret_ciphertext is null then
      raise exception 'Credentials are required for a new integration.' using errcode = '22023';
    end if;
    insert into tenant_integration (integration_id, tenant_id, kind, provider, display_name, settings,
                                    secret_ciphertext, settings_fingerprint, created_by)
    values (p_integration_id, p_tenant_id, p_kind, p_provider, p_display_name, p_settings,
            p_secret_ciphertext, p_fingerprint, p_actor);
  end if;
  insert into platform_audit (tenant_id, feature, action, status, resource_type, resource_id, policy_decision)
  values (p_tenant_id, 'integrations', 'integration_saved:' || p_kind, 'SUCCESS', 'tenant_integration', p_integration_id::text,
          'allow:' || left(p_actor, 80));
  return p_integration_id;
end
$$;

create or replace function platform.record_tenant_integration_test(
  p_tenant_id uuid,
  p_integration_id uuid,
  p_fingerprint text,
  p_ok boolean,
  p_report jsonb,
  p_actor text
) returns boolean
language plpgsql
security definer
set search_path = platform, pg_catalog
as $$
begin
  update tenant_integration
     set last_test_at = now(),
         last_test_ok = p_ok,
         last_test_report = p_report,
         tested_fingerprint = p_fingerprint,
         status = case when status in ('active', 'retired') then status when p_ok then 'verified' else 'failed' end
   where integration_id = p_integration_id and tenant_id = p_tenant_id and settings_fingerprint = p_fingerprint;
  if not found then return false; end if;
  insert into platform_audit (tenant_id, feature, action, status, resource_type, resource_id, policy_decision)
  values (p_tenant_id, 'integrations', 'integration_tested', case when p_ok then 'SUCCESS' else 'FAILED' end,
          'tenant_integration', p_integration_id::text, 'allow:' || left(p_actor, 80));
  return true;
end
$$;

-- True when the integration passed a test of its current settings recently.
create or replace function platform.integration_ready(p_integration_id uuid, p_tenant_id uuid, p_kind text)
returns boolean
language sql
stable
security definer
set search_path = platform, pg_catalog
as $$
  select exists (
    select 1 from tenant_integration
     where integration_id = p_integration_id and tenant_id = p_tenant_id and kind = p_kind
       and last_test_ok and tested_fingerprint = settings_fingerprint
       and last_test_at > now() - interval '30 minutes'
       and status in ('verified', 'active')
  )
$$;

-- Switch where new objects are written. p_integration_id NULL = back to VDS.
create or replace function platform.activate_tenant_storage(
  p_tenant_id uuid,
  p_integration_id uuid,
  p_actor text
) returns boolean
language plpgsql
security definer
set search_path = platform, pg_catalog
as $$
declare
  v_previous uuid;
begin
  select storage_integration_id into v_previous from tenant_registry where tenant_id = p_tenant_id for update;
  if not found then return false; end if;
  if p_integration_id is not null and not integration_ready(p_integration_id, p_tenant_id, 'storage') then
    raise exception 'Run a successful connection test (within 30 minutes, with the current settings) before activating.' using errcode = '55000';
  end if;
  -- The previous backend stays readable: objects keep their own backend
  -- reference until a relocate_storage job moves them.
  update tenant_integration set status = 'verified', activated_at = null
   where tenant_id = p_tenant_id and kind = 'storage' and status = 'active';
  if p_integration_id is not null then
    update tenant_integration set status = 'active', activated_at = now() where integration_id = p_integration_id;
  end if;
  update tenant_registry set storage_integration_id = p_integration_id where tenant_id = p_tenant_id;
  insert into platform_audit (tenant_id, feature, action, status, resource_type, resource_id, policy_decision)
  values (p_tenant_id, 'integrations', 'storage_switched:' || coalesce(p_integration_id::text, 'vds'), 'SUCCESS',
          'tenant', coalesce(v_previous::text, 'vds'), 'allow:' || left(p_actor, 80));
  return true;
end
$$;

create or replace function platform.retire_tenant_integration(p_tenant_id uuid, p_integration_id uuid, p_actor text)
returns boolean
language plpgsql
security definer
set search_path = platform, pg_catalog
as $$
begin
  if exists (select 1 from tenant_registry where tenant_id = p_tenant_id
              and (storage_integration_id = p_integration_id or data_integration_id = p_integration_id)) then
    raise exception 'This integration is in use. Switch back to the VDS (or another integration) first.' using errcode = '55000';
  end if;
  update tenant_integration set status = 'retired', retired_at = now()
   where integration_id = p_integration_id and tenant_id = p_tenant_id and status <> 'retired';
  if not found then return false; end if;
  insert into platform_audit (tenant_id, feature, action, status, resource_type, resource_id, policy_decision)
  values (p_tenant_id, 'integrations', 'integration_retired', 'SUCCESS', 'tenant_integration', p_integration_id::text,
          'allow:' || left(p_actor, 80));
  return true;
end
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'platform.save_tenant_integration(uuid, uuid, text, text, text, jsonb, text, text, text)',
    'platform.record_tenant_integration_test(uuid, uuid, text, boolean, jsonb, text)',
    'platform.integration_ready(uuid, uuid, text)',
    'platform.activate_tenant_storage(uuid, uuid, text)',
    'platform.retire_tenant_integration(uuid, uuid, text)'
  ] loop
    execute format('alter function %s owner to platform_owner', fn);
    execute format('revoke all on function %s from public', fn);
    execute format('grant execute on function %s to platform_bff_runtime, tenant_registry_reader_login', fn);
  end loop;
end
$$;
grant execute on function platform.integration_ready(uuid, uuid, text) to tenant_provisioner;
-- Integration policy (private endpoints, insecure transport) is platform
-- configuration; the worker and tenant BFF read it through the resolver.
grant execute on function platform.resolve_platform_config() to tenant_provisioner, tenant_registry_reader_login;

insert into platform.config_definition
  (config_key, kind, value_type, label, description, category, module_code,
   default_value, min_value, max_value, max_length, scopes, tenant_editable, is_public)
values
  ('integration.byo_storage', 'feature', 'boolean', 'Bring-your-own storage',
   'Tenant owners may connect an S3-compatible bucket. Operators can always configure it for them.', 'integrations', null,
   'true', null, null, null, array['platform', 'plan', 'tenant'], false, true),
  ('integration.byo_database', 'feature', 'boolean', 'Bring-your-own database',
   'Tenant owners may move their data to their own PostgreSQL. Operators can always configure it for them.', 'integrations', null,
   'true', null, null, null, array['platform', 'plan', 'tenant'], false, true),
  ('integration.allow_private_endpoints', 'setting', 'boolean', 'Allow private-network endpoints',
   'Permit integrations that resolve to loopback, private or link-local addresses. Keep off unless every tenant endpoint is trusted.', 'integrations', null,
   'false', null, null, null, array['platform'], false, false),
  ('integration.allow_insecure_transport', 'setting', 'boolean', 'Allow unencrypted connections',
   'Permit http:// storage endpoints and sslMode=disable databases.', 'integrations', null,
   'false', null, null, null, array['platform'], false, false),
  ('limit.storage.max_file_mb', 'limit', 'integer', 'Maximum upload size (MB)',
   'Largest single file accepted by the file service.', 'limits', null,
   '25', 1, 1024, null, array['platform', 'plan', 'tenant'], false, true),
  ('limit.storage.max_mb', 'limit', 'integer', 'Storage quota (MB)',
   'Total stored file size per tenant in megabytes. 0 means unlimited.', 'limits', null,
   '0', 0, 100000000, null, array['platform', 'plan', 'tenant'], false, false)
on conflict (config_key) do nothing;

insert into platform.schema_migration (migration_key, migration_scope)
values ('029_platform_tenant_integrations:v1', 'platform')
on conflict (migration_key) do nothing;

commit;
