import { randomBytes, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'

export const reservedSubdomains = new Set([
  'www',
  'api',
  'admin',
  'platform',
  'app',
  'mail',
  'smtp',
  'ftp',
  'support',
  'status',
  'cdn',
  'assets',
  'static',
  'auth',
  'login',
  'billing',
  'docs',
  'dev',
  'test',
  'staging',
  'user',
  'public',
])

const subdomainPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const colorPattern = /^#[0-9A-Fa-f]{6}$/

export const createTenantSchema = z.object({
  displayName: z.string().trim().min(2).max(160),
  legalName: z.string().trim().min(2).max(240).optional(),
  subdomain: z
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(63)
    .regex(subdomainPattern)
    .refine((value) => !reservedSubdomains.has(value), 'This subdomain is reserved.'),
  region: z.string().trim().min(2).max(32).default('global'),
  locale: z.string().trim().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/).default('en'),
  logoUrl: z.union([z.url().max(2048), z.literal('')]).optional(),
  primaryColor: z.string().regex(colorPattern).default('#2563eb'),
  secondaryColor: z.string().regex(colorPattern).default('#0f172a'),
  loginMessage: z.string().trim().max(300).optional(),
  // Optional onboarding: when present, the owner receives a single-use
  // invitation link that becomes usable once the tenant is active.
  owner: z
    .object({
      email: z.email().max(320),
      displayName: z.string().trim().min(1).max(255),
    })
    .optional(),
  planCode: z.string().trim().regex(/^[a-z][a-z0-9_]{1,62}$/).optional(),
  // Defaults to the tenancy.default_connection_tier setting (plan, then platform).
  connectionTier: z.enum(['dedicated', 'pooled']).optional(),
})

export const provisioningStepDefinitions = [
  ['VALIDATE_TENANT_INPUT', 'Tenant information validated'],
  ['NORMALIZE_SUBDOMAIN', 'Subdomain normalized'],
  ['VALIDATE_SUBDOMAIN', 'Subdomain security checks completed'],
  ['CHECK_SUBDOMAIN_AVAILABILITY', 'Subdomain reservation verified'],
  ['GENERATE_IMMUTABLE_TENANT_ID', 'Immutable tenant identity verified'],
  ['RESERVE_TENANT_IDENTITY', 'Tenant identity reserved'],
  ['CREATE_TENANT_REGISTRY_RECORD', 'Tenant registry record created'],
  ['CREATE_TENANT_DATABASE_ROLE', 'Creating secure tenant database'],
  ['CREATE_TENANT_SCHEMA', 'Creating isolated tenant database'],
  ['APPLY_TENANT_SCHEMA_MIGRATIONS', 'Applying tenant structure'],
  ['APPLY_REQUIRED_SEED_DATA', 'Configuring tenant roles and permissions'],
  ['APPLY_SCHEMA_PRIVILEGES', 'Configuring tenant isolation'],
  ['CONFIGURE_ROLE_SEARCH_PATH', 'Configuring database defaults'],
  ['REGISTER_DATABASE_ACCESS', 'Configuring pooled database access'],
  ['REGISTER_TENANT_DOMAIN', 'Registering tenant route'],
  ['STORE_TENANT_BRANDING', 'Storing safe tenant branding'],
  ['VERIFY_DATABASE_ISOLATION', 'Verifying security boundary'],
  ['VERIFY_TENANT_RESOLUTION', 'Verifying tenant route'],
  ['VERIFY_TENANT_LOGIN_CONTEXT', 'Verifying tenant authentication context'],
  ['ACTIVATE_TENANT_DOMAIN', 'Activating tenant hostname'],
  ['VERIFY_EDGE_REACHABILITY', 'Verifying reachability over the public edge'],
  ['ACTIVATE_TENANT', 'Activating tenant'],
] as const

export const deprovisioningStepDefinitions = [
  ['DEPROV_VALIDATE_ELIGIBLE', 'Tenant eligibility for removal verified'],
  ['DEPROV_MARK_DELETING', 'Tenant marked for removal'],
  ['DEPROV_REVOKE_DATABASE_ACCESS', 'Pooled database access revoked'],
  ['DEPROV_DROP_SCHEMA', 'Tenant database removed'],
  ['DEPROV_DROP_DATABASE_ROLE', 'Tenant database identity removed'],
  ['DEPROV_REMOVE_CREDENTIAL_FILE', 'Tenant credential removed'],
  ['DEPROV_REMOVE_LOCAL_STORAGE', 'Tenant files on the VDS removed'],
  ['DEPROV_FINALIZE', 'Tenant removal finalized'],
] as const

