begin;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'consumer_auth_function_owner') then
    create role consumer_auth_function_owner
      nologin noinherit nosuperuser nocreatedb nocreaterole bypassrls;
  end if;
end
$$;

alter role consumer_auth_function_owner
  nologin noinherit nosuperuser nocreatedb nocreaterole bypassrls;
grant usage on schema consumer to consumer_auth_function_owner;
grant select on consumer.user_account, consumer.subscription to consumer_auth_function_owner;
grant insert on consumer.audit_event to consumer_auth_function_owner;

alter function consumer.lookup_login_candidate(text) owner to consumer_auth_function_owner;
alter function consumer.record_auth_event(uuid, text, text, uuid) owner to consumer_auth_function_owner;
revoke all on function consumer.lookup_login_candidate(text) from public, consumer_runtime;
revoke all on function consumer.record_auth_event(uuid, text, text, uuid) from public, consumer_runtime;
grant execute on function consumer.lookup_login_candidate(text) to consumer_bff_login;
grant execute on function consumer.record_auth_event(uuid, text, text, uuid) to consumer_bff_login;

comment on role consumer_auth_function_owner is
  'NOLOGIN owner for tightly scoped authentication functions that must cross FORCE RLS before a consumer identity exists.';

insert into platform.schema_migration (migration_key, migration_scope)
values ('013_consumer_auth_function_owner:v1', 'grants')
on conflict (migration_key) do nothing;

commit;
