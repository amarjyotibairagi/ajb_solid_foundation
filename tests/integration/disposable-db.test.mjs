import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const { Client } = pg;

describe('Integration: Disposable Database Isolation Harness', () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required for disposable database integration test');
  const testDbUrl = process.env.TEST_DATABASE_URL;

  test('Disposable database harness setup & teardown verification', async () => {

    const client = new Client({ connectionString: testDbUrl });
    await client.connect();

    const tempSchema = `test_disp_${Date.now()}`;
    try {
      // Setup
      await client.query(`CREATE SCHEMA ${tempSchema};`);
      await client.query(`CREATE TABLE ${tempSchema}.test_item (id serial primary key, val text);`);
      await client.query(`INSERT INTO ${tempSchema}.test_item (val) VALUES ('sample');`);

      // Verify
      const res = await client.query(`SELECT val FROM ${tempSchema}.test_item;`);
      assert.equal(res.rows[0].val, 'sample');
    } finally {
      // Teardown
      await client.query(`DROP SCHEMA IF EXISTS ${tempSchema} CASCADE;`);
      await client.end();
    }
  });
});
