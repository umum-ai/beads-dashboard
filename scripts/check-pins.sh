#!/usr/bin/env bash
# The beads version bddb is built for is pinned in four places; they must agree.
#
#   mise.toml                  "github:gastownhall/beads" = "X"   (toolchain, local + CI)
#   Dockerfile                 ARG BEADS_VERSION=X                (bd inside the image; label org.beads.version)
#   src/server/version.ts      BUILT_FOR_BEADS = "X"              (runtime version warning, doctor)
#   .github/workflows/ci.yml   beads-version: [..., "X", ...]     (contract matrix; X must be listed)
#
# Renovate bumps the first two and the matrix (renovate.json); version.ts is bumped by hand in the
# same PR — this check fails CI until it is. See docs/compatibility.md.
#
#   scripts/check-pins.sh           verify (exit 1 on disagreement)
#   scripts/check-pins.sh --print   print the mise.toml pin only (for build scripts and CI)
set -euo pipefail
cd "$(dirname "$0")/.."

mise_pin="$(sed -n 's/^"github:gastownhall\/beads"[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' mise.toml)"
if [ "${1:-}" = "--print" ]; then
  [ -n "$mise_pin" ] || { echo "check-pins: no beads pin in mise.toml" >&2; exit 1; }
  echo "$mise_pin"
  exit 0
fi
docker_pin="$(sed -n 's/^ARG BEADS_VERSION=\(.*\)$/\1/p' Dockerfile)"
version_pin="$(sed -n 's/^export const BUILT_FOR_BEADS = "\([^"]*\)".*/\1/p' src/server/version.ts)"
matrix="$(sed -n 's/^[[:space:]]*beads-version:[[:space:]]*\[\(.*\)\].*/\1/p' .github/workflows/ci.yml | tr -d '" ' | tr ',' '\n')"

status=0
report() { printf '  %-28s %s\n' "$1" "$2"; }
report "mise.toml" "$mise_pin"
report "Dockerfile ARG" "$docker_pin"
report "version.ts BUILT_FOR_BEADS" "$version_pin"
report "ci.yml matrix" "$(printf '%s' "$matrix" | tr '\n' ' ')"

[ -n "$mise_pin" ] || { echo "check-pins: no beads pin in mise.toml" >&2; status=1; }
[ "$docker_pin" = "$mise_pin" ] || { echo "check-pins: Dockerfile ARG BEADS_VERSION=$docker_pin ≠ mise.toml $mise_pin" >&2; status=1; }
[ "$version_pin" = "$mise_pin" ] || { echo "check-pins: version.ts BUILT_FOR_BEADS=$version_pin ≠ mise.toml $mise_pin" >&2; status=1; }
printf '%s\n' "$matrix" | grep -qx -- "$mise_pin" \
  || { echo "check-pins: ci.yml beads-version matrix does not list $mise_pin" >&2; status=1; }

[ "$status" = 0 ] && echo "check-pins: ok ($mise_pin)"
exit "$status"
