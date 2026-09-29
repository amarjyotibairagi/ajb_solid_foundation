import type { Pool } from 'pg'
import {
  integrationSecretAad,
  LocalObjectStore,
  localTenantStorageRoot,
  normalizeS3Credentials,
  normalizeS3Settings,
  S3ObjectStore,
  type EndpointPolicy,
  type ObjectStore,
  type SecretBox,
} from '@skeleton/server-kit'
import type { TenantContext } from './tenant-context.js'

/**
 * Resolves object stores for a tenant. 'vds' is the host's own disk under
 * STORAGE_ROOT/tenants/<tenantKey>; any other reference is one of the
 * tenant's S3-compatible integrations. Every object records the backend it
 * was written to, so objects stay readable after the tenant switches.
 */
export class TenantStorage {
  private readonly cache = new Map<string, { expiresAt: number; store: ObjectStore }>()

  constructor(
    private readonly registry: Pool,
    private readonly secretBox: SecretBox | null,
    private readonly policy: () => Promise<EndpointPolicy>,
    private readonly storageRoot: string,
  ) {}

  activeRef(context: TenantContext): string {
    return context.storageIntegrationId ?? 'vds'
  }

  async store(context: TenantContext, storageRef: string): Promise<ObjectStore> {
    if (storageRef === 'vds') return new LocalObjectStore(localTenantStorageRoot(this.storageRoot, context.tenantKey))
    const cacheKey = `${context.tenantId}:${storageRef}`
    const cached = this.cache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) return cached.store
    if (!this.secretBox) throw new Error('INTEGRATION_SECRET_KEY is not configured; external storage is unavailable.')
    const row = (await this.registry.query<{ integration_id: string; kind: string; settings: unknown; secret_ciphertext: string }>(
      `select integration_id::text, kind, settings, secret_ciphertext
         from platform.tenant_integration
        where integration_id = $1 and tenant_id = $2 and kind = 'storage'`,
      [storageRef, context.tenantId],
    )).rows[0]
    if (!row) throw new Error('Storage backend for this object is not available.')
    const secret = JSON.parse(this.secretBox.open(row.secret_ciphertext, integrationSecretAad(context.tenantId, row.integration_id, row.kind)))
    const store = new S3ObjectStore(normalizeS3Settings(row.settings), normalizeS3Credentials(secret), await this.policy())
    this.cache.set(cacheKey, { expiresAt: Date.now() + 60_000, store })
    return store
  }
}
