import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { createServer } from '../../backend/dist/server.js'

import fs from 'node:fs'
import os from 'node:os'

// Assert required environment is provided; do not silently skip
assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required for integration test')
assert.ok(process.env.TENANT_PROVISIONER_DATABASE_URL, 'TENANT_PROVISIONER_DATABASE_URL is required for integration test')

// Create temporary isolated credentials and pgbouncer auth file created by test harness
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skeleton-test-lifecycle-'))
const testCredsDir = path.join(tempDir, 'credentials')
const testPgbouncerAuth = path.join(tempDir, 'tenant-users.txt')
fs.mkdirSync(testCredsDir, { recursive: true })
fs.writeFileSync(testPgbouncerAuth, '')

process.env.TENANT_CREDENTIALS_DIR = testCredsDir
process.env.TENANT_PGBOUNCER_AUTH_FILE = testPgbouncerAuth
process.env.TENANT_EDGE_VERIFY_DISABLED = 'true'
process.env.TENANT_PGBOUNCER_RELOAD_DISABLED = 'true'

const dbUrl = new URL(process.env.DATABASE_URL)
process.env.TENANT_PGBOUNCER_HOST = dbUrl.hostname
process.env.TENANT_PGBOUNCER_PORT = dbUrl.port || '5432'

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')
const WORKER_POLL_MS = 300
const WORKER_TIMEOUT_MS = 60_000

async function waitForJob(app, cookie, jobId, terminalStatuses) {
  const deadline = Date.now() + WORKER_TIMEOUT_MS
  for (;;) {
    const response = await app.inject({ method: 'GET', url: `/api/tenant-provisioning/${jobId}`, headers: { cookie } })
    const body = JSON.parse(response.payload)
    assert.equal(response.statusCode, 200, body.message)
    if (terminalStatuses.includes(body.job.status)) return body.job
    if (Date.now() > deadline) throw new Error(`Job ${jobId} did not reach a terminal state in time (last: ${body.job.status})`)
    await new Promise((resolve) => setTimeout(resolve, WORKER_POLL_MS))
  }
}

