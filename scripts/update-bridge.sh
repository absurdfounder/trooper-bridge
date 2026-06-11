#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-activate}"
INSTALL_DIR="${TROOPER_BRIDGE_INSTALL_DIR:-/opt/openclaw-bridge}"
NEXT_DIR="${INSTALL_DIR}.next"
PREVIOUS_DIR="${INSTALL_DIR}.previous"
FAILED_DIR="${INSTALL_DIR}.failed"
TARGET_COMMIT="$(printf '%s' "${TROOPER_BRIDGE_COMMIT:-}" | tr '[:upper:]' '[:lower:]')"
BRIDGE_REPO_URL="${TROOPER_BRIDGE_REPO_URL:-https://github.com/absurdfounder/trooper-bridge.git}"
TROOPER_PROTECT_BRIDGE="${TROOPER_PROTECT_BRIDGE:-1}"

cleanup_next() {
  rm -rf "$NEXT_DIR"
}

copy_mutable_state() {
  local source_dir="$1"
  local target_dir="$2"
  local relative_path

  for relative_path in \
    device-identity.json \
    agent-registry.json \
    paired.json \
    .setup-complete \
    data
  do
    if [ ! -e "$source_dir/$relative_path" ]; then
      continue
    fi
    rm -rf "$target_dir/$relative_path"
    cp -a "$source_dir/$relative_path" "$target_dir/$relative_path"
  done
}

read_bridge_commit() {
  local dir="$1"
  local commit=""
  if [ -d "$dir/.git" ]; then
    commit="$(git -C "$dir" rev-parse HEAD 2>/dev/null || true)"
  fi
  if [ -z "$commit" ] && [ -f "$dir/.trooper-bridge-target.json" ]; then
    commit="$(node -e "try{const fs=require('fs');const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p,'utf8'));process.stdout.write(j.commit||'')}catch{}" "$dir/.trooper-bridge-target.json" 2>/dev/null || true)"
  fi
  printf '%s' "$commit"
}

read_bridge_remote_url() {
  local dir="$1"
  local remote_url=""
  if [ -d "$dir/.git" ]; then
    remote_url="$(git -C "$dir" remote get-url origin 2>/dev/null || true)"
  fi
  if [ -z "$remote_url" ] && [ -f "$dir/.trooper-bridge-target.json" ]; then
    remote_url="$(node -e "try{const fs=require('fs');const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p,'utf8'));process.stdout.write(j.remoteUrl||'')}catch{}" "$dir/.trooper-bridge-target.json" 2>/dev/null || true)"
  fi
  printf '%s' "${remote_url:-$BRIDGE_REPO_URL}"
}

rollback_bridge() {
  if [ ! -d "$PREVIOUS_DIR" ]; then
    echo "ERROR: no previous bridge checkout is available" >&2
    exit 1
  fi

  echo "[update-bridge] Restoring previous bridge checkout..."
  rm -rf "$FAILED_DIR"
  if [ -d "$INSTALL_DIR" ]; then
    copy_mutable_state "$INSTALL_DIR" "$PREVIOUS_DIR"
    mv "$INSTALL_DIR" "$FAILED_DIR"
  fi
  mv "$PREVIOUS_DIR" "$INSTALL_DIR"
  rm -rf "$FAILED_DIR"
  echo "[update-bridge] Previous bridge checkout restored."
}

if [ "$ACTION" = "rollback" ]; then
  rollback_bridge
  exit 0
fi
if [ "$ACTION" != "activate" ]; then
  echo "ERROR: unsupported bridge update action: $ACTION" >&2
  exit 1
fi
if [[ ! "$TARGET_COMMIT" =~ ^[a-f0-9]{40}$ ]]; then
  echo "ERROR: TROOPER_BRIDGE_COMMIT must be a full 40-character commit" >&2
  exit 1
fi
if [ ! -d "$INSTALL_DIR" ]; then
  echo "ERROR: bridge install does not exist: $INSTALL_DIR" >&2
  exit 1
fi

trap cleanup_next EXIT

BEFORE_SHA="$(read_bridge_commit "$INSTALL_DIR")"
REMOTE_URL="$(read_bridge_remote_url "$INSTALL_DIR")"
if [ "$BEFORE_SHA" = "$TARGET_COMMIT" ]; then
  echo "[update-bridge] Bridge already at $TARGET_COMMIT"
  exit 0
fi

echo "[update-bridge] Fetching immutable bridge commit $TARGET_COMMIT..."
rm -rf "$NEXT_DIR"
git init -q "$NEXT_DIR"
git -C "$NEXT_DIR" remote add origin "$REMOTE_URL"
git -C "$NEXT_DIR" fetch -q --depth 1 origin "$TARGET_COMMIT"
git -C "$NEXT_DIR" checkout -q --detach FETCH_HEAD

AFTER_SHA="$(git -C "$NEXT_DIR" rev-parse HEAD)"
if [ "$AFTER_SHA" != "$TARGET_COMMIT" ]; then
  echo "ERROR: staged bridge checkout mismatch: expected $TARGET_COMMIT, got $AFTER_SHA" >&2
  exit 1
fi

test -f "$NEXT_DIR/index.mjs" || {
  echo "ERROR: staged bridge is missing index.mjs" >&2
  exit 1
}
test -f "$NEXT_DIR/package-lock.json" || {
  echo "ERROR: staged bridge is missing package-lock.json" >&2
  exit 1
}
test -f "$NEXT_DIR/scripts/update-org-runtime.sh" || {
  echo "ERROR: staged bridge is missing the runtime updater" >&2
  exit 1
}

echo "[update-bridge] Installing locked production dependencies in staging..."
(cd "$NEXT_DIR" && npm ci --omit=dev)

if [ "$TROOPER_PROTECT_BRIDGE" = "1" ] && [ -x "$NEXT_DIR/scripts/protect-js-tree.sh" ]; then
  echo "[update-bridge] Protecting staged bridge runtime files..."
  TROOPER_PROTECT_CODE=1 TROOPER_PROTECT_STRICT=1 "$NEXT_DIR/scripts/protect-js-tree.sh" "$NEXT_DIR" bridge
fi

# These files predate /opt/openclaw-data and can still be updated by existing
# deployments. Copy them immediately before activation so the staged checkout
# cannot replace device identity or agent metadata with repository contents.
copy_mutable_state "$INSTALL_DIR" "$NEXT_DIR"

echo "[update-bridge] Activating staged bridge..."
rm -rf "$PREVIOUS_DIR"
mv "$INSTALL_DIR" "$PREVIOUS_DIR"
if ! mv "$NEXT_DIR" "$INSTALL_DIR"; then
  mv "$PREVIOUS_DIR" "$INSTALL_DIR"
  echo "ERROR: failed to activate staged bridge; previous checkout restored" >&2
  exit 1
fi

trap - EXIT
echo "[update-bridge] Bridge updated $BEFORE_SHA -> $AFTER_SHA"
