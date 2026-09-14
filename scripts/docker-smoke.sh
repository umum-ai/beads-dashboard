#!/usr/bin/env bash
# Smoke test of the container image against a real stand (scratch dolt + seeded database).
#
#   scripts/docker-smoke.sh [--image TAG] [--no-build] [--keep-image]
#
# Builds the image (unless --no-build), brings up scripts/stand.sh (or reuses STAND_DIR when it
# is already running), runs the container with --network host against the stand's dolt, and
# checks: /readyz, /api/meta (database ready), the seeded snapshot, `GET /` → board, the board
# HTML loads its assets, the org.beads.version label, and `bddb doctor` exit codes (0 against the
# stand, non-zero against a wrong port). Cleans up everything it started.
#
# Env: STAND_DIR (default .stand-smoke), STAND_DOLT_PORT (3799), STAND_BD_PORT (47713),
#      SMOKE_PORT (7371, the container's BDDB_PORT on the host network), BEADS_VERSION
#      (default: the mise.toml pin), IMAGE (default bddb:smoke).
#      Addresses (defaults suit Linux Docker Engine, where --network host shares this loopback):
#      SMOKE_DOLT_HOST — how the container reaches the stand's dolt (default 127.0.0.1);
#      SMOKE_DOLT_BIND — dolt listen address (default 127.0.0.1, or 0.0.0.0 when SMOKE_DOLT_HOST
#      is not loopback); SMOKE_HOST — how this shell reaches the container (default 127.0.0.1).
#      From a Linux VM under Docker Desktop / OrbStack: SMOKE_DOLT_HOST=<this machine's IP>
#      SMOKE_HOST=host.docker.internal.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="${IMAGE:-bddb:smoke}"
build=1
keep_image=0
while [ $# -gt 0 ]; do
  case "$1" in
    --image) IMAGE="$2"; shift 2 ;;
    --no-build) build=0; shift ;;
    --keep-image) keep_image=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "docker-smoke.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

STAND_DIR="${STAND_DIR:-.stand-smoke}"
STAND_DOLT_PORT="${STAND_DOLT_PORT:-3799}"
STAND_BD_PORT="${STAND_BD_PORT:-47713}"
SMOKE_PORT="${SMOKE_PORT:-7371}"
SMOKE_DOLT_HOST="${SMOKE_DOLT_HOST:-127.0.0.1}"
if [ "$SMOKE_DOLT_HOST" = "127.0.0.1" ]; then
  SMOKE_DOLT_BIND="${SMOKE_DOLT_BIND:-127.0.0.1}"
else
  SMOKE_DOLT_BIND="${SMOKE_DOLT_BIND:-0.0.0.0}"
fi
SMOKE_HOST="${SMOKE_HOST:-127.0.0.1}"
BEADS_VERSION="${BEADS_VERSION:-$(scripts/check-pins.sh --print)}"
CONTAINER="bddb-smoke-$$"
export STAND_DIR

pass() { echo "  ✓ $*"; }
fail() { echo "  ✗ $*" >&2; exit 1; }

started_stand=0
cleanup() {
  set +e
  docker rm -f "$CONTAINER" >/dev/null 2>&1
  if [ "$started_stand" = 1 ]; then
    scripts/stand.sh down --purge >/dev/null 2>&1
  fi
  if [ "$keep_image" = 0 ] && [ "$build" = 1 ]; then
    docker rmi -f "$IMAGE" >/dev/null 2>&1
  fi
}
trap cleanup EXIT

echo "== image $IMAGE (beads $BEADS_VERSION)"
if [ "$build" = 1 ]; then
  docker build --build-arg "BEADS_VERSION=$BEADS_VERSION" --build-arg BDDB_VERSION=0.0.0-smoke \
    -t "$IMAGE" . >"${TMPDIR:-/tmp}/bddb-smoke-build.log" 2>&1 \
    || { tail -40 "${TMPDIR:-/tmp}/bddb-smoke-build.log"; fail "docker build"; }
  pass "docker build"
fi
echo "  size: $(docker image ls "$IMAGE" --format '{{.Size}}')"

label="$(docker inspect "$IMAGE" --format '{{index .Config.Labels "org.beads.version"}}')"
[ "$label" = "$BEADS_VERSION" ] || fail "label org.beads.version=$label, expected $BEADS_VERSION"
pass "label org.beads.version=$label"

echo "== stand ($STAND_DIR, dolt $STAND_DOLT_PORT)"
if scripts/stand.sh status >/dev/null 2>&1 && [ -f "$STAND_DIR/stand.env" ]; then
  echo "  reusing running stand"
