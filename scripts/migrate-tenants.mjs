import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import pg from 'pg'
import {
  applyTenantMigrationsForSchema,
  discoverTenantMigrations,
  loadTenantAccessManifest,
} from '../backend/provisioner/dist/tenant-migrations.js'
import {
  asProvisioner,
  databasePlacement,
  placementSchema,
  upgradePlacement,
  withPlacement,
} from '../backend/provisioner/dist/tenant-operations.js'

dotenv.config({ path: path.resolve(fileURLToPath(new URL('..', import.meta.url)), '.env'), quiet: true })

const apply = process.argv.includes('--apply')
const tenantArgument = process.argv.find((item) => item.startsWith('--tenant='))?.slice('--tenant='.length)
const concurrencyArgument = process.argv.find((item) => item.startsWith('--concurrency='))?.slice('--concurrency='.length)
const concurrency = Math.min(10, Math.max(1, Number(concurrencyArgument || 2)))
const databaseUrl = process.env.TENANT_PROVISIONER_DATABASE_URL
const migrationsDirectory = path.resolve(
  fileURLToPath(new URL('..', import.meta.url)),
  'database/migrations/tenant/versions',
)
const identifierPattern = /^[a-z][a-z0-9_]{2,62}$/

if (!databaseUrl) throw new Error('TENANT_PROVISIONER_DATABASE_URL is required.')
if (!Number.isInteger(concurrency)) throw new Error('Concurrency must be an integer between 1 and 10.')

const migrations = await discoverTenantMigrations(migrationsDirectory)
const accessManifest = await loadTenantAccessManifest()

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: concurrency + 1,
  connectionTimeoutMillis: 5_000,
  query_timeout: 120_000,
  statement_timeout: 120_000,
  lock_timeout: 10_000,
})

const registryClient = await pool.connect()
let tenants
try {
  await registryClient.query('begin')
  await registryClient.query('set local role tenant_provisioner')
  tenants = (await registryClient.query(
    `select tenant_id::text, tenant_key, schema_identifier, db_role, login_role,
            data_integration_id::text, storage_integration_id::text
       from platform.tenant_registry
      where lifecycle_status in ('active', 'migration_failed')
        and ($1::text is null or tenant_key = $1)
      order by tenant_key`,
    [tenantArgument || null],
  )).rows
  await registryClient.query('rollback')
} catch (error) {
  await registryClient.query('rollback').catch(() => undefined)
  throw error
} finally {
  registryClient.release()
}

if (tenantArgument && tenants.length !== 1) throw new Error(`Active or failed tenant not found: ${tenantArgument}`)

// One code path for every placement: a VDS schema (grants + RLS from the
// access manifest) or a tenant-supplied database (RLS only). The same
// functions run when an operator starts an upgrade from the admin panel.
async function migrateTenant(tenant) {
  if (!identifierPattern.test(tenant.schema_identifier)) throw new Error(`Unsafe schema identifier for ${tenant.tenant_key}.`)
  try {
    const placement = await databasePlacement(pool, tenant, tenant.data_integration_id)
    if (!apply) {
      const result = await withPlacement(pool, placement, tenant.tenant_id, (client) =>
        applyTenantMigrationsForSchema(client, placementSchema(placement), migrations, {
          apply: false,
          tenantId: tenant.tenant_id,
          ownerRole: placement.kind === 'vds' ? 'tenant_template_owner' : null,
        }),
      )
      return { tenant: tenant.tenant_key, placement: placement.kind, current: result.currentVersion, applied: [], pending: result.pending || [] }
    }
    const result = await upgradePlacement(pool, placement, tenant.tenant_id, { migrations, manifest: accessManifest })
    await asProvisioner(pool, (client) =>
      client.query(
        `update platform.tenant_registry
            set schema_version = $1, lifecycle_status = 'active', last_error_code = null, last_error_at = null
          where tenant_id = $2 and lifecycle_status in ('active', 'migration_failed')`,
        [result.version, tenant.tenant_id],
      ),
    )
    return { tenant: tenant.tenant_key, placement: placement.kind, current: result.version, applied: result.applied, pending: [] }
  } catch (error) {
    await asProvisioner(pool, (client) =>
      client.query(
        `update platform.tenant_registry
            set lifecycle_status = 'migration_failed', last_error_code = 'MigrationError', last_error_at = now()
          where tenant_id = $1 and lifecycle_status = 'active'`,
        [tenant.tenant_id],
      ),
    ).catch(() => undefined)
    throw error
  }
}

const results = []
let cursor = 0
await Promise.all(Array.from({ length: Math.min(concurrency, tenants.length) }, async () => {
  while (cursor < tenants.length) {
    const tenant = tenants[cursor]
    cursor += 1
    results.push(await migrateTenant(tenant))
  }
}))

await pool.end()
console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', tenantCount: tenants.length, results }, null, 2))
