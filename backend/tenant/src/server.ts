import cookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import staticFiles from '@fastify/static'
import argon2 from 'argon2'
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type RouteHandlerMethod,
} from 'fastify'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { z, ZodError } from 'zod'
import { createDatabaseClient } from './index.js'
import {
  publicTenantBootstrap,
  TenantResolver,
  MIN_SUPPORTED_SCHEMA_VERSION,
  type TenantContext,
} from './tenant-context.js'
import { TenantDatabaseManager, type ExternalConnectionLoader } from './tenant-database.js'
import { TenantStorage } from './tenant-storage.js'
import { createFileService } from './modules/files.js'
import { createIntegrationsModule } from './modules/integrations.js'
import {
  ALL_SUPPORTED_ROLES,
  toCanonicalRole,
  getHighestCanonicalRole,
  canAssignRole,
  canManageTargetUser,
  assertNotDemotingLastOwner,
} from './authorization.js'
import { recordTenantAudit } from './audit.js'
import {
  createSharedRateLimitStore,
  createThrottleStore,
  deriveCsrfToken,
  externalPostgresConfig,
  IntegrationService,
  integrationSecretAad,
  normalizePostgresCredentials,
  normalizePostgresSettings,
  SecretBox,
  sharedStateBackend,
  configBoolean,
  configInteger,
  deploymentSetting,
  DUMMY_ARGON2ID_HASH,
  hashToken,
  NotificationSender,
  publicConfigValues,
  secureEqual,
  verifyTurnstileToken,
} from '@skeleton/server-kit'
import { TenantConfigService } from './tenant-config.js'
import { applicationModules } from './modules/index.js'
import {
  createInvitationsModule,
  deliverInvitation,
  invitationsEnabled,
  issueUserInvitation,
} from './modules/invitations.js'
import { createSettingsModule } from './modules/settings.js'
import type { TenantModule, TenantRequestKit, TenantSession } from './modules/types.js'

if (process.env.NODE_ENV !== 'test') {
  dotenv.config({
    path: path.resolve(fileURLToPath(new URL('../../..', import.meta.url)), '.env'),
    quiet: true,
  })
}

const isProduction = process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test'
const config = {
  host: process.env.TENANT_BFF_HOST || '127.0.0.1',
  port: Number(process.env.TENANT_BFF_PORT || 6355),
  registryDatabaseUrl: process.env.TENANT_REGISTRY_DATABASE_URL || '',
  rootDomain: deploymentSetting('TENANT_ROOT_DOMAIN', { production: isProduction, developmentDefault: 'example.test' }).toLowerCase(),
  credentialsDirectory: deploymentSetting('TENANT_CREDENTIALS_DIR', {
    production: isProduction,
    developmentDefault: path.resolve(fileURLToPath(new URL('../../..', import.meta.url)), '.secrets/tenants'),
  }),
  cookieSecure: isProduction || (process.env.TENANT_COOKIE_SECURE || '').toLowerCase() === 'true',
  serveStatic: (process.env.SERVE_TENANT_STATIC || '').toLowerCase() === 'true',
  staticRoot:
    process.env.TENANT_STATIC_ROOT ||
    path.resolve(fileURLToPath(new URL('../../..', import.meta.url)), 'frontend/tenant/dist'),
  sessionTtlMs: Number(process.env.TENANT_SESSION_TTL_MS || 8 * 60 * 60 * 1000),
  turnstileSecretKey: process.env.CLOUDFLARE_TENANT_TURNSTILE_SECRET_KEY || '',
  // Local object storage on the VDS (default backend for tenant files).
  storageRoot: deploymentSetting('STORAGE_ROOT', {
    production: isProduction,
    developmentDefault: path.resolve(fileURLToPath(new URL('../../..', import.meta.url)), '.data/storage'),
  }),
  // Optional. When set (>= 32 chars, identical on every process), CSRF tokens
  // are derived from the session instead of cached per process, so several
  // tenant BFF processes can serve the same session.
  sessionSecret: process.env.TENANT_SESSION_SECRET || '',
}
if (config.sessionSecret && config.sessionSecret.length < 32) throw new Error('TENANT_SESSION_SECRET must be at least 32 characters.')

const cookieName = config.cookieSecure ? '__Host-tenant_session' : 'tenant_session'
const identifierPattern = /^[a-z][a-z0-9_]{2,62}$/
const validDummyHash = DUMMY_ARGON2ID_HASH

// Plaintext CSRF tokens for live sessions, keyed by session token hash.
//
// GET /api/auth/session previously minted and stored a fresh CSRF token on
// every call, so opening a second tab silently invalidated the first tab's
// token and its next mutation failed verification. Only the token's SHA-256 is
// persisted, so the plaintext cannot be re-read from the database -- it is
// cached here for the life of the session instead. A cache miss (process
// restart, eviction) falls back to minting a new token, which is exactly the
// previous behaviour, so this is never worse than what it replaces. Entries are
// dropped at logout and bounded so an attacker cannot grow the map without
// also holding that many valid sessions.
const MAXIMUM_CACHED_CSRF_TOKENS = 10_000
const csrfTokensBySession = new Map<string, string>()

function cacheCsrfToken(sessionTokenHash: string, csrfToken: string): void {
  if (csrfTokensBySession.size >= MAXIMUM_CACHED_CSRF_TOKENS) {
    const oldest = csrfTokensBySession.keys().next().value
    if (oldest !== undefined) csrfTokensBySession.delete(oldest)
  }
  csrfTokensBySession.set(sessionTokenHash, csrfToken)
}

type UiRole = TenantSession['role']

function quoteIdentifier(value: string): string {
  if (!identifierPattern.test(value)) throw new Error('Trusted tenant identifier is invalid.')
  return `"${value}"`
}

class UserLimitError extends Error {
  constructor(limit: number) {
    super(`This workspace has reached its limit of ${limit} users.`)
  }
}

function mapRole(roleCodes: string[]): UiRole {
  if (roleCodes.some((role) => ['admin', 'tenant_owner', 'tenant_admin'].includes(role))) return 'admin'
  if (roleCodes.some((role) => ['manager', 'tenant_manager'].includes(role))) return 'manager'
  if (roleCodes.some((role) => ['user', 'tenant_member'].includes(role))) return 'user'
  return 'guest'
}

// LOGIN_CHALLENGE=none disables Turnstile for deployments without Cloudflare.
const loginChallengeDisabled = process.env.LOGIN_CHALLENGE === 'none'

