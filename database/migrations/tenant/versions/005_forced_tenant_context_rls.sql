-- Bind every tenant schema to its immutable platform tenant UUID and require
-- transaction-local app.tenant_id for protected tenant-table access.

alter table schema_metadata
  add column if not exists tenant_id uuid;

do $$
declare
  configured_tenant text := nullif(current_setting('app.migration_tenant_id', true), '');
  metadata_tenant text;
begin
  if configured_tenant is null or configured_tenant !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'app.migration_tenant_id must be a valid tenant UUID';
  end if;

  select tenant_id::text
    into metadata_tenant
    from schema_metadata
   where singleton = true;

  if metadata_tenant is not null and metadata_tenant <> configured_tenant then
    raise exception 'Tenant schema identity mismatch: metadata %, configured %', metadata_tenant, configured_tenant;
  end if;
end
$$;

update schema_metadata
   set tenant_id = nullif(current_setting('app.migration_tenant_id', true), '')::uuid,
       migrated_at = now()
 where singleton = true
   and tenant_id is null;

do $$
begin
  if exists (
    select 1
      from schema_metadata
     where singleton = true
       and tenant_id is null
  ) then
    raise exception 'schema_metadata.tenant_id could not be established';
  end if;
end
$$;

alter table schema_metadata
  alter column tenant_id set not null;

create unique index if not exists schema_metadata_tenant_id_uidx
  on schema_metadata (tenant_id);

create or replace function prevent_tenant_metadata_identity_change()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if new.tenant_id is distinct from old.tenant_id then
    raise exception 'schema_metadata.tenant_id is immutable';
  end if;
  return new;
end
$$;

drop trigger if exists schema_metadata_tenant_identity_immutable on schema_metadata;
create trigger schema_metadata_tenant_identity_immutable
before update on schema_metadata
for each row execute function prevent_tenant_metadata_identity_change();

-- Older tenant templates created user_session during provisioning. Make the
-- table part of the versioned schema so fresh tenants receive the same object
-- before RLS policies are installed.
create table if not exists user_session (
  session_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  user_id uuid not null references user_account(user_id) on delete cascade,
  token_hash text not null unique,
  csrf_hash text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check (expires_at > created_at)
);

create index if not exists user_session_expiry_idx on user_session(expires_at);

revoke all on schema_metadata from public;
revoke all on schema_migration from public;
grant select on schema_metadata, schema_migration to public;
revoke insert, update, delete, truncate, references, trigger on schema_metadata, schema_migration from public;

do $$
declare
  table_name text;
  policy_condition text;
  protected_tables constant text[] := array[
    'user_account',
    'user_identity',
    'permission',
    'role_definition',
    'role_permission',
    'role_assignment',
    'team',
    'team_membership',
    'tenant_setting',
    'subscription_entitlement',
    'audit_event',
    'user_session',
    'capability_delegation'
  ];
begin
  foreach table_name in array protected_tables loop
    if to_regclass(format('%I.%I', current_schema(), table_name)) is null then
      raise exception 'Required tenant table %.% is missing', current_schema(), table_name;
    end if;

    execute format('alter table %I enable row level security', table_name);
    execute format('alter table %I force row level security', table_name);
    execute format('drop policy if exists %I on %I', table_name || '_tenant_context', table_name);
    policy_condition := 'nullif(current_setting(''app.tenant_id'', true), '''') = (select tenant_id::text from schema_metadata where singleton = true)';
    if table_name = 'user_session' then
      policy_condition := policy_condition || ' and tenant_id::text = nullif(current_setting(''app.tenant_id'', true), '''')';
    end if;
    execute format(
      'create policy %I on %I as permissive using (%s) with check (%s)',
      table_name || '_tenant_context',
      table_name,
      policy_condition,
      policy_condition
    );
  end loop;
end
$$;
