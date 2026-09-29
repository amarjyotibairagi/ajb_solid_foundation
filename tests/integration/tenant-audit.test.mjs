import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import crypto from 'node:crypto'
import pg from 'pg'
import { tenantLoginUrl, testTenants } from '../helpers/fixture.mjs'

const { alpha } = testTenants().tenants

const adminUrl = process.env.DATABASE_ADMIN_URL || process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
assert.ok(adminUrl, 'DATABASE_ADMIN_URL or TEST_DATABASE_URL is required')

describe('Integration: Tenant Audit Events and Append-Only Invariants', () => {
  let adminPool
  const tenantSchema = `${alpha.schemaName}`
  const tenantKey = alpha.tenantKey

  before(async () => {
    adminPool = new pg.Pool({ connectionString: adminUrl })
  })

  after(async () => {
    if (adminPool) await adminPool.end()
  })

  test('P05.1 audit_event table rejects UPDATE and DELETE for runtime roles', async () => {
    const runtimePool = new pg.Pool({ connectionString: tenantLoginUrl(alpha) })

    try {
      const client = await runtimePool.connect()
      try {
        await client.query('begin')
        await client.query(`set local role ${alpha.dbRole}`)
        await client.query(`set local search_path = ${tenantSchema}, pg_catalog`)

        // Attempting to UPDATE audit_event must fail
        await assert.rejects(
          async () => {
            await client.query(`update audit_event set outcome = 'success'`)
          },
          /permission denied for table audit_event/,
        )
        await client.query('rollback')

        await client.query('begin')
        await client.query(`set local role ${alpha.dbRole}`)
        await client.query(`set local search_path = ${tenantSchema}, pg_catalog`)

        // Attempting to DELETE audit_event must fail
        await assert.rejects(
          async () => {
            await client.query(`delete from audit_event`)
          },
          /permission denied for table audit_event/,
        )

        await client.query('rollback')
      } finally {
        client.release()
      }
    } finally {
      await runtimePool.end()
    }
  })

  test('P05.1 audit_event enforces check constraint on outcome and accepts denied', async () => {
    const client = await adminPool.connect()
    try {
      await client.query('begin')
      await client.query(`set local search_path = ${tenantSchema}, pg_catalog`)

      const corrId = crypto.randomUUID()

      // Outcome 'denied' is valid
      await client.query(
        `insert into audit_event (action, resource_type, outcome, correlation_id, reason)
         values ('auth:test_denial', 'session', 'denied', $1, 'Test denial')`,
        [corrId],
      )

      const res = await client.query(
        `select action, outcome, reason from audit_event where correlation_id = $1`,
        [corrId],
      )
      assert.equal(res.rows[0]?.outcome, 'denied')
      assert.equal(res.rows[0]?.action, 'auth:test_denial')

      // Outcome 'deny' violates check constraint
      await assert.rejects(
        async () => {
          await client.query(
            `insert into audit_event (action, resource_type, outcome, correlation_id)
             values ('auth:test_invalid', 'session', 'deny', $1)`,
            [crypto.randomUUID()],
          )
        },
        /violates check constraint/,
      )

      await client.query('rollback')
    } finally {
      client.release()
    }
  })

  test('P05.1 records audit event with operator attribution and reason', async () => {
    const client = await adminPool.connect()
    try {
      await client.query('begin')
      await client.query(`set local search_path = ${tenantSchema}, pg_catalog`)

      const corrId = crypto.randomUUID()
      await client.query(
        `insert into audit_event (actor_user_id, actor_type, operator_id, action, resource_type, outcome, correlation_id, reason)
         values (null, 'operator', 'test-operator', 'operator:reset_password', 'user_account', 'success', $1, 'Manual operator reset')`,
        [corrId],
      )

      const res = await client.query(
        `select actor_user_id, actor_type, operator_id, action, outcome, reason
           from audit_event where correlation_id = $1`,
        [corrId],
      )
      assert.equal(res.rows[0]?.actor_user_id, null)
      assert.equal(res.rows[0]?.actor_type, 'operator')
      assert.equal(res.rows[0]?.operator_id, 'test-operator')
      assert.equal(res.rows[0]?.action, 'operator:reset_password')
      assert.equal(res.rows[0]?.outcome, 'success')
      assert.equal(res.rows[0]?.reason, 'Manual operator reset')

      await client.query('rollback')
    } finally {
      client.release()
    }
  })
})
