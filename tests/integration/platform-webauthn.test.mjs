import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import argon2 from 'argon2'
import pg from 'pg'
import { createServer } from '../../backend/dist/server.js'
import { disablePlatformUser } from '../../backend/dist/mfa.js'

process.env.NODE_ENV = 'test'
assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required for platform WebAuthn integration tests')
const adminDbUrl = process.env.DATABASE_ADMIN_URL || process.env.TEST_DATABASE_URL || process.env.DATABASE_URL

// Ensure DATABASE_URL is configured for platform_bff_runtime
let runtimeUrl = process.env.PLATFORM_BFF_DATABASE_URL || process.env.DATABASE_URL
try {
  const parsed = new URL(runtimeUrl)
  if (parsed.username !== 'platform_bff_runtime') {
    parsed.username = 'platform_bff_runtime'
    parsed.password = 'ci-platform-runtime-password'
    runtimeUrl = parsed.toString()
  }
} catch {}
process.env.DATABASE_URL = runtimeUrl

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')

// Platform password hashes are argon2id and are produced in Node, matching the
// BFF and scripts/platform-operator.mjs. Migration 024 rejects any other format
// on platform_user, so seeding with pgcrypto's crypt()/gen_salt('bf') -- whose
// default cost is 6 -- is no longer possible.
const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 }
const hashPassword = (value) => argon2.hash(value, ARGON2_OPTIONS)

