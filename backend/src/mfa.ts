import type { Pool, PoolClient } from 'pg'
import type { FastifyReply } from 'fastify'
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server'

export const MFA_MAX_AGE_MS = 5 * 60 * 1000 // 5 minutes

export interface MfaAuthContext {
  sessionId: string
  csrfHash: string
  user: { id: string; username: string; role: string }
  mfaVerifiedAt: Date | null
}

export function isMfaRecent(mfaVerifiedAt: Date | null | undefined): boolean {
  if (!mfaVerifiedAt) return false
  const age = Date.now() - new Date(mfaVerifiedAt).getTime()
  return age >= 0 && age <= MFA_MAX_AGE_MS
}

export function requireRecentMfa(
  reply: FastifyReply,
  auth: { mfaVerifiedAt?: Date | null },
): boolean {
  if (!isMfaRecent(auth.mfaVerifiedAt)) {
    void reply.code(403).send({
      success: false,
      code: 'MFA_STEP_UP_REQUIRED',
      message: 'This operation requires recent step-up authentication (within 5 minutes).',
    })
    return false
  }
  return true
}

export interface WebAuthnConfig {
  rpName: string
  rpID: string
  expectedOrigin: string[]
}

export function getWebAuthnConfig(configuredOrigin?: string): WebAuthnConfig {
  // WebAuthn credentials are bound to the RP ID forever; never guess it.
  const publicOrigin = configuredOrigin || process.env.PLATFORM_PUBLIC_ORIGIN || ''
  if (!publicOrigin) throw new Error('PLATFORM_PUBLIC_ORIGIN is required for WebAuthn.')
  const rpID = new URL(publicOrigin).hostname

  const origins = new Set<string>([publicOrigin])
  if (process.env.PLATFORM_FRONTEND_ORIGIN) {
    origins.add(process.env.PLATFORM_FRONTEND_ORIGIN)
  }
  return {
    rpName: 'Skeleton Platform',
    rpID,
    expectedOrigin: Array.from(origins),
  }
}

export async function getUserWebAuthnCredentials(
  pool: Pool | PoolClient,
  userId: string,
): Promise<Array<{ credential_id: string; transports: string[] | null; counter: number }>> {
  const result = await pool.query<{
    credential_id: string
    transports: string[] | null
    counter: string
  }>(
    `select credential_id, transports, counter
       from platform.platform_webauthn_credential
      where user_id = $1 and is_enabled = true
      order by created_at desc`,
    [userId],
  )
  return result.rows.map((row) => ({
    credential_id: row.credential_id,
    transports: row.transports,
    counter: Number(row.counter),
  }))
}

export async function generateRegistrationChallenge(
  pool: Pool,
  userId: string,
  username: string,
  sessionId: string,
  config = getWebAuthnConfig(),
) {
  const existingCredentials = await getUserWebAuthnCredentials(pool, userId)
  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpID,
    userID: Buffer.from(userId, 'utf-8'),
    userName: username,
    attestationType: 'none',
    authenticatorSelection: {
      userVerification: 'required',
    },
    excludeCredentials: existingCredentials.map((c) => ({
      id: c.credential_id,
      transports: (c.transports as any) || undefined,
    })),
  })

  // Purge expired challenges and store new challenge
  await pool.query(
    `delete from platform.platform_webauthn_challenge
      where user_id = $1 and (expires_at < now() or purpose = 'registration')`,
    [userId],
  )

  const challengeRes = await pool.query<{ challenge_id: string }>(
    `insert into platform.platform_webauthn_challenge
       (user_id, session_id, challenge, purpose, expected_origin, expected_rp_id, expires_at)
     values ($1, $2, $3, 'registration', $4, $5, now() + interval '5 minutes')
     returning challenge_id::text`,
    [userId, sessionId, options.challenge, config.expectedOrigin[0], config.rpID],
  )

  return {
    challengeId: challengeRes.rows[0]?.challenge_id ?? '',
    options,
  }
}

