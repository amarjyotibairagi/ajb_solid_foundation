import cookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import staticFiles from '@fastify/static'
import argon2 from 'argon2'
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { z } from 'zod'
import {
  configStringList,
  createSharedRateLimitStore,
  createThrottleStore,
  deploymentSetting,
  NotificationSender,
  sharedStateBackend,
  type ResolvedConfig,
} from '@skeleton/server-kit'
import { issueOwnerInvitation, registerAdminRoutes } from './admin-routes.js'
import { APIError, type CloudflareDnsRecordCreateParams } from '@skeleton/cloudflare'
import { createCloudflareClient, createDatabaseClient } from './index.js'
import {
  createTenantDeprovisioningJob,
  createTenantProvisioningJob,
  createTenantSchema,
  getProvisioningJob,
  listTenants,
  resumeTenant,
  retryProvisioningJob,
  suspendTenant,
  tenantKeyParamsSchema,
  TenantProvisioningConflictError,
  TenantStateConflictError,
} from './tenant-provisioning.js'
import {
  requireRecentMfa,
  isMfaRecent,
  generateRegistrationChallenge,
  verifyRegistrationAssertion,
  generateAuthenticationChallenge,
  verifyAuthenticationAssertion,
  getUserWebAuthnCredentials,
  disablePlatformUser,
} from './mfa.js'

if (process.env.NODE_ENV !== 'test') {
  dotenv.config({
    path: path.resolve(fileURLToPath(new URL('../..', import.meta.url)), '.env'),
    quiet: true,
  })
}

type PlatformRole = 'platform_owner' | 'platform_admin' | 'platform_viewer'

interface AuthUser {
  id: string
  username: string
  role: PlatformRole
}

interface AuthContext {
  sessionId: string
  csrfHash: string
  user: AuthUser
  mfaVerifiedAt: Date | null
}

interface DeploymentMode {
  raw: string | undefined
  isProduction: boolean
  ambiguous: boolean
}

function resolveDeploymentMode(): DeploymentMode {
  const raw = process.env.NODE_ENV
  if (raw === 'production') return { raw, isProduction: true, ambiguous: false }
  if (raw === 'development' || raw === 'test') return { raw, isProduction: false, ambiguous: false }
  // Missing or unrecognized NODE_ENV: fail closed. Cookie Secure, Turnstile
  // enforcement, and the Postgres-superuser guard all previously keyed off
  // their own independent `NODE_ENV === 'production'` check with a
  // fail-open default, so a missing/misspelled NODE_ENV silently downgraded
  // multiple protections at once. Treat ambiguity as production-strength
  // requirements instead.
  return { raw, isProduction: true, ambiguous: true }
}

const deploymentMode = resolveDeploymentMode()
if (deploymentMode.ambiguous) {
  console.error(
    `[platform-bff] NODE_ENV is not set to a recognized value (got: ${JSON.stringify(deploymentMode.raw ?? null)}). ` +
      'Treating this process as PRODUCTION for security defaults (Secure cookies, Turnstile enforcement, ' +
      'PostgreSQL-superuser guard all enforced). Set NODE_ENV=development explicitly for local development.',
  )
}

const config = {
  host: process.env.PLATFORM_BFF_HOST || '127.0.0.1',
  port: Number(process.env.PLATFORM_BFF_PORT || 3656),
  frontendOrigin: process.env.PLATFORM_FRONTEND_ORIGIN || 'http://127.0.0.1:3652',
  publicOrigin: deploymentSetting('PLATFORM_PUBLIC_ORIGIN', { production: deploymentMode.isProduction, developmentDefault: 'https://platform.example.test' }),
  cookieSecure: (process.env.PLATFORM_COOKIE_SECURE || '').toLowerCase() === 'true' || deploymentMode.isProduction,
  turnstileSecret: process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY || '',
  cloudflareToken: process.env.CLOUDFLARE_PLATFORM_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN || '',
  cloudflareApiKey: process.env.CLOUDFLARE_API_KEY || '',
  cloudflareApiEmail: process.env.CLOUDFLARE_EMAIL || process.env.CLOUDFLARE_API_EMAIL || '',
  cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
  cloudflareZoneId: process.env.CLOUDFLARE_ZONE_ID || '',
  cloudflareZoneName: deploymentSetting('CLOUDFLARE_ZONE_NAME', { production: deploymentMode.isProduction, developmentDefault: 'example.test' }),
  platformTunnelId: process.env.PLATFORM_TUNNEL_ID || '',
  tenantRootDomain: deploymentSetting('TENANT_ROOT_DOMAIN', { production: deploymentMode.isProduction, developmentDefault: 'example.test' }).toLowerCase(),
  sessionTtlMs: Number(process.env.PLATFORM_SESSION_TTL_MS || 8 * 60 * 60 * 1000),
  servePlatformStatic: (process.env.SERVE_PLATFORM_STATIC || '').toLowerCase() === 'true',
  platformStaticRoot:
    process.env.PLATFORM_STATIC_ROOT ||
    path.resolve(fileURLToPath(new URL('../..', import.meta.url)), 'frontend/platform/dist'),
}

const allowedOrigins = new Set([config.frontendOrigin, config.publicOrigin])
const mutatingMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const cookieName = config.cookieSecure ? '__Host-platform_session' : 'platform_session'
const ownerRoles = new Set<PlatformRole>(['platform_owner'])
const adminRoles = new Set<PlatformRole>(['platform_owner', 'platform_admin'])
const anyPlatformRole = new Set<PlatformRole>(['platform_owner', 'platform_admin', 'platform_viewer'])
const tunnelIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const managedSubdomainLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

const loginSchema = z.object({
  username: z.string().trim().min(1).max(255),
  password: z.string().min(1).max(512),
  turnstileToken: z.string().min(20).max(4096),
})

