import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import pg from 'pg'
import { assertNotDemotingLastOwner } from '../../backend/tenant/dist/authorization.js'
import { tenantLoginUrl, testTenants } from '../helpers/fixture.mjs'

const { alpha } = testTenants().tenants

assert.ok(process.env.TENANT_PROVISIONER_DATABASE_URL, 'TENANT_PROVISIONER_DATABASE_URL is required')
const adminUrl = process.env.DATABASE_ADMIN_URL || process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
assert.ok(adminUrl, 'DATABASE_ADMIN_URL or TEST_DATABASE_URL is required')

describe('Integration: Tenant Operator CLI & Role Invariants', () => {
  let adminPool
  let provisionerPool
  const tenantKey = alpha.tenantKey
  const schemaName = `${alpha.schemaName}`

  before(async () => {
    adminPool = new pg.Pool({ connectionString: adminUrl })
    provisionerPool = new pg.Pool({ connectionString: process.env.TENANT_PROVISIONER_DATABASE_URL })
  })

  after(async () => {
    if (adminPool) await adminPool.end()
    if (provisionerPool) await provisionerPool.end()
  })

  test('bootstrap-owner rejects --password in command-line arguments', () => {
    const res = spawnSync(
      'node',
      [
        'scripts/tenant-operator.mjs',
        'bootstrap-owner',
        '--tenant',
        tenantKey,
        '--username',
        'test-arg-pw',
        '--email',
        'test@example.com',
        '--password',
        'secret1234',
      ],
      {
        env: {
          ...process.env,
          NODE_ENV: 'test',
        },
        encoding: 'utf8',
      },
    )
    assert.notEqual(res.status, 0, 'Must exit with nonzero status')
    assert.match(res.stderr, /Passing passwords in CLI arguments \(--password\) is prohibited/)
  })

  test('bootstrap-owner fails if an active tenant_owner already exists', async () => {
    // Ensure an initial active owner exists
    const ownerRes = await adminPool.query(
      `select count(*)::int as count from ${alpha.schemaName}.role_assignment ra
       join ${alpha.schemaName}.role_definition rd on rd.role_id = ra.role_id
       where rd.role_code = 'tenant_owner' and (ra.expires_at is null or ra.expires_at > now())`,
    )
    if (ownerRes.rows[0].count === 0) {
      await adminPool.query(
        `insert into ${alpha.schemaName}.role_assignment (user_id, role_id)
         select ua.user_id, rd.role_id from ${alpha.schemaName}.user_account ua, ${alpha.schemaName}.role_definition rd
         where ua.username = '${alpha.ownerUsername}' and rd.role_code = 'tenant_owner'
         on conflict do nothing`,
      )
    }

    // Pipe a dummy password via a temporary file descriptor
    const tmpFile = `/tmp/test-pw-${crypto.randomBytes(4).toString('hex')}`
    fs.writeFileSync(tmpFile, 'ValidPassword123!\n', { mode: 0o600 })
    const fd = fs.openSync(tmpFile, 'r')

    try {
      const res = spawnSync(
        'node',
        [
          'scripts/tenant-operator.mjs',
          'bootstrap-owner',
          '--tenant',
          tenantKey,
          '--username',
          'secondowner',
          '--email',
          'secondowner@example.com',
          '--password-fd',
          '3',
        ],
        {
          env: {
            ...process.env,
            NODE_ENV: 'test',
          },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe', fd],
        },
      )
      assert.notEqual(res.status, 0)
      assert.match(res.stderr, /already has an active tenant_owner/)
    } finally {
      fs.closeSync(fd)
      fs.unlinkSync(tmpFile)
    }
  })

  test('operator disable-user protects sole active tenant_owner from being disabled', async () => {
    // Find the single active owner
    const ownerRes = await adminPool.query(
      `select ua.username
         from ${alpha.schemaName}.user_account ua
         join ${alpha.schemaName}.role_assignment ra on ra.user_id = ua.user_id
         join ${alpha.schemaName}.role_definition rd on rd.role_id = ra.role_id
        where rd.role_code = 'tenant_owner' and ua.account_status = 'active'
        limit 1`,
    )
    assert.ok(ownerRes.rows[0], 'Must have an active owner seeded')
    const ownerUsername = ownerRes.rows[0].username

    const res = spawnSync(
      'node',
      [
        'scripts/tenant-operator.mjs',
        'disable-user',
        '--tenant',
        tenantKey,
        '--username',
        ownerUsername,
      ],
      {
        env: {
          ...process.env,
          NODE_ENV: 'test',
        },
        encoding: 'utf8',
      },
    )
    assert.notEqual(res.status, 0)
    assert.match(res.stderr, /must retain at least one active tenant_owner/)
  })

  test('operator actions audit with actor_type=operator, actor_user_id=null, and non-secret operator_id', async () => {
    // 1. Create a non-owner user to test disable
    const testUsername = `user_${crypto.randomBytes(4).toString('hex')}`
    const insertRes = await adminPool.query(
      `insert into ${alpha.schemaName}.user_account (username, display_name, email_normalized, account_status)
       values ($1, 'Test Operator Audit', lower($2), 'active')
       returning user_id::text`,
      [testUsername, `${testUsername}@example.com`],
    )
    const userId = insertRes.rows[0].user_id

    // Give a non-owner role (tenant_member)
    const memberRole = (await adminPool.query(
      `select role_id from ${alpha.schemaName}.role_definition where role_code = 'tenant_member'`,
    )).rows[0]
    await adminPool.query(
      `insert into ${alpha.schemaName}.role_assignment (user_id, role_id) values ($1, $2)`,
      [userId, memberRole.role_id],
    )

    // Insert a dummy session to test revocation on disable
    await adminPool.query(
      `insert into ${alpha.schemaName}.user_session (tenant_id, user_id, token_hash, csrf_hash, expires_at)
       values ($1, $2, 'hash-token', 'hash-csrf', now() + interval '1 hour')`,
      [alpha.tenantId, userId],
    )

    const res = spawnSync(
      'node',
      [
        'scripts/tenant-operator.mjs',
        'disable-user',
        '--tenant',
        tenantKey,
        '--username',
        testUsername,
      ],
      {
        env: {
          ...process.env,
          NODE_ENV: 'test',
          OPERATOR_ID: 'sec-operator-99',
        },
        encoding: 'utf8',
      },
    )
    assert.equal(res.status, 0, `Command failed: ${res.stderr}`)

    // Verify account status is 'suspended' (not invalid 'disabled')
    const userRow = (
      await adminPool.query(`select account_status from ${alpha.schemaName}.user_account where user_id = $1`, [userId])
    ).rows[0]
    assert.equal(userRow.account_status, 'suspended')

    // Verify session was revoked
    const sessions = await adminPool.query(`select 1 from ${alpha.schemaName}.user_session where user_id = $1`, [userId])
    assert.equal(sessions.rows.length, 0)

    // Verify audit event
    const auditRes = await adminPool.query(
      `select actor_user_id, actor_type, operator_id, outcome, action
         from ${alpha.schemaName}.audit_event
        where resource_id = $1
        order by occurred_at desc
        limit 1`,
      [userId],
    )
    assert.ok(auditRes.rows[0])
    assert.equal(auditRes.rows[0].actor_user_id, null, 'External operator must NOT attribute action to target user')
    assert.equal(auditRes.rows[0].actor_type, 'operator')
    assert.equal(auditRes.rows[0].operator_id, 'sec-operator-99')
    assert.equal(auditRes.rows[0].outcome, 'success')

    // Clean up test user
    await adminPool.query(`delete from ${alpha.schemaName}.user_account where user_id = $1`, [userId])
  })

  test('concurrent last-owner demotions are serialized by advisory lock and cannot remove all active owners', async () => {
    // Set up 2 active owners
    const owner2Username = `owner2_${crypto.randomBytes(4).toString('hex')}`
    const ownerRole = (await adminPool.query(
      `select role_id from ${alpha.schemaName}.role_definition where role_code = 'tenant_owner'`,
    )).rows[0]

    const user1 = (await adminPool.query(
      `select ua.user_id::text, ua.username
         from ${alpha.schemaName}.user_account ua
         join ${alpha.schemaName}.role_assignment ra on ra.user_id = ua.user_id
        where ra.role_id = $1 and ua.account_status = 'active'
        limit 1`,
      [ownerRole.role_id],
    )).rows[0]
    assert.ok(user1)

    const insertRes = await adminPool.query(
      `insert into ${alpha.schemaName}.user_account (username, display_name, email_normalized, account_status)
       values ($1, 'Owner Two', lower($2), 'active')
       returning user_id::text`,
      [owner2Username, `${owner2Username}@example.com`],
    )
    const user2Id = insertRes.rows[0].user_id
    await adminPool.query(
      `insert into ${alpha.schemaName}.role_assignment (user_id, role_id) values ($1, $2)`,
      [user2Id, ownerRole.role_id],
    )

    // Two independent connections simultaneously trying to demote both owners
    const clientA = await adminPool.connect()
    const clientB = await adminPool.connect()

    let errorA = null
    let errorB = null

    try {
      const attemptDemote = async (client, targetId) => {
        await client.query('begin')
        await client.query(`set search_path = ${schemaName}, pg_catalog`)
        try {
          await assertNotDemotingLastOwner(client, schemaName, targetId)
          // Demote targetId
          await client.query(
            `delete from ${alpha.schemaName}.role_assignment where user_id = $1 and role_id = $2`,
            [targetId, ownerRole.role_id],
          )
          await client.query('commit')
          return 'committed'
        } catch (err) {
          await client.query('rollback').catch(() => {})
          throw err
        }
      }

      const [resA, resB] = await Promise.allSettled([
        attemptDemote(clientA, user1.user_id),
        attemptDemote(clientB, user2Id),
      ])

      const committedCount = [resA, resB].filter((r) => r.status === 'fulfilled').length
      const rejectedCount = [resA, resB].filter((r) => r.status === 'rejected').length

      // Exactly ONE must commit and ONE must reject with last owner invariant error!
      assert.equal(committedCount, 1, 'Only one concurrent demotion can commit')
      assert.equal(rejectedCount, 1, 'The other concurrent demotion must be rejected')

      const rejectedError = resA.status === 'rejected' ? resA.reason : resB.reason
      assert.match(rejectedError.message, /must retain at least one active tenant_owner/)

      // Verify at least one active owner remains in the database
      const remaining = await adminPool.query(
        `select count(distinct ra.user_id)::int as count
           from ${alpha.schemaName}.role_assignment ra
           join ${alpha.schemaName}.user_account ua on ua.user_id = ra.user_id
          where ra.role_id = $1 and ua.account_status = 'active'`,
        [ownerRole.role_id],
      )
      assert.ok(Number(remaining.rows[0].count) >= 1)
    } finally {
      clientA.release()
      clientB.release()
      await adminPool.query(`delete from ${alpha.schemaName}.user_account where user_id = $1`, [user2Id]).catch(() => {})
    }
  })
})
