#!/usr/bin/env bash
# Exercises a built image over its published port: the browser app, its
# generated configuration, and the bearer boundary that still guards the API.
set -euo pipefail

image="${1:?usage: smoke-container.sh <image>}"
container="pizza-bot-smoke-$$"
port="${PIZZA_SMOKE_PORT:-8080}"
origin="http://127.0.0.1:${port}"
token="pizza-bot-container-smoke-token-0000000000"

cleanup() {
  docker rm --force "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --detach --name "$container" \
  --env PIZZA_API_TOKEN="$token" \
  --env PIZZA_ALLOWED_ORIGINS="$origin" \
  --publish "127.0.0.1:${port}:8080" \
  "$image" >/dev/null

# The generated config needs no model, so it reports the listener is up without
# racing background provider warmup.
for _ in $(seq 60); do
  if curl -sf "${origin}/pizza-config.js" >/dev/null 2>&1; then break; fi
  sleep 1
done

fail() {
  echo "::error::$1"
  docker logs "$container" || true
  exit 1
}

config="$(curl -sf "${origin}/pizza-config.js")" || fail "the image did not serve pizza-config.js"
grep -q '"apiBase":"/"' <<<"$config" || fail "pizza-config.js does not point the app at this origin"
grep -q "\"apiToken\":\"${token}\"" <<<"$config" || fail "pizza-config.js omits the configured token"

shell="$(curl -sf -H 'accept: text/html' "${origin}/")" || fail "the image did not serve the app shell"
grep -q 'id="root"' <<<"$shell" || fail "the app shell is not the built browser app"

asset="$(grep -o 'assets/[A-Za-z0-9._-]*\.js' <<<"$shell" | head -1)"
[[ -n "$asset" ]] || fail "the app shell references no built asset"
curl -sf "${origin}/${asset}" >/dev/null || fail "the image did not serve ${asset}"

identity="$(curl -sf -H "authorization: Bearer ${token}" "${origin}/")" ||
  fail "the authenticated service identity is unreachable"
grep -q '"service":"pizza-bot"' <<<"$identity" ||
  fail "/ returned the app shell instead of the service identity"

status="$(curl -s -o /dev/null -w '%{http_code}' "${origin}/status")"
[[ "$status" == "401" ]] || fail "unauthenticated API access returned ${status}, expected 401"

echo "container smoke passed: ${image}"
