#!/usr/bin/env bash
set -euo pipefail

RELEASE_URL="${TROOPER_RUNTIME_TARBALL_URL:-}"
RELEASE_SHA256="$(printf '%s' "${TROOPER_RUNTIME_TARBALL_SHA256:-}" | tr '[:upper:]' '[:lower:]')"
INSTALL_DIR="${TROOPER_RUNTIME_INSTALL_DIR:-/opt/trooper-org-runtime}"
NEXT_DIR="${INSTALL_DIR}.next"
PREVIOUS_DIR="${INSTALL_DIR}.previous"
TMP_TARBALL="$(mktemp /tmp/trooper-org-runtime-update.XXXXXX.tar.gz)"
SKIP_RESTART="${TROOPER_RUNTIME_SKIP_RESTART:-0}"

cleanup() {
  rm -f "$TMP_TARBALL"
  rm -rf "$NEXT_DIR"
}
trap cleanup EXIT

if [ -z "$RELEASE_URL" ]; then
  echo "ERROR: TROOPER_RUNTIME_TARBALL_URL is required" >&2
  exit 1
fi
if [[ ! "$RELEASE_SHA256" =~ ^[a-f0-9]{64}$ ]]; then
  echo "ERROR: TROOPER_RUNTIME_TARBALL_SHA256 must be a full sha256 digest" >&2
  exit 1
fi
if [[ "$RELEASE_URL" == *"/org-runtime-latest/"* ]]; then
  echo "ERROR: mutable org-runtime-latest bundles are not allowed" >&2
  exit 1
