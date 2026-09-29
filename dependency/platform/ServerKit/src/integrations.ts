import crypto from 'node:crypto'
import net from 'node:net'
import pg from 'pg'
import { EndpointPolicyError, resolveAllowedAddress, type EndpointPolicy } from './network.js'
import { S3Client, type S3Credentials, type S3Settings } from './s3.js'
import { canonicalJson } from './secrets.js'

/**
 * Bring-your-own integrations. A tenant (or an operator on its behalf) can
 * point the platform at:
 *   - an S3-compatible bucket, used under a dedicated folder (prefix), and
 *   - a PostgreSQL database, used under a dedicated schema ("folder").
 * By default both live on the VDS itself. Nothing is used for real traffic
 * until a connection test has passed for exactly the saved settings.
 */

export type IntegrationKind = 'storage' | 'database'
export type IntegrationProvider = 's3' | 'postgresql'

export type PostgresSettings = {
  host: string
  port: number
  database: string
  schema: string
  sslMode: 'verify-full' | 'require' | 'disable'
  caCert?: string
}

export type PostgresCredentials = { user: string; password: string }

export class IntegrationValidationError extends Error {}

const hostnamePattern = /^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/
const bucketPattern = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/
const schemaPattern = /^[a-z][a-z0-9_]{2,62}$/

function text(input: Record<string, unknown>, key: string, fallback?: string): string {
  const value = input[key]
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback
    throw new IntegrationValidationError(`${key} is required.`)
  }
  if (typeof value !== 'string') throw new IntegrationValidationError(`${key} must be text.`)
  return value.trim()
}

export function normalizeFolderPrefix(value: string): string {
  const trimmed = value.trim().replace(/^\/+/, '').replace(/\/{2,}/g, '/')
  if (!trimmed) return ''
  const prefix = trimmed.endsWith('/') ? trimmed : `${trimmed}/`
  if (prefix.length > 256 || !/^[A-Za-z0-9!_.*'()\-/]+$/.test(prefix) || prefix.split('/').some((part) => part === '..' || part === '.')) {
    throw new IntegrationValidationError('Folder may contain letters, digits and ! _ . * \' ( ) - / only.')
  }
  return prefix
}

export function normalizeS3Settings(raw: unknown): S3Settings {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const region = text(input, 'region', 'us-east-1')
  if (!/^[a-z0-9-]{2,32}$/.test(region)) throw new IntegrationValidationError('Region is invalid.')
  const endpointText = text(input, 'endpoint', `https://s3.${region}.amazonaws.com`)
  let endpoint: URL
  try {
    endpoint = new URL(endpointText)
  } catch {
    throw new IntegrationValidationError('Endpoint must be a URL such as https://s3.example.com.')
  }
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || (endpoint.pathname !== '/' && endpoint.pathname !== '') || endpoint.search || endpoint.hash) {
    throw new IntegrationValidationError('Endpoint must be a bare http(s) origin without path, query or credentials.')
  }
  const bucket = text(input, 'bucket')
  if (!bucketPattern.test(bucket) || bucket.includes('..')) throw new IntegrationValidationError('Bucket name is invalid.')
  const forcePathStyle = input.forcePathStyle === undefined ? true : input.forcePathStyle === true
  return {
    endpoint: endpoint.origin,
    region,
    bucket,
    prefix: normalizeFolderPrefix(text(input, 'prefix', 'skeleton-platform/')),
    forcePathStyle,
  }
}

export function normalizeS3Credentials(raw: unknown): S3Credentials {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const accessKeyId = text(input, 'accessKeyId')
  const secretAccessKey = text(input, 'secretAccessKey')
  if (accessKeyId.length > 128 || !/^[\x21-\x7e]+$/.test(accessKeyId)) throw new IntegrationValidationError('Access key ID is invalid.')
  if (secretAccessKey.length > 256 || !/^[\x21-\x7e]+$/.test(secretAccessKey)) throw new IntegrationValidationError('Secret access key is invalid.')
  return { accessKeyId, secretAccessKey }
}

