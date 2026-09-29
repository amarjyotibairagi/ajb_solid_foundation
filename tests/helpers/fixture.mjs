import fs from 'node:fs'

/**
 * The tenants provisioned for the suite by tests/fixtures/provision-test-tenants.mjs
 * (run by scripts/ci-bootstrap-db.sh). Use `bash scripts/with-test-cluster.sh`
 * to get a throwaway database with these in place.
 */
export function testTenants() {
  const file = process.env.TEST_TENANTS_FILE
  if (!file || !fs.existsSync(file)) {
    throw new Error('TEST_TENANTS_FILE is not set or missing. Run the suite through scripts/with-test-cluster.sh.')
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export const rootDomain = () => process.env.TENANT_ROOT_DOMAIN || 'sandbox.test'
export const platformOrigin = () => process.env.PLATFORM_FRONTEND_ORIGIN || `https://platform.${rootDomain()}`

/** Connection string for a fixture tenant's own login role (from its credential file). */
export function tenantLoginUrl(tenant) {
  const directory = process.env.TENANT_CREDENTIALS_DIR
  if (!directory) throw new Error('TENANT_CREDENTIALS_DIR is required.')
  const credential = JSON.parse(fs.readFileSync(`${directory}/${tenant.credentialRef}.json`, 'utf8'))
  const url = new URL(`postgresql://${credential.host}:${credential.port}/${credential.database}`)
  url.username = credential.loginRole
  url.password = credential.password
  return url.toString()
}