const dnsCreateSchema = z.object({
  label: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, 'Enter a subdomain.')
    .max(63, 'Subdomain must be 63 characters or fewer.')
    .regex(managedSubdomainLabelPattern, 'Subdomain may contain lowercase letters, numbers, and internal hyphens.'),
})

const dnsDeleteSchema = z.object({
  id: z.string().trim().min(8).max(128),
})

const provisioningJobParamsSchema = z.object({ jobId: z.uuid() })

const platformCsp = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-src https://challenges.cloudflare.com",
].join('; ')

function assertRuntimeDatabaseUser() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) return

  try {
    const username = new URL(databaseUrl).username
    if (username === 'postgres') {
      if (deploymentMode.isProduction) {
        throw new Error('Refusing to start platform BFF in production with PostgreSQL superuser credentials.')
      }
      console.warn('Warning: platform BFF is using PostgreSQL superuser credentials. Use database/runtime-role-platform.sql before production.')
    }
  } catch (error) {
    if (error instanceof TypeError) return
    throw error
  }
}

function hashSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function createOpaqueToken(): string {
  return randomBytes(32).toString('base64url')
}

function safeCompareHex(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a, 'hex')
  const bBuffer = Buffer.from(b, 'hex')
  return aBuffer.length === bBuffer.length && timingSafeEqual(aBuffer, bBuffer)
}

function normalizeRole(value: unknown): PlatformRole | null {
  if (value === 'platform_owner' || value === 'platform_admin' || value === 'platform_viewer') return value
  return null
}

// Fixed argon2id hash with no corresponding password, used to equalize login
// timing for unknown usernames -- see verifyLoginCredentials. Its parameters
// must match ARGON2_OPTIONS so it stays a faithful timing proxy.
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$I0N+o8ublxxav+2y4Y8i2w$nlO3lNc80nFf3w4J8B8q52D1jyzSZ3GIWOhFzUzNEHs'

// Password verification happens here, in this process, with the same argon2id
// parameters the tenant and public BFFs use (m=65536, t=3, p=4). The previous
// implementation passed the plaintext password to PostgreSQL as a bind
// parameter for pgcrypto's crypt(), which put operator credentials within reach
// of statement logging, pg_stat_activity, and any auditing extension. Hashes
// are written only by scripts/platform-operator.mjs.

interface LoginCredentialResult {
  id: string
  username: string
  role: string
}

async function verifyLoginCredentials(
  pool: ReturnType<typeof createDatabaseClient>['pool'],
  username: string,
  password: string,
): Promise<LoginCredentialResult | null> {
  const result = await pool.query<{
    id: string
    username: string
    role: string
    password_hash: string | null
  }>(
    `select id, username, role, password_hash
       from platform.platform_user
      where lower(username) = lower($1) and is_active = true
      limit 1`,
    [username],
  )

  const row = result.rows[0]
  // Always run a verification, even for an unknown username, so a missing
  // account is not distinguishable by response time.
  let passwordMatches = false
  try {
    passwordMatches = await argon2.verify(row?.password_hash || DUMMY_PASSWORD_HASH, password)
  } catch {
    passwordMatches = false
  }

  if (!row || !row.id || !row.username || !row.role || !passwordMatches) return null
  return { id: row.id, username: row.username, role: row.role }
}

function clientIp(request: FastifyRequest): string {
  const forwardedFor = request.headers['cf-connecting-ip'] || request.headers['x-forwarded-for']
  if (Array.isArray(forwardedFor)) return forwardedFor[0] || request.ip
  if (forwardedFor) return forwardedFor.split(',')[0]?.trim() || request.ip
  return request.ip
}

function sendUnauthorized(reply: FastifyReply, message = 'Authentication required') {
  return reply.code(401).send({ success: false, message })
}

function sendForbidden(reply: FastifyReply, message = 'Not allowed') {
  return reply.code(403).send({ success: false, message })
}

// LOGIN_CHALLENGE=none disables Turnstile for deployments without Cloudflare.
// Login throttling and rate limits still apply.
const loginChallengeDisabled = process.env.LOGIN_CHALLENGE === 'none'
if (loginChallengeDisabled) {
  console.warn('[platform-bff] LOGIN_CHALLENGE=none: Turnstile verification is disabled for sign-in.')
}

async function verifyTurnstile(token: string, remoteIp: string, request?: FastifyRequest): Promise<boolean> {
  if (loginChallengeDisabled) return true
  if (!config.turnstileSecret) return !deploymentMode.isProduction

  const body = new URLSearchParams({
    secret: config.turnstileSecret,
    response: token,
    remoteip: remoteIp,
  })

  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body,
    signal: AbortSignal.timeout(8_000),
  })

  if (!response.ok) {
    request?.log.warn({ status: response.status }, 'turnstile siteverify returned non-OK response')
    return false
  }
  const result = (await response.json()) as { success?: boolean; 'error-codes'?: string[]; hostname?: string; action?: string }
  if (result.success !== true) {
    request?.log.warn(
      {
        errorCodes: result['error-codes'] || [],
        hostname: result.hostname || null,
        action: result.action || null,
      },
      'turnstile siteverify rejected token',
    )
    return false
  }
  if (deploymentMode.isProduction) {
    const expectedHostname = new URL(config.publicOrigin).hostname
    if (result.hostname !== expectedHostname || result.action !== 'login') {
      request?.log.warn(
        { expectedHostname, gotHostname: result.hostname, gotAction: result.action },
        'turnstile token hostname or action binding mismatch',
      )
      return false
    }
  }
  return true
}

async function audit(
  pool: ReturnType<typeof createDatabaseClient>['pool'],
  userId: string | null,
  feature: string,
  action: string,
  status: string,
) {
  await pool.query(
    `insert into platform.platform_audit (user_id, feature, action, status)
     values ($1, $2, $3, $4)`,
    [userId, feature, action, status.toUpperCase()],
  )
}