fi
if [[ ! "$RELEASE_URL" =~ ^https://api\.github\.com/repos/[^/]+/[^/]+/releases/assets/[0-9]+$ ]] \
  && [[ ! "$RELEASE_URL" =~ /releases/download/org-runtime-[a-fA-F0-9]{40}(-[a-fA-F0-9]{40})?/trooper-org-runtime\.tar\.gz([?#].*)?$ ]]; then
  echo "ERROR: runtime bundle URL is not an immutable promoted release asset" >&2
  exit 1
fi

echo "[update-org-runtime] Downloading immutable runtime bundle..."
if [[ "$RELEASE_URL" == https://api.github.com/repos/*/releases/assets/* ]]; then
  curl -fsSL -H "Accept: application/octet-stream" "$RELEASE_URL" -o "$TMP_TARBALL"
else
  curl -fsSL "$RELEASE_URL" -o "$TMP_TARBALL"
fi

ACTUAL_SHA256="$(sha256sum "$TMP_TARBALL" | awk '{print $1}')"
if [ "$ACTUAL_SHA256" != "$RELEASE_SHA256" ]; then
  echo "ERROR: runtime bundle checksum mismatch: expected $RELEASE_SHA256, got $ACTUAL_SHA256" >&2
  exit 1
fi
echo "[update-org-runtime] Runtime checksum verified: $ACTUAL_SHA256"

rm -rf "$NEXT_DIR"
mkdir -p "$NEXT_DIR"
echo "[update-org-runtime] Extracting staged runtime..."
tar -xzf "$TMP_TARBALL" -C "$NEXT_DIR" --strip-components=1

test -f "$NEXT_DIR/server/package.json" || {
  echo "ERROR: staged runtime is missing server/package.json" >&2
  exit 1
}
test -f "$NEXT_DIR/server/package-lock.json" || {
  echo "ERROR: staged runtime is missing server/package-lock.json" >&2
  exit 1
}
test -f "$NEXT_DIR/server/org-runtime/index.js" || {
  echo "ERROR: staged runtime is missing server/org-runtime/index.js" >&2
  exit 1
}
test -f "$NEXT_DIR/server/org-runtime/runtime-manifest.json" || {
  echo "ERROR: staged runtime is missing its compatibility manifest" >&2
  exit 1
}

node - \
  "$NEXT_DIR/server/org-runtime/runtime-manifest.json" \
  "$INSTALL_DIR/.trooper-runtime-target.json" \
  "$NEXT_DIR/.trooper-runtime-target.json" \
  "$RELEASE_URL" \
  "$RELEASE_SHA256" <<'NODE'
const fs = require('fs');
const [
  manifestPath,
  currentTargetPath,
  nextTargetPath,
  releaseUrl,
  runtimeTarballSha256,
] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const positiveInteger = (value, name) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
};
const runtimeSchemaVersion = positiveInteger(
  manifest.runtimeSchemaVersion,
  'runtimeSchemaVersion',
);
const minimumSourceRuntimeSchemaVersion = positiveInteger(
  manifest.minimumSourceRuntimeSchemaVersion,
  'minimumSourceRuntimeSchemaVersion',
);
const maximumSourceRuntimeSchemaVersion = positiveInteger(
  manifest.maximumSourceRuntimeSchemaVersion,
  'maximumSourceRuntimeSchemaVersion',
);
if (minimumSourceRuntimeSchemaVersion > maximumSourceRuntimeSchemaVersion) {
  throw new Error('runtime source schema compatibility range is invalid');
}
let currentRuntimeSchemaVersion = 1;
try {
  const current = JSON.parse(fs.readFileSync(currentTargetPath, 'utf8'));
  const parsed = Number(current.runtimeSchemaVersion);
  if (Number.isInteger(parsed) && parsed > 0) currentRuntimeSchemaVersion = parsed;
} catch {}
if (
  currentRuntimeSchemaVersion < minimumSourceRuntimeSchemaVersion
  || currentRuntimeSchemaVersion > maximumSourceRuntimeSchemaVersion
) {
  throw new Error(
    `runtime schema ${runtimeSchemaVersion} cannot safely upgrade installed schema `
    + `${currentRuntimeSchemaVersion}; supported source schemas are `
    + `${minimumSourceRuntimeSchemaVersion}-${maximumSourceRuntimeSchemaVersion}`,
  );
}
fs.writeFileSync(nextTargetPath, `${JSON.stringify({
  runtimeTarballUrl: releaseUrl,
  runtimeTarballSha256,
  runtimeSchemaVersion,
})}\n`, { mode: 0o600 });
NODE

echo "[update-org-runtime] Installing locked production dependencies..."
(cd "$NEXT_DIR/server" && npm ci --omit=dev)

echo "[update-org-runtime] Activating staged runtime..."
rm -rf "$PREVIOUS_DIR"
if [ -d "$INSTALL_DIR" ]; then
  mv "$INSTALL_DIR" "$PREVIOUS_DIR"
fi
mv "$NEXT_DIR" "$INSTALL_DIR"

if [ "$SKIP_RESTART" = "1" ]; then
  echo "[update-org-runtime] Runtime staged; service restart deferred."
  exit 0
fi

restore_previous() {
  echo "[update-org-runtime] New runtime failed health checks; restoring previous runtime..." >&2
  systemctl stop trooper-server trooper-org-runtime 2>/dev/null || true
  rm -rf "$INSTALL_DIR"
  if [ -d "$PREVIOUS_DIR" ]; then
    mv "$PREVIOUS_DIR" "$INSTALL_DIR"
  fi
  systemctl restart trooper-org-runtime trooper-server 2>/dev/null || true
}

systemctl restart trooper-org-runtime
systemctl restart trooper-server

healthy=0
for _attempt in $(seq 1 30); do
  runtime_ok=0
  server_ok=0
  curl -fsS --max-time 3 http://127.0.0.1:3101/health >/dev/null 2>&1 && runtime_ok=1
  curl -fsS --max-time 3 http://127.0.0.1:3001/health >/dev/null 2>&1 && server_ok=1
  if [ "$runtime_ok" = "1" ] && [ "$server_ok" = "1" ]; then
    healthy=1
    break
  fi
  sleep 2
done

if [ "$healthy" != "1" ]; then
  restore_previous
  exit 1
fi

rm -rf "$PREVIOUS_DIR"
echo "[update-org-runtime] Runtime updated and verified."
