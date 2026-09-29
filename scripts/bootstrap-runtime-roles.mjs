import 'dotenv/config'
import pg from 'pg'

const adminUrl = process.env.DATABASE_ADMIN_URL || process.env.PUBLIC_DIRECT_DATABASE_URL
if (!adminUrl) throw new Error('DATABASE_ADMIN_URL or PUBLIC_DIRECT_DATABASE_URL is required.')

const roleSpecs = [
  ['platform_bff_runtime', process.env.DATABASE_URL],
  ['consumer_bff_login', process.env.PUBLIC_DATABASE_URL],
  ['tenant_registry_reader_login', process.env.TENANT_REGISTRY_DATABASE_URL],
  ['tenant_provisioner_login', process.env.TENANT_PROVISIONER_DATABASE_URL],
  // Optional: the shared login for pooled-tier tenants (migration 028). Also
  // add its SCRAM verifier to the tenant PgBouncer auth file.
  ...(process.env.TENANT_POOL_DATABASE_URL ? [['tenant_pool_login', process.env.TENANT_POOL_DATABASE_URL]] : []),
]

function passwordFromUrl(url, role) {
  if (!url) throw new Error(`A database URL for ${role} is required.`)
  const parsed = new URL(url)
  if (decodeURIComponent(parsed.username) !== role) {
    throw new Error(`Expected ${role} in its database URL.`)
  }
  const password = decodeURIComponent(parsed.password)
  if (!password) throw new Error(`A password for ${role} is required.`)
  return password
}

function quoteLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`
}

const client = new pg.Client({ connectionString: adminUrl })
await client.connect()
try {
  await client.query('begin')
  for (const [role, url] of roleSpecs) {
    const password = passwordFromUrl(url, role)
    const exists = await client.query('select 1 from pg_roles where rolname = $1', [role])
    if (exists.rowCount === 0) {
      await client.query(`create role "${role}" login noinherit nosuperuser nocreatedb nocreaterole nobypassrls`)
    }
    await client.query(`alter role "${role}" login password ${quoteLiteral(password)}`)
  }
  await client.query('grant consumer_runtime to consumer_bff_login')
  await client.query('grant tenant_provisioner to tenant_provisioner_login')
  await client.query("alter role tenant_registry_reader_login set search_path = platform, pg_catalog")
  await client.query('commit')
} catch (error) {
  await client.query('rollback').catch(() => undefined)
  throw error
} finally {
  await client.end()
}

console.log('Runtime login roles were created or rotated from environment URLs; no passwords were printed.')
