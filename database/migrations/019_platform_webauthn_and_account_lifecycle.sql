-- Migration 019: Platform WebAuthn Credential, Challenge Storage, and Account Lifecycle
-- Defines production WebAuthn credential storage, challenge persistence with RP ID/origin/purpose bindings, and grants platform_bff_runtime DML.

begin;

create table if not exists platform.platform_webauthn_credential (
  credential_id text primary key, -- Base64URL credential ID
  user_id uuid not null references platform.platform_user(id) on delete cascade,
  public_key bytea not null,      -- COSE public key bytes
  counter bigint not null default 0,
  transports text[] null,
  aaguid text null,
  is_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  last_used_at timestamptz null
);

create index if not exists platform_webauthn_user_idx
  on platform.platform_webauthn_credential (user_id, is_enabled);

create table if not exists platform.platform_webauthn_challenge (
  challenge_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references platform.platform_user(id) on delete cascade,
  session_id uuid null references platform.platform_session(id) on delete cascade,
  challenge text not null,
  purpose text not null check (purpose in ('registration', 'authentication', 'step_up')),
  expected_origin text not null,
  expected_rp_id text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists platform_webauthn_challenge_lookup_idx
  on platform.platform_webauthn_challenge (challenge_id, user_id, purpose, expires_at)
  where consumed_at is null;

create index if not exists platform_webauthn_challenge_expiry_idx
  on platform.platform_webauthn_challenge (expires_at);

-- Clean up older challenge table from migration 018 if present
drop table if exists platform.operator_mfa_challenge cascade;

-- Grants to platform_bff_runtime
grant select, insert, update, delete on platform.platform_webauthn_credential to platform_bff_runtime;
grant select, insert, update, delete on platform.platform_webauthn_challenge to platform_bff_runtime;

insert into platform.schema_migration (migration_key, migration_scope)
values ('019_platform_webauthn_and_account_lifecycle:v1', 'platform')
on conflict (migration_key) do nothing;

commit;
