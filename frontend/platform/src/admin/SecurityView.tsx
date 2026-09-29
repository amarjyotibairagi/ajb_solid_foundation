import type { AdminApi } from './api'
import { Card, Notice, PageHeader, useAsyncAction } from './ui'
import { webAuthnSupported } from './webauthn'

export function SecurityView({ api, mfaRecent }: { api: AdminApi; mfaRecent: boolean }) {
  const action = useAsyncAction()
  const supported = webAuthnSupported()
  return (
    <div className="admin-view">
      <PageHeader eyebrow="Platform / My security" title="Security keys" subtitle="Changes in this console require a security-key check in the last five minutes" />
      {!supported && <Notice tone="error">This browser does not support security keys (WebAuthn). Use a current browser to make changes.</Notice>}
      {action.error && <Notice tone="error">{action.error}</Notice>}
      {action.message && <Notice tone="success">{action.message}</Notice>}
      <Card title="Step-up status">
        <p className="admin-hint">
          {mfaRecent ? 'You verified with a security key recently.' : 'You have not verified with a security key in this session yet.'} You will be prompted automatically when an action needs it.
        </p>
        <div className="admin-form-inline">
          <button className="admin-button admin-button-primary" disabled={!supported || action.busy} onClick={() => void action.run(async () => { await api.stepUp(); return 'Verified. Changes are unlocked for five minutes.' })}>Verify now</button>
          <button className="admin-button" disabled={!supported || action.busy} onClick={() => void action.run(async () => { await api.registerSecurityKey(); return 'Security key added.' })}>Add another security key</button>
        </div>
      </Card>
      <Notice>Lost every key? Another platform owner can reset your keys from Operators, or use <code>scripts/platform-operator.mjs</code> on the host.</Notice>
    </div>
  )
}
