import { useEffect, useState, type FormEvent } from 'react'

type Step = { step: string; ok: boolean; detail: string; durationMs: number }
type Integration = {
  integrationId: string
  kind: 'storage' | 'database'
  provider: 's3' | 'postgresql'
  displayName: string
  settings: Record<string, unknown>
  secretHint: string
  status: string
  inUse: boolean
  testCurrent: boolean
  lastTestReport: { ok: boolean; steps: Step[] } | null
}
type State = { available: boolean; features: { storage: boolean; database: boolean }; active: { storage: string | null; database: string | null }; integrations: Integration[] }
type Job = { status: string; errorMessage: string | null; steps: Array<{ code: string; message: string; status: string }> }

const card: React.CSSProperties = { background: '#fff', padding: '24px', borderRadius: '8px', border: '1px solid #e2e8f0', marginTop: '20px' }
const input: React.CSSProperties = { width: '100%', padding: '8px 10px', marginTop: '4px', borderRadius: '6px', border: '1px solid #cbd5e1', font: 'inherit', fontSize: '13px' }
const label: React.CSSProperties = { display: 'block', fontSize: '12px', fontWeight: 600, color: '#475569' }
const button: React.CSSProperties = { padding: '7px 12px', border: '1px solid #cbd5e1', borderRadius: '6px', background: '#fff', cursor: 'pointer', fontSize: '13px' }

/**
 * Owner-only: connect the workspace to its own S3-compatible bucket and/or
 * PostgreSQL database. Every connection is tested without side effects
 * before it can be used.
 */
