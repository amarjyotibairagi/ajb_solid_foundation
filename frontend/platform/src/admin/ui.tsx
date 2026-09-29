import { useState, type ReactNode } from 'react'
import { Check, Copy, RefreshCw } from 'lucide-react'

export function PageHeader({ eyebrow, title, subtitle, onRefresh, busy, actions }: {
  eyebrow: string
  title: string
  subtitle?: string
  onRefresh?: () => void
  busy?: boolean
  actions?: ReactNode
}) {
  return (
    <div className="admin-header">
      <div>
        <div className="admin-eyebrow">{eyebrow}</div>
        <h1 className="admin-title">{title}</h1>
        {subtitle && <div className="admin-subtitle">{subtitle}</div>}
      </div>
      <div className="admin-actions">
        {actions}
        {onRefresh && (
          <button className="admin-button" onClick={onRefresh} disabled={busy}>
            <RefreshCw size={14} className={busy ? 'admin-spin' : undefined} />
            <span>Refresh</span>
          </button>
        )}
      </div>
    </div>
  )
}

export function Card({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="dynamic-card admin-card">
      {(title || actions) && (
        <div className="admin-card-head">
          {title && <h2>{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  )
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'error' | 'success' | 'warning'; children: ReactNode }) {
  return <div className={`admin-notice admin-notice-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>{children}</div>
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info'; children: ReactNode }) {
  return <span className={`admin-badge admin-badge-${tone}`}>{children}</span>
}

/** Displays a secret link that cannot be retrieved again, with a copy button. */
export function OneTimeLink({ label, link, delivered }: { label: string; link: string; delivered?: boolean }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="admin-onetime">
      <div className="admin-onetime-label">
        {label}
        {delivered ? <Badge tone="good">Sent</Badge> : <Badge tone="warn">Not sent — share it securely</Badge>}
      </div>
      <div className="admin-onetime-row">
        <code className="admin-onetime-link">{link}</code>
        <button
          className="admin-button"
          onClick={() => {
            void navigator.clipboard.writeText(link).then(() => {
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1500)
            })
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <div className="admin-hint">Shown once. The platform stores only a hash of this link; reissue it if it is lost.</div>
    </div>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="admin-field">
      <span className="admin-field-label">{label}</span>
      {children}
      {hint && <span className="admin-hint">{hint}</span>}
    </label>
  )
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

export function useAsyncAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const run = async (action: () => Promise<string | void>) => {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const result = await action()
      if (result) setMessage(result)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The action failed.')
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, message, run, setError, setMessage }
}
