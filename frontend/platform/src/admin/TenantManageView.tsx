import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { AdminApi } from './api'
import { ConfigEditor, type ConfigDefinition } from './ConfigEditor'
import { IntegrationsPanel, JobProgress } from './IntegrationsPanel'
import { Badge, Card, Field, formatDate, Notice, OneTimeLink, PageHeader, useAsyncAction } from './ui'

type TenantRow = { tenantId: string; displayName: string; hostname: string; status: string }
type Detail = {
  tenant: Record<string, any>
  domains: Array<{ hostname: string; isPrimary: boolean; status: string }>
  subscription: { planCode: string; planName: string; status: string; periodStart: string } | null
  jobs: Array<{ jobId: string; jobType: string; status: string; currentStep: string | null; errorMessage: string | null; createdAt: string; completedAt: string | null }>
  ownerInvitations: Array<{ invitationId: string; email: string; displayName: string; createdAt: string; expiresAt: string; acceptedAt: string | null; revokedAt: string | null }>
  effectiveConfig: { planCode: string | null; values: Record<string, unknown>; sources: Record<string, string> } | null
}

const statusTone = (status: string) =>
  status === 'active' || status === 'succeeded' ? 'good' : /fail/.test(status) ? 'bad' : status === 'suspended' ? 'warn' : 'info'

