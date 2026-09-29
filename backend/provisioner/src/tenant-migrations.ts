import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import type { PoolClient, Client } from 'pg'

export type TenantMigration = {
  filename: string
  version: number
  sql: string
  checksum: string
}

export type MigrationResult = {
  schemaName: string
  currentVersion: number
  pending: string[]
  applied?: string[]
}

const defaultMigrationsDirectory = path.resolve(
  fileURLToPath(new URL('../../..', import.meta.url)),
  'database/migrations/tenant/versions',
)

const schemaNamePattern = /^[a-z][a-z0-9_]{2,62}$/
const migrationFilePattern = /^(\d{3})_[a-z0-9_]+\.sql$/

export async function discoverTenantMigrations(
  migrationsDirectory = defaultMigrationsDirectory,
): Promise<TenantMigration[]> {
  const entries = await readdir(migrationsDirectory)

  // Check all entries in directory
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    if (!migrationFilePattern.test(entry)) {
      throw new Error(`Unexpected migration file name: ${entry}. Tenant migrations must match ^\\d{3}_[a-z0-9_]+\\.sql$`)
    }
  }

  const migrationFiles = entries
    .filter((entry) => migrationFilePattern.test(entry))
    .map((filename) => {
      const match = migrationFilePattern.exec(filename)!
      return { filename, version: Number(match[1]) }
    })
    .sort((left, right) => left.version - right.version)

  if (migrationFiles.length === 0) {
    throw new Error('No tenant migration files discovered.')
  }

  const first = migrationFiles[0]
  if (!first || first.version !== 1) {
    throw new Error(`Tenant migration sequence must start with version 001 (found: ${first?.filename ?? 'none'}).`)
  }

  for (let index = 1; index < migrationFiles.length; index += 1) {
    const prev = migrationFiles[index - 1]
    const curr = migrationFiles[index]
    if (!prev || !curr) continue
    if (prev.version === curr.version) {
      throw new Error(`Duplicate tenant migration version ${curr.version}: ${prev.filename} and ${curr.filename}.`)
    }
    if (curr.version !== prev.version + 1) {
      throw new Error(
        `Non-contiguous tenant migration sequence: missing version ${String(prev.version + 1).padStart(3, '0')} between ${prev.filename} and ${curr.filename}.`,
      )
    }
  }

  return Promise.all(
    migrationFiles.map(async (item) => {
      const sql = await readFile(path.join(migrationsDirectory, item.filename), 'utf8')
      if (/^\s*\\/m.test(sql) || /\b(begin|commit|rollback)\s*;/i.test(sql)) {
        throw new Error(
          `${item.filename} must contain SQL statements only, without transaction control or psql commands.`,
        )
      }
      const checksum = crypto.createHash('sha256').update(sql).digest('hex')
      return { ...item, sql, checksum }
    }),
  )
}

