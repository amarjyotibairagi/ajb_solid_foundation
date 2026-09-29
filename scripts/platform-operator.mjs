#!/usr/bin/env node
// Break-glass CLI for platform control-plane accounts.
//
// Password hashing happens here, in Node, with argon2id -- the same parameters
// the tenant and public BFFs use. Nothing sends a plaintext password to the
// database server, which is the defect this replaces: the platform BFF used to
// verify credentials with pgcrypto's crypt() over a bind parameter, putting
// operator passwords in reach of statement logging and pg_stat_activity.
//
// Reads DATABASE_ADMIN_URL, never a BFF runtime role.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import argon2 from 'argon2'
import dotenv from 'dotenv'
import pg from 'pg'

const rootDirectory = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
if (process.env.NODE_ENV !== 'test') {
  dotenv.config({ path: path.join(rootDirectory, '.env'), quiet: true })
}

export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
}

const PLATFORM_ROLES = ['platform_owner', 'platform_admin', 'platform_viewer']

function parseArgs(argv) {
  const command = argv[0]
  const options = {}
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const equals = arg.indexOf('=')
    if (equals !== -1) {
      options[arg.slice(2, equals)] = arg.slice(equals + 1)
      continue
    }
    const key = arg.slice(2)
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      options[key] = next
      index += 1
    } else {
      options[key] = true
    }
  }
  return { command, options }
}

function usage() {
  console.log(`
Usage: node scripts/platform-operator.mjs <command> [options]

Commands:
  set-password       Replace an operator's password with a fresh argon2id hash
    --username <name>
    [--password-fd <fd>]      read the password from a file descriptor
    [--generate]              generate a strong password and print it once

  create-operator    Create a platform operator account
    --username <name>
    --role <${PLATFORM_ROLES.join('|')}>
    [--display-name <name>]
    [--password-fd <fd>] | [--generate]

  list-operators     Show accounts, roles, status, and password hash format

  audit-hashes       Exit non-zero if any account is not argon2id

A password is never accepted as a command-line argument: argv is visible to
every process on the host and is captured by the platform's own /api/system
process listing. Use --password-fd or --generate.
`)
}

function readPasswordFromFd(fd) {
  const descriptor = Number(fd)
  if (!Number.isInteger(descriptor) || descriptor < 0) {
    throw new Error('--password-fd must be a non-negative integer file descriptor.')
  }
  const chunks = []
  const buffer = Buffer.alloc(4096)
  for (;;) {
    let read = 0
    try {
      read = fs.readSync(descriptor, buffer, 0, buffer.length, null)
    } catch (error) {
      if (error.code === 'EAGAIN') continue
      if (error.code === 'EOF') break
      throw error
    }
    if (read === 0) break
    chunks.push(Buffer.from(buffer.subarray(0, read)))
  }
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
}

function generatePassword() {
  // 30 base64url characters -> ~180 bits of entropy.
  return crypto.randomBytes(24).toString('base64url').slice(0, 30)
}

async function resolvePassword(options) {
  if (options.generate) {
    const generated = generatePassword()
    return { password: generated, generated: true }
  }
  if (options['password-fd'] !== undefined) {
    const password = readPasswordFromFd(options['password-fd'])
    if (password.length < 16) throw new Error('Password must be at least 16 characters.')
    return { password, generated: false }
  }
  throw new Error('Provide --password-fd <fd> or --generate.')
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2))
  if (!command || command === 'help' || options.help) {
    usage()
    return 0
  }

  const databaseUrl = process.env.DATABASE_ADMIN_URL || process.env.TEST_DATABASE_URL
  if (!databaseUrl) {
    console.error('Error: DATABASE_ADMIN_URL is required.')
    return 1
  }

  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 })
  await client.connect()

  try {
    if (command === 'list-operators') {
      const result = await client.query(
        `select username, role, is_active,
                case
                  when password_hash is null then 'none'
                  when password_hash like '$argon2id$%' then 'argon2id'
                  when password_hash ~ '^\\$2[aby]\\$' then 'bcrypt cost ' || substring(password_hash from 5 for 2)
                  else 'unknown'
                end as hash_format
           from platform.platform_user
          order by role, username`,
      )
      console.table(result.rows)
      return 0
    }

    if (command === 'audit-hashes') {
      const result = await client.query(
        // An inactive account with no hash is a pending admin-panel
        // invitation (migration 026); it cannot authenticate until accepted.
        `select username, role from platform.platform_user
          where (password_hash is null and is_active)
             or (password_hash is not null and password_hash not like '$argon2id$%')
          order by username`,
      )
      if (result.rows.length === 0) {
        console.log('[platform-operator] All operator accounts use argon2id.')
        return 0
      }
      console.error('[platform-operator] Accounts not using argon2id:')
      for (const row of result.rows) console.error(`  ${row.username} (${row.role})`)
      return 1
    }

    if (command === 'set-password' || command === 'create-operator') {
      const username = typeof options.username === 'string' ? options.username.trim() : ''
      if (!username) throw new Error('--username is required.')

      const { password, generated } = await resolvePassword(options)
      const passwordHash = await argon2.hash(password, ARGON2_OPTIONS)

      if (command === 'create-operator') {
        const role = typeof options.role === 'string' ? options.role : ''
        if (!PLATFORM_ROLES.includes(role)) {
          throw new Error(`--role must be one of: ${PLATFORM_ROLES.join(', ')}`)
        }
        const displayName =
          typeof options['display-name'] === 'string' ? options['display-name'] : username
        await client.query(
          `insert into platform.platform_user (username, password_hash, role, display_name, is_active)
           values ($1, $2, $3, $4, true)`,
          [username, passwordHash, role, displayName],
        )
        console.log(`[platform-operator] Created ${role} account "${username}".`)
      } else {
        const result = await client.query(
          `update platform.platform_user
              set password_hash = $2
            where lower(username) = lower($1)
            returning username, role`,
          [username, passwordHash],
        )
        if (result.rowCount === 0) throw new Error(`No platform account named "${username}".`)
        // A password change must not leave old sessions authenticated.
        const revoked = await client.query(
          `delete from platform.platform_session s
            using platform.platform_user u
            where s.user_id = u.id and lower(u.username) = lower($1)`,
          [username],
        )
        console.log(
          `[platform-operator] Reset password for "${result.rows[0].username}" (${result.rows[0].role}); revoked ${revoked.rowCount} session(s).`,
        )
      }

      if (generated) {
        console.log('')
        console.log('  Generated password (shown once, store it in your password manager):')
        console.log(`    ${password}`)
        console.log('')
      }
      return 0
    }

    usage()
    return 1
  } finally {
    await client.end()
  }
}

const code = await main().catch((error) => {
  console.error(`[platform-operator] ${error.message}`)
  return 1
})
process.exit(code)
