import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { createServer } from '../../backend/tenant/dist/server.js'
import { testTenants } from '../helpers/fixture.mjs'

const { alpha, beta } = testTenants().tenants

assert.ok(process.env.TENANT_REGISTRY_DATABASE_URL, 'TENANT_REGISTRY_DATABASE_URL is required for tenant isolation tests')
assert.ok(process.env.TENANT_CREDENTIALS_DIR, 'TENANT_CREDENTIALS_DIR is required for tenant isolation tests')

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')

describe('Integration: Tenant Isolation', () => {
  let app
  let registry
  const credentials = new Map()

  before(async () => {
    registry = new pg.Pool({ connectionString: process.env.TENANT_REGISTRY_DATABASE_URL })
    for (const tenantKey of [alpha.tenantKey, beta.tenantKey]) {
      const row = (await registry.query(
        'select tenant_id::text, credential_ref from platform.tenant_registry where tenant_key = $1',
        [tenantKey],
      )).rows[0]
      assert.ok(row, `${tenantKey} must exist for the live isolation test`)
      const credential = JSON.parse(
        await readFile(`${process.env.TENANT_CREDENTIALS_DIR}/${row.credential_ref}.json`, 'utf8'),
      )
      credentials.set(tenantKey, { ...credential, tenantId: row.tenant_id })
    }
    app = await createServer()
  })

  after(async () => {
    if (app) await app.close()
    if (registry) await registry.end()
  })

  test('hostname bootstrap returns only the matching tenant', async () => {
    const first = await app.inject({ method: 'GET', url: '/api/tenant/bootstrap', headers: { host: `${alpha.host}` } })
    const second = await app.inject({ method: 'GET', url: '/api/tenant/bootstrap', headers: { host: `${beta.host}` } })
    const unknown = await app.inject({ method: 'GET', url: '/api/tenant/bootstrap', headers: { host: `unknown-test.${alpha.host.split('.').slice(1).join('.')}` } })
    assert.equal(JSON.parse(first.payload).tenant.tenantId, alpha.tenantKey)
    assert.equal(JSON.parse(second.payload).tenant.tenantId, beta.tenantKey)
    assert.equal(unknown.statusCode, 404)
    assert.equal(first.payload.includes(beta.tenantKey), false)
    assert.equal(second.payload.includes(alpha.tenantKey), false)
  })

  test('each database role is denied the other tenant schema', async () => {
    for (const [tenantKey, credential] of credentials) {
      const db = new pg.Client({
        host: credential.host,
        port: credential.port,
        database: credential.database,
        user: credential.loginRole,
        password: credential.password,
      })
      await db.connect()
      try {
        await db.query('begin')
        await db.query(`set local role "${credential.dbRole}"`)
        await db.query(`set local search_path="${credential.schemaName}",pg_catalog`)
        await db.query(`select set_config('app.tenant_id', $1, true)`, [credential.tenantId])
        const context = (await db.query('select current_user, current_schema()')).rows[0]
        assert.equal(context.current_user, credential.dbRole)
        assert.equal(context.current_schema, credential.schemaName)

        const other = credential.schemaName === alpha.schemaName ? beta.schemaName : alpha.schemaName
        // Test cross-tenant SELECT while elevated runtime role is active
        await db.query('savepoint sp_select')
        await assert.rejects(db.query(`select 1 from ${other}.user_account limit 1`), { code: '42501' }, `${tenantKey} select`)
        await db.query('rollback to savepoint sp_select')

        // Test cross-tenant INSERT while elevated runtime role is active
        await db.query('savepoint sp_insert')
        await assert.rejects(
          db.query(`insert into ${other}.user_account (username, display_name, email_normalized) values ('probe', 'probe', 'probe@test')`),
          { code: '42501' },
          `${tenantKey} insert`,
        )
        await db.query('rollback to savepoint sp_insert')

        // Test SET ROLE privilege escalation while elevated runtime role is active
        await db.query('savepoint sp_set_role')
        await assert.rejects(
          db.query(`set role "${other === alpha.schemaName ? alpha.dbRole : beta.dbRole}"`),
          { code: '42501' },
          `${tenantKey} set role other`,
        )
        await db.query('rollback to savepoint sp_set_role')

        await db.query('savepoint sp_metadata')
        await assert.rejects(
          db.query(`update schema_metadata set tenant_id = '00000000-0000-4000-8000-000000000199' where singleton = true`),
          { code: '42501' },
          `${tenantKey} metadata identity update`,
        )
        await db.query('rollback to savepoint sp_metadata')

        await db.query('rollback')
      } finally {
        await db.end()
      }
    }
  })

  test('FORCE RLS requires the matching transaction tenant context', async () => {
    const credential = credentials.get(alpha.tenantKey)
    const db = new pg.Pool({
      host: credential.host,
      port: credential.port,
      database: credential.database,
      user: credential.loginRole,
      password: credential.password,
    })
    const client = await db.connect()
    try {
      await client.query('begin')
      await client.query(`set local role "${credential.dbRole}"`)
      await client.query(`set local search_path="${credential.schemaName}",pg_catalog`)
      await client.query(`select set_config('app.tenant_id', '', true)`)
      const withoutContext = await client.query('select count(*)::int as count from user_account')
      assert.equal(withoutContext.rows[0].count, 0)

      await client.query(`select set_config('app.tenant_id', $1, true)`, ['00000000-0000-4000-8000-000000000199'])
      const wrongContext = await client.query('select count(*)::int as count from user_account')
      assert.equal(wrongContext.rows[0].count, 0)
      await client.query('savepoint sp_wrong_context_insert')
      await assert.rejects(
        client.query(
          `insert into user_account (username, display_name, email_normalized)
           values ('rls-wrong-context', 'RLS wrong context', 'rls-wrong-context@example.com')`,
        ),
        { code: '42501' },
      )
      await client.query('rollback to savepoint sp_wrong_context_insert')

      await client.query(`select set_config('app.tenant_id', $1, true)`, [credential.tenantId])
      const matchingContext = await client.query('select count(*)::int as count from user_account')
      assert.ok(matchingContext.rows[0].count > 0)
      await client.query('rollback')
    } finally {
      client.release()
      await db.end()
    }
  })

  test('a session from the first tenant is unauthenticated on the second', async () => {
    const credential = credentials.get(alpha.tenantKey)
    const db = new pg.Pool({
      host: credential.host,
      port: credential.port,
      database: credential.database,
      user: credential.loginRole,
      password: credential.password,
    })
    const client = await db.connect()
    let user
    try {
      await client.query('begin')
      await client.query(`set local role "${credential.dbRole}"`)
      await client.query(`set local search_path="${credential.schemaName}",pg_catalog`)
      await client.query(`select set_config('app.tenant_id', $1, true)`, [credential.tenantId])
      user = (await client.query('select user_id::text from user_account order by created_at limit 1')).rows[0]
      await client.query('commit')
    } finally {
      client.release()
    }
    assert.ok(user)
    const token = crypto.randomBytes(32).toString('base64url')
    const tokenHash = sha256(token)
    try {
      const insertClient = await db.connect()
      try {
        await insertClient.query('begin')
        await insertClient.query(`select set_config('app.tenant_id', $1, true)`, [credential.tenantId])
        await insertClient.query(
          `insert into ${alpha.schemaName}.user_session (tenant_id,user_id,token_hash,csrf_hash,expires_at) values ($1,$2,$3,$4,now()+interval '5 minutes')`,
          [credential.tenantId, user.user_id, tokenHash, sha256('integration-csrf')],
        )
        await insertClient.query('commit')
      } finally {
        insertClient.release()
      }
      const cookie = `__Host-tenant_session=${token}`
      const first = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/auth/session', headers: { host: `${alpha.host}`, cookie } })).payload)
      const second = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/auth/session', headers: { host: `${beta.host}`, cookie } })).payload)
      assert.equal(first.authenticated, true)
      assert.equal(first.tenantId, alpha.tenantKey)
      assert.equal(second.authenticated, false)
      assert.equal(second.tenantId, beta.tenantKey)
    } finally {
      const cleanupClient = await db.connect()
      try {
        await cleanupClient.query('begin')
        await cleanupClient.query(`select set_config('app.tenant_id', $1, true)`, [credential.tenantId])
        await cleanupClient.query(`delete from ${alpha.schemaName}.user_session where token_hash=$1`, [tokenHash])
        await cleanupClient.query('commit')
      } finally {
        cleanupClient.release()
      }
      await db.end()
    }
  })
})
