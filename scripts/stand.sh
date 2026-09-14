#!/usr/bin/env bash
# stand.sh — local test stand for bddb contract/e2e tests:
# a scratch `dolt sql-server` + a beads workspace in server mode + `bd serve`.
#
# Usage:
#   scripts/stand.sh up     [--dir DIR] [--dolt-port P] [--bd-port P] [--prefix kb] [--database NAME]
#   scripts/stand.sh down   [--dir DIR] [--purge]
#   scripts/stand.sh seed   [--dir DIR]
#   scripts/stand.sh create-issue TITLE [--dir DIR] [--type T] [--priority N]   # prints the new id
#   scripts/stand.sh status [--dir DIR]
#   scripts/stand.sh --help
#
# Env: STAND_DIR (default DIR), BDDB_BD_PATH (bd binary, default `bd`),
#      STAND_DOLT_PORT / STAND_BD_PORT / STAND_PREFIX / STAND_DATABASE (defaults for the flags).
# All BEADS_* / BD_* variables of the caller are ignored (the stand must never reach a real store).
# Never touches any dolt/bd process it did not start itself (pid files in DIR).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The caller's shell may bind bd to a real store (BEADS_DIR, BEADS_DOLT_SHARED_SERVER,
# BEADS_SHARED_SERVER_DIR, BEADS_DOLT_SERVER_*...). The stand must never touch it:
# scrub every BEADS_* / BD_* variable so bd only sees the scratch workspace.
while IFS= read -r v; do unset "$v"; done < <(compgen -e | grep -E '^(BEADS_|BD_)' || true)
BD="${BDDB_BD_PATH:-bd}"
DOLT="${BDDB_DOLT_PATH:-dolt}"

DIR="${STAND_DIR:-.stand}"
DOLT_PORT="${STAND_DOLT_PORT:-3399}"
BD_PORT="${STAND_BD_PORT:-47313}"
PREFIX="${STAND_PREFIX:-kb}"
DATABASE="${STAND_DATABASE:-}"
PURGE=0
CMD=""
TITLE=""
ISSUE_TYPE="task"
PRIORITY="2"

usage() {
  sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

log() { printf 'stand: %s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }

# ---------- args ----------
[[ $# -gt 0 ]] || { usage; exit 2; }
case "$1" in
  up|down|seed|status) CMD="$1"; shift ;;
  create-issue) CMD="$1"; shift; [[ $# -gt 0 && "$1" != -* ]] && { TITLE="$1"; shift; } ;;
  -h|--help|help) usage; exit 0 ;;
  *) die "unknown command '$1' (see --help)" ;;
esac
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --dolt-port) DOLT_PORT="$2"; shift 2 ;;
    --bd-port) BD_PORT="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --database) DATABASE="$2"; shift 2 ;;
    --purge) PURGE=1; shift ;;
    --type) ISSUE_TYPE="$2"; shift 2 ;;
    --priority) PRIORITY="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option '$1' (see --help)" ;;
  esac
done

