import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'

// B2C administration from the admin panel, catalog-driven public plans, and a
// public origin configured in the admin panel instead of the environment.

assert.ok(process.env.DATABASE_ADMIN_URL, 'DATABASE_ADMIN_URL is required')
assert.ok(process.env.PUBLIC_DATABASE_URL, 'PUBLIC_DATABASE_URL is required')

// The public BFF must take its origin from Platform / Configuration.
delete process.env.PUBLIC_PUBLIC_ORIGIN
const configuredOrigin = `https://user-${crypto.randomBytes(3).toString('hex')}.configured.test`

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')
const platformOrigin = process.env.PLATFORM_FRONTEND_ORIGIN || 'https://platform.sandbox.test'
const csrf = 'consumer-admin-csrf'

describe('Integration: B2C administration and public surface', () => {
  let pool
  let platform
  let publicApp
  let sessionHash
  let headers
  let target

  const call = async (method, url, payload) => {
    const response = await platform.inject({
      method, url,
      headers: payload === undefined ? headers.action : headers.json,
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    })
    return { status: response.statusCode, body: JSON.parse(response.payload) }
  }

  before(async () => {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_ADMIN_URL })
    await pool.query("select platform.set_config_value('platform', null, 'surfaces.public_origin', $1::jsonb, null)", [JSON.stringify(configuredOrigin)])
    const admin = (await pool.query("select id::text from platform.platform_user where role = 'platform_owner' and is_active limit 1")).rows[0]
    const token = crypto.randomBytes(32).toString('base64url')
    sessionHash = sha256(token)
    await pool.query(
      `insert into platform.platform_session (user_id, token_hash, csrf_hash, expires_at, mfa_verified_at)
       values ($1, $2, $3, now() + interval '10 minutes', now())`,
      [admin.id, sessionHash, sha256(csrf)],
    )
    headers = {
      json: { cookie: `__Host-platform_session=${token}`, 'x-csrf-token': csrf, origin: platformOrigin, 'content-type': 'application/json' },
      action: { cookie: `__Host-platform_session=${token}`, 'x-csrf-token': csrf, origin: platformOrigin },
    }
    platform = await (await import('../../backend/dist/server.js')).createServer()
  })

  after(async () => {
    if (publicApp) await publicApp.close()
    if (platform) await platform.close()
    if (target) {
      await pool.query("update consumer.user_account set account_status = 'active' where user_id = $1", [target.userId]).catch(() => undefined)
    }
    await pool.query("select platform.set_config_value('platform', null, 'surfaces.public_origin', null, null)").catch(() => undefined)
    await pool.query('delete from platform.platform_session where token_hash = $1', [sessionHash]).catch(() => undefined)
    await pool.end()
  })

  test('operators list, inspect, suspend, reactivate and re-plan individual users', async () => {
    const list = await call('GET', '/api/consumers?limit=5')
    assert.equal(list.status, 200, JSON.stringify(list.body))
    assert.ok(list.body.total > 0, 'seeded individuals are listed')
    target = list.body.users.find((user) => user.status === 'active')
    assert.ok(target)

    await pool.query(
      `insert into consumer.user_session (user_id, token_hash, csrf_hash, expires_at) values ($1, $2, $3, now() + interval '1 hour')`,
      [target.userId, sha256(crypto.randomUUID()), sha256('x')],
    )
    const suspended = await call('POST', `/api/consumers/${target.userId}/suspend`)
    assert.equal(suspended.status, 200)
    const state = (await pool.query('select account_status, (select count(*)::int from consumer.user_session where user_id = $1) as sessions from consumer.user_account where user_id = $1', [target.userId])).rows[0]
    assert.deepEqual([state.account_status, state.sessions], ['suspended', 0], 'suspension also ends sessions')

    assert.equal((await call('POST', `/api/consumers/${target.userId}/reactivate`)).status, 200)
    const plan = await call('PUT', `/api/consumers/${target.userId}/plan`, { planCode: 'pro', status: 'active' })
    assert.equal(plan.status, 200, JSON.stringify(plan.body))
    const badPlan = await call('PUT', `/api/consumers/${target.userId}/plan`, { planCode: 'standard', status: 'active' })
    assert.equal(badPlan.status, 400, 'B2B-only plans cannot be assigned to individuals')

    const detail = await call('GET', `/api/consumers/${target.userId}`)
    assert.equal(detail.body.subscriptions[0].planCode, 'pro')
    assert.ok(detail.body.recentEvents.some((event) => event.action === 'admin:suspend'))

    const stats = await call('GET', '/api/consumers/stats')
    assert.ok(stats.body.stats.total >= list.body.total)

    const audit = (await pool.query("select count(*)::int as n from platform.platform_audit where feature = 'consumers' and resource_id = $1", [target.userId])).rows[0].n
    assert.ok(audit >= 3, 'operator actions on individuals are audited on the platform side')
  })

  test('public plans and origin come from the admin panel', async () => {
    const updated = await call('PATCH', '/api/plans/plus/presentation', { description: 'Configured from the admin panel.', priceMonthly: 15, highlights: ['Configured feature'] })
    assert.equal(updated.status, 200, JSON.stringify(updated.body))

    publicApp = await (await import('../../backend/public/dist/server.js')).createServer()
    const plans = JSON.parse((await publicApp.inject({ method: 'GET', url: '/api/v1/subscriptions/plans' })).payload).plans
    assert.deepEqual(plans.map((plan) => plan.code), ['free', 'plus', 'pro', 'ultra'])
    const plus = plans.find((plan) => plan.code === 'plus')
    assert.deepEqual([plus.description, plus.priceMonthly, plus.features], ['Configured from the admin panel.', 15, ['Configured feature']])

    const allowed = await publicApp.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: configuredOrigin } })
    assert.equal(allowed.statusCode, 401, 'the configured origin passes the origin check (then fails authentication)')
    const rejected = await publicApp.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: 'https://user.sandbox.test' } })
    assert.equal(rejected.statusCode, 403, 'the old hard-coded origin is no longer trusted')

    const config = JSON.parse((await publicApp.inject({ method: 'GET', url: '/api/public-config' })).payload)
    assert.equal(typeof config.productName, 'string')
  })
})
