-- Records the baseline state after all domain schemas have been created.

create table if not exists consumer.schema_metadata (
  singleton boolean primary key default true check (singleton),
  schema_version integer not null check (schema_version > 0),
  migrated_at timestamptz not null default now()
);

insert into consumer.schema_metadata (singleton, schema_version)
values (true, 1)
on conflict (singleton) do update
set schema_version = greatest(consumer.schema_metadata.schema_version, excluded.schema_version),
    migrated_at = now();

insert into platform.schema_migration (migration_key, migration_scope)
values
  ('000_platform_baseline', 'platform'),
  ('001_platform_security', 'platform'),
  ('002_platform_role_check', 'platform'),
  ('003_platform_control_plane', 'platform'),
  ('consumer/individuals:v1', 'consumer')
on conflict (migration_key) do nothing;
