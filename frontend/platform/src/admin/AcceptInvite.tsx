import { useEffect, useState, type FormEvent } from 'react'

type Invitation = { username: string; displayName: string; role: string; expiresAt: string; passwordMinLength: number }

// Standalone page for /accept-invite. The token arrives in the URL fragment,
// which the browser never sends to the server; it is read here and removed
// from the address bar before anything else happens.
export default function AcceptInvite() {
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('token') || '')
  const [invitation, setInvitation] = useState<Invitation | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    window.history.replaceState(null, '', window.location.pathname)
    if (!token) {
      setError('This link is incomplete. Ask the person who invited you for a new one.')
      return
    }
    fetch('/api/auth/invitations/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
        body: JSON.stringify({ token, password }),
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
    <main className="admin-accept">
      <div className="dynamic-card admin-accept-card">
        <h1 className="admin-title">Set up your operator account</h1>
        {invitation && !done && (
          <p className="admin-hint">
            Signing in as <strong>{invitation.username}</strong> ({invitation.role.replace('platform_', '')}). This link expires {new Date(invitation.expiresAt).toLocaleString()}.
          </p>
        )}
        {error && <div className="admin-notice admin-notice-error" role="alert">{error}</div>}
        {done ? (
          <>
            <div className="admin-notice admin-notice-success">{done}</div>
            <a className="admin-button admin-button-primary" href="/">Go to sign in</a>
          </>
        ) : invitation ? (
          <form className="admin-form" onSubmit={(event) => void submit(event)}>
            <label className="admin-field">
              <span className="admin-field-label">New password</span>
              <input className="admin-input" name="password" type="password" autoComplete="new-password" minLength={invitation.passwordMinLength} required />
              <span className="admin-hint">At least {invitation.passwordMinLength} characters. A passphrase works well.</span>
            </label>
            <label className="admin-field">
              <span className="admin-field-label">Confirm password</span>
              <input className="admin-input" name="confirm" type="password" autoComplete="new-password" required />
            </label>
            <button className="admin-button admin-button-primary" disabled={busy}>{busy ? 'Saving…' : 'Set password'}</button>
          </form>
        ) : null}
      </div>
    </main>
  )
}
