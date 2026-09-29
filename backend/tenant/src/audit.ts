import type { TenantContext } from './tenant-context.js'
import type { TenantDatabaseManager } from './tenant-database.js'
import type { PoolClient } from 'pg'

export type AuditOutcome = 'success' | 'denied' | 'failure'

export interface RecordTenantAuditOptions {
  databases: TenantDatabaseManager
  context: TenantContext
  actorUserId?: string | null | undefined
  action: string
  resourceType: string
  resourceId?: string | null | undefined
  outcome: AuditOutcome
  correlationId?: string | null | undefined
  reason?: string | null | undefined
  actorType?: 'user' | 'operator' | 'system' | undefined
  operatorId?: string | null | undefined
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function recordTenantAudit(options: RecordTenantAuditOptions): Promise<void> {
  const {
    databases,
    context,
    actorUserId = null,
    action,
    resourceType,
    resourceId = null,
    outcome,
    correlationId = null,
    reason = null,
    actorType = 'user',
    operatorId = null,
  } = options

  const parsedResourceId = resourceId && UUID_REGEX.test(resourceId) ? resourceId : null
  const parsedCorrelationId = correlationId && UUID_REGEX.test(correlationId) ? correlationId : null
  const combinedReason = resourceId && !parsedResourceId
    ? (reason ? `${reason} (target: ${resourceId})` : `target: ${resourceId}`)
    : reason

  try {
    await databases.withTenant(context, async (client: PoolClient) => {
      await client.query(
        `insert into audit_event
           (actor_user_id, action, resource_type, resource_id, outcome, correlation_id, reason, actor_type, operator_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          actorUserId,
          action,
          resourceType,
          parsedResourceId,
          outcome,
          parsedCorrelationId,
          combinedReason,
          actorType,
          operatorId,
        ],
      )
    })
  } catch (error) {
    // Redacted structured log; never silently discard without record
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'tenant_audit_write_failed',
        tenantId: context.tenantId,
        action,
        resourceType,
        outcome,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}
