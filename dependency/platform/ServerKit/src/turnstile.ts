export type TurnstileOptions = {
  secret: string
  token: string
  remoteIp?: string | undefined
  /** When set, the token must have been issued on this hostname. */
  expectedHostname?: string | undefined
  /** When set, the token must carry this widget action. */
  expectedAction?: string | undefined
  timeoutMs?: number
}

export type TurnstileResult = {
  ok: boolean
  errorCodes: string[]
  hostname: string | null
  action: string | null
}

/** Server-side Cloudflare Turnstile verification. Never throws; network errors fail closed. */
export async function verifyTurnstileToken(options: TurnstileOptions): Promise<TurnstileResult> {
  const body = new URLSearchParams({ secret: options.secret, response: options.token })
  if (options.remoteIp) body.set('remoteip', options.remoteIp)
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
    })
    if (!response.ok) return { ok: false, errorCodes: [`http_${response.status}`], hostname: null, action: null }
    const result = (await response.json()) as {
      success?: boolean
      'error-codes'?: string[]
      hostname?: string
      action?: string
    }
    const hostname = result.hostname ?? null
    const action = result.action ?? null
    const ok =
      result.success === true &&
      (options.expectedHostname === undefined || hostname === options.expectedHostname) &&
      (options.expectedAction === undefined || action === options.expectedAction)
    return { ok, errorCodes: result['error-codes'] ?? [], hostname, action }
  } catch {
    return { ok: false, errorCodes: ['network_error'], hostname: null, action: null }
  }
}