async function verifyTurnstile(token: string, remoteIp: string, context: TenantContext): Promise<boolean> {
  if (loginChallengeDisabled) return true
  if (!config.turnstileSecretKey) return !isProduction
  const result = await verifyTurnstileToken({
    secret: config.turnstileSecretKey,
    token,
    remoteIp,
    expectedAction: 'login',
    expectedHostname: isProduction ? context.hostname : undefined,
  })
  return result.ok
}

function publicUser(session: TenantSession) {
  return {
    id: session.userId,
    username: session.username,
    displayName: session.displayName,
    email: session.email,
    role: session.role,
  }
}

function requireCsrf(request: FastifyRequest, reply: FastifyReply, session: TenantSession): boolean {
  const supplied = request.headers['x-csrf-token']
  if (typeof supplied !== 'string' || !secureEqual(hashToken(supplied), session.csrfHash)) {
    void reply.code(403).send({ success: false, message: 'CSRF verification failed.' })
    return false
  }
  return true
}

async function requirePermission(
  databases: TenantDatabaseManager,
  context: TenantContext,
  request: FastifyRequest,
  reply: FastifyReply,
  session: TenantSession,
  permission: string,
  resourceType: string = 'permission',
  resourceId?: string | null,
): Promise<boolean> {
  if (!session.permissions.has(permission)) {
    await recordTenantAudit({
      databases,
      context,
      actorUserId: session.userId,
      action: 'permission:denied',
      resourceType,
      resourceId,
      outcome: 'denied',
      correlationId: request.id,
      reason: `Missing permission: ${permission}`,
    })
    void reply.code(403).send({ success: false, message: 'You do not have permission for this action.' })
    return false
  }
  return true
}