async function auditFailure(
  pool: ReturnType<typeof createDatabaseClient>['pool'],
  request: FastifyRequest,
  userId: string,
  action: string,
  cause: unknown,
) {
  try {
    await audit(pool, userId, 'cloudflare_dns', action, 'failed')
  } catch (auditError) {
    request.log.error({ auditError, cause, action }, 'failed to persist Cloudflare mutation failure audit')
  }
}

async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  pool: ReturnType<typeof createDatabaseClient>['pool'],
  roles: Set<PlatformRole>,
): Promise<AuthContext | null> {
  const rawToken = request.cookies[cookieName] || (!deploymentMode.isProduction ? (request.cookies['__Host-platform_session'] || request.cookies['platform_session']) : undefined)
  if (!rawToken) {
    sendUnauthorized(reply)
    return null
  }

  const tokenHash = hashSecret(rawToken)
  const session = await pool.query<{
    session_id: string
    csrf_hash: string
    expires_at: Date
    user_id: string
    username: string
    role: string
    mfa_verified_at: Date | null
  }>(
    `select
       s.id as session_id,
       s.csrf_hash,
       s.expires_at,
       s.mfa_verified_at,
       u.id as user_id,
       u.username,
       u.role
     from platform.platform_session s
     join platform.platform_user u on u.id = s.user_id
     where s.token_hash = $1 and s.expires_at > now() and u.is_active = true`,
    [tokenHash],
  )

  const row = session.rows[0]
  if (!row) {
    reply.clearCookie(cookieName, { path: '/' })
    sendUnauthorized(reply)
    return null
  }

  const role = normalizeRole(row.role)
  if (!role || !roles.has(role)) {
    sendForbidden(reply)
    return null
  }

  await pool.query('update platform.platform_session set last_seen_at = now() where id = $1', [row.session_id])
  return {
    sessionId: row.session_id,
    csrfHash: row.csrf_hash,
    user: { id: row.user_id, username: row.username, role },
    mfaVerifiedAt: row.mfa_verified_at ? new Date(row.mfa_verified_at) : null,
  }
}

function requireCsrf(request: FastifyRequest, reply: FastifyReply, auth: AuthContext): boolean {
  const header = request.headers['x-csrf-token']
  const token = Array.isArray(header) ? header[0] : header
  if (!token || !safeCompareHex(hashSecret(token), auth.csrfHash)) {
    sendForbidden(reply, 'CSRF validation failed')
    return false
  }
  return true
}

function requireCloudflare() {
  if (config.cloudflareApiKey && config.cloudflareApiEmail) {
    return createCloudflareClient({ apiKey: config.cloudflareApiKey, apiEmail: config.cloudflareApiEmail })
  }

  if (config.cloudflareToken) {
    return createCloudflareClient({ apiToken: config.cloudflareToken })
  }

  throw new Error('Configure either CLOUDFLARE_API_TOKEN or CLOUDFLARE_API_KEY plus CLOUDFLARE_EMAIL.')
}

function zoneHostname(inputLabel: string): string {
  const label = inputLabel.trim().toLowerCase()
  if (!managedSubdomainLabelPattern.test(label)) {
    throw new Error('Subdomain label is invalid.')
  }
  const zone = config.cloudflareZoneName.toLowerCase()
  return `${label}.${zone}`
}

function isProtectedHostname(name: string): boolean {
  const cleanName = name.trim().toLowerCase().replace(/\.$/, '')
  const protectedNames = new Set([
    config.cloudflareZoneName.toLowerCase(),
    `www.${config.cloudflareZoneName.toLowerCase()}`,
    `platform.${config.cloudflareZoneName.toLowerCase()}`,
    `user.${config.cloudflareZoneName.toLowerCase()}`,
    `*.${config.cloudflareZoneName.toLowerCase()}`,
  ])
  return protectedNames.has(cleanName)
}

function platformTunnelTarget(): string | null {
  return tunnelIdPattern.test(config.platformTunnelId)
    ? `${config.platformTunnelId}.cfargotunnel.com`
    : null
}

function isManagedSubdomainRecord(record: {
  name: string
  type: string
  content?: string
  proxied?: boolean
}): boolean {
  const target = platformTunnelTarget()
  if (!target || record.type !== 'CNAME' || record.proxied !== true) return false

  const zone = config.cloudflareZoneName.trim().toLowerCase().replace(/\.$/, '')
  const hostname = record.name.trim().toLowerCase().replace(/\.$/, '')
  const suffix = `.${zone}`
  const label = hostname.endsWith(suffix) ? hostname.slice(0, -suffix.length) : ''
  const content = (record.content || '').trim().toLowerCase().replace(/\.$/, '')
  return Boolean(label) && !label.includes('.') && content === target.toLowerCase()
}