export async function verifyRegistrationAssertion(
  pool: Pool,
  userId: string,
  sessionId: string,
  challengeId: string,
  response: RegistrationResponseJSON,
  config = getWebAuthnConfig(),
): Promise<{ verified: boolean; error?: string }> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const challengeRow = (
      await client.query<{
        challenge: string
        expected_origin: string
        expected_rp_id: string
      }>(
        `select challenge, expected_origin, expected_rp_id
           from platform.platform_webauthn_challenge
          where challenge_id = $1
            and user_id = $2
            and purpose = 'registration'
            and consumed_at is null
            and expires_at > now()
          for update`,
        [challengeId, userId],
      )
    ).rows[0]

    if (!challengeRow) {
      await client.query('rollback')
      return { verified: false, error: 'Registration challenge is invalid, expired, or already consumed.' }
    }

    let verification
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challengeRow.challenge,
        expectedOrigin: config.expectedOrigin,
        expectedRPID: challengeRow.expected_rp_id,
        requireUserVerification: true,
      })
    } catch (verifyError) {
      await client.query('rollback')
      return { verified: false, error: (verifyError as Error).message }
    }

    if (!verification.verified || !verification.registrationInfo) {
      await client.query('rollback')
      return { verified: false, error: 'WebAuthn registration verification failed.' }
    }

    const { credential, aaguid } = verification.registrationInfo
    const publicKeyBuffer = Buffer.from(credential.publicKey)

    // Store new credential
    await client.query(
      `insert into platform.platform_webauthn_credential
         (credential_id, user_id, public_key, counter, transports, aaguid, is_enabled)
       values ($1, $2, $3, $4, $5, $6, true)
       on conflict (credential_id) do update set
         user_id = excluded.user_id,
         public_key = excluded.public_key,
         counter = excluded.counter,
         transports = excluded.transports,
         aaguid = excluded.aaguid,
         is_enabled = true`,
      [
        credential.id,
        userId,
        publicKeyBuffer,
        credential.counter,
        credential.transports || null,
        aaguid || null,
      ],
    )

    // Mark challenge as consumed
    await client.query(
      `update platform.platform_webauthn_challenge
          set consumed_at = now()
        where challenge_id = $1`,
      [challengeId],
    )

    // Mark session as MFA verified
    await client.query(
      `update platform.platform_session
          set mfa_verified_at = now()
        where id = $1`,
      [sessionId],
    )

    // Audit log registration
    await client.query(
      `insert into platform.platform_audit
         (user_id, feature, action, status, resource_type, resource_id, policy_decision)
       values ($1, 'platform_auth', 'webauthn_registered', 'success', 'credential', $2, 'allow')`,
      [userId, credential.id],
    )

    await client.query('commit')
    return { verified: true }
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

export async function generateAuthenticationChallenge(
  pool: Pool,
  userId: string,
  sessionId: string | null,
  purpose: 'authentication' | 'step_up',
  config = getWebAuthnConfig(),
) {
  const credentials = await getUserWebAuthnCredentials(pool, userId)
  if (credentials.length === 0) {
    throw new Error('No registered WebAuthn credentials found for this account.')
  }

  const options = await generateAuthenticationOptions({
    rpID: config.rpID,
    userVerification: 'required',
    allowCredentials: credentials.map((c) => ({
      id: c.credential_id,
      transports: (c.transports as any) || undefined,
    })),
  })

  // Purge expired challenges for user
  await pool.query(
    `delete from platform.platform_webauthn_challenge
      where user_id = $1 and (expires_at < now() or purpose = $2)`,
    [userId, purpose],
  )

  const challengeRes = await pool.query<{ challenge_id: string }>(
    `insert into platform.platform_webauthn_challenge
       (user_id, session_id, challenge, purpose, expected_origin, expected_rp_id, expires_at)
     values ($1, $2, $3, $4, $5, $6, now() + interval '5 minutes')
     returning challenge_id::text`,
    [userId, sessionId, options.challenge, purpose, config.expectedOrigin[0], config.rpID],
  )

  return {
    challengeId: challengeRes.rows[0]?.challenge_id ?? '',
    options,
  }
}

