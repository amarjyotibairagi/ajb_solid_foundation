-- File service metadata. Object bytes live in the tenant's storage backend:
-- the VDS disk by default, or its own S3-compatible bucket. Each object
-- records the backend it was written to (storage_ref: 'vds' or the platform
-- integration id), so switching backends never breaks reads.

create table if not exists stored_object (
  object_id uuid primary key default gen_random_uuid(),
  storage_ref text not null check (storage_ref = 'vds' or storage_ref ~ '^[0-9a-f-]{36}$'),
  object_key text not null check (length(object_key) between 1 and 512),
  file_name text not null check (length(btrim(file_name)) between 1 and 255),
  content_type text not null default 'application/octet-stream' check (length(content_type) <= 255),
  size_bytes bigint not null check (size_bytes >= 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  module_code text check (module_code is null or module_code ~ '^[a-z][a-z0-9_]{1,40}$'),
  created_by uuid references user_account(user_id) on delete set null,
  created_at timestamptz not null default now(),
  unique (storage_ref, object_key)
);

create index if not exists stored_object_created_idx on stored_object (created_at desc);
create index if not exists stored_object_ref_idx on stored_object (storage_ref);

insert into permission (permission_code, description)
values
  ('tenant.files.read', 'Read and download workspace files.'),
  ('tenant.files.write', 'Upload and delete workspace files.'),
  ('tenant.integrations.manage', 'Connect the workspace to its own storage or database.')
on conflict (permission_code) do update
set description = excluded.description;

insert into role_permission (role_id, permission_id)
select r.role_id, p.permission_id
from role_definition r
cross join permission p
where (r.role_code in ('tenant_owner', 'tenant_admin', 'tenant_manager', 'tenant_member', 'tenant_viewer')
       and p.permission_code = 'tenant.files.read')
   or (r.role_code in ('tenant_owner', 'tenant_admin', 'tenant_manager', 'tenant_member')
       and p.permission_code = 'tenant.files.write')
   or (r.role_code = 'tenant_owner' and p.permission_code = 'tenant.integrations.manage')
on conflict do nothing;
