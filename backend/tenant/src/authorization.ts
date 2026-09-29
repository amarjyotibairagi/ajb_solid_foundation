import type { PoolClient } from 'pg'

export const CANONICAL_ROLES = [
  'tenant_owner',
  'tenant_admin',
  'tenant_manager',
  'tenant_member',
  'tenant_viewer',
] as const

export type CanonicalRole = (typeof CANONICAL_ROLES)[number]

export const ALL_SUPPORTED_ROLES = CANONICAL_ROLES

export type SupportedRole = (typeof ALL_SUPPORTED_ROLES)[number]

const ROLE_RANK: Record<CanonicalRole, number> = {
  tenant_owner: 100,
  tenant_admin: 80,
  tenant_manager: 60,
  tenant_member: 40,
  tenant_viewer: 20,
}

export function toCanonicalRole(role: string | null | undefined): CanonicalRole | null {
  if (!role) return null
  const normalized = role.trim().toLowerCase()
  if (CANONICAL_ROLES.includes(normalized as CanonicalRole)) {
    return normalized as CanonicalRole
  }
  return null
}

export function getHighestCanonicalRole(roleCodes: string[]): CanonicalRole | null {
  let highest: CanonicalRole | null = null
  let maxRank = -1
  for (const code of roleCodes) {
    const canonical = toCanonicalRole(code)
    if (canonical) {
      const rank = ROLE_RANK[canonical]
      if (rank > maxRank) {
        maxRank = rank
        highest = canonical
      }
    }
  }
  return highest
}

export function canAssignRole(
  actorRole: CanonicalRole,
  targetRole: CanonicalRole,
): boolean {
  if (actorRole === 'tenant_owner') {
    // Owner can assign admin, manager, member, viewer
    // (Owner role can only be assigned via dedicated owner grant/transfer operations)
    return ['tenant_admin', 'tenant_manager', 'tenant_member', 'tenant_viewer'].includes(targetRole)
  }
  if (actorRole === 'tenant_admin') {
    // Cannot assign owner or admin
    return ['tenant_manager', 'tenant_member', 'tenant_viewer'].includes(targetRole)
  }
  if (actorRole === 'tenant_manager') {
    // Can only invite/assign member or viewer
    return ['tenant_member', 'tenant_viewer'].includes(targetRole)
  }
  return false
}

export function canManageTargetUser(
  actorRole: CanonicalRole,
  targetUserHighestRole: CanonicalRole | null,
): boolean {
  if (actorRole === 'tenant_owner') {
    return true
  }
  if (!targetUserHighestRole) {
    return actorRole === 'tenant_admin' || actorRole === 'tenant_manager'
  }
  // Actor cannot manage users of equal or higher rank (admin cannot manage admin/owner, manager cannot manage manager/admin/owner)
  return ROLE_RANK[actorRole] > ROLE_RANK[targetUserHighestRole]
}

export async function assertNotDemotingLastOwner(
  client: PoolClient,
  tenantKeyOrSchema: string,
  targetUserId: string,
): Promise<void> {
  // Serialize owner-affecting checks per tenant schema
  await client.query('select pg_advisory_xact_lock(hashtext($1))', [`tenant-owner-lock:${tenantKeyOrSchema}`])

  // Lock target user account and active owner assignments
  await client.query('select user_id from user_account where user_id = $1 for update', [targetUserId])
  await client.query(
    `select ra.assignment_id
       from role_assignment ra
       join role_definition rd on rd.role_id = ra.role_id
      where rd.role_code = 'tenant_owner'
        for update`,
  )

  const result = await client.query<{ count: number }>(
    `select count(distinct ra.user_id)::int as count
       from role_assignment ra
       join role_definition rd on rd.role_id = ra.role_id
       join user_account ua on ua.user_id = ra.user_id
      where rd.role_code = 'tenant_owner'
        and ua.account_status = 'active'
        and ua.user_id <> $1
        and (ra.expires_at is null or ra.expires_at > now())`,
    [targetUserId],
  )
  const remainingOwners = Number(result.rows[0]?.count || 0)
  if (remainingOwners < 1) {
    throw new Error('Operation not allowed: tenant workspace must retain at least one active tenant_owner.')
  }
}
