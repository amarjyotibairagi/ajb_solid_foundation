#!/usr/bin/env node
// Ledger-driven, checksum-verified runner for platform-scope migrations.
//
// Replaces the hardcoded migration list that previously lived only in
// scripts/ci-bootstrap-db.sh. That list had drifted from production: CI applied
// 017 and 018 (both superseded), production had neither, and nothing detected
// the difference -- so CI validated a schema shape production did not have and
// the restore drill replayed a third shape again.
//
// Order and identity come from database/migrations/manifest.json. Every applied
// file's SHA-256 is recorded in platform.schema_migration; a changed file that
// was already applied is a hard error, not a silent no-op.
//
//   node scripts/platform-migrate.mjs                 # dry run: report drift and pending work
//   node scripts/platform-migrate.mjs --apply         # apply pending migrations
//   node scripts/platform-migrate.mjs --verify        # exit non-zero unless fully in sync
//
// Connects as DATABASE_ADMIN_URL (falls back to TEST_DATABASE_URL), which must
// own the platform schema. It is deliberately NOT the BFF runtime role.

import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import pg from 'pg'

const rootDirectory = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
dotenv.config({ path: path.join(rootDirectory, '.env'), quiet: true })

const apply = process.argv.includes('--apply')
const verifyOnly = process.argv.includes('--verify')
const migrationsDirectory = path.join(rootDirectory, 'database/migrations')

const databaseUrl = process.env.DATABASE_ADMIN_URL || process.env.TEST_DATABASE_URL
if (!databaseUrl) {
  throw new Error('DATABASE_ADMIN_URL (or TEST_DATABASE_URL) is required to run platform migrations.')
}

const manifest = JSON.parse(await readFile(path.join(migrationsDirectory, 'manifest.json'), 'utf8'))
if (!Array.isArray(manifest.migrations) || manifest.migrations.length === 0) {
  throw new Error('database/migrations/manifest.json declares no migrations.')
}

const seenKeys = new Set()
const seenFiles = new Set()
const migrations = []
for (const entry of manifest.migrations) {
  if (!entry.file || !entry.key || !entry.scope) {
    throw new Error(`Manifest entry is missing file, key, or scope: ${JSON.stringify(entry)}`)
  }
  if (seenKeys.has(entry.key)) throw new Error(`Duplicate migration key in manifest: ${entry.key}`)
  if (seenFiles.has(entry.file)) throw new Error(`Duplicate migration file in manifest: ${entry.file}`)
  seenKeys.add(entry.key)
  seenFiles.add(entry.file)

  const absolute = path.join(migrationsDirectory, entry.file)
  if (!absolute.startsWith(`${migrationsDirectory}${path.sep}`)) {
    throw new Error(`Manifest file escapes the migrations directory: ${entry.file}`)
  }
  const sql = await readFile(absolute, 'utf8')
  migrations.push({
    ...entry,
    absolute,
    sql,
    checksum: crypto.createHash('sha256').update(sql).digest('hex'),
  })
}

const client = new pg.Client({
  connectionString: databaseUrl,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 600_000,
})
await client.connect()