export function normalizePostgresSettings(raw: unknown): PostgresSettings {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const host = text(input, 'host')
  if (!(net.isIP(host) || hostnamePattern.test(host))) throw new IntegrationValidationError('Host must be a hostname or IP address.')
  const port = input.port === undefined || input.port === '' ? 5432 : Number(input.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new IntegrationValidationError('Port is invalid.')
  const database = text(input, 'database')
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(database)) throw new IntegrationValidationError('Database name is invalid.')
  const schema = text(input, 'schema', 'skeleton_platform').toLowerCase()
  if (!schemaPattern.test(schema) || schema.startsWith('pg_') || schema === 'public' || schema === 'information_schema') {
    throw new IntegrationValidationError('Schema (folder) must be 3-63 lowercase letters, digits or underscores, and not public or pg_*.')
  }
  const sslMode = text(input, 'sslMode', 'verify-full')
  if (!['verify-full', 'require', 'disable'].includes(sslMode)) throw new IntegrationValidationError('sslMode must be verify-full, require or disable.')
  const caCert = typeof input.caCert === 'string' && input.caCert.trim() ? input.caCert.trim() : undefined
  if (caCert && (caCert.length > 20_000 || !caCert.startsWith('-----BEGIN CERTIFICATE-----'))) {
    throw new IntegrationValidationError('CA certificate must be PEM encoded.')
  }
  return { host, port, database, schema, sslMode: sslMode as PostgresSettings['sslMode'], ...(caCert ? { caCert } : {}) }
}

export function normalizePostgresCredentials(raw: unknown): PostgresCredentials {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const user = text(input, 'user')
  const password = typeof input.password === 'string' ? input.password : ''
  if (!/^[A-Za-z0-9_.@-]{1,63}$/.test(user)) throw new IntegrationValidationError('Database user is invalid.')
  if (!password || password.length > 512) throw new IntegrationValidationError('Database password is required.')
  return { user, password }
}

export function normalizeIntegration(
  provider: IntegrationProvider,
  settings: unknown,
  secret: unknown | undefined,
): { kind: IntegrationKind; settings: S3Settings | PostgresSettings; secret: S3Credentials | PostgresCredentials | undefined } {
  if (provider === 's3') {
    return { kind: 'storage', settings: normalizeS3Settings(settings), secret: secret === undefined ? undefined : normalizeS3Credentials(secret) }
  }
  if (provider === 'postgresql') {
    return {
      kind: 'database',
      settings: normalizePostgresSettings(settings),
      secret: secret === undefined ? undefined : normalizePostgresCredentials(secret),
    }
  }
  throw new IntegrationValidationError('Unsupported provider.')
}

/** Identifies exactly what was tested; activation requires an unchanged fingerprint. */
export function integrationFingerprint(provider: string, settings: unknown, secret: unknown): string {
  const secretDigest = crypto.createHash('sha256').update(canonicalJson(secret)).digest('hex')
  return crypto.createHash('sha256').update(canonicalJson({ provider, settings, secretDigest })).digest('hex')
}

// ---------------------------------------------------------------------------
// Connection tests (non-destructive)
// ---------------------------------------------------------------------------

export type TestStep = { step: string; ok: boolean; detail: string; durationMs: number }
export type TestReport = { ok: boolean; provider: IntegrationProvider; steps: TestStep[]; testedAt: string }

async function runSteps(provider: IntegrationProvider, steps: Array<[string, () => Promise<string>]>): Promise<TestReport> {
  const results: TestStep[] = []
  for (const [step, run] of steps) {
    const started = Date.now()
    try {
      const detail = await run()
      results.push({ step, ok: true, detail, durationMs: Date.now() - started })
    } catch (error) {
      results.push({ step, ok: false, detail: safeError(error), durationMs: Date.now() - started })
      break
    }
  }
  return { ok: results.length === steps.length && results.every((item) => item.ok), provider, steps: results, testedAt: new Date().toISOString() }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  // Never echo secrets back; drivers sometimes include connection strings.
  return message.replace(/(password|secret|authorization)[^,;\n]*/gi, '$1=[redacted]').slice(0, 400)
}

