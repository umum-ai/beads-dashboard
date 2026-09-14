#!/usr/bin/env bash
# Single-file executable: `bun build --compile` of the server with the SPA embedded.
#
#   scripts/build-binary.sh [--target bun-<os>-<arch>] [--outdir dist]
#
# Targets: bun-linux-x64, bun-linux-arm64, bun-darwin-x64, bun-darwin-arm64 (default: the host).
# Cross-compilation downloads the matching bun runtime once (~/.bun/install/cache). Output is
# dist/bddb-<os>-<arch> (Bun's `--compile` names, e.g. dist/bddb-linux-arm64).
#
# The SPA travels inside the binary: Bun compiles the `index.html` import of
# src/server/static.ts into files under /$bunfs/ and exposes them as `HTMLBundle.files`, which
# static.ts serves in files mode (any BDDB_BASE_PATH). The binary needs `bd` in PATH (or
# BDDB_BD_PATH) and `git`; `bddb doctor` reports both.
set -euo pipefail
cd "$(dirname "$0")/.."

target=""
outdir="dist"
while [ $# -gt 0 ]; do
  case "$1" in
    --target) target="$2"; shift 2 ;;
    --target=*) target="${1#--target=}"; shift ;;
    --outdir) outdir="$2"; shift 2 ;;
    --outdir=*) outdir="${1#--outdir=}"; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "build-binary.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

if [ -z "$target" ]; then
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo "build-binary.sh: unsupported host arch $arch; pass --target" >&2; exit 2 ;;
  esac
  target="bun-${os}-${arch}"
fi
case "$target" in
  bun-linux-x64|bun-linux-arm64|bun-darwin-x64|bun-darwin-arm64) ;;
  *) echo "build-binary.sh: unsupported target $target" >&2; exit 2 ;;
esac

outfile="${outdir}/bddb-${target#bun-}"
mkdir -p "$outdir"
rm -f "$outfile"
bun build --compile --production --target="$target" src/server/cli.ts --outfile "$outfile"
ls -la "$outfile"
