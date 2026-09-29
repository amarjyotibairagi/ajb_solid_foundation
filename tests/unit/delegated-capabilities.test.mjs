import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DELEGATABLE_PERMISSION_CODES,
  isDelegatablePermission,
} from '../../backend/tenant/dist/delegated-capabilities.js'

describe('Delegated capability policy', () => {
  test('has the exact narrow allow-list', () => {
    assert.deepEqual([...DELEGATABLE_PERMISSION_CODES], [
      'tenant.modules.author',
      'tenant.modules.assign',
    ])
    assert.equal(isDelegatablePermission('tenant.modules.author'), true)
    assert.equal(isDelegatablePermission('tenant.modules.assign'), true)
    assert.equal(isDelegatablePermission('tenant.users.roles'), false)
    assert.equal(isDelegatablePermission('tenant.delegations.manage'), false)
    assert.equal(isDelegatablePermission('platform.admin'), false)
  })
})
