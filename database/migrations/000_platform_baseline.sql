-- Reproducible baseline for the platform authentication domain.
-- Safe to run against the existing platform database.

create schema if not exists platform;

create table if not exists platform.platform_user (
  id uuid primary key default gen_random_uuid(),
  username varchar(255) not null unique,
  password_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists platform.platform_audit (
  id uuid primary key default gen_random_uuid(),
  timestamp timestamptz not null default now(),
  user_id uuid,
  feature varchar(100) not null,
  action varchar(100) not null,
  status varchar(50) not null
);

create table if not exists platform.schema_migration (
  migration_key text primary key,
  migration_scope text not null check (migration_scope in ('platform', 'consumer', 'tenant', 'grants')),
  applied_at timestamptz not null default now(),
  applied_by text not null default session_user
);

comment on schema platform is
  'Platform workforce authentication, tenant control-plane metadata, and privacy-safe aggregates only.';