export async function testS3Integration(settings: S3Settings, credentials: S3Credentials, policy: EndpointPolicy): Promise<TestReport> {
  const probeKey = `.platform-probe/${crypto.randomUUID()}`
  const payload = Buffer.from(`platform connectivity probe ${new Date().toISOString()}`)
  let client: S3Client
  return runSteps('s3', [
    ['Endpoint policy', async () => {
      const endpoint = new URL(settings.endpoint)
      const host = settings.forcePathStyle ? endpoint.hostname : `${settings.bucket}.${endpoint.hostname}`
      const address = await resolveAllowedAddress(host, policy)
      client = new S3Client(settings, credentials, policy)
      return `${host} → ${address.address} (${endpoint.protocol === 'https:' ? 'TLS' : 'plain HTTP'})`
    }],
    ['Write test object', async () => {
      await client.putObject(probeKey, payload, 'text/plain')
      return `Wrote ${client.fullKey(probeKey)}`
    }],
    ['Read it back', async () => {
      const object = await client.getObject(probeKey)
      const chunks: Buffer[] = []
      for await (const chunk of object.body) chunks.push(Buffer.from(chunk))
      if (!Buffer.concat(chunks).equals(payload)) throw new Error('Read-back content did not match.')
      return 'Content matches'
    }],
    ['List folder', async () => {
      const keys = await client.listKeys('.platform-probe/', 50)
      if (!keys.includes(probeKey)) throw new Error('The test object was not visible in a listing of the folder.')
      return `Folder ${settings.prefix || '(bucket root)'} is listable`
    }],
    ['Delete test object', async () => {
      await client.deleteObject(probeKey)
      if (await client.headObject(probeKey)) throw new Error('The test object still exists after delete.')
      return 'Deleted; nothing left behind'
    }],
  ])
}

/** pg client configuration pinned to a policy-approved address. */
export async function externalPostgresConfig(
  settings: PostgresSettings,
  credentials: PostgresCredentials,
  policy: EndpointPolicy,
  applicationName: string,
): Promise<pg.ClientConfig> {
  if (settings.sslMode === 'disable' && !policy.allowInsecureTransport) {
    throw new EndpointPolicyError('Unencrypted database connections are disabled by the platform.')
  }
  const pinned = await resolveAllowedAddress(settings.host, policy)
  const ssl =
    settings.sslMode === 'disable'
      ? false
      : {
          rejectUnauthorized: settings.sslMode === 'verify-full',
          ...(net.isIP(settings.host) ? {} : { servername: settings.host }),
          ...(settings.caCert ? { ca: settings.caCert } : {}),
        }
  return {
    host: pinned.address,
    port: settings.port,
    database: settings.database,
    user: credentials.user,
    password: credentials.password,
    ssl,
    connectionTimeoutMillis: 8_000,
    query_timeout: 30_000,
    statement_timeout: 30_000,
    application_name: applicationName,
  }
}

