import type { PoolClient } from 'pg'

export const DELEGATABLE_PERMISSION_CODES = [
  'tenant.modules.author',
  'tenant.modules.assign',
] as const

export type DelegatablePermissionCode = (typeof DELEGATABLE_PERMISSION_CODES)[number]

export interface DelegationRecord {
  delegationId: string
  granteeUserId: string
  granteeDisplayName: string
  permissionCode: DelegatablePermissionCode
  status: 'active' | 'revoked'
  grantedBy: string
  grantedAt: string
  expiresAt: string | null
  revokedBy: string | null
  revokedAt: string | null
  reason: string
}

export function isDelegatablePermission(value: string): value is DelegatablePermissionCode {
  return (DELEGATABLE_PERMISSION_CODES as readonly string[]).includes(value)
}

function mapRecord(row: Record<string, unknown>): DelegationRecord {
  if (!isDelegatablePermission(String(row.permission_code))) {
    throw new Error('Database returned a non-delegatable permission.')
  }
  return {
    delegationId: String(row.delegation_id),
    granteeUserId: String(row.grantee_user_id),
    granteeDisplayName: String(row.grantee_display_name),
    permissionCode: row.permission_code as DelegatablePermissionCode,
    status: row.status === 'revoked' ? 'revoked' : 'active',
    grantedBy: String(row.granted_by),
    grantedAt: String(row.granted_at),
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    revokedBy: row.revoked_by ? String(row.revoked_by) : null,
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
    reason: String(row.reason),
  }
}

const delegationSelect = `
  select d.delegation_id::text,
         d.grantee_user_id::text,
         u.display_name as grantee_display_name,
         d.permission_code,
         d.status,
         d.granted_by::text,
         d.granted_at,
         d.expires_at,
         d.revoked_by::text,
         d.revoked_at,
         d.reason
    from capability_delegation d
    join user_account u on u.user_id = d.grantee_user_id`

export async function listDelegations(
  client: PoolClient,
  managerUserId?: string,
): Promise<DelegationRecord[]> {
  const values: unknown[] = []
  let where = ''
  if (managerUserId) {
    values.push(managerUserId)
    where = ' where d.grantee_user_id = $1'
  }
  const result = await client.query<Record<string, unknown>>(
    `${delegationSelect}${where} order by d.granted_at desc`,
    values,
  )
  return result.rows.map(mapRecord)
}

