begin;

do $$
declare
  role_name text;
begin
  foreach role_name in array array[
    'platform_bff_runtime',
    'consumer_bff_login',
    'tenant_registry_reader_login',
    'tenant_provisioner_login'
  ] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('alter role %I set statement_timeout = %L', role_name, '30s');
      execute format('alter role %I set lock_timeout = %L', role_name, '5s');
      execute format('alter role %I set idle_in_transaction_session_timeout = %L', role_name, '15s');
    end if;
  end loop;

  for role_name in
    select distinct login_role
    from platform.tenant_registry
    where login_role is not null
  loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('alter role %I set statement_timeout = %L', role_name, '30s');
      execute format('alter role %I set lock_timeout = %L', role_name, '5s');
      execute format('alter role %I set idle_in_transaction_session_timeout = %L', role_name, '15s');
    end if;
  end loop;
end
$$;

insert into platform.schema_migration (migration_key, migration_scope)
values ('010_runtime_role_timeouts:v1', 'platform')
on conflict (migration_key) do nothing;

commit;
