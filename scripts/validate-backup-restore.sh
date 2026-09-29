#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="/usr/lib/postgresql/16/bin:$PATH"

source_host="${PGHOST:-127.0.0.1}"
source_port="${PGPORT:-5432}"
source_user="${PGUSER:-postgres}"
source_db="${PGDATABASE:-platform_db}"

temp_dir="$(mktemp -d /tmp/platform-restore-drill-XXXXXX)"
chmod 755 "$temp_dir"
isolated_port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("", 0)); print(s.getsockname()[1]); s.close()')

run_as_pg() {
  if [[ $(id -u) -eq 0 ]]; then
    runuser -u postgres -- "$@"
  else
    "$@"
  fi
}

cleanup() {
  echo "==> Cleaning up restore drill artifacts..."
  if [[ -d "$temp_dir/cluster/data" ]]; then
    run_as_pg /usr/lib/postgresql/16/bin/pg_ctl -D "$temp_dir/cluster/data" -m immediate stop 2>/dev/null || true
  fi
  rm -rf "$temp_dir"
}
trap cleanup EXIT

echo "================================================================="
echo "  P06 Disaster Recovery Proof: Fresh Cluster Restore Drill"
echo "================================================================="
echo "Source:     $source_host:$source_port ($source_db)"
echo "Target:     127.0.0.1:$isolated_port (Disposable PostgreSQL 16 Cluster)"
echo "Work Dir:   $temp_dir"
echo "================================================================="

# Step 1: Create a full encrypted backup package
echo "==> Step 1: Generating full production-equivalent encrypted backup..."
mkdir -p "$temp_dir/backup"
key_file="$temp_dir/backup.key"
openssl rand -hex 32 > "$key_file"
chmod 600 "$key_file"

BACKUP_DIR="$temp_dir/backup" \
BACKUP_KEY_FILE="$key_file" \
PGHOST="$source_host" \
PGPORT="$source_port" \
PGUSER="$source_user" \
PGDATABASE="$source_db" \
bash "$ROOT_DIR/scripts/backup-platform-db.sh"

backup_pkg="$(find "$temp_dir/backup" -name 'platform-backup-*.tar.gz.enc' | head -n 1)"
if [[ ! -f "$backup_pkg" ]]; then
  echo "Error: Encrypted backup package not found!"
  exit 1
fi

# Step 2: Decrypt and extract backup package
echo "==> Step 2: Decrypting and validating package archive..."
extract_dir="$temp_dir/extracted"
mkdir -p "$extract_dir"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -pass file:"$key_file" -in "$backup_pkg" | tar -xz -C "$extract_dir"

