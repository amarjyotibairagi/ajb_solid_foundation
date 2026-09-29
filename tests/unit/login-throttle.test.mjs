import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { LoginThrottle as PublicLoginThrottle } from '../../backend/public/dist/login-throttle.js'
import { LoginThrottle as TenantLoginThrottle } from '../../backend/tenant/dist/login-throttle.js'

for (const [name, LoginThrottle] of [
  ['public', PublicLoginThrottle],
  ['tenant', TenantLoginThrottle],
]) {
  describe(`${name} account login throttle`, () => {
    test('locks a normalized account key after the configured failure count', () => {
      const throttle = new LoginThrottle(2, 60_000, 60_000, 100)
      assert.equal(throttle.allowed('Example.User'), true)
      throttle.failure('example.user')
      assert.equal(throttle.allowed('EXAMPLE.USER'), true)
      throttle.failure(' example.user ')
      assert.equal(throttle.allowed('example.user'), false)
    })

    test('successful authentication clears prior failures', () => {
      const throttle = new LoginThrottle(2, 60_000, 60_000, 100)
      throttle.failure('account')
      throttle.success('ACCOUNT')
      throttle.failure('account')
      assert.equal(throttle.allowed('account'), true)
    })
  })
}
