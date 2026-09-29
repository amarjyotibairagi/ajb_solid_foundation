-- Least-privilege ownership and grants for the platform and consumer schemas.
-- Tenant schemas receive their grants from the tenant access manifest when
-- they are provisioned (database/migrations/tenant/access-manifest.json).

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'platform_owner') then
    create role platform_owner nologin nosuperuser nocreatedb nocreaterole noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'consumer_owner') then
    create role consumer_owner nologin nosuperuser nocreatedb nocreaterole noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'consumer_runtime') then
    create role consumer_runtime nologin nosuperuser nocreatedb nocreaterole noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'tenant_template_owner') then
    create role tenant_template_owner nologin nosuperuser nocreatedb nocreaterole noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'analytics_writer') then
    create role analytics_writer nologin nosuperuser nocreatedb nocreaterole noinherit;
  end if;
end $$;

revoke create on schema public from public;
revoke all on schema platform, consumer from public;
revoke all on all tables in schema platform, consumer from public;
revoke all on all sequences in schema platform, consumer from public;

alter schema platform owner to platform_owner;

do $$
declare
  item record;
begin
  for item in
    select c.relkind, n.nspname, c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'platform' and c.relkind in ('r', 'p', 'S', 'v', 'm')
  loop
    execute format(
      'alter %s %I.%I owner to platform_owner',
      case item.relkind
        when 'S' then 'sequence'
        when 'v' then 'view'
        when 'm' then 'materialized view'
        else 'table'
      end,
      item.nspname,
      item.relname
    );
  end loop;

  for item in
    select p.oid::regprocedure as signature
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'platform'
  loop
    execute format('alter function %s owner to platform_owner', item.signature);
  end loop;
end $$;

alter default privileges in schema platform
  revoke select on tables from platform_bff_runtime;
alter default privileges for role platform_owner in schema platform
  revoke all on tables from public;
alter default privileges for role platform_owner in schema platform
  revoke all on sequences from public;
alter default privileges for role platform_owner in schema platform
  revoke execute on functions from public;

alter schema consumer owner to consumer_owner;

do $$
declare
  item record;
begin
  for item in
    select c.relkind, n.nspname, c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'consumer' and c.relkind in ('r', 'p', 'S', 'v', 'm')
  loop
    execute format(
      'alter %s %I.%I owner to consumer_owner',
      case item.relkind
        when 'S' then 'sequence'
        when 'v' then 'view'
        when 'm' then 'materialized view'
        else 'table'
      end,
      item.nspname,
      item.relname
    );
  end loop;

  for item in
    select p.oid::regprocedure as signature
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'consumer'
  loop
    execute format('alter function %s owner to consumer_owner', item.signature);
  end loop;
end $$;

grant usage on schema platform to platform_bff_runtime;
grant select on platform.tenant_registry, platform.plan_catalog,
  platform.tenant_subscription, platform.usage_aggregate to platform_bff_runtime;

grant usage on schema platform to analytics_writer;
grant select on platform.tenant_registry, platform.plan_catalog to analytics_writer;
grant select, insert, update on platform.usage_aggregate to analytics_writer;

grant usage on schema consumer to consumer_runtime;
grant select on consumer.permission, consumer.role_definition,
  consumer.role_permission to consumer_runtime;
grant select, insert, update on consumer.user_account to consumer_runtime;
grant select, insert, update, delete on consumer.user_identity,
  consumer.collaboration_group, consumer.group_membership,
  consumer.group_invitation to consumer_runtime;
grant select on consumer.user_role_assignment, consumer.subscription to consumer_runtime;
grant select, insert on consumer.audit_event to consumer_runtime;
grant execute on function consumer.current_user_id(),
  consumer.can_access_group(uuid), consumer.can_manage_group(uuid),
  consumer.shares_group_with(uuid), consumer.is_assignable_group_role(uuid) to consumer_runtime;

alter default privileges for role consumer_owner in schema consumer
  revoke all on tables from public;
alter default privileges for role consumer_owner in schema consumer
  revoke all on sequences from public;
alter default privileges for role consumer_owner in schema consumer
  revoke execute on functions from public;

-- Audit records are append-only to runtime identities.
revoke update, delete, truncate on platform.platform_audit from platform_bff_runtime;
revoke update, delete, truncate on consumer.audit_event from consumer_runtime;

comment on role consumer_runtime is
  'NOLOGIN capability role. A login service role must SET LOCAL app.current_user_id inside every transaction.';

insert into platform.schema_migration (migration_key, migration_scope)
values ('006_rls_and_grants:v1', 'grants')
on conflict (migration_key) do nothing;
