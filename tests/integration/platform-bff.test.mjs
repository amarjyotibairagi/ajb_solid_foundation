import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import pg from 'pg'
import { createServer } from '../../backend/dist/server.js'

describe('Platform BFF', () => {
  let server
  let pool
  let sessionToken

  before(async () => {
    server = await createServer()
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    const user = (await pool.query(
      "select id::text from platform.platform_user where role = 'platform_owner' order by created_at limit 1",
    )).rows[0]
    assert.ok(user, 'a seeded platform owner is required')
    sessionToken = crypto.randomBytes(32).toString('base64url')
    await pool.query(
      `insert into platform.platform_session (user_id, token_hash, csrf_hash, expires_at)
       values ($1, $2, $3, now() + interval '5 minutes')`,
      [
        user.id,
        crypto.createHash('sha256').update(sessionToken).digest('hex'),
        crypto.createHash('sha256').update('expected-csrf').digest('hex'),
      ],
    )
  })

  after(async () => {
    if (pool && sessionToken) {
      await pool.query('delete from platform.platform_session where token_hash = $1', [
        crypto.createHash('sha256').update(sessionToken).digest('hex'),
      ])
    }
    if (pool) await pool.end()
    if (server) await server.close()
  })

  test('health verifies the platform database', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/health' })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(JSON.parse(response.payload), { success: true, status: 'ok' })
  })

  test('protected routes reject anonymous requests', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/tenants' })
    assert.equal(response.statusCode, 401)
  })

  test('authenticated mutations reject an invalid CSRF token before side effects', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/cloudflare/subdomains',
      headers: {
        cookie: `__Host-platform_session=${sessionToken}`,
        origin: process.env.PLATFORM_FRONTEND_ORIGIN || 'https://platform.sandbox.test',
        'x-csrf-token': 'incorrect-csrf',
      },
      payload: { label: 'must-not-be-created' },
    })
    assert.equal(response.statusCode, 403)
    assert.equal(JSON.parse(response.payload).message, 'CSRF validation failed')
  })
})
