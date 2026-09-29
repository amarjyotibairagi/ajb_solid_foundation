import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createTenantProvisioningJob,
  createTenantSchema,
  retryProvisioningJob,
  TenantProvisioningConflictError,
} from '../../backend/dist/tenant-provisioning.js'

function provisioningPool() {
  const reserved = new Set()
  let sequence = 0
  return {
    reserved,
    async connect() {
      return {
        async query(sql, values = []) {
          if (sql.includes('insert into platform.tenant_registry')) {
            sequence += 1
            return { rows: [{ tenant_id: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}` }] }
          }
          if (sql.includes('insert into platform.tenant_domain')) {
            const hostname = values[1]
            if (reserved.has(hostname)) throw Object.assign(new Error('unique violation'), { code: '23505' })
            reserved.add(hostname)
          }
          if (sql.includes('insert into platform.tenant_provisioning_job')) {
            return { rows: [{ job_id: `10000000-0000-4000-8000-${String(sequence).padStart(12, '0')}` }] }
          }
          return { rows: [] }
        },
        release() {},
      }
    },
  }
}

describe('Tenant Provisioning', () => {
  test('rejects reserved, Unicode, and malformed subdomains', () => {
    for (const subdomain of ['platform', 'acme.example', '-acme', 'acme-', 'acme_company', 'аcme']) {
      assert.equal(createTenantSchema.safeParse({ displayName: 'Acme', subdomain }).success, false)
    }
    assert.equal(createTenantSchema.safeParse({ displayName: 'Acme', subdomain: 'acme-01' }).success, true)
  })

  test('concurrent duplicate subdomain requests produce one owner', async () => {
    const pool = provisioningPool()
    const input = createTenantSchema.parse({ displayName: 'Concurrent Tenant', subdomain: 'concurrent-test' })
    const actor = '00000000-0000-4000-8000-000000000001'
    const results = await Promise.allSettled([
      createTenantProvisioningJob(pool, input, actor, 'sandbox.test'),
      createTenantProvisioningJob(pool, input, actor, 'sandbox.test'),
    ])

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    const rejected = results.find((result) => result.status === 'rejected')
    assert.ok(rejected.reason instanceof TenantProvisioningConflictError)
    assert.deepEqual([...pool.reserved], ['concurrent-test.sandbox.test'])
  })

  test('retry resumes the same job without creating tenant resources', async () => {
    const statements = []
    const pool = {
      async connect() {
        return {
          async query(sql) {
            statements.push(sql)
            if (sql.includes('retry_tenant_provisioning_job')) {
              return { rows: [{ retry_tenant_provisioning_job: true }] }
            }
            if (sql.includes('from platform.tenant_provisioning_job')) {
              return { rows: [{
                tenant_id: '00000000-0000-4000-8000-000000000101',
                correlation_id: '20000000-0000-4000-8000-000000000001',
              }] }
            }
            return { rows: [] }
          },
          release() {},
        }
      },
    }

    assert.equal(await retryProvisioningJob(pool, '30000000-0000-4000-8000-000000000001', 'actor'), true)
    assert.ok(statements.some((sql) => sql.includes("retry_tenant_provisioning_job") || sql.includes("set status = 'retrying'")))
    assert.ok(statements.every((sql) => !/create\s+(schema|role)/i.test(sql)))
    assert.ok(statements.every((sql) => !sql.includes('insert into platform.tenant_registry')))
  })
})
