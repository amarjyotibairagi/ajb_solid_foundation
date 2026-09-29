import { createCredential, getAssertion } from './webauthn'

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
  }
}

export type AdminApi = {
  get<T = any>(url: string): Promise<T>
  send<T = any>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<T>
  registerSecurityKey(): Promise<void>
  stepUp(): Promise<void>
}

/**
 * Same-origin JSON client for the platform BFF. Mutations carry the session
 * CSRF token. When the server answers MFA_STEP_UP_REQUIRED, the client runs a
 * WebAuthn assertion (or enrolment, if the operator has no key yet) and
 * retries the request once, so every admin action gets step-up for free.
 */
export function createAdminApi(csrfToken: string | null, onUnauthorized: () => void): AdminApi {
  const raw = async (method: string, url: string, body?: unknown) => {
    const headers: Record<string, string> = {}
    if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const response = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (response.status === 401) onUnauthorized()
    const data = await response.json().catch(() => ({}))
    if (!response.ok || data.success === false) {
      throw new ApiError(data.message || `Request failed (${response.status}).`, response.status, data.code)
    }
    return data
  }

  const registerSecurityKey = async () => {
    const { challengeId, options } = await raw('POST', '/api/auth/mfa/registration/options')
    const response = await createCredential(options)
    await raw('POST', '/api/auth/mfa/registration/verify', { challengeId, response })
  }

  const stepUp = async () => {
    let started
    try {
      started = await raw('POST', '/api/auth/mfa/assertion/options')
    } catch (error) {
      // No key enrolled yet: enrolment itself verifies the operator.
      if (error instanceof ApiError && /No registered WebAuthn credentials/.test(error.message)) {
        await registerSecurityKey()
        return
      }
      throw error
    }
    const response = await getAssertion(started.options)
    await raw('POST', '/api/auth/mfa/assertion/verify', { challengeId: started.challengeId, response })
  }

  return {
    get: (url) => raw('GET', url),
    async send(method, url, body) {
      try {
        return await raw(method, url, body)
      } catch (error) {
        if (error instanceof ApiError && error.code === 'MFA_STEP_UP_REQUIRED') {
          await stepUp()
          return raw(method, url, body)
        }
        throw error
      }
    },
    registerSecurityKey,
    stepUp,
  }
}
