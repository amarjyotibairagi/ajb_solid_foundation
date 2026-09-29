#!/usr/bin/env node
// Prints a PostgreSQL SCRAM-SHA-256 verifier for the password read from stdin.
// The same verifier is used for ALTER ROLE ... PASSWORD and the PgBouncer
// auth file, so PgBouncer can authenticate to PostgreSQL with it.
import crypto from 'node:crypto'
import fs from 'node:fs'

const password = fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '')
if (!password) {
  console.error('scram: empty password on stdin')
  process.exit(1)
}
const iterations = 4096
const salt = crypto.randomBytes(16)
const saltedPassword = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256')
const clientKey = crypto.createHmac('sha256', saltedPassword).update('Client Key').digest()
const storedKey = crypto.createHash('sha256').update(clientKey).digest()
const serverKey = crypto.createHmac('sha256', saltedPassword).update('Server Key').digest()
process.stdout.write(`SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}\n`)
