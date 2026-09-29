#!/usr/bin/env bash
# =============================================================================
#  Platform installer
# =============================================================================
# Turns the folder it lives in into a running platform installation: a
# dedicated PostgreSQL cluster, three PgBouncer pools, the landing, platform,
# public and tenant services, the provisioning worker, an optional Cloudflare
# Tunnel, backups and health checks, all under systemd.
#
# Everything is created inside this folder, wherever it was unpacked:
#   ./            code (runs in place; dependencies and builds are added here)
#   ./runtime/    config, generated secrets, database, tenant files, logs, Node.js
#   ./backups/    encrypted backups
# `uninstall --purge` returns the folder to its pre-installation state, and
# `package` writes a clean, secret-free zip of it.
#
# Configure .env/setup.env (and .env/secrets.env if needed), then:
#   sudo ./setup.sh check                 validate config and host; change nothing
#   sudo ./setup.sh install [options]     install or upgrade
#   sudo ./setup.sh status                services, health, versions
#   sudo ./setup.sh help                  all commands
#
# Re-running install is safe: generated secrets, the database, tenant data and
# tenant-managed PgBouncer entries are preserved; code is updated, rebuilt and
# migrated, and services restarted.
set -Eeuo pipefail
umask 022

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_SRC="$SOURCE_DIR/.env"
SCRIPT_VERSION="1.0.0"

DEBUG=0
WITH_DEMO=0
INSTALL_PACKAGES=0
ASSUME_YES=0
PURGE=0
ARGS=()
COMMAND="${1:-help}"
[[ $# -gt 0 ]] && shift || true
for argument in "$@"; do
  case "$argument" in
    --debug) DEBUG=1 ;;
    --with-demo) WITH_DEMO=1 ;;
    --install-packages) INSTALL_PACKAGES=1 ;;
    --yes) ASSUME_YES=1 ;;
    --purge) PURGE=1 ;;
    --*) echo "Unknown option: $argument (see ./setup.sh help)" >&2; exit 2 ;;
    *) ARGS+=("$argument") ;;
  esac
done

