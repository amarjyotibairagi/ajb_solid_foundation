-- Migration 025: platform_session.mfa_verified_at.
--
-- This column records when a session last completed a WebAuthn step-up, and
-- requireRecentMfa() in the platform BFF gates every control-plane mutation on
-- it. It existed in production but no migration file created it: the only file
-- that did was 018, which was never recorded in the production ledger and was
-- superseded by 019 (019 reads and writes the column but assumes it is already
-- there). Removing 018 from the canonical sequence made that gap visible -- a
-- database rebuilt from the manifest came up without the column and every MFA
-- path failed.
--
-- Idempotent, so it is a no-op on the production database that already has it.

begin;

alter table platform.platform_session
  add column if not exists mfa_verified_at timestamptz;

comment on column platform.platform_session.mfa_verified_at is
  'Timestamp of the last successful WebAuthn step-up for this session; NULL means password-only.';

insert into platform.schema_migration (migration_key, migration_scope)
values ('025_platform_session_mfa_verified_at:v1', 'platform')
on conflict (migration_key) do nothing;

commit;
