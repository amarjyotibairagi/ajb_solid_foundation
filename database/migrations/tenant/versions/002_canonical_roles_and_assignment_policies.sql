-- Canonical tenant roles and permissions definition
create table if not exists schema_migration (
  version integer primary key,
  filename text not null,
  checksum text not null,
  applied_at timestamptz not null default now()
);

insert into role_definition (role_code, description, is_system)
values
  ('tenant_owner', 'Controls tenant administration and ownership.', true),
  ('tenant_admin', 'Manages tenant users, teams, and configuration.', true),
  ('tenant_manager', 'Invites and views tenant members.', true),
  ('tenant_member', 'Uses tenant application features assigned by policy.', true),
  ('tenant_viewer', 'Reads tenant application data assigned by policy.', true)
on conflict (role_code) do update set
  description = excluded.description,
  is_system = true;

insert into permission (permission_code, description)
values
  ('tenant.users.read', 'Read the tenant member directory.'),
  ('tenant.users.create', 'Invite tenant members.'),
  ('tenant.users.roles', 'Change tenant member roles.'),
  ('tenant.audit.read', 'Read the tenant audit trail.'),
  ('tenant.stats.read', 'Read tenant aggregate statistics.')
on conflict (permission_code) do update set
  description = excluded.description;

-- Ensure canonical permission mappings
insert into role_permission (role_id, permission_id)
select r.role_id, p.permission_id
from role_definition r
cross join permission p
where
  (r.role_code in ('tenant_owner', 'tenant_admin', 'admin'))
  or (r.role_code in ('tenant_manager', 'manager') and p.permission_code in
    ('tenant.users.read', 'tenant.users.create', 'tenant.audit.read', 'tenant.stats.read'))
  or (r.role_code in ('tenant_member', 'user') and p.permission_code in
    ('tenant.users.read', 'tenant.stats.read'))
  or (r.role_code in ('tenant_viewer', 'guest') and p.permission_code = 'tenant.stats.read')
on conflict do nothing;

-- Map legacy role assignments to canonical roles if legacy roles were assigned
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
    update role_assignment ra
    set role_id = (select role_id from role_definition where role_code = r.canonical_code)
    where ra.role_id = (select role_id from role_definition where role_code = r.legacy_code)
      and not exists (
        select 1 from role_assignment ra2
        where ra2.user_id = ra.user_id
          and ra2.role_id = (select role_id from role_definition where role_code = r.canonical_code)
      );
  end loop;
end $$;
