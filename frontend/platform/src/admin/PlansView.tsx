import { useEffect, useState, type FormEvent } from 'react'
import type { AdminApi } from './api'
import { ConfigEditor, type ConfigDefinition } from './ConfigEditor'
import { Badge, Card, Field, Notice, PageHeader, useAsyncAction } from './ui'

type Plan = {
  planCode: string
  displayName: string
  audience: 'b2b' | 'b2c' | 'both'
  isActive: boolean
  version: number
  tenantCount: number
  overrides: Record<string, unknown>
  description: string
  priceMonthly: number | null
  highlights: string[]
  sortOrder: number
}

export function PlansView({ api, canEdit }: { api: AdminApi; canEdit: boolean }) {
  const [plans, setPlans] = useState<Plan[]>([])
  const [definitions, setDefinitions] = useState<ConfigDefinition[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const loader = useAsyncAction()
  const action = useAsyncAction()

  const load = () =>
    loader.run(async () => {
      const [planList, defs] = await Promise.all([api.get('/api/plans'), api.get('/api/config/definitions')])
      setPlans(planList.plans)
      setDefinitions(defs.definitions)
      if (!selected && planList.plans[0]) setSelected(planList.plans[0].planCode)
    })
  useEffect(() => { void load() }, [])

  const savePlan = (event: FormEvent<HTMLFormElement>, existing?: Plan) => {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    void action.run(async () => {
      const planCode = existing?.planCode ?? String(form.get('planCode'))
      await api.send('POST', '/api/plans', {
        planCode,
        displayName: form.get('displayName'),
        audience: form.get('audience'),
        isActive: form.get('isActive') === 'on',
      })
      if (!existing) formElement.reset()
      setSelected(planCode)
      await load()
      return `Plan ${planCode} saved.`
    })
  }

  const plan = plans.find((item) => item.planCode === selected)
  return (
    <div className="admin-view">
      <PageHeader eyebrow="Platform / Plans" title="Plans & entitlements" subtitle="Plan values sit between platform defaults and tenant overrides" onRefresh={() => void load()} busy={loader.busy} />
      {loader.error && <Notice tone="error">{loader.error}</Notice>}
      {action.error && <Notice tone="error">{action.error}</Notice>}
      {action.message && <Notice tone="success">{action.message}</Notice>}
      <div className="admin-grid">
        <Card title="Plans">
          <table className="admin-table">
            <thead><tr><th>Plan</th><th>Audience</th><th>Tenants</th><th>State</th></tr></thead>
            <tbody>
              {plans.map((item) => (
                <tr key={item.planCode} className={item.planCode === selected ? 'admin-row-selected' : undefined} onClick={() => setSelected(item.planCode)}>
                  <td><span className="admin-strong">{item.displayName}</span><div className="admin-hint"><code>{item.planCode}</code> · v{item.version}</div></td>
                  <td>{item.audience}</td>
                  <td>{item.tenantCount}</td>
                  <td>{item.isActive ? <Badge tone="good">active</Badge> : <Badge>retired</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        {canEdit && (
          <Card title="New plan">
            <form className="admin-form" onSubmit={(event) => savePlan(event)}>
              <Field label="Code" hint="lowercase, e.g. enterprise"><input className="admin-input" name="planCode" required pattern="[a-z][a-z0-9_]{1,62}" /></Field>
              <Field label="Display name"><input className="admin-input" name="displayName" required maxLength={120} /></Field>
              <Field label="Audience">
                <select className="admin-input" name="audience" defaultValue="b2b"><option value="b2b">B2B tenants</option><option value="b2c">B2C users</option><option value="both">Both</option></select>
              </Field>
              <label className="admin-check"><input type="checkbox" name="isActive" defaultChecked /> Available for assignment</label>
              <button className="admin-button admin-button-primary" disabled={action.busy}>Create plan</button>
            </form>
          </Card>
        )}
      </div>
      {plan && (
        <>
          {canEdit && (
            <Card title={`Edit ${plan.displayName}`}>
              <form className="admin-form admin-form-inline" onSubmit={(event) => savePlan(event, plan)} key={`${plan.planCode}-${plan.version}`}>
                <input className="admin-input" name="displayName" defaultValue={plan.displayName} required maxLength={120} />
                <select className="admin-input" name="audience" defaultValue={plan.audience}><option value="b2b">B2B</option><option value="b2c">B2C</option><option value="both">Both</option></select>
                <label className="admin-check"><input type="checkbox" name="isActive" defaultChecked={plan.isActive} /> Active</label>
                <button className="admin-button admin-button-primary" disabled={action.busy}>Save</button>
              </form>
            </Card>
          )}
          {canEdit && plan.audience !== 'b2b' && (
            <Card title="Shown on the public app">
              <form
                className="admin-form admin-form-grid"
                key={`${plan.planCode}-presentation-${plan.description}-${plan.priceMonthly}`}
                onSubmit={(event) => {
                  event.preventDefault()
                  const form = new FormData(event.currentTarget)
                  const price = String(form.get('priceMonthly') || '').trim()
                  void action.run(async () => {
                    await api.send('PATCH', `/api/plans/${plan.planCode}/presentation`, {
                      description: String(form.get('description') || ''),
                      priceMonthly: price === '' ? null : Number(price),
                      highlights: String(form.get('highlights') || '').split('\n').map((line) => line.trim()).filter(Boolean),
                      sortOrder: Number(form.get('sortOrder') || 100),
                    })
                    await load()
                    return 'Public plan details saved. The public app picks them up within a minute.'
                  })
                }}
              >
                <Field label="Description"><input className="admin-input" name="description" defaultValue={plan.description} maxLength={500} /></Field>
                <Field label="Monthly price"><input className="admin-input" name="priceMonthly" type="number" min={0} step="0.01" defaultValue={plan.priceMonthly ?? ''} /></Field>
                <Field label="Order"><input className="admin-input" name="sortOrder" type="number" defaultValue={plan.sortOrder} /></Field>
                <Field label="Highlights" hint="One per line"><textarea className="admin-input" name="highlights" rows={4} defaultValue={plan.highlights.join('\n')} /></Field>
                <div><button className="admin-button admin-button-primary" disabled={action.busy}>Save public details</button></div>
              </form>
            </Card>
          )}
          <Card title={`Entitlements for ${plan.displayName}`}>
            <ConfigEditor api={api} definitions={definitions} scope={{ scope: 'plan', ref: plan.planCode }} overrides={plan.overrides} onChanged={() => void load()} />
          </Card>
        </>
      )}
    </div>
  )
}
