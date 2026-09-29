import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const rootDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
// Credentials supplied to setup.sh; generated secrets never live in this tree.
const defaultEnvPath = path.resolve(rootDir, '.env/secrets.env');

export const genericSecretPatterns = [
  { name: 'Postgres connection with password', pattern: /postgresql:\/\/[^:]+:[^@\s]{4,}@/i },
  { name: 'Private Key header', pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/ },
  { name: 'Cloudflare API token', pattern: /cfat_[a-zA-Z0-9_-]{20,}/ },
  { name: 'Turnstile secret key', pattern: /0x4AAAAAA[a-zA-Z0-9_-]{20,}/ },
];

// Values that are ordinary words rather than secrets. A credential set to one
// of these is weak (reported as a warning), and it is matched in bundles only
// as a whole token: otherwise every bundle containing e.g. "postgresql" would
// be reported as leaking a password of "postgres".
export const COMMON_DEFAULT_VALUES = new Set([
  'postgres', 'password', 'admin', 'administrator', 'root', 'secret', 'changeme', 'change_me', 'default', 'letmein',
]);

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const PUBLIC_VITE_ALLOWLIST = new Set([
  'VITE_TURNSTILE_SITE_KEY',
  'VITE_APP_TITLE',
  'VITE_PUBLIC_ORIGIN',
  'VITE_API_URL',
]);

export function runSecretScan(options = {}) {
  const envPath = options.envPath || defaultEnvPath;
  const distDirs = options.distDirs || [
    path.resolve(rootDir, 'frontend/platform/dist'),
    path.resolve(rootDir, 'frontend/public/dist'),
    path.resolve(rootDir, 'frontend/tenant/dist'),
    path.resolve(rootDir, 'frontend/landing/dist')
  ];

  let envVars = {};
  if (fs.existsSync(envPath) && fs.statSync(envPath).isFile()) {
    envVars = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
  }

  // Include process.env in CLI mode or when explicitly requested
  const processEnvToScan = (options.includeProcessEnv ?? true) ? process.env : {};
  const combinedEnv = { ...envVars, ...processEnvToScan, ...(options.additionalEnv || {}) };

  const sensitiveKeys = Object.keys(combinedEnv).filter(k => {
    const upper = k.toUpperCase();
    const isSensitive =
      upper.includes('TOKEN') ||
      upper.includes('SECRET') ||
      upper.includes('PASSWORD') ||
      upper.includes('DATABASE_URL') ||
      upper.includes('API_KEY') ||
      upper.includes('PRIVATE') ||
      upper.includes('CREDENTIAL');

    if (!isSensitive) return false;

    // Only exclude VITE_* variables if they are explicitly in the public allowlist
    if (upper.startsWith('VITE_')) {
      return !PUBLIC_VITE_ALLOWLIST.has(upper);
    }

    return true;
  });

  const secretsToFind = sensitiveKeys
    .map(k => ({ key: k, value: combinedEnv[k] }))
    .filter(item => item.value && typeof item.value === 'string' && item.value.length > 5);

  for (const secret of secretsToFind) {
    if (COMMON_DEFAULT_VALUES.has(secret.value.toLowerCase())) {
      secret.matcher = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(secret.value)}(?![A-Za-z0-9])`);
      console.warn(`[SECRET-SCAN:WEAK] "${secret.key}" is set to a common default value. Rotate it, or remove it if unused.`);
    }
  }

  let leaksFound = 0;
  let filesScanned = 0;
  let missingOrEmptyDirs = 0;
  const scannedFilesList = [];

  function scanDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (/\.(js|mjs|html|css|json|map)$/i.test(entry.name)) {
        filesScanned++;
        scannedFilesList.push(fullPath);
        const content = fs.readFileSync(fullPath, 'utf8');

        // Check exact values from environment
        for (const secret of secretsToFind) {
          if (secret.matcher ? secret.matcher.test(content) : content.includes(secret.value)) {
            console.error(`[SECRET-SCAN:FAIL] Found leaked secret for "${secret.key}" in file: ${fullPath}`);
            leaksFound++;
          }
        }

        // Check generic secret patterns
        for (const { name, pattern } of genericSecretPatterns) {
          if (pattern.test(content)) {
            console.error(`[SECRET-SCAN:FAIL] Pattern match "${name}" in file: ${fullPath}`);
            leaksFound++;
          }
        }
      }
    }
  }

  for (const dist of distDirs) {
    if (!fs.existsSync(dist)) {
      if (!options.allowMissingDirs) {
        console.error(`[SECRET-SCAN:FAIL] Required frontend distribution directory missing: ${dist}`);
        missingOrEmptyDirs++;
      }
      continue;
    }
    const scannedBefore = filesScanned;
    scanDir(dist);
    if (filesScanned === scannedBefore && !options.allowMissingDirs) {
      console.error(`[SECRET-SCAN:FAIL] Expected frontend distribution directory contains zero scannable files: ${dist}`);
      missingOrEmptyDirs++;
    }
  }

  leaksFound += missingOrEmptyDirs;

  return { leaksFound, filesScanned, missingOrEmptyDirs, scannedFilesList };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  console.log('[secret-scanner] Starting browser bundle secret scan across all frontends and source maps...');
  const { leaksFound, filesScanned, missingOrEmptyDirs } = runSecretScan({ includeProcessEnv: true });
  console.log(`[secret-scanner] Total files scanned: ${filesScanned}`);

  if (filesScanned === 0 || missingOrEmptyDirs > 0) {
    console.error('[secret-scanner:FAILED] Missing frontend distribution directories or no files were scanned!');
    process.exit(1);
  }

  if (leaksFound > 0) {
    console.error(`[secret-scanner:FAILED] Total ${leaksFound} issue(s) detected (leaks or missing targets)!`);
    process.exit(1);
  } else {
    console.log('[secret-scanner:PASSED] Zero sensitive environment secrets detected in frontend bundles.');
  }
}
