#!/usr/bin/env node
// Reconciles the tenant control plane against physical reality.
//
// The registry, the PostgreSQL catalog, the credential directory, and the
// PgBouncer auth file are four separate stores that must agree. Nothing checked
// that they did, and they had drifted: registry rows marked 'active' with no
// schema at all, a tenant marked 'deleted' whose schema, login role, credential
// file and pooler entry were all still live, and credential files for tenants
// that no longer existed.
//
//   node scripts/reconcile-tenants.mjs                    # report only (default)
//   node scripts/reconcile-tenants.mjs --repair           # safe registry corrections
//   node scripts/reconcile-tenants.mjs --repair --reap-orphans
//                                                         # additionally queue real
//                                                         # deprovisioning for tenants
//                                                         # whose resources outlived
//                                                         # their registry row
//   node scripts/reconcile-tenants.mjs --repair --reap-failed
//                                                         # additionally queue
//                                                         # deprovisioning for tenants
//                                                         # whose provisioning never
//                                                         # completed
//   node scripts/reconcile-tenants.mjs --verify           # exit non-zero on any drift
//
// Destructive cleanup is never performed inline. Orphaned resources are handed
// to the audited deprovisioning pipeline (lease-protected, step-by-step,
// recorded in tenant_provisioning_step) rather than dropped by this script.

import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import pg from 'pg'

const rootDirectory = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
dotenv.config({ path: path.join(rootDirectory, '.env'), quiet: true })

const repair = process.argv.includes('--repair')
const reapOrphans = process.argv.includes('--reap-orphans')
const reapFailed = process.argv.includes('--reap-failed')
const verifyOnly = process.argv.includes('--verify')
const asJson = process.argv.includes('--json')

const MIN_SUPPORTED_SCHEMA_VERSION = 5

const databaseUrl = process.env.DATABASE_ADMIN_URL || process.env.TEST_DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_ADMIN_URL is required.')

const credentialsDirectory = process.env.TENANT_CREDENTIALS_DIR || path.join(rootDirectory, '.secrets/tenants')
const pgbouncerAuthFile =
  process.env.TENANT_PGBOUNCER_AUTH_FILE || path.join(rootDirectory, '.secrets/pgbouncer/tenant-users.txt')

async function readCredentialRefs() {
  try {
    const entries = await readdir(credentialsDirectory)
    return new Set(entries.filter((entry) => entry.endsWith('.json')).map((entry) => entry.slice(0, -5)))
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EACCES') return null
    throw error
  }
}

async function readPoolerLogins() {
  try {
    const contents = await readFile(pgbouncerAuthFile, 'utf8')
    return new Set(
      contents
        .split(/\r?\n/)
        .map((line) => /^"([^"]+)"/.exec(line)?.[1])
        .filter(Boolean),
    )
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EACCES') return null
    throw error
  }
}

const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 })
await client.connect()

const findings = []
function record(severity, kind, subject, detail, remedy) {
  findings.push({ severity, kind, subject, detail, remedy })
}

