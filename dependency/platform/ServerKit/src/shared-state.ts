import crypto from 'node:crypto'
import { LoginThrottle, type ThrottlePolicy } from './login-throttle.js'

/**
 * State that must be shared when a surface runs more than one process:
 * per-account login throttles and request rate limits. Select with
 * SHARED_STATE_BACKEND:
 *   memory   (default) per-process, correct for a single process per surface;
 *   postgres counters in the UNLOGGED shared_state schema (migration 030),
 *            correct for any number of processes on any number of hosts.
 * Each database identity sees only its own keys (the functions namespace
 * every key by the connecting login, session_user).
 */
export type Queryable = { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }

export type SharedStateBackend = 'memory' | 'postgres'

export function sharedStateBackend(): SharedStateBackend {
  const value = (process.env.SHARED_STATE_BACKEND || 'memory').trim().toLowerCase()
  if (value !== 'memory' && value !== 'postgres') throw new Error('SHARED_STATE_BACKEND must be memory or postgres.')
  return value
}

export interface ThrottleStore {
  allowed(key: string): Promise<boolean>
  failure(key: string, policy?: ThrottlePolicy): Promise<void>
  success(key: string): Promise<void>
}

export class MemoryThrottleStore implements ThrottleStore {
  constructor(private readonly throttle = new LoginThrottle()) {}
  async allowed(key: string) {
    return this.throttle.allowed(key)
  }
  async failure(key: string, policy: ThrottlePolicy = {}) {
    this.throttle.failure(key, policy)
  }
  async success(key: string) {
    this.throttle.success(key)
  }
}

export class PostgresThrottleStore implements ThrottleStore {
  constructor(
    private readonly db: Queryable,
    private readonly defaults = { maximumFailures: 10, windowMs: 15 * 60_000, lockoutMs: 15 * 60_000 },
  ) {}

  private key(raw: string) {
    return `login:${raw.trim().toLowerCase()}`
  }

  async allowed(key: string) {
    const result = await this.db.query('select shared_state.throttle_locked($1) as locked', [this.key(key)])
    return result.rows[0]?.locked !== true
  }

  async failure(key: string, policy: ThrottlePolicy = {}) {
    await this.db.query('select shared_state.throttle_failure($1, $2, $3, $4)', [
      this.key(key),
      this.defaults.windowMs,
      policy.maximumFailures ?? this.defaults.maximumFailures,
      policy.lockoutMs ?? this.defaults.lockoutMs,
    ])
  }

  async success(key: string) {
    await this.db.query('select shared_state.throttle_clear($1)', [this.key(key)])
  }
}

export function createThrottleStore(db: Queryable): ThrottleStore {
  return sharedStateBackend() === 'postgres' ? new PostgresThrottleStore(db) : new MemoryThrottleStore()
}

type RateLimitCallback = (error: Error | null, result?: { current: number; ttl: number }) => void

/**
 * A @fastify/rate-limit store class bound to a database connection. Register
 * with `{ store: createSharedRateLimitStore(pool), skipOnError: true }` so an
 * outage of the counter table degrades to no limiting rather than to errors.
 */
export function createSharedRateLimitStore(db: Queryable) {
  return class SharedRateLimitStore {
    constructor(
      _options: unknown,
      readonly namespace = 'global',
    ) {}

    incr(key: string, callback: RateLimitCallback, timeWindow: number) {
      db.query('select hits, ttl_ms from shared_state.rate_hit($1, $2)', [`rl:${this.namespace}:${key}`, Math.ceil(timeWindow)])
        .then((result) => callback(null, { current: Number(result.rows[0]?.hits ?? 1), ttl: Number(result.rows[0]?.ttl_ms ?? timeWindow) }))
        .catch((error: Error) => callback(error))
    }

    read(key: string, callback: RateLimitCallback) {
      db.query('select hits, ttl_ms from shared_state.rate_peek($1)', [`rl:${this.namespace}:${key}`])
        .then((result) => callback(null, { current: Number(result.rows[0]?.hits ?? 0), ttl: Number(result.rows[0]?.ttl_ms ?? 0) }))
        .catch((error: Error) => callback(error))
    }

    child(routeOptions: object) {
      // At runtime the plugin passes merged params with `routeInfo`; its type
      // declarations describe the route options directly. Accept both.
      const options = routeOptions as { routeInfo?: { method?: string | string[]; url?: string }; method?: string | string[]; url?: string }
      const info = options.routeInfo?.url ? options.routeInfo : options
      const method = Array.isArray(info.method) ? info.method.join(',') : info.method
      return new SharedRateLimitStore(routeOptions, `${method || 'any'}:${info.url || 'global'}`)
    }
  }
}

/**
 * Stateless per-session CSRF token: HMAC(secret, session token hash). Every
 * process derives the same token for the same session, so no process-local
 * cache is needed and multiple tabs and processes agree.
 */
export function deriveCsrfToken(secret: string, sessionTokenHash: string): string {
  return crypto.createHmac('sha256', secret).update(`csrf:v1:${sessionTokenHash}`).digest('base64url')
}
