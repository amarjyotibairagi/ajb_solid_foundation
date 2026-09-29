import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { runSecretScan, PUBLIC_VITE_ALLOWLIST } from '../../scripts/scan-bundle-secrets.mjs';

const rootDir = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

describe('Safety Harness: Secret Scanner', () => {
  test('Secret scanner script exists and is executable with node', () => {
    const scannerPath = path.resolve(rootDir, 'scripts/scan-bundle-secrets.mjs');
    assert.ok(fs.existsSync(scannerPath), 'scripts/scan-bundle-secrets.mjs must exist');
  });

  test('detects embedded secrets and leaks in js and source maps', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-bundle-scan-'));
    try {
      // 1. Clean file
      fs.writeFileSync(path.join(tmpDir, 'bundle.js'), 'console.log("clean bundle");');
      let result = runSecretScan({ distDirs: [tmpDir], envPath: '/nonexistent/.env', allowMissingDirs: true, includeProcessEnv: false });
      assert.equal(result.leaksFound, 0);
      assert.equal(result.filesScanned, 1);

      // 2. JS file with leaked environment secret
      fs.writeFileSync(path.join(tmpDir, 'bundle.js'), 'const token = "super-secret-token-value";');
      result = runSecretScan({
        distDirs: [tmpDir],
        allowMissingDirs: true,
        includeProcessEnv: false,
        additionalEnv: { SENSITIVE_API_TOKEN: 'super-secret-token-value' },
      });
      assert.equal(result.leaksFound, 1);

      // 3. Source map with leaked connection string
      fs.writeFileSync(path.join(tmpDir, 'bundle.js.map'), '{"sourcesContent":["postgresql://user:secretpass123@db:5432/test"]}');
      result = runSecretScan({ distDirs: [tmpDir], allowMissingDirs: true, includeProcessEnv: false, envPath: '/nonexistent/.env' });
      assert.ok(result.leaksFound >= 1, 'Should detect database connection string in source map');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('detects accidental sensitive VITE_* leaks while ignoring public allowlist', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-vite-secret-scan-'));
    try {
      // File containing an accidental VITE_DATABASE_URL
      fs.writeFileSync(path.join(tmpDir, 'app.js'), 'const db = "postgresql://prod_user:topsecret@cloud.db.internal:5432/db";');
      let result = runSecretScan({
        distDirs: [tmpDir],
        allowMissingDirs: true,
        includeProcessEnv: false,
        additionalEnv: {
          VITE_DATABASE_URL: 'postgresql://prod_user:topsecret@cloud.db.internal:5432/db',
          VITE_TURNSTILE_SITE_KEY: '0x4AAAAAAtestkey1234567890', // In public allowlist
        },
      });
      assert.ok(result.leaksFound >= 1, 'Accidental VITE_DATABASE_URL must be detected');

      // File containing an accidental VITE_PRIVATE_API_TOKEN
      fs.writeFileSync(path.join(tmpDir, 'app.js'), 'const secret = "private-api-token-value-xyz";');
      result = runSecretScan({
        distDirs: [tmpDir],
        allowMissingDirs: true,
        includeProcessEnv: false,
        additionalEnv: {
          VITE_PRIVATE_API_TOKEN: 'private-api-token-value-xyz',
        },
      });
      assert.equal(result.leaksFound, 1, 'Accidental VITE_PRIVATE_API_TOKEN must be detected');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('fails closed when required distribution directory is missing or empty', () => {
    const nonExistentDir = path.join(os.tmpdir(), 'non-existent-dist-dir-12345');
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-dist-dir-'));
    try {
      // 1. Missing directory
      let result = runSecretScan({
        distDirs: [nonExistentDir],
        allowMissingDirs: false,
        includeProcessEnv: false,
      });
      assert.ok(result.missingOrEmptyDirs > 0, 'Missing directory must be flagged');
      assert.ok(result.leaksFound > 0, 'leaksFound must count missing directories');

      // 2. Empty directory (zero scannable artifacts)
      result = runSecretScan({
        distDirs: [emptyDir],
        allowMissingDirs: false,
        includeProcessEnv: false,
      });
      assert.ok(result.missingOrEmptyDirs > 0, 'Empty directory must be flagged');
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
