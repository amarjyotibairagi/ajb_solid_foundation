create schema if not exists platform;

alter table if exists platform.platform_user
  add column if not exists role varchar(50) not null default 'platform_owner';

create table if not exists platform.platform_session (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references platform.platform_user(id) on delete cascade,
  token_hash text not null unique,
  csrf_hash text not null,
  iap_subject text,
  iap_email text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists platform_session_user_id_idx
  on platform.platform_session(user_id);

create index if not exists platform_session_expires_at_idx
  on platform.platform_session(expires_at);

comment on table platform.platform_session is
  'Opaque server-side platform admin sessions. Browser receives only HttpOnly cookie plus short-lived CSRF token.';

comment on column platform.platform_user.role is
  'Platform-only RBAC role. Expected values: platform_owner, platform_admin, platform_viewer.';
