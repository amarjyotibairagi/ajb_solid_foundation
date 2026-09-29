import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import pg, { type Pool, type PoolClient } from 'pg'
import {
  externalPostgresConfig,
  integrationSecretAad,
  LocalObjectStore,
  localTenantStorageRoot,
  normalizePostgresCredentials,
  normalizePostgresSettings,
  normalizeS3Credentials,
  normalizeS3Settings,
  objectKeyFor,
  S3ObjectStore,
  SecretBox,
  type EndpointPolicy,
  type ObjectStore,
  type PostgresCredentials,
  type PostgresSettings,
} from '@skeleton/server-kit'
import {
  applyTenantAccessManifest,
  applyTenantMigrationsForSchema,
  discoverTenantMigrations,
  loadTenantAccessManifest,
  tenantBaselineSql,
  type TenantAccessManifest,
  type TenantMigration,
} from './tenant-migrations.js'

// Data operations shared by the provisioning worker and scripts: schema
// upgrades, moving tenant data between the VDS and a tenant-supplied
// PostgreSQL database, and moving stored objects between storage backends.

const identifierPattern = /^[a-z][a-z0-9_]{2,62}$/
const quote = (identifier: string) => {
  if (!identifierPattern.test(identifier)) throw new Error(`Unsafe identifier: ${identifier}`)
  return `"${identifier}"`
}

export type TenantRow = {
  tenant_id: string
  tenant_key: string
  schema_identifier: string
  db_role: string
  login_role: string
  data_integration_id: string | null
  storage_integration_id: string | null
}

export type DataPlacement =
  | { kind: 'vds'; schemaName: string; runtimeRole: string; loginRole: string }
  | { kind: 'external'; integrationId: string; settings: PostgresSettings; credentials: PostgresCredentials }

/** Runs a callback as the provisioner (platform schema access). */
export async function asProvisioner<T>(pool: Pool, callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query('set local role tenant_provisioner')
    await client.query('set local search_path = platform, pg_catalog')
    const result = await callback(client)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

export async function endpointPolicy(pool: Pool): Promise<EndpointPolicy> {
  const values = await asProvisioner(pool, async (client) =>
    (await client.query<{ config: Record<string, unknown> }>('select platform.resolve_platform_config() as config')).rows[0]?.config ?? {},
  )
  return {
    allowPrivateEndpoints: values['integration.allow_private_endpoints'] === true,
    allowInsecureTransport: values['integration.allow_insecure_transport'] === true,
  }
}

type IntegrationRow = { integration_id: string; tenant_id: string; kind: string; provider: string; settings: unknown; secret_ciphertext: string }

export async function loadIntegration(pool: Pool, tenantId: string, integrationId: string): Promise<IntegrationRow> {
  const row = await asProvisioner(pool, async (client) =>
    (await client.query<IntegrationRow>(
      `select integration_id::text, tenant_id::text, kind, provider, settings, secret_ciphertext
         from platform.tenant_integration where integration_id = $1 and tenant_id = $2`,
      [integrationId, tenantId],
    )).rows[0],
  )
  if (!row) throw new Error('Integration not found for this tenant.')
  return row
}

function secretBox(): SecretBox {
  const box = SecretBox.fromEnvironment()
  if (!box) throw new Error('INTEGRATION_SECRET_KEY is not configured; tenant integrations cannot be used.')
  return box
}

export async function databasePlacement(pool: Pool, tenant: TenantRow, integrationId: string | null): Promise<DataPlacement> {
  if (!integrationId) {
    return { kind: 'vds', schemaName: tenant.schema_identifier, runtimeRole: tenant.db_role, loginRole: tenant.login_role }
  }
  const row = await loadIntegration(pool, tenant.tenant_id, integrationId)
  if (row.kind !== 'database') throw new Error('Integration is not a database.')
  const secret = JSON.parse(secretBox().open(row.secret_ciphertext, integrationSecretAad(tenant.tenant_id, row.integration_id, row.kind)))
  return {
    kind: 'external',
    integrationId,
    settings: normalizePostgresSettings(row.settings),
    credentials: normalizePostgresCredentials(secret),
  }
}

export function placementSchema(placement: DataPlacement): string {
  return placement.kind === 'vds' ? placement.schemaName : placement.settings.schema
}

/**
 * One transaction against the tenant's data wherever it lives, with the
 * tenant context (search_path, app.tenant_id) that forced RLS requires.
 * VDS: provisioner connection as the schema owner. External: a direct,
 * policy-checked connection as the tenant-supplied user.
 */
export async function withPlacement<T>(
  pool: Pool,
  placement: DataPlacement,
  tenantId: string,
  callback: (client: PoolClient | pg.Client) => Promise<T>,
  options: { readOnly?: boolean; skipSchemaContext?: boolean } = {},
): Promise<T> {
  const schema = quote(placementSchema(placement))
  let client: PoolClient | pg.Client
  let release: () => Promise<void>
  if (placement.kind === 'vds') {
    const pooled = await pool.connect()
    client = pooled
    release = async () => pooled.release()
  } else {
    const external = new pg.Client(await externalPostgresConfig(placement.settings, placement.credentials, await endpointPolicy(pool), 'skeleton-provisioner'))
    await external.connect()
    client = external
    release = () => external.end()
  }
  try {
    await client.query(options.readOnly ? 'begin isolation level repeatable read read only' : 'begin')
    if (placement.kind === 'vds') await client.query('set local role tenant_template_owner')
    if (!options.skipSchemaContext) await client.query(`set local search_path = ${schema}, pg_catalog`)
    await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId])
    const result = await callback(client)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    throw error
  } finally {
    await release()
  }
}