let exitCode = 0
try {
  // Serialise concurrent runners (deploys, the restore drill, CI) so two
  // processes cannot interleave migrations against the same cluster.
  await client.query('select pg_advisory_lock(hashtext($1))', ['platform-migrations'])

  const ledgerExists = await client.query(
    `select to_regclass('platform.schema_migration') is not null as present`,
  )
  const hasChecksumColumn = ledgerExists.rows[0]?.present
    ? (
        await client.query(
          `select count(*)::int as count from information_schema.columns
            where table_schema = 'platform' and table_name = 'schema_migration' and column_name = 'checksum'`,
        )
      ).rows[0].count > 0
    : false

  const applied = new Map()
  if (ledgerExists.rows[0]?.present) {
    const columns = hasChecksumColumn
      ? 'migration_key, migration_scope, source_file, checksum'
      : 'migration_key, migration_scope, null as source_file, null as checksum'
    const rows = await client.query(`select ${columns} from platform.schema_migration`)
    for (const row of rows.rows) applied.set(row.migration_key, row)
  }

  const drift = []
  const pending = []
  const unrecorded = []

  for (const migration of migrations) {
    const record = applied.get(migration.key)
    if (!record) {
      pending.push(migration)
      continue
    }
    if (!record.checksum) {
      // Applied before the ledger tracked checksums. Adopt the current file's
      // hash as the baseline rather than guessing at drift we cannot prove.
      unrecorded.push(migration)
      continue
    }
    if (record.checksum !== migration.checksum) {
      drift.push({
        key: migration.key,
        file: migration.file,
        recorded: record.checksum,
        actual: migration.checksum,
      })
    }
  }

  const orphaned = [...applied.keys()].filter((key) => !seenKeys.has(key))

  if (drift.length > 0) {
    console.error('[platform-migrate] CHECKSUM DRIFT -- applied migration files have changed since they ran:')
    for (const item of drift) {
      console.error(`  ${item.key} (${item.file})\n    recorded ${item.recorded}\n    actual   ${item.actual}`)
    }
    console.error('[platform-migrate] Refusing to proceed. Add a new migration instead of editing an applied one.')
    process.exitCode = 1
    exitCode = 1
  }

  if (orphaned.length > 0) {
    console.warn(
      `[platform-migrate] Ledger contains ${orphaned.length} migration(s) absent from the manifest: ${orphaned.join(', ')}`,
    )
    console.warn('[platform-migrate] These ran against this database but are not part of the canonical sequence.')
  }

  if (exitCode === 0 && pending.length > 0) {
    if (apply) {
      // The checksum columns are themselves introduced by a migration, so the
      // ledger's shape can change underneath this loop. Re-check rather than
      // assuming the shape observed before the first apply.
      let ledgerTracksChecksums = hasChecksumColumn
      for (const migration of pending) {
        console.log(`[platform-migrate] applying ${migration.file}`)
        // Applied through psql, not the driver: the tenant schema templates use
        // psql meta-commands (\gexec) to build identifiers, which only psql
        // understands. Files also manage their own transaction boundaries and
        // contain DO blocks that must not be nested inside another transaction.
        execFileSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-q', '-f', migration.absolute], {
          stdio: ['ignore', 'ignore', 'inherit'],
        })
        if (!ledgerTracksChecksums) {
          ledgerTracksChecksums =
            (
              await client.query(
                `select count(*)::int as count from information_schema.columns
                  where table_schema = 'platform' and table_name = 'schema_migration' and column_name = 'checksum'`,
              )
            ).rows[0].count > 0
        }
        if (ledgerTracksChecksums) {
          await client.query(
            `insert into platform.schema_migration (migration_key, migration_scope, source_file, checksum)
             values ($1, $2, $3, $4)
             on conflict (migration_key) do update
               set source_file = excluded.source_file,
                   checksum = excluded.checksum`,
            [migration.key, migration.scope, migration.file, migration.checksum],
          )
        } else {
          await client.query(
            `insert into platform.schema_migration (migration_key, migration_scope)
             values ($1, $2) on conflict (migration_key) do nothing`,
            [migration.key, migration.scope],
          )
        }
      }
      console.log(`[platform-migrate] Applied ${pending.length} migration(s).`)
    } else {
      console.log(`[platform-migrate] ${pending.length} pending migration(s):`)
      for (const migration of pending) console.log(`  ${migration.file}  (${migration.key})`)
      if (verifyOnly) {
        console.error('[platform-migrate] Database is not in sync with the manifest.')
        process.exitCode = 1
        exitCode = 1
      }
    }
  } else if (exitCode === 0 && pending.length === 0) {
    console.log(`[platform-migrate] Up to date: ${migrations.length} migration(s) in sync.`)
  }

  // Backfill runs last: the checksum columns are themselves added by a
  // migration, so they may not exist until the pending set above has been
  // applied.
  if (exitCode === 0 && unrecorded.length > 0 && apply) {
    const checksumColumnNow =
      (
        await client.query(
          `select count(*)::int as count from information_schema.columns
            where table_schema = 'platform' and table_name = 'schema_migration' and column_name = 'checksum'`,
        )
      ).rows[0].count > 0
    if (checksumColumnNow) {
      for (const migration of unrecorded) {
        await client.query(
          `update platform.schema_migration
              set source_file = $2, checksum = $3
            where migration_key = $1`,
          [migration.key, migration.file, migration.checksum],
        )
      }
      console.log(`[platform-migrate] Backfilled checksums for ${unrecorded.length} previously applied migration(s).`)
    }
  }

  if (exitCode === 0 && verifyOnly && unrecorded.length > 0) {
    console.error(
      `[platform-migrate] ${unrecorded.length} applied migration(s) have no recorded checksum. Run --apply to backfill.`,
    )
    process.exitCode = 1
    exitCode = 1
  }
} finally {
  await client.query('select pg_advisory_unlock(hashtext($1))', ['platform-migrations']).catch(() => undefined)
  await client.end()
}