# Resolve DIR relative to repo root, make absolute.
[[ "$DIR" = /* ]] || DIR="$REPO_ROOT/$DIR"
WS_DIR="$DIR/ws"
DOLT_DATA="$DIR/dolt"
DOLT_PID="$DIR/dolt.pid"
DOLT_LOG="$DIR/dolt.log"
BD_PID="$DIR/bd-serve.pid"
BD_LOG="$DIR/bd-serve.log"
ENV_FILE="$DIR/stand.env"
BD_URL="http://127.0.0.1:$BD_PORT/v0/beads"

# ---------- helpers ----------
pid_alive() { # pid_alive PIDFILE PATTERN
  local f="$1" pat="$2" pid
  [[ -s "$f" ]] || return 1
  pid="$(cat "$f")"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null || return 1
  # Make sure the pid still belongs to the process we started.
  grep -q -- "$pat" "/proc/$pid/cmdline" 2>/dev/null
}

port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

wait_port() { # wait_port PORT SECONDS
  local i
  for ((i = 0; i < $2 * 10; i++)); do
    port_open "$1" && return 0
    sleep 0.1
  done
  return 1
}

http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$1" 2>/dev/null || true; }

wait_http() { # wait_http URL SECONDS
  local i
  for ((i = 0; i < $2 * 10; i++)); do
    [[ "$(http_code "$1")" == 200 ]] && return 0
    sleep 0.1
  done
  return 1
}

stop_pidfile() { # stop_pidfile PIDFILE PATTERN NAME
  local f="$1" pat="$2" name="$3" pid i
  if pid_alive "$f" "$pat"; then
    pid="$(cat "$f")"
    log "stopping $name (pid $pid)"
    kill -TERM "$pid" 2>/dev/null || true
    for ((i = 0; i < 100; i++)); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then
      log "$name did not exit, sending KILL"
      kill -KILL "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$f"
}

print_env() {
  cat <<ENV
STAND_DIR=$DIR
DOLT_PORT=$DOLT_PORT
BD_PORT=$BD_PORT
BD_URL=$BD_URL
WS_DIR=$WS_DIR
DATABASE=$DATABASE
ENV
}

read_database() {
  # database name as bd recorded it in the workspace metadata
  local meta="$WS_DIR/.beads/metadata.json"
  if [[ -f "$meta" ]]; then
    sed -n 's/.*"dolt_database": *"\([^"]*\)".*/\1/p' "$meta" | head -1
  fi
}

# ---------- commands ----------
cmd_up() {
  mkdir -p "$DIR" "$DOLT_DATA"

  # 1. dolt sql-server
  if pid_alive "$DOLT_PID" "dolt"; then
    log "dolt already running (pid $(cat "$DOLT_PID"))"
  else
    rm -f "$DOLT_PID"
    port_open "$DOLT_PORT" && die "port $DOLT_PORT is already in use by a process we did not start; pick --dolt-port"
    log "starting dolt sql-server on 127.0.0.1:$DOLT_PORT (data: $DOLT_DATA)"
    nohup "$DOLT" sql-server --host 127.0.0.1 --port "$DOLT_PORT" --data-dir "$DOLT_DATA" \
      >"$DOLT_LOG" 2>&1 </dev/null &
    echo $! >"$DOLT_PID"
    wait_port "$DOLT_PORT" 30 || { tail -20 "$DOLT_LOG" >&2; die "dolt did not open port $DOLT_PORT"; }
  fi

  # 2. workspace
  if [[ ! -f "$WS_DIR/.beads/metadata.json" ]]; then
    log "initialising workspace $WS_DIR (prefix $PREFIX)"
    mkdir -p "$WS_DIR"
    [[ -d "$WS_DIR/.git" ]] || git -C "$WS_DIR" init -q .
    local init_args=(init --prefix "$PREFIX" --server --external
      --server-host 127.0.0.1 --server-port "$DOLT_PORT" --skip-agents --skip-hooks)
    [[ -n "$DATABASE" ]] && init_args+=(--database "$DATABASE")
    (cd "$WS_DIR" && BD_NON_INTERACTIVE=1 "$BD" "${init_args[@]}") >"$DIR/bd-init.log" 2>&1 \
      || { cat "$DIR/bd-init.log" >&2; die "bd init failed"; }
    (cd "$WS_DIR" && "$BD" config set events-journal true) >>"$DIR/bd-init.log" 2>&1 \
      || { cat "$DIR/bd-init.log" >&2; die "bd config set events-journal failed"; }
  fi
  DATABASE="$(read_database)"
  [[ -n "$DATABASE" ]] || DATABASE="$PREFIX"

  # 3. bd serve
  if pid_alive "$BD_PID" "serve" && [[ "$(http_code "$BD_URL/context")" == 200 ]]; then
    log "bd serve already running (pid $(cat "$BD_PID"))"
  else
    stop_pidfile "$BD_PID" "serve" "stale bd serve"
    port_open "$BD_PORT" && die "port $BD_PORT is already in use by a process we did not start; pick --bd-port"
    log "starting bd serve on 127.0.0.1:$BD_PORT"
    # `exec` so that $! is the bd process itself, not a wrapper subshell.
    (
      cd "$WS_DIR"
      BD_EVENTS_JOURNAL=1 exec nohup "$BD" serve --addr "127.0.0.1:$BD_PORT" >"$BD_LOG" 2>&1 </dev/null
    ) &
    echo $! >"$BD_PID"
    wait_http "$BD_URL/context" 30 || { tail -20 "$BD_LOG" >&2; die "bd serve did not answer on $BD_URL/context"; }
  fi

  print_env | tee "$ENV_FILE"
}

# bd (server mode) forks a detached `bd db-proxy-child --root WS/.beads/dolt` in front of the
# external dolt; it outlives `bd serve` and is reused by later bd processes of that workspace.
# Stop it only when its --root is OUR workspace.
stop_proxy() {
  local pidf="$WS_DIR/.beads/dolt/proxy.pid" pid i
  [[ -f "$pidf" ]] || return 0
  pid="$(sed -n 's/.*"pid": *\([0-9]*\).*/\1/p' "$pidf" | head -1)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null \
     && tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -qF -- "db-proxy-child --root $WS_DIR/.beads/dolt"; then
    log "stopping db-proxy-child (pid $pid)"
    kill -TERM "$pid" 2>/dev/null || true
    for ((i = 0; i < 50; i++)); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
  fi
}

cmd_down() {
  stop_pidfile "$BD_PID" "serve" "bd serve"
  stop_proxy
  stop_pidfile "$DOLT_PID" "dolt" "dolt sql-server"
  if [[ $PURGE -eq 1 ]]; then
    log "purging $DIR"
    rm -rf "$DIR"
  fi
}

cmd_status() {
  local ok=0
  if pid_alive "$DOLT_PID" "dolt"; then echo "dolt:     running pid=$(cat "$DOLT_PID") port=$DOLT_PORT"; else echo "dolt:     stopped"; ok=1; fi
  if pid_alive "$BD_PID" "serve"; then echo "bd serve: running pid=$(cat "$BD_PID") port=$BD_PORT"; else echo "bd serve: stopped"; ok=1; fi
  if [[ -f "$WS_DIR/.beads/dolt/proxy.pid" ]]; then echo "db-proxy: $(sed -n 's/.*"pid": *\([0-9]*\).*"port": *\([0-9]*\).*/pid=\1 port=\2/p' "$WS_DIR/.beads/dolt/proxy.pid")"; fi
  echo "context:  HTTP $(http_code "$BD_URL/context")"
  echo "ready:    HTTP $(http_code "$BD_URL/ready?limit=1")"
  [[ -f "$ENV_FILE" ]] && cat "$ENV_FILE"
  return $ok
}

cmd_seed() {
  [[ -f "$WS_DIR/.beads/metadata.json" ]] || die "workspace not initialised; run 'up' first"
  local bd=("$BD" -C "$WS_DIR" --actor stand-seed)
  local epic c1 c2 t1 t2
  epic="$("${bd[@]}" q --type epic --priority 1 "Seed epic")"
  c1="$("${bd[@]}" q --type task --priority 2 --parent "$epic" "Seed child 1")"
  c2="$("${bd[@]}" q --type task --priority 2 --parent "$epic" "Seed child 2")"
  t1="$("${bd[@]}" q --type task --priority 3 "Seed standalone task")"
  t2="$("${bd[@]}" q --type chore --priority 4 "Seed closed task")"
  "${bd[@]}" dep add "$c2" "$c1" >/dev/null   # c2 is blocked by c1
  "${bd[@]}" close "$t2" --reason "seeded as closed" >/dev/null
  cat <<IDS
SEED_EPIC=$epic
SEED_CHILD1=$c1
SEED_CHILD2=$c2
SEED_TASK=$t1
SEED_CLOSED=$t2
IDS
}

# One issue through the CLI in the stand workspace (the e2e live test uses it while the board is
# open: the mutation reaches bd serve's event journal and must show up on the board without reload).
cmd_create_issue() {
  [[ -f "$WS_DIR/.beads/metadata.json" ]] || die "workspace not initialised; run 'up' first"
  [[ -n "$TITLE" ]] || die "create-issue needs a TITLE"
  "$BD" -C "$WS_DIR" --actor stand-cli q --type "$ISSUE_TYPE" --priority "$PRIORITY" "$TITLE"
}

case "$CMD" in
  up) cmd_up ;;
  down) cmd_down ;;
  seed) cmd_seed ;;
  status) cmd_status ;;
  create-issue) cmd_create_issue ;;
esac
