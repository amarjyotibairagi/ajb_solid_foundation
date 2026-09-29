import argon2 from 'argon2'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import {
  ARGON2ID_OPTIONS,
  configBoolean,
  configInteger,
  createInvitationToken,
  invitationLink,
  type NotificationSender,
  parseInvitationToken,
} from '@skeleton/server-kit'
import type { TenantContext } from '../tenant-context.js'
import type { TenantModule } from './types.js'

// Core module: invitation redemption for tenant users and for the tenant's
// first owner. The owner invitation is issued by a platform operator and
// stored in the platform schema; everything else is tenant-local.

export class InvitationError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message)
  }
}

const invalidInvitation = 'This invitation link is invalid, already used, or expired.'
const usernamePattern = /^[a-zA-Z0-9._-]{3,64}$/

export async function issueUserInvitation(
  client: PoolClient,
  options: { userId: string; invitedBy: string; ttlHours: number },
): Promise<{ token: string; expiresAt: string }> {
  const { token, tokenHash } = createInvitationToken('user')
  await client.query(
    `update user_invitation set revoked_at = now()
      where user_id = $1 and accepted_at is null and revoked_at is null`,
    [options.userId],
  )
  const result = await client.query<{ expires_at: Date }>(
    `insert into user_invitation (user_id, token_hash, invited_by, expires_at)
     values ($1, $2, $3, now() + make_interval(hours => $4::int))
     returning expires_at`,
    [options.userId, tokenHash, options.invitedBy, options.ttlHours],
  )
  return { token, expiresAt: result.rows[0]!.expires_at.toISOString() }
}

export function tenantOrigin(context: TenantContext): string {
  return `https://${context.hostname}`
}

export async function deliverInvitation(
  notifier: NotificationSender,
  context: TenantContext,
  options: { to: string | null; token: string; type: 'tenant_owner_invitation' | 'tenant_user_invitation'; displayName: string },
) {
  const link = invitationLink(tenantOrigin(context), options.token)
  const delivery = options.to
    ? await notifier.send({
        type: options.type,
        to: options.to,
        subject: `You're invited to ${context.displayName}`,
        link,
        context: { tenant: context.displayName, displayName: options.displayName },
      })
    : { delivered: false as const, channel: 'none' as const }
  return { link, delivery }
}

const inspectBody = z.object({ token: z.string().min(10).max(200) })
const acceptBody = z.object({
  token: z.string().min(10).max(200),
  password: z.string().min(1).max(512),
  username: z.string().trim().max(64).optional(),
})

