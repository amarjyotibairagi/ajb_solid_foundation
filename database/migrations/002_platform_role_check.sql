-- Restricts platform.platform_user.role to the three valid platform RBAC
-- roles at the database level. Previously the column was an unconstrained
-- varchar(50); backend/src/server.ts's normalizeRole() had to defend against
-- arbitrary stored values, and did so by defaulting unrecognized values to
-- the most-privileged role (platform_owner) -- a fail-open bug fixed
-- separately in application code. This migration closes the gap at the data
-- layer so a stray value can never reach the application in the first place.
--
-- IMPORTANT: run this as the schema owner / migration role (e.g. the
-- `postgres` superuser credentials), NOT via DATABASE_URL
-- (platform_bff_runtime), which per database/runtime-role-platform.sql only
-- has SELECT on platform_user and cannot perform the UPDATE or ALTER TABLE
-- below.
--
-- Usage:
--   psql "postgresql://postgres:<password>@<host>:<port>/platform_db" \
--     -f database/migrations/002_platform_role_check.sql

do $$
declare
  bad_role_count integer;
begin
  select count(*) into bad_role_count
  from platform.platform_user
  where role not in ('platform_owner', 'platform_admin', 'platform_viewer');

  if bad_role_count > 0 then
    raise notice
      'platform_user: % row(s) have a role outside the allowed set and will be demoted to platform_viewer before the CHECK constraint is applied. Review these accounts and manually reassign correct roles after this migration completes.',
      bad_role_count;
  end if;
end $$;

-- Fail closed: any row that does not already hold a recognized role is
-- demoted to the least-privileged role rather than left as-is (which would
-- block the constraint below) or deleted (which could unexpectedly remove an
-- account). An operator can promote a legitimately-demoted admin back after
-- reviewing the notice above.
update platform.platform_user
set role = 'platform_viewer'
where role not in ('platform_owner', 'platform_admin', 'platform_viewer');

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'platform_user_role_check'
      and conrelid = 'platform.platform_user'::regclass
  ) then
    alter table platform.platform_user
      add constraint platform_user_role_check
      check (role in ('platform_owner', 'platform_admin', 'platform_viewer'));
  end if;
end $$;

comment on constraint platform_user_role_check on platform.platform_user is
  'Restricts role to platform_owner, platform_admin, or platform_viewer. See 001_platform_security.sql for column history.';
