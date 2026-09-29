#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import argon2 from 'argon2'
import dotenv from 'dotenv'
import pg from 'pg'

if (process.env.NODE_ENV !== 'test') {
  dotenv.config({ path: path.resolve(fileURLToPath(new URL('..', import.meta.url)), '.env'), quiet: true })
}

const databaseUrl = process.env.TENANT_PROVISIONER_DATABASE_URL
if (!databaseUrl) {
  console.error('Error: TENANT_PROVISIONER_DATABASE_URL is required.')
  process.exit(1)
}

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
}

function parseArgs() {
  const args = process.argv.slice(2)
  const command = args[0]
  const options = {}
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=')
      if (eqIdx !== -1) {
        const key = arg.slice(2, eqIdx)
        const val = arg.slice(eqIdx + 1)
        options[key] = val
      } else {
        const key = arg.slice(2)
        const next = args[i + 1]
        if (next && !next.startsWith('--')) {
          options[key] = next
          i++
        } else {
          options[key] = true
        }
      }
    }
  }
  return { command, options }
}

function usage() {
  console.log(`
Usage: node scripts/tenant-operator.mjs <command> [options]

Commands:
  bootstrap-owner    Create first tenant_owner (fails if an owner already exists)
    --tenant <tenant-key>
    --username <username>
    --email <email>
    [--display-name <name>]
    [--password-fd <fd>]

  grant-owner        Grant tenant_owner role to an existing user
    --tenant <tenant-key>
    --username <username>

  transfer-owner     Transfer tenant ownership from one user to another
    --tenant <tenant-key>
    --from <username>
    --to <username>

  activate-user      Set user account status to 'active'
    --tenant <tenant-key>
    --username <username>

  disable-user       Set user account status to 'suspended' and revoke sessions
    --tenant <tenant-key>
    --username <username>

  reset-password     Reset user password and revoke existing sessions
    --tenant <tenant-key>
    --username <username>
    [--password-fd <fd>]

  revoke-sessions    Terminate all active sessions for a user
    --tenant <tenant-key>
    --username <username>
`)
}

async function readPassword(options) {
  if (options.password !== undefined) {
    throw new Error('Passing passwords in CLI arguments (--password) is prohibited for security. Use interactive TTY or --password-fd <fd>.')
  }

  if (options['password-fd'] !== undefined) {
    const fd = Number(options['password-fd'])
    if (Number.isNaN(fd)) throw new Error('Invalid --password-fd: must be a numeric file descriptor.')
    const buf = Buffer.alloc(2048)
    const bytesRead = fs.readSync(fd, buf, 0, 2048, null)
    const secret = buf.toString('utf8', 0, bytesRead).replace(/[\r\n]+$/, '')
    if (secret.length < 8) {
      throw new Error('Supplied password must be at least 8 characters.')
    }
    return secret
  }

  if (!process.stdin.isTTY) {
    throw new Error('Non-interactive environment requires --password-fd <fd> to supply credentials securely.')
  }

  const ask = (promptText) =>
    new Promise((resolve) => {
      process.stdout.write(promptText)
      let input = ''
      process.stdin.setRawMode(true)
      const onData = (chunk) => {
        const char = chunk.toString()
        if (char === '\n' || char === '\r' || char === '\u0004') {
          process.stdin.setRawMode(false)
          process.stdin.removeListener('data', onData)
          process.stdout.write('\n')
          resolve(input)
        } else if (char === '\u0003') {
          process.exit(1)
        } else if (char === '\b' || char === '\x7f') {
          input = input.slice(0, -1)
        } else {
          input += char
        }
      }
      process.stdin.on('data', onData)
    })

  const pw1 = await ask('Enter password: ')
  const pw2 = await ask('Confirm password: ')
  if (pw1 !== pw2) {
    throw new Error('Passwords do not match.')
  }
  if (pw1.length < 8) {
    throw new Error('Password must be at least 8 characters.')
  }
  return pw1
}

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 2,
  connectionTimeoutMillis: 5_000,
  query_timeout: 30_000,
})

async function assertProvisionerUser(client) {
  const result = await client.query('select current_user')
  const user = result.rows[0]?.current_user
  if (user !== 'tenant_provisioner_login' && user !== 'tenant_provisioner') {
    throw new Error(`TENANT_PROVISIONER_DATABASE_URL must authenticate as tenant_provisioner_login (got: ${user}).`)
  }
}

