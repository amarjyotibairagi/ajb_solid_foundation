type State = {
  failureCount: number
  windowStart: number
  lockedUntil: number | null
}

export type ThrottlePolicy = {
  maximumFailures?: number
  lockoutMs?: number
}

/**
 * Per-account failed-login throttle, independent of per-IP rate limiting.
 * In-memory and per-process: state resets on restart and is not shared across
 * instances (see docs/architecture/adr-001-tenancy-scaling-tiers.md).
 */
export class LoginThrottle {
  private readonly states = new Map<string, State>()

  constructor(
    private readonly maximumFailures = 10,
    private readonly windowMs = 15 * 60 * 1000,
    private readonly lockoutMs = 15 * 60 * 1000,
    private readonly maximumEntries = 10_000,
  ) {}

  allowed(rawKey: string): boolean {
    const state = this.states.get(this.key(rawKey))
    return !state?.lockedUntil || state.lockedUntil <= Date.now()
  }

  /** Records a failure. A policy overrides the constructor defaults, e.g. from tenant configuration. */
  failure(rawKey: string, policy: ThrottlePolicy = {}): void {
    const key = this.key(rawKey)
    const now = Date.now()
    let state = this.states.get(key)
    if (!state || now - state.windowStart > this.windowMs) {
      state = { failureCount: 0, windowStart: now, lockedUntil: null }
    }
    state.failureCount += 1
    if (state.failureCount >= (policy.maximumFailures ?? this.maximumFailures)) {
      state.lockedUntil = now + (policy.lockoutMs ?? this.lockoutMs)
    }
    this.states.set(key, state)
    if (this.states.size > this.maximumEntries) {
      const oldest = this.states.keys().next().value
      if (oldest) this.states.delete(oldest)
    }
  }

  success(rawKey: string): void {
    this.states.delete(this.key(rawKey))
  }

  private key(value: string): string {
    return value.trim().toLowerCase()
  }
}
