import type { Pool } from 'pg'

const hostnamePattern = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/

export const MIN_SUPPORTED_SCHEMA_VERSION = 7

export type TenantLifecycleStatus =
  | 'provisioning'
  | 'active'
  | 'suspended'
  | 'migration_failed'
  | 'relocating'
  | 'provisioning_failed'
  | 'deleting'
  | 'deleted'

export type TenantBranding = {
  logoUrl: string | null
  primaryColor: string
  secondaryColor: string
  loginBackground: string | null
  loginMessage: string | null
  defaultLocale: string
  safeMetadata: Record<string, unknown>
}

export type TenantContext = {
  tenantId: string
  tenantKey: string
  displayName: string
  hostname: string
  subdomain: string
  schemaName: string
  /**
   * Schema that holds the tenant's data right now: schemaName on the VDS, or
   * the tenant-chosen schema in its own database. Use this in SQL.
   */
  dataSchema: string
  connectionTier: 'dedicated' | 'pooled'
  dataIntegrationId: string | null
  storageIntegrationId: string | null
  dbRole: string
  loginRole: string
  credentialRef: string
  status: TenantLifecycleStatus
  schemaVersion: number
  branding: TenantBranding
}

type TenantRegistryRow = {
  tenant_id: string
  tenant_key: string
  display_name: string
  schema_identifier: string
  db_role: string
  login_role: string
  credential_ref: string
  lifecycle_status: TenantLifecycleStatus
  schema_version: number
  hostname: string
  subdomain: string
  domain_status: 'pending' | 'active' | 'disabled' | 'failed'
  connection_tier: 'dedicated' | 'pooled' | null
  data_integration_id: string | null
  storage_integration_id: string | null
  data_schema: string | null
  logo_url: string | null
  primary_color: string | null
  secondary_color: string | null
  login_background: string | null
  login_message: string | null
  default_locale: string | null
  safe_metadata: Record<string, unknown> | null
}

export function normalizeTenantHostname(rawHost: string | undefined): string | null {
  if (!rawHost) return null
  const host = rawHost.trim().toLowerCase().replace(/\.$/, '').replace(/:\d+$/, '')
  if (!hostnamePattern.test(host) || host.includes('..')) return null
  return host
}

export class TenantResolver {
  private readonly negativeCache = new Map<string, number>()
  private readonly pending = new Map<string, Promise<TenantContext | null>>()

  constructor(
    private readonly registryPool: Pool,
    private readonly rootDomain: string,
    private readonly negativeCacheTtlMs = 10_000,
    private readonly maximumNegativeEntries = 1_000,
  ) {}

  async resolve(rawHost: string | undefined): Promise<TenantContext | null> {
    const hostname = normalizeTenantHostname(rawHost)
    if (!hostname || !hostname.endsWith(`.${this.rootDomain}`)) return null

    const tenantLabel = hostname.slice(0, -(this.rootDomain.length + 1))
    if (!tenantLabel || tenantLabel.includes('.')) return null

    const cachedUntil = this.negativeCache.get(hostname)
    if (cachedUntil && cachedUntil > Date.now()) return null
    if (cachedUntil) this.negativeCache.delete(hostname)

    const inFlight = this.pending.get(hostname)
    if (inFlight) return inFlight

    const resolution = this.resolveFromRegistry(hostname)
    this.pending.set(hostname, resolution)
    try {
      const context = await resolution
      if (!context) this.cacheNegative(hostname)
      return context
    } finally {
      this.pending.delete(hostname)
    }
  }

  private cacheNegative(hostname: string): void {
    if (this.negativeCache.size >= this.maximumNegativeEntries) {
      const oldest = this.negativeCache.keys().next().value
      if (oldest) this.negativeCache.delete(oldest)
    }
    this.negativeCache.set(hostname, Date.now() + this.negativeCacheTtlMs)
  }

  private async resolveFromRegistry(hostname: string): Promise<TenantContext | null> {
    const result = await this.registryPool.query<TenantRegistryRow>(
      `select
         t.tenant_id::text,
         t.tenant_key,
         t.display_name,
         t.schema_identifier,
         t.db_role,
         t.login_role,
         t.credential_ref,
         t.lifecycle_status,
         coalesce(t.schema_version, 1) as schema_version,
         d.hostname,
         d.subdomain,
         d.status as domain_status,
         b.logo_url,
         b.primary_color,
         b.secondary_color,
         b.login_background,
         b.login_message,
         coalesce(b.default_locale, t.default_locale) as default_locale,
         b.safe_metadata,
         t.connection_tier,
         t.data_integration_id::text,
         t.storage_integration_id::text,
         di.settings->>'schema' as data_schema
       from platform.tenant_domain d
       join platform.tenant_registry t on t.tenant_id = d.tenant_id
       left join platform.tenant_branding b on b.tenant_id = t.tenant_id
       left join platform.tenant_integration di on di.integration_id = t.data_integration_id
       where lower(d.hostname) = $1
       limit 1`,
      [hostname],
    )
    const row = result.rows[0]
    if (
      !row ||
      !row.tenant_key ||
      !row.db_role ||
      !row.login_role ||
      !row.credential_ref ||
      row.domain_status !== 'active'
    ) {
      return null
    }

    return {
      tenantId: row.tenant_id,
      tenantKey: row.tenant_key,
      displayName: row.display_name,
      hostname: row.hostname,
      subdomain: row.subdomain,
      schemaName: row.schema_identifier,
      dataSchema: row.data_integration_id && row.data_schema ? row.data_schema : row.schema_identifier,
      connectionTier: row.connection_tier === 'pooled' ? 'pooled' : 'dedicated',
      dataIntegrationId: row.data_integration_id ?? null,
      storageIntegrationId: row.storage_integration_id ?? null,
      dbRole: row.db_role,
      loginRole: row.login_role,
      credentialRef: row.credential_ref,
      status: row.lifecycle_status,
      schemaVersion: Number(row.schema_version || 1),
      branding: {
        logoUrl: row.logo_url,
        primaryColor: row.primary_color || '#2563eb',
        secondaryColor: row.secondary_color || '#0f172a',
        loginBackground: row.login_background,
        loginMessage: row.login_message,
        defaultLocale: row.default_locale || 'en',
        safeMetadata: row.safe_metadata || {},
      },
    }
  }
}

export function publicTenantBootstrap(context: TenantContext) {
  return {
    tenantId: context.tenantKey,
    displayName: context.displayName,
    hostname: context.hostname,
    subdomain: context.subdomain,
    status: context.status,
    branding: context.branding,
  }
}
