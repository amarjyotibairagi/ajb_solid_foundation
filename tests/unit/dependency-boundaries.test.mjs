import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const rootDir = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

describe('Phase 1: Frontend Dependency Boundaries', () => {
  const frontends = [
    { name: 'platform', dir: path.resolve(rootDir, 'frontend/platform') },
    { name: 'public', dir: path.resolve(rootDir, 'frontend/public') },
    { name: 'tenant', dir: path.resolve(rootDir, 'frontend/tenant') },
    { name: 'landing', dir: path.resolve(rootDir, 'frontend/landing') }
  ];

  const prohibitedDeps = [
    '@skeleton/backend',
    '@skeleton/platform-bff',
    '@skeleton/public-bff',
    '@skeleton/tenant-bff',
    '@skeleton/cloudflare',
    '@skeleton/drizzle',
    'drizzle-orm',
    'pg',
    'fastify'
  ];

  for (const fe of frontends) {
    test(`Frontend "${fe.name}" package.json has no server/database dependencies`, () => {
      const pkgPath = path.join(fe.dir, 'package.json');
      assert.ok(fs.existsSync(pkgPath), `${fe.name} package.json must exist`);
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const allDeps = {
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {})
      };

      for (const prohibited of prohibitedDeps) {
        assert.ok(
          !allDeps[prohibited],
          `Frontend "${fe.name}" must not depend on server package "${prohibited}"`
        );
      }
    });

    test(`Frontend "${fe.name}" source files do not import backend or other frontends`, () => {
      const srcDir = path.join(fe.dir, 'src');
      if (!fs.existsSync(srcDir)) return;

      function checkDir(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            checkDir(fullPath);
          } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
            const content = fs.readFileSync(fullPath, 'utf8');
            assert.ok(!content.includes('@skeleton/drizzle'), `Leaked drizzle import in ${fullPath}`);
            assert.ok(!content.includes('@skeleton/cloudflare'), `Leaked cloudflare import in ${fullPath}`);
            assert.ok(!content.includes('node:'), `Node built-in import in ${fullPath}`);
            
            // Check cross-frontend imports
            for (const other of frontends) {
              if (other.name !== fe.name) {
                assert.ok(!content.includes(`frontend/${other.name}`), `Cross-frontend import in ${fullPath}`);
              }
            }
          }
        }
      }

      checkDir(srcDir);
    });
  }
});