function hardwareSnapshot() {
  const cpus = os.cpus()
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const usedMem = totalMem - freeMem
  const loadAvg = os.loadavg()
  let disk = {
    filesystem: '/',
    totalBytes: 0,
    usedBytes: 0,
    availBytes: 0,
    usedPercent: 0,
    totalGB: '0',
    usedGB: '0',
    availGB: '0',
  }

  try {
    const dfOutput = execFileSync('df', ['-k', '/'], { encoding: 'utf8' }).trim().split('\n')
    const parts = dfOutput[1]?.replace(/\s+/g, ' ').split(' ') || []
    const totalKb = Number(parts[1] || 0)
    const usedKb = Number(parts[2] || 0)
    const availKb = Number(parts[3] || 0)
    const totalBytes = totalKb * 1024
    const usedBytes = usedKb * 1024
    const availBytes = availKb * 1024
    disk = {
      filesystem: parts[0] || '/',
      totalBytes,
      usedBytes,
      availBytes,
      usedPercent: totalBytes ? Math.round((usedBytes / totalBytes) * 100) : 0,
      totalGB: (totalBytes / 1024 ** 3).toFixed(1),
      usedGB: (usedBytes / 1024 ** 3).toFixed(1),
      availGB: (availBytes / 1024 ** 3).toFixed(1),
    }
  } catch {
    // Telemetry is best effort.
  }

  return {
    success: true,
    timestamp: new Date().toISOString(),
    cpu: {
      model: cpus[0]?.model || 'Generic Processor',
      cores: cpus.length,
      speedMhz: cpus[0]?.speed || 0,
      loadAvg: {
        '1m': Number(loadAvg[0]?.toFixed(2) || 0),
        '5m': Number(loadAvg[1]?.toFixed(2) || 0),
        '15m': Number(loadAvg[2]?.toFixed(2) || 0),
      },
      coresList: cpus.map((core, index) => ({
        core: index,
        model: core.model,
        speedMhz: core.speed,
      })),
    },
    memory: {
      totalBytes: totalMem,
      freeBytes: freeMem,
      usedBytes: usedMem,
      cachedBytes: 0,
      buffersBytes: 0,
      usedPercent: Number(((usedMem / totalMem) * 100).toFixed(1)),
      totalGB: (totalMem / 1024 ** 3).toFixed(2),
      freeGB: (freeMem / 1024 ** 3).toFixed(2),
      usedGB: (usedMem / 1024 ** 3).toFixed(2),
    },
    storage: disk,
    system: {
      hostname: os.hostname(),
      platform: os.platform(),
      osName: os.type(),
      release: os.release(),
      arch: os.arch(),
      uptimeSeconds: Math.floor(os.uptime()),
    },
  }
}

function servicesSnapshot() {
  const ssOutput = execFileSync('ss', ['-tulpn'], { encoding: 'utf8' })
  const psOutput = execFileSync('ps', ['-eo', 'pid,ppid,user,%cpu,%mem,rss,etime,comm'], { encoding: 'utf8' })
    .trim()
    .split('\n')

  const psMap = new Map<number, { pid: number; user: string; cpu: number; mem: number; rssMb: string; uptime: string; cmd: string }>()
  for (const line of psOutput.slice(1)) {
    const parts = line.trim().split(/\s+/)
    const pid = Number(parts[0] || 0)
    if (!pid) continue
    psMap.set(pid, {
      pid,
      user: parts[2] || 'unknown',
      cpu: Number(parts[3] || 0),
      mem: Number(parts[4] || 0),
      rssMb: (Number(parts[5] || 0) / 1024).toFixed(1),
      uptime: parts[6] || '',
      cmd: parts[7] || 'process',
    })
  }

  const services = []
  const seenPorts = new Set<string>()
  for (const line of ssOutput.split('\n')) {
    if (!line.includes('LISTEN')) continue
    const port = line.match(/(?:[0-9.]+|\[::\]|\*):([0-9]+)\s+/)?.[1]
    if (!port || seenPorts.has(port) || ['22', '53', '111', '5355'].includes(port)) continue
    seenPorts.add(port)

    const pid = Number(line.match(/pid=([0-9]+)/)?.[1] || 0)
    const proc = psMap.get(pid)
    const cpuPercent = proc?.cpu || 0
    const memPercent = proc?.mem || 0
    const memoryMb = proc?.rssMb || '0.0'
    services.push({
      id: `${port}-${pid || 'unknown'}`,
      port: Number(port),
      pid: pid || null,
      protocol: line.startsWith('tcp') ? 'TCP' : 'UDP',
      address: line.match(/\s([0-9.*:\[\]]+:[0-9]+)\s/)?.[1] || 'local',
      name: ['3652', '3655', '3656'].includes(port) ? 'Platform Service' : proc?.cmd || 'Application Service',
      category: ['3652', '3655', '3656'].includes(port) ? 'Platform' : 'Application Service',
      description: `Listening service on port ${port}`,
      user: proc?.user || 'unknown',
      cpu: cpuPercent,
      mem: memPercent,
      rssMb: memoryMb,
      cpuPercent,
      memPercent,
      memoryMb,
      uptime: proc?.uptime || '',
      cmd: proc?.cmd || '',
      status: 'LISTEN',
    })
  }

  return {
    success: true,
    timestamp: new Date().toISOString(),
    services,
    summary: {
      totalServices: services.length,
      listeningPorts: services.length,
      totalCpu: Number(services.reduce((sum, service) => sum + service.cpu, 0).toFixed(1)),
      totalMem: Number(services.reduce((sum, service) => sum + service.mem, 0).toFixed(1)),
      totalCpuPercent: Number(services.reduce((sum, service) => sum + service.cpuPercent, 0).toFixed(1)),
      totalMemoryMb: services.reduce((sum, service) => sum + Number(service.memoryMb || 0), 0).toFixed(1),
      totalMemoryGb: (services.reduce((sum, service) => sum + Number(service.memoryMb || 0), 0) / 1024).toFixed(2),
    },
  }
}

