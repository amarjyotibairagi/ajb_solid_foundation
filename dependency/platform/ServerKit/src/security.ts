import crypto from 'node:crypto'

/** SHA-256 hex digest. Session, CSRF and invitation secrets are stored only in this form. */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex')
}

/** 256-bit URL-safe random token. */
export function createOpaqueToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url')
}

/** Constant-time string comparison that tolerates unequal lengths. */
export function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

/** The same argon2id parameters every BFF and operator CLI uses. */
export const ARGON2ID_OPTIONS = {
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 4,
} as const

/**
 * Fixed argon2id hash with no corresponding password. Verifying against it
 * for unknown accounts keeps response timing independent of account existence.
 */
export const DUMMY_ARGON2ID_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$I0N+o8ublxxav+2y4Y8i2w$nlO3lNc80nFf3w4J8B8q52D1jyzSZ3GIWOhFzUzNEHs'
