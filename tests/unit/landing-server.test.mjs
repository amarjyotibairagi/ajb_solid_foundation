import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createLandingServer } from '../../scripts/serve-landing.mjs'

function makeRequest(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
    }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('Landing Server Resilience', () => {
  test('handles malformed percent escape and invalid UTF-8 without crashing', async () => {
    const server = createLandingServer()
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port

    try {
      // Malformed percent escape
      const res1 = await makeRequest(port, '/%')
      assert.equal(res1.statusCode, 400)
      assert.equal(res1.body, 'Bad Request')

      // Invalid UTF-8 sequence
      const res2 = await makeRequest(port, '/%E0%A0%80')
      assert.ok([200, 400].includes(res2.statusCode))

      // Traversal attempt stays within bounds / fallback
      const res3 = await makeRequest(port, '/../../../../etc/passwd')
      assert.ok(res3.statusCode === 200 || res3.statusCode === 400)

      // Server remains alive and handles health check
      const healthRes = await makeRequest(port, '/api/health')
      assert.equal(healthRes.statusCode, 200)
      assert.deepEqual(JSON.parse(healthRes.body), { success: true, status: 'ok' })
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