export async function createServer(): Promise<FastifyInstance> {
  if (!config.registryDatabaseUrl) throw new Error('TENANT_REGISTRY_DATABASE_URL is required.')
  if (loginChallengeDisabled) console.warn('[tenant-bff] LOGIN_CHALLENGE=none: Turnstile verification is disabled for sign-in.')
  if (isProduction && !config.turnstileSecretKey && !loginChallengeDisabled) {
    throw new Error('CLOUDFLARE_TENANT_TURNSTILE_SECRET_KEY is required in production.')
  }

  const registry = createDatabaseClient(config.registryDatabaseUrl).pool
  const registryIdentity = await registry.query<{ current_user: string }>('select current_user')
  if (registryIdentity.rows[0]?.current_user !== 'tenant_registry_reader_login') {
    await registry.end()
    throw new Error('Tenant registry connection must use tenant_registry_reader_login.')
  }
  const resolver = new TenantResolver(registry, config.rootDomain)
  const secretBox = SecretBox.fromEnvironment()
  const integrations = new IntegrationService(registry, secretBox)
  // Tenants whose data lives in their own PostgreSQL (bring-your-own).
  const loadExternal: ExternalConnectionLoader = async (context) => {
    if (!secretBox || !context.dataIntegrationId) throw new Error('External tenant database is unavailable (INTEGRATION_SECRET_KEY missing).')
    const row = (await registry.query<{ integration_id: string; kind: string; settings: unknown; secret_ciphertext: string }>(
      `select integration_id::text, kind, settings, secret_ciphertext from platform.tenant_integration
        where integration_id = $1 and tenant_id = $2 and kind = 'database'`,
      [context.dataIntegrationId, context.tenantId],
    )).rows[0]
    if (!row) throw new Error('External tenant database integration not found.')
    const settings = normalizePostgresSettings(row.settings)
    const credentials = normalizePostgresCredentials(JSON.parse(secretBox.open(row.secret_ciphertext, integrationSecretAad(context.tenantId, row.integration_id, row.kind))))
    return {
      integrationId: row.integration_id,
      schema: settings.schema,
      config: await externalPostgresConfig(settings, credentials, await integrations.policy(), `tenant-bff:${context.tenantKey}`),
    }
  }
  const databases = new TenantDatabaseManager(config.credentialsDirectory, 100, {
    poolDatabaseUrl: process.env.TENANT_POOL_DATABASE_URL,
    poolSize: Number(process.env.TENANT_POOL_SIZE || 20),
    loadExternal,
  })
  const storage = new TenantStorage(registry, secretBox, () => integrations.policy(), config.storageRoot)
  const fileService = createFileService(storage)
  const loginThrottle = createThrottleStore(registry)
  const configs = new TenantConfigService(registry, databases)
  const notifier = new NotificationSender()
  const requestContexts = new WeakMap<FastifyRequest, TenantContext>()

  const contextFor = (request: FastifyRequest): TenantContext => {
    const context = requestContexts.get(request)
    if (!context) throw new Error('Trusted tenant context is unavailable.')
    return context
  }

  const getSession = async (request: FastifyRequest): Promise<TenantSession | null> => {
    const context = contextFor(request)
    const rawToken = request.cookies[cookieName] || (!isProduction ? (request.cookies['__Host-tenant_session'] || request.cookies['tenant_session']) : undefined)
    if (!rawToken) return null
    const tokenHash = hashToken(rawToken)
    const schema = quoteIdentifier(context.dataSchema)
    const storedResult = await databases.directQuery<{
      token_hash: string
      csrf_hash: string
      tenant_id: string
      user_id: string
    }>(
      context,
      `select token_hash, csrf_hash, tenant_id::text, user_id::text
         from ${schema}.user_session
        where token_hash = $1 and tenant_id = $2 and expires_at > now()`,
      [tokenHash, context.tenantId],
    )
    const stored = storedResult.rows[0]
    if (!stored || stored.tenant_id !== context.tenantId) return null

    const profile = await databases.withTenant(context, async (client) => {
      const result = await client.query<{
        user_id: string
        username: string
        display_name: string
        email_normalized: string | null
        role_codes: string[]
        permissions: string[]
      }>(
        `select u.user_id::text, u.username, u.display_name, u.email_normalized,
                coalesce(array_agg(distinct r.role_code) filter (where r.role_code is not null), '{}') as role_codes,
                coalesce(array_agg(distinct p.permission_code) filter (where p.permission_code is not null), '{}') as permissions
           from user_account u
           left join role_assignment ra on ra.user_id = u.user_id
             and (ra.expires_at is null or ra.expires_at > now())
           left join role_definition r on r.role_id = ra.role_id
           left join role_permission rp on rp.role_id = r.role_id
           left join permission p on p.permission_id = rp.permission_id
          where u.user_id = $1 and u.account_status = 'active'
          group by u.user_id`,
        [stored.user_id],
      )
      const row = result.rows[0]
      if (!row) return row
      const delegated = await client.query<{ permission_code: string }>(
        `select permission_code
           from capability_delegation
          where grantee_user_id = $1
            and status = 'active'
            and (expires_at is null or expires_at > now())`,
        [row.user_id],
      )
      return {
        ...row,
        permissions: [
          ...new Set([
            ...(row.permissions || []),
            ...delegated.rows.map((delegation) => delegation.permission_code),
          ]),
        ],
      }
    })
    if (!profile) return null
    void databases.directQuery(
      context,
      `update ${schema}.user_session set last_seen_at = now() where token_hash = $1 and tenant_id = $2`,
      [tokenHash, context.tenantId],
    ).catch((error: unknown) => request.log.warn({ error }, 'tenant session heartbeat update failed'))
    const canonicalRole = getHighestCanonicalRole(profile.role_codes) || 'tenant_viewer'
    return {
      tokenHash,
      csrfHash: stored.csrf_hash,
      tenantId: stored.tenant_id,
      userId: profile.user_id,
      username: profile.username,
      displayName: profile.display_name,
      email: profile.email_normalized,
      role: mapRole(profile.role_codes),
      canonicalRole,
      permissions: new Set(profile.permissions),
    }
  }

  const app = Fastify({
    logger: { redact: ['req.headers.cookie', 'req.headers.authorization', 'req.body.password'] },
    bodyLimit: 64 * 1024,
    trustProxy: ['127.0.0.1', '::1'],
    genReqId: (request) => {
      const supplied = request.headers['x-request-id']
      return typeof supplied === 'string' && /^[0-9a-f-]{36}$/i.test(supplied) ? supplied : crypto.randomUUID()
    },
  })
  await app.register(cookie)
  await app.register(rateLimit, {
    max: 200,
    timeWindow: '1 minute',
    ...(sharedStateBackend() === 'postgres' ? { store: createSharedRateLimitStore(registry), skipOnError: true } : {}),
  })
  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    hsts: config.cookieSecure ? { maxAge: 31_536_000, preload: true, includeSubDomains: true } : false,
  })

  // Unauthenticated, read-only, non-sensitive endpoints the provisioning
  // pipeline must be able to reach before a tenant is fully activated, to
  // verify the hostname is genuinely reachable over the public edge (DNS ->
  // Cloudflare -> tunnel -> this process) before flipping it live.
  const provisioningVisibleRoutes = new Set(['/api/health', '/api/tenant/bootstrap', '/api/v1/tenant/info'])

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-Id', request.id)
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store')
    const context = await resolver.resolve(request.headers.host)
    if (!context) {
      return reply.code(404).send({ success: false, message: 'Tenant not found.' })
    }
    if (context.status === 'suspended') {
      return reply.code(403).send({ success: false, message: 'Tenant access is suspended.' })
    }
    if (context.status === 'migration_failed') {
      return reply.code(503).send({ success: false, message: 'Tenant workspace migration failed.' })
    }
    const pathname = request.url.split('?', 1)[0] || '/'
    const isProvisioningVisible =
      context.status === 'provisioning' &&
      request.method === 'GET' &&
      provisioningVisibleRoutes.has(pathname)
    // While data moves between databases, reads needed to show progress stay
    // available; everything else waits for the move to finish.
    const isMaintenanceVisible =
      context.status === 'relocating' &&
      request.method === 'GET' &&
      (provisioningVisibleRoutes.has(pathname) || pathname.endsWith('/auth/session') || pathname.startsWith('/api/v1/operations/'))
    if (context.status === 'relocating' && !isMaintenanceVisible) {
      return reply.code(503).header('Retry-After', '30').send({ success: false, message: 'This workspace is being moved to a new database. Try again shortly.' })
    }
    if (context.status !== 'active' && !isProvisioningVisible && !isMaintenanceVisible) {
      return reply.code(503).send({ success: false, message: 'Tenant workspace is not available.' })
    }
    if (context.schemaVersion < MIN_SUPPORTED_SCHEMA_VERSION && !isProvisioningVisible) {
      return reply.code(503).send({
        success: false,
        message: 'Tenant schema is below minimum supported version.',
      })
    }
    requestContexts.set(request, context)
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      if (request.headers.origin !== `https://${context.hostname}`) {
        return reply.code(403).send({ success: false, message: 'Request origin is not allowed.' })
      }
    }
  })
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ success: false, message: 'Invalid request.' })
    }
    request.log.error({ error, correlationId: request.id }, 'tenant request failed')
    return reply.code(500).send({ success: false, message: 'The request could not be completed.' })
  })

  const kit: TenantRequestKit = {
    tenant: contextFor,
    withTenant: (request, callback) => databases.withTenant(contextFor(request), callback),
    config: (request) => configs.forTenant(contextFor(request)),
    async requireSession(request, reply) {
      const session = await getSession(request)
      if (!session) {
        void reply.code(401).send({ success: false, message: 'Authentication required.' })
        return null
      }
      return session
    },
    requirePermission: (request, reply, session, permission) =>
      requirePermission(databases, contextFor(request), request, reply, session, permission),
    requireCsrf,
    async requireFeature(request, reply, featureKey) {
      if (configBoolean(await configs.forTenant(contextFor(request)), featureKey, false)) return true
      void reply.code(404).send({ success: false, message: 'API route not found.' })
      return false
    },
    audit: (request, event) =>
      recordTenantAudit({ ...event, databases, context: contextFor(request), correlationId: request.id }),
    get files() {
      return fileService.service(kit)
    },
  }

  // Mounts a module in its own encapsulated scope. A module with a feature key
  // is invisible (404) for tenants where the feature resolves to false.
  const mountModule = async (module: TenantModule) => {
    await app.register(async (scope) => {
      if (module.featureKey) {
        const featureKey = module.featureKey
        scope.addHook('preHandler', async (request, reply) => {
          if (!(await kit.requireFeature(request, reply, featureKey))) return reply
        })
      }
      await module.register(scope, kit)
    })
  }

  app.get('/api/health', async (request, reply) => {
    try {
      await databases.withTenant(contextFor(request), async (client) => client.query('select 1'))
      return { success: true, status: 'ok', timestamp: new Date().toISOString() }
    } catch {
      return reply.code(503).send({ success: false, status: 'unavailable' })
    }
  })

  const bootstrapHandler: RouteHandlerMethod = async (request) => {
    const context = contextFor(request)
    let publicConfig: Record<string, unknown> = {}
    try {
      publicConfig = publicConfigValues(await configs.forTenant(context))
    } catch (error) {
      request.log.warn({ error }, 'tenant configuration unavailable for bootstrap')
    }
    return { success: true, tenant: publicTenantBootstrap(context), config: publicConfig }
  }
  app.get('/api/tenant/bootstrap', bootstrapHandler)
  app.get('/api/v1/tenant/info', bootstrapHandler)

  const sessionHandler: RouteHandlerMethod = async (request) => {
    const context = contextFor(request)
    const session = await getSession(request)
    if (!session) return { success: true, authenticated: false, user: null, tenantId: context.tenantKey, csrfToken: null }
    // Issue a per-session CSRF token rather than minting a new one on every
    // call. Rotating here invalidated the token every other open tab held, so
    // a second tab's next mutation failed CSRF verification through no fault
    // of the user. The token is bound to the session and dies with it; it is
    // rotated deliberately at login and logout, not on every read.
    const schema = quoteIdentifier(context.dataSchema)
    let csrfToken = config.sessionSecret ? deriveCsrfToken(config.sessionSecret, session.tokenHash) : csrfTokensBySession.get(session.tokenHash)
    if (csrfToken && config.sessionSecret && !secureEqual(hashToken(csrfToken), session.csrfHash)) {
      // Session created before TENANT_SESSION_SECRET was configured.
      await databases.directQuery(
        context,
        `update ${schema}.user_session set csrf_hash = $1 where token_hash = $2 and tenant_id = $3`,
        [hashToken(csrfToken), session.tokenHash, context.tenantId],
      )
    }
    if (!csrfToken) {
      csrfToken = crypto.randomBytes(32).toString('base64url')
      await databases.directQuery(
        context,
        `update ${schema}.user_session set csrf_hash = $1 where token_hash = $2 and tenant_id = $3`,
        [hashToken(csrfToken), session.tokenHash, context.tenantId],
      )
      cacheCsrfToken(session.tokenHash, csrfToken)
    }
    return {
      success: true,
      authenticated: true,
      user: publicUser(session),
      tenantId: context.tenantKey,
      csrfToken,
    }
  }
  app.get('/api/auth/session', sessionHandler)
  app.get('/api/v1/auth/session', sessionHandler)

  const loginSchema = z.object({
    username: z.string().trim().min(1).max(255),
    password: z.string().min(12).max(512),
    turnstileToken: z.string().min(20).max(4096),
  })
  const loginHandler: RouteHandlerMethod = async (request, reply) => {
    const context = contextFor(request)
    const body = loginSchema.parse(request.body)
    const tenantConfig = await configs.forTenant(context)
    const sessionTtlMs = configInteger(tenantConfig, 'auth.session_ttl_minutes', Math.floor(config.sessionTtlMs / 60_000)) * 60_000
    const throttlePolicy = {
      maximumFailures: configInteger(tenantConfig, 'auth.lockout.max_failures', 10),
      lockoutMs: configInteger(tenantConfig, 'auth.lockout.duration_minutes', 15) * 60_000,
    }
    const throttleKey = `${context.tenantId}:${body.username}`
    if (!(await loginThrottle.allowed(throttleKey))) {
      await recordTenantAudit({
        databases,
        context,
        action: 'auth:lockout',
        resourceType: 'session',
        outcome: 'denied',
        correlationId: request.id,
        reason: 'Rate limit exceeded',
      })
      return reply.code(429).send({ success: false, message: 'Too many sign-in attempts. Try again later.' })
    }
    if (!(await verifyTurnstile(body.turnstileToken, request.ip, context))) {
      await recordTenantAudit({
        databases,
        context,
        action: 'auth:turnstile_failed',
        resourceType: 'session',
        outcome: 'denied',
        correlationId: request.id,
        reason: 'Human verification failed',
      })
      return reply.code(403).send({ success: false, message: 'Human verification failed.' })
    }
    const candidate = await databases.withTenant(context, async (client) => {
      const result = await client.query<{
        user_id: string
        username: string
        display_name: string
        email_normalized: string | null
        account_status: string
        password_hash: string | null
        role_codes: string[]
      }>(
        `select u.user_id::text, u.username, u.display_name, u.email_normalized, u.account_status,
                i.password_hash,
                coalesce(array_agg(distinct r.role_code) filter (where r.role_code is not null), '{}') as role_codes
           from user_account u
           left join user_identity i on i.user_id = u.user_id and i.credential_type = 'password'
           left join role_assignment ra on ra.user_id = u.user_id
             and (ra.expires_at is null or ra.expires_at > now())
           left join role_definition r on r.role_id = ra.role_id
          where lower(u.username) = lower($1) or lower(u.email_normalized) = lower($1)
          group by u.user_id, i.password_hash
          limit 1`,
        [body.username],
      )
      return result.rows[0]
    })
    let passwordValid = false
    try {
      passwordValid = await argon2.verify(candidate?.password_hash || validDummyHash, body.password)
    } catch {
      passwordValid = false
    }
    if (!candidate || candidate.account_status !== 'active' || !passwordValid) {
      await loginThrottle.failure(throttleKey, throttlePolicy)
      await recordTenantAudit({
        databases,
        context,
        actorUserId: candidate?.user_id || null,
        action: 'auth:login_failure',
        resourceType: 'session',
        outcome: 'denied',
        correlationId: request.id,
        reason: !candidate
          ? 'User not found'
          : candidate.account_status !== 'active'
            ? 'Account inactive'
            : 'Invalid password',
      })
      return reply.code(401).send({ success: false, message: 'Invalid username or password.' })
    }

    await loginThrottle.success(throttleKey)

    const rawSessionToken = crypto.randomBytes(32).toString('base64url')
    const csrfToken = config.sessionSecret
      ? deriveCsrfToken(config.sessionSecret, hashToken(rawSessionToken))
      : crypto.randomBytes(32).toString('base64url')
    const schema = quoteIdentifier(context.dataSchema)
    await databases.directQuery(
      context,
      `insert into ${schema}.user_session (tenant_id, user_id, token_hash, csrf_hash, expires_at)
       values ($1, $2, $3, $4, now() + ($5 * interval '1 millisecond'))`,
      [context.tenantId, candidate.user_id, hashToken(rawSessionToken), hashToken(csrfToken), sessionTtlMs],
    )
    cacheCsrfToken(hashToken(rawSessionToken), csrfToken)
    await recordTenantAudit({
      databases,
      context,
      actorUserId: candidate.user_id,
      action: 'auth:login',
      resourceType: 'session',
      outcome: 'success',
      correlationId: request.id,
    })
    reply.setCookie(cookieName, rawSessionToken, {
      path: '/',
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: 'strict',
      maxAge: Math.floor(sessionTtlMs / 1000),
    })
    return {
      success: true,
      user: {
        id: candidate.user_id,
        username: candidate.username,
        displayName: candidate.display_name,
        email: candidate.email_normalized,
        role: mapRole(candidate.role_codes),
      },
      tenantId: context.tenantKey,
      csrfToken,
    }
  }
  app.post('/api/auth/login', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, loginHandler)
  app.post('/api/v1/auth/login', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, loginHandler)

  const logoutHandler: RouteHandlerMethod = async (request, reply) => {
    const context = contextFor(request)
    const session = await getSession(request)
    if (!session) return reply.code(401).send({ success: false, message: 'Authentication required.' })
    if (!requireCsrf(request, reply, session)) return
    const schema = quoteIdentifier(context.dataSchema)
    await databases.directQuery(
      context,
      `delete from ${schema}.user_session where token_hash = $1 and tenant_id = $2`,
      [session.tokenHash, context.tenantId],
    )
    csrfTokensBySession.delete(session.tokenHash)
    await recordTenantAudit({
      databases,
      context,
      actorUserId: session.userId,
      action: 'auth:logout',
      resourceType: 'session',
      outcome: 'success',
      correlationId: request.id,
    })
    reply.clearCookie(cookieName, { path: '/' })
    return { success: true }
  }
  app.post('/api/auth/logout', logoutHandler)
  app.post('/api/v1/auth/logout', logoutHandler)

  const usersQuery = z.object({
    role: z.string().trim().max(64).optional(),
    search: z.string().trim().max(100).default(''),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  app.get('/api/v1/users', async (request, reply) => {
    const context = contextFor(request)
    const session = await getSession(request)
    if (!session) return reply.code(401).send({ success: false, message: 'Authentication required.' })
    if (!await requirePermission(databases, context, request, reply, session, 'tenant.users.read')) return
    const query = usersQuery.parse(request.query)
    const users = await databases.withTenant(context, async (client) => {
      const params: unknown[] = []
      let sql = `select u.user_id::text, u.username, u.display_name, u.email_normalized, u.account_status, u.created_at,
                        coalesce(array_agg(distinct r.role_code) filter (where r.role_code is not null), '{}') as role_codes
                   from user_account u
                   left join role_assignment ra on ra.user_id = u.user_id
                   left join role_definition r on r.role_id = ra.role_id
                  where u.account_status <> 'departed'`
      if (query.search) {
        params.push(`%${query.search.toLowerCase()}%`)
        sql += ` and (lower(u.display_name) like $${params.length} or lower(u.username) like $${params.length})`
      }
      sql += ' group by u.user_id'
      if (query.role) {
        params.push(query.role)
        sql += ` having $${params.length} = any(array_agg(r.role_code))`
      }
      params.push(query.limit)
      sql += ` order by u.created_at desc limit $${params.length}`
      return (await client.query(sql, params)).rows as Array<Record<string, unknown> & { role_codes: string[] }>
    })
    return {
      success: true,
      tenantId: context.tenantKey,
      total: users.length,
      users: users.map((user) => ({
        id: user.user_id,
        username: user.username,
        displayName: user.display_name,
        email: user.email_normalized,
        status: user.account_status,
        createdAt: user.created_at,
        role: mapRole(user.role_codes),
      })),
    }
  })

  const createUserSchema = z.object({
    username: z.string().trim().min(1).max(255).regex(/^[a-zA-Z0-9._-]+$/),
    displayName: z.string().trim().min(1).max(255),
    email: z.string().email().max(320),
    role: z.enum(ALL_SUPPORTED_ROLES).default('tenant_member'),
  })

  app.post('/api/v1/users', async (request, reply) => {
    const context = contextFor(request)
    const session = await getSession(request)
    if (!session) return reply.code(401).send({ success: false, message: 'Authentication required.' })
    if (!await requirePermission(databases, context, request, reply, session, 'tenant.users.create') || !requireCsrf(request, reply, session)) return
    const body = createUserSchema.parse(request.body)
    const targetCanonical = toCanonicalRole(body.role)
    if (!targetCanonical) {
      return reply.code(400).send({ success: false, message: 'Invalid role.' })
    }
    if (!canAssignRole(session.canonicalRole, targetCanonical)) {
      await recordTenantAudit({
        databases,
        context,
        actorUserId: session.userId,
        action: 'user:invite',
        resourceType: 'user_account',
        outcome: 'denied',
        correlationId: request.id,
        reason: `Your role (${session.canonicalRole}) is not permitted to assign ${targetCanonical}.`,
      })
      return reply.code(403).send({
        success: false,
        message: `Your role (${session.canonicalRole}) is not permitted to assign ${targetCanonical}.`,
      })
    }
    const tenantConfig = await configs.forTenant(context)
    if (!invitationsEnabled(tenantConfig)) {
      return reply.code(403).send({ success: false, message: 'User invitations are disabled for this workspace.' })
    }
    const maximumUsers = configInteger(tenantConfig, 'limit.users.max', 0)
    const ttlHours = configInteger(tenantConfig, 'invitations.ttl_hours', 72)
    let created
    try {
      created = await databases.withTenant(context, async (client) => {
      // Serialise concurrent invites so the user limit cannot be overshot.
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`tenant-user-limit:${context.schemaName}`])
      if (maximumUsers > 0) {
        const count = await client.query<{ total: number }>(
          `select count(*)::int as total from user_account where account_status <> 'departed'`,
        )
        if ((count.rows[0]?.total || 0) >= maximumUsers) throw new UserLimitError(maximumUsers)
      }
      const role = await client.query<{ role_id: string }>(
        'select role_id::text from role_definition where role_code = $1 limit 1',
        [targetCanonical],
      )
      if (!role.rows[0]) throw new Error('Configured role is unavailable.')
      const result = await client.query<{
        user_id: string
        username: string
        display_name: string
        email_normalized: string
      }>(
        `insert into user_account (username, display_name, email_normalized, account_status)
         values (lower($1), $2, lower($3), 'invited')
         returning user_id::text, username, display_name, email_normalized`,
        [body.username, body.displayName, body.email],
      )
      const user = result.rows[0]
      if (!user) throw new Error('User creation failed.')
      await client.query('insert into role_assignment (user_id, role_id, granted_by) values ($1, $2, $3)', [
        user.user_id,
        role.rows[0].role_id,
        session.userId,
      ])
      await client.query(
        `insert into audit_event (actor_user_id, action, resource_type, resource_id, outcome, correlation_id)
         values ($1, 'user:invite', 'user_account', $2, 'success', $3)`,
        [session.userId, user.user_id, request.id],
      )
      const invitation = await issueUserInvitation(client, { userId: user.user_id, invitedBy: session.userId, ttlHours })
      return { ...user, invitation }
      })
    } catch (error) {
      if (error instanceof UserLimitError) {
        await recordTenantAudit({
          databases,
          context,
          actorUserId: session.userId,
          action: 'user:invite',
          resourceType: 'user_account',
          outcome: 'denied',
          correlationId: request.id,
          reason: error.message,
        })
        return reply.code(409).send({ success: false, message: error.message })
      }
      if ((error as { code?: string }).code === '23505') {
        return reply.code(409).send({ success: false, message: 'That username or email is already in use.' })
      }
      throw error
    }
    const { link, delivery } = await deliverInvitation(notifier, context, {
      to: created.email_normalized,
      token: created.invitation.token,
      type: 'tenant_user_invitation',
      displayName: created.display_name,
    })
    return {
      success: true,
      user: {
        id: created.user_id,
        username: created.username,
        displayName: created.display_name,
        email: created.email_normalized,
        role: targetCanonical,
        status: 'invited',
      },
      // Shown once to the inviting administrator. The token itself is stored
      // only as a hash and cannot be recovered later; reissue instead.
      invitation: { link, expiresAt: created.invitation.expiresAt, delivered: delivery.delivered },
    }
  })

  app.post('/api/v1/users/:userId/invitation', async (request, reply) => {
    const context = contextFor(request)
    const session = await getSession(request)
    if (!session) return reply.code(401).send({ success: false, message: 'Authentication required.' })
    if (!await requirePermission(databases, context, request, reply, session, 'tenant.users.create') || !requireCsrf(request, reply, session)) return
    const { userId } = z.object({ userId: z.uuid() }).parse(request.params)
    const tenantConfig = await configs.forTenant(context)
    if (!invitationsEnabled(tenantConfig)) {
      return reply.code(403).send({ success: false, message: 'User invitations are disabled for this workspace.' })
    }
    const ttlHours = configInteger(tenantConfig, 'invitations.ttl_hours', 72)
    const result = await databases.withTenant(context, async (client) => {
      const locked = await client.query(
        `select 1 from user_account where user_id = $1 and account_status = 'invited' for update`,
        [userId],
      )
      if (!locked.rowCount) return null
      const target = (
        await client.query<{ display_name: string; email_normalized: string | null; role_codes: string[] }>(
          `select u.display_name, u.email_normalized,
                  coalesce(array_agg(r.role_code) filter (where r.role_code is not null), '{}') as role_codes
             from user_account u
             left join role_assignment ra on ra.user_id = u.user_id
             left join role_definition r on r.role_id = ra.role_id
            where u.user_id = $1
            group by u.user_id`,
          [userId],
        )
      ).rows[0]
      if (!target) return null
      if (!canManageTargetUser(session.canonicalRole, getHighestCanonicalRole(target.role_codes))) return 'forbidden' as const
      const invitation = await issueUserInvitation(client, { userId, invitedBy: session.userId, ttlHours })
      await client.query(
        `insert into audit_event (actor_user_id, action, resource_type, resource_id, outcome, correlation_id)
         values ($1, 'user:invitation_reissued', 'user_account', $2, 'success', $3)`,
        [session.userId, userId, request.id],
      )
      return { ...target, invitation }
    })
    if (!result) return reply.code(404).send({ success: false, message: 'No pending invitation exists for this user.' })
    if (result === 'forbidden') return reply.code(403).send({ success: false, message: 'You cannot manage this user.' })
    const { link, delivery } = await deliverInvitation(notifier, context, {
      to: result.email_normalized,
      token: result.invitation.token,
      type: 'tenant_user_invitation',
      displayName: result.display_name,
    })
    return { success: true, invitation: { link, expiresAt: result.invitation.expiresAt, delivered: delivery.delivered } }
  })

  const updateRoleSchema = z.object({ role: z.enum(ALL_SUPPORTED_ROLES) })
  app.patch('/api/v1/users/:userId/role', async (request, reply) => {
    const context = contextFor(request)
    const session = await getSession(request)
    if (!session) return reply.code(401).send({ success: false, message: 'Authentication required.' })
    if (!await requirePermission(databases, context, request, reply, session, 'tenant.users.roles') || !requireCsrf(request, reply, session)) return
    const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params)
    if (userId === session.userId) {
      await recordTenantAudit({
        databases,
        context,
        actorUserId: session.userId,
        action: 'role:update',
        resourceType: 'role_assignment',
        resourceId: userId,
        outcome: 'denied',
        correlationId: request.id,
        reason: 'You cannot change your own administrative role.',
      })
      return reply.code(409).send({ success: false, message: 'You cannot change your own administrative role.' })
    }
    const body = updateRoleSchema.parse(request.body)
    const newCanonicalRole = toCanonicalRole(body.role)
    if (!newCanonicalRole) {
      return reply.code(400).send({ success: false, message: 'Invalid role.' })
    }
    if (!canAssignRole(session.canonicalRole, newCanonicalRole)) {
      await recordTenantAudit({
        databases,
        context,
        actorUserId: session.userId,
        action: 'role:update',
        resourceType: 'role_assignment',
        resourceId: userId,
        outcome: 'denied',
        correlationId: request.id,
        reason: `Your role (${session.canonicalRole}) is not permitted to assign ${newCanonicalRole}.`,
      })
      return reply.code(403).send({
        success: false,
        message: `Your role (${session.canonicalRole}) is not permitted to assign ${newCanonicalRole}.`,
      })
    }
    try {
      await databases.withTenant(context, async (client) => {
        const existingRolesRes = await client.query<{ role_code: string }>(
          `select rd.role_code
             from role_assignment ra
             join role_definition rd on rd.role_id = ra.role_id
            where ra.user_id = $1`,
          [userId],
        )
        const targetHighestRole = getHighestCanonicalRole(existingRolesRes.rows.map((r) => r.role_code))
        if (!canManageTargetUser(session.canonicalRole, targetHighestRole)) {
          throw new Error(
            `Your role (${session.canonicalRole}) cannot modify a user with role ${targetHighestRole || 'unknown'}.`,
          )
        }
        if (targetHighestRole === 'tenant_owner' && newCanonicalRole !== 'tenant_owner') {
          await assertNotDemotingLastOwner(client, context.schemaName, userId)
        }
        const role = await client.query<{ role_id: string }>(
          'select role_id::text from role_definition where role_code = $1 limit 1',
          [newCanonicalRole],
        )
        if (!role.rows[0]) throw new Error('Configured role is unavailable.')
        await client.query('delete from role_assignment where user_id = $1', [userId])
        await client.query('insert into role_assignment (user_id, role_id, granted_by) values ($1, $2, $3)', [
          userId,
          role.rows[0].role_id,
          session.userId,
        ])
        await client.query(
          `insert into audit_event (actor_user_id, action, resource_type, resource_id, outcome, correlation_id)
           values ($1, $2, 'role_assignment', $3, 'success', $4)`,
          [session.userId, `role:update:${newCanonicalRole}`, userId, request.id],
        )
      })
    } catch (error) {
      const msg = (error as Error).message
      await recordTenantAudit({
        databases,
        context,
        actorUserId: session.userId,
        action: 'role:update',
        resourceType: 'role_assignment',
        resourceId: userId,
        outcome: 'denied',
        correlationId: request.id,
        reason: msg,
      })
      if (
        msg.includes('cannot modify a user with role') ||
        msg.includes('must retain at least one active tenant_owner')
      ) {
        return reply.code(403).send({ success: false, message: msg })
      }
      throw error
    }
    return { success: true, role: newCanonicalRole }
  })

  app.post('/api/v1/users/:userId/grant-owner', async (request, reply) => {
    const context = contextFor(request)
    const session = await getSession(request)
    if (!session) return reply.code(401).send({ success: false, message: 'Authentication required.' })
    if (session.canonicalRole !== 'tenant_owner') {
      return reply.code(403).send({ success: false, message: 'Only tenant_owner can grant owner role.' })
    }
    if (!requireCsrf(request, reply, session)) return
    const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params)
    try {
      await databases.withTenant(context, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [`tenant-owner-lock:${context.schemaName}`])
        const userRes = await client.query<{ account_status: string }>(
          'select account_status from user_account where user_id = $1 for update',
          [userId],
        )
        if (!userRes.rows[0] || userRes.rows[0].account_status !== 'active') {
          throw new Error('Target user must exist and be active.')
        }
        const role = (await client.query<{ role_id: string }>('select role_id from role_definition where role_code = $1', ['tenant_owner'])).rows[0]
        if (!role) throw new Error('Role tenant_owner is missing.')
        await client.query('delete from role_assignment where user_id = $1', [userId])
        await client.query('insert into role_assignment (user_id, role_id, granted_by) values ($1, $2, $3)', [
          userId,
          role.role_id,
          session.userId,
        ])
        await client.query(
          `insert into audit_event (actor_user_id, action, resource_type, resource_id, outcome, correlation_id)
           values ($1, 'owner:grant', 'role_assignment', $2, 'success', $3)`,
          [session.userId, userId, request.id],
        )
      })
      return { success: true, message: 'Owner role granted.' }
    } catch (error) {
      return reply.code(400).send({ success: false, message: (error as Error).message })
    }
  })

  app.post('/api/v1/users/:userId/transfer-ownership', async (request, reply) => {
    const context = contextFor(request)
    const session = await getSession(request)
    if (!session) return reply.code(401).send({ success: false, message: 'Authentication required.' })
    if (session.canonicalRole !== 'tenant_owner') {
      return reply.code(403).send({ success: false, message: 'Only tenant_owner can transfer ownership.' })
    }
    if (!requireCsrf(request, reply, session)) return
    const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params)
    if (userId === session.userId) {
      return reply.code(409).send({ success: false, message: 'Cannot transfer ownership to yourself.' })
    }
    try {
      await databases.withTenant(context, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [`tenant-owner-lock:${context.schemaName}`])
        const userRes = await client.query<{ account_status: string }>(
          'select account_status from user_account where user_id = $1 for update',
          [userId],
        )
        if (!userRes.rows[0] || userRes.rows[0].account_status !== 'active') {
          throw new Error('Target user must exist and be active.')
        }
        const ownerRole = (await client.query<{ role_id: string }>('select role_id from role_definition where role_code = $1', ['tenant_owner'])).rows[0]
        const adminRole = (await client.query<{ role_id: string }>('select role_id from role_definition where role_code = $1', ['tenant_admin'])).rows[0]
        if (!ownerRole || !adminRole) throw new Error('Required role definitions are missing.')

        await client.query('delete from role_assignment where user_id = $1', [userId])
        await client.query('insert into role_assignment (user_id, role_id, granted_by) values ($1, $2, $3)', [
          userId,
          ownerRole.role_id,
          session.userId,
        ])
        await client.query('delete from role_assignment where user_id = $1', [session.userId])
        await client.query('insert into role_assignment (user_id, role_id, granted_by) values ($1, $2, $3)', [
          session.userId,
          adminRole.role_id,
          session.userId,
        ])

        await assertNotDemotingLastOwner(client, context.schemaName, session.userId)
        await client.query(
          `insert into audit_event (actor_user_id, action, resource_type, resource_id, outcome, correlation_id)
           values ($1, 'owner:transfer', 'role_assignment', $2, 'success', $3)`,
          [session.userId, userId, request.id],
        )
      })
      return { success: true, message: 'Ownership transferred.' }
    } catch (error) {
      return reply.code(400).send({ success: false, message: (error as Error).message })
    }
  })

  app.post('/api/v1/users/:userId/suspend', async (request, reply) => {
    const context = contextFor(request)
    const session = await getSession(request)
    if (!session) return reply.code(401).send({ success: false, message: 'Authentication required.' })
    if (!await requirePermission(databases, context, request, reply, session, 'tenant.users.roles') || !requireCsrf(request, reply, session)) return
    const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params)
    if (userId === session.userId) {
      await recordTenantAudit({
        databases,
        context,
        actorUserId: session.userId,
        action: 'user:suspend',
        resourceType: 'user_account',
        resourceId: userId,
        outcome: 'denied',
        correlationId: request.id,
        reason: 'You cannot suspend your own account.',
      })
      return reply.code(409).send({ success: false, message: 'You cannot suspend your own account.' })
    }
    try {
      await databases.withTenant(context, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [`tenant-owner-lock:${context.schemaName}`])
        const userRes = await client.query<{ account_status: string }>(
          'select account_status from user_account where user_id = $1 for update',
          [userId],
        )
        if (!userRes.rows[0]) throw new Error('User not found.')

        const rolesRes = await client.query<{ role_code: string }>(
          `select rd.role_code from role_assignment ra join role_definition rd on rd.role_id = ra.role_id where ra.user_id = $1`,
          [userId],
        )
        const targetRole = getHighestCanonicalRole(rolesRes.rows.map((r) => r.role_code))
        if (!canManageTargetUser(session.canonicalRole, targetRole)) {
          throw new Error(`Your role (${session.canonicalRole}) cannot modify a user with role ${targetRole || 'unknown'}.`)
        }
        if (targetRole === 'tenant_owner') {
          await assertNotDemotingLastOwner(client, context.schemaName, userId)
        }
        await client.query('update user_account set account_status = $1, updated_at = now() where user_id = $2', ['suspended', userId])
        await client.query(
          `insert into audit_event (actor_user_id, action, resource_type, resource_id, outcome, correlation_id)
           values ($1, 'user:suspend', 'user_account', $2, 'success', $3)`,
          [session.userId, userId, request.id],
        )
      })
      // user_session is reachable only by the login role (see the access
      // manifest). getSession also rejects non-active accounts, so a session
      // left behind by a failure here is already unusable.
      await databases.directQuery(
        context,
        `delete from ${quoteIdentifier(context.dataSchema)}.user_session where user_id = $1 and tenant_id = $2`,
        [userId, context.tenantId],
      )
      return { success: true, status: 'suspended' }
    } catch (error) {
      const msg = (error as Error).message
      await recordTenantAudit({
        databases,
        context,
        actorUserId: session.userId,
        action: 'user:suspend',
        resourceType: 'user_account',
        resourceId: userId,
        outcome: 'denied',
        correlationId: request.id,
        reason: msg,
      })
      if (
        msg.includes('cannot modify a user with role') ||
        msg.includes('must retain at least one active tenant_owner')
      ) {
        return reply.code(403).send({ success: false, message: msg })
      }
      return reply.code(400).send({ success: false, message: msg })
    }
  })

  app.get('/api/v1/audit', async (request, reply) => {
    const context = contextFor(request)
    const session = await getSession(request)
    if (!session) return reply.code(401).send({ success: false, message: 'Authentication required.' })
    if (!await requirePermission(databases, context, request, reply, session, 'tenant.audit.read')) return
    const logs = await databases.withTenant(context, async (client) =>
      (
        await client.query(
          `select a.event_id::text, a.action, a.resource_type, a.outcome, a.occurred_at,
                  coalesce(u.display_name, u.username, 'System') as actor
             from audit_event a
             left join user_account u on u.user_id = a.actor_user_id
            order by a.occurred_at desc limit 50`,
        )
      ).rows,
    )
    return {
      success: true,
      tenantId: context.tenantKey,
      total: logs.length,
      logs: logs.map((log) => ({
        id: log.event_id,
        action: log.action,
        resourceType: log.resource_type,
        outcome: log.outcome,
        occurredAt: log.occurred_at,
        actor: log.actor,
      })),
    }
  })

  app.get('/api/v1/stats', async (request, reply) => {
    const context = contextFor(request)
    const session = await getSession(request)
    if (!session) return reply.code(401).send({ success: false, message: 'Authentication required.' })
    if (!await requirePermission(databases, context, request, reply, session, 'tenant.stats.read')) return
    const stats = await databases.withTenant(context, async (client) => {
      const total = await client.query<{ total_users: number }>('select count(*)::int as total_users from user_account')
      const roles = await client.query<{ role_code: string; role_count: number }>(
        `select r.role_code, count(distinct ra.user_id)::int as role_count
           from role_definition r left join role_assignment ra on ra.role_id = r.role_id
          group by r.role_code`,
      )
      return { total: total.rows[0]?.total_users || 0, roles: roles.rows }
    })
    return {
      success: true,
      tenantId: context.tenantKey,
      stats: { totalUsers: stats.total, roleBreakdown: stats.roles },
    }
  })

  await mountModule(createInvitationsModule({ registry }))
  await mountModule(createSettingsModule({ configs }))
  await mountModule(fileService.module)
  await mountModule(createIntegrationsModule({ registry, integrations }))
  for (const module of applicationModules) await mountModule(module)

  if (config.serveStatic) {
    await app.register(staticFiles, {
      root: config.staticRoot,
      prefix: '/',
      wildcard: true,
      setHeaders(response, filePath) {
        response.raw.setHeader(
          'Content-Security-Policy',
          "default-src 'none'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https:; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; font-src 'self' https://fonts.gstatic.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; upgrade-insecure-requests",
        )
        response.raw.setHeader('Referrer-Policy', 'no-referrer')
        response.raw.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
        response.raw.setHeader(
          'Cache-Control',
          filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable',
        )
      },
    })
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ success: false, message: 'API route not found.' })
      }
      const pathname = request.url.split('?', 1)[0] || '/'
      if (pathname.startsWith('/assets/') || path.posix.extname(pathname)) {
        return reply.code(404).send({ success: false, message: 'Static asset not found.' })
      }
      reply.header('Cache-Control', 'no-store')
      return reply.sendFile('index.html')
    })
  }

  app.addHook('onClose', async () => {
    await databases.close()
    await registry.end()
  })
  return app
}

export async function startServer() {
  const server = await createServer()
  await server.listen({ host: config.host, port: config.port })
  return server
}

async function main(): Promise<void> {
  const server = await startServer()
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    const forcedExit = setTimeout(() => process.exit(1), 25_000)
    forcedExit.unref()
    try {
      await server.close()
      process.exit(0)
    } catch (error) {
      server.log.error({ error }, 'graceful shutdown failed')
      process.exit(1)
    }
  }
  process.once('SIGINT', () => void stop())
  process.once('SIGTERM', () => void stop())
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}
