begin;

create extension if not exists pgcrypto;

grant usage on schema platform to platform_bff_runtime;
grant select on platform.platform_user to platform_bff_runtime;
grant select, insert on platform.platform_audit to platform_bff_runtime;
grant select, insert, update, delete on platform.platform_session to platform_bff_runtime;
grant select on platform.tenant_registry, platform.plan_catalog,
  platform.tenant_subscription, platform.usage_aggregate to platform_bff_runtime;

-- Account active status and removing dangerous platform_owner default
alter table platform.platform_user
  add column if not exists is_active boolean not null default true;

alter table platform.platform_user
  alter column role drop default;

insert into platform.schema_migration (migration_key, migration_scope)
values ('015_platform_runtime_grants_and_pgcrypto:v1', 'platform')
on conflict (migration_key) do nothing;

commit;
