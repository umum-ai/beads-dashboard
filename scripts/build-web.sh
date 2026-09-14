#!/usr/bin/env bash
# Production build of the SPA into dist/web (or $1).
#
# Asset URLs are emitted relative (`./index-<hash>.js`), so the same output serves under any
# BDDB_BASE_PATH: the server injects `<base href="<prefix>/">` at runtime (src/server/static.ts).
# Point `BDDB_WEB_DIR` at the output to serve it from disk.
set -euo pipefail
cd "$(dirname "$0")/.."

out="${1:-dist/web}"
rm -rf "$out"
bun build src/web/index.html --outdir "$out" --production --public-path ./
test -f "$out/index.html"
