-- Reusable B2B tenant baseline. Run with psql and an opaque, registry-approved
-- identifier: psql ... -v tenant_schema=tenant_<opaque_id> -f 001_tenant_schema.sql

\if :{?tenant_schema}
\else
  \warn 'tenant_schema is required'
  \quit 3
\endif

select :'tenant_schema' ~ '^tenant_[a-z0-9][a-z0-9_]{2,62}$' as tenant_schema_valid \gset
\if :tenant_schema_valid
\else
  \warn 'tenant_schema must match ^tenant_[a-z0-9][a-z0-9_]{2,62}$'
  \quit 3
\endif

begin;
select format('create schema if not exists %I', :'tenant_schema') \gexec
select format('set local search_path = %I, pg_catalog', :'tenant_schema') \gexec

create table if not exists schema_metadata (
  singleton boolean primary key default true check (singleton),
  schema_version integer not null check (schema_version > 0),
  migrated_at timestamptz not null default now()
);

insert into schema_metadata (singleton, schema_version)
values (true, 1)
on conflict (singleton) do update
set schema_version = greatest(schema_metadata.schema_version, excluded.schema_version),
    migrated_at = now();

create table if not exists user_account (
  user_id uuid primary key default gen_random_uuid(),
  username text not null,
  email_normalized text,
  display_name text not null,
  account_status text not null default 'active'
    check (account_status in ('invited', 'active', 'suspended', 'departed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists user_account_username_uidx on user_account (lower(username));
create unique index if not exists user_account_email_uidx
  on user_account (lower(email_normalized)) where email_normalized is not null;

create table if not exists user_identity (
  identity_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references user_account(user_id) on delete cascade,
  provider text not null,
  provider_subject text not null,
  credential_type text not null default 'oidc'
    check (credential_type in ('oidc', 'webauthn', 'password')),
  password_hash text,
  created_at timestamptz not null default now(),
  last_authenticated_at timestamptz,
  unique (provider, provider_subject),
  check ((credential_type = 'password') = (password_hash is not null))
);

create table if not exists permission (
  permission_id uuid primary key default gen_random_uuid(),
  permission_code text not null unique check (permission_code ~ '^[a-z][a-z0-9_.:-]{1,95}$'),
  description text not null
);

create table if not exists role_definition (
  role_id uuid primary key default gen_random_uuid(),
  role_code text not null unique check (role_code ~ '^[a-z][a-z0-9_]{1,62}$'),
  description text not null,
  is_system boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists role_permission (
  role_id uuid not null references role_definition(role_id) on delete cascade,
  permission_id uuid not null references permission(permission_id) on delete cascade,
  primary key (role_id, permission_id)
);

create table if not exists role_assignment (
  assignment_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references user_account(user_id) on delete cascade,
  role_id uuid not null references role_definition(role_id) on delete restrict,
  granted_by uuid references user_account(user_id) on delete set null,
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  unique (user_id, role_id),
  check (expires_at is null or expires_at > granted_at)
);

create table if not exists team (
  team_id uuid primary key default gen_random_uuid(),
  name text not null unique,
  team_status text not null default 'active' check (team_status in ('active', 'archived')),
  created_by uuid references user_account(user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists team_membership (
  team_id uuid not null references team(team_id) on delete cascade,
  user_id uuid not null references user_account(user_id) on delete cascade,
  membership_role text not null default 'member' check (membership_role in ('manager', 'member')),
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id)
);

create index if not exists team_membership_user_idx on team_membership (user_id, team_id);

create table if not exists tenant_setting (
  setting_key text primary key check (setting_key ~ '^[a-z][a-z0-9_.:-]{1,95}$'),
  setting_value jsonb not null,
  updated_by uuid references user_account(user_id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists subscription_entitlement (
  singleton boolean primary key default true check (singleton),
  plan_code text not null check (plan_code ~ '^[a-z][a-z0-9_]{1,62}$'),
  status text not null check (status in ('trialing', 'active', 'past_due', 'paused', 'cancelled', 'expired')),
  entitlement_version integer not null check (entitlement_version > 0),
  entitlements jsonb not null default '{}'::jsonb check (jsonb_typeof(entitlements) = 'object'),
  period_start timestamptz,
  period_end timestamptz,
  updated_at timestamptz not null default now(),
  check (period_end is null or period_start is null or period_end > period_start)
);

create table if not exists audit_event (
  event_id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references user_account(user_id) on delete set null,
  action text not null,
  resource_type text not null,
  resource_id uuid,
  outcome text not null check (outcome in ('success', 'denied', 'failure')),
  correlation_id uuid,
  occurred_at timestamptz not null default now()
);

create index if not exists audit_event_time_idx on audit_event (occurred_at desc);
create index if not exists audit_event_actor_time_idx on audit_event (actor_user_id, occurred_at desc);

insert into role_definition (role_code, description, is_system)
values
  ('tenant_owner', 'Controls tenant administration and ownership.', true),
  ('tenant_admin', 'Manages tenant users, teams, and configuration.', true),
  ('tenant_member', 'Uses tenant application features assigned by policy.', true),
  ('tenant_viewer', 'Reads tenant application data assigned by policy.', true)
on conflict (role_code) do nothing;

commit;

