import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import {
  discoverTenantMigrations,
  applyTenantMigrationsForSchema,
} from '../../backend/provisioner/dist/tenant-migrations.js'

assert.ok(process.env.TENANT_PROVISIONER_DATABASE_URL, 'TENANT_PROVISIONER_DATABASE_URL is required')

describe('Integration: Tenant Migrations', () => {
  let pool
  let adminPool
  const createdSchemas = []

  before(async () => {
    const adminUrl = process.env.DATABASE_ADMIN_URL || process.env.TEST_DATABASE_URL
    assert.ok(adminUrl, 'DATABASE_ADMIN_URL or TEST_DATABASE_URL is required for setup')
    adminPool = new pg.Pool({ connectionString: adminUrl })
    pool = new pg.Pool({
      connectionString: process.env.TENANT_PROVISIONER_DATABASE_URL,
      max: 5,
    })
  })

  after(async () => {
    if (adminPool) {
      const client = await adminPool.connect()
      try {
        for (const s of createdSchemas) {
          await client.query(`drop schema if exists "${s}" cascade`).catch(() => {})
        }
      } finally {
        client.release()
        await adminPool.end()
      }
    }
    if (pool) {
      await pool.end()
    }
  })

  async function createTestSchema(schemaName, initialVersion = 1) {
    createdSchemas.push(schemaName)
    const adminClient = await adminPool.connect()
    try {
      await adminClient.query('reset role')
      await adminClient.query(`create schema "${schemaName}"`)
      await adminClient.query(`alter schema "${schemaName}" owner to tenant_template_owner`)
      await adminClient.query(`grant all on schema "${schemaName}" to tenant_template_owner, tenant_provisioner`)
      await adminClient.query(`alter default privileges for role tenant_template_owner in schema "${schemaName}" grant all on tables to tenant_provisioner`)
      await adminClient.query(`grant tenant_template_owner to "${new URL(process.env.TENANT_PROVISIONER_DATABASE_URL).username}"`).catch(() => {})
      await adminClient.query(`set role tenant_template_owner`)
      await adminClient.query(`set search_path = "${schemaName}", pg_catalog`)
      await adminClient.query(`
      create table schema_metadata (
        singleton boolean primary key default true check (singleton),
        schema_version integer not null check (schema_version > 0),
        migrated_at timestamptz not null default now()
      );
      insert into schema_metadata (singleton, schema_version) values (true, ${initialVersion});
      create table user_account (
        user_id uuid primary key default gen_random_uuid(),
        username text not null,
        email_normalized text,
        display_name text not null,
        account_status text not null default 'active' check (account_status in ('invited', 'active', 'suspended', 'departed')),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create table user_identity (
        identity_id uuid primary key default gen_random_uuid(),
        user_id uuid not null references user_account(user_id) on delete cascade,
        provider text not null,
        provider_subject text not null,
        credential_type text not null default 'password',
        password_hash text,
        created_at timestamptz not null default now(),
        last_authenticated_at timestamptz,
        unique (provider, provider_subject)
      );
      create table user_session (
        session_id uuid primary key default gen_random_uuid(),
        user_id uuid not null references user_account(user_id) on delete cascade,
        tenant_id uuid not null,
        token_hash text not null,
        csrf_hash text not null,
        created_at timestamptz not null default now(),
        last_seen_at timestamptz not null default now(),
        expires_at timestamptz not null
      );
      create table role_definition (
        role_id uuid primary key default gen_random_uuid(),
        role_code text not null unique,
        description text not null,
        is_system boolean not null default true
      );
      create table permission (
        permission_id uuid primary key default gen_random_uuid(),
        permission_code text not null unique,
        description text not null
      );
      create table role_permission (
        role_id uuid not null references role_definition(role_id) on delete cascade,
        permission_id uuid not null references permission(permission_id) on delete cascade,
        primary key (role_id, permission_id)
      );
      create table role_assignment (
        assignment_id uuid primary key default gen_random_uuid(),
        user_id uuid not null references user_account(user_id) on delete cascade,
        role_id uuid not null references role_definition(role_id) on delete cascade,
        assigned_at timestamptz not null default now(),
        expires_at timestamptz,
        unique (user_id, role_id)
      );
      create table team (
        team_id uuid primary key default gen_random_uuid(),
        name text not null unique,
        team_status text not null default 'active',
        created_by uuid references user_account(user_id) on delete set null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create table team_membership (
        team_id uuid not null references team(team_id) on delete cascade,
        user_id uuid not null references user_account(user_id) on delete cascade,
        membership_role text not null default 'member',
        joined_at timestamptz not null default now(),
        primary key (team_id, user_id)
      );
      create table tenant_setting (
        setting_key text primary key,
        setting_value jsonb not null,
        updated_by uuid references user_account(user_id) on delete set null,
        updated_at timestamptz not null default now()
      );
      create table subscription_entitlement (
        singleton boolean primary key default true check (singleton),
        plan_code text not null,
        status text not null,
        entitlement_version integer not null,
        entitlements jsonb not null default '{}'::jsonb,
        period_start timestamptz,
        period_end timestamptz,
        updated_at timestamptz not null default now()
      );
      create table audit_event (
        event_id uuid primary key default gen_random_uuid(),
        actor_user_id uuid references user_account(user_id) on delete set null,
        action text not null,
        resource_type text not null,
        resource_id uuid,
        outcome text not null check (outcome in ('success', 'denied', 'failure')),
        correlation_id uuid,
        occurred_at timestamptz not null default now()
      );
    `)
    } finally {
      await adminClient.query('reset role').catch(() => {})
      adminClient.release()
    }
  }

  test('discoverTenantMigrations validates contiguous sequence and rejects invalid files', async () => {
    const migrations = await discoverTenantMigrations()
    assert.ok(migrations.length >= 2, 'Should discover at least 2 migrations')
    assert.equal(migrations[0].version, 1)
    assert.equal(migrations[1].version, 2)

    // Test temporary directory with gaps or non-conforming files
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-mig-disc-'))
    try {
      fs.writeFileSync(path.join(tmpDir, '001_initial.sql'), 'select 1;')
      fs.writeFileSync(path.join(tmpDir, '003_skipped.sql'), 'select 3;')
      await assert.rejects(
        discoverTenantMigrations(tmpDir),
        /Non-contiguous tenant migration sequence/,
      )

      fs.writeFileSync(path.join(tmpDir, '001_duplicate.sql'), 'select 1;')
      // Should reject duplicate or non-contiguous
      fs.unlinkSync(path.join(tmpDir, '003_skipped.sql'))
      fs.writeFileSync(path.join(tmpDir, 'invalid_name.sql'), 'select 1;')
      await assert.rejects(
        discoverTenantMigrations(tmpDir),
        /Unexpected migration file name/,
      )
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('legacy version 1 schema receives real v1 ledger row and upgrades to latest', async () => {
    const schemaName = `tenant_test_leg_${crypto.randomBytes(4).toString('hex')}`
    const client = await pool.connect()
    try {
      await createTestSchema(schemaName, 1)
      const migrations = await discoverTenantMigrations()

      // Apply migrations
      await client.query('begin')
      const result = await applyTenantMigrationsForSchema(client, schemaName, migrations, {
        apply: true,
        tenantId: '00000000-0000-4000-8000-000000000101',
      })
      await client.query('commit')

      const latest = migrations[migrations.length - 1].version
      assert.equal(result.currentVersion, latest)
      assert.deepEqual(result.applied, migrations.slice(1).map((migration) => migration.filename))

      // Assert ledger rows
      await client.query('set role tenant_template_owner')
      const ledger = await client.query(
        `select version, filename, checksum from "${schemaName}".schema_migration order by version`,
      )
      assert.equal(ledger.rows.length, migrations.length)
      for (const [index, migration] of migrations.entries()) {
        assert.equal(ledger.rows[index].version, migration.version)
        assert.equal(ledger.rows[index].filename, migration.filename)
        assert.equal(ledger.rows[index].checksum, migration.checksum)
      }

      const metadata = await client.query(
        `select tenant_id::text from "${schemaName}".schema_metadata where singleton = true`,
      )
      assert.equal(metadata.rows[0].tenant_id, '00000000-0000-4000-8000-000000000101')
      const rls = await client.query(
        `select c.relname, c.relrowsecurity, c.relforcerowsecurity,
                exists (
                  select 1 from pg_policies p
                   where p.schemaname = $1
                     and p.tablename = c.relname
                     and p.policyname = c.relname || '_tenant_context'
                ) as has_context_policy
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = $1
            and c.relname = any($2::text[])
          order by c.relname`,
        [schemaName, [
          'user_account', 'user_identity', 'permission', 'role_definition', 'role_permission',
          'role_assignment', 'team', 'team_membership', 'tenant_setting',
          'subscription_entitlement', 'audit_event', 'user_session', 'capability_delegation',
        ]],
      )
      assert.equal(rls.rows.length, 13)
      for (const row of rls.rows) {
        assert.equal(row.relrowsecurity, true, `${row.relname} must enable RLS`)
        assert.equal(row.relforcerowsecurity, true, `${row.relname} must force RLS`)
        assert.equal(row.has_context_policy, true, `${row.relname} must have tenant context policy`)
      }

      await client.query('begin')
      await client.query('set local role tenant_template_owner')
      await client.query(`set local search_path = "${schemaName}", pg_catalog`)
      await client.query('savepoint immutable_metadata')
      await assert.rejects(
        client.query(
          `update schema_metadata
              set tenant_id = '00000000-0000-4000-8000-000000000199'
            where singleton = true`,
        ),
        /schema_metadata\.tenant_id is immutable/,
      )
      await client.query('rollback to savepoint immutable_metadata')
      await client.query('commit')
    } finally {
      client.release()
    }
  })

  test('altered checksum in ledger fails closed', async () => {
    const schemaName = `tenant_test_tamper_${crypto.randomBytes(4).toString('hex')}`
    const client = await pool.connect()
    try {
      await createTestSchema(schemaName, 1)
      const migrations = await discoverTenantMigrations()

      // Seed corrupted ledger row for version 1
      await client.query('begin')
      await client.query('set local role tenant_template_owner')
      await client.query(`set local search_path = "${schemaName}", pg_catalog`)
      await client.query(`
        create table if not exists schema_migration (
          version integer primary key,
          filename text not null,
          checksum text not null,
          applied_at timestamptz not null default now()
        );
        insert into schema_migration (version, filename, checksum)
        values (1, '001_baseline_marker.sql', 'tampered-checksum');
      `)
      await client.query('commit')

      await client.query('begin')
      await assert.rejects(
        applyTenantMigrationsForSchema(client, schemaName, migrations, {
          apply: true,
          tenantId: '00000000-0000-4000-8000-000000000102',
        }),
        /Migration checksum mismatch/,
      )
      await client.query('rollback')
    } finally {
      client.release()
    }
  })

  test('deliberately failing migration rolls back all schema and ledger changes', async () => {
    const schemaName = `tenant_test_fail_${crypto.randomBytes(4).toString('hex')}`
    const client = await pool.connect()
    try {
      await createTestSchema(schemaName, 1)
      const migrations = [
        {
          version: 1,
          filename: '001_baseline_marker.sql',
          sql: '',
          checksum: crypto.createHash('sha256').update('').digest('hex'),
        },
        {
          version: 2,
          filename: '002_broken.sql',
          sql: 'CREATE TABLE should_not_exist (id int); INVALID SQL SYNTAX HERE;',
          checksum: 'broken-checksum',
        },
      ]

      await client.query('begin')
      await assert.rejects(
        applyTenantMigrationsForSchema(client, schemaName, migrations, {
          apply: true,
          tenantId: '00000000-0000-4000-8000-000000000103',
        }),
      )
      await client.query('rollback')

      // Assert table was not created and version remains 1
      const checkTable = await client.query(
        `select 1 from information_schema.tables where table_schema = $1 and table_name = 'should_not_exist'`,
        [schemaName],
      )
      assert.equal(checkTable.rowCount, 0)

      await client.query('set role tenant_template_owner')
      const meta = await client.query(
        `select schema_version from "${schemaName}".schema_metadata where singleton = true`,
      )
      assert.equal(meta.rows[0].schema_version, 1)
    } finally {
      client.release()
    }
  })

  test('two migration runners serialize on pg_advisory_xact_lock', async () => {
    const schemaName = `tenant_test_lock_${crypto.randomBytes(4).toString('hex')}`
    const client1 = await pool.connect()
    const client2 = await pool.connect()
    try {
      await createTestSchema(schemaName, 1)
      const migrations = await discoverTenantMigrations()

      await client1.query('begin')
      await client1.query('select pg_advisory_xact_lock(hashtext($1))', [`tenant-migration:${schemaName}`])

      // Apply in client1
      const res1 = await applyTenantMigrationsForSchema(client1, schemaName, migrations, {
        apply: true,
        tenantId: '00000000-0000-4000-8000-000000000104',
      })
      assert.equal(res1.applied.length, migrations.length - 1)

      // In client2, begin and try to run after client1 commits
      await client1.query('commit')

      await client2.query('begin')
      await client2.query('select pg_advisory_xact_lock(hashtext($1))', [`tenant-migration:${schemaName}`])
      const res2 = await applyTenantMigrationsForSchema(client2, schemaName, migrations, {
        apply: true,
        tenantId: '00000000-0000-4000-8000-000000000104',
      })
      await client2.query('commit')

      assert.equal(res2.applied.length, 0, 'Second runner should have 0 pending migrations')
      assert.equal(res2.currentVersion, migrations[migrations.length - 1].version)
    } finally {
      client1.release()
      client2.release()
    }
  })
})