export async function schemaVersion(client: PoolClient | pg.Client): Promise<number> {
  const result = await client.query<{ schema_version: number }>('select schema_version from schema_metadata where singleton = true')
  return Number(result.rows[0]?.schema_version || 0)
}

/**
 * Brings a placement's schema to the latest tenant version and resets its
 * access rules. Creates the schema and baseline first on an empty target.
 */
export async function upgradePlacement(
  pool: Pool,
  placement: DataPlacement,
  tenantId: string,
  resources: { migrations?: TenantMigration[]; manifest?: TenantAccessManifest } = {},
): Promise<{ version: number; applied: string[] }> {
  const migrations = resources.migrations ?? (await discoverTenantMigrations())
  const manifest = resources.manifest ?? (await loadTenantAccessManifest())
  const schemaName = placementSchema(placement)
  return withPlacement(pool, placement, tenantId, async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`tenant-migration:${schemaName}`])
    if (placement.kind === 'external') {
      await client.query(`create schema if not exists ${quote(schemaName)}`)
      await client.query(`set local search_path = ${quote(schemaName)}, pg_catalog`)
      const hasMetadata = (await client.query<{ present: boolean }>(
        `select exists (select 1 from pg_class where relnamespace = $1::regnamespace and relname = 'schema_metadata') as present`,
        [schemaName],
      )).rows[0]?.present
      if (!hasMetadata) await client.query(await tenantBaselineSql())
    }
    const result = await applyTenantMigrationsForSchema(client, schemaName, migrations, {
      apply: true,
      tenantId,
      ownerRole: placement.kind === 'vds' ? 'tenant_template_owner' : null,
    })
    await applyTenantAccessManifest(client, manifest, {
      schemaName,
      runtimeRole: placement.kind === 'vds' ? placement.runtimeRole : null,
      loginRole: placement.kind === 'vds' ? placement.loginRole : null,
    })
    return { version: result.currentVersion, applied: result.applied || [] }
  }, { skipSchemaContext: placement.kind === 'external' })
}

/** Data tables in dependency order (parents first), from the manifest and FK graph. */
async function copyOrder(client: PoolClient | pg.Client, schemaName: string, manifest: TenantAccessManifest): Promise<string[]> {
  const tables = Object.entries(manifest.relations).filter(([, access]) => access.rls).map(([name]) => name)
  const edges = (await client.query<{ child: string; parent: string }>(
    `select c.relname as child, p.relname as parent
       from pg_constraint k
       join pg_class c on c.oid = k.conrelid
       join pg_class p on p.oid = k.confrelid
      where k.contype = 'f' and k.connamespace = $1::regnamespace and c.oid <> p.oid`,
    [schemaName],
  )).rows
  const ordered: string[] = []
  const visiting = new Set<string>()
  const visit = (table: string) => {
    if (ordered.includes(table)) return
    if (visiting.has(table)) throw new Error(`Foreign-key cycle involving ${table}.`)
    visiting.add(table)
    for (const edge of edges) if (edge.child === table && tables.includes(edge.parent)) visit(edge.parent)
    visiting.delete(table)
    ordered.push(table)
  }
  for (const table of tables) visit(table)
  return ordered
}

/**
 * Replaces all tenant data in the target with a consistent snapshot of the
 * source, table by table, and verifies row counts before committing. Both
 * placements must be at the same schema version. The source is only read.
 */
