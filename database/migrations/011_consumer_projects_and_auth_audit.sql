begin;

create table if not exists consumer.workspace_project (
  project_id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references consumer.user_account(user_id) on delete cascade,
  title varchar(160) not null check (length(trim(title)) between 1 and 160),
  project_type varchar(24) not null check (project_type in ('Document', 'Collection', 'Workspace')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table consumer.workspace_project owner to consumer_owner;
alter table consumer.workspace_project enable row level security;
alter table consumer.workspace_project force row level security;

drop policy if exists workspace_project_owner_access on consumer.workspace_project;
create policy workspace_project_owner_access on consumer.workspace_project
  using (owner_user_id = consumer.current_user_id())
  with check (owner_user_id = consumer.current_user_id());

grant select, insert, update, delete on consumer.workspace_project to consumer_runtime;

create or replace function consumer.record_auth_event(
  target_actor_user_id uuid,
  target_action text,
  target_outcome text,
  target_correlation_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, consumer
as $$
begin
  if target_action not in ('auth.login', 'auth.logout') then
    raise exception 'Unsupported consumer authentication audit action';
  end if;
  if target_outcome not in ('success', 'denied', 'failure') then
    raise exception 'Unsupported consumer authentication audit outcome';
  end if;

  insert into consumer.audit_event (
    actor_user_id, action, resource_type, resource_id, outcome, correlation_id
  ) values (
    target_actor_user_id, target_action, 'consumer_session', null,
    target_outcome, target_correlation_id
  );
end
$$;

alter function consumer.record_auth_event(uuid, text, text, uuid) owner to consumer_owner;
revoke all on function consumer.record_auth_event(uuid, text, text, uuid) from public, consumer_runtime;
grant execute on function consumer.record_auth_event(uuid, text, text, uuid) to consumer_bff_login;

insert into platform.schema_migration (migration_key, migration_scope)
values ('011_consumer_projects_and_auth_audit:v1', 'consumer')
on conflict (migration_key) do nothing;

commit;