try {
  const registry = (
    await client.query(
      `select r.tenant_key, r.tenant_id::text as tenant_id, r.schema_identifier, r.db_role, r.login_role,
              r.credential_ref, r.lifecycle_status, r.schema_version, r.identity_scheme,
              exists (select 1 from pg_namespace n where n.nspname = r.schema_identifier) as has_schema,
              r.connection_tier,
              -- A pooled tenant's login_role is the shared tenant_pool_login, which
              -- outlives every pooled tenant; only its runtime role is its own.
              case when r.connection_tier = 'pooled'
                   then exists (select 1 from pg_roles p where p.rolname = r.db_role)
                   else exists (select 1 from pg_roles p where p.rolname = r.login_role) end as has_login_role,
              exists (select 1 from pg_roles p where p.rolname = r.db_role) as has_db_role,
              exists (select 1 from platform.tenant_domain d where d.tenant_id = r.tenant_id and d.is_primary) as has_primary_domain
         from platform.tenant_registry r
        order by r.tenant_key`,
    )
  ).rows

  // Schemas and roles that follow the tenant naming convention but that no
  // registry row claims at all.
  const unclaimedSchemas = (
    await client.query(
      `select n.nspname
         from pg_namespace n
        where n.nspname like 'tenant\\_%'
          and not exists (select 1 from platform.tenant_registry r where r.schema_identifier = n.nspname)
        order by n.nspname`,
    )
  ).rows.map((row) => row.nspname)

  const unclaimedRoles = (
    await client.query(
      `select p.rolname
         from pg_roles p
        where p.rolname like 'tenant\\_%'
          and not exists (
                select 1 from platform.tenant_registry r
                 where r.login_role = p.rolname or r.db_role = p.rolname
              )
          and p.rolname not in (
                'tenant_template_owner', 'tenant_provisioner', 'tenant_provisioner_login',
                'tenant_registry_reader_login', 'tenant_pgbouncer_admin'
              )
        order by p.rolname`,
    )
  ).rows.map((row) => row.rolname)

  const credentialRefs = await readCredentialRefs()
  const poolerLogins = await readPoolerLogins()

  const claimedCredentialRefs = new Set()
  const claimedPoolerLogins = new Set()

  const registryOnlyRepairs = []
  const orphanReaps = []
  const failedReaps = []

  for (const tenant of registry) {
    const live = tenant.has_schema || tenant.has_login_role || tenant.has_db_role
    if (tenant.lifecycle_status !== 'deleted') {
      claimedCredentialRefs.add(tenant.credential_ref)
      claimedPoolerLogins.add(tenant.login_role)
    }

    // A registry row claiming to be live while owning nothing.
    if (tenant.lifecycle_status !== 'deleted' && !live) {
      record(
        'high',
        'phantom-registry-row',
        tenant.tenant_key,
        `status=${tenant.lifecycle_status} but no schema, login role, or database role exists`,
        'mark deleted (no data can exist)',
      )
      registryOnlyRepairs.push(tenant)
      continue
    }

    // Resources that outlived the registry row that owned them. This is the
    // dangerous direction: a live login role and credential for a tenant the
    // control plane believes is gone.
    if (tenant.lifecycle_status === 'deleted' && live) {
      const parts = [
        tenant.has_schema ? `schema ${tenant.schema_identifier}` : null,
        tenant.has_login_role ? `login role ${tenant.login_role}` : null,
        tenant.has_db_role ? `database role ${tenant.db_role}` : null,
      ].filter(Boolean)
      record(
        'critical',
        'orphaned-tenant-resources',
        tenant.tenant_key,
        `status=deleted but ${parts.join(', ')} still exist`,
        'reset to suspended and queue deprovisioning',
      )
      claimedCredentialRefs.add(tenant.credential_ref)
      claimedPoolerLogins.add(tenant.login_role)
      orphanReaps.push(tenant)
      continue
    }

    if (tenant.lifecycle_status === 'deleted') continue

    // Partially built tenants: some resources present, others missing.
    if (live && !(tenant.has_schema && tenant.has_login_role && tenant.has_db_role)) {
      record(
        'high',
        'incomplete-tenant-resources',
        tenant.tenant_key,
        `schema=${tenant.has_schema} loginRole=${tenant.has_login_role} dbRole=${tenant.has_db_role}`,
        'suspend and deprovision, then re-provision',
      )
    }

    if (tenant.lifecycle_status === 'provisioning_failed') {
      record(
        'medium',
        'failed-provisioning',
        tenant.tenant_key,
        'provisioning never completed; tenant owns resources but was never activated',
        'retry the provisioning job, or suspend and deprovision (--reap-failed)',
      )
      failedReaps.push(tenant)
    }

    if (tenant.lifecycle_status === 'active' && tenant.schema_version < MIN_SUPPORTED_SCHEMA_VERSION) {
      record(
        'high',
        'schema-version-below-minimum',
        tenant.tenant_key,
        `schema_version=${tenant.schema_version}, tenant BFF requires >= ${MIN_SUPPORTED_SCHEMA_VERSION}; every request returns 503`,
        'npm run migrate:tenants -- --apply',
      )
    }

    if (tenant.lifecycle_status === 'active' && tenant.connection_tier !== 'pooled' && credentialRefs && !credentialRefs.has(tenant.credential_ref)) {
      record(
        'critical',
        'missing-credential-file',
        tenant.tenant_key,
        `active tenant has no credential file ${tenant.credential_ref}.json; the tenant BFF cannot open a pool for it`,
        're-provision, or restore the credential from backup',
      )
    }

    if (tenant.lifecycle_status === 'active' && poolerLogins && !poolerLogins.has(tenant.login_role)) {
      record(
        'high',
        'missing-pooler-entry',
        tenant.tenant_key,
        `active tenant login role ${tenant.login_role} is absent from the PgBouncer auth file`,
        're-run REGISTER_DATABASE_ACCESS for this tenant',
      )
    }
  }

  for (const schema of unclaimedSchemas) {
    record('critical', 'unclaimed-schema', schema, 'schema exists but no registry row references it', 'investigate before dropping; no automated repair')
  }
  for (const role of unclaimedRoles) {
    record('critical', 'unclaimed-role', role, 'database role exists but no registry row references it', 'investigate before dropping; no automated repair')
  }

  if (credentialRefs) {
    for (const ref of credentialRefs) {
      if (!claimedCredentialRefs.has(ref)) {
        record('high', 'orphaned-credential-file', `${ref}.json`, 'credential file has no live tenant', 'remove after confirming the tenant is gone')
      }
    }
  } else {
    record('low', 'credential-directory-unreadable', credentialsDirectory, 'cannot enumerate credentials from this account', 'run as the provisioner user for a complete report')
  }

  if (poolerLogins) {
    const infrastructureLogins = new Set([
      'pgbouncer_stats',
      'tenant_pgbouncer_admin',
      'tenant_provisioner_login',
      'tenant_registry_reader_login',
    ])
    for (const login of poolerLogins) {
      if (infrastructureLogins.has(login) || claimedPoolerLogins.has(login)) continue
      record('high', 'orphaned-pooler-entry', login, 'PgBouncer auth file grants a login with no live tenant', 'remove the entry and reload PgBouncer')
    }
  } else {
    record('low', 'pooler-auth-file-unreadable', pgbouncerAuthFile, 'cannot read the PgBouncer auth file from this account', 'run as the provisioner user for a complete report')
  }

  // ---- repair --------------------------------------------------------------

  if (repair && registryOnlyRepairs.length > 0) {
    for (const tenant of registryOnlyRepairs) {
      await client.query('begin')
      try {
        await client.query(
          `update platform.tenant_domain set status = 'disabled' where tenant_id = $1`,
          [tenant.tenant_id],
        )
        // The lifecycle trigger added in migration 023 independently verifies
        // that no schema or role exists before allowing this transition.
        await client.query(
          `update platform.tenant_registry
              set lifecycle_status = 'deleted', last_error_code = 'ReconciledPhantom', last_error_at = now()
            where tenant_id = $1`,
          [tenant.tenant_id],
        )
        await client.query('commit')
        console.log(`[reconcile] ${tenant.tenant_key}: marked deleted (owned no resources)`)
      } catch (error) {
        await client.query('rollback')
        console.error(`[reconcile] ${tenant.tenant_key}: repair failed -- ${error.message}`)
      }
    }
  }

  async function queueDeprovision(tenant, reason) {
    if (!tenant.has_primary_domain) {
      console.error(
        `[reconcile] ${tenant.tenant_key}: cannot queue deprovisioning -- no primary tenant_domain row. Resolve manually.`,
      )
      return
    }
    await client.query('begin')
    try {
      await client.query(
        `update platform.tenant_registry
            set lifecycle_status = 'suspended', last_error_code = $2, last_error_at = now()
          where tenant_id = $1`,
        [tenant.tenant_id, reason],
      )
      const job = await client.query(
        `insert into platform.tenant_provisioning_job (tenant_id, job_type, status, correlation_id)
         values ($1, 'deprovision', 'pending', gen_random_uuid())
         returning job_id::text`,
        [tenant.tenant_id],
      )
      await client.query(
        `update platform.tenant_registry set lifecycle_status = 'deleting' where tenant_id = $1`,
        [tenant.tenant_id],
      )
      await client.query(
        `update platform.tenant_domain set status = 'disabled' where tenant_id = $1`,
        [tenant.tenant_id],
      )
      await client.query('commit')
      console.log(
        `[reconcile] ${tenant.tenant_key}: queued deprovisioning job ${job.rows[0].job_id}; the provisioner worker will drop the schema, roles, credential, and pooler entry.`,
      )
    } catch (error) {
      await client.query('rollback')
      console.error(`[reconcile] ${tenant.tenant_key}: could not queue deprovisioning -- ${error.message}`)
    }
  }

  if (repair && reapFailed && failedReaps.length > 0) {
    for (const tenant of failedReaps) await queueDeprovision(tenant, 'ReconciledFailedProvisioning')
  }

  if (repair && reapOrphans && orphanReaps.length > 0) {
    for (const tenant of orphanReaps) {
      await queueDeprovision(tenant, 'ReconciledOrphan')
    }
  }

  // ---- report --------------------------------------------------------------

  if (asJson) {
    console.log(JSON.stringify({ findings, tenantCount: registry.length }, null, 2))
  } else if (findings.length === 0) {
    console.log(`[reconcile] Clean: ${registry.length} registry rows agree with the cluster, credentials, and pooler.`)
  } else {
    const order = { critical: 0, high: 1, medium: 2, low: 3 }
    findings.sort((left, right) => order[left.severity] - order[right.severity])
    console.log(`[reconcile] ${findings.length} finding(s) across ${registry.length} registry rows:\n`)
    for (const finding of findings) {
      console.log(`  [${finding.severity.toUpperCase()}] ${finding.kind}: ${finding.subject}`)
      console.log(`      ${finding.detail}`)
      console.log(`      -> ${finding.remedy}`)
    }
    if (!repair) {
      console.log(
        '\n  Re-run with --repair (--reap-orphans for orphaned resources, --reap-failed for failed provisioning) to correct.',
      )
    }
  }

  if (verifyOnly && findings.length > 0) process.exitCode = 1
} finally {
  await client.end()
}