export async function applyTenantMigrationsForSchema(
  client: PoolClient | Client,
  schemaName: string,
  migrations: TenantMigration[],
  options: { apply?: boolean; tenantId: string; ownerRole?: string | null },
): Promise<MigrationResult> {
  if (!schemaNamePattern.test(schemaName)) {
    throw new Error(`Invalid tenant schema identifier: ${schemaName}. Must match ^[a-z][a-z0-9_]{2,62}$`)
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options.tenantId)) {
    throw new Error('Invalid tenant UUID for schema migration.')
  }

  const quote = (id: string) => `"${id.replace(/"/g, '""')}"`
  const schema = quote(schemaName)

  // VDS schemas are owned by tenant_template_owner. A tenant-supplied database
  // (bring-your-own) has no such role: the connecting user owns the schema.
  const ownerRole = options.ownerRole === undefined ? 'tenant_template_owner' : options.ownerRole
  if (ownerRole) await client.query(`set local role ${quote(ownerRole)}`)
  await client.query(`set local search_path = ${schema}, pg_catalog`)
  await client.query(`select set_config('app.migration_tenant_id', $1, true)`, [options.tenantId])
  await client.query(`select set_config('app.tenant_id', $1, true)`, [options.tenantId])

  // Ensure migration ledger table exists
  await client.query(`
    create table if not exists schema_migration (
      version integer primary key,
      filename text not null,
      checksum text not null,
      applied_at timestamptz not null default now()
    );
  `)

  // Read current version from schema_metadata
  const currentVersionRes = await client.query<{ schema_version: number }>(
    'select schema_version from schema_metadata where singleton = true',
  )
  if (!currentVersionRes.rows[0]) {
    throw new Error(`Schema metadata missing singleton row in schema ${schemaName}.`)
  }
  const currentVersion = Number(currentVersionRes.rows[0].schema_version)

  // Read applied ledger
  let appliedLedgerRes = await client.query<{ version: number; filename: string; checksum: string }>(
    'select version, filename, checksum from schema_migration order by version',
  )

  // Handle legacy schema upgrade: if currentVersion >= 1 and version 1 is not in the ledger
  const hasVersion1 = appliedLedgerRes.rows.some((r) => r.version === 1)
  if (currentVersion >= 1 && !hasVersion1) {
    // Validate required baseline tables exist before backfilling version 1 ledger
    const requiredTables = [
      'user_account',
      'user_identity',
      'role_definition',
      'permission',
      'role_permission',
      'role_assignment',
      'audit_event',
      'schema_metadata',
    ]
    const tablesCheck = await client.query<{ count: string }>(
      `select count(*)::text as count from information_schema.tables
        where table_schema = $1 and table_name = any($2)`,
      [schemaName, requiredTables],
    )
    if (Number(tablesCheck.rows[0]?.count || 0) < requiredTables.length) {
      throw new Error(`Legacy schema ${schemaName} is missing required baseline tables for version 1 backfill.`)
    }

    const baselineMigration = migrations.find((m) => m.version === 1)
    if (!baselineMigration) {
      throw new Error('Migration version 001 is missing from discovered migrations.')
    }

    // Insert real checksum and filename for version 1
    await client.query(
      `insert into schema_migration (version, filename, checksum)
       values ($1, $2, $3)`,
      [baselineMigration.version, baselineMigration.filename, baselineMigration.checksum],
    )

    // Reload applied ledger
    appliedLedgerRes = await client.query<{ version: number; filename: string; checksum: string }>(
      'select version, filename, checksum from schema_migration order by version',
    )
  }

  const appliedMap = new Map(appliedLedgerRes.rows.map((row) => [row.version, row]))
  const maxLedgerVersion = appliedLedgerRes.rows.length > 0
    ? Math.max(...appliedLedgerRes.rows.map((r) => r.version))
    : 0

  // Check for inconsistent state: ledger version > schema metadata
  if (maxLedgerVersion > currentVersion) {
    throw new Error(
      `Inconsistent migration state in ${schemaName}: highest ledger version (${maxLedgerVersion}) is greater than schema_metadata version (${currentVersion}).`,
    )
  }

  // Check for inconsistent state: schema metadata > highest ledger version
  if (currentVersion > maxLedgerVersion) {
    throw new Error(
      `Inconsistent migration state in ${schemaName}: schema_metadata version (${currentVersion}) is greater than highest ledger version (${maxLedgerVersion}).`,
    )
  }

  // Verify all ledger entries have matching migration file with identical filename and checksum
  for (const ledgerRow of appliedLedgerRes.rows) {
    const fileMigration = migrations.find((m) => m.version === ledgerRow.version)
    if (!fileMigration) {
      throw new Error(
        `Migration version ${ledgerRow.version} in schema ${schemaName} ledger is missing from migration files.`,
      )
    }
    if (fileMigration.filename !== ledgerRow.filename) {
      throw new Error(
        `Migration filename mismatch for version ${ledgerRow.version} in ${schemaName}: ledger has ${ledgerRow.filename}, file is ${fileMigration.filename}.`,
      )
    }
    if (fileMigration.checksum !== ledgerRow.checksum) {
      throw new Error(
        `Migration checksum mismatch for ${ledgerRow.filename} in ${schemaName}: recorded ${ledgerRow.checksum}, calculated ${fileMigration.checksum}.`,
      )
    }
  }

  // Check that all migrations <= currentVersion are present in ledger
  for (const migration of migrations) {
    if (migration.version <= currentVersion && !appliedMap.has(migration.version)) {
      throw new Error(
        `Migration version ${migration.version} (${migration.filename}) is at or below current version (${currentVersion}) but missing from ledger in ${schemaName}.`,
      )
    }
  }

  // Find pending migrations (version > currentVersion)
  const pending = migrations.filter((migration) => migration.version > currentVersion)

  if (!options.apply || pending.length === 0) {
    return {
      schemaName,
      currentVersion,
      pending: pending.map((m) => m.filename),
      applied: [],
    }
  }

  const applied: string[] = []
  for (const migration of pending) {
    if (migration.sql.trim().length > 0) {
      await client.query(migration.sql)
    }
    // Ledger is immutable: regular insert, conflict aborts
    await client.query(
      `insert into schema_migration (version, filename, checksum)
       values ($1, $2, $3)`,
      [migration.version, migration.filename, migration.checksum],
    )
    await client.query(
      'update schema_metadata set schema_version = $1, migrated_at = now() where singleton = true',
      [migration.version],
    )
    applied.push(migration.filename)
  }

  const lastApplied = pending[pending.length - 1]
  const newVersion = lastApplied ? lastApplied.version : currentVersion

  return {
    schemaName,
    currentVersion: newVersion,
    pending: [],
    applied,
  }
}

