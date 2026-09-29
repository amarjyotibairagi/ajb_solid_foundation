import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import { grantDelegation, revokeDelegation } from '../../backend/tenant/dist/delegated-capabilities.js'
import { tenantLoginUrl, testTenants } from '../helpers/fixture.mjs'

const adminUrl = process.env.DATABASE_ADMIN_URL || process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
assert.ok(adminUrl, 'DATABASE_ADMIN_URL or TEST_DATABASE_URL is required')
const { alpha } = testTenants().tenants

describe('Integration: Tenant delegated capabilities', () => {
  let adminPool
  let runtimePool
  let temporaryManagerId
  let tenantId

  before(async () => {
    adminPool = new pg.Pool({ connectionString: adminUrl })
    runtimePool = new pg.Pool({ connectionString: tenantLoginUrl(alpha) })
    tenantId = (await adminPool.query(`select tenant_id::text from ${alpha.schemaName}.schema_metadata where singleton = true`)).rows[0]?.tenant_id
    assert.match(tenantId, /^[0-9a-f-]{36}$/i)

    const managerRole = (await adminPool.query(
      `select role_id from ${alpha.schemaName}.role_definition where role_code = 'tenant_manager'`,
    )).rows[0]
    const username = `delegation_${crypto.randomBytes(5).toString('hex')}`
    temporaryManagerId = (await adminPool.query(
      `insert into ${alpha.schemaName}.user_account (username, display_name, email_normalized, account_status)
       values ($1, 'Delegation Integration Manager', $2, 'active')
       returning user_id::text`,
      [username, `${username}@example.com`],
    )).rows[0].user_id
    await adminPool.query(
      `insert into ${alpha.schemaName}.role_assignment (user_id, role_id) values ($1, $2)`,
      [temporaryManagerId, managerRole.role_id],
    )
  })

  after(async () => {
    if (temporaryManagerId && adminPool) {
      await adminPool.query(`delete from ${alpha.schemaName}.user_account where user_id = $1`, [temporaryManagerId])
    }
    if (runtimePool) await runtimePool.end()
    if (adminPool) await adminPool.end()
  })

  test('runtime role can grant and revoke only an allow-listed capability', async () => {
    const actor = (await adminPool.query(
      `select ua.user_id::text
         from ${alpha.schemaName}.user_account ua
         join ${alpha.schemaName}.role_assignment ra on ra.user_id = ua.user_id
         join ${alpha.schemaName}.role_definition rd on rd.role_id = ra.role_id
        where ua.account_status = 'active'
          and rd.role_code in ('tenant_owner', 'tenant_admin')
        order by ua.created_at
        limit 1`,
    )).rows[0]
    assert.ok(actor?.user_id, 'An active tenant administrator is required')

    const client = await runtimePool.connect()
    try {
      await client.query('begin')
      await client.query(`set local role ${alpha.dbRole}`)
      await client.query(`set local search_path = ${alpha.schemaName}, pg_catalog`)
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId])

      const granted = await grantDelegation(client, {
        actorUserId: actor.user_id,
        managerUserId: temporaryManagerId,
        permissionCode: 'tenant.modules.author',
        reason: 'Integration test delegation',
        correlationId: crypto.randomUUID(),
      })
      assert.equal(granted.permissionCode, 'tenant.modules.author')
      assert.equal(granted.granteeUserId, temporaryManagerId)

      const permission = await client.query(
        `select permission_code from capability_delegation
          where delegation_id = $1 and status = 'active'`,
        [granted.delegationId],
      )
      assert.deepEqual(permission.rows, [{ permission_code: 'tenant.modules.author' }])

      const revoked = await revokeDelegation(client, {
        actorUserId: actor.user_id,
        managerUserId: temporaryManagerId,
        delegationId: granted.delegationId,
        reason: 'Integration test cleanup',
        correlationId: crypto.randomUUID(),
      })
      assert.equal(revoked.status, 'revoked')
      await client.query('commit')
    } catch (error) {
      await client.query('rollback').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  })
})