export const tenantKeyParamsSchema = z.object({ tenantKey: z.string().trim().regex(/^T[A-Z0-9]{10,63}$/) })

type CreateTenantInput = z.infer<typeof createTenantSchema>

export class TenantProvisioningConflictError extends Error {}
export class TenantStateConflictError extends Error {}

function generateTenantIdentity() {
  const tenantKey = `T${randomBytes(10).toString('hex').toUpperCase()}`
  const opaque = tenantKey.toLowerCase()
  return {
    tenantKey,
    schemaName: `tenant_${opaque}`,
    dbRole: `tenant_${opaque}_runtime`,
    loginRole: `tenant_${opaque}_login`,
  }
}

async function transaction<T>(pool: Pool, callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('begin isolation level serializable')
    const result = await callback(client)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

export async function createTenantProvisioningJob(
  pool: Pool,
  input: CreateTenantInput & { connectionTier: 'dedicated' | 'pooled' },
  actorUserId: string,
  rootDomain: string,
  correlationId = randomUUID(),
) {
  const identity = generateTenantIdentity()
  // Pooled tenants share one login (tenant_pool_login); isolation is still
  // the per-tenant schema, runtime role and forced RLS.
  const loginRole = input.connectionTier === 'pooled' ? 'tenant_pool_login' : identity.loginRole
  const hostname = `${input.subdomain}.${rootDomain}`
  try {
    return await transaction(pool, async (client) => {
      const tenant = await client.query<{ tenant_id: string }>(
        `insert into platform.tenant_registry (
           tenant_key, display_name, legal_name, slug, schema_identifier,
           db_role, login_role, credential_ref, lifecycle_status,
           primary_hostname, region, default_locale, identity_scheme, connection_tier
         ) values ($1, $2, $3, $4, $5, $6, $7, $1, 'provisioning', $8, $9, $10, 'tenant_key_v1', $11)
         returning tenant_id::text`,
        [
          identity.tenantKey,
          input.displayName,
          input.legalName || input.displayName,
          input.subdomain,
          identity.schemaName,
          identity.dbRole,
          loginRole,
          hostname,
          input.region,
          input.locale,
          input.connectionTier,
        ],
      )
      const tenantId = tenant.rows[0]?.tenant_id
      if (!tenantId) throw new Error('Tenant registry insertion failed.')
      await client.query(
        `insert into platform.tenant_domain (tenant_id, hostname, subdomain, is_primary, status)
         values ($1, $2, $3, true, 'pending')`,
        [tenantId, hostname, input.subdomain],
      )
      await client.query(
        `insert into platform.tenant_branding (
           tenant_id, logo_url, primary_color, secondary_color,
           login_message, default_locale
         ) values ($1, $2, $3, $4, $5, $6)`,
        [
          tenantId,
          input.logoUrl || null,
          input.primaryColor,
          input.secondaryColor,
          input.loginMessage || `Sign in with your ${input.displayName} credentials.`,
          input.locale,
        ],
      )
      const job = await client.query<{ job_id: string }>(
        `insert into platform.tenant_provisioning_job (
           tenant_id, requested_by, correlation_id, status
         ) values ($1, $2, $3, 'pending') returning job_id::text`,
        [tenantId, actorUserId, correlationId],
      )
      const jobId = job.rows[0]?.job_id
      if (!jobId) throw new Error('Provisioning job insertion failed.')
      for (const [index, [stepCode, displayMessage]] of provisioningStepDefinitions.entries()) {
        await client.query(
          `insert into platform.tenant_provisioning_step
             (job_id, step_code, step_order, display_message)
           values ($1, $2, $3, $4)`,
          [jobId, stepCode, index + 1, displayMessage],
        )
      }
      await client.query(
        `insert into platform.platform_audit (
           user_id, tenant_id, feature, action, status,
           resource_type, resource_id, correlation_id, policy_decision
         ) values ($1, $2, 'tenant_provisioning', 'tenant_created', 'success',
                   'tenant', $3, $4, 'allow')`,
        [actorUserId, tenantId, identity.tenantKey, correlationId],
      )
      return {
        tenant: {
          tenantId: identity.tenantKey,
          displayName: input.displayName,
          hostname,
          subdomain: input.subdomain,
          status: 'provisioning',
          connectionTier: input.connectionTier,
        },
        jobId,
        correlationId,
      }
    })
  } catch (error) {
    if ((error as { code?: string }).code === '23505' || (error as { code?: string }).code === '40001') {
      throw new TenantProvisioningConflictError('The requested subdomain is already reserved.')
    }
    throw error
  }
}

export async function listTenants(pool: Pool) {
  const result = await pool.query(
    `select t.tenant_key as "tenantId", t.display_name as "displayName",
            d.hostname, d.subdomain, t.lifecycle_status as status,
            t.region, t.created_at as "createdAt", t.activated_at as "activatedAt",
            t.connection_tier as "connectionTier", t.schema_version as "schemaVersion",
            (t.data_integration_id is not null) as "byoDatabase", (t.storage_integration_id is not null) as "byoStorage",
            j.job_id::text as "jobId", j.status as "jobStatus", j.current_step as "currentStep"
       from platform.tenant_registry t
       left join platform.tenant_domain d on d.tenant_id = t.tenant_id and d.is_primary
       left join lateral (
         select job_id, status, current_step from platform.tenant_provisioning_job
          where tenant_id = t.tenant_id order by created_at desc limit 1
       ) j on true
      where t.lifecycle_status <> 'deleted'
      order by t.created_at desc`,
  )
  return result.rows
}

export async function getProvisioningJob(pool: Pool, jobId: string) {
  const job = await pool.query(
    `select j.job_id::text as "jobId", t.tenant_key as "tenantId",
            t.display_name as "displayName", d.hostname,
            j.status, j.current_step as "currentStep", j.attempt_count as "attemptCount",
            j.retryable, j.safe_error_code as "errorCode",
            j.safe_error_message as "errorMessage", j.correlation_id::text as "correlationId",
            j.created_at as "createdAt", j.started_at as "startedAt", j.completed_at as "completedAt"
       from platform.tenant_provisioning_job j
       join platform.tenant_registry t on t.tenant_id = j.tenant_id
       join platform.tenant_domain d on d.tenant_id = t.tenant_id and d.is_primary
      where j.job_id = $1`,
    [jobId],
  )
  if (!job.rows[0]) return null
  const steps = await pool.query(
    `select step_code as "stepCode", step_order as "stepOrder", status,
            display_message as "message", safe_error_message as "errorMessage",
            attempt_count as "attemptCount", started_at as "startedAt", completed_at as "completedAt"
       from platform.tenant_provisioning_step
      where job_id = $1 order by step_order`,
    [jobId],
  )
  return { ...job.rows[0], steps: steps.rows }
}

export async function retryProvisioningJob(pool: Pool, jobId: string, actorUserId: string) {
  return transaction(pool, async (client) => {
    const res = await client.query<{ retry_tenant_provisioning_job: boolean }>(
      `select platform.retry_tenant_provisioning_job($1, $2) as retry_tenant_provisioning_job`,
      [jobId, actorUserId],
    )
    return Boolean(res.rows[0]?.retry_tenant_provisioning_job)
  })
}


export async function suspendTenant(pool: Pool, tenantKey: string, actorUserId: string) {
  return transaction(pool, async (client) => {
    const result = await client.query<{ tenant_id: string }>(
      `update platform.tenant_registry set lifecycle_status = 'suspended'
        where tenant_key = $1 and lifecycle_status = 'active'
        returning tenant_id::text`,
      [tenantKey],
    )
    const tenantId = result.rows[0]?.tenant_id
    if (!tenantId) return false
    await client.query(
      `insert into platform.platform_audit (
         user_id, tenant_id, feature, action, status, resource_type, resource_id, policy_decision
       ) values ($1, $2, 'tenant_lifecycle', 'tenant_suspended', 'success', 'tenant', $3, 'allow')`,
      [actorUserId, tenantId, tenantKey],
    )
    return true
  })
}

export async function resumeTenant(pool: Pool, tenantKey: string, actorUserId: string) {
  return transaction(pool, async (client) => {
    const checkTenant = await client.query<{ lifecycle_status: string }>(
      `select lifecycle_status from platform.tenant_registry where tenant_key = $1 for update`,
      [tenantKey],
    )
    if (!checkTenant.rows[0]) return false
    const status = checkTenant.rows[0].lifecycle_status
    if (status === 'deleting' || status === 'deleted' || status === 'deletion_failed') {
      throw new TenantStateConflictError('Tenant is scheduled for removal or deleting and cannot be resumed.')
    }
    if (status !== 'suspended') return false

    const result = await client.query<{ tenant_id: string }>(
      `update platform.tenant_registry set lifecycle_status = 'active'
        where tenant_key = $1 and lifecycle_status = 'suspended'
        returning tenant_id::text`,
      [tenantKey],
    )
    const tenantId = result.rows[0]?.tenant_id
    if (!tenantId) return false
    await client.query(
      `insert into platform.platform_audit (
         user_id, tenant_id, feature, action, status, resource_type, resource_id, policy_decision
       ) values ($1, $2, 'tenant_lifecycle', 'tenant_resumed', 'success', 'tenant', $3, 'allow')`,
      [actorUserId, tenantId, tenantKey],
    )
    return true
  })
}

export async function createTenantDeprovisioningJob(
  pool: Pool,
  tenantKey: string,
  actorUserId: string,
  correlationId = randomUUID(),
) {
  return transaction(pool, async (client) => {
    const tenant = await client.query<{ tenant_id: string; display_name: string; hostname: string }>(
      `select t.tenant_id::text, t.display_name, d.hostname
         from platform.tenant_registry t
         join platform.tenant_domain d on d.tenant_id = t.tenant_id and d.is_primary
        where t.tenant_key = $1 and t.lifecycle_status = 'suspended'
        for update of t`,
      [tenantKey],
    )
    const row = tenant.rows[0]
    if (!row) {
      throw new TenantStateConflictError('Only a suspended tenant can be removed. Suspend it first.')
    }
    const activeJob = await client.query<{ job_id: string }>(
      `select job_id::text from platform.tenant_provisioning_job
        where tenant_id = $1 and status in ('pending', 'running', 'retrying')
        limit 1`,
      [row.tenant_id],
    )
    if (activeJob.rows[0]) {
      throw new TenantProvisioningConflictError('A provisioning or deprovisioning job is already active for this tenant.')
    }
    await client.query(
      `update platform.tenant_registry set lifecycle_status = 'deleting' where tenant_id = $1`,
      [row.tenant_id],
    )
    const job = await client.query<{ job_id: string }>(
      `insert into platform.tenant_provisioning_job (
         tenant_id, requested_by, correlation_id, status, job_type
       ) values ($1, $2, $3, 'pending', 'deprovision') returning job_id::text`,
      [row.tenant_id, actorUserId, correlationId],
    )
    const jobId = job.rows[0]?.job_id
    if (!jobId) throw new Error('Deprovisioning job insertion failed.')
    for (const [index, [stepCode, displayMessage]] of deprovisioningStepDefinitions.entries()) {
      await client.query(
        `insert into platform.tenant_provisioning_step
           (job_id, step_code, step_order, display_message)
         values ($1, $2, $3, $4)`,
        [jobId, stepCode, index + 1, displayMessage],
      )
    }
    await client.query(
      `insert into platform.platform_audit (
         user_id, tenant_id, feature, action, status,
         resource_type, resource_id, correlation_id, policy_decision
       ) values ($1, $2, 'tenant_provisioning', 'tenant_deletion_requested', 'success',
                 'tenant', $3, $4, 'allow')`,
      [actorUserId, row.tenant_id, tenantKey, correlationId],
    )
    return {
      tenant: { tenantId: tenantKey, displayName: row.display_name, hostname: row.hostname, status: 'deleting' },
      jobId,
      correlationId,
    }
  }).catch((error: unknown) => {
    if ((error as { code?: string }).code === '23505') {
      throw new TenantProvisioningConflictError('A provisioning or deprovisioning job is already in progress.')
    }
    throw error
  })
}
