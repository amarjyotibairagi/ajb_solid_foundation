import { useEffect, useState, type FormEvent } from 'react'
import type { AdminApi } from './api'
import { Badge, Card, formatDate, Notice, PageHeader, useAsyncAction } from './ui'

type Consumer = {
  userId: string
  username: string
  displayName: string
  email: string | null
  status: string
  planCode: string | null
  subscriptionStatus: string | null
  createdAt: string
  activeSessions: number
}

type Detail = {
  user: { userId: string; username: string; displayName: string; email: string | null; status: string; createdAt: string }
  subscriptions: Array<{ planCode: string; status: string; periodStart: string | null; periodEnd: string | null }>
  projects: number
  groups: number
  activeSessions: number
  recentEvents: Array<{ action: string; outcome: string; occurred_at: string }>
}

const pageSize = 50

export function ConsumersView({ api }: { api: AdminApi }) {
  const [users, setUsers] = useState<Consumer[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [filters, setFilters] = useState({ search: '', status: '', plan: '' })
  const [stats, setStats] = useState<{ total: number; byStatus: Record<string, number>; byPlan: Record<string, number>; activeSessions: number } | null>(null)
  const [plans, setPlans] = useState<Array<{ planCode: string; displayName: string; audience: string; isActive: boolean }>>([])
  const [selected, setSelected] = useState<Detail | null>(null)
  const loader = useAsyncAction()
  const action = useAsyncAction()

  const load = (next = filters, nextOffset = offset) =>
    loader.run(async () => {
      const params = new URLSearchParams({ limit: String(pageSize), offset: String(nextOffset) })
      for (const [key, value] of Object.entries(next)) if (value) params.set(key, value)
      const [list, summary, planList] = await Promise.all([api.get(`/api/consumers?${params}`), api.get('/api/consumers/stats'), api.get('/api/plans')])
      setUsers(list.users)
      setTotal(list.total)
      setStats(summary.stats)
      setPlans(planList.plans.filter((plan: { audience: string; isActive: boolean }) => plan.isActive && plan.audience !== 'b2b'))
    })
  useEffect(() => { void load() }, [])

  const open = (userId: string) => void action.run(async () => { setSelected(await api.get(`/api/consumers/${userId}`)) })

  const act = (userId: string, path: string, body?: unknown, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return
    void action.run(async () => {
      await (body === undefined ? api.send('POST', `/api/consumers/${userId}/${path}`) : api.send('PUT', `/api/consumers/${userId}/${path}`, body))
      await load()
      setSelected(await api.get(`/api/consumers/${userId}`))
      return 'Done.'
    })
  }

  const applyFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const next = { search: String(form.get('search') || ''), status: String(form.get('status') || ''), plan: String(form.get('plan') || '') }
    setFilters(next)
    setOffset(0)
    void load(next, 0)
  }

  return (
    <div className="admin-view">
      <PageHeader eyebrow="Platform / Individuals" title="Individual users (B2C)" subtitle="Accounts on the public app: status, sessions and plans" onRefresh={() => void load()} busy={loader.busy} />
      {loader.error && <Notice tone="error">{loader.error}</Notice>}
      {action.error && <Notice tone="error">{action.error}</Notice>}
      {stats && (
        <div className="admin-stats">
          <div className="dynamic-card admin-stat"><span>Accounts</span><strong>{stats.total}</strong></div>
          <div className="dynamic-card admin-stat"><span>Active</span><strong>{stats.byStatus.active ?? 0}</strong></div>
          <div className="dynamic-card admin-stat"><span>Suspended</span><strong>{stats.byStatus.suspended ?? 0}</strong></div>
          <div className="dynamic-card admin-stat"><span>Signed in now</span><strong>{stats.activeSessions}</strong></div>
        </div>
      )}
      <Card>
        <form className="admin-form admin-form-inline" onSubmit={applyFilters}>
          <input className="admin-input" name="search" placeholder="Search name, username or email" defaultValue={filters.search} />
          <select className="admin-input" name="status" defaultValue={filters.status}><option value="">Any status</option><option>active</option><option>suspended</option><option>pending</option></select>
          <select className="admin-input" name="plan" defaultValue={filters.plan}><option value="">Any plan</option>{plans.map((plan) => <option key={plan.planCode} value={plan.planCode}>{plan.displayName}</option>)}</select>
          <button className="admin-button admin-button-primary">Filter</button>
        </form>
      </Card>
      <div className="admin-grid">
        <Card title={`${total} account(s)`}>
          <table className="admin-table">
            <thead><tr><th>User</th><th>Status</th><th>Plan</th><th>Sessions</th></tr></thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.userId} className={selected?.user.userId === user.userId ? 'admin-row-selected' : 'admin-row-link'} onClick={() => open(user.userId)}>
                  <td><span className="admin-strong">{user.displayName}</span><div className="admin-hint">{user.username}{user.email ? ` · ${user.email}` : ''}</div></td>
                  <td><Badge tone={user.status === 'active' ? 'good' : user.status === 'suspended' ? 'warn' : 'neutral'}>{user.status}</Badge></td>
                  <td>{user.planCode ?? <span className="admin-muted">none</span>}</td>
                  <td>{user.activeSessions}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="admin-form-inline">
            <button className="admin-button" disabled={offset === 0} onClick={() => { const next = Math.max(0, offset - pageSize); setOffset(next); void load(filters, next) }}>Previous</button>
            <span className="admin-hint">{total ? `${offset + 1}–${Math.min(offset + pageSize, total)} of ${total}` : ''}</span>
            <button className="admin-button" disabled={offset + pageSize >= total} onClick={() => { const next = offset + pageSize; setOffset(next); void load(filters, next) }}>Next</button>
          </div>
        </Card>
        {selected && (
          <Card title={selected.user.displayName}>
            <dl className="admin-dl">
              <dt>Username</dt><dd>{selected.user.username}</dd>
              <dt>Email</dt><dd>{selected.user.email ?? '—'}</dd>
              <dt>Status</dt><dd><Badge tone={selected.user.status === 'active' ? 'good' : 'warn'}>{selected.user.status}</Badge></dd>
              <dt>Joined</dt><dd>{formatDate(selected.user.createdAt)}</dd>
              <dt>Projects / groups</dt><dd>{selected.projects} / {selected.groups}</dd>
              <dt>Active sessions</dt><dd>{selected.activeSessions}</dd>
              <dt>Plan</dt><dd>{selected.subscriptions.find((sub) => ['active', 'trialing', 'past_due', 'paused'].includes(sub.status))?.planCode ?? 'none'}</dd>
            </dl>
            <div className="admin-form-inline">
              {selected.user.status === 'active'
                ? <button className="admin-button" onClick={() => act(selected.user.userId, 'suspend', undefined, `Suspend ${selected.user.username}? Their sessions end immediately.`)}>Suspend</button>
                : <button className="admin-button" onClick={() => act(selected.user.userId, 'reactivate')}>Reactivate</button>}
              <button className="admin-button" onClick={() => act(selected.user.userId, 'revoke-sessions')}>End sessions</button>
              <select className="admin-input admin-select-inline" defaultValue="" onChange={(event) => { if (event.target.value) act(selected.user.userId, 'plan', { planCode: event.target.value, status: 'active' }, `Change plan to ${event.target.value}?`) }}>
                <option value="">Change plan…</option>
                {plans.map((plan) => <option key={plan.planCode} value={plan.planCode}>{plan.displayName}</option>)}
              </select>
            </div>
            {action.message && <Notice tone="success">{action.message}</Notice>}
            <h3 className="admin-subhead">Recent activity</h3>
            <table className="admin-table">
              <tbody>
                {selected.recentEvents.map((event, index) => (
                  <tr key={index}><td className="admin-mono">{formatDate(event.occurred_at)}</td><td><code>{event.action}</code></td><td><Badge tone={event.outcome === 'success' ? 'good' : 'bad'}>{event.outcome}</Badge></td></tr>
                ))}
                {!selected.recentEvents.length && <tr><td className="admin-muted">No events.</td></tr>}
              </tbody>
            </table>
          </Card>
        )}
      </div>
    </div>
  )
}