// ---------------------------------------------------------------------------
// Declarative tenant access (grants + row-level security)
// ---------------------------------------------------------------------------

type Privilege = 'select' | 'insert' | 'update' | 'delete'

export type TenantRelationAccess = {
  rls: boolean
  tenantColumn?: string
  public?: Privilege[]
  runtime?: Privilege[]
  login?: Privilege[]
}

export type TenantAccessManifest = {
  version: number
  relations: Record<string, TenantRelationAccess>
}

const defaultAccessManifestPath = path.resolve(
  fileURLToPath(new URL('../../..', import.meta.url)),
  'database/migrations/tenant/access-manifest.json',
)

const relationNamePattern = /^[a-z][a-z0-9_]{0,62}$/
const privileges: readonly Privilege[] = ['select', 'insert', 'update', 'delete']

export async function loadTenantAccessManifest(
  manifestPath = defaultAccessManifestPath,
): Promise<TenantAccessManifest> {
  const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as TenantAccessManifest
  if (!parsed || typeof parsed.relations !== 'object' || parsed.relations === null) {
    throw new Error('Tenant access manifest must define "relations".')
  }
  for (const [name, access] of Object.entries(parsed.relations)) {
    if (!relationNamePattern.test(name)) throw new Error(`Invalid relation name in access manifest: ${name}`)
    if (typeof access.rls !== 'boolean') throw new Error(`Access manifest entry ${name} must set "rls".`)
    if (access.tenantColumn !== undefined && !relationNamePattern.test(access.tenantColumn)) {
      throw new Error(`Access manifest entry ${name} has an invalid tenantColumn.`)
    }
    for (const grantee of ['public', 'runtime', 'login'] as const) {
      for (const privilege of access[grantee] || []) {
        if (!privileges.includes(privilege)) {
          throw new Error(`Access manifest entry ${name} grants unknown privilege ${String(privilege)} to ${grantee}.`)
        }
      }
    }
  }
  return parsed
}

/**
 * Resets every relation in a tenant schema to exactly the privileges and RLS
 * policy the manifest declares. Must run as the schema owner
 * (tenant_template_owner) inside the caller's transaction. Fails closed when
 * the schema and manifest disagree in either direction.
 */
