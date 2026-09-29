import { z } from 'zod'
import { ConfigValidationError, validateConfigValue } from '@skeleton/server-kit'
import type { TenantConfigService } from '../tenant-config.js'
import type { TenantModule } from './types.js'

// Core module: lets tenant administrators read their effective configuration
// (features, limits, settings and where each value came from) and change the
// subset the platform marks tenant_editable. Everything else is controlled
// from the platform admin panel.

const keyParams = z.object({ key: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/).max(96) })
const valueBody = z.object({ value: z.unknown() })

export function createSettingsModule(deps: { configs: TenantConfigService }): TenantModule {
  return {
    code: 'settings',
    register(app, kit) {
      app.get('/api/v1/settings', async (request, reply) => {
        const session = await kit.requireSession(request, reply)
        if (!session || !(await kit.requirePermission(request, reply, session, 'tenant.settings.read'))) return
        const config = await kit.config(request)
        const entries = Object.entries(config.definitions).map(([key, meta]) => ({
          key,
          kind: meta.kind,
          valueType: meta.valueType,
          value: config.values[key],
          source: config.sources[key],
          editable: meta.tenantEditable,
          min: meta.min ?? null,
          max: meta.max ?? null,
          maxLength: meta.maxLength ?? null,
        }))
        return { success: true, planCode: config.planCode, settings: entries }
      })

      app.put('/api/v1/settings/:key', async (request, reply) => {
        const session = await kit.requireSession(request, reply)
        if (!session) return
        if (!(await kit.requirePermission(request, reply, session, 'tenant.settings.manage')) || !kit.requireCsrf(request, reply, session)) return
        const { key } = keyParams.parse(request.params)
        const { value } = valueBody.parse(request.body)
        const config = await kit.config(request)
        const meta = config.definitions[key]
        if (!meta?.tenantEditable) {
          await kit.audit(request, {
            actorUserId: session.userId,
            action: 'setting:update',
            resourceType: 'tenant_setting',
            resourceId: key,
            outcome: 'denied',
            reason: 'Setting is not tenant-editable.',
          })
          return reply.code(403).send({ success: false, message: 'This setting is managed by the platform.' })
        }
        let validated
        try {
          validated = validateConfigValue(key, meta, value)
        } catch (error) {
          if (error instanceof ConfigValidationError) return reply.code(400).send({ success: false, message: error.message })
          throw error
        }
        await kit.withTenant(request, async (client) => {
          await client.query(
            `insert into tenant_setting (setting_key, setting_value, updated_by, updated_at)
             values ($1, $2::jsonb, $3, now())
             on conflict (setting_key) do update
               set setting_value = excluded.setting_value, updated_by = excluded.updated_by, updated_at = now()`,
            [key, JSON.stringify(validated), session.userId],
          )
          await client.query(
            `insert into audit_event (actor_user_id, action, resource_type, outcome, correlation_id, reason)
             values ($1, 'setting:update', 'tenant_setting', 'success', $2, $3)`,
            [session.userId, request.id, key],
          )
        })
        deps.configs.invalidate(kit.tenant(request).tenantId)
        return { success: true, key, value: validated }
      })

      app.delete('/api/v1/settings/:key', async (request, reply) => {
        const session = await kit.requireSession(request, reply)
        if (!session) return
        if (!(await kit.requirePermission(request, reply, session, 'tenant.settings.manage')) || !kit.requireCsrf(request, reply, session)) return
        const { key } = keyParams.parse(request.params)
        await kit.withTenant(request, async (client) => {
          await client.query('delete from tenant_setting where setting_key = $1', [key])
          await client.query(
            `insert into audit_event (actor_user_id, action, resource_type, outcome, correlation_id, reason)
             values ($1, 'setting:reset', 'tenant_setting', 'success', $2, $3)`,
            [session.userId, request.id, key],
          )
        })
        deps.configs.invalidate(kit.tenant(request).tenantId)
        return { success: true, key }
      })
    },
  }
}
