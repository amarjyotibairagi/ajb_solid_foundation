#!/usr/bin/env bash
# Encrypted, self-describing backup of everything needed to rebuild the
# platform's data on a new host:
#   globals.sql        roles and their attributes (pg_dumpall --globals-only)
#   platform_db.dump   the database (custom format)
#   credentials/       per-tenant database credentials (dedicated tier)
#   pgbouncer/         the tenant PgBouncer auth file
#   storage.tar.gz     tenant files stored on this host (STORAGE_ROOT)
#   manifest.json      SHA-256 of every file, migrations and tenant inventory
# The archive is encrypted with AES-256 (openssl, PBKDF2) using a key kept
# outside the backup directory.
#
# Environment (all optional):
#   BACKUP_DIR, BACKUP_RETENTION_DAYS, BACKUP_KEY_FILE, BACKUP_INCLUDE_STORAGE
#   PGHOST, PGPORT, PGUSER, PGDATABASE, PG_BIN
#   PG_RUN_AS   run PostgreSQL client commands as this OS user (peer auth on a
#               Unix socket, e.g. "postgres") when this script runs as root
#   TENANT_CREDENTIALS_DIR, TENANT_PGBOUNCER_AUTH_FILE, STORAGE_ROOT
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -n "${PG_BIN:-}" ]]; then export PATH="$PG_BIN:$PATH"; else export PATH="/usr/lib/postgresql/16/bin:$PATH"; fi

backup_dir="${BACKUP_DIR:-/var/backups/platform}"
retention_days="${BACKUP_RETENTION_DAYS:-7}"
include_storage="${BACKUP_INCLUDE_STORAGE:-true}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
port="${PGPORT:-5432}"
host="${PGHOST:-127.0.0.1}"
user="${PGUSER:-postgres}"
database="${PGDATABASE:-platform_db}"
creds_dir="${TENANT_CREDENTIALS_DIR:-}"
pgbouncer_file="${TENANT_PGBOUNCER_AUTH_FILE:-}"
storage_root="${STORAGE_ROOT:-}"

pgrun() {
  if [[ -n "${PG_RUN_AS:-}" && "$(id -u)" -eq 0 ]]; then
    runuser -u "$PG_RUN_AS" -- env PATH="$PATH" "$@"
  else
    "$@"
  fi
}

mkdir -p "$backup_dir"

key_file="${BACKUP_KEY_FILE:-}"
if [[ -z "$key_file" ]]; then
  key_file="$(dirname "$backup_dir")/$(basename "$backup_dir").key"
  if [[ ! -f "$key_file" ]]; then
    openssl rand -hex 32 > "$key_file"
    chmod 600 "$key_file"
  fi
fi

staging_dir="$(mktemp -d "$backup_dir/staging-XXXXXX")"
trap 'rm -rf "$staging_dir"' EXIT
echo "==> Staging backup in $staging_dir"

echo "==> Dumping roles"
pgrun pg_dumpall -h "$host" -p "$port" -U "$user" --globals-only > "$staging_dir/globals.sql"

echo "==> Dumping database $database"
pgrun pg_dump -h "$host" -p "$port" -U "$user" --format=custom --compress=9 "$database" > "$staging_dir/platform_db.dump"
pgrun pg_restore --list < "$staging_dir/platform_db.dump" >/dev/null

echo "==> Collecting tenant credentials and PgBouncer auth"
mkdir -p "$staging_dir/credentials" "$staging_dir/pgbouncer"
if [[ -n "$creds_dir" && -d "$creds_dir" ]]; then
  cp -a "$creds_dir"/*.json "$staging_dir/credentials/" 2>/dev/null || true
fi
if [[ -n "$pgbouncer_file" && -f "$pgbouncer_file" ]]; then
  cp -a "$pgbouncer_file" "$staging_dir/pgbouncer/tenant-users.txt"
else
  touch "$staging_dir/pgbouncer/tenant-users.txt"
fi

archive_members=(globals.sql platform_db.dump credentials pgbouncer manifest.json metadata.json)
if [[ "$include_storage" == "true" && -n "$storage_root" && -d "$storage_root" ]]; then
  echo "==> Archiving stored files from $storage_root"
  tar -czf "$staging_dir/storage.tar.gz" -C "$storage_root" .
  archive_members+=(storage.tar.gz)
fi

echo "==> Recording cluster metadata"
pgrun psql -h "$host" -p "$port" -U "$user" -d "$database" -Atq -v ON_ERROR_STOP=1 -c "
  select json_build_object(
    'postgres_version', current_setting('server_version'),
    'platform_migrations', coalesce((select json_agg(json_build_object(
        'migration_key', migration_key, 'migration_scope', migration_scope,
        'source_file', source_file, 'checksum', checksum) order by migration_key)
      from platform.schema_migration), '[]'::json),
    'tenants', coalesce((select json_agg(json_build_object(
        'tenant_key', tenant_key, 'schema_identifier', schema_identifier,
        'schema_version', schema_version, 'lifecycle_status', lifecycle_status) order by tenant_key)
      from platform.tenant_registry where lifecycle_status <> 'deleted'), '[]'::json))" > "$staging_dir/metadata.json"

node - "$staging_dir" "$database" <<'NODE_SCRIPT'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const [, , stagingDir, database] = process.argv
const metadata = JSON.parse(fs.readFileSync(path.join(stagingDir, 'metadata.json'), 'utf8'))
const files = {}
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.isFile() && entry.name !== 'manifest.json') {
      files[path.relative(stagingDir, full)] = {
        size: fs.statSync(full).size,
        sha256: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'),
      }
    }
  }
}
walk(stagingDir)
const manifest = {
  backup_id: `platform-backup-${Date.now()}`,
  timestamp: new Date().toISOString(),
  database,
  ...metadata,
  inventory: {
    tenant_count: metadata.tenants.length,
    credential_files_count: Object.keys(files).filter((key) => key.startsWith('credentials/')).length,
    includes_storage: Object.prototype.hasOwnProperty.call(files, 'storage.tar.gz'),
  },
  files,
}
fs.writeFileSync(path.join(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`Generated manifest with ${Object.keys(files).length} staged files.`)
NODE_SCRIPT

echo "==> Packaging and encrypting"
archive_file="$staging_dir/backup.tar.gz"
tar -czf "$archive_file" -C "$staging_dir" "${archive_members[@]}"
final_package="$backup_dir/platform-backup-$timestamp.tar.gz.enc"
openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -salt -pass file:"$key_file" -in "$archive_file" -out "$final_package"
chmod 600 "$final_package"
rm -rf "$staging_dir"
trap - EXIT

find "$backup_dir" -maxdepth 1 -type f -name 'platform-backup-*.tar.gz.enc' -mtime "+$retention_days" -delete 2>/dev/null || true

echo "Created encrypted backup: $final_package"
echo "Decryption key file: $key_file"