async function resolveTenant(client, tenantKey) {
  await client.query('set local role tenant_provisioner')
  const res = await client.query(
    `select tenant_id::text, tenant_key, slug, schema_identifier, lifecycle_status, schema_version
       from platform.tenant_registry
      where upper(tenant_key) = upper($1)
      limit 1`,
    [tenantKey],
  )
  const tenant = res.rows[0]
  if (!tenant) throw new Error(`Tenant key '${tenantKey}' not found.`)

  if (['deleted', 'deleting', 'migration_failed'].includes(tenant.lifecycle_status)) {
    throw new Error(`Tenant '${tenantKey}' is in invalid lifecycle status '${tenant.lifecycle_status}'.`)
  }
  return tenant
}

async function recordOperatorAudit(client, action, resourceType, resourceId, outcome = 'success', reason = null) {
  const operatorId = process.env.OPERATOR_ID || process.env.USER || 'cli-operator'
  await client.query(
    `insert into audit_event (actor_user_id, actor_type, operator_id, action, resource_type, resource_id, outcome, reason)
     values (null, 'operator', $1, $2, $3, $4, $5, $6)`,
    [operatorId, action, resourceType, resourceId, outcome, reason],
  )
}

async function main() {
  const { command, options } = parseArgs()
  if (!command || command === '--help' || command === 'help') {
    usage()
    process.exit(0)
  }

  if (options.password !== undefined) {
    console.error('Error: Passing passwords in CLI arguments (--password) is prohibited for security. Use interactive TTY or --password-fd <fd>.')
    process.exit(1)
  }

  const tenantKey = options.tenant
  if (!tenantKey) {
    console.error('Error: --tenant <tenant-key> is required.')
    usage()
    process.exit(1)
  }

  const client = await pool.connect()
  try {
    await assertProvisionerUser(client)
    await client.query('begin')

    const tenant = await resolveTenant(client, tenantKey)
    const schema = `"${tenant.schema_identifier.replace(/"/g, '""')}"`

    // Serialized tenant owner advisory lock
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`tenant-owner-lock:${tenant.tenant_key}`])

    await client.query('set local role tenant_template_owner')
    await client.query(`set local search_path = ${schema}, pg_catalog`)
    await client.query(`select set_config('app.tenant_id', $1, true)`, [tenant.tenant_id])

    if (command === 'bootstrap-owner') {
      const username = options.username?.trim().toLowerCase()
      const email = options.email?.trim().toLowerCase()
      const displayName = options['display-name']?.trim() || username
      if (!username || !email) {
        console.error('Error: --username and --email are required for bootstrap-owner.')
        process.exit(1)
      }

      // Assert no active tenant_owner exists
      const existingOwnerCheck = await client.query(
        `select count(distinct ra.user_id)::int as count
           from role_assignment ra
           join role_definition rd on rd.role_id = ra.role_id
           join user_account ua on ua.user_id = ra.user_id
          where rd.role_code = 'tenant_owner'
            and ua.account_status = 'active'
            and (ra.expires_at is null or ra.expires_at > now())`,
      )
      if (Number(existingOwnerCheck.rows[0]?.count || 0) > 0) {
        throw new Error(`Tenant '${tenant.tenant_key}' already has an active tenant_owner. Use 'grant-owner' or 'transfer-owner' instead.`)
      }

      const password = await readPassword(options)
      const passwordHash = await argon2.hash(password, ARGON2_OPTIONS)

      const roleRes = await client.query(
        `select role_id from role_definition where role_code = 'tenant_owner' limit 1`,
      )
      if (!roleRes.rows[0]) throw new Error('Role tenant_owner is missing from role_definition.')
      const ownerRoleId = roleRes.rows[0].role_id

      const existingUser = await client.query(
        `select user_id::text from user_account where lower(username) = lower($1) limit 1`,
        [username],
      )
      let userId
      if (existingUser.rows[0]) {
        userId = existingUser.rows[0].user_id
        await client.query(
          `update user_account
              set display_name = $1, email_normalized = lower($2), account_status = 'active', updated_at = now()
            where user_id = $3`,
          [displayName, email, userId],
        )
      } else {
        const insertRes = await client.query(
          `insert into user_account (username, display_name, email_normalized, account_status)
           values (lower($1), $2, lower($3), 'active')
           returning user_id::text`,
          [username, displayName, email],
        )
        userId = insertRes.rows[0].user_id
      }

      await client.query(
        `insert into user_identity (user_id, provider, provider_subject, credential_type, password_hash)
         values ($1, 'local', lower($2), 'password', $3)
         on conflict (provider, provider_subject) do update set
           user_id = excluded.user_id,
           credential_type = excluded.credential_type,
           password_hash = excluded.password_hash,
           last_authenticated_at = null`,
        [userId, username, passwordHash],
      )

      await client.query(
        `insert into role_assignment (user_id, role_id)
         values ($1, $2)
         on conflict (user_id, role_id) do nothing`,
        [userId, ownerRoleId],
      )

      await recordOperatorAudit(client, 'operator:bootstrap-owner', 'user_account', userId)
      await client.query('commit')
      console.log(`Successfully bootstrapped tenant_owner for tenant ${tenant.tenant_key}: user ${username}`)
      return
    }

    if (command === 'grant-owner') {
      const username = options.username?.trim().toLowerCase()
      if (!username) {
        console.error('Error: --username is required.')
        process.exit(1)
      }

      const userRes = await client.query(
        `select user_id::text, account_status from user_account where username = $1 for update`,
        [username],
      )
      const user = userRes.rows[0]
      if (!user) throw new Error(`User '${username}' not found in tenant '${tenant.tenant_key}'.`)
      if (user.account_status !== 'active') throw new Error(`User '${username}' is not active (status: ${user.account_status}).`)

      const roleRes = await client.query(
        `select role_id from role_definition where role_code = 'tenant_owner' limit 1`,
      )
      if (!roleRes.rows[0]) throw new Error('Role tenant_owner is missing.')

      await client.query(
        `insert into role_assignment (user_id, role_id)
         values ($1, $2)
         on conflict (user_id, role_id) do update set expires_at = null`,
        [user.user_id, roleRes.rows[0].role_id],
      )

      await recordOperatorAudit(client, 'operator:grant-owner', 'role_assignment', user.user_id)
      await client.query('commit')
      console.log(`Granted tenant_owner to user '${username}' in tenant '${tenant.tenant_key}'.`)
      return
    }

    if (command === 'transfer-owner') {
      const fromUsername = options.from?.trim().toLowerCase()
      const toUsername = options.to?.trim().toLowerCase()
      if (!fromUsername || !toUsername) {
        console.error('Error: --from and --to usernames are required for transfer-owner.')
        process.exit(1)
      }
      if (fromUsername === toUsername) {
        throw new Error('Cannot transfer ownership to the same user.')
      }

      const fromUserRes = await client.query(
        `select user_id::text, account_status from user_account where username = $1 for update`,
        [fromUsername],
      )
      const fromUser = fromUserRes.rows[0]
      if (!fromUser) throw new Error(`User '${fromUsername}' not found.`)

      const toUserRes = await client.query(
        `select user_id::text, account_status from user_account where username = $1 for update`,
        [toUsername],
      )
      const toUser = toUserRes.rows[0]
      if (!toUser) throw new Error(`User '${toUsername}' not found.`)
      if (toUser.account_status !== 'active') throw new Error(`Target user '${toUsername}' is not active.`)

      const ownerRoleRes = await client.query(`select role_id from role_definition where role_code = 'tenant_owner' limit 1`)
      const adminRoleRes = await client.query(`select role_id from role_definition where role_code = 'tenant_admin' limit 1`)
      const ownerRoleId = ownerRoleRes.rows[0].role_id
      const adminRoleId = adminRoleRes.rows[0].role_id

      // Promote toUser to owner
      await client.query(
        `insert into role_assignment (user_id, role_id) values ($1, $2)
         on conflict (user_id, role_id) do update set expires_at = null`,
        [toUser.user_id, ownerRoleId],
      )

      // Demote fromUser to admin
      await client.query(`delete from role_assignment where user_id = $1 and role_id = $2`, [fromUser.user_id, ownerRoleId])
      await client.query(
        `insert into role_assignment (user_id, role_id) values ($1, $2)
         on conflict (user_id, role_id) do nothing`,
        [fromUser.user_id, adminRoleId],
      )

      // Invariant check: remaining active owners must be >= 1
      const activeOwnersCheck = await client.query(
        `select count(distinct ra.user_id)::int as count
           from role_assignment ra
           join role_definition rd on rd.role_id = ra.role_id
           join user_account ua on ua.user_id = ra.user_id
          where rd.role_code = 'tenant_owner'
            and ua.account_status = 'active'
            and (ra.expires_at is null or ra.expires_at > now())`,
      )
      if (Number(activeOwnersCheck.rows[0]?.count || 0) < 1) {
        throw new Error('Owner transfer failed: tenant must retain at least one active tenant_owner.')
      }

      await recordOperatorAudit(client, 'operator:transfer-owner', 'role_assignment', toUser.user_id)
      await client.query('commit')
      console.log(`Transferred tenant_owner from '${fromUsername}' to '${toUsername}' in tenant '${tenant.tenant_key}'.`)
      return
    }

    const username = options.username?.trim().toLowerCase()
    if (!username) {
      console.error('Error: --username is required.')
      process.exit(1)
    }

    const userRes = await client.query(
      `select user_id::text, account_status from user_account where username = $1 for update`,
      [username],
    )
    const user = userRes.rows[0]
    if (!user) throw new Error(`User '${username}' not found in tenant '${tenant.tenant_key}'.`)

    if (command === 'activate-user') {
      const identityRes = await client.query(
        `select 1 from user_identity where user_id = $1 and password_hash is not null limit 1`,
        [user.user_id],
      )
      if (identityRes.rows.length === 0) {
        throw new Error(`Cannot activate user '${username}': user has no valid credentials set.`)
      }

      await client.query(`update user_account set account_status = 'active', updated_at = now() where user_id = $1`, [user.user_id])
      await recordOperatorAudit(client, 'operator:activate-user', 'user_account', user.user_id)
      await client.query('commit')
      console.log(`User '${username}' in tenant '${tenant.tenant_key}' is now active.`)
      return
    }

    if (command === 'disable-user') {
      // Check last owner protection if user is owner
      const userIsOwner = (
        await client.query(
          `select 1 from role_assignment ra join role_definition rd on rd.role_id = ra.role_id
            where ra.user_id = $1 and rd.role_code = 'tenant_owner'`,
          [user.user_id],
        )
      ).rows.length > 0

      if (userIsOwner) {
        const ownerCheck = await client.query(
          `select count(distinct ra.user_id)::int as count
             from role_assignment ra
             join role_definition rd on rd.role_id = ra.role_id
             join user_account ua on ua.user_id = ra.user_id
            where rd.role_code = 'tenant_owner'
              and ua.account_status = 'active'
              and ua.user_id <> $1
              and (ra.expires_at is null or ra.expires_at > now())`,
          [user.user_id],
        )
        if (Number(ownerCheck.rows[0]?.count || 0) < 1) {
          throw new Error(`Cannot disable user '${username}': tenant workspace must retain at least one active tenant_owner.`)
        }
      }

      // Valid account status is 'suspended'
      await client.query(`update user_account set account_status = 'suspended', updated_at = now() where user_id = $1`, [user.user_id])
      await client.query(`delete from user_session where user_id = $1`, [user.user_id])
      await recordOperatorAudit(client, 'operator:disable-user', 'user_account', user.user_id)
      await client.query('commit')
      console.log(`User '${username}' in tenant '${tenant.tenant_key}' suspended and sessions revoked.`)
      return
    }

    if (command === 'reset-password') {
      const password = await readPassword(options)
      const hash = await argon2.hash(password, ARGON2_OPTIONS)
      await client.query(
        `insert into user_identity (user_id, provider, provider_subject, credential_type, password_hash)
         values ($1, 'local', lower($2), 'password', $3)
         on conflict (provider, provider_subject) do update set
           credential_type = 'password',
           password_hash = excluded.password_hash,
           last_authenticated_at = null`,
        [user.user_id, username, hash],
      )
      await client.query(`delete from user_session where user_id = $1`, [user.user_id])
      await recordOperatorAudit(client, 'operator:reset-password', 'user_identity', user.user_id)
      await client.query('commit')
      console.log(`Password reset for user '${username}' in tenant '${tenant.tenant_key}'. Sessions revoked.`)
      return
    }

    if (command === 'revoke-sessions') {
      const del = await client.query(`delete from user_session where user_id = $1`, [user.user_id])
      await recordOperatorAudit(client, 'operator:revoke-sessions', 'user_session', user.user_id)
      await client.query('commit')
      console.log(`Revoked ${del.rowCount} session(s) for user '${username}' in tenant '${tenant.tenant_key}'.`)
      return
    }

    console.error(`Unknown command: ${command}`)
    usage()
    process.exit(1)
  } catch (error) {
    await client.query('rollback').catch(() => {})
    console.error(`Error: ${error.message}`)
    process.exit(1)
  } finally {
    client.release()
    await pool.end()
  }
}

main()
