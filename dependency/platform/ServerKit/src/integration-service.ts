import crypto from 'node:crypto'
import {
  integrationFingerprint,
  IntegrationValidationError,
  normalizeIntegration,
  testPostgresIntegration,
  testS3Integration,
  type IntegrationProvider,
  type PostgresCredentials,
  type PostgresSettings,
  type TestReport,
} from './integrations.js'
import type { EndpointPolicy } from './network.js'
import { operationSteps, type OperationType } from './operations.js'
import type { S3Credentials, S3Settings } from './s3.js'
import { integrationSecretAad, type SecretBox } from './secrets.js'
import type { Queryable } from './shared-state.js'

/**
 * Bring-your-own integration workflow shared by the platform BFF (operators)
 * and the tenant BFF (tenant owners). Both call the same SECURITY DEFINER
 * functions (migration 029); only the caller identity and actor label differ.
 *
 * Lifecycle: save (draft) -> test (verified | failed) -> activate.
 *   storage:  activation switches where new files are written, immediately.
 *   database: activation enqueues a relocate_database job (maintenance window).
 */

export class IntegrationUnavailableError extends Error {}

export type IntegrationSummary = {
  integrationId: string
  kind: 'storage' | 'database'
  provider: IntegrationProvider
  displayName: string
  settings: Record<string, unknown>
  secretHint: string
  status: 'draft' | 'verified' | 'failed' | 'active' | 'retired'
  inUse: boolean
  lastTestAt: string | null
  lastTestOk: boolean | null
  lastTestReport: TestReport | null
  testCurrent: boolean
  createdBy: string
  createdAt: string
}

type Row = {
  integration_id: string
  tenant_id: string
  kind: 'storage' | 'database'
  provider: IntegrationProvider
  display_name: string
  settings: Record<string, unknown>
  secret_ciphertext: string
  settings_fingerprint: string
  status: IntegrationSummary['status']
  last_test_at: Date | null
  last_test_ok: boolean | null
  last_test_report: TestReport | null
  tested_fingerprint: string | null
  created_by: string
  created_at: Date
  in_use: boolean
}

function mask(value: string): string {
  return value.length <= 6 ? '••••' : `${value.slice(0, 4)}…${value.slice(-4)}`
}

export class IntegrationService {
  constructor(
    private readonly db: Queryable,
    private readonly box: SecretBox | null,
  ) {}

  get available(): boolean {
    return this.box !== null
  }

  private secretBox(): SecretBox {
    if (!this.box) {
      throw new IntegrationUnavailableError('Tenant integrations are not configured on this server (INTEGRATION_SECRET_KEY is missing).')
    }
    return this.box
  }

  async policy(): Promise<EndpointPolicy> {
    const values = (await this.db.query('select platform.resolve_platform_config() as config')).rows[0]?.config ?? {}
    return {
      allowPrivateEndpoints: values['integration.allow_private_endpoints'] === true,
      allowInsecureTransport: values['integration.allow_insecure_transport'] === true,
    }
  }

  private async rows(tenantId: string, integrationId?: string): Promise<Row[]> {
    const result = await this.db.query(
      `select i.integration_id::text, i.tenant_id::text, i.kind, i.provider, i.display_name, i.settings,
              i.secret_ciphertext, i.settings_fingerprint, i.status, i.last_test_at, i.last_test_ok,
              i.last_test_report, i.tested_fingerprint, i.created_by, i.created_at,
              (r.storage_integration_id = i.integration_id or r.data_integration_id = i.integration_id) as in_use
         from platform.tenant_integration i
         join platform.tenant_registry r on r.tenant_id = i.tenant_id
        where i.tenant_id = $1 and ($2::uuid is null or i.integration_id = $2::uuid)
        order by i.created_at desc`,
      [tenantId, integrationId ?? null],
    )
    return result.rows as Row[]
  }

  private async row(tenantId: string, integrationId: string): Promise<Row> {
    const found = (await this.rows(tenantId, integrationId))[0]
    if (!found) throw new IntegrationValidationError('Integration not found.')
    return found
  }

  private decrypt(row: Row): unknown {
    return JSON.parse(this.secretBox().open(row.secret_ciphertext, integrationSecretAad(row.tenant_id, row.integration_id, row.kind)))
  }

  private summarize(row: Row): IntegrationSummary {
    let secretHint = 'stored'
    try {
      const secret = this.box ? (this.decrypt(row) as Record<string, string>) : null
      if (secret) secretHint = row.provider === 's3' ? `key ${mask(secret.accessKeyId || '')}` : `user ${secret.user}`
    } catch {
      secretHint = 'unreadable (key changed?)'
    }
    return {
      integrationId: row.integration_id,
      kind: row.kind,
      provider: row.provider,
      displayName: row.display_name,
      settings: row.settings,
      secretHint,
      status: row.status,
      inUse: row.in_use === true,
      lastTestAt: row.last_test_at ? new Date(row.last_test_at).toISOString() : null,
      lastTestOk: row.last_test_ok,
      lastTestReport: row.last_test_report,
      testCurrent:
        row.last_test_ok === true &&
        row.tested_fingerprint === row.settings_fingerprint &&
        !!row.last_test_at &&
        Date.now() - new Date(row.last_test_at).getTime() < 30 * 60_000,
      createdBy: row.created_by,
      createdAt: new Date(row.created_at).toISOString(),
    }
  }

