-- Tenant-issued invitations and tenant-editable settings.
--
-- An invited user_account stays 'invited' (unable to sign in) until the
-- invitee redeems a single-use token and sets a password. Tokens are stored
-- only as SHA-256 hashes. Grants and RLS for this table come from
-- database/migrations/tenant/access-manifest.json, not from this file.

create table if not exists user_invitation (
  invitation_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references user_account(user_id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  invited_by uuid references user_account(user_id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  check (expires_at > created_at),
  check (accepted_at is null or revoked_at is null)
);

create index if not exists user_invitation_user_idx on user_invitation (user_id, created_at desc);

insert into permission (permission_code, description)
values
  ('tenant.settings.read', 'Read tenant configuration and entitlements.'),
  ('tenant.settings.manage', 'Change tenant-editable settings.')
on conflict (permission_code) do update
set description = excluded.description;

insert into role_permission (role_id, permission_id)
select r.role_id, p.permission_id
from role_definition r
cross join permission p
where r.role_code in ('tenant_owner', 'tenant_admin')
  and p.permission_code in ('tenant.settings.read', 'tenant.settings.manage')
on conflict do nothing;