export async function applyTenantAccessManifest(
  client: PoolClient | Client,
  manifest: TenantAccessManifest,
  target: { schemaName: string; runtimeRole: string | null; loginRole: string | null },
): Promise<{ relations: number }> {
  // Roles are null for a tenant-supplied (bring-your-own) database: there the
  // platform's single connecting user owns the schema, so only public access
  // is revoked and forced RLS is (re)applied.
  const grantsEnabled = target.runtimeRole !== null && target.loginRole !== null
  for (const identifier of [target.schemaName, target.runtimeRole, target.loginRole]) {
    if (identifier !== null && !schemaNamePattern.test(identifier)) throw new Error(`Unsafe tenant identifier: ${identifier}`)
  }
  const quote = (id: string) => `"${id.replace(/"/g, '""')}"`
  const schema = quote(target.schemaName)
  const runtime = grantsEnabled ? quote(target.runtimeRole!) : ''
  const login = grantsEnabled ? quote(target.loginRole!) : ''

  const existing = await client.query<{ relname: string; relkind: string }>(
    `select c.relname, c.relkind::text
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm')`,
    [target.schemaName],
  )
  const present = new Map(existing.rows.map((row) => [row.relname, row.relkind]))
  const undeclared = [...present.keys()].filter((name) => !(name in manifest.relations)).sort()
  if (undeclared.length) {
    throw new Error(
      `Tenant schema ${target.schemaName} has relations missing from the access manifest: ${undeclared.join(', ')}. ` +
        'Declare them in database/migrations/tenant/access-manifest.json.',
    )
  }
  const missing = Object.keys(manifest.relations).filter((name) => !present.has(name)).sort()
  if (missing.length) {
    throw new Error(`Tenant schema ${target.schemaName} is missing manifest relations: ${missing.join(', ')}.`)
  }

  await client.query(`revoke all on schema ${schema} from public`)
  if (grantsEnabled) await client.query(`grant usage on schema ${schema} to ${runtime}, ${login}`)

  const tenantPredicate =
    `nullif(current_setting('app.tenant_id', true), '') = (select tenant_id::text from ${schema}.schema_metadata where singleton = true)`

  for (const [name, access] of Object.entries(manifest.relations)) {
    const relation = `${schema}.${quote(name)}`
    await client.query(`revoke all on ${relation} from public${grantsEnabled ? `, ${runtime}, ${login}` : ''}`)
    const grants: Array<[string, Privilege[] | undefined]> = grantsEnabled
      ? [['public', access.public], [runtime, access.runtime], [login, access.login]]
      : [['public', access.public]]
    for (const [grantee, list] of grants) {
      if (list?.length) await client.query(`grant ${list.join(', ')} on ${relation} to ${grantee}`)
    }

    const kind = present.get(name)
    if (kind === 'v' || kind === 'm') {
      if (access.rls) throw new Error(`Access manifest cannot enable RLS on view ${name}.`)
      continue
    }
    const policy = quote(`${name}_tenant_context`)
    if (access.rls) {
      let condition = tenantPredicate
      if (access.tenantColumn) {
        condition += ` and ${quote(access.tenantColumn)}::text = nullif(current_setting('app.tenant_id', true), '')`
      }
      await client.query(`alter table ${relation} enable row level security`)
      await client.query(`alter table ${relation} force row level security`)
      await client.query(`drop policy if exists ${policy} on ${relation}`)
      await client.query(`create policy ${policy} on ${relation} as permissive using (${condition}) with check (${condition})`)
    } else {
      await client.query(`drop policy if exists ${policy} on ${relation}`)
      await client.query(`alter table ${relation} no force row level security`)
      await client.query(`alter table ${relation} disable row level security`)
    }
  }

  await client.query(`revoke all on all sequences in schema ${schema} from public`)
  if (grantsEnabled) await client.query(`grant usage, select on all sequences in schema ${schema} to ${runtime}`)
  return { relations: Object.keys(manifest.relations).length }
}

const defaultBaselinePath = path.resolve(
  fileURLToPath(new URL('../../..', import.meta.url)),
  'database/migrations/tenant/001_tenant_schema.sql',
)

/**
 * The version-1 tenant baseline as plain SQL (the psql wrapper, transaction
 * control and schema creation stripped), to run with search_path already set
 * to the target schema.
 */
export async function tenantBaselineSql(templatePath = process.env.TENANT_SCHEMA_TEMPLATE || defaultBaselinePath): Promise<string> {
  const template = await readFile(templatePath, 'utf8')
  const start = template.indexOf('create table if not exists schema_metadata')
  const end = template.lastIndexOf('commit;')
  if (start < 0 || end <= start) throw new Error('Tenant schema migration template is invalid.')
  return template.slice(start, end)
}
