import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

describe('Unit: Turnstile Siteverify Scenarios', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  async function verifyTurnstileLogic(token, remoteIp, secretKey, expectedHostname, expectedAction = 'login', isProduction = true) {
    if (!secretKey) return !isProduction
    try {
      const body = new URLSearchParams({ secret: secretKey, response: token })
      if (remoteIp) body.set('remoteip', remoteIp)
      const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(8_000),
      })
      if (!response.ok) return false
      const result = await response.json()
      return (
        result.success === true &&
        (!isProduction || (result.action === expectedAction && result.hostname === expectedHostname))
      )
    } catch {
      return false
    }
  }

  const secretKey = '0x4AAAAAAtestkey1234567890'
  const validHostname = 'tenant1.example.com'

  test('valid siteverify token with matching action and hostname returns true', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        success: true,
        action: 'login',
        hostname: validHostname,
      }),
    })

    const verified = await verifyTurnstileLogic('valid-token', '127.0.0.1', secretKey, validHostname)
    assert.equal(verified, true)
  })

  test('rejected token (success=false) returns false', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        success: false,
        'error-codes': ['invalid-input-response'],
      }),
    })

    const verified = await verifyTurnstileLogic('invalid-token', '127.0.0.1', secretKey, validHostname)
    assert.equal(verified, false)
  })

  test('token with wrong action returns false', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        success: true,
        action: 'password_reset',
        hostname: validHostname,
      }),
    })

    const verified = await verifyTurnstileLogic('wrong-action-token', '127.0.0.1', secretKey, validHostname)
    assert.equal(verified, false)
  })

  test('token with wrong hostname returns false', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        success: true,
        action: 'login',
        hostname: 'malicious.attacker.com',
      }),
    })

    const verified = await verifyTurnstileLogic('wrong-host-token', '127.0.0.1', secretKey, validHostname)
    assert.equal(verified, false)
  })

  test('HTTP non-OK status returns false', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 500,
    })

    const verified = await verifyTurnstileLogic('server-error-token', '127.0.0.1', secretKey, validHostname)
    assert.equal(verified, false)
  })

  test('malformed JSON response fails closed and returns false', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => {
        throw new Error('Unexpected token < in JSON at position 0')
      },
    })

    const verified = await verifyTurnstileLogic('malformed-token', '127.0.0.1', secretKey, validHostname)
    assert.equal(verified, false)
  })

  test('request timeout fails closed and returns false', async () => {
    globalThis.fetch = async () => {
      const err = new Error('The operation was aborted due to timeout')
      err.name = 'TimeoutError'
      throw err
    }

    const verified = await verifyTurnstileLogic('timeout-token', '127.0.0.1', secretKey, validHostname)
    assert.equal(verified, false)
  })

  test('network failure fails closed and returns false', async () => {
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed: ECONNREFUSED')
    }

    const verified = await verifyTurnstileLogic('network-fail-token', '127.0.0.1', secretKey, validHostname)
    assert.equal(verified, false)
  })
})
