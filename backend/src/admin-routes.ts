import argon2 from 'argon2'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Pool } from 'pg'
import { z } from 'zod'
import {
  IntegrationService,
  IntegrationUnavailableError,
  IntegrationValidationError,
  SecretBox,
  ARGON2ID_OPTIONS,
  configInteger,
  createInvitationToken,
  invitationLink,
  type NotificationSender,
  parseInvitationToken,
  type ResolvedConfig,
} from '@skeleton/server-kit'
import { tenantKeyParamsSchema } from './tenant-provisioning.js'

// Admin-panel control surface for foundation features. Every mutation:
//   * requires an authenticated operator with the stated role,
//   * requires the session CSRF token and a recent WebAuthn step-up,
//   * goes through a SECURITY DEFINER function that enforces invariants and
//     writes platform_audit in the same transaction (migrations 026, 027).

type PlatformRole = 'platform_owner' | 'platform_admin' | 'platform_viewer'
type Auth = { sessionId: string; user: { id: string; username: string; role: PlatformRole }; mfaVerifiedAt: Date | null }

export interface AdminRouteDeps {
  pool: Pool
  notifier: NotificationSender
  platformOrigin: string
  tenantRootDomain: string
  requireAuth(request: FastifyRequest, reply: FastifyReply, roles: Set<PlatformRole>): Promise<Auth | null>
  requireCsrf(request: FastifyRequest, reply: FastifyReply, auth: Auth): boolean
  requireRecentMfa(reply: FastifyReply, auth: Auth): boolean
  platformConfig(): Promise<Pick<ResolvedConfig, 'values'>>
}

const ownerRoles = new Set<PlatformRole>(['platform_owner'])
const adminRoles = new Set<PlatformRole>(['platform_owner', 'platform_admin'])
const anyRole = new Set<PlatformRole>(['platform_owner', 'platform_admin', 'platform_viewer'])

const colorPattern = /^#[0-9A-Fa-f]{6}$/
const planCodePattern = /^[a-z][a-z0-9_]{1,62}$/
const configKeyPattern = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/

const tenantMigrationsDirectory = path.resolve(
  fileURLToPath(new URL('../..', import.meta.url)),
  'database/migrations/tenant/versions',
)

export async function latestTenantSchemaVersion(directory = tenantMigrationsDirectory): Promise<number> {
  const versions = (await readdir(directory))
    .map((name) => /^(\d{3})_[a-z0-9_]+\.sql$/.exec(name)?.[1])
    .filter((value): value is string => Boolean(value))
    .map(Number)
  return versions.length ? Math.max(...versions) : 0
}

const profileSchema = z
  .object({
    displayName: z.string().trim().min(2).max(160).optional(),
    legalName: z.string().trim().min(2).max(240).optional(),
    locale: z.string().trim().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/).optional(),
    logoUrl: z.union([z.url({ protocol: /^https$/ }).max(2048), z.literal('')]).optional(),
    primaryColor: z.string().regex(colorPattern).optional(),
    secondaryColor: z.string().regex(colorPattern).optional(),
    loginMessage: z.string().trim().max(300).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update.')

const ownerInvitationSchema = z.object({
  email: z.email().max(320),
  displayName: z.string().trim().min(1).max(255),
})

const planSchema = z.object({
  planCode: z.string().trim().regex(planCodePattern),
  displayName: z.string().trim().min(1).max(120),
  audience: z.enum(['b2b', 'b2c', 'both']).default('b2b'),
  isActive: z.boolean().default(true),
})

const assignPlanSchema = z.object({
  planCode: z.string().trim().regex(planCodePattern),
  status: z.enum(['trialing', 'active', 'past_due', 'paused']).default('active'),
})

const configScopeSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('platform'), ref: z.null().optional() }),
  z.object({ scope: z.literal('plan'), ref: z.string().regex(planCodePattern) }),
  z.object({ scope: z.literal('tenant'), ref: tenantKeyParamsSchema.shape.tenantKey }),
])

const configWriteSchema = z.intersection(
  configScopeSchema,
  z.object({ key: z.string().regex(configKeyPattern).max(96), value: z.unknown() }),
)

const operatorInviteSchema = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/),
  displayName: z.string().trim().min(1).max(255),
  email: z.union([z.email().max(320), z.literal('')]).optional(),
  role: z.enum(['platform_owner', 'platform_admin', 'platform_viewer']),
})

const operatorParams = z.object({ userId: z.uuid() })
const operatorRoleSchema = z.object({ role: z.enum(['platform_owner', 'platform_admin', 'platform_viewer']) })
const acceptOperatorSchema = z.object({ token: z.string().min(10).max(200), password: z.string().min(1).max(512) })

const auditQuerySchema = z.object({
  feature: z.string().trim().max(100).optional(),
  action: z.string().trim().max(100).optional(),
  status: z.string().trim().max(50).optional(),
  tenantKey: z.string().trim().max(64).optional(),
  userId: z.uuid().optional(),
  before: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
})

async function tenantIdFor(pool: Pool, tenantKey: string): Promise<string | null> {
  const result = await pool.query<{ tenant_id: string }>(
    `select tenant_id::text from platform.tenant_registry where tenant_key = $1 and lifecycle_status <> 'deleted'`,
    [tenantKey],
  )
  return result.rows[0]?.tenant_id ?? null
}

