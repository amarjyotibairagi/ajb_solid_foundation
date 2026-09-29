// Covers the database-level lifecycle invariants added in migration 023 and
// the reconciler that reports on them.
//
// The defect these exist for: a tenant's lifecycle_status could be set to
// 'deleted' by any direct UPDATE, with no check that the tenant's schema, roles
// and credentials had actually been removed. Test tooling did exactly that
// against the production database, leaving a tenant the control plane believed
// was gone whose schema, login role, credential file and PgBouncer entry were
// all still live and usable.

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'

process.env.NODE_ENV = 'test'

const adminDbUrl = process.env.DATABASE_ADMIN_URL || process.env.TEST_DATABASE_URL
assert.ok(adminDbUrl, 'DATABASE_ADMIN_URL is required for tenant lifecycle integrity tests')

const makeTenantKey = () => `T${crypto.randomBytes(10).toString('hex').toUpperCase()}`

describe('Integration: Tenant Lifecycle Integrity', () => {
  let pool
  const createdTenantIds = []

  async function insertTenant({ status = 'provisioning', withSchema = false, withRoles = false } = {}) {
    const tenantId = crypto.randomUUID()
    const tenantKey = makeTenantKey()
    const schema = `tenant_${tenantKey.toLowerCase()}`
    const dbRole = `${schema}_runtime`
    const loginRole = `${schema}_login`

    if (withSchema) await pool.query(`create schema "${schema}"`)
    if (withRoles) {
      await pool.query(`create role "${dbRole}" nologin noinherit`)
      await pool.query(`create role "${loginRole}" login noinherit`)
    }

    await pool.query(
      `insert into platform.tenant_registry
         (tenant_id, tenant_key, schema_identifier, db_role, login_role, credential_ref,
          display_name, identity_scheme, region, lifecycle_status)
       values ($1, $2, $3, $4, $5, $2, 'Lifecycle Integrity Test', 'tenant_key_v1', 'default', $6)`,
      [tenantId, tenantKey, schema, dbRole, loginRole, status],
    )
    createdTenantIds.push({ tenantId, schema, dbRole, loginRole })
    return { tenantId, tenantKey, schema, dbRole, loginRole }
  }

  before(async () => {
    pool = new pg.Pool({ connectionString: adminDbUrl })
  })

  after(async () => {
    for (const { tenantId, schema, dbRole, loginRole } of createdTenantIds) {
      await pool.query('delete from platform.tenant_registry where tenant_id = $1', [tenantId]).catch(() => {})
      await pool.query(`drop schema if exists "${schema}" cascade`).catch(() => {})
      await pool.query(`drop role if exists "${loginRole}"`).catch(() => {})
      await pool.query(`drop role if exists "${dbRole}"`).catch(() => {})
    }
    if (pool) await pool.end()
  })

  test('a tenant cannot be marked deleted while its schema still exists', async () => {
    const tenant = await insertTenant({ status: 'deleting', withSchema: true })
    await assert.rejects(
      pool.query(`update platform.tenant_registry set lifecycle_status = 'deleted' where tenant_id = $1`, [
        tenant.tenantId,
      ]),
      /cannot be marked deleted: schema .* still exists/,
      'the registry must not be able to claim a tenant is gone while its data is reachable',
    )
  })

  test('a tenant cannot be marked deleted while its database roles still exist', async () => {
    const tenant = await insertTenant({ status: 'deleting', withRoles: true })
    await assert.rejects(
      pool.query(`update platform.tenant_registry set lifecycle_status = 'deleted' where tenant_id = $1`, [
        tenant.tenantId,
      ]),
      /cannot be marked deleted: database roles still exist/,
      'a live login role for a deleted tenant is a standing cross-tenant credential',
    )
  })

  test('a tenant with no remaining resources can be marked deleted', async () => {
    const tenant = await insertTenant({ status: 'deleting' })
    await pool.query(`update platform.tenant_registry set lifecycle_status = 'deleted' where tenant_id = $1`, [
      tenant.tenantId,
    ])
    const row = (
      await pool.query('select lifecycle_status from platform.tenant_registry where tenant_id = $1', [tenant.tenantId])
    ).rows[0]
    assert.equal(row.lifecycle_status, 'deleted')
  })

  test('a tenant cannot be marked active without a schema', async () => {
    const tenant = await insertTenant({ status: 'provisioning' })
    await assert.rejects(
      pool.query(`update platform.tenant_registry set lifecycle_status = 'active' where tenant_id = $1`, [
        tenant.tenantId,
      ]),
      /cannot be marked active: schema .* does not exist/,
      'an active registry row with no schema makes every request to that host fail',
    )
  })

  test('a tenant cannot be marked active without its login role', async () => {
    const tenant = await insertTenant({ status: 'provisioning', withSchema: true })
    await assert.rejects(
      pool.query(`update platform.tenant_registry set lifecycle_status = 'active' where tenant_id = $1`, [
        tenant.tenantId,
      ]),
      /cannot be marked active: login role .* does not exist/,
    )
  })

  test('a tenant with schema and roles can be marked active', async () => {
    const tenant = await insertTenant({ status: 'provisioning', withSchema: true, withRoles: true })
    await pool.query(`update platform.tenant_registry set lifecycle_status = 'active' where tenant_id = $1`, [
      tenant.tenantId,
    ])
    const row = (
      await pool.query('select lifecycle_status from platform.tenant_registry where tenant_id = $1', [tenant.tenantId])
    ).rows[0]
    assert.equal(row.lifecycle_status, 'active')
  })

  test('platform_user rejects a non-argon2id password hash', async () => {
    await assert.rejects(
      pool.query(
        `insert into platform.platform_user (username, password_hash, role, display_name, is_active)
         values ($1, $2, 'platform_viewer', 'Legacy Hash', true)`,
        [`legacy.${crypto.randomBytes(4).toString('hex')}`, '$2a$06$ORNUF9tmwoLGoF1Og7QlxeuPVpl1So3mfGWsFNcwDG9uVC7Keyut'],
      ),
      /platform_user_password_hash_format_check/,
      'a cost-6 bcrypt hash on a control-plane account must be impossible to store',
    )
  })
})
