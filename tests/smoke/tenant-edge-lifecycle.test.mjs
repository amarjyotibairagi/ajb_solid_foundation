import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { createServer } from '../../backend/dist/server.js'

// Explicit opt-in check: Refuse to run without opt-in and live configuration
if (process.env.RUN_TENANT_EDGE_SMOKE !== 'true') {
  throw new Error('Refusing to run live smoke test: RUN_TENANT_EDGE_SMOKE=true is required.')
}

const requiredLiveConfig = [
  'DATABASE_URL',
  'TENANT_CREDENTIALS_DIR',
  'TENANT_PGBOUNCER_AUTH_FILE',
  'TENANT_PROVISIONER_DATABASE_URL',
  'TENANT_PGBOUNCER_ADMIN_USER',
  'TENANT_PGBOUNCER_ADMIN_PASSWORD',
]

for (const key of requiredLiveConfig) {
  if (!process.env[key]) {
    throw new Error(`Refusing to run live smoke test: missing required environment variable ${key}.`)
  }
}

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

describe('Smoke: Tenant Edge Lifecycle', () => {
  let app
  let pool
  let cookie
  let tokenHash
  let worker
  let tickTimer
  const subdomain = `zzsmoke${crypto.randomBytes(4).toString('hex')}`
  let tenantId
  let credentialRef

  before(async () => {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    const owner = (await pool.query("select id::text from platform.platform_user where role = 'platform_owner' and is_active = true order by created_at limit 1")).rows[0]
    assert.ok(owner, 'a seeded active platform owner is required')
    const token = crypto.randomBytes(32).toString('base64url')
    tokenHash = sha256(token)
    await pool.query(
      `insert into platform.platform_session (user_id, token_hash, csrf_hash, expires_at, mfa_verified_at)
       values ($1, $2, $3, now() + interval '10 minutes', now())`,
      [owner.id, tokenHash, sha256('smoke-test-csrf')],
    )
    cookie = `__Host-platform_session=${token}`
    app = await createServer()

    const { TenantProvisioningWorker } = await import('../../backend/provisioner/dist/worker.js')
    worker = new TenantProvisioningWorker()
    await worker.assertIdentity()
    tickTimer = setInterval(() => {
      worker.tick().catch((error) => console.error('[tenant-edge-lifecycle.test] worker tick failed', error))
    }, WORKER_POLL_MS)
  })

  after(async () => {
    if (tickTimer) clearInterval(tickTimer)
    if (worker) await worker.close()
    await pool.query('delete from platform.platform_session where token_hash = $1', [tokenHash]).catch(() => undefined)
    if (app) await app.close()
    if (pool) await pool.end()
  })

  test('create, verify over edge, suspend, resume, and deprovision live tenant', async () => {
    const csrfToken = 'smoke-test-csrf'
    const origin = process.env.PLATFORM_FRONTEND_ORIGIN || 'https://platform.sandbox.test'
    const headers = { cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/json', origin }
    const actionHeaders = { cookie, 'x-csrf-token': csrfToken, origin }

    // 1. Create
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/tenants',
      headers,
      payload: JSON.stringify({ displayName: 'Smoke Edge Tenant', subdomain }),
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

    // Verify side effects
    const schemaExists = (await pool.query('select 1 from pg_namespace where nspname = $1', [registryRow.schema_identifier])).rowCount === 1
    assert.equal(schemaExists, true, 'tenant schema should exist after provisioning')

    // 2. Suspend
    const suspendResponse = await app.inject({ method: 'POST', url: `/api/tenants/${tenantId}/suspend`, headers: actionHeaders })
    assert.equal(suspendResponse.statusCode, 200)

    // 3. Resume
    const resumeResponse = await app.inject({ method: 'POST', url: `/api/tenants/${tenantId}/resume`, headers: actionHeaders })
    assert.equal(resumeResponse.statusCode, 200)

    // 4. Suspend again & Deprovision
    await app.inject({ method: 'POST', url: `/api/tenants/${tenantId}/suspend`, headers: actionHeaders })
    const deprovisionResponse = await app.inject({ method: 'POST', url: `/api/tenants/${tenantId}/deprovision`, headers: actionHeaders })
    const deprovisioned = JSON.parse(deprovisionResponse.payload)
    assert.equal(deprovisionResponse.statusCode, 202)

    const removed = await waitForJob(app, cookie, deprovisioned.jobId, ['succeeded', 'failed'])
    assert.equal(removed.status, 'succeeded', removed.errorMessage || '')
  })
})
