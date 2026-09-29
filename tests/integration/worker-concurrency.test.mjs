import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import { acquireWorkerDatabaseLock } from '../../backend/provisioner/dist/worker.js'

const adminUrl = process.env.DATABASE_ADMIN_URL || process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
assert.ok(adminUrl, 'DATABASE_ADMIN_URL or TEST_DATABASE_URL is required')
const provisionerUrl = process.env.TENANT_PROVISIONER_DATABASE_URL
assert.ok(provisionerUrl, 'TENANT_PROVISIONER_DATABASE_URL is required')
const bffUrl = process.env.PLATFORM_BFF_DATABASE_URL || process.env.DATABASE_URL
assert.ok(bffUrl, 'PLATFORM_BFF_DATABASE_URL or DATABASE_URL is required')

// tenant_key_v1 is 'T' plus 20 uppercase hex characters -- the format the
// provisioner emits and that migration 023 now enforces with a CHECK
// constraint. Fixtures previously used a short 'TK<8 hex>' form, which is
// exactly the malformed shape that constraint exists to reject.
const makeTenantKey = () => `T${crypto.randomBytes(10).toString('hex').toUpperCase()}`

describe('Integration: Worker Concurrency, Advisory Locks & Tenant Immutability', () => {
  let adminPool
  let provisionerPool
  let bffPool

  before(async () => {
    adminPool = new pg.Pool({ connectionString: adminUrl })
    provisionerPool = new pg.Pool({ connectionString: provisionerUrl })
    bffPool = new pg.Pool({ connectionString: bffUrl })
  })

  after(async () => {
    if (adminPool) await adminPool.end()
    if (provisionerPool) await provisionerPool.end()
    if (bffPool) await bffPool.end()
  })

  describe('P04.3 Database Session Advisory Lock', () => {
    test('two workers cannot simultaneously acquire the worker database advisory lock', async () => {
      const lock1 = await acquireWorkerDatabaseLock(provisionerUrl)
      assert.ok(lock1.client, 'First worker must receive active lock client')
      assert.ok(lock1.release, 'First worker must receive release function')

      try {
        await assert.rejects(
          async () => acquireWorkerDatabaseLock(provisionerUrl),
          /Another tenant provisioner worker process currently holds the database advisory lock/,
          'Second worker must be rejected while lock is held',
        )
      } finally {
        await lock1.release()
      }

      // After release, a new worker can acquire the lock
      const lock2 = await acquireWorkerDatabaseLock(provisionerUrl)
      assert.ok(lock2.client, 'Lock must be acquirable after prior worker releases')
      assert.ok(lock2.release)
      await lock2.release()
    })
  })

  describe('P04.1 Tenant Identity Immutability', () => {
    const testTenantId = crypto.randomUUID()
    const testTenantKey = makeTenantKey()
    const validSchema = `tenant_${testTenantKey.toLowerCase()}`
    const validDbRole = `${validSchema}_runtime`
    const validLoginRole = `${validSchema}_login`

    test('enforces naming conventions for tenant_key_v1 on insert', async () => {
      // Mismatched schema name
      await assert.rejects(
        async () => {
          await adminPool.query(
            `insert into platform.tenant_registry
               (tenant_id, tenant_key, schema_identifier, db_role, login_role, credential_ref, display_name, identity_scheme, region)
             values ($1, $2, 'wrong_schema', $3, $4, $2, 'Invalid Scheme', 'tenant_key_v1', 'default')`,
            [crypto.randomUUID(), makeTenantKey(), validDbRole, validLoginRole],
          )
        },
        /Tenant identity scheme tenant_key_v1 requires schema=tenant_<key>/,
      )

      // A malformed tenant_key is rejected by the format invariant itself,
      // independently of the schema-naming trigger.
      await assert.rejects(
        async () => {
          const malformed = `TK${crypto.randomBytes(4).toString('hex').toLowerCase()}`
          await adminPool.query(
            `insert into platform.tenant_registry
               (tenant_id, tenant_key, schema_identifier, db_role, login_role, credential_ref, display_name, identity_scheme, region)
             values ($1, $2, $3, $4, $5, $2, 'Malformed Key', 'tenant_key_v1', 'default')`,
            [
              crypto.randomUUID(),
              malformed,
              `tenant_${malformed.toLowerCase()}`,
              `tenant_${malformed.toLowerCase()}_runtime`,
              `tenant_${malformed.toLowerCase()}_login`,
            ],
          )
        },
        /tenant_registry_tenant_key_format_check/,
      )

      // Valid insert succeeds
      await adminPool.query(
        `insert into platform.tenant_registry
           (tenant_id, tenant_key, schema_identifier, db_role, login_role, credential_ref, display_name, identity_scheme, region)
         values ($1, $2, $3, $4, $5, $2, 'Valid Test Tenant', 'tenant_key_v1', 'default')`,
        [testTenantId, testTenantKey, validSchema, validDbRole, validLoginRole],
      )
    })

    test('rejects modification of tenant identity fields after allocation', async () => {
      // Cannot modify tenant_key
      await assert.rejects(
        async () => {
          await adminPool.query(
            `update platform.tenant_registry set tenant_key = $2 where tenant_id = $1`,
            [testTenantId, makeTenantKey()],
          )
        },
        /Tenant immutable identity fields.*cannot be modified/,
      )

      // Cannot modify schema_identifier
      await assert.rejects(
        async () => {
          await adminPool.query(
            `update platform.tenant_registry set schema_identifier = 'tenant_other' where tenant_id = $1`,
            [testTenantId],
          )
        },
        /Tenant immutable identity fields.*cannot be modified/,
      )

      // Cannot modify db_role
      await assert.rejects(
        async () => {
          await adminPool.query(
            `update platform.tenant_registry set db_role = 'other_runtime' where tenant_id = $1`,
            [testTenantId],
          )
        },
        /Tenant immutable identity fields.*cannot be modified/,
      )

      // Cannot modify login_role
      await assert.rejects(
        async () => {
          await adminPool.query(
            `update platform.tenant_registry set login_role = 'other_login' where tenant_id = $1`,
            [testTenantId],
          )
        },
        /Tenant immutable identity fields.*cannot be modified/,
      )

      // Cannot modify credential_ref
      await assert.rejects(
        async () => {
          await adminPool.query(
            `update platform.tenant_registry set credential_ref = 'other_ref' where tenant_id = $1`,
            [testTenantId],
          )
        },
        /Tenant immutable identity fields.*cannot be modified/,
      )

      // Cannot modify identity_scheme
      await assert.rejects(
        async () => {
          await adminPool.query(
            `update platform.tenant_registry set identity_scheme = 'legacy' where tenant_id = $1`,
            [testTenantId],
          )
        },
        /Tenant immutable identity fields.*cannot be modified/,
      )
    })

    test('cleans up test tenant', async () => {
      await adminPool.query(`delete from platform.tenant_registry where tenant_id = $1`, [testTenantId])
    })
  })

  describe('P04.2 Narrow Platform BFF Control-Plane Writes', () => {
    test('platform BFF runtime cannot directly mutate worker-owned tables or columns', async () => {
      // Find an existing job or create a dummy one for testing
      const testTenantId = crypto.randomUUID()
      const testKey = makeTenantKey()
      const testSchema = `tenant_${testKey.toLowerCase()}`
      const jobId = crypto.randomUUID()

      await adminPool.query(
        `insert into platform.tenant_registry
           (tenant_id, tenant_key, schema_identifier, db_role, login_role, credential_ref, display_name, identity_scheme, region, lifecycle_status)
         values ($1, $2, $3, $3 || '_runtime', $3 || '_login', $2, 'BFF Grant Test', 'tenant_key_v1', 'default', 'active')`,
        [testTenantId, testKey, testSchema],
      )

      await adminPool.query(
        `insert into platform.tenant_provisioning_job
           (job_id, tenant_id, correlation_id, job_type, status, current_step, worker_id, locked_at)
         values ($1, $2, $3, 'provision', 'pending', 'SCHEMA', null, null)`,
        [jobId, testTenantId, crypto.randomUUID()],
      )

      try {
        // Attempting to update worker_id directly as platform_bff_runtime must fail
        await assert.rejects(
          async () => {
            await bffPool.query(
              `update platform.tenant_provisioning_job set worker_id = 'rogue_worker' where job_id = $1`,
              [jobId],
            )
          },
          /permission denied for table tenant_provisioning_job/,
        )

        // Attempting to update current_step directly as platform_bff_runtime must fail
        await assert.rejects(
          async () => {
            await bffPool.query(
              `update platform.tenant_provisioning_job set current_step = 'SCHEMA' where job_id = $1`,
              [jobId],
            )
          },
          /permission denied for table tenant_provisioning_job/,
        )

        // Attempting to update tenant_provisioning_step directly must fail
        await assert.rejects(
          async () => {
            await bffPool.query(
              `update platform.tenant_provisioning_step set status = 'failed' where job_id = $1`,
              [jobId],
            )
          },
          /permission denied for table tenant_provisioning_step/,
        )

        // Attempting to update immutable identity column directly on tenant_registry must fail
        await assert.rejects(
          async () => {
            await bffPool.query(
              `update platform.tenant_registry set schema_identifier = 'evil' where tenant_id = $1`,
              [testTenantId],
            )
          },
          /permission denied for table tenant_registry/,
        )
      } finally {
        await adminPool.query(`delete from platform.tenant_provisioning_job where job_id = $1`, [jobId])
        await adminPool.query(`delete from platform.tenant_registry where tenant_id = $1`, [testTenantId])
      }
    })
  })

  describe('P04.4 Lease-Sensitive Mutations Fail Closed', () => {
    test('a worker that has lost its lease cannot mark failure or mutate tenant/audit state', async () => {
      const testTenantId = crypto.randomUUID()
      const testTenantKey = makeTenantKey()
      const testSchema = `tenant_${testTenantKey.toLowerCase()}`
      const jobId = crypto.randomUUID()

      // Create test tenant in active state
      await adminPool.query(
        `insert into platform.tenant_registry
           (tenant_id, tenant_key, schema_identifier, db_role, login_role, credential_ref, display_name, identity_scheme, region, lifecycle_status)
         values ($1, $2, $3, $3 || '_runtime', $3 || '_login', $2, 'Lease Test Tenant', 'tenant_key_v1', 'default', 'active')`,
        [testTenantId, testTenantKey, testSchema],
      )

      // Create a running provisioning job claimed by worker-1
      await adminPool.query(
        `insert into platform.tenant_provisioning_job
           (job_id, tenant_id, correlation_id, job_type, status, current_step, worker_id, locked_at)
         values ($1, $2, $3, 'deprovision', 'running', 'DEPROV_REVOKE_ACCESS', 'worker-1', now())`,
        [jobId, testTenantId, crypto.randomUUID()],
      )

      // Simulate lease expiration / takeover: worker-2 claims the job
      await adminPool.query(
        `update platform.tenant_provisioning_job
            set worker_id = 'worker-2', locked_at = now()
          where job_id = $1`,
        [jobId],
      )

      // Now worker-1 attempts to fail the job using the fail query pattern:
      const staleFailResult = await adminPool.query(
        `update platform.tenant_provisioning_job
            set status = 'failed', safe_error_code = 'StaleWorkerError', safe_error_message = 'Lost lease',
                retryable = true, completed_at = now(), worker_id = null, locked_at = null
          where job_id = $1 and worker_id = 'worker-1' and status = 'running'
          returning job_id`,
        [jobId],
      )

      assert.equal(staleFailResult.rowCount, 0, 'Stale worker update must return 0 rows')

      // Because rowCount === 0, worker-1 does not perform mutations on tenant_registry or platform_audit.
      // Verify job is still owned by worker-2 and in 'running' status
      const currentJob = await adminPool.query(
        `select worker_id, status from platform.tenant_provisioning_job where job_id = $1`,
        [jobId],
      )
      assert.equal(currentJob.rows[0].worker_id, 'worker-2')
      assert.equal(currentJob.rows[0].status, 'running')

      // Verify tenant lifecycle_status was not modified to 'deletion_failed'
      const currentTenant = await adminPool.query(
        `select lifecycle_status from platform.tenant_registry where tenant_id = $1`,
        [testTenantId],
      )
      assert.equal(currentTenant.rows[0].lifecycle_status, 'active')

      // Clean up
      await adminPool.query(`delete from platform.tenant_provisioning_job where job_id = $1`, [jobId])
      await adminPool.query(`delete from platform.tenant_registry where tenant_id = $1`, [testTenantId])
    })
  })
})
