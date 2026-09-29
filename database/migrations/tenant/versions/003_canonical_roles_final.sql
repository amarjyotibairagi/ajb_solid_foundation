-- Canonical tenant roles cleanup and external operator audit columns

-- Step 1: Clean up legacy role assignments
do $$
declare
  r record;
begin
  for r in
    select 'admin' as legacy_code, 'tenant_admin' as canonical_code union all
    select 'manager', 'tenant_manager' union all
    select 'user', 'tenant_member' union all
    select 'guest', 'tenant_viewer'
  loop
    -- Delete redundant legacy assignment if canonical assignment already exists for the user
    delete from role_assignment
    where role_id = (select role_id from role_definition where role_code = r.legacy_code)
      and user_id in (
        select user_id from role_assignment
        where role_id = (select role_id from role_definition where role_code = r.canonical_code)
      );

    -- Remap remaining legacy assignments to canonical role IDs
    update role_assignment
    set role_id = (select role_id from role_definition where role_code = r.canonical_code)
    where role_id = (select role_id from role_definition where role_code = r.legacy_code);
  end loop;
end $$;

-- Step 2: Delete legacy role-permission mappings
delete from role_permission
where role_id in (select role_id from role_definition where role_code in ('admin', 'manager', 'user', 'guest'));

-- Step 3: Remove legacy role definitions
delete from role_definition
where role_code in ('admin', 'manager', 'user', 'guest');

-- Step 4: Add external operator audit columns
alter table audit_event
  add column if not exists actor_type text not null default 'user'
  check (actor_type in ('user', 'operator', 'system'));

alter table audit_event
  add column if not exists operator_id text;

alter table audit_event
  add column if not exists reason text;