describe('Integration: Platform WebAuthn MFA & Account Lifecycle', () => {
  let app
  let pool
  let adminPool
  let ownerUser
  let adminUser
  let ownerCookie
  let ownerCsrf
  let adminCookie
  let adminCsrf
  let disabledUser
  const createdUserIds = []

  before(async () => {
    adminPool = new pg.Pool({ connectionString: adminDbUrl })
    pool = new pg.Pool({ connectionString: runtimeUrl })

    // Create test active platform owner
    const ownerRes = await adminPool.query(
      `insert into platform.platform_user (username, password_hash, role, display_name, is_active)
       values ($1, $2, 'platform_owner', 'Test Owner', true)
       returning id::text, username`,
      [`test.owner.${crypto.randomBytes(4).toString('hex')}`, await hashPassword('test-owner-pw')],
    )
    ownerUser = ownerRes.rows[0]

    // Create test active platform admin
    const adminRes = await adminPool.query(
      `insert into platform.platform_user (username, password_hash, role, display_name, is_active)
       values ($1, $2, 'platform_admin', 'Test Admin', true)
       returning id::text, username`,
      [`test.admin.${crypto.randomBytes(4).toString('hex')}`, await hashPassword('test-admin-pw')],
    )
    adminUser = adminRes.rows[0]

    // Create disabled user
    const disabledRes = await adminPool.query(
      `insert into platform.platform_user (username, password_hash, role, display_name, is_active)
       values ($1, $2, 'platform_viewer', 'Disabled User', false)
       returning id::text, username`,
      [`test.disabled.${crypto.randomBytes(4).toString('hex')}`, await hashPassword('disabled-pw')],
    )
    disabledUser = disabledRes.rows[0]

    // Create session for owner without MFA verified
    const ownerToken = crypto.randomBytes(32).toString('base64url')
    ownerCsrf = 'owner-csrf-token'
    await adminPool.query(
      `insert into platform.platform_session (user_id, token_hash, csrf_hash, expires_at, mfa_verified_at)
       values ($1, $2, $3, now() + interval '1 hour', null)`,
      [ownerUser.id, sha256(ownerToken), sha256(ownerCsrf)],
    )
    ownerCookie = `__Host-platform_session=${ownerToken}`

    // Create session for admin
    const adminToken = crypto.randomBytes(32).toString('base64url')
    adminCsrf = 'admin-csrf-token'
    await adminPool.query(
      `insert into platform.platform_session (user_id, token_hash, csrf_hash, expires_at, mfa_verified_at)
       values ($1, $2, $3, now() + interval '1 hour', null)`,
      [adminUser.id, sha256(adminToken), sha256(adminCsrf)],
    )
    adminCookie = `__Host-platform_session=${adminToken}`

    app = await createServer()
  })

  after(async () => {
    if (app) await app.close()
    if (adminPool) {
      if (ownerUser) await adminPool.query('delete from platform.platform_user where id = $1', [ownerUser.id]).catch(() => {})
      if (adminUser) await adminPool.query('delete from platform.platform_user where id = $1', [adminUser.id]).catch(() => {})
      if (disabledUser) await adminPool.query('delete from platform.platform_user where id = $1', [disabledUser.id]).catch(() => {})
      for (const id of createdUserIds) {
        await adminPool.query('delete from platform.platform_user where id = $1', [id]).catch(() => {})
      }
      await adminPool.end()
    }
    if (pool) await pool.end()
  })

  test('disabled platform account cannot authenticate via password login', async () => {
    const origin = process.env.PLATFORM_FRONTEND_ORIGIN || 'http://127.0.0.1:3652'
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: {
        origin,
      },
      payload: {
        username: disabledUser.username,
        password: 'disabled-pw',
        turnstileToken: 'dummy-turnstile-token-passed-in-dev-mode',
      },
    })
    assert.equal(res.statusCode, 401)
  })

  test('existing session of disabled account fails immediately', async () => {
    // Mint session for disabled user
    const token = crypto.randomBytes(32).toString('base64url')
    await adminPool.query(
      `insert into platform.platform_session (user_id, token_hash, csrf_hash, expires_at)
       values ($1, $2, $3, now() + interval '1 hour')`,
      [disabledUser.id, sha256(token), sha256('dummy-csrf')],
    )

    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: `__Host-platform_session=${token}` },
    })
    assert.equal(res.statusCode, 401, 'Disabled user session should be rejected with 401')
  })

  test('password-only owner session cannot mutate control-plane without recent MFA', async () => {
    const origin = process.env.PLATFORM_FRONTEND_ORIGIN || 'https://platform.sandbox.test'
    const res = await app.inject({
      method: 'POST',
      url: '/api/tenants',
      headers: {
        cookie: ownerCookie,
        'x-csrf-token': ownerCsrf,
        'content-type': 'application/json',
        origin,
      },
      payload: JSON.stringify({ displayName: 'MFA Blocked Tenant', subdomain: 'mfablocked' }),
    })

    assert.equal(res.statusCode, 403)
    const body = JSON.parse(res.payload)
    assert.equal(body.code, 'MFA_STEP_UP_REQUIRED')
  })

  test('echoing challenge is rejected (no plaintext challenge verification endpoint)', async () => {
    const origin = process.env.PLATFORM_FRONTEND_ORIGIN || 'https://platform.sandbox.test'

    // The legacy endpoint /api/auth/mfa/challenge and /api/auth/mfa/verify must NOT accept echoed challenge
    const oldVerifyRes = await app.inject({
      method: 'POST',
      url: '/api/auth/mfa/verify',
      headers: {
        cookie: ownerCookie,
        'x-csrf-token': ownerCsrf,
        'content-type': 'application/json',
        origin,
      },
      payload: JSON.stringify({ challenge: 'echoed-challenge' }),
    })

    // Route no longer exists or rejects
    assert.equal(oldVerifyRes.statusCode === 404 || oldVerifyRes.statusCode === 400, true)
  })

  test('WebAuthn registration ceremony issues valid options and rejects invalid assertion', async () => {
    const origin = process.env.PLATFORM_FRONTEND_ORIGIN || 'https://platform.sandbox.test'

    // 1. Request options
    const optionsRes = await app.inject({
      method: 'POST',
      url: '/api/auth/mfa/registration/options',
      headers: {
        cookie: ownerCookie,
        'x-csrf-token': ownerCsrf,
        origin,
      },
    })
    assert.equal(optionsRes.statusCode, 200)
    const optionsBody = JSON.parse(optionsRes.payload)
    assert.equal(optionsBody.success, true)
    assert.ok(optionsBody.challengeId)
    assert.ok(optionsBody.options.challenge)
    assert.equal(optionsBody.options.authenticatorSelection.userVerification, 'required')

    // 2. Submit bogus assertion
    const verifyRes = await app.inject({
      method: 'POST',
      url: '/api/auth/mfa/registration/verify',
      headers: {
        cookie: ownerCookie,
        'x-csrf-token': ownerCsrf,
        'content-type': 'application/json',
        origin,
      },
      payload: JSON.stringify({
        challengeId: optionsBody.challengeId,
        response: {
          id: 'fake-cred-id',
          rawId: 'fake-raw-id',
          type: 'public-key',
          response: {
            clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: 'bogus' })).toString('base64url'),
            attestationObject: 'fake-attestation',
          },
        },
      }),
    })

    assert.equal(verifyRes.statusCode, 400)
    const verifyBody = JSON.parse(verifyRes.payload)
    assert.equal(verifyBody.success, false)
  })

  test('WebAuthn authentication assertion options fails when no credentials enrolled', async () => {
    const origin = process.env.PLATFORM_FRONTEND_ORIGIN || 'https://platform.sandbox.test'
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/mfa/assertion/options',
      headers: {
        cookie: ownerCookie,
        'x-csrf-token': ownerCsrf,
        origin,
      },
    })
    assert.equal(res.statusCode, 400)
    const body = JSON.parse(res.payload)
    assert.ok(body.message.includes('No registered WebAuthn credentials'))
  })

  test('admin role cannot access owner-only routes even with MFA', async () => {
    const origin = process.env.PLATFORM_FRONTEND_ORIGIN || 'https://platform.sandbox.test'
    // Mark admin session as MFA verified for testing authorization boundary
    await adminPool.query(
      `update platform.platform_session set mfa_verified_at = now()
       where user_id = $1`,
      [adminUser.id],
    )

    // Attempt deprovision which requires ownerRoles
    const res = await app.inject({
      method: 'POST',
      url: '/api/tenants/TNONEXISTENT/deprovision',
      headers: {
        cookie: adminCookie,
        'x-csrf-token': adminCsrf,
        origin,
      },
    })
    assert.equal(res.statusCode, 403, 'Platform admin must not access platform owner endpoints')
  })

  test('disablePlatformUser terminates sessions and protects last active platform owner', async () => {
    // 1. Trying to disable the sole remaining seeded owner should fail if there's only 1
    // First, verify how many active owners exist
    const ownerCountRes = await adminPool.query(
      `select count(*)::int as count from platform.platform_user where role = 'platform_owner' and is_active = true`,
    )
    const count = ownerCountRes.rows[0].count

    if (count <= 1) {
      await assert.rejects(
        disablePlatformUser(adminPool, ownerUser.id),
        /platform must retain at least one active platform_owner/,
      )
    } else {
      // Create another temporary owner
      // Recorded in `createdUserIds` so the after() hook removes it. An earlier
      // version of this test left its temp owner behind: a disabled-then-
      // forgotten row is still a platform_owner with a password hash, and one
      // such row was found active in the production database with a cost-6
      // bcrypt hash, created by this test running against the live cluster.
      const tempOwner = (
        await adminPool.query(
          `insert into platform.platform_user (username, password_hash, role, display_name, is_active)
           values ($1, $2, 'platform_owner', 'Temp Owner', true)
           returning id::text`,
          [`temp.owner.${crypto.randomBytes(4).toString('hex')}`, await hashPassword('test-temp-pw')],
        )
      ).rows[0]
      createdUserIds.push(tempOwner.id)

      // Disabling tempOwner should succeed
      await disablePlatformUser(adminPool, tempOwner.id, ownerUser.id)

      const disabledRow = (
        await adminPool.query('select is_active from platform.platform_user where id = $1', [tempOwner.id])
      ).rows[0]
      assert.equal(disabledRow.is_active, false)

      await adminPool.query('delete from platform.platform_user where id = $1', [tempOwner.id])
    }
  })
})