export async function verifyAuthenticationAssertion(
  pool: Pool,
  userId: string,
  sessionId: string,
  challengeId: string,
  response: AuthenticationResponseJSON,
  config = getWebAuthnConfig(),
): Promise<{ verified: boolean; error?: string }> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const challengeRow = (
      await client.query<{
        challenge: string
        expected_origin: string
        expected_rp_id: string
      }>(
        `select challenge, expected_origin, expected_rp_id
           from platform.platform_webauthn_challenge
          where challenge_id = $1
            and user_id = $2
            and consumed_at is null
            and expires_at > now()
          for update`,
        [challengeId, userId],
      )
    ).rows[0]

    if (!challengeRow) {
      await client.query('rollback')
      return { verified: false, error: 'WebAuthn challenge is invalid, expired, or already consumed.' }
    }

    const credentialRow = (
      await client.query<{
        credential_id: string
        public_key: Buffer
        counter: string
        transports: string[] | null
      }>(
        `select credential_id, public_key, counter, transports
           from platform.platform_webauthn_credential
          where credential_id = $1
            and user_id = $2
            and is_enabled = true
          for update`,
        [response.id, userId],
      )
    ).rows[0]

    if (!credentialRow) {
      await client.query('rollback')
      return { verified: false, error: 'Supplied credential was not found or is revoked.' }
    }

    let verification
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challengeRow.challenge,
        expectedOrigin: config.expectedOrigin,
        expectedRPID: challengeRow.expected_rp_id,
        credential: {
          id: credentialRow.credential_id,
          publicKey: new Uint8Array(credentialRow.public_key),
          counter: Number(credentialRow.counter),
          transports: (credentialRow.transports as any) || undefined,
        },
        requireUserVerification: true,
      })
    } catch (verifyError) {
      await client.query('rollback')
      return { verified: false, error: (verifyError as Error).message }
    }

    if (!verification.verified || !verification.authenticationInfo) {
      await client.query('rollback')
      return { verified: false, error: 'WebAuthn authentication verification failed.' }
    }

    const { newCounter } = verification.authenticationInfo

    // Counter rollback check: new counter must be greater than stored counter,
    // unless both are 0 (which authenticators without internal counters may use)
    if (newCounter < Number(credentialRow.counter)) {
      await client.query('rollback')
      return { verified: false, error: 'Signature counter rollback detected.' }
    }

    // Update credential counter and last used timestamp
    await client.query(
      `update platform.platform_webauthn_credential
          set counter = $1, last_used_at = now()
        where credential_id = $2`,
      [newCounter, credentialRow.credential_id],
    )

    // Mark challenge as consumed
    await client.query(
      `update platform.platform_webauthn_challenge
          set consumed_at = now()
        where challenge_id = $1`,
      [challengeId],
    )

    // Mark session as MFA verified
    await client.query(
      `update platform.platform_session
          set mfa_verified_at = now()
        where id = $1`,
      [sessionId],
    )

    // Audit log successful authentication
    await client.query(
      `insert into platform.platform_audit
         (user_id, feature, action, status, resource_type, resource_id, policy_decision)
       values ($1, 'platform_auth', 'webauthn_authenticated', 'success', 'credential', $2, 'allow')`,
      [userId, credentialRow.credential_id],
    )

    await client.query('commit')
    return { verified: true }
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

export async function assertPlatformLastOwner(
  client: PoolClient | Pool,
  targetUserId: string,
): Promise<void> {
  const result = await client.query<{ count: string }>(
    `with locked as (
       select id
         from platform.platform_user
        where role = 'platform_owner'
          and is_active = true
          and id <> $1
        for update
     )
     select count(*)::text as count from locked`,
    [targetUserId],
  )
  const remaining = Number(result.rows[0]?.count || 0)
  if (remaining < 1) {
    throw new Error('Operation not allowed: platform must retain at least one active platform_owner.')
  }
}

export async function disablePlatformUser(
  pool: Pool,
  targetUserId: string,
  operatorId?: string,
): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query('select pg_advisory_xact_lock(hashtext($1))', ['platform-owner-lock'])

    // Check if target is a platform owner and prevent demoting the last active owner
    const userRow = (
      await client.query<{ role: string; is_active: boolean }>(
        `select role, is_active from platform.platform_user where id = $1 for update`,
        [targetUserId],
      )
    ).rows[0]

    if (!userRow) throw new Error('User not found.')

    if (userRow.role === 'platform_owner') {
      await assertPlatformLastOwner(client, targetUserId)
    }

    // Set is_active = false
    await client.query(
      `update platform.platform_user set is_active = false, updated_at = now() where id = $1`,
      [targetUserId],
    )

    // Revoke all sessions immediately
    await client.query(
      `delete from platform.platform_session where user_id = $1`,
      [targetUserId],
    )

    // Revoke all challenges
    await client.query(
      `delete from platform.platform_webauthn_challenge where user_id = $1`,
      [targetUserId],
    )

    // Audit disable
    await client.query(
      `insert into platform.platform_audit
         (user_id, feature, action, status, resource_type, resource_id, policy_decision)
       values ($1, 'platform_user', 'user_disabled', 'success', 'platform_user', $2, 'allow')`,
      [operatorId || null, targetUserId],
    )

    await client.query('commit')
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}