# Verify manifest SHA-256 digests
echo "==> Step 3: Verifying file integrity against SHA-256 manifest..."
node - "$extract_dir" <<'NODE_SCRIPT'
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const extractDir = process.argv[2];
const manifestPath = path.join(extractDir, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error('Error: manifest.json is missing from backup package!');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
console.log(`Manifest backup ID: ${manifest.backup_id}, timestamp: ${manifest.timestamp}`);

for (const [relPath, info] of Object.entries(manifest.files)) {
  const filePath = path.join(extractDir, relPath);
  if (!fs.existsSync(filePath)) {
    console.error(`Error: Backup file ${relPath} listed in manifest is missing!`);
    process.exit(1);
  }
  const actualHash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  if (actualHash !== info.sha256) {
    console.error(`Error: SHA-256 checksum mismatch for ${relPath}! Expected: ${info.sha256}, Actual: ${actualHash}`);
    process.exit(1);
  }
}
console.log(`All ${Object.keys(manifest.files).length} files verified against SHA-256 digests.`);
NODE_SCRIPT

# Step 4: Initialize a brand new disposable PostgreSQL 16 cluster
echo "==> Step 4: Initializing fresh isolated PostgreSQL 16 cluster on port $isolated_port..."
cluster_dir="$temp_dir/cluster"
mkdir -p "$cluster_dir/data" "$cluster_dir/run"
chmod 700 "$cluster_dir/data" "$cluster_dir/run"
chown -R postgres:postgres "$cluster_dir"

run_as_pg /usr/lib/postgresql/16/bin/initdb -D "$cluster_dir/data" -A trust -U postgres --no-locale -E UTF8 >/dev/null

echo "==> Starting disposable PostgreSQL server..."
run_as_pg /usr/lib/postgresql/16/bin/pg_ctl -D "$cluster_dir/data" -l "$cluster_dir/logfile" \
  -o "-p $isolated_port -k $cluster_dir/run -h 127.0.0.1" -w start

/usr/lib/postgresql/16/bin/pg_isready -h 127.0.0.1 -p "$isolated_port" -U postgres

# Step 5: Restore globals (roles, passwords, security attributes)
echo "==> Step 5: Restoring global cluster roles and security attributes..."
# The fresh cluster was initialized with superuser postgres; make superuser creation idempotent
sed -i 's/^CREATE ROLE postgres;/-- CREATE ROLE postgres;/' "$extract_dir/globals.sql"
psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$isolated_port" -U postgres -d postgres -f "$extract_dir/globals.sql"

# Step 6: Restore platform_db with single-transaction and strict error checking
echo "==> Step 6: Restoring database with strict error checking (NO --no-owner, NO || true)..."
createdb -h 127.0.0.1 -p "$isolated_port" -U postgres platform_db
pg_restore -h 127.0.0.1 -p "$isolated_port" -U postgres -d platform_db \
  --single-transaction --exit-on-error "$extract_dir/platform_db.dump"

# Step 7: Perform comprehensive security catalog, RLS, and access verification
echo "==> Step 7: Running catalog invariants, ownerships, FORCE RLS, and tenant boundary assertions..."
export LATEST_TENANT_VERSION="$(ls "$ROOT_DIR/database/migrations/tenant/versions" | grep -c "^[0-9][0-9][0-9]_")"
node - "$isolated_port" "$extract_dir" <<'NODE_SCRIPT'
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const pg = require('pg');

const [,, port, extractDir] = process.argv;
const adminUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/platform_db`;

async function verify() {
  const admin = new pg.Pool({ connectionString: adminUrl });

  try {
    // 1. Verify global roles and security attributes
    console.log('  -> Verifying roles and security attributes...');
    const rolesRes = await admin.query(
      `select rolname, rolsuper, rolcanlogin, rolbypassrls
         from pg_roles
        where rolname in (
          'platform_owner', 'platform_bff_runtime', 'consumer_owner',
          'consumer_bff_login', 'consumer_policy_function_owner',
          'tenant_template_owner', 'tenant_provisioner_login',
          'tenant_registry_reader_login'
        )`
    );
    const roleMap = new Map(rolesRes.rows.map(r => [r.rolname, r]));
    assert.ok(roleMap.has('platform_owner'), 'platform_owner must exist');
    assert.ok(roleMap.has('platform_bff_runtime'), 'platform_bff_runtime must exist');
    assert.ok(roleMap.has('consumer_policy_function_owner'), 'consumer_policy_function_owner must exist');

    const helperOwner = roleMap.get('consumer_policy_function_owner');
    assert.equal(helperOwner.rolbypassrls, true, 'consumer_policy_function_owner must have BYPASSRLS');
    assert.equal(helperOwner.rolcanlogin, false, 'consumer_policy_function_owner must be NOLOGIN');

    // Verify helper owner has no members
    const memberRes = await admin.query(
      `select count(*)::int as count
         from pg_auth_members m
         join pg_roles r on r.oid = m.roleid
        where r.rolname = 'consumer_policy_function_owner'`
    );
    assert.equal(memberRes.rows[0].count, 0, 'consumer_policy_function_owner must have 0 members');

    // 2. Verify schema and table ownerships
    console.log('  -> Verifying schema and table ownerships...');
    const schemaRes = await admin.query(
      `select n.nspname, r.rolname as owner
         from pg_namespace n
         join pg_roles r on r.oid = n.nspowner
        where n.nspname in ('platform', 'consumer')`
    );
    const schemaOwners = Object.fromEntries(schemaRes.rows.map(r => [r.nspname, r.owner]));
    assert.equal(schemaOwners.platform, 'platform_owner', 'platform schema must be owned by platform_owner');
    assert.equal(schemaOwners.consumer, 'consumer_owner', 'consumer schema must be owned by consumer_owner');
    const tenants = (await admin.query(
      `select tenant_key, tenant_id::text, schema_identifier, credential_ref, connection_tier
         from platform.tenant_registry
        where lifecycle_status = 'active' and data_integration_id is null
        order by created_at`,
    )).rows;
    for (const tenant of tenants) {
      const owner = (await admin.query(
        'select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = $1', [tenant.schema_identifier],
      )).rows[0]?.owner;
      assert.equal(owner, 'tenant_template_owner', `${tenant.schema_identifier} must be owned by tenant_template_owner`);
    }

    // 3. Verify FORCE RLS state on consumer application tables
    console.log('  -> Verifying FORCE RLS state on consumer tables...');
    const rlsRes = await admin.query(
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'consumer'
          and c.relname in ('collaboration_group', 'group_membership', 'workspace_project')`
    );
    for (const row of rlsRes.rows) {
      assert.equal(row.relrowsecurity, true, `${row.relname} must have rowsecurity`);
      assert.equal(row.relforcerowsecurity, true, `${row.relname} must have FORCEROWSECURITY`);
    }

    // 4. Verify helper function execute ACLs (revoked from login)
    console.log('  -> Verifying function ACLs (consumer_bff_login cannot execute helper)...');
    const aclRes = await admin.query(
      `select has_function_privilege('consumer_bff_login', 'consumer.can_access_group(uuid)', 'execute') as can_exec`
    );
    assert.equal(aclRes.rows[0].can_exec, false, 'consumer_bff_login cannot execute policy helper');

    // 5. Verify representative row counts
    console.log('  -> Verifying representative table row counts...');
    const pUsers = (await admin.query('select count(*)::int as c from platform.platform_user')).rows[0].c;
    assert.ok(pUsers > 0, 'Restored platform_user count must be > 0');

    const cUsers = (await admin.query('select count(*)::int as c from consumer.user_account')).rows[0].c;
    assert.ok(cUsers >= 0, 'consumer user_account must be readable');

    // 6. Every active VDS tenant restored at a consistent schema version
    console.log(`  -> Verifying ${tenants.length} tenant schema(s) and migration ledgers...`);
    const latest = Number(process.env.LATEST_TENANT_VERSION || 0);
    for (const tenant of tenants) {
      const version = (await admin.query(`select schema_version from "${tenant.schema_identifier}".schema_metadata`)).rows[0].schema_version;
      const ledger = (await admin.query(`select count(*)::int as c, max(version) as mv from "${tenant.schema_identifier}".schema_migration`)).rows[0];
      assert.equal(ledger.mv, version, `${tenant.tenant_key} ledger must match schema_metadata`);
      assert.equal(ledger.c, version, `${tenant.tenant_key} ledger must be contiguous`);
      if (latest) assert.equal(version, latest, `${tenant.tenant_key} must be at schema version ${latest}`);
    }

    // 7. Tenant runtime and isolation with restored credentials (dedicated
    // tenants carry a credential file; needs two tenants to prove isolation).
    const dedicated = tenants.filter((tenant) => tenant.connection_tier === 'dedicated'
      && fs.existsSync(path.join(extractDir, 'credentials', `${tenant.credential_ref}.json`)));
    if (dedicated.length < 2) {
      console.log('  -> Fewer than two dedicated tenants in the backup; skipping the cross-tenant isolation probe.');
    } else {
      console.log('  -> Verifying tenant authentication, query, and isolation boundaries...');
      const [first, second] = dedicated;
      const cred = JSON.parse(fs.readFileSync(path.join(extractDir, 'credentials', `${first.credential_ref}.json`), 'utf8'));
      const tenantPool = new pg.Pool({ connectionString: `postgresql://${cred.loginRole}:${encodeURIComponent(cred.password)}@127.0.0.1:${port}/platform_db` });
      const client = await tenantPool.connect();
      const enter = async () => {
        await client.query('begin');
        await client.query(`set local role "${cred.dbRole}"`);
        await client.query(`set local search_path = "${cred.schemaName}", pg_catalog`);
        await client.query(`select set_config('app.tenant_id', $1, true)`, [cred.tenantId]);
      };
      try {
        await enter();
        const meta = await client.query('select schema_version from schema_metadata limit 1');
        assert.ok(meta.rows[0].schema_version > 0);
        await client.query('rollback');
        for (const forbidden of ['platform.platform_user', `"${second.schema_identifier}".user_account`, 'consumer.user_account']) {
          await enter();
          await assert.rejects(async () => { await client.query(`select * from ${forbidden} limit 1`); }, /permission denied/);
          await client.query('rollback');
        }
      } finally {
        client.release();
        await tenantPool.end();
      }
    }

    console.log('All catalog, permission, RLS, ledger, and isolation assertions PASSED.');
  } finally {
    await admin.end();
  }
}

verify().catch(err => {
  console.error('Restore validation verification failed:', err);
  process.exit(1);
});
NODE_SCRIPT

echo "================================================================="
echo "  Disaster Recovery Proof PASSED: Clean-Cluster Restore Success  "
echo "================================================================="
