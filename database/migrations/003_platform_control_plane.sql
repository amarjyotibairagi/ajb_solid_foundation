-- Platform control-plane records. This schema must never contain tenant business
-- records, consumer profiles, raw events, credentials, or payment instruments.

alter table platform.platform_user
  add column if not exists identity_provider_subject text,
  add column if not exists email_normalized text,
  add column if not exists display_name text,
  add column if not exists department text,
  add column if not exists employment_status text not null default 'active',
  add column if not exists last_authenticated_at timestamptz;

create unique index if not exists platform_user_idp_subject_uidx
  on platform.platform_user (identity_provider_subject)
  where identity_provider_subject is not null;

create unique index if not exists platform_user_email_uidx
  on platform.platform_user (lower(email_normalized))
  where email_normalized is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'platform_user_employment_status_check'
      and conrelid = 'platform.platform_user'::regclass
  ) then
    alter table platform.platform_user
      add constraint platform_user_employment_status_check
      check (employment_status in ('invited', 'active', 'suspended', 'departed'));
  end if;
end $$;

create table if not exists platform.tenant_registry (
  tenant_id uuid primary key default gen_random_uuid(),
  display_name text not null,
  schema_identifier text not null unique,
  deployment_model text not null default 'shared_cluster_schema',
  database_target_ref text,
  lifecycle_status text not null default 'provisioning',
  primary_hostname text,
  region text not null,
  schema_version integer not null default 0 check (schema_version >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tenant_registry_schema_identifier_check
    check (schema_identifier ~ '^tenant_[a-z0-9][a-z0-9_]{7,62}$'),
  constraint tenant_registry_deployment_model_check
    check (deployment_model in ('shared_cluster_schema', 'dedicated_database')),
  constraint tenant_registry_lifecycle_status_check
    check (lifecycle_status in ('provisioning', 'active', 'suspended', 'migration_failed', 'deleting', 'deleted')),
  constraint tenant_registry_database_target_check
    check (
      (deployment_model = 'shared_cluster_schema' and database_target_ref is null)
      or
      (deployment_model = 'dedicated_database' and database_target_ref is not null)
    )
);

create unique index if not exists tenant_registry_hostname_uidx
  on platform.tenant_registry (lower(primary_hostname))
  where primary_hostname is not null and lifecycle_status <> 'deleted';

create index if not exists tenant_registry_status_idx
  on platform.tenant_registry (lifecycle_status);

create table if not exists platform.plan_catalog (
  plan_id uuid primary key default gen_random_uuid(),
  plan_code text not null unique check (plan_code ~ '^[a-z][a-z0-9_]{1,62}$'),
  display_name text not null,
  audience text not null check (audience in ('b2b', 'b2c', 'both')),
  entitlements jsonb not null default '{}'::jsonb check (jsonb_typeof(entitlements) = 'object'),
  version integer not null default 1 check (version > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists platform.tenant_subscription (
  subscription_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenant_registry(tenant_id) on delete restrict,
  plan_id uuid not null references platform.plan_catalog(plan_id) on delete restrict,
  status text not null check (status in ('trialing', 'active', 'past_due', 'paused', 'cancelled', 'expired')),
  entitlement_version integer not null check (entitlement_version > 0),
  period_start timestamptz,
  period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tenant_subscription_period_check
    check (period_end is null or period_start is null or period_end > period_start)
);

create unique index if not exists tenant_subscription_current_uidx
  on platform.tenant_subscription (tenant_id)
  where status in ('trialing', 'active', 'past_due', 'paused');

create table if not exists platform.usage_aggregate (
  aggregate_id uuid primary key default gen_random_uuid(),
  subject_type text not null check (subject_type in ('tenant', 'consumer_population', 'platform_total')),
  tenant_id uuid references platform.tenant_registry(tenant_id) on delete restrict,
  metric_name text not null check (metric_name ~ '^[a-z][a-z0-9_]{1,95}$'),
  metric_value numeric(30, 6) not null check (metric_value >= 0),
  plan_code text,
  window_start timestamptz not null,
  window_end timestamptz not null,
  calculated_at timestamptz not null default now(),
  source_version integer not null check (source_version > 0),
  constraint usage_aggregate_subject_check
    check ((subject_type = 'tenant') = (tenant_id is not null)),
  constraint usage_aggregate_window_check check (window_end > window_start),
  constraint usage_aggregate_plan_code_check
    check (plan_code is null or plan_code ~ '^[a-z][a-z0-9_]{1,62}$')
);

create index if not exists usage_aggregate_metric_window_idx
  on platform.usage_aggregate (metric_name, window_end desc);
create unique index if not exists usage_aggregate_identity_uidx
  on platform.usage_aggregate (
    subject_type,
    coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
    metric_name,
    coalesce(plan_code, ''),
    window_start,
    window_end,
    source_version
  );

alter table platform.platform_audit
  add column if not exists tenant_id uuid references platform.tenant_registry(tenant_id) on delete set null,
  add column if not exists resource_type text,
  add column if not exists resource_id text,
  add column if not exists correlation_id uuid,
  add column if not exists policy_decision text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'platform_audit_user_id_fkey'
      and conrelid = 'platform.platform_audit'::regclass
  ) then
    alter table platform.platform_audit
      add constraint platform_audit_user_id_fkey
      foreign key (user_id) references platform.platform_user(id) on delete set null;
  end if;
end $$;

create index if not exists platform_audit_timestamp_idx
  on platform.platform_audit (timestamp desc);
create index if not exists platform_audit_tenant_timestamp_idx
  on platform.platform_audit (tenant_id, timestamp desc)
  where tenant_id is not null;

create or replace function platform.set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.updated_at = clock_timestamp();
  return new;
end;
$$;

drop trigger if exists platform_user_set_updated_at on platform.platform_user;
create trigger platform_user_set_updated_at
before update on platform.platform_user
for each row execute function platform.set_updated_at();

drop trigger if exists tenant_registry_set_updated_at on platform.tenant_registry;
create trigger tenant_registry_set_updated_at
before update on platform.tenant_registry
for each row execute function platform.set_updated_at();

drop trigger if exists plan_catalog_set_updated_at on platform.plan_catalog;
create trigger plan_catalog_set_updated_at
before update on platform.plan_catalog
for each row execute function platform.set_updated_at();

drop trigger if exists tenant_subscription_set_updated_at on platform.tenant_subscription;
create trigger tenant_subscription_set_updated_at
before update on platform.tenant_subscription
for each row execute function platform.set_updated_at();

comment on table platform.usage_aggregate is
  'Privacy-safe numeric aggregates only. Never store identities, free text, raw events, IP addresses, or device identifiers.';