describe('Integration: Tenant Lifecycle', () => {
  let app
  let pool
  let cookie
  let tokenHash
  let worker
  let tickTimer
  const subdomain = `zzlifecycle${crypto.randomBytes(4).toString('hex')}`
  let tenantId // opaque tenant key (e.g. T...)
  let credentialRef

  before(async () => {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    const owner = (await pool.query("select id::text from platform.platform_user where role = 'platform_owner' order by created_at limit 1")).rows[0]
    assert.ok(owner, 'a seeded platform owner is required')
    const token = crypto.randomBytes(32).toString('base64url')
    tokenHash = sha256(token)
    await pool.query(
      `insert into platform.platform_session (user_id, token_hash, csrf_hash, expires_at, mfa_verified_at)
       values ($1, $2, $3, now() + interval '10 minutes', now())`,
      [owner.id, tokenHash, sha256('lifecycle-test-csrf')],
    )
    cookie = `__Host-platform_session=${token}`
    app = await createServer()

    // Drive a real worker instance rather than assume one is already
    // running in the background (safe alongside any such process — job
    // claiming uses FOR UPDATE SKIP LOCKED, so there's no double-processing).
    const { TenantProvisioningWorker } = await import('../../backend/provisioner/dist/worker.js')
    worker = new TenantProvisioningWorker()
    await worker.assertIdentity()
    tickTimer = setInterval(() => {
      worker.tick().catch((error) => console.error('[tenant-lifecycle.test] worker tick failed', error))
    }, WORKER_POLL_MS)
  })

  after(async () => {
    if (tickTimer) clearInterval(tickTimer)
    if (worker) await worker.close()
    await pool.query('delete from platform.platform_session where token_hash = $1', [tokenHash]).catch(() => undefined)
    if (app) await app.close()
    if (pool) await pool.end()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('create, suspend, resume, and fully remove a tenant', async () => {
    // CSRF is enforced on every mutating route; the CSRF token issued at
    // session-mint time isn't known to this test (it's derived server-side),
    // so requests here go through the same 401/403-checked HTTP surface but
    // with CSRF validated via the stored hash — bypass isn't possible, so we
    // mint a matching token by hashing the same secret used above.
    const csrfToken = 'lifecycle-test-csrf'
    const origin = process.env.PLATFORM_FRONTEND_ORIGIN || 'https://platform.sandbox.test'
    const headers = { cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/json', origin }
    // Suspend/resume/deprovision take no body; Fastify's JSON parser rejects
    // an empty body sent with a json content-type, so these omit it.
    const actionHeaders = { cookie, 'x-csrf-token': csrfToken, origin }

    // 1. Create
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/tenants',
      headers,
      payload: JSON.stringify({ displayName: 'Lifecycle Test Tenant', subdomain }),
    })
    const created = JSON.parse(createResponse.payload)
    assert.equal(createResponse.statusCode, 202, created.message)
    tenantId = created.tenant.tenantId
    const provisionJobId = created.jobId

    const provisioned = await waitForJob(app, cookie, provisionJobId, ['succeeded', 'failed'])
    assert.equal(provisioned.status, 'succeeded', provisioned.errorMessage || '')

    const registryRow = (await pool.query(
      'select lifecycle_status, schema_identifier, db_role, login_role, credential_ref from platform.tenant_registry where tenant_key = $1',
      [tenantId],
    )).rows[0]
    assert.equal(registryRow.lifecycle_status, 'active')
    credentialRef = registryRow.credential_ref

    // Real side effects exist: schema, both roles, credential file, PgBouncer auth line.
    const schemaExists = (await pool.query('select 1 from pg_namespace where nspname = $1', [registryRow.schema_identifier])).rowCount === 1
    assert.equal(schemaExists, true, 'tenant schema should exist after provisioning')
    const rolesExist = (await pool.query('select rolname from pg_roles where rolname in ($1, $2)', [registryRow.db_role, registryRow.login_role])).rowCount
    assert.equal(rolesExist, 2, 'both tenant database roles should exist after provisioning')
    await readFile(`${process.env.TENANT_CREDENTIALS_DIR}/${credentialRef}.json`, 'utf8')
    const authFileAfterCreate = await readFile(process.env.TENANT_PGBOUNCER_AUTH_FILE, 'utf8')
    assert.ok(authFileAfterCreate.includes(`"${registryRow.login_role}" `), 'PgBouncer auth file should contain the new tenant login role')

    // 2. Suspend
    const suspendResponse = await app.inject({ method: 'POST', url: `/api/tenants/${tenantId}/suspend`, headers: actionHeaders })
    assert.equal(suspendResponse.statusCode, 200, JSON.parse(suspendResponse.payload).message)
    assert.equal(
      (await pool.query('select lifecycle_status from platform.tenant_registry where tenant_key = $1', [tenantId])).rows[0].lifecycle_status,
      'suspended',
    )

    // Deprovisioning a still-active-looking tenant must be refused — but it's suspended now, so this should work.
    // Resuming while suspended should succeed; deprovisioning while active should have been refused (checked next).
    const activeDeprovisionAttempt = await app.inject({ method: 'POST', url: `/api/tenants/${tenantId}/resume`, headers: actionHeaders })
    assert.equal(activeDeprovisionAttempt.statusCode, 200)
    assert.equal(
      (await pool.query('select lifecycle_status from platform.tenant_registry where tenant_key = $1', [tenantId])).rows[0].lifecycle_status,
      'active',
    )
    const refusedDeprovision = await app.inject({ method: 'POST', url: `/api/tenants/${tenantId}/deprovision`, headers: actionHeaders })
    assert.equal(refusedDeprovision.statusCode, 409, 'an active tenant must not be directly removable')

    // 3. Suspend again, then remove for real
    await app.inject({ method: 'POST', url: `/api/tenants/${tenantId}/suspend`, headers: actionHeaders })
    const deprovisionResponse = await app.inject({ method: 'POST', url: `/api/tenants/${tenantId}/deprovision`, headers: actionHeaders })
    const deprovisioned = JSON.parse(deprovisionResponse.payload)
    assert.equal(deprovisionResponse.statusCode, 202, deprovisioned.message)

    const removed = await waitForJob(app, cookie, deprovisioned.jobId, ['succeeded', 'failed'])
    assert.equal(removed.status, 'succeeded', removed.errorMessage || '')

    // 4. Every side effect must be gone.
    const finalRow = (await pool.query('select lifecycle_status from platform.tenant_registry where tenant_key = $1', [tenantId])).rows[0]
    assert.equal(finalRow.lifecycle_status, 'deleted')
    const schemaGone = (await pool.query('select 1 from pg_namespace where nspname = $1', [registryRow.schema_identifier])).rowCount === 0
    assert.equal(schemaGone, true, 'tenant schema should be dropped after removal')
    const rolesGone = (await pool.query('select rolname from pg_roles where rolname in ($1, $2)', [registryRow.db_role, registryRow.login_role])).rowCount === 0
    assert.equal(rolesGone, true, 'both tenant database roles should be dropped after removal')
    await assert.rejects(
      readFile(`${process.env.TENANT_CREDENTIALS_DIR}/${credentialRef}.json`, 'utf8'),
      { code: 'ENOENT' },
      'the credential file should be deleted after removal',
    )
    const authFileAfterRemoval = await readFile(process.env.TENANT_PGBOUNCER_AUTH_FILE, 'utf8')
    assert.equal(
      authFileAfterRemoval.includes(`"${registryRow.login_role}" `),
      false,
      'PgBouncer auth file should no longer contain the removed tenant login role',
    )
  })
})
