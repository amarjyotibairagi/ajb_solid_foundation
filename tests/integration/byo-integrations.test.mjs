import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'

// End-to-end coverage for bring-your-own storage and databases, the pooled
// connection tier, admin-panel operations (schema upgrades, data and file
// relocation) and the shared throttle store.

for (const name of ['DATABASE_URL', 'DATABASE_ADMIN_URL', 'TENANT_PROVISIONER_DATABASE_URL', 'TENANT_REGISTRY_DATABASE_URL', 'TENANT_POOL_DATABASE_URL', 'INTEGRATION_SECRET_KEY']) {
  assert.ok(process.env[name], `${name} is required`)
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skeleton-byo-'))
process.env.TENANT_CREDENTIALS_DIR = path.join(tempDir, 'credentials')
process.env.TENANT_PGBOUNCER_AUTH_FILE = path.join(tempDir, 'tenant-users.txt')
process.env.STORAGE_ROOT = path.join(tempDir, 'storage')
fs.mkdirSync(process.env.TENANT_CREDENTIALS_DIR, { recursive: true })
fs.writeFileSync(process.env.TENANT_PGBOUNCER_AUTH_FILE, '')
process.env.TENANT_EDGE_VERIFY_DISABLED = 'true'
process.env.TENANT_PGBOUNCER_RELOAD_DISABLED = 'true'
process.env.TENANT_CONFIG_CACHE_TTL_MS = '0'
process.env.TENANT_RELOCATION_DRAIN_MS = '0'
const adminUrl = new URL(process.env.DATABASE_ADMIN_URL)
process.env.TENANT_PGBOUNCER_HOST = adminUrl.hostname
process.env.TENANT_PGBOUNCER_PORT = adminUrl.port || '5432'

const { createServer: createPlatformServer } = await import('../../backend/dist/server.js')
const { createServer: createTenantServer } = await import('../../backend/tenant/dist/server.js')
const { TenantProvisioningWorker } = await import('../../backend/provisioner/dist/worker.js')
const kit = await import('../../dependency/platform/ServerKit/dist/index.js')

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')
const rootDomain = process.env.TENANT_ROOT_DOMAIN || 'sandbox.test'
const platformOrigin = process.env.PLATFORM_FRONTEND_ORIGIN || 'https://platform.sandbox.test'
const csrf = 'byo-integrations-csrf'
const password = 'correct horse battery staple'
const tokenFromLink = (link) => decodeURIComponent(new URL(link).hash.replace(/^#token=/, ''))

// --- Minimal S3-compatible server that re-verifies every SigV4 signature ----

const s3Credentials = { accessKeyId: 'TESTACCESSKEY', secretAccessKey: 'test-secret-access-key' }
function startFakeS3() {
  const objects = new Map()
  const rejected = []
  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks)
      const url = new URL(request.url, `http://${request.headers.host}`)
      const authorization = String(request.headers.authorization || '')
      const signedHeaders = /SignedHeaders=([^,]+)/.exec(authorization)?.[1]?.split(';') || []
      const headers = Object.fromEntries(signedHeaders.filter((name) => !['host', 'x-amz-date', 'x-amz-content-sha256'].includes(name)).map((name) => [name, String(request.headers[name])]))
      const amzDate = String(request.headers['x-amz-date'])
      const date = new Date(`${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`)
      const expected = kit.signS3Request({
        method: request.method,
        host: String(request.headers.host),
        path: decodeURIComponent(url.pathname),
        query: Object.fromEntries(url.searchParams),
        headers,
        payloadHash: sha256(body),
        region: 'us-east-1',
        credentials: s3Credentials,
        date,
      }).authorization
      if (expected !== authorization || request.headers['x-amz-content-sha256'] !== sha256(body)) {
        rejected.push(`${request.method} ${request.url}`)
        response.writeHead(403, { 'content-type': 'application/xml' })
        return response.end('<Error><Code>SignatureDoesNotMatch</Code><Message>bad signature</Message></Error>')
      }
      const [, bucket, ...rest] = decodeURIComponent(url.pathname).split('/')
      const key = rest.join('/')
      if (bucket !== 'tenant-bucket') {
        response.writeHead(404)
        return response.end('<Error><Code>NoSuchBucket</Code><Message>no bucket</Message></Error>')
      }
      if (request.method === 'PUT') {
        objects.set(key, { body, type: request.headers['content-type'] })
        response.writeHead(200)
        return response.end()
      }
      if (request.method === 'GET' && !key) {
        const prefix = url.searchParams.get('prefix') || ''
        const keys = [...objects.keys()].filter((item) => item.startsWith(prefix))
        response.writeHead(200, { 'content-type': 'application/xml' })
        return response.end(`<ListBucketResult>${keys.map((item) => `<Contents><Key>${item}</Key></Contents>`).join('')}</ListBucketResult>`)
      }
      const object = objects.get(key)
      if (request.method === 'DELETE') {
        objects.delete(key)
        response.writeHead(204)
        return response.end()
      }
      if (!object) {
        response.writeHead(404)
        return response.end(request.method === 'HEAD' ? undefined : '<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>')
      }
      response.writeHead(200, { 'content-type': object.type || 'application/octet-stream', 'content-length': object.body.length })
      return response.end(request.method === 'HEAD' ? undefined : object.body)
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, objects, rejected, port: server.address().port })))
}

