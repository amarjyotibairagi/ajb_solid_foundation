import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import { z } from 'zod'
import {
  configBoolean,
  IntegrationUnavailableError,
  IntegrationValidationError,
  type IntegrationService,
} from '@skeleton/server-kit'
import type { TenantModule, TenantRequestKit, TenantSession } from './types.js'

// Core module: tenant owners connect their own S3-compatible storage and/or
// PostgreSQL database. Each integration is saved, tested (non-destructive),
// then activated. Operators can do the same from the admin panel regardless
// of the integration.byo_* features, which govern only this self-service.

const body = z.object({
  provider: z.enum(['s3', 'postgresql']),
  displayName: z.string().trim().min(1).max(120),
  settings: z.record(z.string(), z.unknown()),
  secret: z.record(z.string(), z.unknown()).optional(),
})
const params = z.object({ integrationId: z.uuid() })

export function createIntegrationsModule(deps: { registry: Pool; integrations: IntegrationService }): TenantModule {
  const { integrations } = deps
  return {
    code: 'integrations',
    register(app, kit) {
      const owner = async (request: FastifyRequest, reply: FastifyReply, mutation: boolean): Promise<TenantSession | null> => {
        const session = await kit.requireSession(request, reply)
        if (!session) return null
        if (!(await kit.requirePermission(request, reply, session, 'tenant.integrations.manage'))) return null
        if (session.canonicalRole !== 'tenant_owner') {
          void reply.code(403).send({ success: false, message: 'Only the workspace owner can connect external storage or databases.' })
          return null
        }
        if (mutation && !kit.requireCsrf(request, reply, session)) return null
        return session
      }
      const featureFor = async (request: FastifyRequest, reply: FastifyReply, provider: 's3' | 'postgresql') => {
        const key = provider === 's3' ? 'integration.byo_storage' : 'integration.byo_database'
        if (configBoolean(await kit.config(request), key, false)) return true
        void reply.code(403).send({ success: false, message: 'Your plan does not include this integration. Contact the platform operator.' })
        return false
      }
      const fail = (reply: FastifyReply, error: unknown) => {
        if (error instanceof IntegrationUnavailableError) return reply.code(503).send({ success: false, message: error.message })
        if (error instanceof IntegrationValidationError) return reply.code(400).send({ success: false, message: error.message })
        const code = (error as { code?: string }).code
        if (code === '22023' || code === '55000') return reply.code(409).send({ success: false, message: (error as Error).message })
        throw error
      }
      const actor = (session: TenantSession) => `tenant:${session.username}`
      const findKind = async (request: FastifyRequest, integrationId: string) =>
        (await integrations.list(kit.tenant(request).tenantId)).find((item) => item.integrationId === integrationId)

      app.get('/api/v1/integrations', async (request, reply) => {
        if (!(await owner(request, reply, false))) return
        const context = kit.tenant(request)
        const config = await kit.config(request)
        return {
          success: true,
          available: integrations.available,
          features: {
            storage: configBoolean(config, 'integration.byo_storage', false),
            database: configBoolean(config, 'integration.byo_database', false),
          },
          active: { storage: context.storageIntegrationId, database: context.dataIntegrationId },
          integrations: await integrations.list(context.tenantId),
        }
      })

      app.post('/api/v1/integrations', async (request, reply) => {
        const session = await owner(request, reply, true)
        if (!session) return
        const input = body.parse(request.body)
        if (!(await featureFor(request, reply, input.provider))) return
        try {
          const integration = await integrations.save(kit.tenant(request).tenantId, input, actor(session))
          return reply.code(201).send({ success: true, integration })
        } catch (error) {
          return fail(reply, error)
        }
      })

      app.put('/api/v1/integrations/:integrationId', async (request, reply) => {
        const session = await owner(request, reply, true)
        if (!session) return
        const { integrationId } = params.parse(request.params)
        const input = body.parse(request.body)
        if (!(await featureFor(request, reply, input.provider))) return
        try {
          return { success: true, integration: await integrations.save(kit.tenant(request).tenantId, { ...input, integrationId }, actor(session)) }
        } catch (error) {
          return fail(reply, error)
        }
      })

      app.post('/api/v1/integrations/:integrationId/test', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
        const session = await owner(request, reply, true)
        if (!session) return
        const { integrationId } = params.parse(request.params)
        try {
          const report = await integrations.test(kit.tenant(request).tenantId, integrationId, actor(session))
          await kit.audit(request, { actorUserId: session.userId, action: 'integration:test', resourceType: 'integration', resourceId: integrationId, outcome: report.ok ? 'success' : 'failure' })
          return { success: true, report }
        } catch (error) {
          return fail(reply, error)
        }
      })

      app.post('/api/v1/integrations/:integrationId/activate', async (request, reply) => {
        const session = await owner(request, reply, true)
        if (!session) return
        const { integrationId } = params.parse(request.params)
        const context = kit.tenant(request)
        try {
          const integration = await findKind(request, integrationId)
          if (!integration) return reply.code(404).send({ success: false, message: 'Integration not found.' })
          if (!(await featureFor(request, reply, integration.provider))) return
          if (integration.kind === 'storage') {
            await integrations.activateStorage(context.tenantId, integrationId, actor(session))
            await kit.audit(request, { actorUserId: session.userId, action: 'integration:activate_storage', resourceType: 'integration', resourceId: integrationId, outcome: 'success' })
            return { success: true, message: 'New files are now stored in your bucket. Existing files remain readable.' }
          }
          const jobId = await integrations.requestDatabaseMove(context.tenantKey, context.tenantId, integrationId, null, actor(session))
          await kit.audit(request, { actorUserId: session.userId, action: 'integration:move_database', resourceType: 'integration', resourceId: integrationId, outcome: 'success' })
          return reply.code(202).send({ success: true, jobId, message: 'Your data is being moved. The workspace is briefly unavailable.' })
        } catch (error) {
          return fail(reply, error)
        }
      })

      app.post('/api/v1/integrations/:integrationId/retire', async (request, reply) => {
        const session = await owner(request, reply, true)
        if (!session) return
        const { integrationId } = params.parse(request.params)
        try {
          if (!(await integrations.retire(kit.tenant(request).tenantId, integrationId, actor(session)))) {
            return reply.code(404).send({ success: false, message: 'Integration not found or already removed.' })
          }
          return { success: true }
        } catch (error) {
          return fail(reply, error)
        }
      })

      app.post('/api/v1/integrations/storage/use-vds', async (request, reply) => {
        const session = await owner(request, reply, true)
        if (!session) return
        await integrations.activateStorage(kit.tenant(request).tenantId, null, actor(session))
        return { success: true, message: 'New files are stored on the platform again.' }
      })

      app.post('/api/v1/integrations/storage/relocate', async (request, reply) => {
        const session = await owner(request, reply, true)
        if (!session) return
        try {
          const context = kit.tenant(request)
          return reply.code(202).send({ success: true, jobId: await integrations.enqueue(context.tenantKey, 'relocate_storage', {}, null, actor(session)) })
        } catch (error) {
          return fail(reply, error)
        }
      })

      app.post('/api/v1/integrations/database/use-vds', async (request, reply) => {
        const session = await owner(request, reply, true)
        if (!session) return
        try {
          const context = kit.tenant(request)
          const jobId = await integrations.requestDatabaseMove(context.tenantKey, context.tenantId, null, null, actor(session))
          return reply.code(202).send({ success: true, jobId })
        } catch (error) {
          return fail(reply, error)
        }
      })

      app.get('/api/v1/operations/:jobId', async (request, reply) => {
        if (!(await owner(request, reply, false))) return
        const { jobId } = z.object({ jobId: z.uuid() }).parse(request.params)
        const job = (await deps.registry.query(
          `select job_id::text as "jobId", job_type as "jobType", status, current_step as "currentStep",
                  safe_error_message as "errorMessage", created_at as "createdAt", completed_at as "completedAt",
                  (select coalesce(jsonb_agg(jsonb_build_object('code', step_code, 'message', display_message, 'status', status) order by step_order), '[]'::jsonb)
                     from platform.tenant_provisioning_step s where s.job_id = j.job_id) as steps
             from platform.tenant_provisioning_job j
            where job_id = $1 and tenant_id = $2 and job_type in ('migrate', 'relocate_database', 'relocate_storage')`,
          [jobId, kit.tenant(request).tenantId],
        )).rows[0]
        if (!job) return reply.code(404).send({ success: false, message: 'Operation not found.' })
        return { success: true, job }
      })
    },
  }
}

export type { TenantRequestKit }