export async function copyTenantData(
  pool: Pool,
  source: DataPlacement,
  target: DataPlacement,
  tenantId: string,
  manifest?: TenantAccessManifest,
): Promise<Record<string, number>> {
  const accessManifest = manifest ?? (await loadTenantAccessManifest())
  return withPlacement(pool, source, tenantId, async (from) =>
    withPlacement(pool, target, tenantId, async (to) => {
      const [sourceVersion, targetVersion] = [await schemaVersion(from), await schemaVersion(to)]
      if (sourceVersion !== targetVersion) {
        throw new Error(`Schema versions differ (source ${sourceVersion}, target ${targetVersion}); upgrade both first.`)
      }
      const tables = await copyOrder(from, placementSchema(source), accessManifest)
      await to.query(`truncate table ${tables.map(quote).join(', ')}`)
      const counts: Record<string, number> = {}
      for (const table of tables) {
        const cursor = `copy_${table}`
        await from.query(`declare ${quote(cursor)} no scroll cursor for select to_jsonb(t)::text as row from ${quote(table)} t`)
        let copied = 0
        for (;;) {
          const batch = await from.query<{ row: string }>(`fetch 500 from ${quote(cursor)}`)
          if (!batch.rows.length) break
          await to.query(
            `insert into ${quote(table)} select * from jsonb_populate_recordset(null::${quote(table)}, $1::jsonb)`,
            [`[${batch.rows.map((item) => item.row).join(',')}]`],
          )
          copied += batch.rows.length
        }
        await from.query(`close ${quote(cursor)}`)
        const targetCount = Number((await to.query<{ n: string }>(`select count(*) as n from ${quote(table)}`)).rows[0]?.n)
        if (targetCount !== copied) throw new Error(`Row count mismatch for ${table}: copied ${copied}, target has ${targetCount}.`)
        counts[table] = copied
      }
      return counts
    }),
  { readOnly: true })
}

/** Removes all rows from a placement's tenant tables, keeping structure. */
export async function purgeTenantData(pool: Pool, placement: DataPlacement, tenantId: string): Promise<void> {
  const manifest = await loadTenantAccessManifest()
  await withPlacement(pool, placement, tenantId, async (client) => {
    const tables = Object.entries(manifest.relations).filter(([, access]) => access.rls).map(([name]) => name)
    await client.query(`truncate table ${tables.map(quote).join(', ')}`)
  })
}

// ---------------------------------------------------------------------------
// Object storage
// ---------------------------------------------------------------------------

export function storageRoot(): string {
  const configured = process.env.STORAGE_ROOT?.trim()
  if (configured) return configured
  if (process.env.NODE_ENV === 'production') throw new Error('STORAGE_ROOT must be set in production.')
  return path.resolve(new URL('../../..', import.meta.url).pathname, '.data/storage')
}

export async function openObjectStore(pool: Pool, tenant: Pick<TenantRow, 'tenant_id' | 'tenant_key'>, storageRef: string): Promise<ObjectStore> {
  if (storageRef === 'vds') return new LocalObjectStore(localTenantStorageRoot(storageRoot(), tenant.tenant_key))
  const row = await loadIntegration(pool, tenant.tenant_id, storageRef)
  if (row.kind !== 'storage') throw new Error('Integration is not a storage backend.')
  const secret = JSON.parse(secretBox().open(row.secret_ciphertext, integrationSecretAad(tenant.tenant_id, row.integration_id, row.kind)))
  return new S3ObjectStore(normalizeS3Settings(row.settings), normalizeS3Credentials(secret), await endpointPolicy(pool))
}

/** Moves every object not on the active backend onto it, one object at a time. */
export async function relocateStoredObjects(
  pool: Pool,
  tenant: TenantRow,
  placement: DataPlacement,
  onProgress?: () => Promise<void>,
): Promise<{ moved: number }> {
  const activeRef = tenant.storage_integration_id ?? 'vds'
  const target = await openObjectStore(pool, tenant, activeRef)
  const sources = new Map<string, ObjectStore>()
  let moved = 0
  for (;;) {
    const batch = await withPlacement(pool, placement, tenant.tenant_id, async (client) =>
      (await client.query<{ object_id: string; storage_ref: string; object_key: string; content_type: string; sha256: string }>(
        `select object_id::text, storage_ref, object_key, content_type, sha256
           from stored_object where storage_ref <> $1 order by created_at limit 50`,
        [activeRef],
      )).rows,
    )
    if (!batch.length) break
    for (const object of batch) {
      let source = sources.get(object.storage_ref)
      if (!source) {
        source = await openObjectStore(pool, tenant, object.storage_ref)
        sources.set(object.storage_ref, source)
      }
      const read = await source.get(object.object_key)
      const chunks: Buffer[] = []
      for await (const chunk of read.body) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks)
      if (createHash('sha256').update(body).digest('hex') !== object.sha256) {
        throw new Error(`Stored object ${object.object_id} failed its checksum on the source backend.`)
      }
      const key = objectKeyFor(object.object_id)
      await target.put(key, body, object.content_type)
      await withPlacement(pool, placement, tenant.tenant_id, (client) =>
        client.query('update stored_object set storage_ref = $1, object_key = $2 where object_id = $3 and storage_ref = $4', [
          activeRef, key, object.object_id, object.storage_ref,
        ]),
      )
      await source.delete(object.object_key).catch(() => undefined)
      moved += 1
    }
    if (onProgress) await onProgress()
  }
  return { moved }
}

export async function removeLocalTenantStorage(tenantKey: string): Promise<void> {
  const root = path.resolve(storageRoot())
  const directory = path.resolve(localTenantStorageRoot(root, tenantKey))
  if (!directory.startsWith(`${root}${path.sep}`)) throw new Error('Refusing to remove storage outside STORAGE_ROOT.')
  await rm(directory, { recursive: true, force: true })
}
