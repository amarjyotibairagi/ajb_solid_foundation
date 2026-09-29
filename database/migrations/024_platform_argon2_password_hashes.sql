-- Migration 024: Argon2id password hashes for the platform control plane.
--
-- The platform BFF previously verified operator passwords with pgcrypto's
-- crypt() inside SQL, which meant every login sent the plaintext password to
-- the database server as a bind parameter -- recoverable from statement logs,
-- pg_stat_activity, or any auditing extension. The tenant and public BFFs
-- already verified argon2id in-process; this brings the most privileged plane
-- in line with the other two and removes the plaintext hop entirely.
--
-- PREREQUISITE: every platform_user row must already carry an argon2id hash.
-- Convert legacy bcrypt accounts first:
--
--     node scripts/platform-operator.mjs set-password --username <name>
--
-- This migration fails closed, naming the offending accounts, rather than
-- silently locking anyone out or silently accepting a weaker format.

begin;

do $$
declare
  offenders text;
begin
  select string_agg(username, ', ' order by username) into offenders
  from platform.platform_user
  where password_hash is not null and password_hash not like '$argon2id$%';

  if offenders is not null then
    raise exception
      'Cannot enforce argon2id password hashes: account(s) % still use a legacy hash. Run: node scripts/platform-operator.mjs set-password --username <name>',
      offenders
      using errcode = '55000';
  end if;
end
$$;

alter table platform.platform_user
  drop constraint if exists platform_user_password_hash_format_check;

alter table platform.platform_user
  add constraint platform_user_password_hash_format_check
  check (password_hash is null or password_hash like '$argon2id$%');

-- The platform BFF no longer needs pgcrypto to authenticate. Other callers
-- (gen_random_uuid) still do, so the extension itself stays.

insert into platform.schema_migration (migration_key, migration_scope)
values ('024_platform_argon2_password_hashes:v1', 'platform')
on conflict (migration_key) do nothing;

commit;