# -----------------------------------------------------------------------------
# Output and logging
# -----------------------------------------------------------------------------
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m' C_DIM=$'\033[2m' C_BOLD=$'\033[1m' C_GREEN=$'\033[32m' C_YELLOW=$'\033[33m' C_RED=$'\033[31m' C_BLUE=$'\033[34m'
else
  C_RESET='' C_DIM='' C_BOLD='' C_GREEN='' C_YELLOW='' C_RED='' C_BLUE=''
fi
LOG_FILE="$(mktemp /tmp/platform-setup-XXXXXX.log)"
STEP_NO=0
STEP_TOTAL=0
STEP_NAME=""
STEP_STARTED=0
RUN_STARTED=$(date +%s)

ts() { date -u +%H:%M:%S; }
_log() { printf '%s %-5s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" >> "$LOG_FILE"; }
info() { _log INFO "$*"; printf '%s  %s%s\n' "${C_DIM}$(ts)${C_RESET}" "" "$*"; }
detail() { _log INFO "$*"; printf '%s    %s%s%s\n' "${C_DIM}$(ts)" "" "$*" "${C_RESET}"; }
warn() { _log WARN "$*"; printf '%s  %s! %s%s\n' "${C_DIM}$(ts)${C_RESET}" "$C_YELLOW" "$*" "$C_RESET"; }
debug() { _log DEBUG "$*"; [[ $DEBUG == 1 ]] && printf '%s    %s[debug] %s%s\n' "${C_DIM}$(ts)" "" "$*" "${C_RESET}"; return 0; }
die() { _log ERROR "$*"; printf '\n%s%sERROR:%s %s\n' "$C_RED" "$C_BOLD" "$C_RESET" "$*" >&2; printf 'Full log: %s\n' "$LOG_FILE" >&2; exit 1; }

step() {
  STEP_NO=$((STEP_NO + 1))
  STEP_NAME="$1"
  STEP_STARTED=$(date +%s)
  _log STEP "[$STEP_NO/$STEP_TOTAL] $1"
  printf '\n%s%s[%d/%d] %s%s\n' "$C_BOLD" "$C_BLUE" "$STEP_NO" "$STEP_TOTAL" "$1" "$C_RESET"
}
step_done() {
  local elapsed=$(( $(date +%s) - STEP_STARTED ))
  _log DONE "[$STEP_NO/$STEP_TOTAL] $STEP_NAME (${elapsed}s)"
  printf '%s  %s✓ %s%s %s(%ss)%s\n' "${C_DIM}$(ts)${C_RESET}" "$C_GREEN" "${1:-done}" "$C_RESET" "$C_DIM" "$elapsed" "$C_RESET"
}

# run "description" cmd...   Runs a command, logging its output. On failure,
# prints the tail of the output. Never pass secrets as arguments.
run() {
  local description="$1"; shift
  debug "$description: $*"
  _log RUN "$description: $*"
  local status=0
  if [[ $DEBUG == 1 ]]; then
    "$@" 2>&1 | tee -a "$LOG_FILE" | sed 's/^/      │ /' || status=${PIPESTATUS[0]}
  else
    "$@" >> "$LOG_FILE" 2>&1 || status=$?
  fi
  if [[ $status -ne 0 ]]; then
    printf '%s  %s✗ %s failed (exit %s)%s\n' "${C_DIM}$(ts)${C_RESET}" "$C_RED" "$description" "$status" "$C_RESET" >&2
    tail -n 25 "$LOG_FILE" | sed 's/^/      │ /' >&2
    die "Step \"$STEP_NAME\" failed at: $description"
  fi
  detail "$description"
}

on_error() {
  local status=$1 line=$2 command=$3
  _log ERROR "exit $status at line $line: $command"
  printf '\n%sERROR:%s step "%s" stopped at setup.sh line %s (exit %s)\n  command: %s\n' "$C_RED" "$C_RESET" "${STEP_NAME:-startup}" "$line" "$status" "$command" >&2
  printf 'Full log: %s\nRe-run with --debug to stream command output.\n' "$LOG_FILE" >&2
}
trap 'on_error $? $LINENO "$BASH_COMMAND"' ERR

move_log_to() {
  local directory="$1"
  mkdir -p "$directory"
  local destination
  destination="$directory/setup-$(date -u +%Y%m%dT%H%M%SZ).log"
  cat "$LOG_FILE" >> "$destination"
  rm -f "$LOG_FILE"
  LOG_FILE="$destination"
  chmod 600 "$LOG_FILE"
}

confirm() {
  [[ $ASSUME_YES == 1 ]] && return 0
  local answer
  read -r -p "$1 [y/N] " answer
  [[ "$answer" =~ ^[Yy]$ ]]
}

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------
load_config() {
  [[ -f "$CONFIG_SRC/setup.env" ]] || die "Missing $CONFIG_SRC/setup.env"
  set -a
  # shellcheck disable=SC1091
  source "$CONFIG_SRC/setup.env"
  if [[ -f "$CONFIG_SRC/secrets.env" ]]; then
    local mode
    mode=$(stat -c %a "$CONFIG_SRC/secrets.env")
    if [[ "$mode" != 600 && "$mode" != 400 ]] && grep -qE '^[A-Z_]+=.+' "$CONFIG_SRC/secrets.env"; then
      warn ".env/secrets.env contains values and is mode $mode; run: chmod 600 .env/secrets.env"
    fi
    # shellcheck disable=SC1091
    source "$CONFIG_SRC/secrets.env"
  fi
  set +a
  # Layout: everything lives inside this folder.
  INSTALL_DIR="$SOURCE_DIR"
  RUNTIME_DIR="$SOURCE_DIR/runtime"
  CONFIG_DIR="$RUNTIME_DIR/config"
  DATA_DIR="$RUNTIME_DIR/data"
  LOG_DIR="$RUNTIME_DIR/logs"
  LOCAL_NODE_DIR="$RUNTIME_DIR/node"
  BACKUP_DIR="${BACKUP_DIR:-$SOURCE_DIR/backups}"
  # systemd's ProtectHome=true would hide a folder under /home or /root.
  case "$SOURCE_DIR/" in
    /home/*|/root/*|/run/user/*) PROTECT_HOME=read-only ;;
    *) PROTECT_HOME=true ;;
  esac
  PLATFORM_HOST="$PLATFORM_SUBDOMAIN.$ROOT_DOMAIN"
  PUBLIC_HOST="$PUBLIC_SUBDOMAIN.$ROOT_DOMAIN"
  PG_BIN="/usr/lib/postgresql/$PG_VERSION/bin"
  if [[ -z "${NODE_BIN:-}" ]]; then
    if [[ -x "$LOCAL_NODE_DIR/bin/node" ]]; then NODE_BIN="$LOCAL_NODE_DIR/bin/node"; else NODE_BIN="$(command -v node || true)"; fi
  fi
  CLOUDFLARED_BIN="$(command -v cloudflared || true)"
  PG_SOCKET_DIR="/run/$APP_SLUG-postgresql"
  PG_DATA_DIR="$DATA_DIR/postgres/$PG_VERSION"
  SECRETS_DIR="$CONFIG_DIR/secrets"
  GENERATED="$SECRETS_DIR/generated.env"
  ADMIN_URL="postgresql://postgres@/platform_db?host=$PG_SOCKET_DIR&port=$POSTGRES_PORT"
  export PRODUCT_NAME APP_SLUG ROOT_DOMAIN PLATFORM_HOST PUBLIC_HOST PG_BIN NODE_BIN CLOUDFLARED_BIN PG_DATA_DIR \
    INSTALL_DIR RUNTIME_DIR CONFIG_DIR DATA_DIR LOG_DIR BACKUP_DIR PROTECT_HOME POSTGRES_PORT LANDING_PORT PLATFORM_PORT PUBLIC_PORT TENANT_PORT \
    PGBOUNCER_PLATFORM_PORT PGBOUNCER_PUBLIC_PORT PGBOUNCER_TENANT_PORT BACKUP_SCHEDULE HEALTHCHECK_INTERVAL
  export BACKUP_KEY_DIR="$SECRETS_DIR"
}

validate_config() {
  local problems=()
  [[ "$APP_SLUG" =~ ^[a-z][a-z0-9-]{1,19}$ ]] || problems+=("APP_SLUG must be 2-20 lowercase letters, digits or hyphens, starting with a letter")
  [[ "$ROOT_DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$ ]] || problems+=("ROOT_DOMAIN is not a valid lowercase domain")
  [[ "$ROOT_DOMAIN" != example.com ]] || problems+=("ROOT_DOMAIN is still example.com")
  for label in "$PLATFORM_SUBDOMAIN" "$PUBLIC_SUBDOMAIN"; do
    [[ "$label" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || problems+=("subdomain '$label' is not a valid DNS label")
  done
  [[ "$PLATFORM_SUBDOMAIN" != "$PUBLIC_SUBDOMAIN" ]] || problems+=("PLATFORM_SUBDOMAIN and PUBLIC_SUBDOMAIN must differ")
  [[ "$OWNER_USERNAME" =~ ^[a-z0-9][a-z0-9._-]{2,63}$ ]] || problems+=("OWNER_USERNAME must be 3-64 lowercase letters, digits, dot, dash or underscore")
  [[ "$EDGE_MODE" =~ ^(cloudflare-api|cloudflare-token|none)$ ]] || problems+=("EDGE_MODE must be cloudflare-api, cloudflare-token or none")
  [[ "$LOGIN_CHALLENGE" =~ ^(turnstile|none)$ ]] || problems+=("LOGIN_CHALLENGE must be turnstile or none")
  [[ "$DEFAULT_CONNECTION_TIER" =~ ^(dedicated|pooled)$ ]] || problems+=("DEFAULT_CONNECTION_TIER must be dedicated or pooled")
  [[ "$SHARED_STATE_BACKEND" =~ ^(memory|postgres)$ ]] || problems+=("SHARED_STATE_BACKEND must be memory or postgres")
  [[ "$PG_VERSION" =~ ^[0-9]+$ && "$PG_VERSION" -ge 16 ]] || problems+=("PG_VERSION must be 16 or newer")
  [[ "$NODE_MAJOR" =~ ^[0-9]+$ && "$NODE_MAJOR" -ge 22 ]] || problems+=("NODE_MAJOR must be 22 or newer")
  [[ "$SOURCE_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || problems+=("the folder path '$SOURCE_DIR' may only contain letters, digits, '.', '_', '-' and '/' (no spaces)")
  [[ "$BACKUP_DIR" == /* && "$BACKUP_DIR" != / ]] || problems+=("BACKUP_DIR must be an absolute path other than /")
  local ports=("$POSTGRES_PORT" "$PGBOUNCER_PLATFORM_PORT" "$PGBOUNCER_PUBLIC_PORT" "$PGBOUNCER_TENANT_PORT" "$LANDING_PORT" "$PLATFORM_PORT" "$PUBLIC_PORT" "$TENANT_PORT")
  for port in "${ports[@]}"; do [[ "$port" =~ ^[0-9]+$ && "$port" -ge 1024 && "$port" -le 65535 ]] || problems+=("port $port must be 1024-65535"); done
  [[ $(printf '%s\n' "${ports[@]}" | sort | uniq -d | wc -l) -eq 0 ]] || problems+=("ports must all be different")
  if [[ "$EDGE_MODE" == cloudflare-api ]]; then
    for key in CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_ZONE_ID CLOUDFLARE_API_TOKEN; do
      [[ -n "${!key:-}" ]] || problems+=("$key is required in .env/secrets.env for EDGE_MODE=cloudflare-api")
    done
  fi
  if [[ "$EDGE_MODE" == cloudflare-token && -z "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]]; then
    problems+=("CLOUDFLARE_TUNNEL_TOKEN is required in .env/secrets.env for EDGE_MODE=cloudflare-token")
  fi
  if [[ "$LOGIN_CHALLENGE" == turnstile && "$EDGE_MODE" != cloudflare-api ]]; then
    for surface in PLATFORM PUBLIC TENANT; do
      for kind in SITE SECRET; do
        local key="TURNSTILE_${surface}_${kind}_KEY"
        [[ -n "${!key:-}" ]] || problems+=("$key is required (or set LOGIN_CHALLENGE=none, or use EDGE_MODE=cloudflare-api)")
      done
    done
  fi
  if [[ -n "${NOTIFICATION_WEBHOOK_URL:-}" && -z "${NOTIFICATION_WEBHOOK_SECRET:-}" ]]; then
    problems+=("NOTIFICATION_WEBHOOK_SECRET is required when NOTIFICATION_WEBHOOK_URL is set")
  fi
  if (( ${#problems[@]} > 0 )); then
    printf '%sConfiguration problems in .env/:%s\n' "$C_RED" "$C_RESET" >&2
    printf '  - %s\n' "${problems[@]}" >&2
    die "Fix .env/setup.env (and .env/secrets.env), then run ./setup.sh check"
  fi
}

print_plan() {
  cat <<EOF

  ${C_BOLD}Plan${C_RESET}
    Product          $PRODUCT_NAME  (slug: $APP_SLUG)
    Landing          https://$ROOT_DOMAIN  and  https://www.$ROOT_DOMAIN
    Platform console https://$PLATFORM_HOST
    Individual app   https://$PUBLIC_HOST
    Tenants          https://<name>.$ROOT_DOMAIN
    Public edge      $EDGE_MODE    login challenge: $LOGIN_CHALLENGE
    Installation     $SOURCE_DIR  (code runs in place)
    Runtime state    $RUNTIME_DIR  (config, secrets, database, tenant files, logs)
    Database         PostgreSQL $PG_VERSION on 127.0.0.1:$POSTGRES_PORT, data in $DATA_DIR/postgres
    Backups          $BACKUP_DIR  ($BACKUP_SCHEDULE, keep $BACKUP_RETENTION_DAYS days)
    Logs             $LOG_DIR and journalctl -u '$APP_SLUG-*'
EOF
}

# -----------------------------------------------------------------------------
# Host checks and packages
# -----------------------------------------------------------------------------
OS_ID="" OS_CODENAME=""
require_root() { [[ $(id -u) -eq 0 ]] || die "Run as root (sudo ./setup.sh $COMMAND)."; }

host_checks() {
  require_root
  [[ -r /etc/os-release ]] || die "Cannot identify the operating system (/etc/os-release missing)."
  # shellcheck disable=SC1091
  OS_ID=$(. /etc/os-release && echo "${ID:-}")
  # shellcheck disable=SC1091
  OS_CODENAME=$(. /etc/os-release && echo "${VERSION_CODENAME:-}")
  case "$OS_ID" in
    ubuntu|debian) detail "Operating system: $OS_ID $OS_CODENAME ($(uname -m))" ;;
    *) die "Supported systems: Ubuntu 22.04+ and Debian 12+ (found $OS_ID)." ;;
  esac
  [[ -d /run/systemd/system ]] || die "systemd is not running; this installer needs systemd."
  command -v systemctl >/dev/null || die "systemctl not found."
  check_location
}

# The services run as unprivileged users, so every directory above this folder
# must be traversable by them, and the folder must not be claimed by another
# installation with the same APP_SLUG.
check_location() {
  local directory="$SOURCE_DIR" blocked=()
  while [[ "$directory" != / ]]; do
    [[ "$(stat -c %A "$directory")" == ?????????[xt] ]] || blocked+=("$directory")
    directory=$(dirname "$directory")
  done
  if (( ${#blocked[@]} > 0 )); then
    die "Service accounts cannot reach this folder: ${blocked[*]} not traversable by other users.
       Move the folder to e.g. /opt or /srv, or run: chmod o+x ${blocked[*]}"
  fi
  local unit="/etc/systemd/system/$APP_SLUG-platform.service" other
  if [[ -f "$unit" ]]; then
    other=$(sed -n 's/^WorkingDirectory=//p' "$unit")
    [[ "$other" == "$SOURCE_DIR" ]] || die "APP_SLUG '$APP_SLUG' is already installed from $other. Uninstall that one, or give this folder its own APP_SLUG and ports."
  fi
  detail "Installing in place: $SOURCE_DIR"
}

missing_tools() {
  local missing=()
  for tool in curl openssl runuser; do command -v "$tool" >/dev/null || missing+=("$tool"); done
  [[ -x "$PG_BIN/initdb" && -x "$PG_BIN/postgres" ]] || missing+=("postgresql-$PG_VERSION")
  command -v psql >/dev/null || missing+=("postgresql-client")
  [[ -x /usr/sbin/pgbouncer ]] || missing+=("pgbouncer")
  if [[ -z "$NODE_BIN" ]]; then
    missing+=("node")
  else
    local major
    major=$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
    (( major >= 22 )) || missing+=("node>=22 (found $major)")
  fi
  if [[ "$EDGE_MODE" == cloudflare-* && -z "$CLOUDFLARED_BIN" ]]; then missing+=("cloudflared"); fi
  printf '%s\n' "${missing[@]}"
}

install_packages() {
  export DEBIAN_FRONTEND=noninteractive
  run "Refreshing package lists" apt-get update
  run "Installing base tools" apt-get install -y --no-install-recommends ca-certificates curl gnupg openssl xz-utils util-linux iproute2

  if ! apt-cache show "postgresql-$PG_VERSION" >/dev/null 2>&1; then
    info "postgresql-$PG_VERSION is not in the default repositories; adding apt.postgresql.org"
    install -d /usr/share/postgresql-common/pgdg
    run "Downloading PostgreSQL signing key" curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $OS_CODENAME-pgdg main" > /etc/apt/sources.list.d/pgdg.list
    run "Refreshing package lists" apt-get update
  fi
  # This installer runs its own cluster; don't let the package create "main".
  if [[ ! -f /etc/postgresql-common/createcluster.conf ]]; then
    install -d /etc/postgresql-common
    echo "create_main_cluster = false" > /etc/postgresql-common/createcluster.conf
  fi
  run "Installing PostgreSQL $PG_VERSION and PgBouncer" apt-get install -y --no-install-recommends "postgresql-$PG_VERSION" "postgresql-client-$PG_VERSION" pgbouncer
  # The distribution's default PgBouncer instance is not used.
  systemctl disable --now pgbouncer.service >> "$LOG_FILE" 2>&1 || true

  local major=0
  [[ -n "$NODE_BIN" ]] && major=$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if (( major < 22 )); then
    local arch
    case "$(uname -m)" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) die "No Node.js build for $(uname -m)" ;; esac
    local base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
    local listing tarball
    listing=$(curl -fsSL "$base/SHASUMS256.txt") || die "Cannot reach nodejs.org"
    tarball=$(awk -v a="linux-$arch.tar.xz" '$2 ~ a {print $2}' <<<"$listing" | head -n 1)
    [[ -n "$tarball" ]] || die "No Node.js $NODE_MAJOR tarball for linux-$arch"
    run "Downloading $tarball" curl -fsSL -o "/tmp/$tarball" "$base/$tarball"
    (cd /tmp && grep " $tarball\$" <<<"$listing" | sha256sum -c -) >> "$LOG_FILE" 2>&1 || die "Node.js download failed its SHA-256 check"
    detail "Checksum verified"
    rm -rf "$LOCAL_NODE_DIR"
    install -d -m 0755 "$RUNTIME_DIR" "$LOCAL_NODE_DIR"
    run "Unpacking Node.js into $LOCAL_NODE_DIR" tar -xJf "/tmp/$tarball" -C "$LOCAL_NODE_DIR" --strip-components=1 --no-same-owner
    rm -f "/tmp/$tarball"
    NODE_BIN="$LOCAL_NODE_DIR/bin/node"
    export NODE_BIN
  fi

  if [[ "$EDGE_MODE" == cloudflare-* && -z "$CLOUDFLARED_BIN" ]]; then
    install -d -m 0755 /usr/share/keyrings
    run "Downloading Cloudflare signing key" curl -fsSL -o /usr/share/keyrings/cloudflare-main.gpg https://pkg.cloudflare.com/cloudflare-main.gpg
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" > /etc/apt/sources.list.d/cloudflared.list
    run "Refreshing package lists" apt-get update
    run "Installing cloudflared" apt-get install -y cloudflared
    CLOUDFLARED_BIN=$(command -v cloudflared)
    export CLOUDFLARED_BIN
  fi
}

port_owner() { ss -Hltnp "sport = :$1" 2>/dev/null | head -n 1; }

# A port is fine if it is free or held by one of this installation's units
# (identified by the owning process's systemd cgroup, e.g. myplatform-tenant.service).
check_ports() {
  local busy=()
  for port in "$POSTGRES_PORT" "$PGBOUNCER_PLATFORM_PORT" "$PGBOUNCER_PUBLIC_PORT" "$PGBOUNCER_TENANT_PORT" "$LANDING_PORT" "$PLATFORM_PORT" "$PUBLIC_PORT" "$TENANT_PORT"; do
    local owner pid
    owner=$(port_owner "$port")
    [[ -z "$owner" ]] && continue
    pid=$(grep -oE 'pid=[0-9]+' <<<"$owner" | head -n 1 | cut -d= -f2)
    if [[ -n "$pid" ]] && grep -qE "/$APP_SLUG-[a-z@]+\.service" "/proc/$pid/cgroup" 2>/dev/null; then
      debug "port $port held by this installation (pid $pid)"
      continue
    fi
    busy+=("$port ($(grep -oE 'users:\(\("[^"]+' <<<"$owner" | cut -d'"' -f2))")
  done
  (( ${#busy[@]} == 0 )) || die "Ports already in use by other programs: ${busy[*]}. Change them in .env/setup.env."
}

# -----------------------------------------------------------------------------
# Secrets
# -----------------------------------------------------------------------------
secret_value() { grep -E "^$1=" "$GENERATED" 2>/dev/null | tail -n 1 | cut -d= -f2-; }
ensure_secret() { # name generator-command...
  local name=$1; shift
  if [[ -z "$(secret_value "$name")" ]]; then
    printf '%s=%s\n' "$name" "$("$@")" >> "$GENERATED"
    detail "Generated $name"
  fi
}
random_hex() { openssl rand -hex "${1:-24}"; }
random_b64() { openssl rand -base64 32; }

generate_secrets() {
  install -d -m 0700 -o root -g root "$SECRETS_DIR"
  touch "$GENERATED"; chmod 600 "$GENERATED"
  ensure_secret DB_PASSWORD_PLATFORM random_hex
  ensure_secret DB_PASSWORD_CONSUMER random_hex
  ensure_secret DB_PASSWORD_REGISTRY random_hex
  ensure_secret DB_PASSWORD_PROVISIONER random_hex
  ensure_secret DB_PASSWORD_POOL random_hex
  ensure_secret PGBOUNCER_ADMIN_PASSWORD random_hex
  ensure_secret PGBOUNCER_STATS_PASSWORD random_hex
  ensure_secret TENANT_SESSION_SECRET random_hex 32
  ensure_secret INTEGRATION_SECRET_KEY random_b64
  if [[ ! -f "$SECRETS_DIR/backup.key" ]]; then
    openssl rand -hex 32 > "$SECRETS_DIR/backup.key"; chmod 600 "$SECRETS_DIR/backup.key"
    detail "Generated backup encryption key ($SECRETS_DIR/backup.key) - copy it somewhere safe"
  fi
  printf 'PGBOUNCER_STATS_PASSWORD=%s\n' "$(secret_value PGBOUNCER_STATS_PASSWORD)" > "$SECRETS_DIR/pgbouncer-stats.env"
  chmod 600 "$SECRETS_DIR/pgbouncer-stats.env"
  # Carry supplied credentials over so services never read the source folder.
  if [[ -f "$CONFIG_SRC/secrets.env" ]]; then
    install -m 0600 -o root -g root "$CONFIG_SRC/secrets.env" "$SECRETS_DIR/supplied.env"
  fi
}

# -----------------------------------------------------------------------------
# Accounts and directories
# -----------------------------------------------------------------------------
ensure_group() { getent group "$1" >/dev/null || groupadd --system "$1"; }
ensure_user() { # user primary-group
  if ! id -u "$1" >/dev/null 2>&1; then
    useradd --system --gid "$2" --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin "$1"
    detail "Created system user $1"
  fi
}

create_accounts_and_directories() {
  for group in landing platform public tenant pgbouncer cloudflared; do ensure_group "$APP_SLUG-$group"; done
  ensure_user "$APP_SLUG-landing" "$APP_SLUG-landing"
  ensure_user "$APP_SLUG-platform" "$APP_SLUG-platform"
  ensure_user "$APP_SLUG-public" "$APP_SLUG-public"
  ensure_user "$APP_SLUG-tenant" "$APP_SLUG-tenant"
  ensure_user "$APP_SLUG-provisioner" "$APP_SLUG-tenant"
  ensure_user "$APP_SLUG-pgbouncer" "$APP_SLUG-pgbouncer"
  ensure_user "$APP_SLUG-cloudflared" "$APP_SLUG-cloudflared"
  usermod -a -G "$APP_SLUG-pgbouncer" "$APP_SLUG-provisioner"
  id -u postgres >/dev/null 2>&1 || die "The postgres system user is missing; install postgresql-$PG_VERSION first."

  install -d -m 0755 -o root -g root "$RUNTIME_DIR" "$CONFIG_DIR" "$DATA_DIR"
  install -d -m 0700 -o root -g root "$CONFIG_DIR/env" "$SECRETS_DIR"
  install -d -m 2770 -o root -g "$APP_SLUG-pgbouncer" "$CONFIG_DIR/pgbouncer"
  install -d -m 0700 -o postgres -g postgres "$DATA_DIR/postgres"
  install -d -m 2750 -o "$APP_SLUG-provisioner" -g "$APP_SLUG-tenant" "$DATA_DIR/tenant-credentials"
  install -d -m 2770 -o root -g "$APP_SLUG-tenant" "$DATA_DIR/storage"
  install -d -m 0750 -o root -g root "$LOG_DIR"
  install -d -m 0700 -o root -g root "$BACKUP_DIR"
  detail "System users <$APP_SLUG>-{landing,platform,public,tenant,provisioner,pgbouncer,cloudflared} ready"
  detail "Runtime directories under $RUNTIME_DIR and $BACKUP_DIR ready"
}

# -----------------------------------------------------------------------------
# Application code
# -----------------------------------------------------------------------------
deploy_code() {
  # Code runs in place. Service accounts need to read it but never write it,
  # and nobody but root may read the .env folder.
  local item
  for item in backend database dependency deploy docs frontend scripts tests package.json package-lock.json setup.sh README.md; do
    [[ -e "$SOURCE_DIR/$item" ]] && chmod -R go-w,o+rX "$SOURCE_DIR/$item"
  done
  chmod go-w,o+x "$SOURCE_DIR"
  chmod 700 "$CONFIG_SRC"; chmod 600 "$CONFIG_SRC"/*.env
  detail "Code permissions set (read-only for services; .env/ root only)"
  local lock_hash previous marker="$RUNTIME_DIR/.dependencies.sha256"
  lock_hash=$(sha256sum "$INSTALL_DIR/package-lock.json" | cut -d' ' -f1)
  previous=$(cat "$marker" 2>/dev/null || true)
  if [[ "$lock_hash" != "$previous" || ! -d "$INSTALL_DIR/node_modules" ]]; then
    info "Installing dependencies (npm ci); this can take a few minutes"
    run "npm ci" bash -c "cd '$INSTALL_DIR' && PATH='$(dirname "$NODE_BIN")':\$PATH npm ci --no-audit --no-fund"
    echo "$lock_hash" > "$marker"
  else
    detail "Dependencies unchanged; skipping npm ci"
  fi
}

build_code() {
  local npm_path; npm_path="$(dirname "$NODE_BIN"):$PATH"
  local challenge=""; [[ "$LOGIN_CHALLENGE" == none ]] && challenge=none
  run "Building shared packages" bash -c "cd '$INSTALL_DIR' && export PATH='$npm_path' && npm run build:server-kit && npm run build:cloudflare && npm run build:drizzle"
  run "Building backends" bash -c "cd '$INSTALL_DIR' && PATH='$npm_path' npm run build:backend"
  run "Building platform console" env PATH="$npm_path" VITE_TURNSTILE_SITE_KEY="${TURNSTILE_PLATFORM_SITE_KEY:-}" VITE_LOGIN_CHALLENGE="$challenge" \
    bash -c "cd '$INSTALL_DIR' && npm run build --workspace @skeleton/platform"
  run "Building individual-user app" env PATH="$npm_path" VITE_TURNSTILE_SITE_KEY="${TURNSTILE_PUBLIC_SITE_KEY:-}" VITE_LOGIN_CHALLENGE="$challenge" \
    bash -c "cd '$INSTALL_DIR' && npm run build --workspace @skeleton/public"
  run "Building tenant workspace app" env PATH="$npm_path" VITE_TURNSTILE_SITE_KEY="${TURNSTILE_TENANT_SITE_KEY:-}" VITE_LOGIN_CHALLENGE="$challenge" \
    bash -c "cd '$INSTALL_DIR' && npm run build --workspace @skeleton/tenant"
  run "Building landing page" env PATH="$npm_path" VITE_BRAND_NAME="$PRODUCT_NAME" VITE_BRAND_TAGLINE="$BRAND_TAGLINE" \
    VITE_BRAND_DESCRIPTION="$BRAND_DESCRIPTION" VITE_PLATFORM_URL="https://$PLATFORM_HOST" VITE_PUBLIC_URL="https://$PUBLIC_HOST" \
    VITE_CONTACT_EMAIL="${CONTACT_EMAIL:-}" bash -c "cd '$INSTALL_DIR' && npm run build --workspace @skeleton/landing"
}

# -----------------------------------------------------------------------------
# Public edge
# -----------------------------------------------------------------------------
provision_edge() {
  case "$EDGE_MODE" in
    cloudflare-api)
      local result="$SECRETS_DIR/cloudflare.json"
      run "Provisioning tunnel, DNS and Turnstile on Cloudflare" env \
        CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID" CLOUDFLARE_ZONE_ID="$CLOUDFLARE_ZONE_ID" CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
        CLOUDFLARE_REPLACE_DNS="${CLOUDFLARE_REPLACE_DNS:-false}" CLOUDFLARE_TUNNEL_NAME="$CLOUDFLARE_TUNNEL_NAME" \
        PLATFORM_SUBDOMAIN="$PLATFORM_SUBDOMAIN" PUBLIC_SUBDOMAIN="$PUBLIC_SUBDOMAIN" \
        "$NODE_BIN" "$INSTALL_DIR/scripts/foundation/cloudflare.mjs" "$result"
      json() { "$NODE_BIN" -e "const r=require('$result'); process.stdout.write(String($1))"; }
      TURNSTILE_PLATFORM_SITE_KEY=$(json r.widgets.platform.siteKey); TURNSTILE_PLATFORM_SECRET_KEY=$(json r.widgets.platform.secretKey)
      TURNSTILE_PUBLIC_SITE_KEY=$(json r.widgets.public.siteKey); TURNSTILE_PUBLIC_SECRET_KEY=$(json r.widgets.public.secretKey)
      TURNSTILE_TENANT_SITE_KEY=$(json r.widgets.tenant.siteKey); TURNSTILE_TENANT_SECRET_KEY=$(json r.widgets.tenant.secretKey)
      PLATFORM_TUNNEL_ID=$(json r.tunnelId)
      json r.tunnelToken > "$SECRETS_DIR/tunnel.token"
      ;;
    cloudflare-token)
      printf '%s' "$CLOUDFLARE_TUNNEL_TOKEN" > "$SECRETS_DIR/tunnel.token"
      detail "Using the supplied tunnel token; configure public hostnames in the Cloudflare dashboard (see README)"
      ;;
    none)
      detail "No tunnel; put a TLS reverse proxy in front of the loopback ports (see README)"
      ;;
  esac
  if [[ -f "$SECRETS_DIR/tunnel.token" ]]; then
    chown "root:$APP_SLUG-cloudflared" "$SECRETS_DIR/tunnel.token"; chmod 640 "$SECRETS_DIR/tunnel.token"
    chmod 711 "$SECRETS_DIR"
  fi
}

# -----------------------------------------------------------------------------
# PostgreSQL
# -----------------------------------------------------------------------------
render() { # template output mode
  env PRODUCT_NAME="$PRODUCT_NAME" "$NODE_BIN" "$INSTALL_DIR/scripts/foundation/render.mjs" "$INSTALL_DIR/deploy/templates/$1" "$2" "${3:-644}" >> "$LOG_FILE" 2>&1 \
    || { tail -n 5 "$LOG_FILE" >&2; die "Could not render $1"; }
}
psql_admin() { runuser -u postgres -- "$PG_BIN/psql" -h "$PG_SOCKET_DIR" -p "$POSTGRES_PORT" -X -v ON_ERROR_STOP=1 -q "$@"; }

setup_postgres() {
  render systemd/postgresql.service "/etc/systemd/system/$APP_SLUG-postgresql.service"
  if [[ ! -f "$PG_DATA_DIR/PG_VERSION" ]]; then
    install -d -m 0700 -o postgres -g postgres "$PG_DATA_DIR"
    run "Initialising PostgreSQL $PG_VERSION cluster in $PG_DATA_DIR" runuser -u postgres -- "$PG_BIN/initdb" -D "$PG_DATA_DIR" \
      --auth-local=peer --auth-host=scram-sha-256 --encoding=UTF8 --locale=C.UTF-8 --username=postgres
  else
    detail "Existing cluster found in $PG_DATA_DIR (kept)"
  fi
  install -d -m 0700 -o postgres -g postgres "$PG_DATA_DIR/conf.d"
  render postgres/platform.conf "$PG_DATA_DIR/conf.d/platform.conf" 600
  render postgres/pg_hba.conf "$PG_DATA_DIR/pg_hba.conf" 600
  chown postgres:postgres "$PG_DATA_DIR/conf.d/platform.conf" "$PG_DATA_DIR/pg_hba.conf"
  grep -q "^include_dir = 'conf.d'" "$PG_DATA_DIR/postgresql.conf" || echo "include_dir = 'conf.d'" >> "$PG_DATA_DIR/postgresql.conf"
  run "Reloading systemd" systemctl daemon-reload
  run "Starting $APP_SLUG-postgresql" systemctl enable --now "$APP_SLUG-postgresql.service"
  systemctl reload-or-restart "$APP_SLUG-postgresql.service" >> "$LOG_FILE" 2>&1 || true
  local attempt
  for attempt in $(seq 1 30); do
    runuser -u postgres -- "$PG_BIN/pg_isready" -h "$PG_SOCKET_DIR" -p "$POSTGRES_PORT" -q && break
    sleep 1
  done
  runuser -u postgres -- "$PG_BIN/pg_isready" -h "$PG_SOCKET_DIR" -p "$POSTGRES_PORT" -q || die "PostgreSQL did not become ready (journalctl -u $APP_SLUG-postgresql)"
  detail "PostgreSQL ready on 127.0.0.1:$POSTGRES_PORT (socket $PG_SOCKET_DIR)"
}

scram() { printf '%s' "$1" | "$NODE_BIN" "$INSTALL_DIR/scripts/foundation/scram.mjs"; }

setup_database() {
  if [[ -z "$(psql_admin -d postgres -Atc "select 1 from pg_database where datname = 'platform_db'")" ]]; then
    run "Creating database platform_db" psql_admin -d postgres -c "create database platform_db"
  fi
  run "Preparing extensions and bootstrap roles" psql_admin -d platform_db -c "
    create extension if not exists pgcrypto;
    do \$\$ begin
      if not exists (select 1 from pg_roles where rolname = 'platform_bff_runtime') then create role platform_bff_runtime login noinherit; end if;
      if not exists (select 1 from pg_roles where rolname = 'consumer_bff_login') then create role consumer_bff_login login noinherit; end if;
    end \$\$;"
  info "Applying platform migrations"
  run "Platform migrations" runuser -u postgres -- env DATABASE_ADMIN_URL="$ADMIN_URL" PATH="$PG_BIN:$PATH" \
    "$NODE_BIN" "$INSTALL_DIR/scripts/platform-migrate.mjs" --apply
  local applied
  applied=$(psql_admin -d platform_db -Atc "select count(*) from platform.schema_migration")
  detail "$applied migrations recorded in platform.schema_migration"

  # Role passwords are set as SCRAM verifiers; the same verifiers go into the
  # PgBouncer auth files. Sent over stdin so they never appear in logs or argv.
  VERIFIER_PLATFORM=$(scram "$(secret_value DB_PASSWORD_PLATFORM)")
  VERIFIER_CONSUMER=$(scram "$(secret_value DB_PASSWORD_CONSUMER)")
  VERIFIER_REGISTRY=$(scram "$(secret_value DB_PASSWORD_REGISTRY)")
  VERIFIER_PROVISIONER=$(scram "$(secret_value DB_PASSWORD_PROVISIONER)")
  VERIFIER_POOL=$(scram "$(secret_value DB_PASSWORD_POOL)")
  psql_admin -d platform_db >> "$LOG_FILE" 2>&1 <<SQL || die "Could not configure database roles (see log)"
alter role platform_bff_runtime login password '$VERIFIER_PLATFORM';
alter role consumer_bff_login login password '$VERIFIER_CONSUMER';
alter role tenant_registry_reader_login login password '$VERIFIER_REGISTRY';
alter role tenant_registry_reader_login set search_path = platform, pg_catalog;
alter role tenant_provisioner_login login password '$VERIFIER_PROVISIONER';
alter role tenant_pool_login login password '$VERIFIER_POOL';
grant consumer_runtime to consumer_bff_login;
grant tenant_provisioner to tenant_provisioner_login;
grant connect on database platform_db to platform_bff_runtime, consumer_bff_login, tenant_registry_reader_login,
  tenant_provisioner_login, tenant_pool_login;
SQL
  detail "Runtime roles configured (passwords from $GENERATED)"

  local reserved
  reserved=$(psql_admin -d platform_db -Atc "select (platform.resolve_platform_config())->'tenancy.reserved_subdomains'")
  reserved=$("$NODE_BIN" -e "const l=new Set(JSON.parse(process.argv[1]));for(const x of process.argv.slice(2))l.add(x);console.log(JSON.stringify([...l]))" "$reserved" "$PLATFORM_SUBDOMAIN" "$PUBLIC_SUBDOMAIN" www)
  local integrations=true; [[ "$ENABLE_INTEGRATIONS" == true ]] || integrations=false
  psql_admin -d platform_db >> "$LOG_FILE" 2>&1 <<SQL || die "Could not apply platform settings (see log)"
select platform.set_config_value('platform', null, 'platform.product_name', to_jsonb(\$\$$PRODUCT_NAME\$\$::text), null);
select platform.set_config_value('platform', null, 'surfaces.public_origin', to_jsonb('https://$PUBLIC_HOST'::text), null);
select platform.set_config_value('platform', null, 'tenancy.reserved_subdomains', '$reserved'::jsonb, null);
select platform.set_config_value('platform', null, 'tenancy.default_connection_tier', to_jsonb('$DEFAULT_CONNECTION_TIER'::text), null);
select platform.set_config_value('platform', null, 'integration.byo_storage', '$integrations'::jsonb, null);
select platform.set_config_value('platform', null, 'integration.byo_database', '$integrations'::jsonb, null);
SQL
  detail "Platform settings applied (product name, public origin, reserved subdomains, tier, integrations)"
}

# -----------------------------------------------------------------------------
# PgBouncer
# -----------------------------------------------------------------------------
write_auth_file() { # pool lines...  (keeps entries managed by the provisioner)
  local file="$CONFIG_DIR/pgbouncer/$1-users.txt"; shift
  local static_names=() line
  for line in "$@"; do static_names+=("$(cut -d'"' -f2 <<<"$line")"); done
  local temporary; temporary=$(mktemp "$CONFIG_DIR/pgbouncer/.auth-XXXXXX")
  if [[ -f "$file" ]]; then
    grep -vE "^\"($(IFS='|'; echo "${static_names[*]}"))\" " "$file" > "$temporary" || true
  fi
  printf '%s\n' "$@" >> "$temporary"
  sort -u -o "$temporary" "$temporary"
  chown "root:$APP_SLUG-pgbouncer" "$temporary"; chmod 660 "$temporary"
  mv "$temporary" "$file"
}

setup_pgbouncer() {
  local stats admin
  stats="\"pgbouncer_stats\" \"$(scram "$(secret_value PGBOUNCER_STATS_PASSWORD)")\""
  admin="\"tenant_pgbouncer_admin\" \"$(scram "$(secret_value PGBOUNCER_ADMIN_PASSWORD)")\""
  write_auth_file platform "\"platform_bff_runtime\" \"$VERIFIER_PLATFORM\"" "\"tenant_registry_reader_login\" \"$VERIFIER_REGISTRY\"" "$stats"
  write_auth_file public "\"consumer_bff_login\" \"$VERIFIER_CONSUMER\"" "$stats"
  write_auth_file tenant "\"tenant_pool_login\" \"$VERIFIER_POOL\"" "$admin" "$stats"
  detail "Auth files written (tenant entries added by the provisioner are preserved)"
  POOL_NAME=platform POOL_PORT=$PGBOUNCER_PLATFORM_PORT POOL_ADMIN_USERS=tenant_pgbouncer_admin POOL_MAX_CLIENT_CONN=200 POOL_DEFAULT_SIZE=10 POOL_MAX_DB_CONNECTIONS=20 \
    render pgbouncer/pool.ini "$CONFIG_DIR/pgbouncer/platform.ini" 640
  POOL_NAME=public POOL_PORT=$PGBOUNCER_PUBLIC_PORT POOL_ADMIN_USERS=tenant_pgbouncer_admin POOL_MAX_CLIENT_CONN=300 POOL_DEFAULT_SIZE=10 POOL_MAX_DB_CONNECTIONS=20 \
    render pgbouncer/pool.ini "$CONFIG_DIR/pgbouncer/public.ini" 640
  POOL_NAME=tenant POOL_PORT=$PGBOUNCER_TENANT_PORT POOL_ADMIN_USERS=tenant_pgbouncer_admin POOL_MAX_CLIENT_CONN=500 POOL_DEFAULT_SIZE=4 POOL_MAX_DB_CONNECTIONS=60 \
    render pgbouncer/pool.ini "$CONFIG_DIR/pgbouncer/tenant.ini" 640
  chown "root:$APP_SLUG-pgbouncer" "$CONFIG_DIR"/pgbouncer/*.ini
  render systemd/pgbouncer@.service "/etc/systemd/system/$APP_SLUG-pgbouncer@.service"
  run "Reloading systemd" systemctl daemon-reload
  for pool in platform public tenant; do
    run "Starting PgBouncer pool $pool" systemctl enable "$APP_SLUG-pgbouncer@$pool.service"
    systemctl restart "$APP_SLUG-pgbouncer@$pool.service" >> "$LOG_FILE" 2>&1 || die "PgBouncer $pool failed to start (journalctl -u $APP_SLUG-pgbouncer@$pool)"
  done
}

# -----------------------------------------------------------------------------
# Service environment files
# -----------------------------------------------------------------------------
write_env() { # name, then KEY=VALUE lines on stdin; empty values are dropped
  local file="$CONFIG_DIR/env/$1.env"
  grep -vE '^[A-Z0-9_]+=$' > "$file.tmp"
  chmod 600 "$file.tmp"; mv "$file.tmp" "$file"
}

write_service_environments() {
  local db="platform_db" challenge=""
  [[ "$LOGIN_CHALLENGE" == none ]] && challenge=none
  local edge_verify=false
  if [[ "$TENANT_EDGE_VERIFY" == true || ( "$TENANT_EDGE_VERIFY" == auto && "$EDGE_MODE" == cloudflare-api ) ]]; then edge_verify=true; fi
  local integration_key=""; [[ "$ENABLE_INTEGRATIONS" == true ]] && integration_key=$(secret_value INTEGRATION_SECRET_KEY)
  local pool_url="postgresql://tenant_pool_login:$(secret_value DB_PASSWORD_POOL)@127.0.0.1:$PGBOUNCER_TENANT_PORT/$db"

  write_env landing <<EOF
LANDING_PORT=$LANDING_PORT
EOF
  write_env platform <<EOF
PLATFORM_BFF_HOST=127.0.0.1
PLATFORM_BFF_PORT=$PLATFORM_PORT
DATABASE_URL=postgresql://platform_bff_runtime:$(secret_value DB_PASSWORD_PLATFORM)@127.0.0.1:$PGBOUNCER_PLATFORM_PORT/$db
PLATFORM_PUBLIC_ORIGIN=https://$PLATFORM_HOST
PLATFORM_FRONTEND_ORIGIN=https://$PLATFORM_HOST
PLATFORM_HOSTNAME=$PLATFORM_HOST
TENANT_ROOT_DOMAIN=$ROOT_DOMAIN
CLOUDFLARE_ZONE_NAME=$ROOT_DOMAIN
CLOUDFLARE_ACCOUNT_ID=${CLOUDFLARE_ACCOUNT_ID:-}
CLOUDFLARE_ZONE_ID=${CLOUDFLARE_ZONE_ID:-}
CLOUDFLARE_PLATFORM_API_TOKEN=${CLOUDFLARE_API_TOKEN:-}
PLATFORM_TUNNEL_ID=${PLATFORM_TUNNEL_ID:-}
CLOUDFLARE_TURNSTILE_SECRET_KEY=${TURNSTILE_PLATFORM_SECRET_KEY:-}
LOGIN_CHALLENGE=$challenge
SERVE_PLATFORM_STATIC=true
INTEGRATION_SECRET_KEY=$integration_key
SHARED_STATE_BACKEND=$SHARED_STATE_BACKEND
NOTIFICATION_WEBHOOK_URL=${NOTIFICATION_WEBHOOK_URL:-}
NOTIFICATION_WEBHOOK_SECRET=${NOTIFICATION_WEBHOOK_SECRET:-}
EOF
  write_env public <<EOF
PUBLIC_BFF_HOST=127.0.0.1
PUBLIC_BFF_PORT=$PUBLIC_PORT
PUBLIC_DATABASE_URL=postgresql://consumer_bff_login:$(secret_value DB_PASSWORD_CONSUMER)@127.0.0.1:$PGBOUNCER_PUBLIC_PORT/$db
PUBLIC_PUBLIC_ORIGIN=https://$PUBLIC_HOST
CLOUDFLARE_PUBLIC_TURNSTILE_SECRET_KEY=${TURNSTILE_PUBLIC_SECRET_KEY:-}
LOGIN_CHALLENGE=$challenge
SERVE_PUBLIC_STATIC=true
SHARED_STATE_BACKEND=$SHARED_STATE_BACKEND
EOF
  write_env tenant <<EOF
TENANT_BFF_HOST=127.0.0.1
TENANT_BFF_PORT=$TENANT_PORT
TENANT_REGISTRY_DATABASE_URL=postgresql://tenant_registry_reader_login:$(secret_value DB_PASSWORD_REGISTRY)@127.0.0.1:$PGBOUNCER_PLATFORM_PORT/$db
TENANT_POOL_DATABASE_URL=$pool_url
TENANT_ROOT_DOMAIN=$ROOT_DOMAIN
TENANT_CREDENTIALS_DIR=$DATA_DIR/tenant-credentials
STORAGE_ROOT=$DATA_DIR/storage
CLOUDFLARE_TENANT_TURNSTILE_SECRET_KEY=${TURNSTILE_TENANT_SECRET_KEY:-}
LOGIN_CHALLENGE=$challenge
SERVE_TENANT_STATIC=true
INTEGRATION_SECRET_KEY=$integration_key
TENANT_SESSION_SECRET=$(secret_value TENANT_SESSION_SECRET)
SHARED_STATE_BACKEND=$SHARED_STATE_BACKEND
NOTIFICATION_WEBHOOK_URL=${NOTIFICATION_WEBHOOK_URL:-}
NOTIFICATION_WEBHOOK_SECRET=${NOTIFICATION_WEBHOOK_SECRET:-}
EOF
  write_env provisioner <<EOF
TENANT_PROVISIONER_DATABASE_URL=postgresql://tenant_provisioner_login:$(secret_value DB_PASSWORD_PROVISIONER)@127.0.0.1:$POSTGRES_PORT/$db
TENANT_CREDENTIALS_DIR=$DATA_DIR/tenant-credentials
TENANT_PGBOUNCER_HOST=127.0.0.1
TENANT_PGBOUNCER_PORT=$PGBOUNCER_TENANT_PORT
TENANT_PGBOUNCER_AUTH_FILE=$CONFIG_DIR/pgbouncer/tenant-users.txt
TENANT_PGBOUNCER_ADMIN_USER=tenant_pgbouncer_admin
TENANT_PGBOUNCER_ADMIN_PASSWORD=$(secret_value PGBOUNCER_ADMIN_PASSWORD)
TENANT_POOL_DATABASE_URL=$pool_url
TENANT_SCHEMA_TEMPLATE=$INSTALL_DIR/database/migrations/tenant/001_tenant_schema.sql
STORAGE_ROOT=$DATA_DIR/storage
INTEGRATION_SECRET_KEY=$integration_key
TENANT_EDGE_VERIFY_DISABLED=$([[ $edge_verify == true ]] && echo false || echo true)
EOF
  write_env backup <<EOF
PATH=$(dirname "$NODE_BIN"):$PG_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
PG_BIN=$PG_BIN
PGHOST=$PG_SOCKET_DIR
PGPORT=$POSTGRES_PORT
PGUSER=postgres
PGDATABASE=$db
PG_RUN_AS=postgres
BACKUP_DIR=$BACKUP_DIR
BACKUP_KEY_FILE=$SECRETS_DIR/backup.key
BACKUP_RETENTION_DAYS=$BACKUP_RETENTION_DAYS
BACKUP_INCLUDE_STORAGE=$BACKUP_INCLUDE_STORAGE
TENANT_CREDENTIALS_DIR=$DATA_DIR/tenant-credentials
TENANT_PGBOUNCER_AUTH_FILE=$CONFIG_DIR/pgbouncer/tenant-users.txt
STORAGE_ROOT=$DATA_DIR/storage
EOF
  # Non-secret facts for the health check and status command.
  cat > "$CONFIG_DIR/install.env" <<EOF
APP_SLUG=$APP_SLUG
PRODUCT_NAME="$PRODUCT_NAME"
ROOT_DOMAIN=$ROOT_DOMAIN
PLATFORM_HOST=$PLATFORM_HOST
PUBLIC_HOST=$PUBLIC_HOST
EDGE_MODE=$EDGE_MODE
INSTALL_DIR=$INSTALL_DIR
RUNTIME_DIR=$RUNTIME_DIR
CONFIG_DIR=$CONFIG_DIR
DATA_DIR=$DATA_DIR
BACKUP_DIR=$BACKUP_DIR
PG_BIN=$PG_BIN
POSTGRES_PORT=$POSTGRES_PORT
PGBOUNCER_PLATFORM_PORT=$PGBOUNCER_PLATFORM_PORT
PGBOUNCER_PUBLIC_PORT=$PGBOUNCER_PUBLIC_PORT
PGBOUNCER_TENANT_PORT=$PGBOUNCER_TENANT_PORT
LANDING_PORT=$LANDING_PORT
PLATFORM_PORT=$PLATFORM_PORT
PUBLIC_PORT=$PUBLIC_PORT
TENANT_PORT=$TENANT_PORT
SETUP_VERSION=$SCRIPT_VERSION
INSTALLED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
  chmod 644 "$CONFIG_DIR/install.env"
  detail "Wrote $CONFIG_DIR/env/{landing,platform,public,tenant,provisioner,backup}.env (root only)"
}

# -----------------------------------------------------------------------------
# Services
# -----------------------------------------------------------------------------
APP_UNITS=(landing platform public tenant provisioner)

wait_for_http() { # description url [host] [expected]
  local attempt code
  for attempt in $(seq 1 45); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 -H "Host: ${3:-localhost}" "$2" || true)
    [[ "$code" == "${4:-200}" ]] && { detail "$1 answering on $2"; return 0; }
    sleep 1
  done
  die "$1 did not answer on $2 (got '$code'); see journalctl -u $APP_SLUG-$1"
}

start_services() {
  for unit in "${APP_UNITS[@]}"; do render "systemd/$unit.service" "/etc/systemd/system/$APP_SLUG-$unit.service"; done
  if [[ "$EDGE_MODE" == cloudflare-* ]]; then render systemd/cloudflared.service "/etc/systemd/system/$APP_SLUG-cloudflared.service"; fi
  run "Reloading systemd" systemctl daemon-reload
  for unit in "${APP_UNITS[@]}"; do
    run "Enabling $APP_SLUG-$unit" systemctl enable "$APP_SLUG-$unit.service"
    info "Starting $APP_SLUG-$unit"
    systemctl restart "$APP_SLUG-$unit.service" >> "$LOG_FILE" 2>&1 || {
      journalctl -u "$APP_SLUG-$unit" -n 30 --no-pager >> "$LOG_FILE" 2>&1 || true
      journalctl -u "$APP_SLUG-$unit" -n 15 --no-pager 2>/dev/null | sed 's/^/      │ /' >&2 || true
      die "$APP_SLUG-$unit failed to start (journalctl -u $APP_SLUG-$unit)"
    }
  done
  wait_for_http landing "http://127.0.0.1:$LANDING_PORT/api/health"
  wait_for_http platform "http://127.0.0.1:$PLATFORM_PORT/api/health"
  wait_for_http public "http://127.0.0.1:$PUBLIC_PORT/api/health"
  wait_for_http tenant "http://127.0.0.1:$TENANT_PORT/api/health" "readiness.invalid" 404
  systemctl is-active --quiet "$APP_SLUG-provisioner.service" && detail "provisioner running" || die "provisioner is not running"
  if [[ "$EDGE_MODE" == cloudflare-* ]]; then
    run "Enabling tunnel" systemctl enable "$APP_SLUG-cloudflared.service"
    systemctl restart "$APP_SLUG-cloudflared.service" >> "$LOG_FILE" 2>&1 || die "Tunnel failed to start (journalctl -u $APP_SLUG-cloudflared)"
    detail "Cloudflare Tunnel running"
  fi
}

upgrade_tenants() {
  local count
  count=$(psql_admin -d platform_db -Atc "select count(*) from platform.tenant_registry where lifecycle_status in ('active','migration_failed','suspended')")
  if [[ "$count" == 0 ]]; then detail "No tenants yet"; return; fi
  set -a; # shellcheck disable=SC1091
  source "$CONFIG_DIR/env/provisioner.env"; set +a
  run "Upgrading $count tenant schema(s)" bash -c "cd '$INSTALL_DIR' && '$NODE_BIN' scripts/migrate-tenants.mjs --apply"
}

setup_timers() {
  for unit in backup.service backup.timer healthcheck.service healthcheck.timer; do
    render "systemd/$unit" "/etc/systemd/system/$APP_SLUG-${unit}"
  done
  run "Reloading systemd" systemctl daemon-reload
  run "Enabling daily backup ($BACKUP_SCHEDULE)" systemctl enable --now "$APP_SLUG-backup.timer"
  run "Enabling health check (every $HEALTHCHECK_INTERVAL)" systemctl enable --now "$APP_SLUG-healthcheck.timer"
}

# platform-operator prints the generated password on the indented line after
# "Generated password". Only that value is kept; nothing reaches the log.
generated_password() { awk '/Generated password/ {getline; gsub(/^ +| +$/, ""); print; exit}'; }

create_owner() {
  local existing
  existing=$(psql_admin -d platform_db -Atc "select count(*) from platform.platform_user where role = 'platform_owner' and is_active")
  if [[ "$existing" != 0 ]]; then
    detail "A platform owner already exists; not creating another"
    return
  fi
  local file="$SECRETS_DIR/initial-owner.txt" output
  output=$(runuser -u postgres -- env DATABASE_ADMIN_URL="$ADMIN_URL" "$NODE_BIN" "$INSTALL_DIR/scripts/platform-operator.mjs" \
    create-operator --username "$OWNER_USERNAME" --role platform_owner --display-name "$OWNER_DISPLAY_NAME" --generate 2>&1) \
    || { echo "$output" | grep -v '^    ' >> "$LOG_FILE"; die "Could not create the platform owner (see log)"; }
  {
    echo "Platform console: https://$PLATFORM_HOST"
    echo "Username:         $OWNER_USERNAME"
    echo "Password:         $(generated_password <<<"$output")"
    echo
    echo "Sign in, enrol a security key when asked, then delete this file."
  } > "$file"
  chmod 600 "$file"
  detail "Platform owner '$OWNER_USERNAME' created; credentials in $file (root only)"
}

run_demo() {
  if [[ "$(psql_admin -d platform_db -Atc "select count(*) from consumer.user_account where email_normalized like '%@individual.io'")" == 0 ]]; then
    run "Adding 100 demo individual users" psql_admin -d platform_db -f "$INSTALL_DIR/database/seeds/001_seed_individuals.sql"
  else
    detail "Demo individual users already present"
  fi
  set -a; # shellcheck disable=SC1091
  source "$CONFIG_DIR/env/platform.env"; set +a
  local file="$SECRETS_DIR/demo-tenant.txt"
  info "Provisioning the demo tenant (the worker performs ~20 steps)"
  if ! (cd "$INSTALL_DIR" && DEMO_ACTOR="$OWNER_USERNAME" TENANT_ROOT_DOMAIN="$ROOT_DOMAIN" NODE_ENV=production \
        "$NODE_BIN" scripts/foundation/demo.mjs > "$file" 2>&1); then
    grep -v 'invitation' "$file" | tail -n 20 >&2
    die "Demo tenant could not be created (journalctl -u $APP_SLUG-provisioner)"
  fi
  chmod 600 "$file"
  grep -E '^\[demo\]' "$file" | while read -r line; do detail "${line#\[demo\] }"; done
  detail "Demo workspace and one-time owner link in $file (root only)"
}

# -----------------------------------------------------------------------------
# Commands
# -----------------------------------------------------------------------------
cmd_help() {
  cat <<EOF
${C_BOLD}Platform installer $SCRIPT_VERSION${C_RESET}

Usage: sudo ./setup.sh <command> [options]

Commands
  check                 Validate .env/ and the host; show the plan. Changes nothing.
  install               Install, or upgrade an existing installation in place.
  status                Services, ports, health, database and tenant summary.
  demo                  Add demo individual users and a demo tenant.
  owner-password        Generate a new password for OWNER_USERNAME (ends its sessions).
  backup                Run an encrypted backup now.
  logs [service]        Follow logs (landing, platform, public, tenant, provisioner,
                        postgresql, cloudflared; default: all).
  test                  Run the test suite against a throwaway database
                        (installs dependencies first if needed).
  uninstall             Stop and remove the services and system users; keeps
                        ./runtime so a later install resumes where it was.
    --purge             Also delete ./runtime (database, secrets, logs), Node
                        dependencies and builds: the folder returns to its
                        pre-installation state. ./backups is kept.
  package               Write a clean zip of this folder next to it (no runtime
                        state, builds, backups, or values from secrets.env).

Options
  --install-packages    Install missing packages (PostgreSQL, PgBouncer, Node.js,
                        cloudflared) from official repositories.
  --with-demo           With install: also run 'demo' at the end.
  --debug               Stream every command's output.
  --yes                 Do not ask for confirmation.

Configuration: .env/setup.env (decisions) and .env/secrets.env (credentials you
supply). Everything the installer creates goes to ./runtime and ./backups.
EOF
}

cmd_check() {
  STEP_TOTAL=3
  load_config
  step "Configuration"
  validate_config
  step_done "configuration is valid"
  step "Host"
  host_checks
  local missing; missing=$(missing_tools)
  if [[ -n "$missing" ]]; then
    warn "Missing: $(tr '\n' ' ' <<<"$missing")"
    warn "Install them yourself, or run install with --install-packages"
  else
    detail "All required software present"
  fi
  check_ports
  step_done "host is suitable"
  step "Existing installation"
  if systemctl list-unit-files "$APP_SLUG-platform.service" --no-legend 2>/dev/null | grep -q .; then
    detail "Found an installation of $APP_SLUG; install will upgrade it in place"
  else
    detail "No existing installation of $APP_SLUG"
  fi
  step_done
  print_plan
  echo
  echo "Next: sudo ./setup.sh install$( [[ -n "$missing" ]] && echo ' --install-packages')"
}

cmd_install() {
  STEP_TOTAL=14
  [[ $WITH_DEMO == 1 ]] && STEP_TOTAL=15
  load_config
  printf '%s%s installer %s%s  (log: %s)\n' "$C_BOLD" "$PRODUCT_NAME" "$SCRIPT_VERSION" "$C_RESET" "$LOG_FILE"

  step "Validating configuration and host"
  validate_config
  host_checks
  check_ports
  print_plan
  local upgrading=0
  systemctl list-unit-files "$APP_SLUG-platform.service" --no-legend 2>/dev/null | grep -q . && upgrading=1
  [[ $upgrading == 1 ]] && info "Existing installation found: upgrading in place"
  confirm "Proceed with $([[ $upgrading == 1 ]] && echo upgrade || echo installation)?" || die "Cancelled."
  step_done

  step "Software packages"
  local missing; missing=$(missing_tools)
  if [[ -n "$missing" ]]; then
    [[ $INSTALL_PACKAGES == 1 ]] || die "Missing: $(tr '\n' ' ' <<<"$missing"). Re-run with --install-packages, or install them yourself."
    install_packages
    missing=$(missing_tools)
    [[ -z "$missing" ]] || die "Still missing after package installation: $(tr '\n' ' ' <<<"$missing")"
  fi
  detail "node $("$NODE_BIN" --version), PostgreSQL $("$PG_BIN/postgres" --version | awk '{print $3}'), $(/usr/sbin/pgbouncer --version | head -n 1)"
  step_done

  step "System users and directories"
  create_accounts_and_directories
  move_log_to "$LOG_DIR"
  detail "Logging to $LOG_FILE"
  step_done

  step "Secrets"
  generate_secrets
  step_done "secrets ready in $SECRETS_DIR (root only)"

  step "Dependencies"
  deploy_code
  step_done

  step "Public edge ($EDGE_MODE)"
  provision_edge
  step_done

  step "Build"
  build_code
  step_done

  step "PostgreSQL"
  setup_postgres
  step_done

  step "Database, migrations and roles"
  setup_database
  step_done

  step "PgBouncer pools"
  setup_pgbouncer
  step_done

  step "Service configuration"
  write_service_environments
  step_done

  step "Starting services"
  start_services
  upgrade_tenants
  step_done "all services running"

  step "First platform owner"
  create_owner
  step_done

  step "Backups and health checks"
  setup_timers
  step_done

  if [[ $WITH_DEMO == 1 ]]; then
    step "Demo data"
    run_demo
    step_done
  fi

  local total=$(( $(date +%s) - RUN_STARTED ))
  cat <<EOF

${C_GREEN}${C_BOLD}$PRODUCT_NAME is $([[ $upgrading == 1 ]] && echo upgraded || echo installed)${C_RESET} in ${total}s.

  Platform console   https://$PLATFORM_HOST
  Individual app     https://$PUBLIC_HOST
  Landing            https://$ROOT_DOMAIN
  Tenants            https://<name>.$ROOT_DOMAIN

  Installed in       $SOURCE_DIR  (runtime state in ./runtime)
  First sign-in      sudo cat $SECRETS_DIR/initial-owner.txt
$( [[ $WITH_DEMO == 1 ]] && echo "  Demo tenant        sudo cat $SECRETS_DIR/demo-tenant.txt" )
  Backup key         $SECRETS_DIR/backup.key  (copy it off this server)
  Status             sudo ./setup.sh status
  Log of this run    $LOG_FILE
EOF
  if [[ "$EDGE_MODE" == none ]]; then
    warn "EDGE_MODE=none: route HTTPS for the hostnames above to 127.0.0.1 ports $LANDING_PORT (landing), $PLATFORM_PORT (platform), $PUBLIC_PORT (individual app) and $TENANT_PORT (all tenant subdomains). See README."
  fi
  if [[ "$EDGE_MODE" == cloudflare-token ]]; then
    warn "Add these public hostnames to your tunnel: $ROOT_DOMAIN and www -> http://127.0.0.1:$LANDING_PORT, $PLATFORM_HOST -> :$PLATFORM_PORT, $PUBLIC_HOST -> :$PUBLIC_PORT, *.$ROOT_DOMAIN -> :$TENANT_PORT"
  fi
}

load_installed() {
  require_root
  load_config
  [[ -f "$CONFIG_DIR/install.env" ]] || die "No installation found for $APP_SLUG ($CONFIG_DIR/install.env missing). Run install first."
  move_log_to "$LOG_DIR"
}

cmd_status() {
  load_installed
  printf '%s%s%s  (installed %s)\n\n' "$C_BOLD" "$PRODUCT_NAME" "$C_RESET" "$(grep INSTALLED_AT "$CONFIG_DIR/install.env" | cut -d= -f2)"
  printf '  %-34s %-10s %s\n' SERVICE STATE SINCE
  local units=(postgresql pgbouncer@platform pgbouncer@public pgbouncer@tenant "${APP_UNITS[@]}")
  [[ "$EDGE_MODE" == cloudflare-* ]] && units+=(cloudflared)
  for unit in "${units[@]}"; do
    local state since color
    state=$(systemctl is-active "$APP_SLUG-$unit.service" 2>/dev/null || true)
    since=$(systemctl show -p ActiveEnterTimestamp --value "$APP_SLUG-$unit.service" 2>/dev/null)
    [[ "$state" == active ]] && color=$C_GREEN || color=$C_RED
    printf '  %-34s %s%-10s%s %s\n' "$APP_SLUG-$unit" "$color" "$state" "$C_RESET" "$since"
  done
  for timer in backup healthcheck; do
    local next
    next=$(systemctl list-timers --all --no-legend "$APP_SLUG-$timer.timer" 2>/dev/null | awk '{print $1, $2, $3, $4}')
    printf '  %-34s %-10s next: %s\n' "$APP_SLUG-$timer.timer" "$(systemctl is-active "$APP_SLUG-$timer.timer" 2>/dev/null || true)" "${next:-n/a}"
  done
  echo
  if systemctl is-active --quiet "$APP_SLUG-postgresql.service"; then
    psql_admin -d platform_db -At <<'SQL' | sed 's/^/  /'
select 'Platform migrations:  ' || count(*) from platform.schema_migration;
select 'Platform operators:   ' || count(*) filter (where is_active) || ' active' from platform.platform_user;
select 'Tenants:              ' || coalesce(string_agg(n || ' ' || lifecycle_status, ', '), 'none')
  from (select lifecycle_status, count(*) n from platform.tenant_registry where lifecycle_status <> 'deleted' group by 1) t;
select 'Tenant jobs running:  ' || count(*) from platform.tenant_provisioning_job where status in ('pending','running','retrying');
select 'Individual users:     ' || count(*) from consumer.user_account where account_status <> 'deleted';
SQL
    local newest; newest=$(ls -1t "$BACKUP_DIR"/platform-backup-*.tar.gz.enc 2>/dev/null | head -n 1 || true)
    echo "  Newest backup:        ${newest:-none yet}"
  fi
  echo
  set -a; # shellcheck disable=SC1091
  source "$CONFIG_DIR/install.env"; set +a
  if HEALTHCHECK_VERBOSE=1 bash "$INSTALL_DIR/scripts/healthcheck.sh"; then
    printf '\n%sHealthy.%s\n' "$C_GREEN" "$C_RESET"
  else
    printf '\n%sSome checks failed (above).%s\n' "$C_RED" "$C_RESET"
    return 1
  fi
}

cmd_demo() {
  STEP_TOTAL=1
  load_installed
  step "Demo data"
  run_demo
  step_done
  echo "Demo workspace and owner link: sudo cat $SECRETS_DIR/demo-tenant.txt"
}

cmd_owner_password() {
  load_installed
  local file="$SECRETS_DIR/initial-owner.txt" output
  output=$(runuser -u postgres -- env DATABASE_ADMIN_URL="$ADMIN_URL" "$NODE_BIN" "$INSTALL_DIR/scripts/platform-operator.mjs" \
    set-password --username "$OWNER_USERNAME" --generate 2>&1) || die "Password reset failed"
  { echo "Platform console: https://$PLATFORM_HOST"; echo "Username:         $OWNER_USERNAME"; echo "Password:         $(generated_password <<<"$output")"; } > "$file"
  chmod 600 "$file"
  info "New password for $OWNER_USERNAME written to $file (root only). Existing sessions were ended."
}

cmd_backup() {
  load_installed
  info "Running backup now (same job as the daily timer)"
  systemctl start "$APP_SLUG-backup.service" || die "Backup failed (journalctl -u $APP_SLUG-backup)"
  journalctl -u "$APP_SLUG-backup" -n 5 --no-pager -o cat | sed 's/^/  /'
}

cmd_logs() {
  load_installed
  local target="${1:-}"
  if [[ -n "$target" ]]; then exec journalctl -f -u "$APP_SLUG-$target"; fi
  exec journalctl -f -u "$APP_SLUG-*"
}

cmd_test() {
  load_config
  [[ -n "$NODE_BIN" ]] || die "Node.js 22+ is needed for tests (install it, or run install first)."
  export PATH="$(dirname "$NODE_BIN"):$PATH"
  local pg="/usr/lib/postgresql/16/bin"
  [[ -x "$pg/initdb" ]] || pg=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -n 1)
  [[ -x "$pg/initdb" ]] || die "PostgreSQL server binaries are needed for tests (install postgresql)."
  cd "$SOURCE_DIR"
  if [[ ! -d node_modules ]]; then
    run "Installing dependencies (npm ci)" npm ci --no-audit --no-fund
  fi
  if [[ ! -f backend/dist/server.js ]]; then
    run "Building shared packages and backends" bash -c 'npm run build:server-kit && npm run build:cloudflare && npm run build:drizzle && npm run build:backend'
  fi
  info "Running the test suite against a throwaway PostgreSQL cluster (nothing installed is touched)"
  PG_BIN="$pg" bash scripts/with-test-cluster.sh node --test --test-concurrency=1 'tests/unit/**/*.test.mjs' 'tests/integration/**/*.test.mjs'
}

cmd_uninstall() {
  require_root
  load_config
  local unit="/etc/systemd/system/$APP_SLUG-platform.service" other
  if [[ -f "$unit" ]]; then
    other=$(sed -n 's/^WorkingDirectory=//p' "$unit")
    [[ "$other" == "$SOURCE_DIR" ]] || die "APP_SLUG '$APP_SLUG' belongs to the installation in $other; run uninstall from that folder."
  fi
  warn "This stops and removes all $APP_SLUG services."
  warn "It also removes the system users <$APP_SLUG>-*. ./runtime is kept unless --purge is given."
  [[ $PURGE == 1 ]] && warn "--purge DELETES $RUNTIME_DIR (database, tenant files, secrets, logs), node_modules and builds. Backups in $BACKUP_DIR are kept."
  if [[ $ASSUME_YES != 1 ]]; then
    local answer
    read -r -p "Type the slug ($APP_SLUG) to confirm: " answer
    [[ "$answer" == "$APP_SLUG" ]] || die "Cancelled."
  fi
  STEP_TOTAL=$(( PURGE == 1 ? 3 : 2 ))
  step "Removing services"
  for unit in healthcheck.timer backup.timer cloudflared.service "${APP_UNITS[@]/%/.service}" pgbouncer@tenant.service pgbouncer@public.service pgbouncer@platform.service postgresql.service; do
    systemctl disable --now "$APP_SLUG-$unit" >> "$LOG_FILE" 2>&1 || true
  done
  rm -f /etc/systemd/system/"$APP_SLUG"-*.service /etc/systemd/system/"$APP_SLUG"-*.timer
  systemctl daemon-reload
  step_done "services removed"
  step "Removing system users"
  for account in landing platform public tenant provisioner pgbouncer cloudflared; do userdel "$APP_SLUG-$account" >> "$LOG_FILE" 2>&1 || true; done
  for group in landing platform public tenant pgbouncer cloudflared; do groupdel "$APP_SLUG-$group" >> "$LOG_FILE" 2>&1 || true; done
  step_done "users removed"
  if [[ $PURGE == 1 ]]; then
    step "Returning the folder to its pre-installation state"
    rm -rf "$RUNTIME_DIR"
    detail "Removed runtime state ($RUNTIME_DIR)"
    find "$SOURCE_DIR" -name node_modules -type d -prune -exec rm -rf {} +
    find "$SOURCE_DIR" -path "$BACKUP_DIR" -prune -o -name dist -type d -prune -exec rm -rf {} +
    find "$SOURCE_DIR" -name '*.tsbuildinfo' -delete
    detail "Removed dependencies and builds"
    step_done "folder is back to its pre-installation state (backups kept in $BACKUP_DIR)"
  else
    info "Runtime state kept in $RUNTIME_DIR; 'sudo ./setup.sh install' resumes it."
  fi
}

# Zip of the folder as it was before installation: no runtime state, builds,
# dependencies or backups, and secrets.env with every value blanked.
cmd_package() {
  load_config
  local name stamp output stage
  name=$(basename "$SOURCE_DIR")
  stamp=$(date -u +%Y%m%d-%H%M%S)
  output="$(dirname "$SOURCE_DIR")/$name-$stamp.zip"
  stage=$(mktemp -d)
  info "Staging a clean copy of $SOURCE_DIR"
  (cd "$SOURCE_DIR" && find . \( -path ./runtime -o -path ./backups -o -path "./${BACKUP_DIR#"$SOURCE_DIR"/}" \
      -o -name node_modules -o -name dist -o -name .git \) -prune -o \
      \( -type f ! -name '*.tsbuildinfo' ! -name '*.log' ! -name '*.local' -print0 \) ) \
    | (cd "$SOURCE_DIR" && xargs -0 cp --parents -t "$stage/")
  mkdir -p "$stage/.env"
  local blanked
  blanked=$(grep -cE '^[A-Z_]+=.+' "$stage/.env/secrets.env" 2>/dev/null || true)
  sed -i -E 's/^([A-Z_]+)=.*/\1=/' "$stage/.env/secrets.env"
  [[ "${blanked:-0}" -gt 0 ]] && warn "Blanked $blanked value(s) from .env/secrets.env in the package (your folder is unchanged)"
  chmod +x "$stage/setup.sh"
  if command -v zip >/dev/null; then
    (cd "$stage" && zip -qr -X "$output" .)
  elif command -v python3 >/dev/null; then
    (cd "$stage" && python3 -c 'import os,sys,zipfile
with zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED) as z:
  for root,dirs,files in os.walk("."):
    dirs.sort()
    for f in sorted(files): z.write(os.path.join(root,f))' "$output")
  else
    output="${output%.zip}.tar.gz"
    tar -C "$stage" -czf "$output" .
  fi
  local files; files=$(find "$stage" -type f | wc -l)
  rm -rf "$stage"
  info "Package written: $output ($files files, $(du -h "$output" | cut -f1))"
  echo "Deploy: unzip into an empty folder (e.g. /opt/$APP_SLUG), edit .env/, then: sudo ./setup.sh check"
}

case "$COMMAND" in
  help|-h|--help) cmd_help ;;
  check) cmd_check ;;
  install) cmd_install ;;
  status) cmd_status ;;
  demo) cmd_demo ;;
  owner-password) cmd_owner_password ;;
  backup) cmd_backup ;;
  logs) cmd_logs "${ARGS[@]}" ;;
  test) cmd_test ;;
  uninstall) cmd_uninstall ;;
  package) cmd_package ;;
  *) echo "Unknown command: $COMMAND" >&2; cmd_help; exit 2 ;;
esac
