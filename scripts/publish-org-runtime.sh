#!/usr/bin/env bash
set -euo pipefail

cmd="${1:-}"
src="${2:-}"
out="${3:-}"

if [[ "$cmd" != "build" || -z "$src" || -z "$out" ]]; then
  echo "usage: $0 build <crabshq-server-dir> <out-tarball>" >&2
  exit 1
fi

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

mkdir -p "$stage/crabhq-org-runtime/server"

rsync -a --delete \
  --exclude 'node_modules' \
  --exclude '.env' \
  --exclude 'server.log' \
  --exclude '*.test.js' \
  --exclude 'test-data' \
  "$src/" "$stage/crabhq-org-runtime/server/"

COPYFILE_DISABLE=1 tar -C "$stage" -czf "$out" crabhq-org-runtime

echo "built runtime bundle: $out"
tar -tzf "$out" | sed -n '1,40p'
