#!/usr/bin/env bash
# Periodic health check for an installation made by setup.sh. Reads its
# settings from CONFIG_DIR/install.env (passed in by the systemd unit, or
# sourced when run by hand: sudo ./setup.sh status runs the same checks).
# Exit code 0 = healthy; any failure is printed and the unit is marked failed.
set -uo pipefail

: "${APP_SLUG:?APP_SLUG missing (run via the healthcheck unit or setup.sh status)}"
failures=0
fail() { echo "UNHEALTHY: $*" >&2; failures=$((failures + 1)); }
ok() { [[ "${HEALTHCHECK_VERBOSE:-0}" == 1 ]] && echo "ok: $*"; return 0; }

for unit in postgresql pgbouncer@platform pgbouncer@public pgbouncer@tenant landing platform public tenant provisioner; do
  if systemctl is-active --quiet "$APP_SLUG-$unit.service"; then ok "$APP_SLUG-$unit active"; else fail "service $APP_SLUG-$unit is not active"; fi
done
if [[ "$EDGE_MODE" == cloudflare-* ]]; then
  systemctl is-active --quiet "$APP_SLUG-cloudflared.service" && ok "tunnel active" || fail "service $APP_SLUG-cloudflared is not active"
fi

probe() { # expected-code host url
  local code attempt=0
  while (( attempt < 3 )); do
    code=$(curl --silent --output /dev/null --write-out '%{http_code}' --connect-timeout 3 --max-time 10 --header "Host: $2" "$3" || true)
    [[ "$code" == "$1" ]] && { ok "$3 -> $code"; return 0; }
    attempt=$((attempt + 1)); sleep 2
  done
  fail "$3 answered $code (expected $1)"
}
probe 200 localhost "http://127.0.0.1:$LANDING_PORT/api/health"
probe 200 localhost "http://127.0.0.1:$PLATFORM_PORT/api/health"
probe 200 localhost "http://127.0.0.1:$PUBLIC_PORT/api/health"
probe 404 "healthcheck-unknown.$ROOT_DOMAIN" "http://127.0.0.1:$TENANT_PORT/api/health"

if [[ "$EDGE_MODE" != none && "${HEALTHCHECK_PUBLIC:-true}" == true ]]; then
  probe 200 "$PLATFORM_HOST" "https://$PLATFORM_HOST/api/health"
  probe 200 "$PUBLIC_HOST" "https://$PUBLIC_HOST/api/health"
  probe 200 "$ROOT_DOMAIN" "https://$ROOT_DOMAIN/api/health"
fi

if [[ -r "$CONFIG_DIR/secrets/pgbouncer-stats.env" ]]; then
  # shellcheck disable=SC1091
  source "$CONFIG_DIR/secrets/pgbouncer-stats.env"
  for port in "$PGBOUNCER_PLATFORM_PORT" "$PGBOUNCER_PUBLIC_PORT" "$PGBOUNCER_TENANT_PORT"; do
    if PGPASSWORD="$PGBOUNCER_STATS_PASSWORD" "$PG_BIN/psql" -h 127.0.0.1 -p "$port" -U pgbouncer_stats -d pgbouncer -Atqc 'show pools' >/dev/null 2>&1; then
      ok "pgbouncer :$port"
    else
      fail "PgBouncer on port $port does not answer SHOW POOLS"
    fi
  done
fi

stale=$(runuser -u postgres -- "$PG_BIN/psql" -h "/run/$APP_SLUG-postgresql" -p "$POSTGRES_PORT" -d platform_db -Atqc \
  "select count(*) from platform.tenant_provisioning_job where status = 'running' and locked_at < now() - interval '3 minutes'" 2>/dev/null || echo error)
if [[ "$stale" == error ]]; then fail "database query failed"
elif [[ "$stale" != 0 ]]; then fail "$stale provisioning job(s) stuck for more than 3 minutes"
else ok "no stuck provisioning jobs"; fi

newest=$(find "$BACKUP_DIR" -maxdepth 1 -name 'platform-backup-*.tar.gz.enc' -mmin -1560 2>/dev/null | head -n 1)
if [[ -z "$newest" && -n "$(find "$BACKUP_DIR" -maxdepth 1 -name 'platform-backup-*' 2>/dev/null | head -n 1)" ]]; then
  fail "newest backup in $BACKUP_DIR is older than 26 hours"
fi

if (( failures > 0 )); then
  echo "$failures health check(s) failed" >&2
  exit 1
fi
echo "healthy"
