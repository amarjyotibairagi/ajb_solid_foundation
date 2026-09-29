import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { PoolClient } from 'pg'
import type { ResolvedConfig } from '@skeleton/server-kit'
import type { RecordTenantAuditOptions } from '../audit.js'
import type { CanonicalRole } from '../authorization.js'
import type { TenantContext } from '../tenant-context.js'

export type TenantSession = {
  tokenHash: string
  csrfHash: string
  tenantId: string
  userId: string
  username: string
  displayName: string
  email: string | null
  role: 'admin' | 'manager' | 'user' | 'guest'
  canonicalRole: CanonicalRole
  permissions: Set<string>
}

/**
 * Everything a module needs from the foundation. Modules never open database
 * connections, read credentials, resolve hostnames, or check cookies
 * themselves; they receive an already-bound tenant and must run every query
 * through withTenant so the per-tenant role, search_path, and RLS context are
 * applied.
 */
export interface TenantRequestKit {
  /** The trusted tenant for this request, resolved from the Host header. */
  tenant(request: FastifyRequest): TenantContext
  /** Runs a callback in one transaction under the tenant runtime role. */
  withTenant<T>(request: FastifyRequest, callback: (client: PoolClient) => Promise<T>): Promise<T>
  /** Resolved platform/plan/tenant configuration for this tenant. */
  config(request: FastifyRequest): Promise<ResolvedConfig>
  /** Returns the session or replies 401. */
  requireSession(request: FastifyRequest, reply: FastifyReply): Promise<TenantSession | null>
  /** Returns false (and replies 403, audited) when the session lacks the permission. */
  requirePermission(request: FastifyRequest, reply: FastifyReply, session: TenantSession, permission: string): Promise<boolean>
  /** Returns false (and replies 403) unless X-CSRF-Token matches the session. Call on every mutation. */
  requireCsrf(request: FastifyRequest, reply: FastifyReply, session: TenantSession): boolean
  /** Returns false (and replies 404) when a boolean feature is off for this tenant. */
  requireFeature(request: FastifyRequest, reply: FastifyReply, featureKey: string): Promise<boolean>
  /**
   * The tenant's file service: stores bytes on the VDS or the tenant's own
   * bucket (whichever is active) and metadata in the tenant schema, enforcing
   * size and quota limits. Modules should store files through this.
   */
  files: import('./files.js').FileService
  /** Appends to the tenant's immutable audit trail. Never throws. */
  audit(request: FastifyRequest, event: Omit<RecordTenantAuditOptions, 'databases' | 'context' | 'correlationId'>): Promise<void>
}

/**
 * An application-layer module mounted into the tenant BFF.
 *
 * Contract:
 *  - `code` is unique and matches config_definition.module_code for its keys.
 *  - `featureKey`, when set, is a boolean config key (usually `module.<code>`).
 *    Every route the module registers answers 404 for tenants where it is off,
 *    so operators enable modules per platform, plan, or tenant from the admin
 *    panel without deploys.
 *  - Routes live under `/api/v1/<code>/` or another prefix owned by the module.
 *  - Tables the module needs are added by numbered files in
 *    database/migrations/tenant/versions/ and MUST be declared in
 *    database/migrations/tenant/access-manifest.json (the migrator fails
 *    closed otherwise). Permissions are seeded by the same migration.
 *  - Configuration keys are declared by a platform migration inserting into
 *    platform.config_definition with module_code = code.
 */
export interface TenantModule {
  code: string
  featureKey?: string
  register(app: FastifyInstance, kit: TenantRequestKit): Promise<void> | void
}
