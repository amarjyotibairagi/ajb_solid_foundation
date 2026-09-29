#!/usr/bin/env node
// Provisions the two tenants the test suite runs against ("alpha" and "beta")
// through the real provisioning pipeline, adds a small user population to
// each, and writes their identities to TEST_TENANTS_FILE.
//
// Run by scripts/ci-bootstrap-db.sh after migrations, against a throwaway
// database only.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import argon2 from 'argon2'
import pg from 'pg'

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
for (const name of ['DATABASE_URL', 'DATABASE_ADMIN_URL', 'TENANT_PROVISIONER_DATABASE_URL', 'TENANT_CREDENTIALS_DIR', 'TEST_TENANTS_FILE']) {
  if (!process.env[name]) throw new Error(`${name} is required.`)
}
process.env.TENANT_EDGE_VERIFY_DISABLED = 'true'
process.env.TENANT_PGBOUNCER_RELOAD_DISABLED = 'true'
const adminUrl = new URL(process.env.DATABASE_ADMIN_URL)
process.env.TENANT_PGBOUNCER_HOST ||= adminUrl.hostname
process.env.TENANT_PGBOUNCER_PORT ||= adminUrl.port || '5432'
fs.mkdirSync(process.env.TENANT_CREDENTIALS_DIR, { recursive: true })

const { createTenantProvisioningJob } = await import(path.join(root, 'backend/dist/tenant-provisioning.js'))
const { TenantProvisioningWorker } = await import(path.join(root, 'backend/provisioner/dist/worker.js'))

const rootDomain = process.env.TENANT_ROOT_DOMAIN || 'sandbox.test'
const fixturePassword = 'fixture-password-long-enough'
const platform = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const admin = new pg.Pool({ connectionString: process.env.DATABASE_ADMIN_URL })
const worker = new TenantProvisioningWorker()
await worker.assertIdentity()

const log = (message) => console.log(`[test-fixture] ${message}`)
const owner = (await admin.query("select id::text from platform.platform_user where role = 'platform_owner' and is_active limit 1")).rows[0]
if (!owner) throw new Error('A platform owner must exist before provisioning test tenants.')

const passwordHash = await argon2.hash(fixturePassword, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 })
const tenants = {}

for (const name of ['alpha', 'beta']) {
  const created = await createTenantProvisioningJob(
    platform,
    { displayName: `${name[0].toUpperCase()}${name.slice(1)} Test Org`, subdomain: name, region: 'global', locale: 'en', primaryColor: '#2563eb', secondaryColor: '#0f172a', connectionTier: 'dedicated' },
    owner.id,
    rootDomain,
    crypto.randomUUID(),
  )
  log(`provisioning ${name} (${created.tenant.tenantId})`)
  for (let attempt = 0; ; attempt += 1) {
    await worker.tick()
    const job = (await admin.query('select status, safe_error_message from platform.tenant_provisioning_job where job_id = $1', [created.jobId])).rows[0]
    if (job.status === 'succeeded') break
    if (job.status === 'failed' || attempt > 200) throw new Error(`Provisioning ${name} failed: ${job.safe_error_message}`)
  }
  const registry = (await admin.query(
    `select tenant_id::text, tenant_key, schema_identifier, db_role, login_role, credential_ref
       from platform.tenant_registry where tenant_key = $1`,
    [created.tenant.tenantId],
  )).rows[0]

  // Users: owner, admin, three members, a viewer. The admin connection is a
  // superuser, so forced RLS does not apply to these inserts.
  const schema = `"${registry.schema_identifier}"`
  const people = [
    ['owner', 'tenant_owner'], ['admin', 'tenant_admin'], ['member1', 'tenant_member'],
    ['member2', 'tenant_member'], ['member3', 'tenant_member'], ['viewer', 'tenant_viewer'],
  ]
  for (const [suffix, role] of people) {
    const username = `${name}.${suffix}`
    const user = (await admin.query(
      `insert into ${schema}.user_account (username, display_name, email_normalized, account_status)
       values ($1, $2, $3, 'active') returning user_id::text`,
      [username, `${name} ${suffix}`, `${username}@${name}.test`],
    )).rows[0]
    await admin.query(
      `insert into ${schema}.role_assignment (user_id, role_id)
       select $1, role_id from ${schema}.role_definition where role_code = $2`,
      [user.user_id, role],
    )
    await admin.query(
      `insert into ${schema}.user_identity (user_id, provider, provider_subject, credential_type, password_hash)
       values ($1, 'local', $2, 'password', $3)`,
      [user.user_id, username, passwordHash],
    )
  }

  tenants[name] = {
    tenantId: registry.tenant_id,
    tenantKey: registry.tenant_key,
    host: `${name}.${rootDomain}`,
    schemaName: registry.schema_identifier,
    dbRole: registry.db_role,
    loginRole: registry.login_role,
    credentialRef: registry.credential_ref,
    ownerUsername: `${name}.owner`,
  }
  log(`${name} ready at ${tenants[name].host}`)
}

fs.writeFileSync(process.env.TEST_TENANTS_FILE, `${JSON.stringify({ rootDomain, password: fixturePassword, tenants }, null, 2)}\n`)
log(`wrote ${process.env.TEST_TENANTS_FILE}`)
await worker.close()
await platform.end()
await admin.end()