export async function testPostgresIntegration(
  settings: PostgresSettings,
  credentials: PostgresCredentials,
  policy: EndpointPolicy,
  tenantId: string,
): Promise<TestReport> {
  let client: pg.Client | null = null
  const schema = `"${settings.schema}"`
  try {
    return await runSteps('postgresql', [
      ['Endpoint policy', async () => {
        const config = await externalPostgresConfig(settings, credentials, policy, 'skeleton-integration-test')
        client = new pg.Client(config)
        return `${settings.host} → ${config.host}:${settings.port}`
      }],
      ['Connect and authenticate', async () => {
        await client!.connect()
        const info = (await client!.query<{ user: string; ssl: boolean | null }>(
          `select current_user as user,
                  (select ssl from pg_stat_ssl where pid = pg_backend_pid()) as ssl`,
        )).rows[0]!
        return `Signed in as ${info.user}; transport ${info.ssl ? 'encrypted (TLS)' : 'unencrypted'}`
      }],
      ['Server version', async () => {
        const version = Number((await client!.query<{ v: string }>(`select current_setting('server_version_num') as v`)).rows[0]?.v)
        if (!(version >= 130000)) throw new Error('PostgreSQL 13 or newer is required.')
        return `PostgreSQL ${Math.floor(version / 10000)}`
      }],
      ['Folder (schema) availability', async () => {
        const existing = (await client!.query<{ owned: boolean; can_create: boolean; tables: number; has_metadata: boolean }>(
          `select pg_get_userbyid(n.nspowner) = current_user as owned,
                  has_schema_privilege(n.oid, 'CREATE') as can_create,
                  (select count(*)::int from pg_class c where c.relnamespace = n.oid and c.relkind in ('r','p','v','m')) as tables,
                  exists (select 1 from pg_class c where c.relnamespace = n.oid and c.relname = 'schema_metadata') as has_metadata
             from pg_namespace n where n.nspname = $1`,
          [settings.schema],
        )).rows[0]
        if (!existing) {
          const canCreate = (await client!.query<{ ok: boolean }>(`select has_database_privilege(current_database(), 'CREATE') as ok`)).rows[0]?.ok
          if (!canCreate) throw new Error(`Schema ${settings.schema} does not exist and this user cannot create it.`)
          return `Schema ${settings.schema} will be created`
        }
        if (!existing.owned) throw new Error(`Schema ${settings.schema} exists but is owned by another user; it must be owned by ${credentials.user}.`)
        if (existing.has_metadata) {
          const owner = (await client!.query<{ tenant_id: string | null }>(
            `select to_jsonb(m)->>'tenant_id' as tenant_id from ${schema}.schema_metadata m limit 1`,
          ).catch(() => ({ rows: [{ tenant_id: null }] }))).rows[0]?.tenant_id
          if (owner && owner !== tenantId) throw new Error(`Schema ${settings.schema} already holds another tenant's data.`)
          return `Schema ${settings.schema} already holds this tenant's data (will be updated)`
        }
        if (existing.tables > 0) throw new Error(`Schema ${settings.schema} is not empty. Use a dedicated, empty schema.`)
        return `Schema ${settings.schema} exists and is empty`
      }],
      ['Write, row-level security, rollback', async () => {
        await client!.query('begin')
        try {
          await client!.query(`create schema if not exists ${schema}`)
          const table = `platform_probe_${crypto.randomBytes(6).toString('hex')}`
          const qualified = `${schema}."${table}"`
          await client!.query(`create table ${qualified} (id uuid primary key default gen_random_uuid(), tenant uuid not null)`)
          await client!.query(`alter table ${qualified} enable row level security`)
          await client!.query(`alter table ${qualified} force row level security`)
          await client!.query(`create policy probe on ${qualified} using (tenant::text = current_setting('app.tenant_id', true)) with check (tenant::text = current_setting('app.tenant_id', true))`)
          await client!.query(`select set_config('app.tenant_id', $1, true)`, [tenantId])
          await client!.query(`insert into ${qualified} (tenant) values ($1)`, [tenantId])
          const visible = (await client!.query<{ n: number }>(`select count(*)::int as n from ${qualified}`)).rows[0]?.n
          await client!.query(`select set_config('app.tenant_id', $1, true)`, [crypto.randomUUID()])
          const hidden = (await client!.query<{ n: number }>(`select count(*)::int as n from ${qualified}`)).rows[0]?.n
          if (visible !== 1 || hidden !== 0) throw new Error('Row-level security is not enforced for this user (it may have BYPASSRLS or be a superuser).')
          return 'Create, write, read and forced RLS all work; changes rolled back'
        } finally {
          await client!.query('rollback').catch(() => undefined)
        }
      }],
    ])
  } finally {
    await (client as pg.Client | null)?.end().catch(() => undefined)
  }
}
