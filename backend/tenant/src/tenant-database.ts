import { readFile } from 'node:fs/promises'
import path from 'node:path'
import pg, { type PoolClient, type QueryResult, type QueryResultRow } from 'pg'
import type { TenantContext } from './tenant-context.js'

const identifierPattern = /^[a-z][a-z0-9_]{2,62}$/
const credentialRefPattern = /^[A-Z0-9]{6,64}$/

type TenantCredential = {
  tenantId: string
  tenantKey: string
  schemaName: string
  dbRole: string
  loginRole: string
  password: string
  database: string
  host: string
  port: number
}

/** Connection settings for a tenant whose data lives in its own database. */
export type ExternalConnection = {
  integrationId: string
  schema: string
  config: pg.PoolConfig
}

export type ExternalConnectionLoader = (context: TenantContext) => Promise<ExternalConnection>

type ManagedPool = {
  pool: pg.Pool
  /** Identifies what this pool is bound to; a mismatch forces a rebuild. */
  binding: string
  lastUsedAt: number
}

function quoteIdentifier(value: string): string {
  if (!identifierPattern.test(value)) throw new Error('Trusted tenant database identifier is invalid.')
  return `"${value}"`
}

/**
 * Hands out tenant-bound transactions. Three connection paths:
 *   dedicated  the tenant's own login role (credential file) via PgBouncer;
 *   pooled     the shared tenant_pool_login via one PgBouncer pool, switching
 *              into the tenant's runtime role per transaction;
 *   external   the tenant's own PostgreSQL (bring-your-own), directly, over a
 *              policy-checked and pinned address, as the tenant-supplied user.
 * Every transaction sets and verifies the tenant context that forced RLS
 * checks, so a pooled connection can never carry one tenant's context into
 * another tenant's request.
 */
export class TenantDatabaseManager {
  private readonly pools = new Map<string, ManagedPool>()
  private readonly poolCreations = new Map<string, Promise<ManagedPool>>()
  private mutationTail: Promise<void> = Promise.resolve()
  private sharedPool: pg.Pool | null = null

  constructor(
    private readonly credentialsDirectory: string,
    private readonly maximumPools = 100,
    private readonly options: {
      poolDatabaseUrl?: string | undefined
      poolSize?: number
      loadExternal?: ExternalConnectionLoader
    } = {},
  ) {}

  private async loadCredential(context: TenantContext): Promise<TenantCredential> {
    if (!credentialRefPattern.test(context.credentialRef)) {
      throw new Error('Tenant credential reference is invalid.')
    }
    const credentialPath = path.join(this.credentialsDirectory, `${context.credentialRef}.json`)
    const relative = path.relative(this.credentialsDirectory, credentialPath)
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Tenant credential path is invalid.')
    const credential = JSON.parse(await readFile(credentialPath, 'utf8')) as TenantCredential
    if (
      credential.tenantId !== context.tenantId ||
      credential.tenantKey !== context.tenantKey ||
      credential.schemaName !== context.schemaName ||
      credential.dbRole !== context.dbRole ||
      credential.loginRole !== context.loginRole
    ) {
      throw new Error('Tenant credential binding does not match the resolved tenant context.')
    }
    quoteIdentifier(credential.schemaName)
    quoteIdentifier(credential.dbRole)
    quoteIdentifier(credential.loginRole)
    return credential
  }

  private placement(context: TenantContext): 'dedicated' | 'pooled' | 'external' {
    if (context.dataIntegrationId) return 'external'
    return context.connectionTier === 'pooled' ? 'pooled' : 'dedicated'
  }

  private bindingFor(context: TenantContext): string {
    const placement = this.placement(context)
    if (placement === 'external') return `external:${context.dataIntegrationId}:${context.dataSchema}`
    return `dedicated:${context.credentialRef}:${context.tenantId}:${context.schemaName}:${context.dbRole}:${context.loginRole}`
  }

