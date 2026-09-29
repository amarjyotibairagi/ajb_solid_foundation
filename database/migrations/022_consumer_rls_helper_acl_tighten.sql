-- Migration 022: Tighten Consumer RLS Helper Execution ACLs and Role Isolation

begin;

-- Step 1: Revoke direct execution privileges from consumer_bff_login
revoke execute on function consumer.can_access_group(uuid) from consumer_bff_login;
revoke execute on function consumer.can_manage_group(uuid) from consumer_bff_login;
revoke execute on function consumer.shares_group_with(uuid) from consumer_bff_login;
revoke execute on function consumer.is_assignable_group_role(uuid) from consumer_bff_login;

-- Step 2: Ensure only consumer_runtime (and the owner/postgres) has execute
grant execute on function consumer.can_access_group(uuid) to consumer_runtime;
grant execute on function consumer.can_manage_group(uuid) to consumer_runtime;
grant execute on function consumer.shares_group_with(uuid) to consumer_runtime;
grant execute on function consumer.is_assignable_group_role(uuid) to consumer_runtime;

-- Step 3: Ensure helper owner role is strictly NOLOGIN and NOINHERIT, and no login/runtime role is granted membership
alter role consumer_policy_function_owner
  nologin noinherit nosuperuser nocreatedb nocreaterole bypassrls;

revoke consumer_policy_function_owner from consumer_runtime, consumer_bff_login;

insert into platform.schema_migration (migration_key, migration_scope)
values ('022_consumer_rls_helper_acl_tighten:v1', 'consumer')
on conflict (migration_key) do nothing;

commit;