  async list(tenantId: string): Promise<IntegrationSummary[]> {
    return (await this.rows(tenantId)).map((row) => this.summarize(row))
  }

  async save(
    tenantId: string,
    input: { integrationId?: string; provider: IntegrationProvider; displayName: string; settings: unknown; secret?: unknown },
    actor: string,
  ): Promise<IntegrationSummary> {
    const box = this.secretBox()
    const displayName = String(input.displayName || '').trim()
    if (!displayName || displayName.length > 120) throw new IntegrationValidationError('Name must be 1-120 characters.')
    const normalized = normalizeIntegration(input.provider, input.settings, input.secret)
    const integrationId = input.integrationId ?? crypto.randomUUID()
    let secret = normalized.secret
    if (!secret) {
      if (!input.integrationId) throw new IntegrationValidationError('Credentials are required.')
      secret = this.decrypt(await this.row(tenantId, input.integrationId)) as typeof secret
    }
    const fingerprint = integrationFingerprint(input.provider, normalized.settings, secret)
    const ciphertext = normalized.secret
      ? box.seal(JSON.stringify(normalized.secret), integrationSecretAad(tenantId, integrationId, normalized.kind))
      : null
    await this.db.query('select platform.save_tenant_integration($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)', [
      tenantId, integrationId, normalized.kind, input.provider, displayName, JSON.stringify(normalized.settings), ciphertext, fingerprint, actor,
    ])
    return this.summarize(await this.row(tenantId, integrationId))
  }

  /** Runs the non-destructive connection test and records the outcome. */
  async test(tenantId: string, integrationId: string, actor: string): Promise<TestReport> {
    const row = await this.row(tenantId, integrationId)
    if (row.status === 'retired') throw new IntegrationValidationError('Retired integrations cannot be tested.')
    const secret = this.decrypt(row)
    const policy = await this.policy()
    const report =
      row.provider === 's3'
        ? await testS3Integration(row.settings as unknown as S3Settings, secret as S3Credentials, policy)
        : await testPostgresIntegration(row.settings as unknown as PostgresSettings, secret as PostgresCredentials, policy, tenantId)
    await this.db.query('select platform.record_tenant_integration_test($1, $2, $3, $4, $5::jsonb, $6)', [
      tenantId, integrationId, row.settings_fingerprint, report.ok, JSON.stringify(report), actor,
    ])
    return report
  }

  /** Switches where new files are written. null = back to the VDS. */
  async activateStorage(tenantId: string, integrationId: string | null, actor: string): Promise<void> {
    if (integrationId) {
      const row = await this.row(tenantId, integrationId)
      if (row.kind !== 'storage') throw new IntegrationValidationError('That integration is not storage.')
    }
    await this.db.query('select platform.activate_tenant_storage($1, $2, $3)', [tenantId, integrationId, actor])
  }

  async retire(tenantId: string, integrationId: string, actor: string): Promise<boolean> {
    const result = await this.db.query('select platform.retire_tenant_integration($1, $2, $3) as ok', [tenantId, integrationId, actor])
    return result.rows[0]?.ok === true
  }

  /** Enqueues a worker operation; returns the job id. */
  async enqueue(
    tenantKey: string,
    type: OperationType,
    params: Record<string, unknown>,
    actorUserId: string | null,
    actorLabel: string,
  ): Promise<string> {
    const result = await this.db.query('select platform.enqueue_tenant_operation($1, $2, $3::jsonb, $4::jsonb, $5, $6)::text as job_id', [
      tenantKey, type, JSON.stringify(params), JSON.stringify(operationSteps[type]), actorUserId, actorLabel,
    ])
    return result.rows[0].job_id as string
  }

  async requestDatabaseMove(
    tenantKey: string,
    tenantId: string,
    integrationId: string | null,
    actorUserId: string | null,
    actorLabel: string,
  ): Promise<string> {
    if (integrationId) {
      const row = await this.row(tenantId, integrationId)
      if (row.kind !== 'database') throw new IntegrationValidationError('That integration is not a database.')
      if (!this.summarize(row).testCurrent) {
        throw new IntegrationValidationError('Run a successful connection test (within 30 minutes, with the current settings) first.')
      }
    }
    return this.enqueue(tenantKey, 'relocate_database', { targetIntegrationId: integrationId }, actorUserId, actorLabel)
  }
}
