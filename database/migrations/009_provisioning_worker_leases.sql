begin;

create index if not exists tenant_provisioning_running_lease_idx
  on platform.tenant_provisioning_job (locked_at)
  where status = 'running';

insert into platform.schema_migration (migration_key, migration_scope)
values ('009_provisioning_worker_leases:v1', 'platform')
on conflict (migration_key) do nothing;

commit;
