import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'

// End-to-end coverage for the admin-panel control surface: onboarding through
// invitations, the configuration registry and its enforcement in the tenant
// BFF, module gating, operator administration, fleet status, and the
// declarative tenant access manifest.

assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required')
assert.ok(process.env.TENANT_PROVISIONER_DATABASE_URL, 'TENANT_PROVISIONER_DATABASE_URL is required')
assert.ok(process.env.TENANT_REGISTRY_DATABASE_URL, 'TENANT_REGISTRY_DATABASE_URL is required')

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skeleton-admin-controls-'))
process.env.TENANT_CREDENTIALS_DIR = path.join(tempDir, 'credentials')
process.env.TENANT_PGBOUNCER_AUTH_FILE = path.join(tempDir, 'tenant-users.txt')
fs.mkdirSync(process.env.TENANT_CREDENTIALS_DIR, { recursive: true })
fs.writeFileSync(process.env.TENANT_PGBOUNCER_AUTH_FILE, '')
process.env.TENANT_EDGE_VERIFY_DISABLED = 'true'
process.env.TENANT_PGBOUNCER_RELOAD_DISABLED = 'true'
process.env.TENANT_CONFIG_CACHE_TTL_MS = '0'
const dbUrl = new URL(process.env.DATABASE_URL)
process.env.TENANT_PGBOUNCER_HOST = dbUrl.hostname
process.env.TENANT_PGBOUNCER_PORT = dbUrl.port || '5432'

