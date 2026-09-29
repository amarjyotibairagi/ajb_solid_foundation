begin;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'consumer_policy_function_owner') then
    create role consumer_policy_function_owner
      nologin noinherit nosuperuser nocreatedb nocreaterole bypassrls;
  end if;
end
$$;

alter role consumer_policy_function_owner
  nologin noinherit nosuperuser nocreatedb nocreaterole bypassrls;

grant usage on schema consumer to consumer_policy_function_owner;
grant select on consumer.collaboration_group, consumer.group_membership, consumer.role_definition
  to consumer_policy_function_owner;
grant execute on function consumer.current_user_id() to consumer_policy_function_owner;

alter function consumer.can_access_group(uuid) owner to consumer_policy_function_owner;
alter function consumer.can_manage_group(uuid) owner to consumer_policy_function_owner;
alter function consumer.shares_group_with(uuid) owner to consumer_policy_function_owner;
alter function consumer.is_assignable_group_role(uuid) owner to consumer_policy_function_owner;

revoke all on function consumer.can_access_group(uuid) from public;
revoke all on function consumer.can_manage_group(uuid) from public;
revoke all on function consumer.shares_group_with(uuid) from public;
revoke all on function consumer.is_assignable_group_role(uuid) from public;

grant execute on function consumer.can_access_group(uuid) to consumer_runtime, consumer_bff_login;
grant execute on function consumer.can_manage_group(uuid) to consumer_runtime, consumer_bff_login;
grant execute on function consumer.shares_group_with(uuid) to consumer_runtime, consumer_bff_login;
grant execute on function consumer.is_assignable_group_role(uuid) to consumer_runtime, consumer_bff_login;

-- Update collaboration_group_read policy so owner access checks owner_user_id directly
-- which avoids query-snapshot invisibility during INSERT ... RETURNING and avoids recursion
drop policy if exists collaboration_group_read on consumer.collaboration_group;
create policy collaboration_group_read on consumer.collaboration_group for select
  using (owner_user_id = consumer.current_user_id() or consumer.can_access_group(group_id));

comment on role consumer_policy_function_owner is
  'NOLOGIN owner for collaboration RLS policy helper functions that requires BYPASSRLS to prevent recursion on FORCE RLS tables.';

insert into platform.schema_migration (migration_key, migration_scope)
values ('016_consumer_collaboration_rls_fix:v1', 'consumer')
on conflict (migration_key) do nothing;

commit;
