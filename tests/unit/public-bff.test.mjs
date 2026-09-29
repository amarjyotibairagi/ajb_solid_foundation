import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../backend/public/dist/server.js';

describe('Public BFF Unit Tests', () => {
  test('GET /api/health returns consumer domain status ok', async () => {
    const server = await createServer();
    try {
      const response = await server.inject({
        method: 'GET',
        url: '/api/health',
      });

      assert.strictEqual(response.statusCode, 200);
      const body = JSON.parse(response.payload);
      assert.strictEqual(body.success, true);
      assert.strictEqual(body.domain, 'consumer');
      assert.strictEqual(body.status, 'ok');
    } finally {
      await server.close();
    }
  });

  test('GET /api/v1/subscriptions/plans returns 4 tiers (free, plus, pro, ultra)', async () => {
    const server = await createServer();
    try {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/subscriptions/plans',
      });

      assert.strictEqual(response.statusCode, 200);
      const body = JSON.parse(response.payload);
      assert.strictEqual(body.success, true);
      assert.strictEqual(body.plans.length, 4);
      const planCodes = body.plans.map((p) => p.code);
      assert.deepStrictEqual(planCodes, ['free', 'plus', 'pro', 'ultra']);
    } finally {
      await server.close();
    }
  });

  test('GET /api/v1/auth/session returns unauthenticated session by default', async () => {
    const server = await createServer();
    try {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/auth/session',
      });

      assert.strictEqual(response.statusCode, 200);
      const body = JSON.parse(response.payload);
      assert.strictEqual(body.success, true);
      assert.strictEqual(body.authenticated, false);
      assert.strictEqual(body.csrfToken, null);
    } finally {
      await server.close();
    }
  });
});
