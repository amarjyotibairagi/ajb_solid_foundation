#!/usr/bin/env bash
# Runs a command against a throwaway PostgreSQL cluster, then destroys it.
#
# The integration suite creates and deletes tenants, drops schemas, and mutates
# roles. It must never touch the production cluster -- doing so is what left
# stale tenant rows and an orphaned schema behind in the first place. Previously
# the suite only ran in CI, so locally it failed with permission-denied noise
# that read like product bugs.
#
# This spins up an isolated cluster with initdb on a free port (the same
# mechanism scripts/validate-backup-restore.sh already uses for the restore
# drill), bootstraps it, exports the connection strings, runs the command, and
# tears the cluster down on exit -- success or failure.
#
#   bash scripts/with-test-cluster.sh                       # runs the integration suite
#   bash scripts/with-test-cluster.sh npm run test:integration
#   bash scripts/with-test-cluster.sh psql "$DATABASE_ADMIN_URL"
#
# Roles are cluster-global in PostgreSQL, which is precisely why a separate
# database on the production cluster is not good enough: bootstrapping would
# reset live role passwords. A separate cluster is the smallest safe unit.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
TEST_PORT="${TEST_CLUSTER_PORT:-0}"

if [ ! -x "$PG_BIN/initdb" ]; then
  echo "error: $PG_BIN/initdb not found. Set PG_BIN to your PostgreSQL bin directory." >&2
  exit 1
fi

temp_dir="$(mktemp -d /tmp/skeleton-test-cluster.XXXXXX)"
cluster_dir="$temp_dir/cluster"
credentials_dir="$temp_dir/tenants"
pgbouncer_auth_file="$temp_dir/pgbouncer-users.txt"
mkdir -p "$cluster_dir" "$credentials_dir" "$temp_dir/storage"
: > "$pgbouncer_auth_file"

# initdb refuses to run as root and the cluster must be owned by a non-root
# user, matching how the restore drill does it.
run_as_pg() {
  if [ "$(id -u)" -eq 0 ]; then
    su postgres -c "$(printf '%q ' "$@")"
  else
    "$@"
  fi
}

if [ "$(id -u)" -eq 0 ]; then
  chown -R postgres:postgres "$temp_dir"
  chmod 755 "$temp_dir"
fi

cleanup() {
  local status=$?
  run_as_pg "$PG_BIN/pg_ctl" -D "$cluster_dir/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$temp_dir"
  exit "$status"
}
trap cleanup EXIT INT TERM

if [ "$TEST_PORT" = "0" ]; then
  TEST_PORT="$(node -e 'const s=require("node:net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})')"
fi

echo "==> Initialising throwaway cluster on port $TEST_PORT"
run_as_pg "$PG_BIN/initdb" -D "$cluster_dir/data" -A trust -U postgres --no-locale -E UTF8 >/dev/null
run_as_pg "$PG_BIN/pg_ctl" -D "$cluster_dir/data" -l "$cluster_dir/logfile" \
  -o "-p $TEST_PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=$cluster_dir" -w start >/dev/null

createdb -h 127.0.0.1 -p "$TEST_PORT" -U postgres platform_db

BASE="postgresql://postgres@127.0.0.1:$TEST_PORT/platform_db"
export NODE_ENV=test
export DATABASE_ADMIN_URL="$BASE"
export TEST_DATABASE_URL="$BASE"
export PUBLIC_DIRECT_DATABASE_URL="$BASE"
export DATABASE_URL="postgresql://platform_bff_runtime:ci-platform-runtime-password@127.0.0.1:$TEST_PORT/platform_db"
export PLATFORM_BFF_DATABASE_URL="$DATABASE_URL"
export PUBLIC_DATABASE_URL="postgresql://consumer_bff_login:ci-consumer-password@127.0.0.1:$TEST_PORT/platform_db"
export TENANT_REGISTRY_DATABASE_URL="postgresql://tenant_registry_reader_login:ci-registry-password@127.0.0.1:$TEST_PORT/platform_db"
export TENANT_PROVISIONER_DATABASE_URL="postgresql://tenant_provisioner_login:ci-provisioner-password@127.0.0.1:$TEST_PORT/platform_db"
export TENANT_CREDENTIALS_DIR="$credentials_dir"
export TENANT_PGBOUNCER_AUTH_FILE="$pgbouncer_auth_file"
export TENANT_PGBOUNCER_RELOAD_DISABLED=true
export TENANT_POOL_DATABASE_URL="postgresql://tenant_pool_login:ci-pool-password@127.0.0.1:$TEST_PORT/platform_db"
export STORAGE_ROOT="$temp_dir/storage"
# Fixed, test-only key for sealing integration credentials.
export INTEGRATION_SECRET_KEY="dGVzdC1vbmx5LWludGVncmF0aW9uLWtleS0zMmJ5dGU="
export TENANT_ROOT_DOMAIN=sandbox.test
export PLATFORM_HOSTNAME=platform.sandbox.test
export PLATFORM_FRONTEND_ORIGIN=https://platform.sandbox.test
export PLATFORM_PUBLIC_ORIGIN=https://platform.sandbox.test
export PUBLIC_PUBLIC_ORIGIN=https://user.sandbox.test
export TEST_TENANTS_FILE="$temp_dir/test-tenants.json"

echo "==> Bootstrapping schema, roles, seed data and test tenants"
bash "$ROOT_DIR/scripts/ci-bootstrap-db.sh" >"$temp_dir/bootstrap.log" 2>&1 || { tail -40 "$temp_dir/bootstrap.log"; exit 1; }

echo "==> Running: ${*:-npm run test:integration}"
if [ "$#" -eq 0 ]; then
  npm run test:integration
else
  "$@"
fi
