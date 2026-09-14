#!/usr/bin/env bash
# dev.sh — run the BFF with hot reload against the local stand (scripts/stand.sh).
#
# Starts the stand if it is not up (dolt on 3399, seeded `kb` database), then runs
# `bun --hot src/server/main.ts` pointed at it. BDDB_* variables you export win over the
# defaults below (e.g. BDDB_PORT=8080 scripts/dev.sh). Stop with Ctrl-C; the stand keeps
# running (`scripts/stand.sh down` stops it).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

STAND_DIR="${STAND_DIR:-$REPO_ROOT/.stand}"
export STAND_DIR

if ! scripts/stand.sh status >/dev/null 2>&1; then
  echo "dev: starting the stand in $STAND_DIR" >&2
  scripts/stand.sh up >/dev/null
  scripts/stand.sh seed >/dev/null || true
fi

# shellcheck disable=SC1091
source "$STAND_DIR/stand.env"

export BDDB_HOST="${BDDB_HOST:-127.0.0.1}"
export BDDB_PORT="${BDDB_PORT:-7331}"
export BDDB_DOLT_HOST="${BDDB_DOLT_HOST:-127.0.0.1}"
export BDDB_DOLT_PORT="${BDDB_DOLT_PORT:-$DOLT_PORT}"
export BDDB_DATABASES="${BDDB_DATABASES:-$DATABASE}"
export BDDB_POLL_INTERVAL="${BDDB_POLL_INTERVAL:-5s}"
export BDDB_LOG_LEVEL="${BDDB_LOG_LEVEL:-debug}"
export BDDB_WORK_DIR="${BDDB_WORK_DIR:-$STAND_DIR/bddb-work}"
export NODE_ENV="${NODE_ENV:-development}"

# The dev shell may bind bd to a real store; bddb scrubs BEADS_*/BD_* for its children anyway,
# but keep this process clean too.
while IFS= read -r v; do unset "$v"; done < <(compgen -e | grep -E '^(BEADS_|BD_)' || true)

echo "dev: http://$BDDB_HOST:$BDDB_PORT (dolt 127.0.0.1:$BDDB_DOLT_PORT, databases $BDDB_DATABASES)" >&2
exec bun --hot src/server/main.ts
