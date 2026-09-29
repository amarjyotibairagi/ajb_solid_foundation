import cookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import staticFiles from '@fastify/static'
import argon2 from 'argon2'
import Fastify, {
  type FastifyReply,
  type FastifyRequest,
  type RouteHandlerMethod,
} from 'fastify'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import type { PoolClient } from 'pg'
import { z, ZodError } from 'zod'
import { createDatabaseClient } from './index.js'
import {
  createSharedRateLimitStore,
  createThrottleStore,
  sharedStateBackend,
} from '@skeleton/server-kit'

dotenv.config({
  path: path.resolve(fileURLToPath(new URL('../../..', import.meta.url)), '.env'),
  quiet: true,
})

const isProduction = process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test'
// The public origin comes from PUBLIC_PUBLIC_ORIGIN, or, when that is unset,
// from the admin panel (Platform / Configuration -> surfaces.public_origin),
// read at startup and refreshed every minute. There is no built-in default:
// a production process with neither refuses to start.
const configuredPublicOrigin = process.env.PUBLIC_PUBLIC_ORIGIN?.trim() || ''
const developmentOrigins = ['http://127.0.0.1:3653', 'http://localhost:3653']
const config = {
  host: process.env.PUBLIC_BFF_HOST || '127.0.0.1',
  port: Number(process.env.PUBLIC_BFF_PORT || 3657),
  databaseUrl: process.env.PUBLIC_DATABASE_URL || '',
  publicOrigin: configuredPublicOrigin,
  cookieSecure: isProduction || (process.env.PUBLIC_COOKIE_SECURE || '').toLowerCase() === 'true',
  serveStatic: (process.env.SERVE_PUBLIC_STATIC || '').toLowerCase() === 'true',
  staticRoot:
    process.env.PUBLIC_STATIC_ROOT ||
    path.resolve(fileURLToPath(new URL('../../..', import.meta.url)), 'frontend/public/dist'),
  sessionTtlMs: Number(process.env.PUBLIC_SESSION_TTL_MS || 8 * 60 * 60 * 1000),
  turnstileSecretKey: process.env.CLOUDFLARE_PUBLIC_TURNSTILE_SECRET_KEY || '',
}

const cookieName = config.cookieSecure ? '__Host-public_session' : 'public_session'
let allowedOrigins = new Set<string>()
type PublicSurface = {
  productName: string
  publicOrigin: string
  plans: Array<{ code: string; name: string; priceMonthly: number | null; description: string; features: string[]; version: number }>
}
let surface: PublicSurface = { productName: 'Skeleton Platform', publicOrigin: '', plans: [] }

function normalizeOrigin(value: string): string {
  if (!value) return ''
  const parsed = new URL(value)
  if (parsed.protocol !== 'https:' && isProduction) throw new Error('The public origin must use https in production.')
  return parsed.origin
}

async function refreshSurface(pool: DatabasePool): Promise<void> {
  const result = await pool.query<{ config: PublicSurface }>('select shared_state.public_surface_config() as config')
  const next = result.rows[0]?.config
  if (!next) return
  surface = next
  const origin = normalizeOrigin(configuredPublicOrigin || next.publicOrigin)
  if (!origin && isProduction) {
    throw new Error('The public app origin is not configured. Set PUBLIC_PUBLIC_ORIGIN or Platform / Configuration -> Public app origin.')
  }
  config.publicOrigin = origin || 'http://127.0.0.1:3653'
  allowedOrigins = new Set([config.publicOrigin, ...(!isProduction ? developmentOrigins : [])])
}
const validDummyHash =
  '$argon2id$v=19$m=65536,t=3,p=4$I0N+o8ublxxav+2y4Y8i2w$nlO3lNc80nFf3w4J8B8q52D1jyzSZ3GIWOhFzUzNEHs'

type DatabasePool = ReturnType<typeof createDatabaseClient>['pool']
type DatabaseConnection = PoolClient
type Session = {
  tokenHash: string
  csrfHash: string
  userId: string
  username: string
  displayName: string
  email: string | null
  planCode: string
  expiresAt: Date
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

// LOGIN_CHALLENGE=none disables Turnstile for deployments without Cloudflare.
const loginChallengeDisabled = process.env.LOGIN_CHALLENGE === 'none'

async function verifyTurnstile(token: string, remoteIp: string): Promise<boolean> {
  if (loginChallengeDisabled) return true
  if (!config.turnstileSecretKey) return !isProduction

  try {
    const body = new URLSearchParams({ secret: config.turnstileSecretKey, response: token })
    if (remoteIp) body.set('remoteip', remoteIp)
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(8_000),
    })
    if (!response.ok) return false
    const result = (await response.json()) as { success?: boolean; hostname?: string; action?: string }
    const expectedHostname = new URL(config.publicOrigin).hostname
    return (
      result.success === true &&
      result.action === 'login' &&
      (!isProduction || result.hostname === expectedHostname)
    )
  } catch {
    return false
  }
}

