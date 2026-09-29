import { z } from 'zod'
import {
  DELEGATABLE_PERMISSION_CODES,
  grantDelegation,
  isDelegatablePermission,
  listDelegations,
  revokeDelegation,
} from '../delegated-capabilities.js'
import type { TenantModule } from './types.js'

// Example application module. Per-user delegation of allow-listed permissions
// to managers originated in one product built on this foundation; it now ships
// disabled by default (config key module.delegations) and serves as the
// reference implementation of the TenantModule contract.

const managerParams = z.object({ userId: z.uuid() })
const grantBody = z.object({
  permissionCode: z.string().trim().max(128),
  reason: z.string().trim().min(1).max(500),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
})
const revokeBody = z.object({
  reason: z.string().trim().min(1).max(500).default('Revoked by tenant administrator.'),
})

export const delegationsModule: TenantModule = {
  code: 'delegations',
  featureKey: 'module.delegations',
  register(app, kit) {
    app.get('/api/v1/managers/:userId/delegations', async (request, reply) => {
      const session = await kit.requireSession(request, reply)
      if (!session || !(await kit.requirePermission(request, reply, session, 'tenant.delegations.read'))) return
      const { userId } = managerParams.parse(request.params)
      if (session.canonicalRole === 'tenant_manager' && userId !== session.userId) {
        return reply.code(403).send({ success: false, message: 'Managers may only view their own delegations.' })
      }
      const delegations = await kit.withTenant(request, (client) => listDelegations(client, userId))
      return {
        success: true,
        managerUserId: userId,
        availablePermissions: [...DELEGATABLE_PERMISSION_CODES],
        delegations,
      }
    })

    app.post('/api/v1/managers/:userId/delegations', async (request, reply) => {
      const session = await kit.requireSession(request, reply)
      if (!session) return
      if (!(await kit.requirePermission(request, reply, session, 'tenant.delegations.manage')) || !kit.requireCsrf(request, reply, session)) return
      if (!['tenant_owner', 'tenant_admin'].includes(session.canonicalRole)) {
        return reply.code(403).send({ success: false, message: 'Only tenant owners and administrators may manage delegations.' })
      }
      const { userId } = managerParams.parse(request.params)
      const body = grantBody.parse(request.body)
      if (!isDelegatablePermission(body.permissionCode)) {
        await kit.audit(request, {
          actorUserId: session.userId,
          action: 'delegation:grant',
          resourceType: 'capability_delegation',
          resourceId: userId,
          outcome: 'denied',
          reason: 'Requested permission is not delegatable.',
        })
        return reply.code(400).send({ success: false, message: 'This permission cannot be delegated.' })
      }
      try {
        const delegation = await kit.withTenant(request, (client) =>
          grantDelegation(client, {
            actorUserId: session.userId,
            managerUserId: userId,
            permissionCode: body.permissionCode,
            reason: body.reason,
            expiresAt: body.expiresAt || null,
            correlationId: request.id,
          }),
        )
        return { success: true, delegation }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Delegation could not be created.'
        return reply.code(400).send({ success: false, message })
      }
    })

    app.delete('/api/v1/managers/:userId/delegations/:delegationId', async (request, reply) => {
      const session = await kit.requireSession(request, reply)
      if (!session) return
      if (!(await kit.requirePermission(request, reply, session, 'tenant.delegations.manage')) || !kit.requireCsrf(request, reply, session)) return
      if (!['tenant_owner', 'tenant_admin'].includes(session.canonicalRole)) {
        return reply.code(403).send({ success: false, message: 'Only tenant owners and administrators may manage delegations.' })
      }
      const params = z.object({ userId: z.uuid(), delegationId: z.uuid() }).parse(request.params)
      const body = revokeBody.parse(request.body || {})
      try {
        const delegation = await kit.withTenant(request, (client) =>
          revokeDelegation(client, {
            actorUserId: session.userId,
            managerUserId: params.userId,
            delegationId: params.delegationId,
            reason: body.reason,
            correlationId: request.id,
          }),
        )
        return { success: true, delegation }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Delegation could not be revoked.'
        return reply.code(404).send({ success: false, message })
      }
    })
  },
}