  private async withMutationLock<T>(callback: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail
    let release = () => {}
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await callback()
    } finally {
      release()
    }
  }

  private async sharedPooledPool(): Promise<pg.Pool> {
    if (this.sharedPool) return this.sharedPool
    return this.withMutationLock(async () => {
      if (this.sharedPool) return this.sharedPool
      if (!this.options.poolDatabaseUrl) throw new Error('TENANT_POOL_DATABASE_URL is required for pooled tenants.')
      const pool = new pg.Pool({
        connectionString: this.options.poolDatabaseUrl,
        max: this.options.poolSize ?? 20,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
        query_timeout: 30_000,
        application_name: 'tenant-bff:pooled',
      })
      const identity = await pool.query<{ current_user: string }>('select current_user')
      if (identity.rows[0]?.current_user !== 'tenant_pool_login') {
        await pool.end()
        throw new Error('TENANT_POOL_DATABASE_URL must authenticate as tenant_pool_login.')
      }
      this.sharedPool = pool
      return pool
    })
  }

  private async createPool(context: TenantContext, binding: string): Promise<ManagedPool> {
    return this.withMutationLock(async () => {
      const current = this.pools.get(context.tenantId)
      if (current && current.binding === binding) {
        current.lastUsedAt = Date.now()
        return current
      }
      if (current) {
        this.pools.delete(context.tenantId)
        await current.pool.end()
      }
      if (this.pools.size >= this.maximumPools) {
        const oldest = [...this.pools.entries()]
          .filter(([, managed]) => managed.pool.totalCount === managed.pool.idleCount && managed.pool.waitingCount === 0)
          .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0]
        if (!oldest) throw new Error('Tenant database pool capacity is temporarily exhausted.')
        this.pools.delete(oldest[0])
        await oldest[1].pool.end()
      }
      let pool: pg.Pool
      if (this.placement(context) === 'external') {
        if (!this.options.loadExternal) throw new Error('External tenant databases are not configured on this server.')
        const external = await this.options.loadExternal(context)
        if (external.schema !== context.dataSchema) throw new Error('External database binding does not match the tenant context.')
        pool = new pg.Pool({ ...external.config, max: 2, idleTimeoutMillis: 30_000, application_name: `tenant-bff:${context.tenantKey}` })
        await pool.query('select 1')
      } else {
        const credential = await this.loadCredential(context)
        pool = new pg.Pool({
          host: credential.host,
          port: credential.port,
          database: credential.database,
          user: credential.loginRole,
          password: credential.password,
          max: 2,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000,
          query_timeout: 30_000,
          application_name: `tenant-bff:${context.tenantKey}`,
        })
        const identity = await pool.query<{ current_user: string }>('select current_user')
        if (identity.rows[0]?.current_user !== context.loginRole) {
          await pool.end()
          throw new Error('Tenant database login identity verification failed.')
        }
      }
      const managed = { pool, binding, lastUsedAt: Date.now() }
      this.pools.set(context.tenantId, managed)
      return managed
    })
  }

  private async poolFor(context: TenantContext): Promise<pg.Pool> {
    if (this.placement(context) === 'pooled') return this.sharedPooledPool()
    const binding = this.bindingFor(context)
    const existing = this.pools.get(context.tenantId)
    if (existing && existing.binding === binding) {
      existing.lastUsedAt = Date.now()
      return existing.pool
    }
    const key = `${context.tenantId}|${binding}`
    const pending = this.poolCreations.get(key)
    if (pending) return (await pending).pool
    const creation = this.createPool(context, binding)
    this.poolCreations.set(key, creation)
    try {
      return (await creation).pool
    } finally {
      this.poolCreations.delete(key)
    }
  }

  private async transaction<T>(context: TenantContext, callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const pool = await this.poolFor(context)
    const client = await pool.connect()
    let releaseError: Error | undefined
    try {
      await client.query('begin')
      const result = await callback(client)
      await client.query('commit')
      return result
    } catch (error) {
      try {
        await client.query('rollback')
      } catch (rollbackError) {
        releaseError = rollbackError instanceof Error ? rollbackError : new Error('Tenant rollback failed.')
      }
      throw error
    } finally {
      client.release(releaseError)
    }
  }

  /**
   * Session bookkeeping on the login connection (no runtime-role switch):
   * dedicated and pooled logins hold user_session privileges directly;
   * external databases have a single user.
   */
  async directQuery<T extends QueryResultRow = QueryResultRow>(
    context: TenantContext,
    query: string,
    values: unknown[] = [],
  ): Promise<QueryResult<T>> {
    return this.transaction(context, async (client) => {
      await client.query(`select set_config('app.tenant_id', $1, true)`, [context.tenantId])
      return client.query<T>(query, values)
    })
  }

  async withTenant<T>(context: TenantContext, callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const placement = this.placement(context)
    const schema = quoteIdentifier(context.dataSchema)
    return this.transaction(context, async (client) => {
      if (placement !== 'external') await client.query(`set local role ${quoteIdentifier(context.dbRole)}`)
      await client.query(`set local search_path = ${schema}, pg_catalog`)
      await client.query(`select set_config('app.tenant_id', $1, true)`, [context.tenantId])
      const verification = await client.query<{
        current_user: string
        database_tenant: string
        configured_tenant: string | null
        database_tenant_id: string | null
      }>(
        `select current_user, current_schema() as database_tenant,
                current_setting('app.tenant_id', true) as configured_tenant,
                (select to_jsonb(schema_metadata)->>'tenant_id'
                   from schema_metadata
                  where singleton = true) as database_tenant_id`,
      )
      const row = verification.rows[0]
      if (
        (placement !== 'external' && row?.current_user !== context.dbRole) ||
        row?.database_tenant !== context.dataSchema ||
        row?.configured_tenant !== context.tenantId ||
        // An external schema must already carry this tenant's identity; a VDS
        // legacy schema may predate the column.
        (placement === 'external' ? row?.database_tenant_id !== context.tenantId
          : row?.database_tenant_id !== null && row?.database_tenant_id !== context.tenantId)
      ) {
        throw new Error('Database tenant context verification failed.')
      }
      return callback(client)
    })
  }

  async close(): Promise<void> {
    await Promise.all([...this.pools.values()].map(async ({ pool }) => pool.end()))
    this.pools.clear()
    this.poolCreations.clear()
    if (this.sharedPool) await this.sharedPool.end()
    this.sharedPool = null
  }
}
