#!/usr/bin/env bash
# Production bundle of the server into dist/server (or $1): `bun dist/server/cli.js serve`.
#
# Self-contained: no node_modules or src/ at runtime. The SPA is bundled alongside (the
# `index.html` import in src/server/static.ts becomes a manifest of files next to cli.js) and is
# served in files mode under any BDDB_BASE_PATH. package.json is inlined at build time, so
# `bddb version` keeps working without the file.
set -euo pipefail
cd "$(dirname "$0")/.."

out="${1:-dist/server}"
rm -rf "$out"
bun build --target=bun --production src/server/cli.ts --outdir "$out"
test -f "$out/cli.js"
