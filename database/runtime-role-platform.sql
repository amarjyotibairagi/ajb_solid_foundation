-- Usage:
-- psql "$DATABASE_URL" -v runtime_password='replace-with-generated-password' -f database/runtime-role-platform.sql

select format('create role platform_bff_runtime login password %L', :'runtime_password')
where not exists (select 1 from pg_roles where rolname = 'platform_bff_runtime')
\gexec

alter role platform_bff_runtime login password :'runtime_password';

grant usage on schema platform to platform_bff_runtime;
grant connect on database platform_db to platform_bff_runtime;

grant select on platform.platform_user to platform_bff_runtime;
grant select, insert on platform.platform_audit to platform_bff_runtime;
grant select, insert, update, delete on platform.platform_session to platform_bff_runtime;
grant select on platform.tenant_registry, platform.plan_catalog,
  platform.tenant_subscription, platform.usage_aggregate to platform_bff_runtime;

alter default privileges in schema platform
  revoke select on tables from platform_bff_runtime;