export async function createServer(): Promise<FastifyInstance> {
  assertRuntimeDatabaseUser()
  const database = createDatabaseClient()
  const pool = database.pool
  const databaseIdentity = await pool.query<{ current_user: string }>('select current_user')
  if (databaseIdentity.rows[0]?.current_user !== 'platform_bff_runtime') {
    await pool.end()
    throw new Error('DATABASE_URL must authenticate as platform_bff_runtime.')
  }

  const app = Fastify({
    logger: {
      redact: ['req.headers.cookie', 'req.headers.authorization', 'req.body.password'],
    },
    bodyLimit: 64 * 1024,
    // Trust X-Forwarded-For / CF-Connecting-IP only when the immediate TCP
    // peer is loopback. This matches the deployed topology: the app binds
    // to 127.0.0.1 only (config.host) and the only process expected to
    // connect is the local cloudflared tunnel making a single local hop.
    // Residual risk: this still fully depends on (a) config.host never
    // becoming 0.0.0.0, and (b) no other local process on this host being
    // able to reach 127.0.0.1:<port> and inject forged forwarding headers --
    // i.e. host-level process isolation is a trust boundary here, not just
    // the network.
    trustProxy: ['127.0.0.1', '::1'],
  })

  const notifier = new NotificationSender()
  // Platform-scope configuration (registry migration 027), cached briefly.
  let platformConfigCache: { expiresAt: number; value: Promise<Pick<ResolvedConfig, 'values'>> } | null = null
  const platformConfig = (): Promise<Pick<ResolvedConfig, 'values'>> => {
    if (!platformConfigCache || platformConfigCache.expiresAt < Date.now()) {
      const value = pool
        .query<{ values: ResolvedConfig['values'] }>('select platform.resolve_platform_config() as values')
        .then((result) => ({ values: result.rows[0]?.values ?? {} }))
      value.catch(() => { platformConfigCache = null })
      platformConfigCache = { expiresAt: Date.now() + 10_000, value }
    }
    return platformConfigCache.value
  }

  // Per-account login throttle and request rate limits. With
  // SHARED_STATE_BACKEND=postgres both are shared by every process.
  const loginThrottle = createThrottleStore(pool)
  await app.register(cookie)
  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
    ...(sharedStateBackend() === 'postgres' ? { store: createSharedRateLimitStore(pool), skipOnError: true } : {}),
  })
  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    hsts: config.cookieSecure ? { maxAge: 31_536_000, preload: true, includeSubDomains: true } : false,
  })

  app.setErrorHandler((error, request, reply) => {
    // Messages raised by the control-plane functions (migrations 026, 027)
    // are authored for operators and contain no internal detail.
    const databaseCode = (error as { code?: string }).code
    if (databaseCode === '22023') return reply.code(400).send({ success: false, message: (error as Error).message })
    if (databaseCode === '55000') return reply.code(409).send({ success: false, message: (error as Error).message })

    request.log.error({ error }, 'platform BFF request failed')

    if (error instanceof z.ZodError) {
      const issue = error.issues[0]
      return reply.code(400).send({
        success: false,
        message: issue?.message || 'Request validation failed.',
      })
    }

    if (error instanceof APIError) {
      const providerStatus = error.status
      if (providerStatus === 400 || providerStatus === 409 || providerStatus === 422) {
        const providerIssue = error.errors.find(
          (item): item is { message: string } =>
            typeof item === 'object' && item !== null && 'message' in item && typeof item.message === 'string',
        )
        return reply.code(providerStatus).send({
          success: false,
          message: providerIssue?.message || 'Cloudflare rejected the DNS record.',
        })
      }
      if (providerStatus === 429) {
        return reply.code(429).send({ success: false, message: 'Cloudflare rate limit reached. Try again shortly.' })
      }
      if (providerStatus === 401 || providerStatus === 403) {
        return reply.code(502).send({ success: false, message: 'Cloudflare authorization failed.' })
      }
      if (providerStatus === 404) {
        return reply.code(502).send({ success: false, message: 'Cloudflare resource was not found.' })
      }
      return reply.code(502).send({ success: false, message: 'Cloudflare request failed.' })
    }

    const errorWithStatus = error as { statusCode?: number; message?: string }
    const statusCode =
      errorWithStatus.statusCode && errorWithStatus.statusCode >= 400 && errorWithStatus.statusCode < 500
        ? errorWithStatus.statusCode
        : 500
    const message = statusCode === 500 ? 'Request failed.' : errorWithStatus.message || 'Request failed.'
    reply.code(statusCode).send({ success: false, message })
  })

  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store')
    }

    if (mutatingMethods.has(request.method)) {
      const origin = request.headers.origin
      if (!origin || Array.isArray(origin) || !allowedOrigins.has(origin)) {
        reply.code(403).send({ success: false, message: 'Origin rejected' })
      }
    }
  })

  app.get('/api/health', async (_request, reply) => {
    try {
      await pool.query('select 1')
      return { success: true, status: 'ok' }
    } catch {
      return reply.code(503).send({ success: false, status: 'unavailable' })
    }
  })

  // Unauthenticated, non-sensitive values the sign-in page needs.
  app.get('/api/public-config', async () => {
    const settings = await platformConfig()
    return {
      success: true,
      productName: settings.values['platform.product_name'] ?? 'Skeleton Platform',
      tenantRootDomain: config.tenantRootDomain,
    }
  })

  await registerAdminRoutes(app, {
    pool,
    notifier,
    platformOrigin: config.publicOrigin,
    tenantRootDomain: config.tenantRootDomain,
    requireAuth: (request, reply, roles) => requireAuth(request, reply, pool, roles),
    requireCsrf,
    requireRecentMfa,
    platformConfig,
  })

  app.get('/favicon.ico', async (_request, reply) => {
    return reply.code(204).send()
  })

  app.get('/api/auth/session', async (request, reply) => {
    try {
      const auth = await requireAuth(request, reply, pool, anyPlatformRole)
      if (!auth) return reply
      const csrfToken = createOpaqueToken()
      await pool.query('update platform.platform_session set csrf_hash = $1 where id = $2', [
        hashSecret(csrfToken),
        auth.sessionId,
      ])
      return { success: true, user: auth.user, csrfToken, mfaRecent: isMfaRecent(auth.mfaVerifiedAt) }
    } catch {
      return sendUnauthorized(reply)
    }
  })

  app.post('/api/auth/mfa/registration/options', async (request, reply) => {
    const auth = await requireAuth(request, reply, pool, anyPlatformRole)
    if (!auth) return reply
    if (!requireCsrf(request, reply, auth)) return reply
    const result = await generateRegistrationChallenge(pool, auth.user.id, auth.user.username, auth.sessionId)
    return { success: true, ...result }
  })

  const registrationVerifySchema = z.object({
    challengeId: z.string().uuid(),
    response: z.record(z.string(), z.unknown()),
  })
  app.post('/api/auth/mfa/registration/verify', async (request, reply) => {
    const auth = await requireAuth(request, reply, pool, anyPlatformRole)
    if (!auth) return reply
    if (!requireCsrf(request, reply, auth)) return reply
    const body = registrationVerifySchema.parse(request.body)
    const result = await verifyRegistrationAssertion(
      pool,
      auth.user.id,
      auth.sessionId,
      body.challengeId,
      body.response as any,
    )
    if (!result.verified) {
      return reply.code(400).send({ success: false, message: result.error || 'Registration failed.' })
    }
    return { success: true, message: 'WebAuthn credential registered and MFA verified.' }
  })

  app.post('/api/auth/mfa/assertion/options', async (request, reply) => {
    const auth = await requireAuth(request, reply, pool, anyPlatformRole)
    if (!auth) return reply
    if (!requireCsrf(request, reply, auth)) return reply
    try {
      const result = await generateAuthenticationChallenge(pool, auth.user.id, auth.sessionId, 'step_up')
      return { success: true, ...result }
    } catch (error) {
      return reply.code(400).send({ success: false, message: (error as Error).message })
    }
  })

  const assertionVerifySchema = z.object({
    challengeId: z.string().uuid(),
    response: z.record(z.string(), z.unknown()),
  })
  app.post('/api/auth/mfa/assertion/verify', async (request, reply) => {
    const auth = await requireAuth(request, reply, pool, anyPlatformRole)
    if (!auth) return reply
    if (!requireCsrf(request, reply, auth)) return reply
    const body = assertionVerifySchema.parse(request.body)
    const result = await verifyAuthenticationAssertion(
      pool,
      auth.user.id,
      auth.sessionId,
      body.challengeId,
      body.response as any,
    )
    if (!result.verified) {
      return reply.code(400).send({ success: false, message: result.error || 'Authentication assertion failed.' })
    }
    return { success: true, message: 'WebAuthn step-up verified.' }
  })

  const platformUserParamsSchema = z.object({ userId: z.string().uuid() })
  app.post('/api/platform/users/:userId/disable', async (request, reply) => {
    const auth = await requireAuth(request, reply, pool, ownerRoles)
    if (!auth) return reply
    if (!requireCsrf(request, reply, auth)) return reply
    if (!requireRecentMfa(reply, auth)) return reply
    const { userId } = platformUserParamsSchema.parse(request.params)
    try {
      await disablePlatformUser(pool, userId, auth.user.id)
      return { success: true, message: 'User account disabled and all sessions revoked.' }
    } catch (error) {
      return reply.code(409).send({ success: false, message: (error as Error).message })
    }
  })

  app.post('/api/auth/login', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async (request, reply) => {
    try {
      const body = loginSchema.parse(request.body)
      const verified = await verifyTurnstile(body.turnstileToken, clientIp(request), request)
      if (!verified) return sendForbidden(reply, 'Human verification failed')

      if (!(await loginThrottle.allowed(`platform:${body.username}`))) {
        await audit(pool, null, 'auth', 'login', 'throttled')
        return reply.code(429).send({ success: false, message: 'Too many failed attempts for this account. Try again later.' })
      }

      const user = await verifyLoginCredentials(pool, body.username, body.password)
      if (!user) {
        await loginThrottle.failure(`platform:${body.username}`)
        await audit(pool, null, 'auth', 'login', 'failed')
        return sendUnauthorized(reply, 'Credential mismatch. Please check your username and password.')
      }

      const role = normalizeRole(user.role)
      if (!role) {
        await loginThrottle.failure(`platform:${body.username}`)
        await audit(pool, user.id, 'auth', 'login', 'invalid_role')
        request.log.error({ userId: user.id }, 'platform_user has a role value outside the allowed set; denying login')
        return reply.code(403).send({ success: false, message: 'Account role is not configured correctly. Contact an administrator.' })
      }
      await loginThrottle.success(`platform:${body.username}`)

      await pool.query('delete from platform.platform_session where expires_at <= now()')
      const sessionToken = createOpaqueToken()
      const csrfToken = createOpaqueToken()
      await pool.query(
        `insert into platform.platform_session
         (user_id, token_hash, csrf_hash, expires_at)
         values ($1, $2, $3, now() + ($4::text)::interval)`,
        [
          user.id,
          hashSecret(sessionToken),
          hashSecret(csrfToken),
          `${Math.floor(config.sessionTtlMs / 1000)} seconds`,
        ],
      )
      await audit(pool, user.id, 'auth', 'login', 'success')

      reply.setCookie(cookieName, sessionToken, {
        path: '/',
        httpOnly: true,
        sameSite: 'strict',
        secure: config.cookieSecure,
        maxAge: Math.floor(config.sessionTtlMs / 1000),
      })

      const credentials = await getUserWebAuthnCredentials(pool, user.id)
      const hasMfa = credentials.length > 0

      return {
        success: true,
        user: { id: user.id, username: user.username, role },
        csrfToken,
        mfaRequired: adminRoles.has(role),
        mfaEnrolled: hasMfa,
        mfaRecent: false,
      }
    } catch {
      request.log.warn('login failed')
      return reply.code(400).send({ success: false, message: 'Unable to complete login.' })
    }
  })

  app.post('/api/auth/logout', async (request, reply) => {
    const auth = await requireAuth(request, reply, pool, anyPlatformRole)
    if (!auth) return reply
    if (!requireCsrf(request, reply, auth)) return reply

    await pool.query('delete from platform.platform_session where id = $1', [auth.sessionId])
    await audit(pool, auth.user.id, 'auth', 'logout', 'success')
    reply.clearCookie(cookieName, { path: '/' })
    return { success: true }
  })

  app.get('/api/tenants', async (request, reply) => {
    const auth = await requireAuth(request, reply, pool, adminRoles)
    if (!auth) return reply
    return { success: true, tenants: await listTenants(pool) }
  })

  app.post('/api/tenants', async (request, reply) => {
    const auth = await requireAuth(request, reply, pool, adminRoles)
    if (!auth) return reply
    if (!requireCsrf(request, reply, auth)) return reply
    if (!requireRecentMfa(reply, auth)) return reply
    const body = createTenantSchema.parse(request.body)
    const settings = await platformConfig()
    if (configStringList(settings, 'tenancy.reserved_subdomains').includes(body.subdomain)) {
      return reply.code(400).send({ success: false, message: 'This subdomain is reserved.' })
    }
    try {
      // Tier: explicit choice, else the plan's tenancy.default_connection_tier,
      // else the platform value, else the definition default.
      const connectionTier = body.connectionTier ?? ((await pool.query<{ tier: string }>(
        `select coalesce(
           (select v.value #>> '{}' from platform.config_value v
              join platform.plan_catalog p on p.plan_id = v.plan_id
             where v.scope_type = 'plan' and p.plan_code = $1 and v.config_key = 'tenancy.default_connection_tier'),
           (select value #>> '{}' from platform.config_value
             where scope_type = 'platform' and config_key = 'tenancy.default_connection_tier'),
           (select default_value #>> '{}' from platform.config_definition
             where config_key = 'tenancy.default_connection_tier'),
           'dedicated') as tier`,
        [body.planCode ?? null],
      )).rows[0]?.tier === 'pooled' ? 'pooled' : 'dedicated')
      const result = await createTenantProvisioningJob(
        pool,
        { ...body, connectionTier },
        auth.user.id,
        config.tenantRootDomain,
        randomUUID(),
      )
      const onboarding: Record<string, unknown> = {}
      // Plan and owner are applied after the registry row commits; a failure
      // here leaves a valid tenant that the operator can finish from its page.
      if (body.planCode) {
        try {
          await pool.query('select platform.assign_tenant_plan($1, $2, $3, $4::uuid)', [
            result.tenant.tenantId, body.planCode, 'active', auth.user.id,
          ])
          onboarding.planCode = body.planCode
        } catch (error) {
          onboarding.planError = (error as Error).message
        }
      }
      if (body.owner) {
        const ttl = Number((settings.values['invitations.ttl_hours'] as number | undefined) ?? 72)
        onboarding.ownerInvitation = await issueOwnerInvitation(
          { pool, notifier, tenantRootDomain: config.tenantRootDomain },
          result.tenant.tenantId,
          body.owner,
          auth.user.id,
          ttl,
        )
      }
      return reply.code(202).send({ success: true, ...result, ...onboarding })
    } catch (error) {
      if (error instanceof TenantProvisioningConflictError) {
        return reply.code(409).send({ success: false, message: error.message })
      }
      throw error
    }
  })

  app.get('/api/tenant-provisioning/:jobId', async (request, reply) => {
    const auth = await requireAuth(request, reply, pool, adminRoles)
    if (!auth) return reply
    const { jobId } = provisioningJobParamsSchema.parse(request.params)
    const job = await getProvisioningJob(pool, jobId)
    if (!job) return reply.code(404).send({ success: false, message: 'Provisioning job was not found.' })
    return { success: true, job }
  })

  app.post('/api/tenant-provisioning/:jobId/retry', async (request, reply) => {
    const auth = await requireAuth(request, reply, pool, adminRoles)
    if (!auth) return reply
    if (!requireCsrf(request, reply, auth)) return reply
    if (!requireRecentMfa(reply, auth)) return reply
    const { jobId } = provisioningJobParamsSchema.parse(request.params)
    const retried = await retryProvisioningJob(pool, jobId, auth.user.id)
    if (!retried) {
      return reply.code(409).send({ success: false, message: 'This provisioning job cannot be retried.' })
    }
    return reply.code(202).send({ success: true, jobId })
  })

  app.post('/api/tenants/:tenantKey/suspend', async (request, reply) => {
    const auth = await requireAuth(request, reply, pool, adminRoles)
    if (!auth) return reply
    if (!requireCsrf(request, reply, auth)) return reply
    if (!requireRecentMfa(reply, auth)) return reply
    const { tenantKey } = tenantKeyParamsSchema.parse(request.params)
    const suspended = await suspendTenant(pool, tenantKey, auth.user.id)
    if (!suspended) {
      return reply.code(409).send({ success: false, message: 'Only an active tenant can be suspended.' })
    }
    return { success: true, tenantId: tenantKey, status: 'suspended' }
  })

  app.post('/api/tenants/:tenantKey/resume', async (request, reply) => {
    const auth = await requireAuth(request, reply, pool, adminRoles)
    if (!auth) return reply
    if (!requireCsrf(request, reply, auth)) return reply
    if (!requireRecentMfa(reply, auth)) return reply
    const { tenantKey } = tenantKeyParamsSchema.parse(request.params)
    const resumed = await resumeTenant(pool, tenantKey, auth.user.id)
    if (!resumed) {
      return reply.code(409).send({ success: false, message: 'Only a suspended tenant can be resumed.' })
    }
    return { success: true, tenantId: tenantKey, status: 'active' }
  })

  app.post('/api/tenants/:tenantKey/deprovision', async (request, reply) => {
    const auth = await requireAuth(request, reply, pool, ownerRoles)
    if (!auth) return reply
    if (!requireCsrf(request, reply, auth)) return reply
    if (!requireRecentMfa(reply, auth)) return reply
    const { tenantKey } = tenantKeyParamsSchema.parse(request.params)
    try {
      const result = await createTenantDeprovisioningJob(pool, tenantKey, auth.user.id, randomUUID())
      return reply.code(202).send({ success: true, ...result })
    } catch (error) {
      if (error instanceof TenantStateConflictError) {
        return reply.code(409).send({ success: false, message: error.message })
      }
      if (error instanceof TenantProvisioningConflictError) {
        return reply.code(409).send({ success: false, message: error.message })
      }
      throw error
    }
  })

  app.get('/api/cloudflare/subdomains', async (request, reply) => {
    const auth = await requireAuth(request, reply, pool, anyPlatformRole)
    if (!auth) return reply

    const cf = requireCloudflare()
    const records = []
    for await (const record of cf.dns.records.list({ zone_id: config.cloudflareZoneId, per_page: 100 })) {
      records.push({ ...record, managed: isManagedSubdomainRecord(record) })
    }
    return {
      success: true,
      zone: { id: config.cloudflareZoneId, name: config.cloudflareZoneName, status: 'active' },
      records,
    }
  })

  app.post('/api/cloudflare/subdomains', async (request, reply) => {
    const auth = await requireAuth(request, reply, pool, ownerRoles)
    if (!auth) return reply
    if (!requireCsrf(request, reply, auth)) return reply
    if (!requireRecentMfa(reply, auth)) return reply

    const body = dnsCreateSchema.parse(request.body)
    const hostname = zoneHostname(body.label)
    if (isProtectedHostname(hostname)) return sendForbidden(reply, 'Protected platform hostname cannot be changed here.')
    const tunnelTarget = platformTunnelTarget()
    if (!tunnelTarget) {
      return reply.code(503).send({ success: false, message: 'Managed subdomain routing is not configured.' })
    }

    const action = `create:${hostname}`
    await audit(pool, auth.user.id, 'cloudflare_dns', action, 'attempted')
    const cf = requireCloudflare()
    let record
    try {
      for await (const existing of cf.dns.records.list({
        zone_id: config.cloudflareZoneId,
        name: { exact: hostname },
        per_page: 1,
      })) {
        await audit(pool, auth.user.id, 'cloudflare_dns', action, 'failed')
        return reply.code(409).send({
          success: false,
          message: `${existing.name} already has a DNS record.`,
        })
      }

      const createParams: CloudflareDnsRecordCreateParams = {
        zone_id: config.cloudflareZoneId,
        name: hostname,
        type: 'CNAME',
        content: tunnelTarget,
        proxied: true,
        ttl: 1,
      }
      record = await cf.dns.records.create(createParams)
    } catch (error) {
      await auditFailure(pool, request, auth.user.id, action, error)
      throw error
    }
    await audit(pool, auth.user.id, 'cloudflare_dns', action, 'success')
    return { success: true, record, routingStatus: 'dns_reserved' }
  })

  app.delete('/api/cloudflare/subdomains', async (request, reply) => {
    const auth = await requireAuth(request, reply, pool, ownerRoles)
    if (!auth) return reply
    if (!requireCsrf(request, reply, auth)) return reply
    if (!requireRecentMfa(reply, auth)) return reply

    const query = dnsDeleteSchema.parse(request.query)
    const cf = requireCloudflare()
    const record = await cf.dns.records.get(query.id, { zone_id: config.cloudflareZoneId })
    if (isProtectedHostname(record.name)) return sendForbidden(reply, 'Protected platform hostname cannot be deleted.')
    if (!isManagedSubdomainRecord(record)) {
      return sendForbidden(reply, 'Only subdomains managed by this platform tunnel can be deleted here.')
    }

    const action = `delete:${record.name}`
    await audit(pool, auth.user.id, 'cloudflare_dns', action, 'attempted')
    try {
      await cf.dns.records.delete(query.id, { zone_id: config.cloudflareZoneId })
    } catch (error) {
      await auditFailure(pool, request, auth.user.id, action, error)
      throw error
    }
    await audit(pool, auth.user.id, 'cloudflare_dns', action, 'success')
    return { success: true }
  })

  // Both endpoints disclose host infrastructure -- listening ports, bind
  // addresses, process owners, and capacity -- to a browser. That is the point
  // of the operations console, but it is exactly the inventory an attacker
  // wants after stealing an admin session, so they carry the same step-up
  // requirement as a control-plane mutation rather than resting on the session
  // cookie alone.
  app.get('/api/system/hardware', async (request, reply) => {
    const auth = await requireAuth(request, reply, pool, adminRoles)
    if (!auth) return reply
    if (!requireRecentMfa(reply, auth)) return reply
    return hardwareSnapshot()
  })

  app.get('/api/system/services', async (request, reply) => {
    const auth = await requireAuth(request, reply, pool, adminRoles)
    if (!auth) return reply
    if (!requireRecentMfa(reply, auth)) return reply
    return servicesSnapshot()
  })

  app.get('/api/audit/logs', async (request, reply) => {
    const auth = await requireAuth(request, reply, pool, adminRoles)
    if (!auth) return reply
    const result = await pool.query(
      `select
         a.id,
         a.timestamp,
         a.user_id,
         u.username,
         a.feature,
         a.action,
         upper(a.status) as status
       from platform.platform_audit a
       left join platform.platform_user u on u.id = a.user_id
       order by a.timestamp desc
       limit 100`,
    )
    return { success: true, logs: result.rows }
  })

  if (config.servePlatformStatic) {
    await app.register(staticFiles, {
      root: config.platformStaticRoot,
      prefix: '/',
      decorateReply: true,
      wildcard: true,
      setHeaders: (response, filePathName) => {
        response.header('X-Content-Type-Options', 'nosniff')
        response.header('Referrer-Policy', 'no-referrer')
        response.header('X-Frame-Options', 'DENY')
        response.header('Cross-Origin-Opener-Policy', 'same-origin')
        response.header('Cross-Origin-Resource-Policy', 'same-origin')
        response.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()')
        response.header('Content-Security-Policy', platformCsp)
        if (filePathName.endsWith('.html')) {
          response.header('Cache-Control', 'no-store')
        } else {
          response.header('Cache-Control', 'public, max-age=31536000, immutable')
        }
      },
    })

    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ success: false, message: 'Not found' })
      }
      const pathname = request.url.split('?', 1)[0] || '/'
      if (pathname.startsWith('/assets/') || path.posix.extname(pathname)) {
        return reply.code(404).send({ success: false, message: 'Static asset not found' })
      }
      return reply.sendFile('index.html')
    })
  }

  app.addHook('onClose', async () => {
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