export async function grantDelegation(
  client: PoolClient,
  options: {
    actorUserId: string
    managerUserId: string
    permissionCode: string
    reason: string
    expiresAt?: string | null
    correlationId?: string | null
  },
): Promise<DelegationRecord> {
  if (!isDelegatablePermission(options.permissionCode)) {
    throw new Error('This permission cannot be delegated.')
  }
  if (options.actorUserId === options.managerUserId) {
    throw new Error('Managers cannot grant permissions to themselves.')
  }

  const actor = await client.query<{ account_status: string; role_code: string }>(
    `select u.account_status, rd.role_code
       from user_account u
       left join role_assignment ra on ra.user_id = u.user_id
       left join role_definition rd on rd.role_id = ra.role_id
      where u.user_id = $1
        and (ra.expires_at is null or ra.expires_at > now())
      order by case rd.role_code
        when 'tenant_owner' then 100
        when 'tenant_admin' then 80
        else 0 end desc
      limit 1`,
    [options.actorUserId],
  )
  if (
    !actor.rows[0] ||
    actor.rows[0].account_status !== 'active' ||
    !['tenant_owner', 'tenant_admin'].includes(actor.rows[0].role_code)
  ) {
    throw new Error('Delegation actor must be an active tenant owner or administrator.')
  }

  const manager = await client.query<{ user_id: string; display_name: string; account_status: string; role_code: string }>(
    `select u.user_id::text, u.display_name, u.account_status, rd.role_code
       from user_account u
       left join role_assignment ra on ra.user_id = u.user_id
       left join role_definition rd on rd.role_id = ra.role_id
      where u.user_id = $1
        and (ra.expires_at is null or ra.expires_at > now())
      order by case rd.role_code
        when 'tenant_owner' then 100
        when 'tenant_admin' then 80
        when 'tenant_manager' then 60
        else 0 end desc
      limit 1
      for update of u`,
    [options.managerUserId],
  )
  if (!manager.rows[0] || manager.rows[0].account_status !== 'active') {
    throw new Error('Delegation target must be an active tenant user.')
  }
  if (manager.rows[0].role_code !== 'tenant_manager') {
    throw new Error('Delegation target must have the tenant_manager role.')
  }

  const reason = options.reason.trim()
  if (reason.length < 1 || reason.length > 500) {
    throw new Error('Delegation reason must contain between 1 and 500 characters.')
  }
  if (options.expiresAt) {
    const expiresAt = new Date(options.expiresAt)
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()) {
      throw new Error('Delegation expiry must be a valid future timestamp.')
    }
    if (expiresAt.getTime() > Date.now() + 365 * 24 * 60 * 60 * 1000) {
      throw new Error('Delegation expiry cannot exceed 365 days.')
    }
  }

  // Expired active rows are historical records, but they must not block a new
  // grant. Preserve them as revoked rather than deleting audit history.
  await client.query(
    `update capability_delegation
        set status = 'revoked', revoked_by = $1, revoked_at = now()
      where grantee_user_id = $2
        and permission_code = $3
        and status = 'active'
        and expires_at is not null
        and expires_at <= now()`,
    [options.actorUserId, options.managerUserId, options.permissionCode],
  )

  const existing = await client.query<Record<string, unknown>>(
    `${delegationSelect}
      where d.grantee_user_id = $1
        and d.permission_code = $2
        and d.status = 'active'
      limit 1`,
    [options.managerUserId, options.permissionCode],
  )
  if (existing.rows[0]) {
    await client.query(
      `insert into audit_event
         (actor_user_id, action, resource_type, resource_id, outcome, correlation_id, reason)
       values ($1, 'delegation:grant', 'capability_delegation', $2, 'success', $3, $4)`,
      [options.actorUserId, existing.rows[0].delegation_id, options.correlationId || null, `Already active: ${reason}`],
    )
    return mapRecord(existing.rows[0])
  }

  const inserted = await client.query<Record<string, unknown>>(
    `insert into capability_delegation
       (grantee_user_id, permission_code, granted_by, expires_at, reason)
     values ($1, $2, $3, $4, $5)
     returning delegation_id::text, grantee_user_id::text,
               (select display_name from user_account where user_id = grantee_user_id) as grantee_display_name,
               permission_code, status, granted_by::text, granted_at,
               expires_at, revoked_by::text, revoked_at, reason`,
    [options.managerUserId, options.permissionCode, options.actorUserId, options.expiresAt || null, reason],
  )
  const row = inserted.rows[0]
  if (!row) throw new Error('Delegation creation failed.')

  await client.query(
    `insert into audit_event
       (actor_user_id, action, resource_type, resource_id, outcome, correlation_id, reason)
     values ($1, 'delegation:grant', 'capability_delegation', $2, 'success', $3, $4)`,
    [options.actorUserId, row.delegation_id, options.correlationId || null, reason],
  )
  return mapRecord(row)
}

export async function revokeDelegation(
  client: PoolClient,
  options: {
    actorUserId: string
    managerUserId: string
    delegationId: string
    reason: string
    correlationId?: string | null
  },
): Promise<DelegationRecord> {
  const actor = await client.query<{ account_status: string; role_code: string }>(
    `select u.account_status, rd.role_code
       from user_account u
       left join role_assignment ra on ra.user_id = u.user_id
       left join role_definition rd on rd.role_id = ra.role_id
      where u.user_id = $1
        and (ra.expires_at is null or ra.expires_at > now())
      order by case rd.role_code
        when 'tenant_owner' then 100
        when 'tenant_admin' then 80
        else 0 end desc
      limit 1`,
    [options.actorUserId],
  )
  if (
    !actor.rows[0] ||
    actor.rows[0].account_status !== 'active' ||
    !['tenant_owner', 'tenant_admin'].includes(actor.rows[0].role_code)
  ) {
    throw new Error('Delegation actor must be an active tenant owner or administrator.')
  }
  const reason = options.reason.trim()
  if (reason.length < 1 || reason.length > 500) {
    throw new Error('Revocation reason must contain between 1 and 500 characters.')
  }
  const updated = await client.query<Record<string, unknown>>(
    `${delegationSelect}
      where d.delegation_id = $1
        and d.grantee_user_id = $2
        and d.status = 'active'
      for update`,
    [options.delegationId, options.managerUserId],
  )
  const row = updated.rows[0]
  if (!row) throw new Error('Active delegation was not found.')
  await client.query(
    `update capability_delegation
        set status = 'revoked', revoked_by = $1, revoked_at = now()
      where delegation_id = $2 and status = 'active'`,
    [options.actorUserId, options.delegationId],
  )
  await client.query(
    `insert into audit_event
       (actor_user_id, action, resource_type, resource_id, outcome, correlation_id, reason)
     values ($1, 'delegation:revoke', 'capability_delegation', $2, 'success', $3, $4)`,
    [options.actorUserId, options.delegationId, options.correlationId || null, reason],
  )
  return mapRecord({ ...row, status: 'revoked', revoked_by: options.actorUserId, revoked_at: new Date().toISOString(), reason })
}
