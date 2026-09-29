import { useEffect, useState, type FormEvent } from 'react'
import type { AdminApi } from './api'
import { Badge, Card, formatDate, Notice, OneTimeLink, PageHeader, useAsyncAction } from './ui'

type Operator = {
  id: string
  username: string
  displayName: string | null
  email: string | null
  role: 'platform_owner' | 'platform_admin' | 'platform_viewer'
  isActive: boolean
  hasPassword: boolean
  mfaCredentials: number
  activeSessions: number
  pendingInvitationExpiresAt: string | null
  lastAuthenticatedAt: string | null
}

const roles = ['platform_owner', 'platform_admin', 'platform_viewer'] as const

export function OperatorsView({ api, currentUserId }: { api: AdminApi; currentUserId: string }) {
  const [operators, setOperators] = useState<Operator[]>([])
  const [issued, setIssued] = useState<{ username: string; link: string; delivered: boolean } | null>(null)
  const loader = useAsyncAction()
  const action = useAsyncAction()

  const load = () => loader.run(async () => setOperators((await api.get('/api/platform/users')).users))
  useEffect(() => { void load() }, [])

  const invite = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    void action.run(async () => {
      const username = String(form.get('username'))
      const result = await api.send('POST', '/api/platform/users', {
        username,
        displayName: form.get('displayName'),
        email: form.get('email') || '',
        role: form.get('role'),
      })
      setIssued({ username, link: result.invitation.link, delivered: result.invitation.delivered })
      formElement.reset()
      await load()
      return `Invitation created for ${username}.`
    })
  }

  const operate = (operator: Operator, path: string, body: unknown, done: string, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return
    void action.run(async () => {
      const result = await api.send('POST', `/api/platform/users/${operator.id}/${path}`, body)
      if (result.invitation) setIssued({ username: operator.username, link: result.invitation.link, delivered: false })
      await load()
      return done
    })
  }

  return (
    <div className="admin-view">
      <PageHeader eyebrow="Platform / Operators" title="Platform operators" subtitle="Invite operators, change roles, and recover access. All changes require a fresh security-key check." onRefresh={() => void load()} busy={loader.busy} />
      {loader.error && <Notice tone="error">{loader.error}</Notice>}
      {action.error && <Notice tone="error">{action.error}</Notice>}
      {action.message && <Notice tone="success">{action.message}</Notice>}
      <Card title="Invite an operator">
        <form className="admin-form admin-form-inline" onSubmit={invite}>
          <input className="admin-input" name="username" placeholder="username" required pattern="[a-z0-9][a-z0-9._\-]{2,63}" />
          <input className="admin-input" name="displayName" placeholder="Full name" required maxLength={255} />
          <input className="admin-input" name="email" type="email" placeholder="email (optional)" />
          <select className="admin-input" name="role" defaultValue="platform_viewer">{roles.map((role) => <option key={role} value={role}>{role}</option>)}</select>
          <button className="admin-button admin-button-primary" disabled={action.busy}>Create invitation</button>
        </form>
        {issued && <OneTimeLink label={`Set-password link for ${issued.username}`} link={issued.link} delivered={issued.delivered} />}
      </Card>
      <Card title="Operators">
        <table className="admin-table">
          <thead><tr><th>Operator</th><th>Role</th><th>State</th><th>Security keys</th><th>Last sign-in</th><th /></tr></thead>
          <tbody>
            {operators.map((operator) => {
              const self = operator.id === currentUserId
              return (
                <tr key={operator.id}>
                  <td><span className="admin-strong">{operator.displayName || operator.username}</span><div className="admin-hint">{operator.username}{operator.email ? ` · ${operator.email}` : ''}{self ? ' · you' : ''}</div></td>
                  <td>
                    <select
                      className="admin-input admin-select-inline"
                      value={operator.role}
                      disabled={self || action.busy}
                      onChange={(event) => operate(operator, 'role', { role: event.target.value }, 'Role changed; their sessions were ended.')}
                    >
                      {roles.map((role) => <option key={role} value={role}>{role}</option>)}
                    </select>
                  </td>
                  <td>
                    {operator.isActive ? <Badge tone="good">active</Badge> : operator.pendingInvitationExpiresAt ? <Badge tone="info">invited</Badge> : <Badge tone="warn">disabled</Badge>}
                    {operator.activeSessions > 0 && <div className="admin-hint">{operator.activeSessions} session(s)</div>}
                  </td>
                  <td>{operator.mfaCredentials > 0 ? <Badge tone="good">{operator.mfaCredentials} enrolled</Badge> : <Badge tone="warn">none</Badge>}</td>
                  <td>{formatDate(operator.lastAuthenticatedAt)}</td>
                  <td className="admin-row-actions">
                    {!self && (
                      <>
                        {operator.isActive ? (
                          <button className="admin-button" onClick={() => operate(operator, 'deactivate', undefined, 'Operator disabled.', `Disable ${operator.username}? Their sessions end immediately.`)}>Disable</button>
                        ) : operator.hasPassword ? (
                          <button className="admin-button" onClick={() => operate(operator, 'enable', undefined, 'Operator enabled.')}>Enable</button>
                        ) : null}
                        <button className="admin-button" onClick={() => operate(operator, 'invitation', undefined, 'New set-password link issued.', `Issue a new set-password link for ${operator.username}? Accepting it replaces their password and removes their security keys.`)}>Reset access</button>
                        <button className="admin-button" onClick={() => operate(operator, 'reset-mfa', undefined, 'Security keys removed; they must enrol again.', `Remove all security keys for ${operator.username}?`)}>Reset keys</button>
                        <button className="admin-button" onClick={() => operate(operator, 'revoke-sessions', undefined, 'Sessions ended.')}>End sessions</button>
                      </>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </Card>
    </div>
  )
}
