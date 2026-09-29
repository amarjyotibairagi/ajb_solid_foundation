begin;

-- Reserved for a future aggregate-only ingestion pipeline. Keeping this role
-- NOLOGIN and grant-free prevents dormant capabilities from becoming an
-- accidental access path before that pipeline has an explicit threat model.
revoke all on schema platform from analytics_writer;
revoke all on platform.tenant_registry, platform.plan_catalog,
  platform.usage_aggregate from analytics_writer;

alter role analytics_writer nologin noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
comment on role analytics_writer is
  'Reserved NOLOGIN role for a future privacy-safe aggregate ingestion pipeline; intentionally has no grants.';

insert into platform.schema_migration (migration_key, migration_scope)
values ('012_reserve_analytics_writer:v1', 'grants')
on conflict (migration_key) do nothing;

commit;