export function IntegrationsSettings({ csrfToken, accent }: { csrfToken: string | null; accent: string }) {
  const [state, setState] = useState<State | null>(null)
  const [denied, setDenied] = useState<string | null>(null)
  const [form, setForm] = useState<'s3' | 'postgresql' | null>(null)
  const [report, setReport] = useState<{ id: string; steps: Step[] } | null>(null)
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null)
  const [job, setJob] = useState<{ id: string; data: Job | null } | null>(null)
  const [busy, setBusy] = useState(false)

  const call = async (method: string, url: string, body?: unknown) => {
    const response = await fetch(url, {
      method,
      credentials: 'include',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const data = await response.json()
    if (!response.ok) throw Object.assign(new Error(data.message || 'Request failed.'), { status: response.status })
    return data
  }

  const load = async () => {
    try {
      setState(await call('GET', '/api/v1/integrations'))
    } catch (error) {
      setDenied((error as Error).message)
    }
  }
  useEffect(() => { void load() }, [])

  useEffect(() => {
    if (!job || (job.data && ['succeeded', 'failed'].includes(job.data.status))) return
    const timer = window.setTimeout(async () => {
      try {
        const data = await call('GET', `/api/v1/operations/${job.id}`)
        setJob({ id: job.id, data: data.job })
        if (['succeeded', 'failed'].includes(data.job.status)) void load()
      } catch {
        setJob({ ...job })
      }
    }, 1500)
    return () => window.clearTimeout(timer)
  }, [job])

  const run = async (action: () => Promise<string | void>) => {
    setBusy(true)
    setMessage(null)
    try {
      const text = await action()
      if (text) setMessage({ tone: 'success', text })
    } catch (error) {
      setMessage({ tone: 'error', text: (error as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const save = (provider: 's3' | 'postgresql') => (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const value = (name: string) => String(data.get(name) ?? '').trim()
    const payload =
      provider === 's3'
        ? {
            provider, displayName: value('displayName'),
            settings: { endpoint: value('endpoint'), region: value('region'), bucket: value('bucket'), prefix: value('prefix'), forcePathStyle: data.get('forcePathStyle') === 'on' },
            secret: { accessKeyId: value('accessKeyId'), secretAccessKey: value('secretAccessKey') },
          }
        : {
            provider, displayName: value('displayName'),
            settings: { host: value('host'), port: Number(value('port') || 5432), database: value('database'), schema: value('schema'), sslMode: value('sslMode') },
            secret: { user: value('user'), password: String(data.get('password') || '') },
          }
    void run(async () => {
      await call('POST', '/api/v1/integrations', payload)
      setForm(null)
      await load()
      return 'Saved. Now test the connection.'
    })
  }

  if (denied) return <div style={card}><h4 style={{ margin: '0 0 6px', fontSize: '15px' }}>Storage & database</h4><p style={{ fontSize: '13px', color: '#64748b', margin: 0 }}>{denied}</p></div>
  if (!state) return null

  const section = (kind: 'storage' | 'database') => {
    const provider = kind === 'storage' ? 's3' : 'postgresql'
    const enabled = kind === 'storage' ? state.features.storage : state.features.database
    const activeId = state.active[kind]
    const items = state.integrations.filter((item) => item.kind === kind && item.status !== 'retired')
    return (
      <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: '14px', marginTop: '14px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <strong style={{ fontSize: '14px' }}>{kind === 'storage' ? 'File storage' : 'Database'}: {activeId ? 'your own' : 'on the platform (default)'}</strong>
          <span style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {enabled && <button style={button} onClick={() => setForm(form === provider ? null : provider)}>Connect {kind === 'storage' ? 'a bucket' : 'a database'}</button>}
            {kind === 'storage' && activeId && <button style={button} onClick={() => void run(async () => (await call('POST', '/api/v1/integrations/storage/use-vds')).message)}>Use platform storage</button>}
            {kind === 'storage' && <button style={button} onClick={() => void run(async () => { const data = await call('POST', '/api/v1/integrations/storage/relocate'); setJob({ id: data.jobId, data: null }); return 'Moving existing files…' })}>Move existing files</button>}
            {kind === 'database' && activeId && <button style={button} onClick={() => { if (window.confirm('Move your data back to the platform? Your own database is left untouched.')) void run(async () => { const data = await call('POST', '/api/v1/integrations/database/use-vds'); setJob({ id: data.jobId, data: null }); return 'Moving data back…' }) }}>Move data back</button>}
          </span>
        </div>
        {!enabled && <p style={{ fontSize: '12.5px', color: '#64748b' }}>Not included in your plan.</p>}
        {form === provider && (
          <form onSubmit={save(provider)} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px', marginTop: '12px' }}>
            <label style={label}>Name<input style={input} name="displayName" required defaultValue={kind === 'storage' ? 'Our bucket' : 'Our database'} /></label>
            {provider === 's3' ? (
              <>
                <label style={label}>Endpoint<input style={input} name="endpoint" placeholder="https://s3.eu-central-1.amazonaws.com" /></label>
                <label style={label}>Region<input style={input} name="region" defaultValue="us-east-1" /></label>
                <label style={label}>Bucket<input style={input} name="bucket" required /></label>
                <label style={label}>Folder for the platform<input style={input} name="prefix" defaultValue="skeleton-platform/" /></label>
                <label style={label}>Access key ID<input style={input} name="accessKeyId" required autoComplete="off" /></label>
                <label style={label}>Secret access key<input style={input} name="secretAccessKey" type="password" required autoComplete="new-password" /></label>
                <label style={{ ...label, display: 'flex', gap: '6px', alignItems: 'center' }}><input type="checkbox" name="forcePathStyle" defaultChecked /> Path-style addressing</label>
              </>
            ) : (
              <>
                <label style={label}>Host<input style={input} name="host" required /></label>
                <label style={label}>Port<input style={input} name="port" type="number" defaultValue={5432} /></label>
                <label style={label}>Database<input style={input} name="database" required /></label>
                <label style={label}>Schema for the platform<input style={input} name="schema" defaultValue="skeleton_platform" /></label>
                <label style={label}>TLS<select style={input} name="sslMode" defaultValue="verify-full"><option value="verify-full">Verify certificate</option><option value="require">Encrypt only</option></select></label>
                <label style={label}>User<input style={input} name="user" required autoComplete="off" /></label>
                <label style={label}>Password<input style={input} name="password" type="password" required autoComplete="new-password" /></label>
              </>
            )}
            <div><button disabled={busy} style={{ ...button, background: accent, color: '#fff', border: 0 }}>Save</button></div>
          </form>
        )}
        {items.map((item) => (
          <div key={item.integrationId} style={{ marginTop: '10px', padding: '10px', border: '1px solid #e2e8f0', borderRadius: '6px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '13px' }}><strong>{item.displayName}</strong> · {item.status}{item.inUse ? ' · in use' : ''} · <span style={{ color: '#64748b' }}>{item.secretHint}</span></span>
              <span style={{ display: 'flex', gap: '6px' }}>
                <button style={button} disabled={busy} onClick={() => void run(async () => { const data = await call('POST', `/api/v1/integrations/${item.integrationId}/test`); setReport({ id: item.integrationId, steps: data.report.steps }); await load(); return data.report.ok ? 'Connection test passed.' : undefined })}>Test connection</button>
                {!item.inUse && enabled && (
                  <button
                    style={{ ...button, background: item.testCurrent ? accent : '#f1f5f9', color: item.testCurrent ? '#fff' : '#94a3b8', border: 0 }}
                    disabled={busy || !item.testCurrent}
                    title={item.testCurrent ? '' : 'Run a successful test first'}
                    onClick={() => {
                      const warning = item.kind === 'database'
                        ? 'Move all workspace data to this database? The workspace is unavailable during the copy.'
                        : 'Store new files in this bucket from now on?'
                      if (window.confirm(warning)) void run(async () => { const data = await call('POST', `/api/v1/integrations/${item.integrationId}/activate`); if (data.jobId) setJob({ id: data.jobId, data: null }); await load(); return data.message })
                    }}
                  >
                    {item.kind === 'database' ? 'Move data here' : 'Use this bucket'}
                  </button>
                )}
              </span>
            </div>
            {report?.id === item.integrationId && (
              <ol style={{ margin: '8px 0 0', paddingLeft: '18px', fontSize: '12.5px' }}>
                {report.steps.map((step) => <li key={step.step} style={{ color: step.ok ? '#166534' : '#b91c1c' }}>{step.ok ? '✓' : '✗'} {step.step}: {step.detail}</li>)}
              </ol>
            )}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div style={card}>
      <h4 style={{ margin: '0 0 4px', fontSize: '15px' }}>Storage & database</h4>
      <p style={{ margin: 0, fontSize: '12.5px', color: '#64748b' }}>
        By default your files and data are kept on the platform. You can bring your own S3-compatible bucket or PostgreSQL database; the platform works inside a dedicated folder (bucket prefix or schema) there.
      </p>
      {!state.available && <p style={{ fontSize: '13px', color: '#92400e' }}>Integrations are not enabled on this platform yet.</p>}
      {message && <div style={{ marginTop: '10px', fontSize: '13px', color: message.tone === 'error' ? '#b91c1c' : '#166534' }}>{message.text}</div>}
      {job?.data && (
        <div style={{ marginTop: '10px', padding: '10px', border: '1px solid #bfdbfe', borderRadius: '6px', fontSize: '12.5px' }}>
          <strong>{job.data.status === 'succeeded' ? 'Done' : job.data.status === 'failed' ? 'Stopped' : 'In progress'}</strong>
          <ol style={{ margin: '6px 0 0', paddingLeft: '18px' }}>{job.data.steps.map((step) => <li key={step.code}>{step.status === 'succeeded' ? '✓' : step.status === 'failed' ? '✗' : '·'} {step.message}</li>)}</ol>
          {job.data.errorMessage && <div style={{ color: '#b91c1c' }}>{job.data.errorMessage}</div>}
        </div>
      )}
      {section('storage')}
      {section('database')}
    </div>
  )
}