async function withConsumerDb<T>(
  pool: DatabasePool,
  userId: string,
  callback: (client: DatabaseConnection) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SET LOCAL ROLE consumer_runtime')
    await client.query('SET LOCAL search_path = consumer, pg_catalog')
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId])
    const result = await callback(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function getSession(pool: DatabasePool, request: FastifyRequest): Promise<Session | null> {
  const rawToken = request.cookies[cookieName]
  if (!rawToken) return null
  const tokenHash = hashToken(rawToken)
  const sessionResult = await pool.query<Session & {
    token_hash: string
    csrf_hash: string
    user_id: string
    expires_at: Date
  }>(
    `SELECT token_hash, csrf_hash, user_id, expires_at
       FROM consumer.user_session
      WHERE token_hash = $1 AND expires_at > now()`,
    [tokenHash],
  )
  const stored = sessionResult.rows[0]
  if (!stored) return null

  const profile = await withConsumerDb(pool, stored.user_id, async (client) => {
    const result = await client.query<{
      user_id: string
      username: string
      display_name: string
      email_normalized: string | null
      plan_code: string
    }>(
      `SELECT u.user_id, u.username, u.display_name, u.email_normalized,
              coalesce(s.plan_code, 'free') AS plan_code
         FROM consumer.user_account u
         LEFT JOIN consumer.subscription s ON s.user_id = u.user_id
        WHERE u.user_id = $1 AND u.account_status = 'active'`,
      [stored.user_id],
    )
    return result.rows[0]
  })
  if (!profile) return null

  void pool
    .query('UPDATE consumer.user_session SET last_seen_at = now() WHERE token_hash = $1', [tokenHash])
    .catch((error: unknown) => request.log.warn({ error }, 'session last-seen update failed'))
  return {
    tokenHash,
    csrfHash: stored.csrf_hash,
    userId: profile.user_id,
    username: profile.username,
    displayName: profile.display_name,
    email: profile.email_normalized,
    planCode: profile.plan_code,
    expiresAt: stored.expires_at,
  }
}

function publicUser(session: Session) {
  return {
    id: session.userId,
    username: session.username,
    displayName: session.displayName,
    email: session.email,
    role: 'consumer',
    planCode: session.planCode,
  }
}

function requireOrigin(request: FastifyRequest, reply: FastifyReply): boolean {
  const origin = request.headers.origin
  if (!origin || !allowedOrigins.has(origin)) {
    void reply.code(403).send({ success: false, message: 'Request origin is not allowed.' })
    return false
  }
  return true
}

function requireCsrf(request: FastifyRequest, reply: FastifyReply, session: Session): boolean {
  const supplied = request.headers['x-csrf-token']
  if (typeof supplied !== 'string' || !secureEqual(hashToken(supplied), session.csrfHash)) {
    void reply.code(403).send({ success: false, message: 'CSRF verification failed.' })
    return false
  }
  return true
}

export async function createServer() {
  if (!config.databaseUrl) throw new Error('PUBLIC_DATABASE_URL is required.')
  if (loginChallengeDisabled) console.warn('[public-bff] LOGIN_CHALLENGE=none: Turnstile verification is disabled for sign-in.')
  if (isProduction && !config.turnstileSecretKey && !loginChallengeDisabled) {
    throw new Error('CLOUDFLARE_PUBLIC_TURNSTILE_SECRET_KEY is required in production.')
  }

  const database = createDatabaseClient(config.databaseUrl)
  const pool = database.pool
  const identity = await pool.query<{ current_user: string }>('SELECT current_user')
  if (identity.rows[0]?.current_user !== 'consumer_bff_login') {
    await pool.end()
    throw new Error('PUBLIC_DATABASE_URL must authenticate as consumer_bff_login.')
  }
  try {
    await refreshSurface(pool)
  } catch (error) {
    await pool.end()
    throw error
  }
  const surfaceTimer = setInterval(() => {
    refreshSurface(pool).catch((error: unknown) => console.error('[public-bff] surface refresh failed', error))
  }, 60_000)
  surfaceTimer.unref()
  const loginThrottle = createThrottleStore(pool)

  const app = Fastify({
    logger: { redact: ['req.headers.cookie', 'req.headers.authorization', 'req.body.password'] },
    bodyLimit: 64 * 1024,
    trustProxy: ['127.0.0.1', '::1'],
    genReqId: () => crypto.randomUUID(),
  })
  await app.register(cookie)
  await app.register(rateLimit, {
    max: 200,
    timeWindow: '1 minute',
    ...(sharedStateBackend() === 'postgres' ? { store: createSharedRateLimitStore(pool), skipOnError: true } : {}),
  })
  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    hsts: config.cookieSecure ? { maxAge: 31_536_000, preload: true, includeSubDomains: true } : false,
  })

  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store')
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) requireOrigin(request, reply)
  })
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ success: false, message: 'Invalid request.' })
    }
    app.log.error(error)
    return reply.code(500).send({ success: false, message: 'The request could not be completed.' })
  })

  app.get('/api/health', async (_request, reply) => {
    try {
      await pool.query('SELECT 1')
      return { success: true, domain: 'consumer', status: 'ok', timestamp: new Date().toISOString() }
    } catch {
      return reply.code(503).send({ success: false, status: 'unavailable' })
    }
  })

  const sessionHandler: RouteHandlerMethod = async (request) => {
    const session = await getSession(pool, request)
    if (!session) return { success: true, authenticated: false, user: null, csrfToken: null }
    const csrfToken = crypto.randomBytes(32).toString('base64url')
    await pool.query('UPDATE consumer.user_session SET csrf_hash = $1 WHERE token_hash = $2', [
      hashToken(csrfToken),
      session.tokenHash,
    ])
    return { success: true, authenticated: true, user: publicUser(session), csrfToken }
  }
  app.get('/api/auth/session', sessionHandler)
  app.get('/api/v1/auth/session', sessionHandler)

  const loginSchema = z.object({
    username: z.string().trim().min(1).max(255),
    password: z.string().min(12).max(512),
    turnstileToken: z.string().min(20).max(4096),
  })
  const loginHandler: RouteHandlerMethod = async (request, reply) => {
    const body = loginSchema.parse(request.body)
    if (!(await loginThrottle.allowed(`public:${body.username}`))) {
      return reply.code(429).send({ success: false, message: 'Too many sign-in attempts. Try again later.' })
    }
    if (!(await verifyTurnstile(body.turnstileToken, request.ip))) {
      await pool.query("select consumer.record_auth_event(null, 'auth.login', 'denied', $1)", [request.id])
      return reply.code(403).send({ success: false, message: 'Human verification failed.' })
    }
    const candidateResult = await pool.query<{
      user_id: string
      username: string
      display_name: string
      email_normalized: string | null
      password_hash: string | null
      account_status: string
      plan_code: string
    }>('SELECT * FROM consumer.lookup_login_candidate($1)', [body.username])
    const candidate = candidateResult.rows[0]
    let passwordValid = false
    try {
      passwordValid = await argon2.verify(candidate?.password_hash || validDummyHash, body.password)
    } catch {
      passwordValid = false
    }
    if (!candidate || candidate.account_status !== 'active' || !passwordValid) {
      await loginThrottle.failure(`public:${body.username}`)
      await pool.query("select consumer.record_auth_event($1, 'auth.login', 'denied', $2)", [
        candidate?.user_id || null,
        request.id,
      ])
      return reply.code(401).send({ success: false, message: 'Invalid username or password.' })
    }

    await loginThrottle.success(`public:${body.username}`)

    const rawSessionToken = crypto.randomBytes(32).toString('base64url')
    const csrfToken = crypto.randomBytes(32).toString('base64url')
    await pool.query(
      `INSERT INTO consumer.user_session (user_id, token_hash, csrf_hash, expires_at)
       VALUES ($1, $2, $3, now() + ($4 * interval '1 millisecond'))`,
      [candidate.user_id, hashToken(rawSessionToken), hashToken(csrfToken), config.sessionTtlMs],
    )
    await pool.query("select consumer.record_auth_event($1, 'auth.login', 'success', $2)", [candidate.user_id, request.id])
    reply.setCookie(cookieName, rawSessionToken, {
      path: '/',
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: 'strict',
      maxAge: Math.floor(config.sessionTtlMs / 1000),
    })
    return {
      success: true,
      user: publicUser({
        tokenHash: hashToken(rawSessionToken),
        csrfHash: hashToken(csrfToken),
        userId: candidate.user_id,
        username: candidate.username,
        displayName: candidate.display_name,
        email: candidate.email_normalized,
        planCode: candidate.plan_code,
        expiresAt: new Date(Date.now() + config.sessionTtlMs),
      }),
      csrfToken,
    }
  }
  app.post('/api/auth/login', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, loginHandler)
  app.post('/api/v1/auth/login', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, loginHandler)

  const logoutHandler: RouteHandlerMethod = async (request, reply) => {
    const session = await getSession(pool, request)
    if (!session) return reply.code(401).send({ success: false, message: 'Authentication required.' })
    if (!requireCsrf(request, reply, session)) return
    await pool.query('DELETE FROM consumer.user_session WHERE token_hash = $1', [session.tokenHash])
    await pool.query("select consumer.record_auth_event($1, 'auth.logout', 'success', $2)", [session.userId, request.id])
    reply.clearCookie(cookieName, { path: '/' })
    return { success: true }
  }
  app.post('/api/auth/logout', logoutHandler)
  app.post('/api/v1/auth/logout', logoutHandler)

  app.get('/api/v1/me', async (request, reply) => {
    const session = await getSession(pool, request)
    if (!session) return reply.code(401).send({ success: false, message: 'Authentication required.' })
    return { success: true, user: publicUser(session) }
  })

  const usersQuery = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    search: z.string().trim().max(100).default(''),
    plan: z.enum(['free', 'plus', 'pro', 'ultra']).optional(),
  })

  const projectCreateSchema = z.object({
    title: z.string().trim().min(1).max(160),
    type: z.enum(['Document', 'Collection', 'Workspace']),
  })

  app.get('/api/v1/projects', async (request, reply) => {
    const session = await getSession(pool, request)
    if (!session) return reply.code(401).send({ success: false, message: 'Authentication required.' })
    const projects = await withConsumerDb(pool, session.userId, async (client) =>
      (await client.query(
        `select project_id::text as id, title, project_type as type, created_at, updated_at
           from consumer.workspace_project
          order by updated_at desc
          limit 100`,
      )).rows,
    )
    return { success: true, projects }
  })

  app.post('/api/v1/projects', async (request, reply) => {
    const session = await getSession(pool, request)
    if (!session) return reply.code(401).send({ success: false, message: 'Authentication required.' })
    if (!requireCsrf(request, reply, session)) return
    const body = projectCreateSchema.parse(request.body)
    const project = await withConsumerDb(pool, session.userId, async (client) =>
      (await client.query(
        `insert into consumer.workspace_project (owner_user_id, title, project_type)
         values ($1, $2, $3)
         returning project_id::text as id, title, project_type as type, created_at, updated_at`,
        [session.userId, body.title, body.type],
      )).rows[0],
    )
    return reply.code(201).send({ success: true, project })
  })

  app.get('/api/v1/users', async (request, reply) => {
    const session = await getSession(pool, request)
    if (!session) return reply.code(401).send({ success: false, message: 'Authentication required.' })
    const query = usersQuery.parse(request.query)
    const users = await withConsumerDb(pool, session.userId, async (client) => {
      const params: unknown[] = []
      let sql = `SELECT u.user_id, u.username, u.display_name, u.email_normalized, u.account_status,
                        u.created_at, coalesce(s.plan_code, 'free') AS plan_code
                   FROM consumer.user_account u
                   LEFT JOIN consumer.subscription s ON s.user_id = u.user_id
                  WHERE u.account_status <> 'deleted'`
      if (query.search) {
        params.push(`%${query.search.toLowerCase()}%`)
        sql += ` AND (lower(u.display_name) LIKE $${params.length} OR lower(u.username) LIKE $${params.length})`
      }
      if (query.plan) {
        params.push(query.plan)
        sql += ` AND coalesce(s.plan_code, 'free') = $${params.length}`
      }
      params.push(query.limit)
      sql += ` ORDER BY u.created_at DESC LIMIT $${params.length}`
      return (await client.query(sql, params)).rows as Array<Record<string, unknown>>
    })
    return {
      success: true,
      total: users.length,
      users: users.map((user) => ({
        id: user.user_id,
        username: user.username,
        displayName: user.display_name,
        email: user.email_normalized,
        status: user.account_status,
        plan: user.plan_code,
        createdAt: user.created_at,
      })),
    }
  })

  // Plans are managed in the admin panel (Platform / Plans, audience b2c).
  app.get('/api/v1/subscriptions/plans', async () => ({
    success: true,
    plans: surface.plans.map((plan) => ({
      code: plan.code,
      name: plan.name,
      priceMonthly: plan.priceMonthly === null ? null : Number(plan.priceMonthly),
      description: plan.description,
      features: plan.features,
    })),
  }))

  app.get('/api/public-config', async () => ({ success: true, productName: surface.productName }))

  app.post('/api/v1/me/subscription', async (request, reply) => {
    const session = await getSession(pool, request)
    if (!session) return reply.code(401).send({ success: false, message: 'Authentication required.' })
    if (!requireCsrf(request, reply, session)) return
    return reply.code(501).send({ success: false, message: 'Billing checkout is not configured.' })
  })

  if (config.serveStatic) {
    await app.register(staticFiles, {
      root: config.staticRoot,
      prefix: '/',
      wildcard: true,
      setHeaders(response, filePath) {
        response.raw.setHeader(
          'Content-Security-Policy',
          "default-src 'none'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data:; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; font-src 'self' https://fonts.gstatic.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; upgrade-insecure-requests",
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
    clearInterval(surfaceTimer)
    await pool.end()
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
