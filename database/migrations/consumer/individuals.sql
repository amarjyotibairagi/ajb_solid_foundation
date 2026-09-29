-- Shared B2C identity, collaboration, RBAC, subscriptions, and audit domain.
-- The backend must SET LOCAL app.current_user_id after authenticating each request.

create schema if not exists consumer;

create table if not exists consumer.user_account (
  user_id uuid primary key default gen_random_uuid(),
  username text not null,
  email_normalized text,
  password_hash text,
  display_name text not null,
  account_status text not null default 'active'
    check (account_status in ('pending', 'active', 'suspended', 'deleting', 'deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint user_account_deleted_state_check
    check ((account_status = 'deleted') = (deleted_at is not null))
);

create unique index if not exists user_account_username_uidx
  on consumer.user_account (lower(username)) where account_status <> 'deleted';
create unique index if not exists user_account_email_uidx
  on consumer.user_account (lower(email_normalized))
  where email_normalized is not null and account_status <> 'deleted';

create table if not exists consumer.user_identity (
  identity_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references consumer.user_account(user_id) on delete cascade,
  provider text not null,
  provider_subject text not null,
  credential_type text not null default 'oidc'
    check (credential_type in ('oidc', 'webauthn', 'password')),
  created_at timestamptz not null default now(),
  last_authenticated_at timestamptz,
  unique (provider, provider_subject)
);

create table if not exists consumer.permission (
  permission_id uuid primary key default gen_random_uuid(),
  permission_code text not null unique check (permission_code ~ '^[a-z][a-z0-9_.:-]{1,95}$'),
  description text not null
);

create table if not exists consumer.role_definition (
  role_id uuid primary key default gen_random_uuid(),
  role_code text not null unique check (role_code ~ '^[a-z][a-z0-9_]{1,62}$'),
  role_scope text not null check (role_scope in ('account', 'group')),
  description text not null,
  is_system boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists consumer.role_permission (
  role_id uuid not null references consumer.role_definition(role_id) on delete cascade,
  permission_id uuid not null references consumer.permission(permission_id) on delete cascade,
  primary key (role_id, permission_id)
);

create table if not exists consumer.user_role_assignment (
  assignment_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references consumer.user_account(user_id) on delete cascade,
  role_id uuid not null references consumer.role_definition(role_id) on delete restrict,
  granted_by uuid references consumer.user_account(user_id) on delete set null,
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  unique (user_id, role_id),
  check (expires_at is null or expires_at > granted_at)
);

create table if not exists consumer.collaboration_group (
  group_id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references consumer.user_account(user_id) on delete restrict,
  name text not null,
  group_status text not null default 'active'
    check (group_status in ('active', 'archived', 'deleting')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_user_id, name)
);

create table if not exists consumer.group_membership (
  membership_id uuid primary key default gen_random_uuid(),
  group_id uuid not null references consumer.collaboration_group(group_id) on delete cascade,
  user_id uuid not null references consumer.user_account(user_id) on delete cascade,
  role_id uuid not null references consumer.role_definition(role_id) on delete restrict,
  membership_status text not null default 'active'
    check (membership_status in ('active', 'suspended')),
  joined_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (group_id, user_id)
);

create index if not exists group_membership_user_idx
  on consumer.group_membership (user_id, group_id) where membership_status = 'active';

create table if not exists consumer.group_invitation (
  invitation_id uuid primary key default gen_random_uuid(),
  group_id uuid not null references consumer.collaboration_group(group_id) on delete cascade,
  invited_email_normalized text not null,
  role_id uuid not null references consumer.role_definition(role_id) on delete restrict,
  token_hash text not null unique,
  invited_by uuid not null references consumer.user_account(user_id) on delete restrict,
  expires_at timestamptz not null,
  accepted_by uuid references consumer.user_account(user_id) on delete set null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at),
  check ((accepted_by is null) = (accepted_at is null)),
  check (accepted_at is null or revoked_at is null)
);

create index if not exists group_invitation_group_idx
  on consumer.group_invitation (group_id, expires_at);

create table if not exists consumer.subscription (
  subscription_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references consumer.user_account(user_id) on delete restrict,
  plan_code text not null check (plan_code ~ '^[a-z][a-z0-9_]{1,62}$'),
  status text not null check (status in ('trialing', 'active', 'past_due', 'paused', 'cancelled', 'expired')),
  entitlement_version integer not null check (entitlement_version > 0),
  period_start timestamptz,
  period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (period_end is null or period_start is null or period_end > period_start)
);

create unique index if not exists consumer_subscription_current_uidx
  on consumer.subscription (user_id)
  where status in ('trialing', 'active', 'past_due', 'paused');

create table if not exists consumer.audit_event (
  event_id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references consumer.user_account(user_id) on delete set null,
  group_id uuid references consumer.collaboration_group(group_id) on delete set null,
  action text not null,
  resource_type text not null,
  resource_id uuid,
  outcome text not null check (outcome in ('success', 'denied', 'failure')),
  correlation_id uuid,
  occurred_at timestamptz not null default now()
);

create index if not exists consumer_audit_actor_time_idx
  on consumer.audit_event (actor_user_id, occurred_at desc);
create index if not exists consumer_audit_group_time_idx
  on consumer.audit_event (group_id, occurred_at desc) where group_id is not null;

insert into consumer.role_definition (role_code, role_scope, description, is_system)
values
  ('group_admin', 'group', 'Manages members and group resources.', true),
  ('group_editor', 'group', 'Creates and edits group resources.', true),
  ('group_viewer', 'group', 'Reads group resources.', true)
on conflict (role_code) do nothing;

create or replace function consumer.current_user_id()
returns uuid language sql stable set search_path = pg_catalog
as $$ select nullif(current_setting('app.current_user_id', true), '')::uuid $$;

create or replace function consumer.can_access_group(target_group_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, consumer
as $$
  select exists (
    select 1 from consumer.collaboration_group g
    where g.group_id = target_group_id and g.group_status = 'active'
      and (g.owner_user_id = consumer.current_user_id() or exists (
        select 1 from consumer.group_membership gm
        where gm.group_id = g.group_id and gm.user_id = consumer.current_user_id()
          and gm.membership_status = 'active'
      ))
  )
$$;

create or replace function consumer.can_manage_group(target_group_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, consumer
as $$
  select exists (
    select 1 from consumer.collaboration_group g
    where g.group_id = target_group_id and g.group_status = 'active'
      and (g.owner_user_id = consumer.current_user_id() or exists (
        select 1 from consumer.group_membership gm
        join consumer.role_definition r on r.role_id = gm.role_id
        where gm.group_id = g.group_id and gm.user_id = consumer.current_user_id()
          and gm.membership_status = 'active' and r.role_code = 'group_admin'
      ))
  )
$$;

create or replace function consumer.shares_group_with(other_user_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, consumer
as $$
  select exists (
    select 1 from consumer.collaboration_group g
    where g.group_status = 'active'
      and (
        g.owner_user_id = consumer.current_user_id()
        or exists (
          select 1 from consumer.group_membership mine
          where mine.group_id = g.group_id and mine.user_id = consumer.current_user_id()
            and mine.membership_status = 'active'
        )
      )
      and (
        g.owner_user_id = other_user_id
        or exists (
          select 1 from consumer.group_membership theirs
          where theirs.group_id = g.group_id and theirs.user_id = other_user_id
            and theirs.membership_status = 'active'
        )
      )
  )
$$;

create or replace function consumer.is_assignable_group_role(target_role_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, consumer
as $$
  select exists (
    select 1 from consumer.role_definition r
    where r.role_id = target_role_id and r.role_scope = 'group'
      and r.role_code in ('group_admin', 'group_editor', 'group_viewer')
  )
$$;

alter table consumer.user_account enable row level security;
alter table consumer.user_identity enable row level security;
alter table consumer.user_role_assignment enable row level security;
alter table consumer.collaboration_group enable row level security;
alter table consumer.group_membership enable row level security;
alter table consumer.group_invitation enable row level security;
alter table consumer.subscription enable row level security;
alter table consumer.audit_event enable row level security;

create policy user_account_read on consumer.user_account for select
  using (user_id = consumer.current_user_id() or consumer.shares_group_with(user_id));
create policy user_account_create_self on consumer.user_account for insert
  with check (user_id = consumer.current_user_id());
create policy user_account_update_self on consumer.user_account for update
  using (user_id = consumer.current_user_id()) with check (user_id = consumer.current_user_id());
create policy user_identity_self on consumer.user_identity
  using (user_id = consumer.current_user_id()) with check (user_id = consumer.current_user_id());
create policy user_role_assignment_self_read on consumer.user_role_assignment for select
  using (user_id = consumer.current_user_id());
create policy collaboration_group_read on consumer.collaboration_group for select
  using (consumer.can_access_group(group_id));
create policy collaboration_group_create on consumer.collaboration_group for insert
  with check (owner_user_id = consumer.current_user_id());
create policy collaboration_group_owner_update on consumer.collaboration_group for update
  using (owner_user_id = consumer.current_user_id()) with check (owner_user_id = consumer.current_user_id());
create policy collaboration_group_owner_delete on consumer.collaboration_group for delete
  using (owner_user_id = consumer.current_user_id());
create policy group_membership_read on consumer.group_membership for select
  using (consumer.can_access_group(group_id));
create policy group_membership_manage on consumer.group_membership
  using (consumer.can_manage_group(group_id))
  with check (consumer.can_manage_group(group_id) and consumer.is_assignable_group_role(role_id));
create policy group_invitation_manage on consumer.group_invitation
  using (consumer.can_manage_group(group_id))
  with check (consumer.can_manage_group(group_id) and consumer.is_assignable_group_role(role_id));
create policy subscription_self_read on consumer.subscription for select
  using (user_id = consumer.current_user_id());
create policy audit_event_read on consumer.audit_event for select
  using (actor_user_id = consumer.current_user_id() or (group_id is not null and consumer.can_access_group(group_id)));
create policy audit_event_insert on consumer.audit_event for insert
  with check (actor_user_id = consumer.current_user_id());

comment on schema consumer is
  'Shared B2C data protected by authenticated user context, ownership, collaboration RBAC, and RLS.';
