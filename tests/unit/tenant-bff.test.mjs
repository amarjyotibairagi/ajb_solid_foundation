import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../backend/tenant/dist/server.js';
import {
  normalizeTenantHostname,
  publicTenantBootstrap,
  TenantResolver,
} from '../../backend/tenant/dist/tenant-context.js';
import { testTenants } from '../helpers/fixture.mjs';

describe('Tenant BFF Unit Tests', () => {
  test('normalizes a DNS hostname without accepting malformed input', () => {
    assert.equal(normalizeTenantHostname('ALPHA.sandbox.test:443'), 'alpha.sandbox.test');
    assert.equal(normalizeTenantHostname('alpha.sandbox.test.'), 'alpha.sandbox.test');
    assert.equal(normalizeTenantHostname('alpha..sandbox.test'), null);
    assert.equal(normalizeTenantHostname('alpha.sandbox.test/path'), null);
  });

  test('resolves only an exact active registry hostname', async () => {
    const pool = {
      async query(_sql, values) {
        assert.deepEqual(values, ['alpha.sandbox.test']);
        return {
          rows: [{
            tenant_id: '00000000-0000-4000-8000-000000000101',
            tenant_key: 'TALPHAEXAMPLE000000000',
            display_name: 'Alpha Test Org',
            schema_identifier: 'tenant_alpha',
            db_role: 'tenant_alpha_runtime',
            login_role: 'tenant_alpha_login',
            credential_ref: 'TALPHAEXAMPLE000000000',
            lifecycle_status: 'active',
            schema_version: 7,
            hostname: 'alpha.sandbox.test',
            subdomain: 'alpha',
            domain_status: 'active',
            logo_url: null,
            primary_color: '#2563eb',
            secondary_color: '#0f172a',
            login_background: null,
            login_message: null,
            default_locale: 'en',
            safe_metadata: {},
          }],
        };
      },
    };
    const resolver = new TenantResolver(pool, 'sandbox.test');
    const context = await resolver.resolve('ALPHA.sandbox.test:443');

    assert.equal(context.tenantKey, 'TALPHAEXAMPLE000000000');
    assert.equal(context.schemaName, 'tenant_alpha');
    assert.equal(await resolver.resolve('sandbox.test'), null);
    assert.equal(await resolver.resolve('alpha.example.com'), null);

    const bootstrap = publicTenantBootstrap(context);
    assert.equal(bootstrap.tenantId, 'TALPHAEXAMPLE000000000');
    assert.equal(bootstrap.schemaName, undefined);
    assert.equal(bootstrap.dbRole, undefined);
  });

  test('coalesces and negatively caches unknown wildcard hosts', async () => {
    let queries = 0;
    const pool = {
      async query() {
        queries += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { rows: [] };
      },
    };
    const resolver = new TenantResolver(pool, 'sandbox.test');

    const results = await Promise.all([
      resolver.resolve('missing.sandbox.test'),
      resolver.resolve('missing.sandbox.test'),
      resolver.resolve('missing.sandbox.test'),
    ]);
    assert.deepEqual(results, [null, null, null]);
    assert.equal(await resolver.resolve('missing.sandbox.test'), null);
    assert.equal(await resolver.resolve('nested.missing.sandbox.test'), null);
    assert.equal(queries, 1);
  });

  test('GET /api/health verifies the host-bound database without exposing tenant internals', async () => {
    const server = await createServer();
    try {
      // First tenant health
      const firstRes = await server.inject({
        method: 'GET',
        url: '/api/health',
        headers: { host: 'alpha.sandbox.test' },
      });
      assert.strictEqual(firstRes.statusCode, 200);
      const firstBody = JSON.parse(firstRes.payload);
      assert.strictEqual(firstBody.status, 'ok');
      assert.strictEqual(firstBody.tenantId, undefined);
      assert.strictEqual(firstBody.schema, undefined);

      // Second tenant health
      const secondRes = await server.inject({
        method: 'GET',
        url: '/api/health',
        headers: { host: 'beta.sandbox.test' },
      });
      assert.strictEqual(secondRes.statusCode, 200);
      const secondBody = JSON.parse(secondRes.payload);
      assert.strictEqual(secondBody.status, 'ok');
      assert.strictEqual(secondBody.tenantId, undefined);
      assert.strictEqual(secondBody.schema, undefined);
    } finally {
      await server.close();
    }
  });

  test('rejects an unregistered hostname before serving tenant data', async () => {
    const server = await createServer();
    try {
      const response = await server.inject({
        method: 'GET',
        url: '/api/tenant/bootstrap',
        headers: { host: 'not-registered.sandbox.test' },
      });

      assert.strictEqual(response.statusCode, 404);
      assert.deepEqual(JSON.parse(response.payload), {
        success: false,
        message: 'Tenant not found.',
      });
    } finally {
      await server.close();
    }
  });

  test('GET /api/v1/tenant/info returns only branding for the host-bound tenant', async () => {
    const server = await createServer();
    try {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/tenant/info',
        headers: { host: 'alpha.sandbox.test' },
      });

      assert.strictEqual(response.statusCode, 200);
      const body = JSON.parse(response.payload);
      assert.strictEqual(body.success, true);
      assert.strictEqual(body.tenant.tenantId, testTenants().tenants.alpha.tenantKey);
      assert.strictEqual(body.tenant.displayName, 'Alpha Test Org');
      assert.strictEqual(body.tenant.schema, undefined);
      assert.strictEqual(body.availableTenants, undefined);
    } finally {
      await server.close();
    }
  });
});
