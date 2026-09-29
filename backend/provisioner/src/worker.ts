import crypto from 'node:crypto'
import { open, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import pg, { type PoolClient } from 'pg'
import {
  applyTenantAccessManifest,
  applyTenantMigrationsForSchema,
  discoverTenantMigrations,
  loadTenantAccessManifest,
} from './tenant-migrations.js'
import { operationSteps, type OperationType } from '@skeleton/server-kit'
import {
  databasePlacement,
  purgeTenantData,
  relocateStoredObjects,
  removeLocalTenantStorage,
  upgradePlacement,
  copyTenantData,
  type TenantRow,
} from './tenant-operations.js'

if (process.env.NODE_ENV !== 'test') {
  dotenv.config({
    path: path.resolve(fileURLToPath(new URL('../../..', import.meta.url)), '.env'),
    quiet: true,
  })
}

// Secret file locations must be explicit in production so a new deployment
// never writes credentials into another installation's directory layout.
function requiredPath(name: string, repositoryRelativeDefault: string): string {
  const value = process.env[name]?.trim()
  if (value) return value
  if (process.env.NODE_ENV === 'production') throw new Error(`${name} must be set in production.`)
  return path.resolve(fileURLToPath(new URL('../../..', import.meta.url)), repositoryRelativeDefault)
}

const config = {
  get databaseUrl() {
    return process.env.TENANT_PROVISIONER_DATABASE_URL || ''
  },
  get credentialsDirectory() {
    return requiredPath('TENANT_CREDENTIALS_DIR', '.secrets/tenants')
  },
  get pgbouncerAuthFile() {
    return requiredPath('TENANT_PGBOUNCER_AUTH_FILE', '.secrets/pgbouncer/tenant-users.txt')
  },
  get pgbouncerHost() {
    return process.env.TENANT_PGBOUNCER_HOST || '127.0.0.1'
  },
  get pgbouncerPort() {
    return Number(process.env.TENANT_PGBOUNCER_PORT || 6360)
  },
  get pgbouncerAdminUser() {
    return process.env.TENANT_PGBOUNCER_ADMIN_USER || ''
  },
  get pgbouncerAdminPassword() {
    return process.env.TENANT_PGBOUNCER_ADMIN_PASSWORD || ''
  },
  get schemaTemplate() {
    return (
      process.env.TENANT_SCHEMA_TEMPLATE ||
      path.resolve(fileURLToPath(new URL('../../..', import.meta.url)), 'database/migrations/tenant/001_tenant_schema.sql')
    )
  },
  get edgeVerifyTimeoutMs() {
    return Number(process.env.TENANT_EDGE_VERIFY_TIMEOUT_MS || 10_000)
  },
  get pollIntervalMs() {
    return Number(process.env.TENANT_PROVISIONER_POLL_MS || 2_000)
  },
  get leaseTimeoutMs() {
    return Number(process.env.TENANT_PROVISIONER_LEASE_MS || 2 * 60_000)
  },
  get heartbeatIntervalMs() {
    return Number(process.env.TENANT_PROVISIONER_HEARTBEAT_MS || 15_000)
  },
  get workerId() {
    return `${process.env.HOSTNAME || 'worker'}:${process.pid}`
  },
}

const identifierPattern = /^[a-z][a-z0-9_]{2,62}$/
const tenantKeyPattern = /^T[A-Z0-9]{10,63}$/
const stepDefinitions = [
  ['VALIDATE_TENANT_INPUT', 'Tenant information validated'],
  ['NORMALIZE_SUBDOMAIN', 'Subdomain normalized'],
  ['VALIDATE_SUBDOMAIN', 'Subdomain security checks completed'],
  ['CHECK_SUBDOMAIN_AVAILABILITY', 'Subdomain reservation verified'],
  ['GENERATE_IMMUTABLE_TENANT_ID', 'Immutable tenant identity verified'],
  ['RESERVE_TENANT_IDENTITY', 'Tenant identity reserved'],
  ['CREATE_TENANT_REGISTRY_RECORD', 'Tenant registry record created'],
  ['CREATE_TENANT_DATABASE_ROLE', 'Secure tenant database identity created'],
  ['CREATE_TENANT_SCHEMA', 'Isolated tenant database created'],
  ['APPLY_TENANT_SCHEMA_MIGRATIONS', 'Tenant structure applied'],
  ['APPLY_REQUIRED_SEED_DATA', 'Default tenant roles and permissions applied'],
  ['APPLY_SCHEMA_PRIVILEGES', 'Tenant isolation privileges applied'],
  ['CONFIGURE_ROLE_SEARCH_PATH', 'Tenant database defaults configured'],
  ['REGISTER_DATABASE_ACCESS', 'Tenant pooled database access registered'],
  ['REGISTER_TENANT_DOMAIN', 'Tenant hostname registered'],
  ['STORE_TENANT_BRANDING', 'Safe tenant branding stored'],
  ['VERIFY_DATABASE_ISOLATION', 'Database isolation verified'],
  ['VERIFY_TENANT_RESOLUTION', 'Hostname resolution verified'],
  ['VERIFY_TENANT_LOGIN_CONTEXT', 'Tenant authentication context verified'],
  ['ACTIVATE_TENANT_DOMAIN', 'Tenant hostname activated'],
  ['VERIFY_EDGE_REACHABILITY', 'Tenant reachability verified over the public edge'],
  ['ACTIVATE_TENANT', 'Tenant activated'],
] as const

const deprovisionStepDefinitions = [
  ['DEPROV_VALIDATE_ELIGIBLE', 'Tenant eligibility for removal verified'],
  ['DEPROV_MARK_DELETING', 'Tenant marked for removal'],
  ['DEPROV_REVOKE_DATABASE_ACCESS', 'Pooled database access revoked'],
  ['DEPROV_DROP_SCHEMA', 'Tenant database removed'],
  ['DEPROV_DROP_DATABASE_ROLE', 'Tenant database identity removed'],
  ['DEPROV_REMOVE_CREDENTIAL_FILE', 'Tenant credential removed'],
  ['DEPROV_REMOVE_LOCAL_STORAGE', 'Tenant files on the VDS removed'],
  ['DEPROV_FINALIZE', 'Tenant removal finalized'],
] as const

type StepCode = string
type JobType = 'provision' | 'deprovision' | OperationType
const operationJobTypes = new Set<JobType>(['migrate', 'relocate_database', 'relocate_storage'])
type ProvisioningTenant = {
  jobId: string
  jobType: JobType
  tenantId: string
  tenantKey: string
  displayName: string
  slug: string
  hostname: string
  schemaName: string
  dbRole: string
  loginRole: string
  credentialRef: string
  correlationId: string
  connectionTier: 'dedicated' | 'pooled'
  jobParams: Record<string, unknown>
  dataIntegrationId: string | null
  storageIntegrationId: string | null
}

type TenantCredential = {
  tenantId: string
  tenantKey: string
  schemaName: string
  dbRole: string
  loginRole: string
  password: string
  scramVerifier: string
  database: string
  host: string
  port: number
}

function quoteIdentifier(value: string): string {
  if (!identifierPattern.test(value)) throw new Error('Generated tenant identifier is invalid.')
  return `"${value}"`
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

async function assertPermissionDenied(client: pg.Client, query: string): Promise<void> {
  try {
    await client.query(query)
  } catch (error) {
    if ((error as { code?: string }).code === '42501') return
    throw error
  }
  throw new Error('Tenant login unexpectedly accessed a protected table.')
}

function createScramVerifier(password: string): string {
  const iterations = 4096
  const salt = crypto.randomBytes(16)
  const saltedPassword = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256')
  const clientKey = crypto.createHmac('sha256', saltedPassword).update('Client Key').digest()
  const storedKey = crypto.createHash('sha256').update(clientKey).digest()
  const serverKey = crypto.createHmac('sha256', saltedPassword).update('Server Key').digest()
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`
}

async function atomicWrite(filePath: string, contents: string): Promise<void> {
  const dir = path.dirname(filePath)
  const temporary = path.join(dir, `.tmp.${path.basename(filePath)}.${process.pid}.${Date.now()}`)
  const fileHandle = await open(temporary, 'w', 0o640)
  try {
    await fileHandle.writeFile(contents)
    await fileHandle.sync()
  } finally {
    await fileHandle.close()
  }
  await rename(temporary, filePath)
  try {
    const dirHandle = await open(dir, 'r')
    try {
      await dirHandle.sync()
    } finally {
      await dirHandle.close()
    }
  } catch {
    // Directory sync best-effort if OS supports it
  }
}

export class TenantProvisioningWorker {
  private readonly pool: pg.Pool
  private running = false

  constructor() {
    if (!config.databaseUrl) throw new Error('TENANT_PROVISIONER_DATABASE_URL is required.')
    if (!config.pgbouncerAdminUser || !config.pgbouncerAdminPassword) {
      if (process.env.TENANT_PGBOUNCER_RELOAD_DISABLED !== 'true') {
        throw new Error('Dedicated tenant PgBouncer administrator credentials are required.')
      }
    }
    this.pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: 4,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      query_timeout: 120_000,
      statement_timeout: 120_000,
      lock_timeout: 10_000,
      idle_in_transaction_session_timeout: 30_000,
      application_name: 'tenant-provisioner',
    })
  }

  private async withProvisioner<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      await client.query('set local role tenant_provisioner')
      await client.query('set local search_path = platform, pg_catalog')
      const result = await callback(client)
      await client.query('commit')
      return result
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  async assertIdentity(): Promise<void> {
    const identity = await this.pool.query<{ current_user: string }>('select current_user')
    if (identity.rows[0]?.current_user !== 'tenant_provisioner_login') {
      throw new Error('Provisioning worker must authenticate as tenant_provisioner_login.')
    }
  }

  private async acquireJob(): Promise<ProvisioningTenant | null> {
    return this.withProvisioner(async (client) => {
      await client.query(
        `update platform.tenant_provisioning_job
            set status = 'retrying', worker_id = null, locked_at = null,
                safe_error_code = 'WorkerLeaseExpired',
                safe_error_message = 'Provisioning worker restarted; the existing job will resume.'
          where status = 'running'
            and locked_at < now() - ($1 * interval '1 millisecond')`,
        [config.leaseTimeoutMs],
      )
      const result = await client.query<{
        job_id: string
        job_type: JobType
        tenant_id: string
        tenant_key: string
        display_name: string
        slug: string
        hostname: string
        schema_identifier: string
        db_role: string
        login_role: string
        credential_ref: string
        correlation_id: string
        connection_tier: 'dedicated' | 'pooled'
        job_params: Record<string, unknown>
        data_integration_id: string | null
        storage_integration_id: string | null
      }>(
        `select j.job_id::text, j.job_type, t.tenant_id::text, t.tenant_key, t.display_name,
                t.slug, d.hostname, t.schema_identifier, t.db_role, t.login_role,
                t.credential_ref, j.correlation_id::text, t.connection_tier, j.job_params,
                t.data_integration_id::text, t.storage_integration_id::text
           from platform.tenant_provisioning_job j
           join platform.tenant_registry t on t.tenant_id = j.tenant_id
           join platform.tenant_domain d on d.tenant_id = t.tenant_id and d.is_primary
          where j.status in ('pending', 'retrying')
          order by j.created_at
          for update of j skip locked
          limit 1`,
      )
      const row = result.rows[0]
      if (!row) return null
      await client.query(
        `update platform.tenant_provisioning_job
            set status = 'running', worker_id = $1, locked_at = now(),
                started_at = coalesce(started_at, now()), attempt_count = attempt_count + 1,
                safe_error_code = null, safe_error_message = null
          where job_id = $2`,
        [config.workerId, row.job_id],
      )
      return {
        jobId: row.job_id,
        jobType: row.job_type,
        tenantId: row.tenant_id,
        tenantKey: row.tenant_key,
        displayName: row.display_name,
        slug: row.slug,
        hostname: row.hostname,
        schemaName: row.schema_identifier,
        dbRole: row.db_role,
        loginRole: row.login_role,
        credentialRef: row.credential_ref,
        correlationId: row.correlation_id,
        connectionTier: row.connection_tier,
        jobParams: row.job_params || {},
        dataIntegrationId: row.data_integration_id,
        storageIntegrationId: row.storage_integration_id,
      }
    })
  }

  private validateTenant(tenant: ProvisioningTenant): void {
    if (!tenantKeyPattern.test(tenant.tenantKey)) throw new Error('Immutable tenant identity is invalid.')
    if (!identifierPattern.test(tenant.schemaName)) throw new Error('Invalid tenant schema identifier.')
    if (!identifierPattern.test(tenant.dbRole)) throw new Error('Invalid tenant db role identifier.')
    if (!identifierPattern.test(tenant.loginRole)) throw new Error('Invalid tenant login role identifier.')
    quoteIdentifier(tenant.schemaName)
    quoteIdentifier(tenant.dbRole)
    quoteIdentifier(tenant.loginRole)
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(tenant.slug)) throw new Error('Subdomain is invalid.')
    if (tenant.credentialRef !== tenant.tenantKey) throw new Error('Credential reference is not tenant-bound.')
  }

  /**
   * Login used to verify a tenant's database access. Dedicated tenants have
   * their own credential file; pooled tenants share tenant_pool_login, whose
   * connection string the worker receives as TENANT_POOL_DATABASE_URL.
   */
  private async loginCredential(tenant: ProvisioningTenant): Promise<{ host: string; port: number; database: string; loginRole: string; password: string }> {
    if (tenant.connectionTier === 'dedicated') return this.ensureCredential(tenant)
    const url = process.env.TENANT_POOL_DATABASE_URL
    if (!url) throw new Error('TENANT_POOL_DATABASE_URL is required to provision pooled tenants.')
    const parsed = new URL(url)
    return {
      host: parsed.hostname,
      port: Number(parsed.port || 5432),
      database: decodeURIComponent(parsed.pathname.slice(1)),
      loginRole: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    }
  }

  private tenantRow(tenant: ProvisioningTenant): TenantRow {
    return {
      tenant_id: tenant.tenantId,
      tenant_key: tenant.tenantKey,
      schema_identifier: tenant.schemaName,
      db_role: tenant.dbRole,
      login_role: tenant.loginRole,
      data_integration_id: tenant.dataIntegrationId,
      storage_integration_id: tenant.storageIntegrationId,
    }
  }

  private credentialPath(tenant: ProvisioningTenant): string {
    return path.join(config.credentialsDirectory, `${tenant.credentialRef}.json`)
  }

  private async ensureCredential(tenant: ProvisioningTenant): Promise<TenantCredential> {
    const secretPath = this.credentialPath(tenant)
    try {
      const existing = JSON.parse(await readFile(secretPath, 'utf8')) as TenantCredential
      if (
        existing.tenantId !== tenant.tenantId ||
        existing.schemaName !== tenant.schemaName ||
        existing.loginRole !== tenant.loginRole
      ) {
        throw new Error('Existing tenant credential binding is invalid.')
      }
      return existing
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const password = crypto.randomBytes(32).toString('base64url')
    const credential: TenantCredential = {
      tenantId: tenant.tenantId,
      tenantKey: tenant.tenantKey,
      schemaName: tenant.schemaName,
      dbRole: tenant.dbRole,
      loginRole: tenant.loginRole,
      password,
      scramVerifier: createScramVerifier(password),
      database: 'platform_db',
      host: config.pgbouncerHost,
      port: config.pgbouncerPort,
    }
    await this.assertLeaseActive(tenant)
    await atomicWrite(secretPath, `${JSON.stringify(credential, null, 2)}\n`)
    await this.assertLeaseActive(tenant)
    return credential
  }

  async assertLeaseActive(tenant: ProvisioningTenant): Promise<void> {
    const result = await this.withProvisioner(async (client) =>
      client.query(
        `select 1 from platform.tenant_provisioning_job
          where job_id = $1 and worker_id = $2 and status = 'running'`,
        [tenant.jobId, config.workerId],
      ),
    )
    if (result.rowCount !== 1) {
      throw new Error('Provisioning worker lease was lost.')
    }
  }

  private async markStep(tenant: ProvisioningTenant, step: StepCode, status: 'running' | 'succeeded'): Promise<void> {
    await this.withProvisioner(async (client) => {
      const jobUpdate = await client.query(
        `update platform.tenant_provisioning_job
            set current_step = $1
          where job_id = $2 and worker_id = $3 and status = 'running'`,
        [step, tenant.jobId, config.workerId],
      )
      if (jobUpdate.rowCount !== 1) {
        throw new Error('Provisioning worker lease was lost.')
      }
      await client.query(
        `update platform.tenant_provisioning_step
            set status = $1,
                started_at = case when $1 = 'running' then coalesce(started_at, now()) else started_at end,
                completed_at = case when $1 = 'succeeded' then now() else null end,
                attempt_count = case when $1 = 'running' then attempt_count + 1 else attempt_count end,
                safe_error_message = null
          where job_id = $2 and step_code = $3`,
        [status, tenant.jobId, step],
      )
    })
  }

  private async stepAlreadySucceeded(tenant: ProvisioningTenant, step: StepCode): Promise<boolean> {
    return this.withProvisioner(async (client) => {
      const result = await client.query<{ succeeded: boolean }>(
        `select status = 'succeeded' as succeeded
           from platform.tenant_provisioning_step where job_id = $1 and step_code = $2`,
        [tenant.jobId, step],
      )
      return result.rows[0]?.succeeded === true
    })
  }

  private async runStep(tenant: ProvisioningTenant, step: StepCode): Promise<void> {
    if (await this.stepAlreadySucceeded(tenant, step)) return
    await this.markStep(tenant, step, 'running')
    let heartbeatFailure: unknown
    let heartbeatTask = Promise.resolve()
    const heartbeat = () => {
      heartbeatTask = heartbeatTask
        .then(async () => {
          const result = await this.withProvisioner(async (client) =>
            client.query(
              `update platform.tenant_provisioning_job set locked_at = now()
                where job_id = $1 and status = 'running' and worker_id = $2`,
              [tenant.jobId, config.workerId],
            ),
          )
          if (result.rowCount !== 1) throw new Error('Provisioning worker lease was lost.')
        })
        .catch((error: unknown) => {
          heartbeatFailure = error
        })
    }
    heartbeat()
    const heartbeatTimer = setInterval(heartbeat, config.heartbeatIntervalMs)
    try {
      if (tenant.jobType === 'deprovision') {
        await this.executeDeprovisionStep(tenant, step)
      } else if (operationJobTypes.has(tenant.jobType)) {
        await this.executeOperationStep(tenant, step)
      } else {
        await this.executeStep(tenant, step)
      }
      await heartbeatTask
      if (heartbeatFailure) throw heartbeatFailure
    } finally {
      clearInterval(heartbeatTimer)
    }
    await this.markStep(tenant, step, 'succeeded')
  }

  private async executeStep(tenant: ProvisioningTenant, step: StepCode): Promise<void> {
    if (
      [
        'VALIDATE_TENANT_INPUT',
        'NORMALIZE_SUBDOMAIN',
        'VALIDATE_SUBDOMAIN',
        'GENERATE_IMMUTABLE_TENANT_ID',
        'RESERVE_TENANT_IDENTITY',
      ].includes(step)
    ) {
      this.validateTenant(tenant)
      return
    }
    if (step === 'CHECK_SUBDOMAIN_AVAILABILITY' || step === 'CREATE_TENANT_REGISTRY_RECORD') {
      await this.withProvisioner(async (client) => {
        const result = await client.query<{ count: number }>(
          `select count(*)::int as count
             from platform.tenant_domain
            where lower(hostname) = lower($1) and tenant_id <> $2`,
          [tenant.hostname, tenant.tenantId],
        )
        if (result.rows[0]?.count !== 0) throw new Error('Tenant hostname is no longer available.')
      })
      return
    }
    if (step === 'CREATE_TENANT_DATABASE_ROLE' && tenant.connectionTier === 'pooled') {
      if (tenant.loginRole !== 'tenant_pool_login') throw new Error('Pooled tenant must use tenant_pool_login.')
      await this.withProvisioner(async (client) => {
        const runtime = quoteIdentifier(tenant.dbRole)
        if (!(await client.query<{ exists: boolean }>('select exists(select 1 from pg_roles where rolname = $1)', [tenant.dbRole])).rows[0]?.exists) {
          await client.query(`create role ${runtime} nologin noinherit nosuperuser nocreatedb nocreaterole nobypassrls`)
        }
        // SET only: the shared login can switch into this tenant's role per
        // transaction but never inherits its privileges.
        await client.query(`grant ${runtime} to tenant_pool_login with inherit false, set true`)
      })
      return
    }
    if (step === 'CREATE_TENANT_DATABASE_ROLE') {
      const credential = await this.ensureCredential(tenant)
      await this.withProvisioner(async (client) => {
        const runtime = quoteIdentifier(tenant.dbRole)
        const login = quoteIdentifier(tenant.loginRole)
        if (!(await client.query<{ exists: boolean }>('select exists(select 1 from pg_roles where rolname = $1)', [tenant.dbRole])).rows[0]?.exists) {
          await client.query(`create role ${runtime} nologin noinherit nosuperuser nocreatedb nocreaterole nobypassrls`)
        }
        if (!(await client.query<{ exists: boolean }>('select exists(select 1 from pg_roles where rolname = $1)', [tenant.loginRole])).rows[0]?.exists) {
          await client.query(
            `create role ${login} login noinherit nosuperuser nocreatedb nocreaterole nobypassrls password ${quoteLiteral(credential.scramVerifier)}`,
          )
        } else {
          await client.query(`alter role ${login} password ${quoteLiteral(credential.scramVerifier)}`)
        }
        await client.query(`alter role ${login} set statement_timeout = '30s'`)
        await client.query(`alter role ${login} set lock_timeout = '5s'`)
        await client.query(`alter role ${login} set idle_in_transaction_session_timeout = '15s'`)
        await client.query(`grant ${runtime} to ${login}`)
        await client.query(`grant connect on database platform_db to ${login}`)
      })
      return
    }
    if (step === 'CREATE_TENANT_SCHEMA') {
      await this.withProvisioner(async (client) => {
        await client.query(`create schema if not exists ${quoteIdentifier(tenant.schemaName)} authorization tenant_template_owner`)
      })
      return
    }
    if (step === 'APPLY_TENANT_SCHEMA_MIGRATIONS') {
      const template = await readFile(config.schemaTemplate, 'utf8')
      const start = template.indexOf('create table if not exists schema_metadata')
      const end = template.lastIndexOf('commit;')
      if (start < 0 || end <= start) throw new Error('Tenant schema migration template is invalid.')
      const body = template.slice(start, end)
      const migrations = await discoverTenantMigrations()
      await this.withProvisioner(async (client) => {
        await client.query('set local role tenant_template_owner')
        await client.query(`set local search_path = ${quoteIdentifier(tenant.schemaName)}, pg_catalog`)
        await client.query(body)
        await applyTenantMigrationsForSchema(client, tenant.schemaName, migrations, {
          apply: true,
          tenantId: tenant.tenantId,
        })
      })
      return
    }
    if (step === 'APPLY_REQUIRED_SEED_DATA') {
      // Roles and permissions are seeded by the versioned tenant migrations;
      // this step only proves they landed, so a broken migration cannot yield
      // a tenant nobody can administer.
      await this.withProvisioner(async (client) => {
        await client.query('set local role tenant_template_owner')
        await client.query(`set local search_path = ${quoteIdentifier(tenant.schemaName)}, pg_catalog`)
        await client.query(`select set_config('app.tenant_id', $1, true)`, [tenant.tenantId])
        const roles = await client.query<{ count: number }>(
          `select count(*)::int as count from role_definition
            where role_code = any($1::text[])`,
          [['tenant_owner', 'tenant_admin', 'tenant_manager', 'tenant_member', 'tenant_viewer']],
        )
        if (roles.rows[0]?.count !== 5) throw new Error('Tenant role catalog is incomplete after migrations.')
      })
      return
    }
    if (step === 'APPLY_SCHEMA_PRIVILEGES') {
      const manifest = await loadTenantAccessManifest()
      await this.withProvisioner(async (client) => {
        await client.query('set local role tenant_template_owner')
        await applyTenantAccessManifest(client, manifest, {
          schemaName: tenant.schemaName,
          runtimeRole: tenant.dbRole,
          loginRole: tenant.loginRole,
        })
      })
      return
    }
    if (step === 'CONFIGURE_ROLE_SEARCH_PATH') {
      // The shared pool login serves many schemas; its search_path is set per
      // transaction by the tenant BFF instead.
      if (tenant.connectionTier === 'pooled') return
      await this.withProvisioner(async (client) => {
        await client.query(
          `alter role ${quoteIdentifier(tenant.loginRole)} set search_path = ${quoteIdentifier(tenant.schemaName)}, pg_catalog`,
        )
      })
      return
    }
    if (step === 'REGISTER_DATABASE_ACCESS') {
      // tenant_pool_login is registered with PgBouncer once, by operations.
      if (tenant.connectionTier === 'pooled') return
      await this.assertLeaseActive(tenant)
      const credential = await this.ensureCredential(tenant)
      const current = await readFile(config.pgbouncerAuthFile, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return ''
      })
      const line = `"${tenant.loginRole}" "${credential.scramVerifier}"`
      const lines = current.split(/\r?\n/).filter(Boolean).filter((item) => !item.startsWith(`"${tenant.loginRole}" `))
      lines.push(line)
      lines.sort()
      await atomicWrite(config.pgbouncerAuthFile, `${lines.join('\n')}\n`)
      if (config.pgbouncerAdminUser && process.env.TENANT_PGBOUNCER_RELOAD_DISABLED !== 'true') {
        const admin = new pg.Client({
          host: config.pgbouncerHost,
          port: config.pgbouncerPort,
          database: 'pgbouncer',
          user: config.pgbouncerAdminUser,
          password: config.pgbouncerAdminPassword,
          connectionTimeoutMillis: 5_000,
          query_timeout: 15_000,
        })
        await admin.connect()
        try {
          await admin.query('reload')
        } finally {
          await admin.end()
        }
      }
      await this.assertLeaseActive(tenant)
      return
    }
    if (step === 'REGISTER_TENANT_DOMAIN') {
      await this.withProvisioner(async (client) => {
        const result = await client.query<{ hostname: string }>(
          'select hostname from platform.tenant_domain where tenant_id = $1 and is_primary',
          [tenant.tenantId],
        )
        if (result.rows[0]?.hostname !== tenant.hostname) throw new Error('Primary tenant hostname is not registered.')
      })
      return
    }
    if (step === 'STORE_TENANT_BRANDING') {
      await this.withProvisioner(async (client) => {
        const result = await client.query<{ exists: boolean }>(
          'select exists(select 1 from platform.tenant_branding where tenant_id = $1)',
          [tenant.tenantId],
        )
        if (!result.rows[0]?.exists) throw new Error('Tenant branding record is missing.')
      })
      return
    }
    if (step === 'VERIFY_DATABASE_ISOLATION') {
      const credential = await this.loginCredential(tenant)
      const client = new pg.Client({
        host: credential.host,
        port: credential.port,
        database: credential.database,
        user: credential.loginRole,
        password: credential.password,
        connectionTimeoutMillis: 5_000,
        query_timeout: 30_000,
      })
      await client.connect()
      try {
        await assertPermissionDenied(
          client,
          `select 1 from ${quoteIdentifier(tenant.schemaName)}.user_account limit 1`,
        )
        await client.query('begin')
        await client.query(`set local role ${quoteIdentifier(tenant.dbRole)}`)
        await client.query(`select set_config('app.tenant_id', $1, true)`, [tenant.tenantId])
        await client.query(`select 1 from ${quoteIdentifier(tenant.schemaName)}.schema_metadata limit 1`)
        const otherTenants = await this.withProvisioner(async (provisioner) => {
          const result = await provisioner.query<{ schema_identifier: string }>(
            `select schema_identifier from platform.tenant_registry
              where tenant_id <> $1 and lifecycle_status in ('active', 'suspended')`,
            [tenant.tenantId],
          )
          return result.rows.map((row) => row.schema_identifier)
        })
        const forbiddenTargets: Array<[string, string]> = [
          ['platform', 'schema_migration'],
          ['consumer', 'user_account'],
          ...otherTenants.map((schema): [string, string] => [schema, 'user_account']),
        ]
        for (const [forbiddenSchema, forbiddenTable] of forbiddenTargets) {
          try {
            await client.query(
              `select 1 from ${quoteIdentifier(forbiddenSchema)}.${quoteIdentifier(forbiddenTable)} limit 1`,
            )
            throw new Error(`Tenant runtime unexpectedly accessed ${forbiddenSchema}.`)
          } catch (error) {
            const errCode = (error as { code?: string }).code
            if (errCode !== '42501' && errCode !== '42P01' && errCode !== '3F000') throw error
            await client.query('rollback')
            await client.query('begin')
            await client.query(`set local role ${quoteIdentifier(tenant.dbRole)}`)
            await client.query(`select set_config('app.tenant_id', $1, true)`, [tenant.tenantId])
          }
        }
        await client.query('rollback')
      } finally {
        await client.end()
      }
      return
    }
    if (step === 'VERIFY_TENANT_RESOLUTION') {
      await this.withProvisioner(async (client) => {
        const result = await client.query<{ tenant_id: string }>(
          `select t.tenant_id::text from platform.tenant_domain d
             join platform.tenant_registry t on t.tenant_id = d.tenant_id
            where lower(d.hostname) = lower($1) and d.tenant_id = $2`,
          [tenant.hostname, tenant.tenantId],
        )
        if (result.rows[0]?.tenant_id !== tenant.tenantId) throw new Error('Tenant hostname resolution verification failed.')
      })
      return
    }
    if (step === 'VERIFY_TENANT_LOGIN_CONTEXT') {
      const credential = await this.loginCredential(tenant)
      const client = new pg.Client({
        host: credential.host,
        port: credential.port,
        database: credential.database,
        user: credential.loginRole,
        password: credential.password,
        connectionTimeoutMillis: 5_000,
        query_timeout: 30_000,
      })
      await client.connect()
      try {
        const identity = await client.query<{ current_user: string }>('select current_user')
        if (identity.rows[0]?.current_user !== tenant.loginRole) {
          throw new Error('Tenant login identity verification failed.')
        }
        await client.query(`select set_config('app.tenant_id', $1, false)`, [tenant.tenantId])
        await client.query(`select 1 from ${quoteIdentifier(tenant.schemaName)}.user_session limit 0`)
        await assertPermissionDenied(
          client,
          `select 1 from ${quoteIdentifier(tenant.schemaName)}.user_account limit 1`,
        )
      } finally {
        await client.end()
      }
      return
    }
    if (step === 'ACTIVATE_TENANT_DOMAIN') {
      await this.withProvisioner(async (client) => {
        await client.query(
          `update platform.tenant_domain set status = 'active' where tenant_id = $1`,
          [tenant.tenantId],
        )
      })
      return
    }
    if (step === 'VERIFY_EDGE_REACHABILITY') {
      if (process.env.TENANT_EDGE_VERIFY_DISABLED === 'true') {
        await this.withProvisioner(async (client) => {
          await client.query(
            `update platform.tenant_domain set verified_at = now() where tenant_id = $1`,
            [tenant.tenantId],
          )
        })
        return
      }
      const url = `https://${tenant.hostname}/api/v1/tenant/info`
      let response: Response
      try {
        response = await fetch(url, { signal: AbortSignal.timeout(config.edgeVerifyTimeoutMs) })
      } catch (error) {
        throw new Error(`Tenant hostname is not reachable over the public edge: ${(error as Error).message}`)
      }
      if (!response.ok) throw new Error(`Tenant hostname returned HTTP ${response.status} over the public edge.`)
      const body = (await response.json()) as { success?: boolean; tenant?: { tenantId?: string } }
      if (!body.success || body.tenant?.tenantId !== tenant.tenantKey) {
        throw new Error('Tenant hostname resolved to a different or unrecognized tenant over the public edge.')
      }
      await this.withProvisioner(async (client) => {
        await client.query(
          `update platform.tenant_domain set verified_at = now() where tenant_id = $1`,
          [tenant.tenantId],
        )
      })
      return
    }
    if (step === 'ACTIVATE_TENANT') {
      await this.withProvisioner(async (client) => {
        await client.query('set local role tenant_template_owner')
        const versionResult = await client.query<{ schema_version: number }>(
          `select schema_version from ${quoteIdentifier(tenant.schemaName)}.schema_metadata where singleton = true`,
        )
        const activeVersion = Number(versionResult.rows[0]?.schema_version || 1)
        await client.query('set local role tenant_provisioner')
        await client.query(
          `update platform.tenant_registry
              set lifecycle_status = 'active', schema_version = $2, activated_at = coalesce(activated_at, now()),
                  last_error_code = null, last_error_at = null
            where tenant_id = $1`,
          [tenant.tenantId, activeVersion],
        )
      })
    }
  }

  private async executeDeprovisionStep(tenant: ProvisioningTenant, step: StepCode): Promise<void> {
    if (step === 'DEPROV_VALIDATE_ELIGIBLE') {
      this.validateTenant(tenant)
      await this.withProvisioner(async (client) => {
        const result = await client.query<{ eligible: boolean }>(
          `select lifecycle_status in ('suspended', 'deleting') as eligible
             from platform.tenant_registry where tenant_id = $1`,
          [tenant.tenantId],
        )
        if (!result.rows[0]?.eligible) throw new Error('Tenant is not in a removable state.')
      })
      return
    }
    if (step === 'DEPROV_MARK_DELETING') {
      await this.withProvisioner(async (client) => {
        await client.query(
          `update platform.tenant_registry set lifecycle_status = 'deleting'
            where tenant_id = $1 and lifecycle_status in ('suspended', 'deleting')`,
          [tenant.tenantId],
        )
        await client.query(
          `update platform.tenant_domain set status = 'disabled' where tenant_id = $1`,
          [tenant.tenantId],
        )
      })
      return
    }
    if (step === 'DEPROV_REVOKE_DATABASE_ACCESS') {
      // Never remove the shared pool login's PgBouncer entry.
      if (tenant.connectionTier === 'pooled') return
      const current = await readFile(config.pgbouncerAuthFile, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return ''
      })
      const lines = current.split(/\r?\n/).filter(Boolean).filter((item) => !item.startsWith(`"${tenant.loginRole}" `))
      await atomicWrite(config.pgbouncerAuthFile, lines.length ? `${lines.join('\n')}\n` : '')
      if (config.pgbouncerAdminUser && process.env.TENANT_PGBOUNCER_RELOAD_DISABLED !== 'true') {
        const admin = new pg.Client({
          host: config.pgbouncerHost,
          port: config.pgbouncerPort,
          database: 'pgbouncer',
          user: config.pgbouncerAdminUser,
          password: config.pgbouncerAdminPassword,
          connectionTimeoutMillis: 5_000,
          query_timeout: 15_000,
        })
        await admin.connect()
        try {
          await admin.query('reload')
        } finally {
          await admin.end()
        }
      }
      return
    }
    if (step === 'DEPROV_DROP_SCHEMA') {
      await this.assertLeaseActive(tenant)
      if (tenant.jobType !== 'deprovision') {
        throw new Error('Destructive drop schema requested outside deprovisioning job.')
      }
      await this.withProvisioner(async (client) => {
        const verifyRes = await client.query<{
          schema_identifier: string
          db_role: string
          login_role: string
          lifecycle_status: string
        }>(
          `select schema_identifier, db_role, login_role, lifecycle_status
             from platform.tenant_registry
            where tenant_id = $1 and tenant_key = $2`,
          [tenant.tenantId, tenant.tenantKey],
        )
        const row = verifyRes.rows[0]
        if (
          !row ||
          row.schema_identifier !== tenant.schemaName ||
          row.db_role !== tenant.dbRole ||
          row.login_role !== tenant.loginRole ||
          row.lifecycle_status !== 'deleting'
        ) {
          throw new Error('Tenant identity verification failed before schema deletion.')
        }
        await client.query('set local role tenant_template_owner')
        await client.query(`drop schema if exists ${quoteIdentifier(tenant.schemaName)} cascade`)
      })
      await this.assertLeaseActive(tenant)
      return
    }
    if (step === 'DEPROV_DROP_DATABASE_ROLE') {
      await this.assertLeaseActive(tenant)
      if (tenant.jobType !== 'deprovision') {
        throw new Error('Destructive drop role requested outside deprovisioning job.')
      }
      await this.withProvisioner(async (client) => {
        const verifyRes = await client.query<{
          db_role: string
          login_role: string
          lifecycle_status: string
        }>(
          `select db_role, login_role, lifecycle_status
             from platform.tenant_registry
            where tenant_id = $1 and tenant_key = $2`,
          [tenant.tenantId, tenant.tenantKey],
        )
        const row = verifyRes.rows[0]
        if (
          !row ||
          row.db_role !== tenant.dbRole ||
          row.login_role !== tenant.loginRole ||
          row.lifecycle_status !== 'deleting'
        ) {
          throw new Error('Tenant identity verification failed before role deletion.')
        }
        // A pooled tenant's login_role is the shared tenant_pool_login: drop
        // only the tenant's own runtime role (which also ends the membership).
        if (tenant.connectionTier === 'dedicated') {
          await client.query(`drop role if exists ${quoteIdentifier(tenant.loginRole)}`)
        }
        await client.query(`drop role if exists ${quoteIdentifier(tenant.dbRole)}`)
      })
      await this.assertLeaseActive(tenant)
      return
    }
    if (step === 'DEPROV_REMOVE_CREDENTIAL_FILE') {
      await this.assertLeaseActive(tenant)
      await unlink(this.credentialPath(tenant)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
      await this.assertLeaseActive(tenant)
      return
    }
    if (step === 'DEPROV_REMOVE_LOCAL_STORAGE') {
      // Files in a tenant-owned bucket belong to the tenant and are left there.
      await this.assertLeaseActive(tenant)
      await removeLocalTenantStorage(tenant.tenantKey)
      return
    }
    if (step === 'DEPROV_FINALIZE') {
      await this.withProvisioner(async (client) => {
        await client.query(
          `update platform.tenant_registry
              set lifecycle_status = 'deleted', last_error_code = null, last_error_at = null,
                  storage_integration_id = null, data_integration_id = null
            where tenant_id = $1`,
          [tenant.tenantId],
        )
        await client.query(
          `update platform.tenant_integration set status = 'retired', retired_at = now()
            where tenant_id = $1 and status <> 'retired'`,
          [tenant.tenantId],
        )
      })
    }
  }


  // -------------------------------------------------------------------------
  // Operations started from the admin panel (migration 028)
  // -------------------------------------------------------------------------

  private async placementFor(tenant: ProvisioningTenant, integrationId: string | null) {
    return databasePlacement(this.pool, this.tenantRow(tenant), integrationId)
  }

  private async setLifecycle(tenant: ProvisioningTenant, from: string[], to: string): Promise<void> {
    await this.withProvisioner(async (client) => {
      await client.query(
        `update platform.tenant_registry set lifecycle_status = $1
          where tenant_id = $2 and lifecycle_status = any($3::text[])`,
        [to, tenant.tenantId, from],
      )
    })
  }

  private relocationTarget(tenant: ProvisioningTenant): string | null {
    const target = tenant.jobParams.targetIntegrationId
    if (target === null || target === undefined) return null
    if (typeof target !== 'string' || !/^[0-9a-f-]{36}$/.test(target)) throw new Error('Relocation target is invalid.')
    return target
  }

  private async executeOperationStep(tenant: ProvisioningTenant, step: StepCode): Promise<void> {
    switch (step) {
      case 'MIGRATE_VALIDATE': {
        const status = await this.withProvisioner(async (client) =>
          (await client.query<{ lifecycle_status: string }>('select lifecycle_status from platform.tenant_registry where tenant_id = $1', [tenant.tenantId])).rows[0]?.lifecycle_status,
        )
        if (!status || !['active', 'suspended', 'migration_failed'].includes(status)) throw new Error(`Tenant cannot be upgraded while ${status}.`)
        return
      }
      case 'MIGRATE_APPLY': {
        const placement = await this.placementFor(tenant, tenant.dataIntegrationId)
        const result = await upgradePlacement(this.pool, placement, tenant.tenantId)
        tenant.jobParams.resultVersion = result.version
        return
      }
      case 'MIGRATE_FINALIZE': {
        const placement = await this.placementFor(tenant, tenant.dataIntegrationId)
        const version = (await upgradePlacement(this.pool, placement, tenant.tenantId)).version
        await this.withProvisioner(async (client) => {
          await client.query(
            `update platform.tenant_registry
                set schema_version = $1, last_error_code = null, last_error_at = null,
                    lifecycle_status = case when lifecycle_status = 'migration_failed' then 'active' else lifecycle_status end
              where tenant_id = $2`,
            [version, tenant.tenantId],
          )
        })
        return
      }
      case 'RELOC_VALIDATE': {
        const target = this.relocationTarget(tenant)
        if (target === tenant.dataIntegrationId) throw new Error('The tenant already uses that database.')
        if (target) {
          const ready = await this.withProvisioner(async (client) =>
            (await client.query<{ ready: boolean }>('select platform.integration_ready($1, $2, $3) as ready', [target, tenant.tenantId, 'database'])).rows[0]?.ready,
          )
          if (!ready) throw new Error('The target database has no recent successful connection test.')
        }
        return
      }
      case 'RELOC_PREPARE_TARGET': {
        const target = await this.placementFor(tenant, this.relocationTarget(tenant))
        const source = await this.placementFor(tenant, tenant.dataIntegrationId)
        // Both sides must be on the same, latest schema version before copying.
        await upgradePlacement(this.pool, source, tenant.tenantId)
        await upgradePlacement(this.pool, target, tenant.tenantId)
        return
      }
      case 'RELOC_COPY_DATA': {
        const source = await this.placementFor(tenant, tenant.dataIntegrationId)
        const target = await this.placementFor(tenant, this.relocationTarget(tenant))
        const counts = await copyTenantData(this.pool, source, target, tenant.tenantId)
        console.log(`[tenant-provisioner] relocated ${tenant.tenantKey}: ${JSON.stringify(counts)}`)
        return
      }
      case 'RELOC_SWITCH': {
        const target = this.relocationTarget(tenant)
        await this.withProvisioner(async (client) => {
          await client.query(
            `update platform.tenant_integration set status = 'verified', activated_at = null
              where tenant_id = $1 and kind = 'database' and status = 'active'`,
            [tenant.tenantId],
          )
          if (target) {
            await client.query(
              `update platform.tenant_integration set status = 'active', activated_at = now() where integration_id = $1 and tenant_id = $2`,
              [target, tenant.tenantId],
            )
          }
          await client.query('update platform.tenant_registry set data_integration_id = $1 where tenant_id = $2', [target, tenant.tenantId])
        })
        tenant.jobParams.previousIntegrationId = tenant.dataIntegrationId
        tenant.dataIntegrationId = target
        return
      }
      case 'RELOC_PURGE_SOURCE': {
        // Only the platform's own VDS copy is purged. A tenant-owned database
        // is never modified after the tenant leaves it.
        const previous = await this.withProvisioner(async (client) =>
          (await client.query<{ data_integration_id: string | null }>(
            'select data_integration_id::text from platform.tenant_registry where tenant_id = $1', [tenant.tenantId],
          )).rows[0]?.data_integration_id,
        )
        if (previous && tenant.jobParams.purgeSource !== false) {
          await purgeTenantData(this.pool, await this.placementFor(tenant, null), tenant.tenantId)
        }
        return
      }
      case 'RELOC_EXIT_MAINTENANCE': {
        await this.setLifecycle(tenant, ['relocating'], 'active')
        return
      }
      case 'STORAGE_VALIDATE': {
        await this.withProvisioner(async (client) => {
          const row = (await client.query<{ storage_integration_id: string | null; lifecycle_status: string }>(
            'select storage_integration_id::text, lifecycle_status from platform.tenant_registry where tenant_id = $1', [tenant.tenantId],
          )).rows[0]
          if (!row || row.lifecycle_status !== 'active') throw new Error('Tenant must be active to move files.')
          tenant.storageIntegrationId = row.storage_integration_id
        })
        return
      }
      case 'STORAGE_COPY_OBJECTS': {
        const placement = await this.placementFor(tenant, tenant.dataIntegrationId)
        const current = await this.withProvisioner(async (client) =>
          (await client.query<{ storage_integration_id: string | null }>(
            'select storage_integration_id::text from platform.tenant_registry where tenant_id = $1', [tenant.tenantId],
          )).rows[0]?.storage_integration_id ?? null,
        )
        const result = await relocateStoredObjects(this.pool, { ...this.tenantRow(tenant), storage_integration_id: current }, placement, () =>
          this.assertLeaseActive(tenant),
        )
        console.log(`[tenant-provisioner] moved ${result.moved} object(s) for ${tenant.tenantKey}`)
        return
      }
      case 'STORAGE_FINALIZE':
        return
      default:
        throw new Error(`Unknown operation step ${step}.`)
    }
  }

  private stepsFor(jobType: JobType): ReadonlyArray<readonly [string, string]> {
    if (jobType === 'provision') return stepDefinitions
    if (jobType === 'deprovision') return deprovisionStepDefinitions
    return operationSteps[jobType as OperationType].map((step) => [step.code, step.message] as const)
  }

  private async succeed(tenant: ProvisioningTenant): Promise<void> {
    const isDeprovision = tenant.jobType === 'deprovision'
    await this.withProvisioner(async (client) => {
      const res = await client.query(
        `update platform.tenant_provisioning_job
            set status = 'succeeded', current_step = $1, completed_at = now(),
                worker_id = null, locked_at = null
          where job_id = $2 and worker_id = $3 and status = 'running'`,
        [this.stepsFor(tenant.jobType).at(-1)![0], tenant.jobId, config.workerId],
      )
      if (res.rowCount !== 1) {
        throw new Error('Provisioning worker lease was lost.')
      }
      await client.query(
        `insert into platform.platform_audit
           (tenant_id, feature, action, status, resource_type, resource_id, correlation_id, policy_decision)
         values ($1, 'tenant_provisioning', $2, 'success', 'tenant', $3, $4, 'allow')`,
        [
          tenant.tenantId,
          isDeprovision ? 'tenant_deleted' : tenant.jobType === 'provision' ? 'tenant_activated' : `${tenant.jobType}_succeeded`,
          tenant.tenantKey,
          tenant.correlationId,
        ],
      )
    })
  }

  private async fail(tenant: ProvisioningTenant, error: unknown): Promise<void> {
    const isDeprovision = tenant.jobType === 'deprovision'
    // Operation failures carry their reason (target not empty, test expired,
    // unreachable endpoint) because the operator or owner must act on it.
    const reason = error instanceof Error ? error.message.replace(/password=[^\s]+/gi, 'password=[redacted]').slice(0, 300) : ''
    const safeMessage = isDeprovision
      ? 'Tenant removal stopped at a recoverable infrastructure step. Retry is available.'
      : operationJobTypes.has(tenant.jobType)
        ? `Operation stopped: ${reason || 'unexpected error'}. Retry is available.`
        : 'Provisioning stopped at a recoverable infrastructure step. Retry is available.'
    const errorCode = error instanceof Error ? error.name.slice(0, 64) : 'ProvisioningError'
    await this.withProvisioner(async (client) => {
      // First lock and update the owned running job with RETURNING
      const jobRes = await client.query<{ job_id: string }>(
        `update platform.tenant_provisioning_job
            set status = 'failed', safe_error_code = $1, safe_error_message = $2,
                retryable = true, completed_at = now(), worker_id = null, locked_at = null
          where job_id = $3 and worker_id = $4 and status = 'running'
          returning job_id`,
        [errorCode, safeMessage, tenant.jobId, config.workerId],
      )
      if (jobRes.rowCount !== 1) {
        console.warn(`[tenant-provisioner] Lease lost for job ${tenant.jobId}; discarding fail mutations.`)
        return
      }

      await client.query(
        `update platform.tenant_provisioning_step
            set status = 'failed', safe_error_message = $1, completed_at = now()
          where job_id = $2 and step_code = (
            select current_step from platform.tenant_provisioning_job where job_id = $2
          )`,
        [safeMessage, tenant.jobId],
      )
      if (isDeprovision) {
        await client.query(
          `update platform.tenant_registry
              set lifecycle_status = 'deletion_failed', last_error_code = $1, last_error_at = now()
            where tenant_id = $2 and lifecycle_status = 'deleting'`,
          [errorCode, tenant.tenantId],
        )
      } else if (tenant.jobType === 'migrate') {
        await client.query(
          `update platform.tenant_registry
              set lifecycle_status = case when lifecycle_status = 'suspended' then 'suspended' else 'migration_failed' end,
                  last_error_code = $1, last_error_at = now()
            where tenant_id = $2`,
          [errorCode, tenant.tenantId],
        )
      } else if (tenant.jobType === 'relocate_database') {
        // Until RELOC_SWITCH succeeds the source is still authoritative, so
        // the tenant goes back online on it. Any copy made so far is redone
        // on retry because the tenant may have written new data meanwhile.
        await client.query(
          `update platform.tenant_provisioning_step set status = 'pending', completed_at = null
            where job_id = $1 and step_code in ('RELOC_PREPARE_TARGET', 'RELOC_COPY_DATA')
              and not exists (select 1 from platform.tenant_provisioning_step
                               where job_id = $1 and step_code = 'RELOC_SWITCH' and status = 'succeeded')`,
          [tenant.jobId],
        )
        await client.query(
          `update platform.tenant_registry set lifecycle_status = 'active', last_error_code = $1, last_error_at = now()
            where tenant_id = $2 and lifecycle_status = 'relocating'`,
          [errorCode, tenant.tenantId],
        )
      } else if (tenant.jobType === 'relocate_storage') {
        await client.query(
          'update platform.tenant_registry set last_error_code = $1, last_error_at = now() where tenant_id = $2',
          [errorCode, tenant.tenantId],
        )
      } else {
        await client.query(
          `update platform.tenant_registry
              set lifecycle_status = 'provisioning_failed', last_error_code = $1, last_error_at = now()
            where tenant_id = $2 and lifecycle_status <> 'active'`,
          [errorCode, tenant.tenantId],
        )
      }
      await client.query(
        `insert into platform.platform_audit
           (tenant_id, feature, action, status, resource_type, resource_id, correlation_id, policy_decision)
         values ($1, 'tenant_provisioning', $2, 'failed', 'tenant', $3, $4, 'denied')`,
        [
          tenant.tenantId,
          isDeprovision ? 'deprovisioning_failed' : tenant.jobType === 'provision' ? 'provisioning_failed' : `${tenant.jobType}_failed`,
          tenant.tenantKey,
          tenant.correlationId,
        ],
      )
    })
    console.error(`[tenant-provisioner] job ${tenant.jobId} failed at a protected step`, error)
  }

  async tick(): Promise<boolean> {
    if (this.running) return false
    this.running = true
    try {
      const tenant = await this.acquireJob()
      if (!tenant) return false
      try {
        if (tenant.jobType === 'relocate_database') {
          // Every attempt starts in maintenance so no write can land on the
          // source after the copy begins.
          await this.setLifecycle(tenant, ['active', 'relocating'], 'relocating')
          await new Promise((resolve) => setTimeout(resolve, Number(process.env.TENANT_RELOCATION_DRAIN_MS || 3_000)))
        }
        for (const [step] of this.stepsFor(tenant.jobType)) await this.runStep(tenant, step)
        await this.succeed(tenant)
      } catch (error) {
        await this.fail(tenant, error)
      }
      return true
    } finally {
      this.running = false
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

export const WORKER_SESSION_ADVISORY_LOCK_KEY = 'skeleton-tenant-provisioner-worker'

export async function acquireWorkerDatabaseLock(databaseUrl: string): Promise<{
  client: pg.Client
  release: () => Promise<void>
}> {
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  const res = await client.query<{ locked: boolean }>(
    'select pg_try_advisory_lock(hashtext($1)) as locked',
    [WORKER_SESSION_ADVISORY_LOCK_KEY],
  )
  if (!res.rows[0]?.locked) {
    await client.end().catch(() => {})
    throw new Error('Another tenant provisioner worker process currently holds the database advisory lock.')
  }

  let released = false
  const release = async () => {
    if (released) return
    released = true
    try {
      await client.query('select pg_advisory_unlock(hashtext($1))', [WORKER_SESSION_ADVISORY_LOCK_KEY])
    } catch {}
    await client.end().catch(() => {})
  }

  client.on('error', (err) => {
    console.error('[tenant-provisioner] Fatal: lost connection to advisory lock database', err)
    process.exit(1)
  })

  return { client, release }
}

async function main(): Promise<void> {
  const { release: releaseLock } = await acquireWorkerDatabaseLock(config.databaseUrl)
  const worker = new TenantProvisioningWorker()
  await worker.assertIdentity()
  if (process.argv.includes('--once')) {
    try {
      await worker.tick()
    } finally {
      await worker.close()
      await releaseLock()
    }
    return
  }
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    await worker.close()
    await releaseLock()
    process.exit(0)
  }
  process.on('SIGINT', () => void stop())
  process.on('SIGTERM', () => void stop())
  while (!stopping) {
    await worker.tick()
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs))
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error('[tenant-provisioner] fatal startup error', error)
    process.exit(1)
  })
}

export { stepDefinitions }
