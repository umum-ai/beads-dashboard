#!/usr/bin/env bash
# gen-api.sh — generate src/api-client/generated/openapi.d.ts from spec/openapi.v0.yaml
# with openapi-typescript, then format it with biome so `biome check .` stays green.
#
# Usage:
#   scripts/gen-api.sh          # regenerate in place
#   scripts/gen-api.sh --check  # regenerate into a temp file and diff (exit 1 when stale)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPEC="$REPO_ROOT/spec/openapi.v0.yaml"
OUT="$REPO_ROOT/src/api-client/generated/openapi.d.ts"

generate() { # generate TARGET
  bunx openapi-typescript "$SPEC" -o "$1" >/dev/null
  # Format with the repository's biome config; the target must live inside the repo so the
  # config (and its `files.includes`) applies.
  bunx biome format --write "$1" >/dev/null
}

case "${1:-}" in
  "")
    mkdir -p "$(dirname "$OUT")"
    generate "$OUT"
    echo "gen-api: wrote ${OUT#"$REPO_ROOT"/}"
    ;;
  --check)
    tmp="$(dirname "$OUT")/.openapi.check.d.ts"
    trap 'rm -f "$tmp"' EXIT
    generate "$tmp"
    if diff -u "$OUT" "$tmp" >"${tmp}.diff"; then
      echo "gen-api: ${OUT#"$REPO_ROOT"/} is up to date"
      rm -f "${tmp}.diff"
    else
      head -40 "${tmp}.diff" >&2
      rm -f "${tmp}.diff"
      echo "gen-api: ${OUT#"$REPO_ROOT"/} is stale; run 'mise run gen:api'" >&2
      exit 1
    fi
    ;;
  *)
    echo "usage: scripts/gen-api.sh [--check]" >&2
    exit 2
    ;;
esac