describe('Integration: bring-your-own storage and database, pooled tier, operations', () => {
  let platform
  let tenantApp
  let pool
  let admin
  let worker
  let timer
  let sessionHash
  let fakeS3
  let tenantKey
  let tenantId
  const subdomain = `zzbyo${crypto.randomBytes(4).toString('hex')}`
  const host = `${subdomain}.${rootDomain}`
  const externalDb = `byo_${crypto.randomBytes(3).toString('hex')}`
  const externalUser = `${externalDb}_owner`
  const externalPassword = crypto.randomBytes(12).toString('hex')
  let platformHeaders

  const platformCall = async (method, url, payload) => {
    const response = await platform.inject({
      method,
      url,
      headers: payload === undefined ? platformHeaders.action : platformHeaders.json,
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    })
    return { status: response.statusCode, body: JSON.parse(response.payload) }
  }
  const tenantHeaders = (extra = {}) => ({ host, origin: `https://${host}`, ...extra })
  const tenantLogin = async (username) => {
    const response = await tenantApp.inject({
      method: 'POST', url: '/api/auth/login', headers: tenantHeaders({ 'content-type': 'application/json' }),
      payload: JSON.stringify({ username, password, turnstileToken: 'x'.repeat(24) }),
    })
    assert.equal(response.statusCode, 200, response.payload)
    const cookie = response.cookies.find((item) => item.name.endsWith('tenant_session'))
    return { cookie: `${cookie.name}=${cookie.value}`, csrfToken: JSON.parse(response.payload).csrfToken }
  }
  const tenantCall = async (session, method, url, payload, extraHeaders = {}) => {
    const headers = tenantHeaders({ cookie: session.cookie, 'x-csrf-token': session.csrfToken, ...extraHeaders })
    let body
    if (Buffer.isBuffer(payload)) {
      headers['content-type'] = 'application/octet-stream'
      body = payload
    } else if (payload !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(payload)
    }
    const response = await tenantApp.inject({ method, url, headers, ...(body === undefined ? {} : { payload: body }) })
    const isJson = String(response.headers['content-type'] || '').includes('json')
    return { status: response.statusCode, body: isJson ? JSON.parse(response.payload) : response.rawPayload, headers: response.headers }
  }
  const waitForJob = async (jobId) => {
    const deadline = Date.now() + 90_000
    for (;;) {
      const { body } = await platformCall('GET', `/api/tenant-provisioning/${jobId}`)
      if (['succeeded', 'failed'].includes(body.job.status)) return body.job
      if (Date.now() > deadline) throw new Error(`job ${jobId} timed out at ${body.job.currentStep}`)
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  const setPlatformValue = (key, value) =>
    pool.query('select platform.set_config_value($1, null, $2, $3::jsonb, null)', ['platform', key, value === null ? null : JSON.stringify(value)])

  before(async () => {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_ADMIN_URL })
    admin = (await pool.query("select id::text from platform.platform_user where role = 'platform_owner' and is_active order by created_at limit 1")).rows[0]
    const token = crypto.randomBytes(32).toString('base64url')
    sessionHash = sha256(token)
    await pool.query(
      `insert into platform.platform_session (user_id, token_hash, csrf_hash, expires_at, mfa_verified_at)
       values ($1, $2, $3, now() + interval '20 minutes', now())`,
      [admin.id, sessionHash, sha256(csrf)],
    )
    const cookie = `__Host-platform_session=${token}`
    platformHeaders = {
      json: { cookie, 'x-csrf-token': csrf, origin: platformOrigin, 'content-type': 'application/json' },
      action: { cookie, 'x-csrf-token': csrf, origin: platformOrigin },
    }
    // The test cluster and fake S3 listen on loopback without TLS.
    await setPlatformValue('integration.allow_private_endpoints', true)
    await setPlatformValue('integration.allow_insecure_transport', true)
    // A separate database and non-superuser owner play the tenant's own PostgreSQL.
    await pool.query(`create role ${externalUser} login password '${externalPassword}' nosuperuser nobypassrls`)
    await pool.query(`create database ${externalDb} owner ${externalUser}`)
    fakeS3 = await startFakeS3()
    platform = await createPlatformServer()
    tenantApp = await createTenantServer()
    worker = new TenantProvisioningWorker()
    await worker.assertIdentity()
    timer = setInterval(() => worker.tick().catch((error) => console.error('[byo] worker tick failed', error)), 200)
  })

  after(async () => {
    if (tenantKey) {
      await platformCall('POST', `/api/tenants/${tenantKey}/suspend`).catch(() => undefined)
      const removal = await platformCall('POST', `/api/tenants/${tenantKey}/deprovision`).catch(() => null)
      if (removal?.body?.jobId) await waitForJob(removal.body.jobId).catch(() => undefined)
    }
    if (timer) clearInterval(timer)
    if (worker) await worker.close()
    if (tenantApp) await tenantApp.close()
    if (platform) await platform.close()
    if (fakeS3) fakeS3.server.close()
    await setPlatformValue('integration.allow_private_endpoints', null).catch(() => undefined)
    await setPlatformValue('integration.allow_insecure_transport', null).catch(() => undefined)
    await pool.query('delete from platform.platform_session where token_hash = $1', [sessionHash]).catch(() => undefined)
    await pool.query(`drop database if exists ${externalDb} with (force)`).catch(() => undefined)
    await pool.query(`drop role if exists ${externalUser}`).catch(() => undefined)
    await pool.end()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('a pooled-tier tenant is provisioned on the shared login and serves requests', async () => {
    const created = await platformCall('POST', '/api/tenants', {
      displayName: 'BYO Tenant', subdomain, connectionTier: 'pooled',
      owner: { email: `owner@${subdomain}.test`, displayName: 'BYO Owner' },
    })
    assert.equal(created.status, 202, created.body.message)
    assert.equal(created.body.tenant.connectionTier, 'pooled')
    tenantKey = created.body.tenant.tenantId
    const job = await waitForJob(created.body.jobId)
    assert.equal(job.status, 'succeeded', job.errorMessage || '')
    const registry = (await pool.query('select tenant_id::text, login_role, connection_tier from platform.tenant_registry where tenant_key = $1', [tenantKey])).rows[0]
    tenantId = registry.tenant_id
    assert.deepEqual([registry.login_role, registry.connection_tier], ['tenant_pool_login', 'pooled'])
    assert.equal(fs.existsSync(path.join(process.env.TENANT_CREDENTIALS_DIR, `${tenantKey}.json`)), false, 'pooled tenants have no credential file')

    const accept = await tenantApp.inject({
      method: 'POST', url: '/api/auth/invitations/accept', headers: tenantHeaders({ 'content-type': 'application/json' }),
      payload: JSON.stringify({ token: tokenFromLink(created.body.ownerInvitation.link), username: 'byo.owner', password }),
    })
    assert.equal(accept.statusCode, 200, accept.payload)
    const owner = await tenantLogin('byo.owner')
    const users = await tenantCall(owner, 'GET', '/api/v1/users')
    assert.equal(users.status, 200)
    assert.equal(users.body.users.length, 1)
  })

  test('files are stored on the VDS by default, downloaded as attachments, and size-limited', async () => {
    const owner = await tenantLogin('byo.owner')
    const content = Buffer.from('hello from the VDS')
    const upload = await tenantCall(owner, 'POST', '/api/v1/files', content, { 'x-file-name': encodeURIComponent('notes <1>.txt'), 'x-content-type': 'text/plain' })
    assert.equal(upload.status, 201, JSON.stringify(upload.body))
    assert.equal(upload.body.file.storage, 'vds')
    assert.equal(upload.body.file.sha256, sha256(content))
    const onDisk = path.join(process.env.STORAGE_ROOT, 'tenants', tenantKey, 'objects', upload.body.file.id)
    assert.ok(fs.existsSync(onDisk), 'object bytes live under STORAGE_ROOT/tenants/<key>')

    const download = await tenantCall(owner, 'GET', `/api/v1/files/${upload.body.file.id}`)
    assert.equal(download.status, 200)
    assert.equal(Buffer.from(download.body).toString(), 'hello from the VDS')
    assert.match(download.headers['content-disposition'], /^attachment;/)
    assert.equal(download.headers['x-content-type-options'], 'nosniff')

    await pool.query("select platform.set_config_value('tenant', $1, 'limit.storage.max_file_mb', '1'::jsonb, null)", [tenantKey])
    const tooBig = await tenantCall(owner, 'POST', '/api/v1/files', Buffer.alloc(2 * 1024 * 1024), { 'x-file-name': 'big.bin' })
    assert.equal(tooBig.status, 413)
    await pool.query("select platform.set_config_value('tenant', $1, 'limit.storage.max_file_mb', null, null)", [tenantKey])
  })

  test('the endpoint policy blocks private addresses unless the platform allows them', async () => {
    const policy = { allowPrivateEndpoints: false, allowInsecureTransport: true }
    const report = await kit.testS3Integration(
      kit.normalizeS3Settings({ endpoint: `http://127.0.0.1:${fakeS3.port}`, bucket: 'tenant-bucket' }), s3Credentials, policy,
    )
    assert.equal(report.ok, false)
    assert.equal(report.steps[0].step, 'Endpoint policy')
    assert.match(report.steps[0].detail, /private or reserved address/)
    assert.equal(kit.isPrivateAddress('169.254.169.254'), true, 'cloud metadata address is private')
    assert.equal(kit.isPrivateAddress('::ffff:10.0.0.1'), true)
    assert.equal(kit.isPrivateAddress('93.184.216.34'), false)
  })

  test('the owner connects their own bucket: save, test, activate, and move existing files', async () => {
    const owner = await tenantLogin('byo.owner')
    const saved = await tenantCall(owner, 'POST', '/api/v1/integrations', {
      provider: 's3',
      displayName: 'Company bucket',
      settings: { endpoint: `http://127.0.0.1:${fakeS3.port}`, bucket: 'tenant-bucket', region: 'us-east-1', prefix: `platform/${subdomain}`, forcePathStyle: true },
      secret: s3Credentials,
    })
    assert.equal(saved.status, 201, JSON.stringify(saved.body))
    const integrationId = saved.body.integration.integrationId
    assert.equal(saved.body.integration.settings.prefix, `platform/${subdomain}/`)
    assert.equal(JSON.stringify(saved.body).includes(s3Credentials.secretAccessKey), false, 'secrets are never returned')
    const stored = (await pool.query('select secret_ciphertext from platform.tenant_integration where integration_id = $1', [integrationId])).rows[0]
    assert.equal(stored.secret_ciphertext.includes(s3Credentials.secretAccessKey), false, 'secrets are encrypted at rest')

    const early = await tenantCall(owner, 'POST', `/api/v1/integrations/${integrationId}/activate`)
    assert.notEqual(early.status, 200, 'activation requires a passing test first')

    const tested = await tenantCall(owner, 'POST', `/api/v1/integrations/${integrationId}/test`)
    assert.equal(tested.status, 200, JSON.stringify(tested.body))
    assert.equal(tested.body.report.ok, true, JSON.stringify(tested.body.report.steps))
    assert.equal(fakeS3.rejected.length, 0, `signatures rejected: ${fakeS3.rejected}`)
    assert.equal([...fakeS3.objects.keys()].some((key) => key.includes('.platform-probe')), false, 'the probe cleans up after itself')

    const activated = await tenantCall(owner, 'POST', `/api/v1/integrations/${integrationId}/activate`)
    assert.equal(activated.status, 200, JSON.stringify(activated.body))
    const upload = await tenantCall(owner, 'POST', '/api/v1/files', Buffer.from('hello from the bucket'), { 'x-file-name': 'bucket.txt', 'x-content-type': 'text/plain' })
    assert.equal(upload.status, 201)
    assert.equal(upload.body.file.storage, 'external')
    assert.ok(fakeS3.objects.has(`platform/${subdomain}/objects/${upload.body.file.id}`), 'new files land in the tenant folder of the bucket')

    const listing = await tenantCall(owner, 'GET', '/api/v1/files')
    assert.equal(listing.body.files.length, 2)
    const vdsFile = listing.body.files.find((file) => file.storage === 'vds')
    const stillReadable = await tenantCall(owner, 'GET', `/api/v1/files/${vdsFile.id}`)
    assert.equal(Buffer.from(stillReadable.body).toString(), 'hello from the VDS', 'files written before the switch stay readable')

    const move = await tenantCall(owner, 'POST', '/api/v1/integrations/storage/relocate')
    assert.equal(move.status, 202, JSON.stringify(move.body))
    const job = await waitForJob(move.body.jobId)
    assert.equal(job.status, 'succeeded', job.errorMessage || '')
    const after = await tenantCall(owner, 'GET', '/api/v1/files')
    assert.ok(after.body.files.every((file) => file.storage === 'external'))
    assert.ok(fakeS3.objects.has(`platform/${subdomain}/objects/${vdsFile.id}`))
    assert.equal(fs.existsSync(path.join(process.env.STORAGE_ROOT, 'tenants', tenantKey, 'objects', vdsFile.id)), false)
    const moved = await tenantCall(owner, 'GET', `/api/v1/files/${vdsFile.id}`)
    assert.equal(Buffer.from(moved.body).toString(), 'hello from the VDS')
  })

  test('an operator moves the tenant to its own PostgreSQL and back, with an upgrade in between', async () => {
    const saved = await platformCall('POST', `/api/tenants/${tenantKey}/integrations`, {
      provider: 'postgresql',
      displayName: 'Customer Postgres',
      settings: { host: '127.0.0.1', port: Number(adminUrl.port || 5432), database: externalDb, schema: 'acme_platform', sslMode: 'disable' },
      secret: { user: externalUser, password: externalPassword },
    })
    assert.equal(saved.status, 201, JSON.stringify(saved.body))
    const integrationId = saved.body.integration.integrationId
    const tested = await platformCall('POST', `/api/tenants/${tenantKey}/integrations/${integrationId}/test`)
    assert.equal(tested.body.report.ok, true, JSON.stringify(tested.body.report?.steps || tested.body))

    const moved = await platformCall('POST', `/api/tenants/${tenantKey}/integrations/${integrationId}/activate`)
    assert.equal(moved.status, 202, JSON.stringify(moved.body))
    const job = await waitForJob(moved.body.jobId)
    assert.equal(job.status, 'succeeded', job.errorMessage || '')

    const registry = (await pool.query('select lifecycle_status, data_integration_id::text from platform.tenant_registry where tenant_key = $1', [tenantKey])).rows[0]
    assert.deepEqual([registry.lifecycle_status, registry.data_integration_id], ['active', integrationId])
    const vdsRows = (await pool.query(`select count(*)::int as n from tenant_${tenantKey.toLowerCase()}.user_account`)).rows[0].n
    assert.equal(vdsRows, 0, 'the VDS copy is purged after the move')

    const external = new pg.Client({ host: '127.0.0.1', port: Number(adminUrl.port || 5432), database: externalDb, user: externalUser, password: externalPassword })
    await external.connect()
    try {
      await external.query('begin')
      await external.query(`select set_config('app.tenant_id', $1, true)`, [tenantId])
      const users = (await external.query('select username from acme_platform.user_account')).rows.map((row) => row.username)
      assert.deepEqual(users, ['byo.owner'])
      await external.query('rollback')
      const hidden = (await external.query('select count(*)::int as n from acme_platform.user_account')).rows[0].n
      assert.equal(hidden, 0, 'forced RLS hides rows without the tenant context, even for the owner')
    } finally {
      await external.end()
    }

    // The tenant keeps working on its own database.
    const owner = await tenantLogin('byo.owner')
    const invite = await tenantCall(owner, 'POST', '/api/v1/users', { username: 'ext.member', displayName: 'External Member', email: `ext@${subdomain}.test`, role: 'tenant_member' })
    assert.equal(invite.status, 200, JSON.stringify(invite.body))
    const files = await tenantCall(owner, 'GET', '/api/v1/files')
    assert.equal(files.body.files.length, 2, 'file metadata moved with the data')

    const upgrade = await platformCall('POST', `/api/tenants/${tenantKey}/migrate`)
    assert.equal(upgrade.status, 202, JSON.stringify(upgrade.body))
    assert.equal((await waitForJob(upgrade.body.jobId)).status, 'succeeded')

    const back = await platformCall('POST', `/api/tenants/${tenantKey}/database/use-vds`)
    assert.equal(back.status, 202, JSON.stringify(back.body))
    const backJob = await waitForJob(back.body.jobId)
    assert.equal(backJob.status, 'succeeded', backJob.errorMessage || '')
    const ownerAgain = await tenantLogin('byo.owner')
    const usersAgain = await tenantCall(ownerAgain, 'GET', '/api/v1/users')
    assert.deepEqual(usersAgain.body.users.map((user) => user.username).sort(), ['byo.owner', 'ext.member'])

    const detail = await platformCall('GET', `/api/tenants/${tenantKey}`)
    assert.equal(detail.body.tenant.dataIntegrationId, null)
  })

  test('fleet upgrades are started from the admin panel', async () => {
    await pool.query("update platform.tenant_registry set schema_version = schema_version - 1 where tenant_key = $1", [tenantKey])
    const fleet = await platformCall('POST', '/api/fleet/migrate')
    assert.equal(fleet.status, 202)
    const mine = fleet.body.jobs.find((job) => job.tenantId === tenantKey)
    assert.ok(mine?.jobId, JSON.stringify(fleet.body))
    assert.equal((await waitForJob(mine.jobId)).status, 'succeeded')
    const status = await platformCall('GET', '/api/fleet/status')
    assert.equal(status.body.tenants.find((tenant) => tenant.tenantId === tenantKey).schemaVersion, status.body.latestSchemaVersion)
  })

  test('the shared throttle store locks across processes and namespaces per service', async () => {
    const registry = new pg.Pool({ connectionString: process.env.TENANT_REGISTRY_DATABASE_URL })
    const platformPool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    try {
      const first = new kit.PostgresThrottleStore(registry)
      const second = new kit.PostgresThrottleStore(registry)
      const other = new kit.PostgresThrottleStore(platformPool)
      const key = `victim-${crypto.randomBytes(3).toString('hex')}`
      for (let attempt = 0; attempt < 3; attempt += 1) await first.failure(key, { maximumFailures: 3, lockoutMs: 60_000 })
      assert.equal(await second.allowed(key), false, 'a lockout recorded by one process is seen by another')
      assert.equal(await other.allowed(key), true, 'another service identity has its own namespace')
      await second.success(key)
      assert.equal(await first.allowed(key), true)

      const Store = kit.createSharedRateLimitStore(registry)
      const store = new Store({}).child({ routeInfo: { method: 'POST', url: '/api/auth/login' } })
      const hit = () => new Promise((resolve, reject) => store.incr(`ip-${key}`, (error, result) => (error ? reject(error) : resolve(result)), 60_000))
      assert.equal((await hit()).current, 1)
      assert.equal((await hit()).current, 2)
    } finally {
      await registry.end()
      await platformPool.end()
    }
  })

  test('deprovisioning a pooled tenant keeps the shared pool login and removes local files', async () => {
    await platformCall('POST', `/api/tenants/${tenantKey}/suspend`)
    const removal = await platformCall('POST', `/api/tenants/${tenantKey}/deprovision`)
    assert.equal(removal.status, 202, JSON.stringify(removal.body))
    assert.equal((await waitForJob(removal.body.jobId)).status, 'succeeded')
    const role = (await pool.query("select 1 from pg_roles where rolname = 'tenant_pool_login'")).rowCount
    assert.equal(role, 1, 'tenant_pool_login must survive a pooled tenant deprovision')
    assert.equal(fs.existsSync(path.join(process.env.STORAGE_ROOT, 'tenants', tenantKey)), false)
    const integrations = (await pool.query('select distinct status from platform.tenant_integration where tenant_id = $1', [tenantId])).rows.map((row) => row.status)
    assert.deepEqual(integrations, ['retired'])
    tenantKey = null
  })
})