export async function registerAdminRoutes(app: FastifyInstance, deps: AdminRouteDeps): Promise<void> {
  const { pool } = deps

  const guard = async (
    request: FastifyRequest,
    reply: FastifyReply,
    roles: Set<PlatformRole>,
    mutation: boolean,
  ): Promise<Auth | null> => {
    const auth = await deps.requireAuth(request, reply, roles)
    if (!auth) return null
    if (mutation && (!deps.requireCsrf(request, reply, auth) || !deps.requireRecentMfa(reply, auth))) return null
    return auth
  }

  const ttlHours = async () => configInteger(await deps.platformConfig() as ResolvedConfig, 'invitations.ttl_hours', 72)

  // --- Tenants --------------------------------------------------------------

  app.get('/api/tenants/:tenantKey', async (request, reply) => {
    if (!(await guard(request, reply, adminRoles, false))) return reply
    const { tenantKey } = tenantKeyParamsSchema.parse(request.params)
    const tenant = (
      await pool.query(
        `select t.tenant_id::text as "id", t.tenant_key as "tenantId", t.display_name as "displayName",
                t.legal_name as "legalName", t.lifecycle_status as status, t.region,
                t.default_locale as locale, t.schema_version as "schemaVersion",
                t.identity_scheme as "identityScheme", t.last_error_code as "lastErrorCode",
                t.last_error_at as "lastErrorAt", t.created_at as "createdAt", t.activated_at as "activatedAt",
                t.connection_tier as "connectionTier",
                t.storage_integration_id::text as "storageIntegrationId", t.data_integration_id::text as "dataIntegrationId",
                b.logo_url as "logoUrl", b.primary_color as "primaryColor", b.secondary_color as "secondaryColor",
                b.login_message as "loginMessage"
           from platform.tenant_registry t
           left join platform.tenant_branding b on b.tenant_id = t.tenant_id
          where t.tenant_key = $1 and t.lifecycle_status <> 'deleted'`,
        [tenantKey],
      )
    ).rows[0] as ({ id: string } & Record<string, unknown>) | undefined
    if (!tenant) return reply.code(404).send({ success: false, message: 'Tenant not found.' })
    const [domains, subscription, jobs, invitations, config, latest] = await Promise.all([
      pool.query(
        `select hostname, subdomain, is_primary as "isPrimary", status, created_at as "createdAt"
           from platform.tenant_domain where tenant_id = $1 order by is_primary desc, created_at`,
        [tenant.id],
      ),
      pool.query(
        `select p.plan_code as "planCode", p.display_name as "planName", s.status,
                s.period_start as "periodStart", s.period_end as "periodEnd"
           from platform.tenant_subscription s join platform.plan_catalog p on p.plan_id = s.plan_id
          where s.tenant_id = $1 order by s.created_at desc limit 1`,
        [tenant.id],
      ),
      pool.query(
        `select job_id::text as "jobId", job_type as "jobType", status, current_step as "currentStep",
                attempt_count as "attemptCount", safe_error_message as "errorMessage",
                created_at as "createdAt", completed_at as "completedAt"
           from platform.tenant_provisioning_job where tenant_id = $1 order by created_at desc limit 20`,
        [tenant.id],
      ),
      pool.query(
        `select invitation_id::text as "invitationId", email_normalized as email, display_name as "displayName",
                created_at as "createdAt", expires_at as "expiresAt", consumed_at as "acceptedAt", revoked_at as "revokedAt"
           from platform.tenant_owner_invitation where tenant_id = $1 order by created_at desc limit 10`,
        [tenant.id],
      ),
      pool.query<{ config: ResolvedConfig }>('select platform.resolve_tenant_config($1::uuid) as config', [tenant.id]),
      latestTenantSchemaVersion(),
    ])
    const { id: _internalId, ...publicTenant } = tenant
    return {
      success: true,
      tenant: { ...publicTenant, latestSchemaVersion: latest },
      domains: domains.rows,
      subscription: subscription.rows[0] ?? null,
      jobs: jobs.rows,
      ownerInvitations: invitations.rows,
      effectiveConfig: config.rows[0]?.config ?? null,
    }
  })

  app.patch('/api/tenants/:tenantKey', async (request, reply) => {
    const auth = await guard(request, reply, adminRoles, true)
    if (!auth) return reply
    const { tenantKey } = tenantKeyParamsSchema.parse(request.params)
    const body = profileSchema.parse(request.body)
    const result = await pool.query<{ updated: boolean }>(
      `select platform.update_tenant_profile($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9) as updated`,
      [
        tenantKey,
        auth.user.id,
        body.displayName ?? null,
        body.legalName ?? null,
        body.locale ?? null,
        body.logoUrl ?? null,
        body.primaryColor ?? null,
        body.secondaryColor ?? null,
        body.loginMessage ?? null,
      ],
    )
    if (!result.rows[0]?.updated) return reply.code(404).send({ success: false, message: 'Tenant not found or not editable.' })
    return { success: true }
  })

  app.post('/api/tenants/:tenantKey/owner-invitations', async (request, reply) => {
    const auth = await guard(request, reply, adminRoles, true)
    if (!auth) return reply
    const { tenantKey } = tenantKeyParamsSchema.parse(request.params)
    const body = ownerInvitationSchema.parse(request.body)
    const issued = await issueOwnerInvitation(deps, tenantKey, body, auth.user.id, await ttlHours())
    return reply.code(201).send({ success: true, invitation: issued })
  })

  app.delete('/api/tenants/:tenantKey/owner-invitations/:invitationId', async (request, reply) => {
    const auth = await guard(request, reply, adminRoles, true)
    if (!auth) return reply
    const { invitationId } = z.object({ invitationId: z.uuid() }).parse(request.params)
    const result = await pool.query<{ revoked: boolean }>(
      'select platform.revoke_tenant_owner_invitation($1::uuid, $2::uuid) as revoked',
      [invitationId, auth.user.id],
    )
    if (!result.rows[0]?.revoked) return reply.code(404).send({ success: false, message: 'No pending invitation found.' })
    return { success: true }
  })

  app.put('/api/tenants/:tenantKey/plan', async (request, reply) => {
    const auth = await guard(request, reply, adminRoles, true)
    if (!auth) return reply
    const { tenantKey } = tenantKeyParamsSchema.parse(request.params)
    const body = assignPlanSchema.parse(request.body)
    const result = await pool.query<{ assigned: boolean }>(
      'select platform.assign_tenant_plan($1, $2, $3, $4::uuid) as assigned',
      [tenantKey, body.planCode, body.status, auth.user.id],
    )
    if (!result.rows[0]?.assigned) return reply.code(404).send({ success: false, message: 'Tenant not found.' })
    return { success: true }
  })

  // --- Fleet ------------------------------------------------------------------

  app.get('/api/fleet/status', async (request, reply) => {
    if (!(await guard(request, reply, adminRoles, false))) return reply
    const latest = await latestTenantSchemaVersion()
    const tenants = await pool.query(
      `select t.tenant_key as "tenantId", t.display_name as "displayName", t.lifecycle_status as status,
              t.schema_version as "schemaVersion", t.last_error_code as "lastErrorCode", t.last_error_at as "lastErrorAt",
              p.plan_code as "planCode"
         from platform.tenant_registry t
         left join lateral (
           select pc.plan_code from platform.tenant_subscription s
             join platform.plan_catalog pc on pc.plan_id = s.plan_id
            where s.tenant_id = t.tenant_id and s.status in ('trialing', 'active', 'past_due', 'paused')
            order by s.created_at desc limit 1
         ) p on true
        where t.lifecycle_status <> 'deleted'
        order by t.schema_version, t.display_name`,
    )
    const rows = tenants.rows as Array<{ status: string; schemaVersion: number }>
    const jobs = await pool.query(
      `select status, job_type as "jobType", count(*)::int as count
         from platform.tenant_provisioning_job
        where created_at > now() - interval '30 days'
        group by status, job_type order by job_type, status`,
    )
    return {
      success: true,
      latestSchemaVersion: latest,
      summary: {
        total: rows.length,
        current: rows.filter((row) => row.schemaVersion === latest).length,
        behind: rows.filter((row) => row.status === 'active' && row.schemaVersion < latest).length,
        failed: rows.filter((row) => /failed/.test(row.status)).length,
      },
      tenants: rows,
      jobs30d: jobs.rows,
    }
  })

  // --- Plans ------------------------------------------------------------------

  app.get('/api/plans', async (request, reply) => {
    if (!(await guard(request, reply, anyRole, false))) return reply
    const plans = await pool.query(
      `select p.plan_code as "planCode", p.display_name as "displayName", p.audience, p.is_active as "isActive",
              p.version, p.updated_at as "updatedAt", p.description, p.price_monthly::float8 as "priceMonthly",
              p.highlights, p.sort_order as "sortOrder",
              (select count(*)::int from platform.tenant_subscription s
                where s.plan_id = p.plan_id and s.status in ('trialing', 'active', 'past_due', 'paused')) as "tenantCount",
              coalesce((select jsonb_object_agg(v.config_key, v.value) from platform.config_value v
                         where v.scope_type = 'plan' and v.plan_id = p.plan_id), '{}'::jsonb) as overrides
         from platform.plan_catalog p order by p.is_active desc, p.sort_order, p.plan_code`,
    )
    return { success: true, plans: plans.rows }
  })

  app.post('/api/plans', async (request, reply) => {
    const auth = await guard(request, reply, ownerRoles, true)
    if (!auth) return reply
    const body = planSchema.parse(request.body)
    await pool.query('select platform.upsert_plan($1, $2, $3, $4, $5::uuid)', [
      body.planCode,
      body.displayName,
      body.audience,
      body.isActive,
      auth.user.id,
    ])
    return reply.code(201).send({ success: true, planCode: body.planCode })
  })

  // --- Configuration registry -------------------------------------------------

  app.get('/api/config/definitions', async (request, reply) => {
    if (!(await guard(request, reply, anyRole, false))) return reply
    const definitions = await pool.query(
      `select config_key as key, kind, value_type as "valueType", label, description, category,
              module_code as "moduleCode", default_value as "defaultValue", min_value::float8 as min,
              max_value::float8 as max, max_length as "maxLength", allowed_values as allowed, scopes,
              tenant_editable as "tenantEditable", is_public as "isPublic"
         from platform.config_definition order by category, config_key`,
    )
    const platformValues = await pool.query(
      `select config_key as key, value, updated_at as "updatedAt" from platform.config_value where scope_type = 'platform'`,
    )
    return { success: true, definitions: definitions.rows, platformValues: platformValues.rows }
  })

  app.get('/api/config/values', async (request, reply) => {
    if (!(await guard(request, reply, anyRole, false))) return reply
    const scope = configScopeSchema.parse(request.query)
    const result = await pool.query(
      `select v.config_key as key, v.value, v.updated_at as "updatedAt", u.username as "updatedBy"
         from platform.config_value v
         left join platform.platform_user u on u.id = v.updated_by
         left join platform.plan_catalog p on p.plan_id = v.plan_id
         left join platform.tenant_registry t on t.tenant_id = v.tenant_id
        where v.scope_type = $1
          and ($1 = 'platform'
               or ($1 = 'plan' and p.plan_code = $2)
               or ($1 = 'tenant' and t.tenant_key = $2))
        order by v.config_key`,
      [scope.scope, scope.ref ?? null],
    )
    return { success: true, values: result.rows }
  })

  app.put('/api/config/values', async (request, reply) => {
    const auth = await guard(request, reply, adminRoles, true)
    if (!auth) return reply
    const body = configWriteSchema.parse(request.body)
    // Platform-wide values affect every tenant; reserve them for owners.
    if (body.scope === 'platform' && auth.user.role !== 'platform_owner') {
      return reply.code(403).send({ success: false, message: 'Only platform owners can change platform-wide values.' })
    }
    if (body.value === undefined || body.value === null) {
      return reply.code(400).send({ success: false, message: 'Provide a value, or use DELETE to clear an override.' })
    }
    await pool.query('select platform.set_config_value($1, $2, $3, $4::jsonb, $5::uuid)', [
      body.scope,
      body.ref ?? null,
      body.key,
      JSON.stringify(body.value),
      auth.user.id,
    ])
    return { success: true }
  })

  app.delete('/api/config/values', async (request, reply) => {
    const auth = await guard(request, reply, adminRoles, true)
    if (!auth) return reply
    const body = z.intersection(configScopeSchema, z.object({ key: z.string().regex(configKeyPattern).max(96) })).parse(request.body)
    if (body.scope === 'platform' && auth.user.role !== 'platform_owner') {
      return reply.code(403).send({ success: false, message: 'Only platform owners can change platform-wide values.' })
    }
    await pool.query('select platform.set_config_value($1, $2, $3, null, $4::uuid)', [
      body.scope,
      body.ref ?? null,
      body.key,
      auth.user.id,
    ])
    return { success: true }
  })

  // --- Platform operators -----------------------------------------------------

  app.get('/api/platform/users', async (request, reply) => {
    if (!(await guard(request, reply, ownerRoles, false))) return reply
    const users = await pool.query(
      `select u.id::text as id, u.username, u.display_name as "displayName", u.email_normalized as email,
              u.role, u.is_active as "isActive", u.created_at as "createdAt",
              u.last_authenticated_at as "lastAuthenticatedAt",
              (u.password_hash is not null) as "hasPassword",
              (select count(*)::int from platform.platform_webauthn_credential c where c.user_id = u.id and c.is_enabled) as "mfaCredentials",
              (select count(*)::int from platform.platform_session s where s.user_id = u.id and s.expires_at > now()) as "activeSessions",
              (select max(i.expires_at) from platform.platform_operator_invitation i
                where i.user_id = u.id and i.consumed_at is null and i.revoked_at is null and i.expires_at > now()) as "pendingInvitationExpiresAt"
         from platform.platform_user u order by u.is_active desc, u.role, u.username`,
    )
    return { success: true, users: users.rows }
  })

  app.post('/api/platform/users', async (request, reply) => {
    const auth = await guard(request, reply, ownerRoles, true)
    if (!auth) return reply
    const body = operatorInviteSchema.parse(request.body)
    const { token, tokenHash } = createInvitationToken('operator')
    const hours = await ttlHours()
    let userId: string
    try {
      userId = (
        await pool.query<{ id: string }>(
          'select platform.invite_platform_operator($1, $2, $3, $4, $5, $6, $7::uuid)::text as id',
          [body.username, body.displayName, body.email || '', body.role, tokenHash, hours, auth.user.id],
        )
      ).rows[0]!.id
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        return reply.code(409).send({ success: false, message: 'That username is already taken.' })
      }
      throw error
    }
    const link = invitationLink(deps.platformOrigin, token)
    const delivery = body.email
      ? await deps.notifier.send({
          type: 'platform_operator_invitation',
          to: body.email,
          subject: 'Platform operator invitation',
          link,
          context: { username: body.username, role: body.role },
        })
      : { delivered: false }
    return reply.code(201).send({ success: true, userId, invitation: { link, expiresInHours: hours, delivered: delivery.delivered } })
  })

  app.post('/api/platform/users/:userId/invitation', async (request, reply) => {
    const auth = await guard(request, reply, ownerRoles, true)
    if (!auth) return reply
    const { userId } = operatorParams.parse(request.params)
    const { token, tokenHash } = createInvitationToken('operator')
    const hours = await ttlHours()
    const result = await pool.query<{ issued: boolean }>(
      'select platform.reissue_platform_operator_invitation($1::uuid, $2, $3, $4::uuid) as issued',
      [userId, tokenHash, hours, auth.user.id],
    )
    if (!result.rows[0]?.issued) return reply.code(404).send({ success: false, message: 'Operator not found.' })
    return { success: true, invitation: { link: invitationLink(deps.platformOrigin, token), expiresInHours: hours, delivered: false } }
  })

  app.post('/api/platform/users/:userId/role', async (request, reply) => {
    const auth = await guard(request, reply, ownerRoles, true)
    if (!auth) return reply
    const { userId } = operatorParams.parse(request.params)
    const { role } = operatorRoleSchema.parse(request.body)
    const result = await pool.query<{ ok: boolean }>('select platform.set_platform_operator_role($1::uuid, $2, $3::uuid) as ok', [
      userId,
      role,
      auth.user.id,
    ])
    if (!result.rows[0]?.ok) return reply.code(404).send({ success: false, message: 'Operator not found.' })
    return { success: true }
  })

  for (const [suffix, active] of [['enable', true], ['deactivate', false]] as const) {
    app.post(`/api/platform/users/:userId/${suffix}`, async (request, reply) => {
      const auth = await guard(request, reply, ownerRoles, true)
      if (!auth) return reply
      const { userId } = operatorParams.parse(request.params)
      const result = await pool.query<{ ok: boolean }>(
        'select platform.set_platform_operator_active($1::uuid, $2, $3::uuid) as ok',
        [userId, active, auth.user.id],
      )
      if (!result.rows[0]?.ok) return reply.code(404).send({ success: false, message: 'Operator not found.' })
      return { success: true }
    })
  }

  for (const [suffix, resetMfa] of [['revoke-sessions', false], ['reset-mfa', true]] as const) {
    app.post(`/api/platform/users/:userId/${suffix}`, async (request, reply) => {
      const auth = await guard(request, reply, ownerRoles, true)
      if (!auth) return reply
      const { userId } = operatorParams.parse(request.params)
      const result = await pool.query<{ ok: boolean }>(
        'select platform.revoke_platform_operator_sessions($1::uuid, $2, $3::uuid) as ok',
        [userId, resetMfa, auth.user.id],
      )
      if (!result.rows[0]?.ok) return reply.code(404).send({ success: false, message: 'Operator not found.' })
      return { success: true }
    })
  }

  // Unauthenticated: an invited operator sets their password. The token is
  // single-use, 256-bit, stored hashed, and the route is rate limited.
  const acceptLimits = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }
  app.post('/api/auth/invitations/inspect', acceptLimits, async (request, reply) => {
    const parsed = parseInvitationToken(z.object({ token: z.string().max(200) }).parse(request.body).token)
    if (parsed?.kind !== 'operator') return reply.code(404).send({ success: false, message: 'This invitation link is invalid, already used, or expired.' })
    const row = (await pool.query('select * from platform.inspect_platform_operator_invitation($1)', [parsed.tokenHash])).rows[0]
    if (!row) return reply.code(404).send({ success: false, message: 'This invitation link is invalid, already used, or expired.' })
    return {
      success: true,
      invitation: { kind: 'operator', username: row.username, displayName: row.display_name, role: row.role, expiresAt: row.expires_at, passwordMinLength: 14 },
    }
  })

  app.post('/api/auth/invitations/accept', acceptLimits, async (request, reply) => {
    const body = acceptOperatorSchema.parse(request.body)
    const parsed = parseInvitationToken(body.token)
    if (parsed?.kind !== 'operator') return reply.code(404).send({ success: false, message: 'This invitation link is invalid, already used, or expired.' })
    // Operators guard the whole platform; their floor is stricter than tenants'.
    if (body.password.length < 14) return reply.code(400).send({ success: false, message: 'Password must be at least 14 characters.' })
    const hash = await argon2.hash(body.password, { type: argon2.argon2id, ...ARGON2ID_OPTIONS })
    const result = await pool.query<{ user_id: string | null }>(
      'select platform.accept_platform_operator_invitation($1, $2)::text as user_id',
      [parsed.tokenHash, hash],
    )
    if (!result.rows[0]?.user_id) return reply.code(404).send({ success: false, message: 'This invitation link is invalid, already used, or expired.' })
    return { success: true, message: 'Your password is set. Sign in and enrol a security key.' }
  })

  // --- Audit --------------------------------------------------------------------

  app.get('/api/audit/events', async (request, reply) => {
    if (!(await guard(request, reply, adminRoles, false))) return reply
    const query = auditQuerySchema.parse(request.query)
    const tenantId = query.tenantKey ? await tenantIdFor(pool, query.tenantKey) : null
    if (query.tenantKey && !tenantId) return { success: true, events: [], nextBefore: null }
    const result = await pool.query(
      `select a.id::text, a.timestamp, a.user_id::text as "userId", u.username, a.feature, a.action,
              upper(a.status) as status, t.tenant_key as "tenantKey", a.resource_type as "resourceType",
              a.resource_id as "resourceId", a.correlation_id::text as "correlationId"
         from platform.platform_audit a
         left join platform.platform_user u on u.id = a.user_id
         left join platform.tenant_registry t on t.tenant_id = a.tenant_id
        where ($1::text is null or a.feature = $1)
          and ($2::text is null or a.action ilike $2 || '%')
          and ($3::text is null or upper(a.status) = upper($3))
          and ($4::uuid is null or a.tenant_id = $4)
          and ($5::uuid is null or a.user_id = $5)
          and ($6::timestamptz is null or a.timestamp < $6)
        order by a.timestamp desc
        limit $7`,
      [
        query.feature ?? null,
        query.action ?? null,
        query.status ?? null,
        tenantId,
        query.userId ?? null,
        query.before ?? null,
        query.limit,
      ],
    )
    const events = result.rows as Array<{ timestamp: Date }>
    const last = events.length === query.limit ? events[events.length - 1] : undefined
    const features = await pool.query<{ feature: string }>('select distinct feature from platform.platform_audit order by feature')
    return {
      success: true,
      events,
      nextBefore: last ? new Date(last.timestamp).toISOString() : null,
      features: features.rows.map((row) => row.feature),
    }
  })
  // --- Bring-your-own integrations and tenant operations --------------------

  const integrations = new IntegrationService(pool, SecretBox.fromEnvironment())
  const integrationParams = z.object({ tenantKey: tenantKeyParamsSchema.shape.tenantKey, integrationId: z.uuid() })
  const integrationBody = z.object({
    provider: z.enum(['s3', 'postgresql']),
    displayName: z.string().trim().min(1).max(120),
    settings: z.record(z.string(), z.unknown()),
    secret: z.record(z.string(), z.unknown()).optional(),
  })
  const operator = (auth: Auth) => `operator:${auth.user.username}`
  const tenantFor = async (reply: FastifyReply, tenantKey: string) => {
    const tenantId = await tenantIdFor(pool, tenantKey)
    if (!tenantId) void reply.code(404).send({ success: false, message: 'Tenant not found.' })
    return tenantId
  }
  const integrationError = (reply: FastifyReply, error: unknown) => {
    if (error instanceof IntegrationUnavailableError) return reply.code(503).send({ success: false, message: error.message })
    if (error instanceof IntegrationValidationError) return reply.code(400).send({ success: false, message: error.message })
    throw error
  }

  app.get('/api/tenants/:tenantKey/integrations', async (request, reply) => {
    if (!(await guard(request, reply, adminRoles, false))) return reply
    const { tenantKey } = tenantKeyParamsSchema.parse(request.params)
    const tenantId = await tenantFor(reply, tenantKey)
    if (!tenantId) return reply
    return { success: true, available: integrations.available, integrations: await integrations.list(tenantId) }
  })

  app.post('/api/tenants/:tenantKey/integrations', async (request, reply) => {
    const auth = await guard(request, reply, adminRoles, true)
    if (!auth) return reply
    const { tenantKey } = tenantKeyParamsSchema.parse(request.params)
    const body = integrationBody.parse(request.body)
    const tenantId = await tenantFor(reply, tenantKey)
    if (!tenantId) return reply
    try {
      return reply.code(201).send({ success: true, integration: await integrations.save(tenantId, body, operator(auth)) })
    } catch (error) {
      return integrationError(reply, error)
    }
  })

  app.put('/api/tenants/:tenantKey/integrations/:integrationId', async (request, reply) => {
    const auth = await guard(request, reply, adminRoles, true)
    if (!auth) return reply
    const { tenantKey, integrationId } = integrationParams.parse(request.params)
    const body = integrationBody.parse(request.body)
    const tenantId = await tenantFor(reply, tenantKey)
    if (!tenantId) return reply
    try {
      return { success: true, integration: await integrations.save(tenantId, { ...body, integrationId }, operator(auth)) }
    } catch (error) {
      return integrationError(reply, error)
    }
  })

  // Testing makes outbound connections but changes nothing, so CSRF is
  // required and step-up is not.
  app.post('/api/tenants/:tenantKey/integrations/:integrationId/test', async (request, reply) => {
    const auth = await deps.requireAuth(request, reply, adminRoles)
    if (!auth || !deps.requireCsrf(request, reply, auth)) return reply
    const { tenantKey, integrationId } = integrationParams.parse(request.params)
    const tenantId = await tenantFor(reply, tenantKey)
    if (!tenantId) return reply
    try {
      return { success: true, report: await integrations.test(tenantId, integrationId, operator(auth)) }
    } catch (error) {
      return integrationError(reply, error)
    }
  })

  app.post('/api/tenants/:tenantKey/integrations/:integrationId/activate', async (request, reply) => {
    const auth = await guard(request, reply, adminRoles, true)
    if (!auth) return reply
    const { tenantKey, integrationId } = integrationParams.parse(request.params)
    const tenantId = await tenantFor(reply, tenantKey)
    if (!tenantId) return reply
    try {
      const kind = (await integrations.list(tenantId)).find((item) => item.integrationId === integrationId)?.kind
      if (kind === 'storage') {
        await integrations.activateStorage(tenantId, integrationId, operator(auth))
        return { success: true, message: 'New files are now written to this storage. Existing files stay readable where they are.' }
      }
      const jobId = await integrations.requestDatabaseMove(tenantKey, tenantId, integrationId, auth.user.id, operator(auth))
      return reply.code(202).send({ success: true, jobId, message: 'Data relocation started. The tenant is briefly in maintenance.' })
    } catch (error) {
      return integrationError(reply, error)
    }
  })

  app.post('/api/tenants/:tenantKey/integrations/:integrationId/retire', async (request, reply) => {
    const auth = await guard(request, reply, adminRoles, true)
    if (!auth) return reply
    const { tenantKey, integrationId } = integrationParams.parse(request.params)
    const tenantId = await tenantFor(reply, tenantKey)
    if (!tenantId) return reply
    if (!(await integrations.retire(tenantId, integrationId, operator(auth)))) {
      return reply.code(404).send({ success: false, message: 'Integration not found or already retired.' })
    }
    return { success: true }
  })

  app.post('/api/tenants/:tenantKey/storage/use-vds', async (request, reply) => {
    const auth = await guard(request, reply, adminRoles, true)
    if (!auth) return reply
    const { tenantKey } = tenantKeyParamsSchema.parse(request.params)
    const tenantId = await tenantFor(reply, tenantKey)
    if (!tenantId) return reply
    await integrations.activateStorage(tenantId, null, operator(auth))
    return { success: true, message: 'New files are written to the VDS again.' }
  })

  app.post('/api/tenants/:tenantKey/database/use-vds', async (request, reply) => {
    const auth = await guard(request, reply, adminRoles, true)
    if (!auth) return reply
    const { tenantKey } = tenantKeyParamsSchema.parse(request.params)
    const tenantId = await tenantFor(reply, tenantKey)
    if (!tenantId) return reply
    const jobId = await integrations.requestDatabaseMove(tenantKey, tenantId, null, auth.user.id, operator(auth))
    return reply.code(202).send({ success: true, jobId })
  })

  app.post('/api/tenants/:tenantKey/storage/relocate', async (request, reply) => {
    const auth = await guard(request, reply, adminRoles, true)
    if (!auth) return reply
    const { tenantKey } = tenantKeyParamsSchema.parse(request.params)
    const jobId = await integrations.enqueue(tenantKey, 'relocate_storage', {}, auth.user.id, operator(auth))
    return reply.code(202).send({ success: true, jobId })
  })

  app.post('/api/tenants/:tenantKey/migrate', async (request, reply) => {
    const auth = await guard(request, reply, adminRoles, true)
    if (!auth) return reply
    const { tenantKey } = tenantKeyParamsSchema.parse(request.params)
    const jobId = await integrations.enqueue(tenantKey, 'migrate', {}, auth.user.id, operator(auth))
    return reply.code(202).send({ success: true, jobId })
  })

  // Upgrades every tenant that is behind (or failed a previous upgrade) and
  // has no operation running.
  app.post('/api/fleet/migrate', async (request, reply) => {
    const auth = await guard(request, reply, adminRoles, true)
    if (!auth) return reply
    const latest = await latestTenantSchemaVersion()
    const candidates = await pool.query<{ tenant_key: string }>(
      `select t.tenant_key from platform.tenant_registry t
        where (t.lifecycle_status = 'migration_failed' or (t.lifecycle_status in ('active', 'suspended') and t.schema_version < $1))
          and not exists (select 1 from platform.tenant_provisioning_job j
                           where j.tenant_id = t.tenant_id and j.status in ('pending', 'running', 'retrying'))
        order by t.schema_version, t.created_at`,
      [latest],
    )
    const jobs: Array<{ tenantId: string; jobId?: string; error?: string }> = []
    for (const row of candidates.rows) {
      try {
        jobs.push({ tenantId: row.tenant_key, jobId: await integrations.enqueue(row.tenant_key, 'migrate', {}, auth.user.id, operator(auth)) })
      } catch (error) {
        jobs.push({ tenantId: row.tenant_key, error: (error as Error).message })
      }
    }
    return reply.code(202).send({ success: true, latestSchemaVersion: latest, queued: jobs.filter((job) => job.jobId).length, jobs })
  })

  // --- Plans: public presentation ---------------------------------------------

  app.patch('/api/plans/:planCode/presentation', async (request, reply) => {
    const auth = await guard(request, reply, ownerRoles, true)
    if (!auth) return reply
    const { planCode } = z.object({ planCode: z.string().regex(planCodePattern) }).parse(request.params)
    const body = z.object({
      description: z.string().trim().max(500).optional(),
      priceMonthly: z.number().min(0).max(1_000_000).nullable().optional(),
      highlights: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
      sortOrder: z.number().int().min(0).max(10_000).optional(),
    }).parse(request.body)
    const result = await pool.query<{ ok: boolean }>('select platform.update_plan_presentation($1, $2, $3, $4::jsonb, $5, $6::uuid) as ok', [
      planCode,
      body.description ?? null,
      body.priceMonthly ?? null,
      body.highlights ? JSON.stringify(body.highlights) : null,
      body.sortOrder ?? null,
      auth.user.id,
    ])
    if (!result.rows[0]?.ok) return reply.code(404).send({ success: false, message: 'Plan not found.' })
    return { success: true }
  })

  // --- Individual (B2C) users --------------------------------------------------

  const consumerParams = z.object({ userId: z.uuid() })
  const consumerAudit = (auth: Auth, action: string, userId: string) =>
    pool.query(
      `insert into platform.platform_audit (user_id, feature, action, status, resource_type, resource_id, policy_decision)
       values ($1, 'consumers', $2, 'SUCCESS', 'consumer_user', $3, 'allow')`,
      [auth.user.id, action, userId],
    )

  app.get('/api/consumers', async (request, reply) => {
    if (!(await guard(request, reply, adminRoles, false))) return reply
    const query = z.object({
      search: z.string().trim().max(100).optional(),
      status: z.enum(['pending', 'active', 'suspended', 'deleting']).optional(),
      plan: z.string().regex(planCodePattern).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(request.query)
    const result = await pool.query(
      `select user_id::text as "userId", username, display_name as "displayName", email, account_status as status,
              plan_code as "planCode", subscription_status as "subscriptionStatus", created_at as "createdAt",
              active_sessions as "activeSessions", total_count::int as total
         from consumer.admin_list_users($1, $2, $3, $4, $5)`,
      [query.search || null, query.status ?? null, query.plan ?? null, query.limit, query.offset],
    )
    const rows = result.rows as Array<{ total: number } & Record<string, unknown>>
    return { success: true, total: rows[0]?.total ?? 0, users: rows.map(({ total: _total, ...user }) => user) }
  })

  app.get('/api/consumers/stats', async (request, reply) => {
    if (!(await guard(request, reply, adminRoles, false))) return reply
    return { success: true, stats: (await pool.query('select consumer.admin_stats() as stats')).rows[0]?.stats }
  })

  app.get('/api/consumers/:userId', async (request, reply) => {
    if (!(await guard(request, reply, adminRoles, false))) return reply
    const { userId } = consumerParams.parse(request.params)
    const detail = (await pool.query('select consumer.admin_get_user($1) as detail', [userId])).rows[0]?.detail
    if (!detail) return reply.code(404).send({ success: false, message: 'User not found.' })
    return { success: true, ...detail }
  })

  for (const [suffix, status] of [['suspend', 'suspended'], ['reactivate', 'active']] as const) {
    app.post(`/api/consumers/:userId/${suffix}`, async (request, reply) => {
      const auth = await guard(request, reply, adminRoles, true)
      if (!auth) return reply
      const { userId } = consumerParams.parse(request.params)
      const ok = (await pool.query('select consumer.admin_set_user_status($1, $2) as ok', [userId, status])).rows[0]?.ok
      if (!ok) return reply.code(404).send({ success: false, message: 'User not found.' })
      await consumerAudit(auth, `consumer_${suffix}`, userId)
      return { success: true }
    })
  }

  app.post('/api/consumers/:userId/revoke-sessions', async (request, reply) => {
    const auth = await guard(request, reply, adminRoles, true)
    if (!auth) return reply
    const { userId } = consumerParams.parse(request.params)
    const count = (await pool.query('select consumer.admin_revoke_sessions($1) as n', [userId])).rows[0]?.n
    await consumerAudit(auth, 'consumer_sessions_revoked', userId)
    return { success: true, revoked: count }
  })

  app.put('/api/consumers/:userId/plan', async (request, reply) => {
    const auth = await guard(request, reply, adminRoles, true)
    if (!auth) return reply
    const { userId } = consumerParams.parse(request.params)
    const body = assignPlanSchema.parse(request.body)
    const ok = (await pool.query('select consumer.admin_set_plan($1, $2, $3) as ok', [userId, body.planCode, body.status])).rows[0]?.ok
    if (!ok) return reply.code(404).send({ success: false, message: 'User not found.' })
    await consumerAudit(auth, `consumer_plan_set:${body.planCode}`, userId)
    return { success: true }
  })
}


export async function issueOwnerInvitation(
  deps: Pick<AdminRouteDeps, 'pool' | 'notifier' | 'tenantRootDomain'>,
  tenantKey: string,
  owner: { email: string; displayName: string },
  actorUserId: string,
  ttlHours: number,
) {
  const { token, tokenHash } = createInvitationToken('owner')
  const issued = await deps.pool.query<{ invitation_id: string; hostname: string; display_name: string }>(
    `select platform.issue_tenant_owner_invitation($1, $2, $3, $4, $5, $6::uuid)::text as invitation_id,
            (select d.hostname from platform.tenant_domain d join platform.tenant_registry t on t.tenant_id = d.tenant_id
              where t.tenant_key = $1 and d.is_primary) as hostname,
            (select display_name from platform.tenant_registry where tenant_key = $1) as display_name`,
    [tenantKey, owner.email, owner.displayName, tokenHash, ttlHours, actorUserId],
  )
  const row = issued.rows[0]!
  const link = invitationLink(`https://${row.hostname}`, token)
  const delivery = await deps.notifier.send({
    type: 'tenant_owner_invitation',
    to: owner.email,
    subject: `Your ${row.display_name} workspace is ready`,
    link,
    context: { tenant: row.display_name, displayName: owner.displayName },
  })
  return {
    invitationId: row.invitation_id,
    email: owner.email.toLowerCase(),
    link,
    expiresInHours: ttlHours,
    delivered: delivery.delivered,
    note: 'The link works once the tenant is active. It is shown only now; reissue it if lost.',
  }
}
