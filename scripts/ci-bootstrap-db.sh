#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADMIN_URL="${DATABASE_ADMIN_URL:?DATABASE_ADMIN_URL is required}"

psql "$ADMIN_URL" -v ON_ERROR_STOP=1 <<'SQL'
create extension if not exists pgcrypto;
do $$
declare
  target text;
begin
  foreach target in array array[
    'platform_bff_runtime', 'consumer_bff_login'
  ] loop
    if not exists (select 1 from pg_roles where rolname = target) then
      execute format('create role %I login noinherit', target);
    end if;
  end loop;
end
$$;
SQL

# Migration order and identity come from database/migrations/manifest.json --
# the same source scripts/platform-migrate.mjs uses in production and in the
# restore drill. The list used to be duplicated here and had silently drifted:
# CI applied two migrations (017, 018) that production never had.
DATABASE_ADMIN_URL="$ADMIN_URL" node "$ROOT_DIR/scripts/platform-migrate.mjs" --apply

psql "$ADMIN_URL" -v ON_ERROR_STOP=1 <<'SQL'
alter role platform_bff_runtime login password 'ci-platform-runtime-password';
alter role tenant_registry_reader_login login password 'ci-registry-password';
alter role tenant_provisioner_login login password 'ci-provisioner-password';
alter role tenant_pool_login login password 'ci-pool-password';
alter role consumer_bff_login login password 'ci-consumer-password';
grant consumer_runtime to consumer_bff_login;
grant connect on database platform_db to platform_bff_runtime, consumer_bff_login,
  tenant_registry_reader_login, tenant_provisioner_login, tenant_pool_login;
SQL

# The platform owner's password is hashed with argon2id in Node, matching the
# BFF. The previous seed used pgcrypto's gen_salt('bf'), whose default cost is
# 6 -- which is how a cost-6 platform_owner ended up in the production database.
CI_OWNER_PASSWORD="${CI_OWNER_PASSWORD:-ci-owner-password-must-be-long}"
DATABASE_ADMIN_URL="$ADMIN_URL" CI_OWNER_PASSWORD="$CI_OWNER_PASSWORD" node -e '
import("argon2").then(async ({ default: argon2 }) => {
  const pg = (await import("pg")).default
  const hash = await argon2.hash(process.env.CI_OWNER_PASSWORD, {
    type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4,
  })
  const client = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL })
  await client.connect()
  await client.query(
    `insert into platform.platform_user (username, password_hash, role, display_name, is_active)
     values ($1, $2, $3, $4, true)
     on conflict (username) do update set
       password_hash = excluded.password_hash,
       role = excluded.role,
       is_active = excluded.is_active`,
    ["ci.owner", hash, "platform_owner", "CI Owner"],
  )
  await client.end()
})'

psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -f "$ROOT_DIR/database/seeds/001_seed_individuals.sql"

# Apply tenant migrations using the isolated tenant provisioner URL
echo "==> Applying tenant migrations..."
npm run build:backend:provisioner
node "$ROOT_DIR/scripts/migrate-tenants.mjs" --apply

# Verify that all active tenants in the registry reached the latest schema version
echo "==> Verifying tenant registry and ledger version consistency..."
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 <<'SQL'
do $$
declare
  r record;
  meta_version integer;
  ledger_version integer;
  latest_version integer := 7; -- Matches database/migrations/tenant/versions
begin
  for r in select tenant_key, schema_identifier, schema_version from platform.tenant_registry where lifecycle_status = 'active' loop
    if r.schema_version <> latest_version then
      raise exception 'Tenant % registry schema_version (%) does not match latest migration version (%)',
        r.tenant_key, r.schema_version, latest_version;
    end if;

    execute format('select schema_version from %I.schema_metadata where singleton = true', r.schema_identifier)
      into meta_version;
    if meta_version <> latest_version then
      raise exception 'Tenant % schema_metadata version (%) does not match latest migration version (%)',
        r.tenant_key, meta_version, latest_version;
    end if;

    execute format('select coalesce(max(version), 0) from %I.schema_migration', r.schema_identifier)
      into ledger_version;
    if ledger_version <> latest_version then
      raise exception 'Tenant % schema_migration ledger max version (%) does not match latest migration version (%)',
        r.tenant_key, ledger_version, latest_version;
    end if;
  end loop;
end $$;
SQL

# Provision the suite's test tenants (alpha, beta) through the real pipeline.
echo "==> Provisioning test tenants..."
export TEST_TENANTS_FILE="${TEST_TENANTS_FILE:-${TMPDIR:-/tmp}/platform-test-tenants.json}"
node "$ROOT_DIR/tests/fixtures/provision-test-tenants.mjs"
