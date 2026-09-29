#!/bin/sh
# Usage: wait-for-origin.sh <host-header> <url> [ok|any]
#   ok  (default) the URL must answer 2xx.
#   any           any HTTP answer means the origin is listening (used for the
#                 tenant origin, which answers 404 for hosts it does not serve).
set -eu

host=$1
url=$2
mode=${3:-ok}
attempt=0

while [ "$attempt" -lt 20 ]; do
  if [ "$mode" = any ]; then
    code=$(/usr/bin/curl --silent --output /dev/null --write-out '%{http_code}' \
      --connect-timeout 2 --max-time 3 --header "Host: $host" "$url" || true)
    [ "$code" != "000" ] && exit 0
  elif /usr/bin/curl --fail --silent --show-error \
    --connect-timeout 2 --max-time 3 --header "Host: $host" "$url" >/dev/null; then
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 1
done

echo "Origin readiness check failed for $host" >&2
exit 1
