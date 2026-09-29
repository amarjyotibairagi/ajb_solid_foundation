import { useMemo, useState } from 'react'
import type { AdminApi } from './api'
import { Badge, Notice, useAsyncAction } from './ui'

export type ConfigDefinition = {
  key: string
  kind: 'feature' | 'limit' | 'setting'
  valueType: 'boolean' | 'integer' | 'string' | 'string_list'
  label: string
  description: string
  category: string
  moduleCode: string | null
  defaultValue: unknown
  min: number | null
  max: number | null
  maxLength: number | null
  scopes: string[]
  tenantEditable: boolean
  isPublic: boolean
}

type Scope = { scope: 'platform' } | { scope: 'plan'; ref: string } | { scope: 'tenant'; ref: string }

function display(value: unknown): string {
  if (value === undefined) return '—'
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

function parseInput(definition: ConfigDefinition, raw: string): unknown {
  switch (definition.valueType) {
    case 'boolean':
      return raw === 'true'
    case 'integer': {
      const value = Number(raw)
      if (!Number.isInteger(value)) throw new Error(`${definition.label} must be a whole number.`)
      return value
    }
    case 'string_list':
      return raw.split(/[\n,]/).map((item) => item.trim()).filter(Boolean)
    default:
      return raw
  }
}

/**
 * Edits configuration overrides at one scope. Shows, per key, the value this
 * scope sets (if any), the effective value where known, and where it came from.
 */
export function ConfigEditor({ api, definitions, scope, overrides, effective, onChanged }: {
  api: AdminApi
  definitions: ConfigDefinition[]
  scope: Scope
  overrides: Record<string, unknown>
  effective?: { values: Record<string, unknown>; sources: Record<string, string> } | null
  onChanged: () => void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [filter, setFilter] = useState('')
  const action = useAsyncAction()
  const visible = useMemo(
    () =>
      definitions
        .filter((definition) => definition.scopes.includes(scope.scope))
        .filter((definition) => !filter || `${definition.key} ${definition.label} ${definition.category}`.toLowerCase().includes(filter.toLowerCase())),
    [definitions, scope.scope, filter],
  )
  const grouped = useMemo(() => {
    const groups = new Map<string, ConfigDefinition[]>()
    for (const definition of visible) groups.set(definition.category, [...(groups.get(definition.category) || []), definition])
    return [...groups.entries()]
  }, [visible])

  const startEdit = (definition: ConfigDefinition) => {
    const current = definition.key in overrides ? overrides[definition.key] : effective?.values[definition.key] ?? definition.defaultValue
    setDraft(Array.isArray(current) ? current.join('\n') : String(current ?? ''))
    setEditing(definition.key)
  }

  const save = (definition: ConfigDefinition) =>
    action.run(async () => {
      const value = parseInput(definition, draft)
      await api.send('PUT', '/api/config/values', { ...scope, key: definition.key, value })
      setEditing(null)
      onChanged()
      return `${definition.label} saved.`
    })

  const clear = (definition: ConfigDefinition) =>
    action.run(async () => {
      await api.send('DELETE', '/api/config/values', { ...scope, key: definition.key })
      onChanged()
      return `${definition.label} now inherits.`
    })

  return (
    <div className="admin-config">
      <input className="admin-input" placeholder="Filter settings, features, limits…" value={filter} onChange={(event) => setFilter(event.target.value)} />
      {action.error && <Notice tone="error">{action.error}</Notice>}
      {action.message && <Notice tone="success">{action.message}</Notice>}
      {grouped.map(([category, items]) => (
        <div key={category} className="admin-config-group">
          <h3>{category}</h3>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Setting</th>
                <th>This scope</th>
                {effective && <th>Effective</th>}
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((definition) => {
                const overridden = definition.key in overrides
                return (
                  <tr key={definition.key}>
                    <td>
                      <div className="admin-strong">
                        {definition.label} <Badge tone={definition.kind === 'feature' ? 'info' : definition.kind === 'limit' ? 'warn' : 'neutral'}>{definition.kind}</Badge>
                        {definition.tenantEditable && <Badge tone="good">tenant-editable</Badge>}
                      </div>
                      <div className="admin-hint"><code>{definition.key}</code> · default {display(definition.defaultValue)} {definition.description && `· ${definition.description}`}</div>
                    </td>
                    <td>
                      {editing === definition.key ? (
                        definition.valueType === 'boolean' ? (
                          <select className="admin-input" value={draft} onChange={(event) => setDraft(event.target.value)}>
                            <option value="true">On</option>
                            <option value="false">Off</option>
                          </select>
                        ) : definition.valueType === 'string_list' ? (
                          <textarea className="admin-input" rows={4} value={draft} onChange={(event) => setDraft(event.target.value)} />
                        ) : (
                          <input
                            className="admin-input"
                            type={definition.valueType === 'integer' ? 'number' : 'text'}
                            min={definition.min ?? undefined}
                            max={definition.max ?? undefined}
                            maxLength={definition.maxLength ?? undefined}
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
                          />
                        )
                      ) : overridden ? (
                        <span className="admin-strong">{display(overrides[definition.key])}</span>
                      ) : (
                        <span className="admin-muted">inherits</span>
                      )}
                    </td>
                    {effective && (
                      <td>
                        {display(effective.values[definition.key])} <Badge>{effective.sources[definition.key] || 'default'}</Badge>
                      </td>
                    )}
                    <td className="admin-row-actions">
                      {editing === definition.key ? (
                        <>
                          <button className="admin-button admin-button-primary" disabled={action.busy} onClick={() => void save(definition)}>Save</button>
                          <button className="admin-button" onClick={() => setEditing(null)}>Cancel</button>
                        </>
                      ) : (
                        <>
                          <button className="admin-button" onClick={() => startEdit(definition)}>{overridden ? 'Change' : 'Override'}</button>
                          {overridden && <button className="admin-button" disabled={action.busy} onClick={() => void clear(definition)}>Reset</button>}
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ))}
      {!visible.length && <div className="admin-muted">No configurable keys at this scope.</div>}
    </div>
  )
}
