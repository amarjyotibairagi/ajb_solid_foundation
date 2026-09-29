import { useEffect, useState } from 'react'
import type { AdminApi } from './api'
import { ConfigEditor, type ConfigDefinition } from './ConfigEditor'
import { Notice, PageHeader, useAsyncAction } from './ui'

export function ConfigurationView({ api, isOwner }: { api: AdminApi; isOwner: boolean }) {
  const [definitions, setDefinitions] = useState<ConfigDefinition[]>([])
  const [values, setValues] = useState<Record<string, unknown>>({})
  const loader = useAsyncAction()

  const load = () =>
    loader.run(async () => {
      const data = await api.get('/api/config/definitions')
      setDefinitions(data.definitions)
      setValues(Object.fromEntries(data.platformValues.map((row: { key: string; value: unknown }) => [row.key, row.value])))
    })
  useEffect(() => { void load() }, [])

  return (
    <div className="admin-view">
      <PageHeader
        eyebrow="Platform / Configuration"
        title="Platform configuration"
        subtitle="Platform-wide defaults for every feature, limit and setting. Plans and tenants may override where the key allows."
        onRefresh={() => void load()}
        busy={loader.busy}
      />
      {loader.error && <Notice tone="error">{loader.error}</Notice>}
      {!isOwner && <Notice tone="warning">Only platform owners can change platform-wide values. You can still view them.</Notice>}
      <Notice>
        Resolution order: definition default → platform → plan → tenant override → tenant-local (tenant-editable keys only). Tenant services pick up changes within about 10 seconds.
      </Notice>
      <ConfigEditor
        api={api}
        definitions={definitions}
        scope={{ scope: 'platform' }}
        overrides={values}
        effective={{
          values: Object.fromEntries(definitions.map((definition) => [definition.key, definition.key in values ? values[definition.key] : definition.defaultValue])),
          sources: Object.fromEntries(definitions.map((definition) => [definition.key, definition.key in values ? 'platform' : 'default'])),
        }}
        onChanged={() => void load()}
      />
    </div>
  )
}
