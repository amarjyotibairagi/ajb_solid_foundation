import { useEffect, useState, type FormEvent } from 'react'

type Invitation = {
  kind: 'owner' | 'user'
  email: string | null
  displayName: string
  username: string | null
  requiresUsername: boolean
  expiresAt: string
  passwordMinLength: number
}

const box: React.CSSProperties = { width: 'min(440px, 100%)', background: '#fff', borderRadius: '12px', padding: '28px', boxShadow: '0 20px 40px rgba(15,23,42,0.18)', display: 'flex', flexDirection: 'column', gap: '14px' }
const input: React.CSSProperties = { width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid #cbd5e1', font: 'inherit', fontSize: '14px' }
const label: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', fontWeight: 600, color: '#475569' }
const notice = (tone: 'error' | 'success'): React.CSSProperties => ({
  padding: '10px 12px', borderRadius: '8px', fontSize: '13px',
  background: tone === 'error' ? '#fef2f2' : '#f0fdf4', color: tone === 'error' ? '#b91c1c' : '#166534',
  border: `1px solid ${tone === 'error' ? '#fecaca' : '#bbf7d0'}`,
})

// Redeems an owner (platform-issued) or user (tenant-issued) invitation on the
// tenant's own hostname. The token is read from the URL fragment, which is
// never sent to the server, and removed from the address bar immediately.
export default function AcceptInvite() {
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('token') || '')
  const [invitation, setInvitation] = useState<Invitation | null>(null)
  const [workspace, setWorkspace] = useState<{ name: string; color: string }>({ name: 'your workspace', color: '#2563eb' })
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    window.history.replaceState(null, '', window.location.pathname)
    fetch('/api/tenant/bootstrap', { credentials: 'include' })
      .then((response) => response.json())
      .then((data) => data?.tenant && setWorkspace({ name: data.tenant.displayName, color: data.tenant.branding?.primaryColor || '#2563eb' }))
      .catch(() => undefined)
    if (!token) {
      setError('This link is incomplete. Ask the person who invited you for a new one.')
      return
    }
    fetch('/api/auth/invitations/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ token }),
    })
      .then(async (response) => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.message)
        setInvitation(data.invitation)
      })
      .catch((caught: Error) => setError(caught.message || 'This invitation could not be loaded.'))
  }, [token])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const password = String(form.get('password'))
    if (password !== String(form.get('confirm'))) {
      setError('The passwords do not match.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/auth/invitations/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ token, password, ...(invitation?.requiresUsername ? { username: String(form.get('username')) } : {}) }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.message)
      setDone(data.message)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The invitation could not be accepted.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-page-bg" style={{ display: 'grid', placeItems: 'center', padding: '24px' }}>
      <div style={box}>
        <h1 style={{ fontSize: '20px', margin: 0 }}>Join {workspace.name}</h1>
        {invitation && !done && (
          <p style={{ margin: 0, fontSize: '13px', color: '#64748b' }}>
            {invitation.kind === 'owner' ? 'You have been invited as the workspace owner. ' : `Welcome, ${invitation.displayName}. `}
            This link expires {new Date(invitation.expiresAt).toLocaleString()}.
          </p>
        )}
        {error && <div role="alert" style={notice('error')}>{error}</div>}
        {done ? (
          <>
            <div style={notice('success')}>{done}</div>
            <a href="/" style={{ textAlign: 'center', padding: '10px', borderRadius: '8px', background: workspace.color, color: '#fff', fontWeight: 600, textDecoration: 'none' }}>Go to sign in</a>
          </>
        ) : invitation ? (
          <form onSubmit={(event) => void submit(event)} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {invitation.requiresUsername ? (
              <label style={label}>
                Choose a username
                <input style={input} name="username" required minLength={3} maxLength={64} pattern="[A-Za-z0-9._\-]{3,64}" autoComplete="username" defaultValue={invitation.email?.split('@')[0] ?? ''} />
              </label>
            ) : (
              <label style={label}>
                Username
                <input style={{ ...input, background: '#f8fafc' }} value={invitation.username ?? ''} readOnly autoComplete="username" />
              </label>
            )}
            <label style={label}>
              New password
              <input style={input} name="password" type="password" required minLength={invitation.passwordMinLength} autoComplete="new-password" />
              <span style={{ fontWeight: 400, color: '#64748b' }}>At least {invitation.passwordMinLength} characters.</span>
            </label>
            <label style={label}>
              Confirm password
              <input style={input} name="confirm" type="password" required autoComplete="new-password" />
            </label>
            <button disabled={busy} style={{ padding: '10px', border: 0, borderRadius: '8px', background: workspace.color, color: '#fff', fontWeight: 600, cursor: busy ? 'wait' : 'pointer' }}>
              {busy ? 'Setting up…' : 'Create my account'}
            </button>
          </form>
        ) : null}
      </div>
    </div>
  )
}
