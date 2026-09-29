import { useEffect, useState } from 'react'
import type { AdminApi } from './api'
import { Badge, Card, formatDate, Notice, PageHeader, useAsyncAction } from './ui'

type Fleet = {
  latestSchemaVersion: number
  summary: { total: number; current: number; behind: number; failed: number }
  tenants: Array<{ tenantId: string; displayName: string; status: string; schemaVersion: number; lastErrorCode: string | null; lastErrorAt: string | null; planCode: string | null }>
  jobs30d: Array<{ status: string; jobType: string; count: number }>
}

export function FleetView({ api, onOpenTenant }: { api: AdminApi; onOpenTenant: (tenantKey: string) => void }) {
  const [fleet, setFleet] = useState<Fleet | null>(null)
  const loader = useAsyncAction()
  const action = useAsyncAction()
  const [queued, setQueued] = useState<Array<{ tenantId: string; jobId?: string; error?: string }>>([])
  const load = () => loader.run(async () => setFleet(await api.get('/api/fleet/status')))
  const upgradeAll = () => {
    if (!window.confirm('Queue a schema upgrade for every tenant that is behind or failed its last upgrade?')) return
    void action.run(async () => {
      const result = await api.send('POST', '/api/fleet/migrate')
      setQueued(result.jobs)
      window.setTimeout(() => void load(), 3000)
      return `${result.queued} upgrade(s) queued. The worker runs them one at a time.`
    })
  }
  useEffect(() => { void load() }, [])

  return (
    <div className="admin-view">
      <PageHeader eyebrow="Tenant / Fleet" title="Fleet health" subtitle="Schema versions, lifecycle failures and job outcomes across all tenants" onRefresh={() => void load()} busy={loader.busy} />
      {loader.error && <Notice tone="error">{loader.error}</Notice>}
      {fleet && (
        <>
          <div className="admin-stats">
            <div className="dynamic-card admin-stat"><span>Tenants</span><strong>{fleet.summary.total}</strong></div>
            <div className="dynamic-card admin-stat"><span>On schema v{fleet.latestSchemaVersion}</span><strong>{fleet.summary.current}</strong></div>
            <div className="dynamic-card admin-stat"><span>Behind</span><strong>{fleet.summary.behind}</strong></div>
            <div className="dynamic-card admin-stat"><span>Failed</span><strong>{fleet.summary.failed}</strong></div>
          </div>
          {action.error && <Notice tone="error">{action.error}</Notice>}
          {action.message && <Notice tone="success">{action.message}</Notice>}
          {(fleet.summary.behind > 0 || fleet.summary.failed > 0) && (
            <Notice tone="warning">
              {fleet.summary.behind} tenant(s) behind schema v{fleet.latestSchemaVersion}.{' '}
              <button className="admin-button admin-button-primary" disabled={action.busy} onClick={upgradeAll}>Upgrade all</button>
            </Notice>
          )}
          {queued.some((job) => job.error) && <Notice tone="error">{queued.filter((job) => job.error).map((job) => `${job.tenantId}: ${job.error}`).join(' · ')}</Notice>}
          <Card title="Tenants">
            <table className="admin-table">
              <thead><tr><th>Tenant</th><th>Status</th><th>Schema</th><th>Plan</th><th>Last error</th></tr></thead>
              <tbody>
                {fleet.tenants.map((tenant) => (
                  <tr key={tenant.tenantId} className="admin-row-link" onClick={() => onOpenTenant(tenant.tenantId)}>
                    <td><span className="admin-strong">{tenant.displayName}</span><div className="admin-hint"><code>{tenant.tenantId}</code></div></td>
                    <td><Badge tone={tenant.status === 'active' ? 'good' : /fail/.test(tenant.status) ? 'bad' : 'warn'}>{tenant.status}</Badge></td>
                    <td>v{tenant.schemaVersion} {tenant.schemaVersion < fleet.latestSchemaVersion && <Badge tone="warn">behind</Badge>}</td>
                    <td>{tenant.planCode ?? <span className="admin-muted">none</span>}</td>
                    <td>{tenant.lastErrorCode ? <><Badge tone="bad">{tenant.lastErrorCode}</Badge> {formatDate(tenant.lastErrorAt)}</> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card title="Jobs in the last 30 days">
            <table className="admin-table">
              <thead><tr><th>Type</th><th>Status</th><th>Count</th></tr></thead>
              <tbody>{fleet.jobs30d.map((row) => <tr key={`${row.jobType}-${row.status}`}><td>{row.jobType}</td><td>{row.status}</td><td>{row.count}</td></tr>)}</tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  )
}