const { createServer: createPlatformServer } = await import('../../backend/dist/server.js')
const { createServer: createTenantServer } = await import('../../backend/tenant/dist/server.js')
const { TenantProvisioningWorker } = await import('../../backend/provisioner/dist/worker.js')
const { applyTenantAccessManifest, loadTenantAccessManifest } = await import('../../backend/provisioner/dist/tenant-migrations.js')

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')
const rootDomain = process.env.TENANT_ROOT_DOMAIN || 'sandbox.test'
const platformOrigin = process.env.PLATFORM_FRONTEND_ORIGIN || 'https://platform.sandbox.test'
const csrf = 'admin-controls-csrf'
const tokenFromLink = (link) => decodeURIComponent(new URL(link).hash.replace(/^#token=/, ''))

describe('Integration: admin-panel control surface', () => {
  let platform
  let tenantApp
  let pool
  let admin
  let worker
  let timer
  let ownerSessionHash
  let ownerId
  const subdomain = `zzadmin${crypto.randomBytes(4).toString('hex')}`
  const host = `${subdomain}.${rootDomain}`
  let tenantKey
  const tenantHeaders = (extra = {}) => ({ host, origin: `https://${host}`, ...extra })
  let platformHeaders

  async function platformCall(method, url, payload) {
    const response = await platform.inject({
      method,
      url,
      headers: payload === undefined ? platformHeaders.action : platformHeaders.json,
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    })
    return { status: response.statusCode, body: JSON.parse(response.payload) }
  }

  async function tenantLogin(username, password) {
    const response = await tenantApp.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: tenantHeaders({ 'content-type': 'application/json' }),
      payload: JSON.stringify({ username, password, turnstileToken: 'x'.repeat(24) }),
    })
    const body = JSON.parse(response.payload)
    assert.equal(response.statusCode, 200, body.message)
    const cookie = response.cookies.find((item) => item.name.endsWith('tenant_session'))
    return { cookie: `${cookie.name}=${cookie.value}`, csrfToken: body.csrfToken, user: body.user }
  }

  async function tenantCall(session, method, url, payload) {
    const headers = tenantHeaders({ cookie: session.cookie, 'x-csrf-token': session.csrfToken })
    if (payload !== undefined) headers['content-type'] = 'application/json'
    const response = await tenantApp.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) })
    return { status: response.statusCode, body: JSON.parse(response.payload) }
  }

  async function waitForActive(jobId) {
    const deadline = Date.now() + 60_000
    for (;;) {
      const { body } = await platformCall('GET', `/api/tenant-provisioning/${jobId}`)
      if (body.job.status === 'succeeded') return
      if (body.job.status === 'failed') throw new Error(`provisioning failed: ${body.job.errorMessage}`)
      if (Date.now() > deadline) throw new Error('provisioning timed out')
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  before(async () => {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_ADMIN_URL || process.env.TEST_DATABASE_URL })
    admin = (await pool.query("select id::text from platform.platform_user where role = 'platform_owner' and is_active order by created_at limit 1")).rows[0]
    assert.ok(admin, 'a seeded platform owner is required')
    const token = crypto.randomBytes(32).toString('base64url')
    ownerSessionHash = sha256(token)
    await pool.query(
      `insert into platform.platform_session (user_id, token_hash, csrf_hash, expires_at, mfa_verified_at)
       values ($1, $2, $3, now() + interval '15 minutes', now())`,
      [admin.id, ownerSessionHash, sha256(csrf)],
    )
    const cookie = `__Host-platform_session=${token}`
    platformHeaders = {
      json: { cookie, 'x-csrf-token': csrf, origin: platformOrigin, 'content-type': 'application/json' },
      action: { cookie, 'x-csrf-token': csrf, origin: platformOrigin },
    }
    platform = await createPlatformServer()
    tenantApp = await createTenantServer()
    worker = new TenantProvisioningWorker()
    await worker.assertIdentity()
    timer = setInterval(() => worker.tick().catch((error) => console.error('[admin-controls] worker tick failed', error)), 250)
  })

  after(async () => {
    if (tenantKey) {
      // Leave the cluster as we found it: suspend, then run the real
      // deprovisioning pipeline while the worker is still ticking.
      await platformCall('POST', `/api/tenants/${tenantKey}/suspend`).catch(() => undefined)
      const removal = await platformCall('POST', `/api/tenants/${tenantKey}/deprovision`).catch(() => null)
      if (removal?.body?.jobId) {
        const deadline = Date.now() + 60_000
        while (Date.now() < deadline) {
          const { body } = await platformCall('GET', `/api/tenant-provisioning/${removal.body.jobId}`)
          if (['succeeded', 'failed'].includes(body.job?.status)) break
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
      }
    }
    if (timer) clearInterval(timer)
    if (worker) await worker.close()
    await pool.query('delete from platform.platform_session where token_hash = $1', [ownerSessionHash]).catch(() => undefined)
    await pool.query(`delete from platform.platform_user where username like 'zzop%'`).catch(() => undefined)
    if (tenantApp) await tenantApp.close()
    if (platform) await platform.close()
    if (pool) await pool.end()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('reserved subdomains come from platform configuration', async () => {
    const custom = `zzres${crypto.randomBytes(3).toString('hex')}`
    const current = (await platformCall('GET', '/api/config/definitions')).body
    const reserved = current.definitions.find((item) => item.key === 'tenancy.reserved_subdomains').defaultValue
    let result = await platformCall('PUT', '/api/config/values', { scope: 'platform', key: 'tenancy.reserved_subdomains', value: [...reserved, custom] })
    assert.equal(result.status, 200, result.body.message)
    // The platform config cache is 10s; a fresh server reads the new value.
    const fresh = await createPlatformServer()
    try {
      const response = await fresh.inject({
        method: 'POST',
        url: '/api/tenants',
        headers: platformHeaders.json,
        payload: JSON.stringify({ displayName: 'Reserved', subdomain: custom }),
      })
      assert.equal(response.statusCode, 400)
    } finally {
      await fresh.close()
      result = await platformCall('DELETE', '/api/config/values', { scope: 'platform', key: 'tenancy.reserved_subdomains' })
      assert.equal(result.status, 200)
    }
  })

  test('onboarding: tenant created with plan and owner invitation; owner redeems it on the tenant host', async () => {
    const created = await platformCall('POST', '/api/tenants', {
      displayName: 'Admin Controls Tenant',
      subdomain,
      planCode: 'standard',
      owner: { email: `owner@${subdomain}.test`, displayName: 'First Owner' },
    })
    assert.equal(created.status, 202, created.body.message)
    tenantKey = created.body.tenant.tenantId
    assert.equal(created.body.planCode, 'standard')
    assert.match(created.body.ownerInvitation.link, new RegExp(`^https://${host}/accept-invite#token=own_`))
    await waitForActive(created.body.jobId)

    const token = tokenFromLink(created.body.ownerInvitation.link)
    const inspect = await tenantApp.inject({
      method: 'POST', url: '/api/auth/invitations/inspect',
      headers: tenantHeaders({ 'content-type': 'application/json' }), payload: JSON.stringify({ token }),
    })
    assert.equal(inspect.statusCode, 200, inspect.payload)
    assert.equal(JSON.parse(inspect.payload).invitation.kind, 'owner')

    const short = await tenantApp.inject({
      method: 'POST', url: '/api/auth/invitations/accept',
      headers: tenantHeaders({ 'content-type': 'application/json' }),
      payload: JSON.stringify({ token, username: 'first.owner', password: 'short' }),
    })
    assert.equal(short.statusCode, 400)

    const accepted = await tenantApp.inject({
      method: 'POST', url: '/api/auth/invitations/accept',
      headers: tenantHeaders({ 'content-type': 'application/json' }),
      payload: JSON.stringify({ token, username: 'first.owner', password: 'correct horse battery staple' }),
    })
    assert.equal(accepted.statusCode, 200, accepted.payload)
    ownerId = JSON.parse(accepted.payload).userId

    const replay = await tenantApp.inject({
      method: 'POST', url: '/api/auth/invitations/accept',
      headers: tenantHeaders({ 'content-type': 'application/json' }),
      payload: JSON.stringify({ token, username: 'second.owner', password: 'correct horse battery staple' }),
    })
    assert.equal(replay.statusCode, 404, 'owner invitations are single-use')

    const session = await tenantLogin('first.owner', 'correct horse battery staple')
    assert.equal(session.user.role, 'admin')

    const detail = await platformCall('GET', `/api/tenants/${tenantKey}`)
    assert.equal(detail.status, 200)
    assert.equal(detail.body.subscription.planCode, 'standard')
    assert.ok(detail.body.ownerInvitations[0].acceptedAt)
    assert.equal(detail.body.tenant.schemaVersion, detail.body.tenant.latestSchemaVersion)
  })

  test('tenant users are invited, redeem once, and the user limit from configuration is enforced', async () => {
    const owner = await tenantLogin('first.owner', 'correct horse battery staple')
    const invite = await tenantCall(owner, 'POST', '/api/v1/users', {
      username: 'member.one', displayName: 'Member One', email: `m1@${subdomain}.test`, role: 'tenant_member',
    })
    assert.equal(invite.status, 200, invite.body.message)
    assert.equal(invite.body.user.status, 'invited')
    const token = tokenFromLink(invite.body.invitation.link)
    assert.match(token, /^inv_/)

    const accept = await tenantApp.inject({
      method: 'POST', url: '/api/auth/invitations/accept',
      headers: tenantHeaders({ 'content-type': 'application/json' }),
      payload: JSON.stringify({ token, password: 'member one strong password' }),
    })
    assert.equal(accept.statusCode, 200, accept.payload)
    const member = await tenantLogin('member.one', 'member one strong password')
    assert.equal(member.user.role, 'user')

    // Limit: 2 users exist (owner + member). An operator caps this tenant at 2.
    const cap = await platformCall('PUT', '/api/config/values', { scope: 'tenant', ref: tenantKey, key: 'limit.users.max', value: 2 })
    assert.equal(cap.status, 200, cap.body.message)
    const blocked = await tenantCall(owner, 'POST', '/api/v1/users', {
      username: 'member.two', displayName: 'Member Two', email: `m2@${subdomain}.test`, role: 'tenant_member',
    })
    assert.equal(blocked.status, 409)
    assert.match(blocked.body.message, /limit of 2 users/)

    const invalid = await platformCall('PUT', '/api/config/values', { scope: 'tenant', ref: tenantKey, key: 'limit.users.max', value: -1 })
    assert.equal(invalid.status, 400, 'the registry rejects out-of-range values')

    await platformCall('DELETE', '/api/config/values', { scope: 'tenant', ref: tenantKey, key: 'limit.users.max' })
    const allowed = await tenantCall(owner, 'POST', '/api/v1/users', {
      username: 'member.two', displayName: 'Member Two', email: `m2@${subdomain}.test`, role: 'tenant_member',
    })
    assert.equal(allowed.status, 200, allowed.body.message)

    const reissued = await tenantCall(owner, 'POST', `/api/v1/users/${allowed.body.user.id}/invitation`)
    assert.equal(reissued.status, 200, reissued.body.message)
    const stale = await tenantApp.inject({
      method: 'POST', url: '/api/auth/invitations/inspect',
      headers: tenantHeaders({ 'content-type': 'application/json' }),
      payload: JSON.stringify({ token: tokenFromLink(allowed.body.invitation.link) }),
    })
    assert.equal(stale.statusCode, 404, 'reissuing revokes the previous link')
  })

  test('suspending a user revokes their sessions', async () => {
    const owner = await tenantLogin('first.owner', 'correct horse battery staple')
    const member = await tenantLogin('member.one', 'member one strong password')
    const users = await tenantCall(owner, 'GET', '/api/v1/users')
    const target = users.body.users.find((user) => user.username === 'member.one')
    const suspended = await tenantCall(owner, 'POST', `/api/v1/users/${target.id}/suspend`)
    assert.equal(suspended.status, 200, suspended.body.message)
    const after = await tenantApp.inject({ method: 'GET', url: '/api/auth/session', headers: tenantHeaders({ cookie: member.cookie }) })
    assert.equal(JSON.parse(after.payload).authenticated, false)
  })

  test('tenant settings expose sources and accept only tenant-editable keys within bounds', async () => {
    const owner = await tenantLogin('first.owner', 'correct horse battery staple')
    const listed = await tenantCall(owner, 'GET', '/api/v1/settings')
    assert.equal(listed.status, 200)
    assert.equal(listed.body.planCode, 'standard')
    const ttl = listed.body.settings.find((item) => item.key === 'auth.session_ttl_minutes')
    assert.equal(ttl.editable, true)
    assert.equal(ttl.source, 'default')

    const planValue = await platformCall('PUT', '/api/config/values', { scope: 'plan', ref: 'standard', key: 'auth.session_ttl_minutes', value: 240 })
    assert.equal(planValue.status, 200, planValue.body.message)
    let current = await tenantCall(owner, 'GET', '/api/v1/settings')
    assert.equal(current.body.settings.find((item) => item.key === 'auth.session_ttl_minutes').source, 'plan')

    const updated = await tenantCall(owner, 'PUT', '/api/v1/settings/auth.session_ttl_minutes', { value: 60 })
    assert.equal(updated.status, 200, updated.body.message)
    current = await tenantCall(owner, 'GET', '/api/v1/settings')
    const effective = current.body.settings.find((item) => item.key === 'auth.session_ttl_minutes')
    assert.deepEqual([effective.value, effective.source], [60, 'tenant_local'])

    const outOfRange = await tenantCall(owner, 'PUT', '/api/v1/settings/auth.session_ttl_minutes', { value: 1 })
    assert.equal(outOfRange.status, 400)
    const locked = await tenantCall(owner, 'PUT', '/api/v1/settings/limit.users.max', { value: 0 })
    assert.equal(locked.status, 403, 'limits are platform-controlled')

    // Session lifetime from configuration is applied at sign-in.
    const relogin = await tenantApp.inject({
      method: 'POST', url: '/api/auth/login', headers: tenantHeaders({ 'content-type': 'application/json' }),
      payload: JSON.stringify({ username: 'first.owner', password: 'correct horse battery staple', turnstileToken: 'x'.repeat(24) }),
    })
    const cookie = relogin.cookies.find((item) => item.name.endsWith('tenant_session'))
    assert.equal(cookie.maxAge, 3600)

    await tenantCall(owner, 'DELETE', '/api/v1/settings/auth.session_ttl_minutes')
    await platformCall('DELETE', '/api/config/values', { scope: 'plan', ref: 'standard', key: 'auth.session_ttl_minutes' })
  })

  test('application modules are hidden until enabled from the admin panel', async () => {
    const owner = await tenantLogin('first.owner', 'correct horse battery staple')
    const url = `/api/v1/managers/${ownerId}/delegations`
    let response = await tenantCall(owner, 'GET', url)
    assert.equal(response.status, 404, 'module.delegations defaults to off')

    const bootstrapOff = JSON.parse((await tenantApp.inject({ method: 'GET', url: '/api/tenant/bootstrap', headers: tenantHeaders() })).payload)
    assert.equal(bootstrapOff.config['module.delegations'], false)
    assert.equal(bootstrapOff.config['limit.users.max'], undefined, 'non-public keys never reach the browser')

    const enabled = await platformCall('PUT', '/api/config/values', { scope: 'tenant', ref: tenantKey, key: 'module.delegations', value: true })
    assert.equal(enabled.status, 200, enabled.body.message)
    response = await tenantCall(owner, 'GET', url)
    assert.equal(response.status, 200, response.body.message)
    assert.ok(Array.isArray(response.body.delegations))
  })

  test('tenant profile edits are reflected on the tenant host', async () => {
    const patched = await platformCall('PATCH', `/api/tenants/${tenantKey}`, { displayName: 'Renamed Tenant', primaryColor: '#123456' })
    assert.equal(patched.status, 200, patched.body.message)
    const bootstrap = JSON.parse((await tenantApp.inject({ method: 'GET', url: '/api/tenant/bootstrap', headers: tenantHeaders() })).payload)
    assert.equal(bootstrap.tenant.displayName, 'Renamed Tenant')
    assert.equal(bootstrap.tenant.branding.primaryColor, '#123456')
    const badColor = await platformCall('PATCH', `/api/tenants/${tenantKey}`, { primaryColor: 'red' })
    assert.equal(badColor.status, 400)
  })

  test('operators are invited, set their own password, and cannot remove the last owner', async () => {
    const username = `zzop${crypto.randomBytes(3).toString('hex')}`
    const invited = await platformCall('POST', '/api/platform/users', { username, displayName: 'Ops Person', role: 'platform_viewer' })
    assert.equal(invited.status, 201, invited.body.message)
    const token = tokenFromLink(invited.body.invitation.link)
    assert.match(token, /^opr_/)

    const listedBefore = (await platformCall('GET', '/api/platform/users')).body.users.find((user) => user.username === username)
    assert.deepEqual([listedBefore.isActive, listedBefore.hasPassword], [false, false])

    const weak = await platform.inject({ method: 'POST', url: '/api/auth/invitations/accept', headers: { 'content-type': 'application/json', origin: platformOrigin }, payload: JSON.stringify({ token, password: 'thirteen char' }) })
    assert.equal(weak.statusCode, 400)
    const accepted = await platform.inject({ method: 'POST', url: '/api/auth/invitations/accept', headers: { 'content-type': 'application/json', origin: platformOrigin }, payload: JSON.stringify({ token, password: 'a long operator password' }) })
    assert.equal(accepted.statusCode, 200, accepted.payload)

    const listed = (await platformCall('GET', '/api/platform/users')).body.users.find((user) => user.username === username)
    assert.deepEqual([listed.isActive, listed.hasPassword], [true, true])

    assert.equal((await platformCall('POST', `/api/platform/users/${listed.id}/role`, { role: 'platform_admin' })).status, 200)
    assert.equal((await platformCall('POST', `/api/platform/users/${listed.id}/deactivate`)).status, 200)
    assert.equal((await platformCall('POST', `/api/platform/users/${listed.id}/enable`)).status, 200)
    assert.equal((await platformCall('POST', `/api/platform/users/${listed.id}/reset-mfa`)).status, 200)

    const selfDisable = await platformCall('POST', `/api/platform/users/${admin.id}/deactivate`)
    assert.equal(selfDisable.status, 409)
    const selfDemote = await platformCall('POST', `/api/platform/users/${admin.id}/role`, { role: 'platform_viewer' })
    assert.equal(selfDemote.status, 409)
  })

  test('fleet status and filtered audit reflect the tenant', async () => {
    const fleet = await platformCall('GET', '/api/fleet/status')
    assert.equal(fleet.status, 200)
    const row = fleet.body.tenants.find((tenant) => tenant.tenantId === tenantKey)
    assert.equal(row.schemaVersion, fleet.body.latestSchemaVersion)
    assert.equal(row.planCode, 'standard')

    const audit = await platformCall('GET', `/api/audit/events?tenantKey=${tenantKey}&limit=200`)
    assert.equal(audit.status, 200)
    const actions = audit.body.events.map((event) => event.action)
    for (const expected of ['owner_invitation_issued', 'owner_invitation_accepted', 'tenant_profile_updated', 'config_set']) {
      assert.ok(actions.includes(expected), `audit should include ${expected}`)
    }
  })

  test('the access manifest fails closed on an undeclared tenant table', async () => {
    const schema = `tenant_zzmanifest${crypto.randomBytes(3).toString('hex')}`
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query(`create schema ${schema} authorization tenant_template_owner`)
      await client.query('set local role tenant_template_owner')
      await client.query(`create table ${schema}.undeclared_widget (id int)`)
      await assert.rejects(
        applyTenantAccessManifest(client, await loadTenantAccessManifest(), {
          schemaName: schema, runtimeRole: 'tenant_placeholder_runtime', loginRole: 'tenant_placeholder_login',
        }),
        /missing from the access manifest: undeclared_widget/,
      )
    } finally {
      await client.query('rollback')
      client.release()
    }
  })
})
