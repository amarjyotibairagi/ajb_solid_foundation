import { useEffect, useState } from 'react'

type Setting = {
  key: string
  kind: 'feature' | 'limit' | 'setting'
  valueType: 'boolean' | 'integer' | 'string' | 'string_list'
  value: unknown
  source: string
  editable: boolean
  min: number | null
  max: number | null
  maxLength: number | null
}

const sourceLabel: Record<string, string> = {
  default: 'Platform default',
  platform: 'Platform',
  plan: 'Your plan',
  tenant: 'Set for this workspace by the platform',
  tenant_local: 'Set by your administrators',
}

function show(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'On' : 'Off'
  if (Array.isArray(value)) return value.join(', ')
  return value === '' || value === undefined ? '—' : String(value)
}

/**
 * Effective configuration for this workspace. Keys the platform marks
 * tenant-editable can be changed here; everything else is read-only and
 * controlled from the platform admin panel or the workspace's plan.
 */
export function WorkspaceSettings({ csrfToken, accent }: { csrfToken: string | null; accent: string }) {
  const [settings, setSettings] = useState<Setting[] | null>(null)
  const [planCode, setPlanCode] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null)

  const load = async () => {
    const response = await fetch('/api/v1/settings', { credentials: 'include' })
    const data = await response.json()
    if (!response.ok) {
      setMessage({ tone: 'error', text: data.message || 'Settings are unavailable.' })
      return
    }
    setSettings(data.settings)
    setPlanCode(data.planCode)
  }
  useEffect(() => { void load() }, [])

  const request = async (method: 'PUT' | 'DELETE', key: string, body?: unknown) => {
    const response = await fetch(`/api/v1/settings/${encodeURIComponent(key)}`, {
      method,
      credentials: 'include',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.message || 'The change was not saved.')
  }

  const save = async (setting: Setting) => {
    try {
      const value = setting.valueType === 'boolean' ? draft === 'true' : setting.valueType === 'integer' ? Number(draft) : draft
      await request('PUT', setting.key, { value })
      setEditing(null)
      setMessage({ tone: 'success', text: 'Saved.' })
      await load()
    } catch (error) {
      setMessage({ tone: 'error', text: (error as Error).message })
    }
  }

  const reset = async (setting: Setting) => {
    try {
      await request('DELETE', setting.key)
      setMessage({ tone: 'success', text: 'Reset to the inherited value.' })
      await load()
    } catch (error) {
      setMessage({ tone: 'error', text: (error as Error).message })
    }
  }

  if (!settings) return message ? <div style={{ color: '#b91c1c', fontSize: '13px' }}>{message.text}</div> : null
  return (
    <div style={{ background: '#fff', padding: '24px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
      <h4 style={{ margin: '0 0 4px 0', fontSize: '15px' }}>Features, limits & policies</h4>
      <p style={{ margin: '0 0 16px', fontSize: '12.5px', color: '#64748b' }}>
        Plan: <strong>{planCode ?? 'none'}</strong>. Values marked editable can be changed by workspace administrators; the rest are managed by the platform.
      </p>
      {message && <div style={{ marginBottom: '12px', fontSize: '13px', color: message.tone === 'error' ? '#b91c1c' : '#166534' }}>{message.text}</div>}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
        <tbody>
          {settings.map((setting) => (
            <tr key={setting.key} style={{ borderTop: '1px solid #f1f5f9' }}>
              <td style={{ padding: '10px 0' }}>
                <div style={{ fontWeight: 600 }}><code>{setting.key}</code></div>
                <div style={{ fontSize: '12px', color: '#64748b' }}>{sourceLabel[setting.source] ?? setting.source}</div>
              </td>
              <td style={{ padding: '10px', textAlign: 'right' }}>
                {editing === setting.key ? (
                  setting.valueType === 'boolean' ? (
                    <select value={draft} onChange={(event) => setDraft(event.target.value)}><option value="true">On</option><option value="false">Off</option></select>
                  ) : (
                    <input
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      type={setting.valueType === 'integer' ? 'number' : 'text'}
                      min={setting.min ?? undefined}
                      max={setting.max ?? undefined}
                      maxLength={setting.maxLength ?? undefined}
                      style={{ padding: '6px 8px', border: '1px solid #cbd5e1', borderRadius: '6px', width: '180px' }}
                    />
                  )
                ) : (
                  show(setting.value)
                )}
              </td>
              <td style={{ padding: '10px 0', textAlign: 'right', whiteSpace: 'nowrap' }}>
                {setting.editable && (editing === setting.key ? (
                  <>
                    <button onClick={() => void save(setting)} style={{ padding: '6px 10px', border: 0, borderRadius: '6px', background: accent, color: '#fff', cursor: 'pointer' }}>Save</button>{' '}
                    <button onClick={() => setEditing(null)} style={{ padding: '6px 10px', border: '1px solid #cbd5e1', borderRadius: '6px', background: '#fff', cursor: 'pointer' }}>Cancel</button>
                  </>
                ) : (
                  <>
                    <button onClick={() => { setDraft(String(setting.value ?? '')); setEditing(setting.key) }} style={{ padding: '6px 10px', border: '1px solid #cbd5e1', borderRadius: '6px', background: '#fff', cursor: 'pointer' }}>Edit</button>
                    {setting.source === 'tenant_local' && <>{' '}<button onClick={() => void reset(setting)} style={{ padding: '6px 10px', border: '1px solid #cbd5e1', borderRadius: '6px', background: '#fff', cursor: 'pointer' }}>Reset</button></>}
                  </>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
