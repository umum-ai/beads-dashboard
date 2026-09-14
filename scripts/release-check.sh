#!/usr/bin/env bash
# A release is a pushed git tag `vX.Y.Z[-pre]`; the tag must equal the version in package.json
# (the binary and the image print that version, `bddb version`). Run before tagging and by
# release.yml (`verify` job) on the tag itself.
#
#   scripts/release-check.sh v0.1.0          exit 0 when package.json says "0.1.0"
#   scripts/release-check.sh --print v0.1.0  print the version without the `v` (for scripts)
#
# Exit codes: 0 ok, 1 mismatch, 2 usage / malformed tag.
set -euo pipefail
cd "$(dirname "$0")/.."

print=0
tag=""
while [ $# -gt 0 ]; do
  case "$1" in
    --print) print=1; shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    -*) echo "release-check: unknown option $1" >&2; exit 2 ;;
    *) tag="$1"; shift ;;
  esac
done
[ -n "$tag" ] || { echo "release-check: usage: scripts/release-check.sh [--print] vX.Y.Z" >&2; exit 2; }

# SemVer 2.0.0 with a leading `v`: MAJOR.MINOR.PATCH, optional -prerelease and +build.
semver='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'
if ! [[ "$tag" =~ $semver ]]; then
  echo "release-check: tag '$tag' is not vMAJOR.MINOR.PATCH[-pre][+build]" >&2
  exit 2
fi
version="${tag#v}"

pkg_version="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -n1)"
[ -n "$pkg_version" ] || { echo "release-check: no \"version\" in package.json" >&2; exit 1; }

if [ "$pkg_version" != "$version" ]; then
  cat >&2 <<MSG
release-check: tag $tag does not match package.json version $pkg_version
  Fix: commit 'chore(release): $version' that sets "version": "$version" in package.json,
  push it, then create the tag on that commit — or tag v$pkg_version instead.
MSG
  exit 1
fi

if [ "$print" = 1 ]; then
  echo "$version"
else
  echo "release-check: ok ($tag == package.json $version)"
fi