export function TenantManageView({ api, initialTenantKey }: { api: AdminApi; initialTenantKey?: string | null }) {
  const [tenants, setTenants] = useState<TenantRow[]>([])
  const [selected, setSelected] = useState<string | null>(initialTenantKey ?? null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [definitions, setDefinitions] = useState<ConfigDefinition[]>([])
  const [plans, setPlans] = useState<Array<{ planCode: string; displayName: string; isActive: boolean }>>([])
  const [overrides, setOverrides] = useState<Record<string, unknown>>({})
  const [issuedLink, setIssuedLink] = useState<{ link: string; delivered: boolean } | null>(null)
  const [upgradeJob, setUpgradeJob] = useState<string | null>(null)
  const loader = useAsyncAction()
  const action = useAsyncAction()

  const loadList = useCallback(
    () =>
      loader.run(async () => {
        const [list, defs, planList] = await Promise.all([api.get('/api/tenants'), api.get('/api/config/definitions'), api.get('/api/plans')])
        setTenants(list.tenants)
        setDefinitions(defs.definitions)
        setPlans(planList.plans)
        if (!selected && list.tenants[0]) setSelected(list.tenants[0].tenantId)
      }),
    [api, selected],
  )

  const loadDetail = useCallback(
    (tenantKey: string) =>
      loader.run(async () => {
        const [data, values] = await Promise.all([
          api.get(`/api/tenants/${encodeURIComponent(tenantKey)}`),
          api.get(`/api/config/values?scope=tenant&ref=${encodeURIComponent(tenantKey)}`),
        ])
        setDetail(data)
        setOverrides(Object.fromEntries(values.values.map((row: { key: string; value: unknown }) => [row.key, row.value])))
      }),
    [api],
  )

  useEffect(() => { void loadList() }, [])
  useEffect(() => {
    setIssuedLink(null)
    if (selected) void loadDetail(selected)
  }, [selected])

  const saveProfile = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const payload: Record<string, string> = {}
    for (const key of ['displayName', 'legalName', 'locale', 'logoUrl', 'primaryColor', 'secondaryColor', 'loginMessage']) {
      const value = String(form.get(key) ?? '')
      if (value !== String(detail?.tenant[key] ?? '')) payload[key] = value
    }
    void action.run(async () => {
      if (!Object.keys(payload).length) return 'Nothing changed.'
      await api.send('PATCH', `/api/tenants/${selected}`, payload)
      await loadDetail(selected!)
      return 'Tenant profile saved.'
    })
  }

  const assignPlan = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    void action.run(async () => {
      await api.send('PUT', `/api/tenants/${selected}/plan`, { planCode: form.get('planCode'), status: form.get('status') })
      await loadDetail(selected!)
      return 'Plan assigned.'
    })
  }

  const inviteOwner = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    void action.run(async () => {
      const result = await api.send('POST', `/api/tenants/${selected}/owner-invitations`, {
        email: form.get('email'),
        displayName: form.get('displayName'),
      })
      setIssuedLink({ link: result.invitation.link, delivered: result.invitation.delivered })
      formElement.reset()
      await loadDetail(selected!)
      return 'Owner invitation issued. Any earlier pending owner link was revoked.'
    })
  }

  const revokeInvitation = (invitationId: string) =>
    action.run(async () => {
      await api.send('DELETE', `/api/tenants/${selected}/owner-invitations/${invitationId}`)
      await loadDetail(selected!)
      return 'Invitation revoked.'
    })

  const tenant = detail?.tenant
  return (
    <div className="admin-view">
      <PageHeader
        eyebrow="Tenant / Manage"
        title={tenant ? tenant.displayName : 'Manage tenants'}
        subtitle="Profile, plan, onboarding, configuration overrides and job history"
        onRefresh={() => (selected ? void loadDetail(selected) : void loadList())}
        busy={loader.busy}
        actions={
          <select className="admin-input admin-select-inline" value={selected ?? ''} onChange={(event) => setSelected(event.target.value || null)}>
            <option value="">Select a tenant…</option>
            {tenants.map((row) => (
              <option key={row.tenantId} value={row.tenantId}>{row.displayName} — {row.hostname}</option>
            ))}
          </select>
        }
      />
      {loader.error && <Notice tone="error">{loader.error}</Notice>}
      {action.error && <Notice tone="error">{action.error}</Notice>}
      {action.message && <Notice tone="success">{action.message}</Notice>}
      {!tenant && !loader.busy && <Notice>Select a tenant to manage it.</Notice>}
      {tenant && detail && (
        <>
          <div className="admin-grid">
            <Card title="Status">
              <dl className="admin-dl">
                <dt>Lifecycle</dt><dd><Badge tone={statusTone(tenant.status)}>{tenant.status}</Badge></dd>
                <dt>Tenant key</dt><dd><code>{tenant.tenantId}</code></dd>
                <dt>Hostname</dt><dd>{detail.domains.find((domain) => domain.isPrimary)?.hostname}</dd>
                <dt>Schema version</dt>
                <dd>
                  {tenant.schemaVersion} / {tenant.latestSchemaVersion}{' '}
                  {tenant.schemaVersion < tenant.latestSchemaVersion ? <Badge tone="warn">behind</Badge> : <Badge tone="good">current</Badge>}{' '}
                  <button
                    className="admin-button"
                    disabled={action.busy || !!upgradeJob}
                    onClick={() => void action.run(async () => {
                      const result = await api.send('POST', `/api/tenants/${selected}/migrate`)
                      setUpgradeJob(result.jobId)
                      return 'Schema upgrade started.'
                    })}
                  >
                    Upgrade schema
                  </button>
                  {upgradeJob && <JobProgress api={api} jobId={upgradeJob} onDone={() => { setUpgradeJob(null); void loadDetail(selected!) }} />}
                </dd>
                <dt>Connection tier</dt>
                <dd><Badge tone={tenant.connectionTier === 'pooled' ? 'info' : 'neutral'}>{tenant.connectionTier}</Badge></dd>
                <dt>Data</dt><dd>{tenant.dataIntegrationId ? <Badge tone="info">tenant database</Badge> : 'VDS'}</dd>
                <dt>Files</dt><dd>{tenant.storageIntegrationId ? <Badge tone="info">tenant bucket</Badge> : 'VDS'}</dd>
                <dt>Plan</dt><dd>{detail.subscription ? `${detail.subscription.planName} (${detail.subscription.status})` : <span className="admin-muted">none</span>}</dd>
                <dt>Created</dt><dd>{formatDate(tenant.createdAt)}</dd>
                {tenant.lastErrorCode && (<><dt>Last error</dt><dd><Badge tone="bad">{tenant.lastErrorCode}</Badge> {formatDate(tenant.lastErrorAt)}</dd></>)}
              </dl>
            </Card>

            <Card title="Plan">
              <form className="admin-form" onSubmit={assignPlan}>
                <Field label="Plan">
                  <select className="admin-input" name="planCode" defaultValue={detail.subscription?.planCode ?? ''} required>
                    <option value="" disabled>Choose a plan…</option>
                    {plans.filter((plan) => plan.isActive).map((plan) => <option key={plan.planCode} value={plan.planCode}>{plan.displayName}</option>)}
                  </select>
                </Field>
                <Field label="Subscription status">
                  <select className="admin-input" name="status" defaultValue={detail.subscription?.status ?? 'active'}>
                    {['active', 'trialing', 'past_due', 'paused'].map((status) => <option key={status}>{status}</option>)}
                  </select>
                </Field>
                <button className="admin-button admin-button-primary" disabled={action.busy}>Assign plan</button>
              </form>
            </Card>
          </div>

          <Card title="Profile & branding">
            <form className="admin-form admin-form-grid" onSubmit={saveProfile} key={`${selected}-${tenant.displayName}-${tenant.primaryColor}`}>
              <Field label="Display name"><input className="admin-input" name="displayName" defaultValue={tenant.displayName} maxLength={160} /></Field>
              <Field label="Legal name"><input className="admin-input" name="legalName" defaultValue={tenant.legalName ?? ''} maxLength={240} /></Field>
              <Field label="Locale" hint="e.g. en or en-GB"><input className="admin-input" name="locale" defaultValue={tenant.locale} /></Field>
              <Field label="Logo URL" hint="https only"><input className="admin-input" name="logoUrl" type="url" defaultValue={tenant.logoUrl ?? ''} /></Field>
              <Field label="Primary color"><input className="admin-input" name="primaryColor" defaultValue={tenant.primaryColor ?? '#2563eb'} pattern="#[0-9A-Fa-f]{6}" /></Field>
              <Field label="Secondary color"><input className="admin-input" name="secondaryColor" defaultValue={tenant.secondaryColor ?? '#0f172a'} pattern="#[0-9A-Fa-f]{6}" /></Field>
              <Field label="Sign-in message"><input className="admin-input" name="loginMessage" defaultValue={tenant.loginMessage ?? ''} maxLength={300} /></Field>
              <div><button className="admin-button admin-button-primary" disabled={action.busy}>Save profile</button></div>
            </form>
          </Card>

          <Card title="Owner onboarding">
            <p className="admin-hint">Invite the tenant's owner. They open the link on the tenant's own hostname, choose a username and set a password. Issuing a new link revokes any pending one.</p>
            <form className="admin-form admin-form-inline" onSubmit={inviteOwner}>
              <input className="admin-input" name="displayName" placeholder="Owner name" required maxLength={255} />
              <input className="admin-input" name="email" type="email" placeholder="owner@company.com" required />
              <button className="admin-button admin-button-primary" disabled={action.busy}>Issue owner invitation</button>
            </form>
            {issuedLink && <OneTimeLink label="Owner invitation link" link={issuedLink.link} delivered={issuedLink.delivered} />}
            {detail.ownerInvitations.length > 0 && (
              <table className="admin-table">
                <thead><tr><th>Invitee</th><th>Issued</th><th>Expires</th><th>State</th><th /></tr></thead>
                <tbody>
                  {detail.ownerInvitations.map((invitation) => {
                    const pending = !invitation.acceptedAt && !invitation.revokedAt && new Date(invitation.expiresAt) > new Date()
                    return (
                      <tr key={invitation.invitationId}>
                        <td>{invitation.displayName}<div className="admin-hint">{invitation.email}</div></td>
                        <td>{formatDate(invitation.createdAt)}</td>
                        <td>{formatDate(invitation.expiresAt)}</td>
                        <td>
                          {invitation.acceptedAt ? <Badge tone="good">accepted</Badge> : invitation.revokedAt ? <Badge>revoked</Badge> : pending ? <Badge tone="info">pending</Badge> : <Badge tone="warn">expired</Badge>}
                        </td>
                        <td className="admin-row-actions">{pending && <button className="admin-button" onClick={() => void revokeInvitation(invitation.invitationId)}>Revoke</button>}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </Card>

          <IntegrationsPanel
            api={api}
            tenantKey={selected!}
            active={{ storage: tenant.storageIntegrationId ?? null, database: tenant.dataIntegrationId ?? null }}
            onChanged={() => void loadDetail(selected!)}
          />

          <Card title="Configuration overrides for this tenant">
            <p className="admin-hint">Overrides here win over the plan and platform values. Tenant administrators can additionally change keys marked tenant-editable from their own workspace.</p>
            <ConfigEditor
              api={api}
              definitions={definitions}
              scope={{ scope: 'tenant', ref: selected! }}
              overrides={overrides}
              effective={detail.effectiveConfig}
              onChanged={() => void loadDetail(selected!)}
            />
          </Card>

          <Card title="Provisioning jobs">
            <table className="admin-table">
              <thead><tr><th>Type</th><th>Status</th><th>Step</th><th>Created</th><th>Completed</th></tr></thead>
              <tbody>
                {detail.jobs.map((job) => (
                  <tr key={job.jobId}>
                    <td>{job.jobType}</td>
                    <td><Badge tone={statusTone(job.status)}>{job.status}</Badge>{job.errorMessage && <div className="admin-hint">{job.errorMessage}</div>}</td>
                    <td><code>{job.currentStep ?? '—'}</code></td>
                    <td>{formatDate(job.createdAt)}</td>
                    <td>{formatDate(job.completedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  )
}