else
  STAND_DOLT_BIND="$SMOKE_DOLT_BIND" scripts/stand.sh up --dolt-port "$STAND_DOLT_PORT" --bd-port "$STAND_BD_PORT" >/dev/null
  started_stand=1
  seed_ids="$(scripts/stand.sh seed | grep -E '^SEED_[A-Z0-9]+=')"
  eval "$seed_ids"
fi
# shellcheck disable=SC1091
source "$STAND_DIR/stand.env"
DOLT_PORT="${DOLT_PORT:-$STAND_DOLT_PORT}"
DATABASE="${DATABASE:-kb}"
pass "stand up: dolt $SMOKE_DOLT_BIND:$DOLT_PORT database $DATABASE (container → $SMOKE_DOLT_HOST:$DOLT_PORT)"

echo "== doctor"
if docker run --rm --network host -e "BDDB_DOLT_HOST=$SMOKE_DOLT_HOST" -e "BDDB_DOLT_PORT=$DOLT_PORT" \
     -e "BDDB_DATABASES=$DATABASE" "$IMAGE" doctor >"${TMPDIR:-/tmp}/bddb-smoke-doctor.log" 2>&1; then
  pass "doctor exits 0 against the stand"
else
  cat "${TMPDIR:-/tmp}/bddb-smoke-doctor.log"; fail "doctor against the stand"
fi
if docker run --rm --network host -e "BDDB_DOLT_HOST=$SMOKE_DOLT_HOST" -e BDDB_DOLT_PORT=1 "$IMAGE" doctor >/dev/null 2>&1; then
  fail "doctor exited 0 against a wrong port"
fi
pass "doctor exits non-zero against a wrong port"

echo "== serve"
docker run -d --name "$CONTAINER" --network host \
  -e "BDDB_DOLT_HOST=$SMOKE_DOLT_HOST" -e "BDDB_DOLT_PORT=$DOLT_PORT" -e "BDDB_DATABASES=$DATABASE" \
  -e "BDDB_PORT=$SMOKE_PORT" "$IMAGE" >/dev/null
base="http://$SMOKE_HOST:$SMOKE_PORT"
for _ in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$base/readyz" || true)"
  [ "$code" = "200" ] && break
  sleep 1
done
[ "$code" = "200" ] || { docker logs "$CONTAINER" | tail -30; fail "/readyz did not become 200 (last $code)"; }
pass "/readyz 200"

meta="$(curl -sf "$base/api/meta")"
state="$(printf '%s' "$meta" | jq -r --arg db "$DATABASE" '.databases[] | select(.name == $db) | .state')"
[ "$state" = "ready" ] || fail "/api/meta: $DATABASE state=$state"
pass "/api/meta: $DATABASE ready (bd $(printf '%s' "$meta" | jq -r --arg db "$DATABASE" '.databases[] | select(.name == $db) | .bdVersion'))"

count="$(curl -sf "$base/api/p/$DATABASE/snapshot" | jq '.issues | length')"
[ "$count" -ge 1 ] || fail "snapshot has no issues"
if [ -n "${SEED_TASK:-}" ]; then
  curl -sf "$base/api/p/$DATABASE/snapshot" | jq -e --arg id "$SEED_TASK" '.issues[] | select(.id == $id)' >/dev/null \
    || fail "snapshot lacks seeded issue $SEED_TASK"
fi
pass "snapshot: $count issues (seed ${SEED_TASK:-?} present)"

location="$(curl -s -o /dev/null -w '%{redirect_url}' "$base/")"
[ "$location" = "$base/p/$DATABASE/board" ] || fail "GET / → $location"
pass "GET / → /p/$DATABASE/board"

html="$(curl -sf "$base/p/$DATABASE/board")"
assets="$(printf '%s' "$html" | grep -o 'href="[^"]*\.css"\|src="[^"]*\.js"' | sed 's/^[a-z]*="//;s/"$//')"
[ -n "$assets" ] || fail "board HTML references no assets"
for a in $assets; do
  url="$base/${a#./}"
  [ "${a#/}" = "$a" ] || url="$base$a"
  code="$(curl -s -o /dev/null -w '%{http_code}' "$url")"
  [ "$code" = "200" ] || fail "asset $a → $code"
  pass "asset $a → 200"
done

# The HEALTHCHECK probe itself (docker reports "starting" until the first interval elapses).
docker exec "$CONTAINER" bun -e "fetch('http://127.0.0.1:$SMOKE_PORT/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))" \
  || fail "healthcheck probe inside the container"
pass "healthcheck probe (docker status: $(docker inspect "$CONTAINER" --format '{{.State.Health.Status}}'))"

echo "== ok"