export function createInvitationsModule(deps: { registry: Pool }): TenantModule {
  return {
    code: 'invitations',
    register(app, kit) {
      const limits = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }

      app.post('/api/auth/invitations/inspect', limits, async (request, reply) => {
        const context = kit.tenant(request)
        const parsed = parseInvitationToken(inspectBody.parse(request.body).token)
        const config = await kit.config(request)
        const passwordMinLength = configInteger(config, 'auth.password.min_length', 12)
        if (parsed?.kind === 'owner') {
          const row = (
            await deps.registry.query<{ email_normalized: string; display_name: string; expires_at: Date }>(
              'select * from platform.inspect_tenant_owner_invitation($1::uuid, $2)',
              [context.tenantId, parsed.tokenHash],
            )
          ).rows[0]
          if (row) {
            return {
              success: true,
              invitation: {
                kind: 'owner',
                email: row.email_normalized,
                displayName: row.display_name,
                username: null,
                requiresUsername: true,
                expiresAt: row.expires_at,
                passwordMinLength,
              },
            }
          }
        } else if (parsed?.kind === 'user') {
          const row = await kit.withTenant(request, async (client) =>
            (
              await client.query<{ username: string; display_name: string; email_normalized: string | null; expires_at: Date }>(
                `select u.username, u.display_name, u.email_normalized, i.expires_at
                   from user_invitation i join user_account u on u.user_id = i.user_id
                  where i.token_hash = $1 and i.accepted_at is null and i.revoked_at is null
                    and i.expires_at > now() and u.account_status = 'invited'`,
                [parsed.tokenHash],
              )
            ).rows[0],
          )
          if (row) {
            return {
              success: true,
              invitation: {
                kind: 'user',
                email: row.email_normalized,
                displayName: row.display_name,
                username: row.username,
                requiresUsername: false,
                expiresAt: row.expires_at,
                passwordMinLength,
              },
            }
          }
        }
        return reply.code(404).send({ success: false, message: invalidInvitation })
      })

      app.post('/api/auth/invitations/accept', limits, async (request, reply) => {
        const context = kit.tenant(request)
        const body = acceptBody.parse(request.body)
        const parsed = parseInvitationToken(body.token)
        if (!parsed || parsed.kind === 'operator') return reply.code(404).send({ success: false, message: invalidInvitation })
        const config = await kit.config(request)
        const minimum = configInteger(config, 'auth.password.min_length', 12)
        if (body.password.length < minimum) {
          return reply.code(400).send({ success: false, message: `Password must be at least ${minimum} characters.` })
        }
        // Hash before opening the transaction so no connection is held during
        // the deliberately slow KDF.
        const passwordHash = await argon2.hash(body.password, { type: argon2.argon2id, ...ARGON2ID_OPTIONS })

        try {
          if (parsed.kind === 'user') {
            const userId = await kit.withTenant(request, async (client) => {
              const invitation = (
                await client.query<{ invitation_id: string; user_id: string; username: string }>(
                  `select i.invitation_id::text, i.user_id::text, u.username
                     from user_invitation i join user_account u on u.user_id = i.user_id
                    where i.token_hash = $1 and i.accepted_at is null and i.revoked_at is null
                      and i.expires_at > now() and u.account_status = 'invited'
                    for update of i, u`,
                  [parsed.tokenHash],
                )
              ).rows[0]
              if (!invitation) throw new InvitationError(invalidInvitation, 404)
              await setPassword(client, invitation.user_id, invitation.username, passwordHash)
              await client.query(`update user_account set account_status = 'active', updated_at = now() where user_id = $1`, [invitation.user_id])
              await client.query('update user_invitation set accepted_at = now() where invitation_id = $1', [invitation.invitation_id])
              await client.query(
                `insert into audit_event (actor_user_id, action, resource_type, resource_id, outcome, correlation_id)
                 values ($1, 'user:invitation_accepted', 'user_account', $1, 'success', $2)`,
                [invitation.user_id, request.id],
              )
              return invitation.user_id
            })
            return { success: true, userId, message: 'Your account is ready. Sign in to continue.' }
          }

          // Owner invitation: create the account inside the tenant transaction,
          // then claim the platform invitation before committing. If the claim
          // fails (already used, revoked, expired) the account is rolled back.
          const username = body.username?.trim() || ''
          if (!usernamePattern.test(username)) {
            return reply.code(400).send({ success: false, message: 'Choose a username of 3-64 letters, digits, dot, dash or underscore.' })
          }
          const preview = (
            await deps.registry.query<{ email_normalized: string; display_name: string }>(
              'select * from platform.inspect_tenant_owner_invitation($1::uuid, $2)',
              [context.tenantId, parsed.tokenHash],
            )
          ).rows[0]
          if (!preview) throw new InvitationError(invalidInvitation, 404)

          const userId = await kit.withTenant(request, async (client) => {
            await client.query('select pg_advisory_xact_lock(hashtext($1))', [`tenant-owner-lock:${context.schemaName}`])
            const created = (
              await client.query<{ user_id: string }>(
                `insert into user_account (username, display_name, email_normalized, account_status)
                 values (lower($1), $2, lower($3), 'active') returning user_id::text`,
                [username, preview.display_name, preview.email_normalized],
              )
            ).rows[0]!
            const ownerRole = (await client.query<{ role_id: string }>(`select role_id::text from role_definition where role_code = 'tenant_owner'`)).rows[0]
            if (!ownerRole) throw new Error('Role tenant_owner is missing.')
            await client.query('insert into role_assignment (user_id, role_id, granted_by) values ($1, $2, null)', [created.user_id, ownerRole.role_id])
            await setPassword(client, created.user_id, username, passwordHash)
            const claimed = await deps.registry.query('select * from platform.consume_tenant_owner_invitation($1::uuid, $2)', [
              context.tenantId,
              parsed.tokenHash,
            ])
            if (!claimed.rows[0]) throw new InvitationError(invalidInvitation, 404)
            await client.query(
              `insert into audit_event (actor_user_id, action, resource_type, resource_id, outcome, correlation_id, actor_type, reason)
               values ($1, 'owner:invitation_accepted', 'user_account', $1, 'success', $2, 'system', 'Platform-issued owner invitation')`,
              [created.user_id, request.id],
            )
            return created.user_id
          })
          return { success: true, userId, message: 'Your owner account is ready. Sign in to continue.' }
        } catch (error) {
          if (error instanceof InvitationError) return reply.code(error.statusCode).send({ success: false, message: error.message })
          if ((error as { code?: string }).code === '23505') {
            return reply.code(409).send({ success: false, message: 'That username or email is already in use in this workspace.' })
          }
          throw error
        }
      })
    },
  }
}

async function setPassword(client: PoolClient, userId: string, username: string, passwordHash: string) {
  await client.query(`delete from user_identity where user_id = $1 and credential_type = 'password'`, [userId])
  await client.query(
    `insert into user_identity (user_id, provider, provider_subject, credential_type, password_hash)
     values ($1, 'local', lower($2), 'password', $3)`,
    [userId, username, passwordHash],
  )
}

export function invitationsEnabled(config: Parameters<typeof configBoolean>[0]): boolean {
  return configBoolean(config, 'feature.user_invitations', true)
}
