import { useEffect, useState, type FormEvent } from 'react'
import type { AdminApi } from './api'
import { Badge, Card, Notice, PageHeader, useAsyncAction } from './ui'

type AuditEvent = {
  id: string
  timestamp: string
  username: string | null
  userId: string | null
  feature: string
  action: string
  status: string
  tenantKey: string | null
  resourceType: string | null
  resourceId: string | null
}

type Filters = { feature: string; action: string; status: string; tenantKey: string }
const emptyFilters: Filters = { feature: '', action: '', status: '', tenantKey: '' }

export function AuditView({ api }: { api: AdminApi }) {
  const [filters, setFilters] = useState<Filters>(emptyFilters)
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [features, setFeatures] = useState<string[]>([])
  const [nextBefore, setNextBefore] = useState<string | null>(null)
  const loader = useAsyncAction()

  const query = (active: Filters, before?: string) => {
    const params = new URLSearchParams({ limit: '100' })
    for (const [key, value] of Object.entries(active)) if (value) params.set(key, value)
    if (before) params.set('before', before)
    return `/api/audit/events?${params}`
  }

  const load = (active = filters, before?: string) =>
    loader.run(async () => {
      const data = await api.get(query(active, before))
      setEvents((current) => (before ? [...current, ...data.events] : data.events))
      setNextBefore(data.nextBefore)
      setFeatures(data.features)
    })
  useEffect(() => { void load() }, [])

  const apply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const next = Object.fromEntries(Object.keys(emptyFilters).map((key) => [key, String(form.get(key) || '').trim()])) as Filters
    setFilters(next)
    void load(next)
  }

  return (
    <div className="admin-view">
      <PageHeader eyebrow="Platform / Audit" title="Security audit trail" subtitle="Every control-plane action, append-only" onRefresh={() => void load()} busy={loader.busy} />
      {loader.error && <Notice tone="error">{loader.error}</Notice>}
      <Card>
        <form className="admin-form admin-form-inline" onSubmit={apply}>
          <select className="admin-input" name="feature" defaultValue=""><option value="">All areas</option>{features.map((feature) => <option key={feature}>{feature}</option>)}</select>
          <input className="admin-input" name="action" placeholder="Action starts with…" />
          <select className="admin-input" name="status" defaultValue=""><option value="">Any outcome</option><option>SUCCESS</option><option>FAILED</option><option>DENIED</option></select>
          <input className="admin-input" name="tenantKey" placeholder="Tenant key (T…)" />
          <button className="admin-button admin-button-primary">Filter</button>
        </form>
      </Card>
      <Card>
        <table className="admin-table">
          <thead><tr><th>Time</th><th>Operator</th><th>Area</th><th>Action</th><th>Tenant</th><th>Resource</th><th>Outcome</th></tr></thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td className="admin-mono">{new Date(event.timestamp).toISOString().replace('T', ' ').slice(0, 19)}</td>
                <td>{event.username || (event.userId ? event.userId.slice(0, 8) : <span className="admin-muted">system</span>)}</td>
                <td>{event.feature}</td>
                <td><code>{event.action}</code></td>
                <td>{event.tenantKey ? <code>{event.tenantKey}</code> : '—'}</td>
                <td className="admin-hint">{event.resourceType ? `${event.resourceType}${event.resourceId ? `: ${event.resourceId}` : ''}` : '—'}</td>
                <td><Badge tone={event.status === 'SUCCESS' ? 'good' : 'bad'}>{event.status}</Badge></td>
              </tr>
            ))}
            {!events.length && !loader.busy && <tr><td colSpan={7} className="admin-muted">No matching events.</td></tr>}
          </tbody>
        </table>
        {nextBefore && <button className="admin-button" disabled={loader.busy} onClick={() => void load(filters, nextBefore)}>Load older events</button>}
      </Card>
    </div>
  )
}
