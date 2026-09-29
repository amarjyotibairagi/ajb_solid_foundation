-- Narrowly allow-listed per-user capability delegation (example module).
-- Delegations never change role_assignment or canonical role rank.

insert into permission (permission_code, description)
values
  ('tenant.modules.read', 'Read tenant module content.'),
  ('tenant.modules.author', 'Author tenant module content.'),
  ('tenant.modules.assign', 'Assign tenant module content.'),
  ('tenant.delegations.read', 'Read manager capability delegations.'),
  ('tenant.delegations.manage', 'Grant and revoke manager capability delegations.')
on conflict (permission_code) do update
set description = excluded.description;

insert into role_permission (role_id, permission_id)
select r.role_id, p.permission_id
from role_definition r
cross join permission p
where r.role_code in ('tenant_owner', 'tenant_admin')
  and p.permission_code in (
    'tenant.modules.read',
    'tenant.modules.author',
    'tenant.modules.assign',
    'tenant.delegations.read',
    'tenant.delegations.manage'
  )
on conflict do nothing;

insert into role_permission (role_id, permission_id)
select r.role_id, p.permission_id
from role_definition r
cross join permission p
where r.role_code = 'tenant_manager'
  and p.permission_code in ('tenant.modules.read', 'tenant.delegations.read')
on conflict do nothing;

create table if not exists capability_delegation (
  delegation_id uuid primary key default gen_random_uuid(),
  grantee_user_id uuid not null references user_account(user_id) on delete cascade,
  permission_code text not null references permission(permission_code) on delete restrict
    check (permission_code in ('tenant.modules.author', 'tenant.modules.assign')),
  status text not null default 'active'
    check (status in ('active', 'revoked')),
  granted_by uuid not null references user_account(user_id) on delete restrict,
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_by uuid references user_account(user_id) on delete restrict,
  revoked_at timestamptz,
  reason text not null check (length(btrim(reason)) between 1 and 500),
  check (expires_at is null or expires_at > granted_at),
  check (
    (status = 'active' and revoked_at is null and revoked_by is null)
    or
    (status = 'revoked' and revoked_at is not null and revoked_by is not null)
  )
);

create unique index if not exists capability_delegation_active_unique
  on capability_delegation (grantee_user_id, permission_code)
  where status = 'active';

create index if not exists capability_delegation_grantee_idx
  on capability_delegation (grantee_user_id, status, expires_at);

create index if not exists capability_delegation_permission_idx
  on capability_delegation (permission_code, status);
