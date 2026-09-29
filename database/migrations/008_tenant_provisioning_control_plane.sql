-- Automated tenant lifecycle control plane and immutable host/session/database binding.
-- Apply as a PostgreSQL administrator. Runtime passwords are configured separately.

begin;

alter table platform.tenant_registry
  drop constraint if exists tenant_registry_schema_identifier_check,
  drop constraint if exists tenant_registry_lifecycle_status_check;

alter table platform.tenant_registry
  add column if not exists tenant_key text,
  add column if not exists legal_name text,
  add column if not exists slug text,
  add column if not exists db_role text,
  add column if not exists login_role text,
  add column if not exists credential_ref text,
  add column if not exists default_locale text not null default 'en',
  add column if not exists activated_at timestamptz,
  add column if not exists last_error_code text,
  add column if not exists last_error_at timestamptz;

alter table platform.tenant_registry
  add constraint tenant_registry_schema_identifier_check
    check (schema_identifier ~ '^tenant_[a-z0-9][a-z0-9_]{2,62}$'),
  add constraint tenant_registry_lifecycle_status_check
    check (lifecycle_status in (
      'provisioning', 'active', 'suspended', 'migration_failed',
      'provisioning_failed', 'deleting', 'deleted'
    ));

create unique index if not exists tenant_registry_tenant_key_uidx
  on platform.tenant_registry (tenant_key) where tenant_key is not null;
create unique index if not exists tenant_registry_slug_uidx
  on platform.tenant_registry (lower(slug))
  where slug is not null and lifecycle_status <> 'deleted';
create unique index if not exists tenant_registry_db_role_uidx
  on platform.tenant_registry (db_role) where db_role is not null;
create unique index if not exists tenant_registry_login_role_uidx
  on platform.tenant_registry (login_role) where login_role is not null;

create table if not exists platform.tenant_domain (
  domain_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenant_registry(tenant_id) on delete restrict,
  hostname text not null,
  subdomain text not null,
  is_primary boolean not null default false,
  status text not null default 'pending'
    check (status in ('pending', 'active', 'disabled', 'failed')),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (hostname = lower(hostname)),
  check (hostname ~ '^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$'),
  check (subdomain ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$')
);

create unique index if not exists tenant_domain_hostname_uidx
  on platform.tenant_domain (lower(hostname));
create unique index if not exists tenant_domain_subdomain_uidx
  on platform.tenant_domain (lower(subdomain));
create unique index if not exists tenant_domain_one_primary_uidx
  on platform.tenant_domain (tenant_id) where is_primary;

create table if not exists platform.tenant_branding (
  tenant_id uuid primary key references platform.tenant_registry(tenant_id) on delete cascade,
  logo_url text,
  primary_color text not null default '#2563eb'
    check (primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  secondary_color text not null default '#0f172a'
    check (secondary_color ~ '^#[0-9A-Fa-f]{6}$'),
  login_background text,
  login_message text,
  default_locale text not null default 'en'
    check (default_locale ~ '^[a-z]{2}(?:-[A-Z]{2})?$'),
  safe_metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(safe_metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists platform.tenant_provisioning_job (
  job_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenant_registry(tenant_id) on delete restrict,
  requested_by uuid references platform.platform_user(id) on delete set null,
  correlation_id uuid not null,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'succeeded', 'failed', 'retrying', 'rolled_back')),
  current_step text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  retryable boolean not null default true,
  safe_error_code text,
  safe_error_message text,
  worker_id text,
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create unique index if not exists tenant_provisioning_one_open_job_uidx
  on platform.tenant_provisioning_job (tenant_id)
  where status in ('pending', 'running', 'retrying');
create index if not exists tenant_provisioning_job_queue_idx
  on platform.tenant_provisioning_job (status, created_at);

create table if not exists platform.tenant_provisioning_step (
  job_id uuid not null references platform.tenant_provisioning_job(job_id) on delete cascade,
  step_code text not null,
  step_order integer not null check (step_order > 0),
  status text not null default 'pending'
    check (status in ('pending', 'running', 'succeeded', 'failed', 'skipped')),
  display_message text not null,
  safe_error_message text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (job_id, step_code),
  unique (job_id, step_order)
);

drop trigger if exists tenant_domain_set_updated_at on platform.tenant_domain;
create trigger tenant_domain_set_updated_at before update on platform.tenant_domain
for each row execute function platform.set_updated_at();
drop trigger if exists tenant_branding_set_updated_at on platform.tenant_branding;
create trigger tenant_branding_set_updated_at before update on platform.tenant_branding
for each row execute function platform.set_updated_at();
drop trigger if exists tenant_provisioning_job_set_updated_at on platform.tenant_provisioning_job;
create trigger tenant_provisioning_job_set_updated_at before update on platform.tenant_provisioning_job
for each row execute function platform.set_updated_at();
drop trigger if exists tenant_provisioning_step_set_updated_at on platform.tenant_provisioning_step;
create trigger tenant_provisioning_step_set_updated_at before update on platform.tenant_provisioning_step
for each row execute function platform.set_updated_at();

alter table platform.tenant_domain owner to platform_owner;
alter table platform.tenant_branding owner to platform_owner;
alter table platform.tenant_provisioning_job owner to platform_owner;
alter table platform.tenant_provisioning_step owner to platform_owner;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'tenant_registry_reader_login') then
    create role tenant_registry_reader_login nologin noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'tenant_provisioner') then
    create role tenant_provisioner nologin noinherit nosuperuser nocreatedb createrole nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'tenant_provisioner_login') then
    create role tenant_provisioner_login nologin noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end $$;

grant tenant_provisioner to tenant_provisioner_login;
grant tenant_template_owner to tenant_provisioner;
grant connect, create on database platform_db to tenant_provisioner;
grant usage on schema platform to platform_bff_runtime, tenant_registry_reader_login, tenant_provisioner;

grant select, insert, update on platform.tenant_registry,
  platform.tenant_domain, platform.tenant_branding,
  platform.tenant_provisioning_job, platform.tenant_provisioning_step
  to platform_bff_runtime;
grant select on platform.tenant_registry, platform.tenant_domain, platform.tenant_branding
  to tenant_registry_reader_login;
grant select, insert, update on platform.tenant_registry,
  platform.tenant_domain, platform.tenant_branding,
  platform.tenant_provisioning_job, platform.tenant_provisioning_step
  to tenant_provisioner;
grant select, insert on platform.platform_audit to tenant_provisioner;

alter table consumer.user_account force row level security;
alter table consumer.user_identity force row level security;
alter table consumer.user_role_assignment force row level security;
alter table consumer.collaboration_group force row level security;
alter table consumer.group_membership force row level security;
alter table consumer.group_invitation force row level security;
alter table consumer.subscription force row level security;
alter table consumer.audit_event force row level security;

insert into platform.schema_migration (migration_key, migration_scope)
values ('008_tenant_provisioning_control_plane:v1', 'platform')
on conflict (migration_key) do nothing;

commit;
