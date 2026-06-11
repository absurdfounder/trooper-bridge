#!/usr/bin/env bash
set -euo pipefail

cmd="${1:-}"
src="${2:-}"
out="${3:-}"

if [[ "$cmd" != "build" || -z "$src" || -z "$out" ]]; then
  echo "usage: $0 build <Trooper-server-dir> <out-tarball>" >&2
  exit 1
fi

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

mkdir -p "$stage/trooper-org-runtime/server"

rsync -a --delete \
  --exclude 'node_modules' \
  --exclude '.env' \
  --exclude 'server.log' \
  --exclude '*.test.js' \
  --exclude '*.map' \
  --exclude 'test-data' \
  "$src/" "$stage/trooper-org-runtime/server/"

if [[ "${TROOPER_PROTECT_RUNTIME_BUNDLE:-1}" == "1" ]]; then
  script_dir="$(cd "$(dirname "$0")" && pwd)"
  if [[ ! -x "$script_dir/protect-js-tree.sh" ]]; then
    echo "ERROR: runtime bundle protection script is missing or not executable: $script_dir/protect-js-tree.sh" >&2
    exit 1
  fi
  TROOPER_PROTECT_CODE=1 TROOPER_PROTECT_STRICT=1 "$script_dir/protect-js-tree.sh" \
    "$stage/trooper-org-runtime/server" runtime
fi

COPYFILE_DISABLE=1 tar -C "$stage" -czf "$out" trooper-org-runtime

echo "built runtime bundle: $out"
tar -tzf "$out" | sed -n '1,40p'
