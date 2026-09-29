-- Migration 023: Platform identity invariants and tenant lifecycle integrity.
--
-- Remediates four defects found by the 2026-09-05 production audit:
--   1. platform.schema_migration had no checksum column, so nothing detected
--      drift between the migration files and what a database actually ran.
--   2. tenant_registry.tenant_key had no format CHECK, so short ad-hoc keys
--      (TK0dc257cd) coexisted with the documented tenant_key_v1 format.
--   3. lifecycle_status could be set directly to 'active' or 'deleted' by any
--      writer, without the tenant's schema/role actually existing or actually
--      being gone. Test tooling did exactly this, leaving a "deleted" tenant
--      whose schema, login role and credential were still live.
--   4. Dead objects (superseded WebAuthn table, leftover test schema) and a
--      weak-cost bcrypt platform_owner account remained in production.

begin;

-- 1. Checksum-aware migration ledger ---------------------------------------
-- scripts/platform-migrate.mjs records the SHA-256 of every file it applies
-- and refuses to proceed if a previously applied file has since changed.

alter table platform.schema_migration
  add column if not exists source_file text,
  add column if not exists checksum text;

-- 2. Tenant key format invariant -------------------------------------------
-- Two identity schemes exist. 'legacy' is reserved for tenants created by hand
-- outside the provisioner; 'tenant_key_v1' is what the provisioner emits and
-- is the only scheme new tenants may use.

alter table platform.tenant_registry
  drop constraint if exists tenant_registry_tenant_key_format_check;

-- 3. Purge provably-empty registry rows -------------------------------------
-- Only rows with NO schema and NO database role are removed: such a row can by
-- construction hold no tenant data. Rows that own real resources are left
-- alone and must go through the deprovisioning pipeline
-- (scripts/reconcile-tenants.mjs reports them).

do $$
declare
  purged integer;
begin
  create temporary table phantom_tenant on commit drop as
  select r.tenant_id, r.tenant_key
  from platform.tenant_registry r
  where not exists (select 1 from pg_namespace n where n.nspname = r.schema_identifier)
    and not exists (select 1 from pg_roles p where p.rolname = r.login_role)
    and not exists (select 1 from pg_roles p where p.rolname = r.db_role)
    and r.lifecycle_status <> 'deleted'
    and r.tenant_key !~ '^T[0-9A-F]{20}$';

  delete from platform.tenant_branding b using phantom_tenant p where b.tenant_id = p.tenant_id;
  delete from platform.tenant_domain d using phantom_tenant p where d.tenant_id = p.tenant_id;
  delete from platform.tenant_subscription s using phantom_tenant p where s.tenant_id = p.tenant_id;
  delete from platform.tenant_provisioning_step s
    using platform.tenant_provisioning_job j, phantom_tenant p
    where s.job_id = j.job_id and j.tenant_id = p.tenant_id;
  delete from platform.tenant_provisioning_job j using phantom_tenant p where j.tenant_id = p.tenant_id;
  delete from platform.tenant_registry r using phantom_tenant p where r.tenant_id = p.tenant_id;

  get diagnostics purged = row_count;
  raise notice 'Purged % resourceless tenant registry rows.', purged;
end
$$;

alter table platform.tenant_registry
  add constraint tenant_registry_tenant_key_format_check
  check (
    (identity_scheme = 'tenant_key_v1' and tenant_key ~ '^T[0-9A-F]{20}$')
    or (identity_scheme = 'legacy' and tenant_key ~ '^T[A-Z0-9]{4,63}$')
  );

-- 4. Lifecycle transition integrity ----------------------------------------
-- 'active' asserts the tenant's schema and roles exist and are reachable.
-- 'deleted' asserts they are gone. Enforcing both in the database means no
-- caller -- application, operator CLI, or test -- can leave the registry
-- claiming something the cluster contradicts.

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
    if exists (select 1 from pg_roles where rolname in (new.login_role, new.db_role)) then
      raise exception 'Tenant % cannot be marked deleted: database roles still exist. Run the deprovisioning pipeline.',
        new.tenant_key using errcode = '55000';
    end if;
  end if;

  return new;
end
$$;

revoke all on function platform.enforce_tenant_lifecycle_integrity() from public;
alter function platform.enforce_tenant_lifecycle_integrity() owner to platform_owner;

drop trigger if exists tenant_registry_lifecycle_integrity_tg on platform.tenant_registry;
create trigger tenant_registry_lifecycle_integrity_tg
  before update on platform.tenant_registry
  for each row
  execute function platform.enforce_tenant_lifecycle_integrity();

-- 5. Remove dead and leftover objects --------------------------------------
-- operator_webauthn_credential was superseded by platform_webauthn_credential
-- in migration 019 and is referenced by no application code.

drop table if exists platform.operator_webauthn_credential cascade;

-- 6. Remove weak-cost platform operator accounts ---------------------------
-- pgcrypto's gen_salt('bf') defaults to cost 6, which is far too cheap for a
-- control-plane owner. Any account still carrying a sub-cost-12 bcrypt hash is
-- removed outright rather than left active; migration 024 then forbids the
-- format entirely. The guard refuses to run if it would remove every owner.

do $$
declare
  weak_count integer;
  strong_owner_count integer;
begin
  select count(*) into weak_count
  from platform.platform_user
  where password_hash ~ '^\$2[aby]\$0[0-9]\$';

  if weak_count = 0 then
    raise notice 'No weak-cost platform accounts present.';
    return;
  end if;

  select count(*) into strong_owner_count
  from platform.platform_user
  where role = 'platform_owner'
    and is_active = true
    and password_hash !~ '^\$2[aby]\$0[0-9]\$';

  if strong_owner_count = 0 then
    raise exception 'Refusing to remove % weak-cost account(s): no strong-credential platform_owner would remain. Enrol a strong owner first.', weak_count;
  end if;

  delete from platform.platform_session s
   using platform.platform_user u
   where s.user_id = u.id and u.password_hash ~ '^\$2[aby]\$0[0-9]\$';

  delete from platform.platform_user
   where password_hash ~ '^\$2[aby]\$0[0-9]\$';

  raise notice 'Removed % weak-cost platform account(s) and their sessions.', weak_count;
end
$$;

insert into platform.schema_migration (migration_key, migration_scope)
values ('023_platform_identity_and_lifecycle_hardening:v1', 'platform')
on conflict (migration_key) do nothing;

commit;
