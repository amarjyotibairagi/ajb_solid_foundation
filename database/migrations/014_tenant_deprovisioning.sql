-- Tenant deprovisioning: job-type discriminator on the existing provisioning
-- job/step tables, plus a dedicated failure state so a stalled teardown is
-- distinguishable from a stalled provision. Apply as a PostgreSQL administrator.

begin;

alter table platform.tenant_provisioning_job
  add column if not exists job_type text not null default 'provision';

alter table platform.tenant_provisioning_job
  drop constraint if exists tenant_provisioning_job_job_type_check;

alter table platform.tenant_provisioning_job
  add constraint tenant_provisioning_job_job_type_check
    check (job_type in ('provision', 'deprovision'));

alter table platform.tenant_registry
  drop constraint if exists tenant_registry_lifecycle_status_check;

alter table platform.tenant_registry
  add constraint tenant_registry_lifecycle_status_check
    check (lifecycle_status in (
      'provisioning', 'active', 'suspended', 'migration_failed',
      'provisioning_failed', 'deleting', 'deletion_failed', 'deleted'
    ));

insert into platform.schema_migration (migration_key, migration_scope)
values ('014_tenant_deprovisioning:v1', 'platform')
on conflict (migration_key) do nothing;

commit;
