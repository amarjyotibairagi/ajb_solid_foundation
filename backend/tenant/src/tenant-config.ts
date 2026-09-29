import type { Pool } from 'pg'
import {
  type ConfigDefinitionMeta,
  type ConfigValue,
  type ResolvedConfig,
  validateConfigValue,
} from '@skeleton/server-kit'
import type { TenantContext } from './tenant-context.js'
import type { TenantDatabaseManager } from './tenant-database.js'

type CacheEntry = { expiresAt: number; value: Promise<ResolvedConfig> }

/**
 * Effective configuration for one tenant: platform.resolve_tenant_config
 * (definition default -> platform -> plan -> operator tenant override), then
 * tenant-local values from the tenant schema's tenant_setting table for keys
 * the registry marks tenant_editable.
 *
 * Cached per tenant for a short TTL. The registry connection goes through a
 * transaction-mode PgBouncer pool, so LISTEN/NOTIFY invalidation is not
 * available; operator changes therefore take effect within ttlMs. Tenant-local
 * edits invalidate this process's entry immediately.
 */
export class TenantConfigService {
  private readonly cache = new Map<string, CacheEntry>()

  constructor(
    private readonly registry: Pool,
    private readonly databases: TenantDatabaseManager,
    private readonly ttlMs = Number(process.env.TENANT_CONFIG_CACHE_TTL_MS || 10_000),
    private readonly maximumEntries = 5_000,
  ) {}

  async forTenant(context: TenantContext): Promise<ResolvedConfig> {
    const cached = this.cache.get(context.tenantId)
    if (cached && cached.expiresAt > Date.now()) return cached.value
    const value = this.load(context)
    this.cache.set(context.tenantId, { expiresAt: Date.now() + this.ttlMs, value })
    if (this.cache.size > this.maximumEntries) {
      const oldest = this.cache.keys().next().value
      if (oldest) this.cache.delete(oldest)
    }
    try {
      return await value
    } catch (error) {
      this.cache.delete(context.tenantId)
      throw error
    }
  }

  invalidate(tenantId: string): void {
    this.cache.delete(tenantId)
  }

  private async load(context: TenantContext): Promise<ResolvedConfig> {
    const result = await this.registry.query<{ config: ResolvedConfig }>(
      'select platform.resolve_tenant_config($1::uuid) as config',
      [context.tenantId],
    )
    const resolved = result.rows[0]?.config
    if (!resolved) throw new Error('Tenant configuration could not be resolved.')
    const config: ResolvedConfig = {
      planCode: resolved.planCode ?? null,
      values: { ...resolved.values },
      sources: { ...resolved.sources },
      definitions: resolved.definitions,
    }

    const editable = Object.entries(config.definitions)
      .filter(([, meta]) => meta.tenantEditable)
      .map(([key]) => key)
    if (!editable.length || context.status !== 'active') return config

    const local = await this.databases.withTenant(context, async (client) =>
      (
        await client.query<{ setting_key: string; setting_value: unknown }>(
          'select setting_key, setting_value from tenant_setting where setting_key = any($1::text[])',
          [editable],
        )
      ).rows,
    )
    for (const row of local) {
      try {
        config.values[row.setting_key] = validateConfigValue(row.setting_key, config.definitions[row.setting_key], row.setting_value)
        config.sources[row.setting_key] = 'tenant_local'
      } catch {
        // A stored value that no longer satisfies the definition (bounds
        // tightened later) is ignored rather than trusted.
      }
    }
    return config
  }
}

export type { ConfigDefinitionMeta, ConfigValue, ResolvedConfig }
