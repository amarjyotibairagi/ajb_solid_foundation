-- Migration 020: Platform Tenant Immutability, Identity Scheme Invariants, and Restricted Control-Plane Grants

begin;

-- Step 1: Backfill null identity fields if any exist
update platform.tenant_registry
   set tenant_key = 'T' || upper(substr(md5(random()::text), 1, 20))
 where tenant_key is null;

update platform.tenant_registry
   set schema_identifier = 'tenant_' || lower(tenant_key)
 where schema_identifier is null;

update platform.tenant_registry
   set db_role = schema_identifier || '_runtime'
 where db_role is null;

update platform.tenant_registry
   set login_role = schema_identifier || '_login'
 where login_role is null;

update platform.tenant_registry
   set credential_ref = tenant_key
 where credential_ref is null;

-- Step 2: Add identity_scheme column
alter table platform.tenant_registry
  add column if not exists identity_scheme text not null default 'tenant_key_v1'
  check (identity_scheme in ('legacy', 'tenant_key_v1'));

-- Step 3: Add NOT NULL constraints on core identity columns
alter table platform.tenant_registry
  alter column tenant_key set not null,
  alter column db_role set not null,
  alter column login_role set not null,
  alter column credential_ref set not null;

-- Step 4: Define null-safe immutability and insertion validation trigger function
create or replace function platform.enforce_tenant_immutability()
returns trigger as $$
begin
  if tg_op = 'INSERT' then
    if new.identity_scheme = 'tenant_key_v1' then
      if new.schema_identifier <> ('tenant_' || lower(new.tenant_key)) or
         new.db_role <> (new.schema_identifier || '_runtime') or
         new.login_role <> (new.schema_identifier || '_login') or
         new.credential_ref <> new.tenant_key then
        raise exception 'Tenant identity scheme tenant_key_v1 requires schema=tenant_<key>, db_role=<schema>_runtime, login_role=<schema>_login, and credential_ref=<key>.'
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
       old.identity_scheme is distinct from new.identity_scheme then
      raise exception 'Tenant immutable identity fields (tenant_id, tenant_key, schema_identifier, db_role, login_role, credential_ref, identity_scheme) cannot be modified.'
        using errcode = '55000';
    end if;
    return new;
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = platform, pg_catalog;

revoke all on function platform.enforce_tenant_immutability() from public;

drop trigger if exists tenant_registry_immutability_tg on platform.tenant_registry;

create trigger tenant_registry_immutability_tg
before insert or update on platform.tenant_registry
for each row
execute function platform.enforce_tenant_immutability();

-- Step 5: Narrow platform_bff_runtime write permissions
revoke update on platform.tenant_registry from platform_bff_runtime;
grant update (lifecycle_status, updated_at) on platform.tenant_registry to platform_bff_runtime;

revoke update on platform.tenant_provisioning_job from platform_bff_runtime;
grant update (status, safe_error_code, safe_error_message, completed_at, worker_id, locked_at)
  on platform.tenant_provisioning_job to platform_bff_runtime;

revoke update on platform.tenant_provisioning_step from platform_bff_runtime;
grant update (status, safe_error_message, completed_at)
  on platform.tenant_provisioning_step to platform_bff_runtime;

insert into platform.schema_migration (migration_key, migration_scope)
values ('020_platform_tenant_immutability_nullsafe:v1', 'platform')
on conflict (migration_key) do nothing;

commit;
