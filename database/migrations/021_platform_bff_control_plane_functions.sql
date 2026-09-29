-- Migration 021: Platform BFF Control-Plane Functions and Direct Mutation Revocation

begin;

-- Step 1: Revoke all direct UPDATE privileges on jobs and steps from platform_bff_runtime
revoke update on platform.tenant_provisioning_job from platform_bff_runtime;
revoke update on platform.tenant_provisioning_step from platform_bff_runtime;

-- Step 2: Define security definer function for retrying provisioning/deprovisioning jobs
create or replace function platform.retry_tenant_provisioning_job(
  p_job_id uuid,
  p_actor_user_id text,
  p_correlation_id text default null
) returns boolean as $$
declare
  v_tenant_id uuid;
  v_job_type text;
  v_job_status text;
  v_retryable boolean;
  v_corr_id text;
begin
  select j.tenant_id, j.job_type, j.status, j.retryable, coalesce(p_correlation_id, j.correlation_id::text)
    into v_tenant_id, v_job_type, v_job_status, v_retryable, v_corr_id
    from platform.tenant_provisioning_job j
   where j.job_id = p_job_id
     for update;

  if not found or v_job_status <> 'failed' or not v_retryable then
    return false;
  end if;

  update platform.tenant_provisioning_step
     set status = 'pending', safe_error_message = null, completed_at = null
   where job_id = p_job_id and status = 'failed';

  update platform.tenant_provisioning_job
     set status = 'retrying', safe_error_code = null, safe_error_message = null,
         completed_at = null, worker_id = null, locked_at = null
   where job_id = p_job_id;

  if v_job_type = 'deprovision' then
    update platform.tenant_registry
       set lifecycle_status = 'deleting'
     where tenant_id = v_tenant_id and lifecycle_status = 'deletion_failed';
  else
    update platform.tenant_registry
       set lifecycle_status = 'provisioning'
     where tenant_id = v_tenant_id and lifecycle_status = 'provisioning_failed';
  end if;

  insert into platform.platform_audit (
    user_id, tenant_id, feature, action, status,
    resource_type, resource_id, correlation_id, policy_decision
  ) values (
    p_actor_user_id,
    v_tenant_id,
    'tenant_provisioning',
    case when v_job_type = 'deprovision' then 'deprovisioning_retried' else 'provisioning_retried' end,
    'success',
    'provisioning_job',
    p_job_id::text,
    v_corr_id,
    'allow'
  );

  return true;
end;
$$ language plpgsql security definer set search_path = platform, pg_catalog;

alter function platform.retry_tenant_provisioning_job(uuid, text, text) owner to platform_owner;
revoke all on function platform.retry_tenant_provisioning_job(uuid, text, text) from public;
grant execute on function platform.retry_tenant_provisioning_job(uuid, text, text) to platform_bff_runtime;

insert into platform.schema_migration (migration_key, migration_scope)
values ('021_platform_bff_control_plane_functions:v1', 'platform')
on conflict (migration_key) do nothing;

commit;
