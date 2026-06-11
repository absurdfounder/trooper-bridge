#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:?usage: protect-js-tree.sh <root-dir> [bridge|runtime]}"
PROFILE="${2:-runtime}"
OBFUSCATOR_VERSION="${TROOPER_JS_OBFUSCATOR_VERSION:-4.1.1}"
STRICT="${TROOPER_PROTECT_STRICT:-1}"
SEED="${TROOPER_PROTECT_SEED:-90421}"

if [ "${TROOPER_PROTECT_CODE:-1}" = "0" ]; then
  echo "[protect-js-tree] disabled by TROOPER_PROTECT_CODE=0"
  exit 0
fi
if [ ! -d "$ROOT_DIR" ]; then
  echo "[protect-js-tree] root does not exist: $ROOT_DIR" >&2
  exit 1
fi

fail_or_warn() {
  local message="$1"
  if [ "$STRICT" = "1" ]; then
    echo "ERROR: $message" >&2
    exit 1
  fi
  echo "WARNING: $message" >&2
}

echo "[protect-js-tree] pruning non-runtime files in $ROOT_DIR ($PROFILE)"
find "$ROOT_DIR" -type f \( \
  -name '*.test.js' -o \
  -name '*.test.mjs' -o \
  -name '*.test.cjs' -o \
  -name '*.spec.js' -o \
  -name '*.spec.mjs' -o \
  -name '*.map' -o \
  -name '.DS_Store' -o \
  -name '*.log' \
\) -delete 2>/dev/null || true

case "$PROFILE" in
  bridge)
    rm -rf \
      "$ROOT_DIR/.github" \
      "$ROOT_DIR/docs" \
      "$ROOT_DIR/patches" \
      "$ROOT_DIR/README.md" \
      "$ROOT_DIR/SELF-HOSTED-DEPLOYMENT-PLAN.md" \
      "$ROOT_DIR/.env.example" \
      2>/dev/null || true
    ;;
  runtime)
    rm -rf \
      "$ROOT_DIR/.github" \
      "$ROOT_DIR/test-data" \
      2>/dev/null || true
    ;;
  *)
    echo "ERROR: unknown protection profile: $PROFILE" >&2
    exit 1
    ;;
esac

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

COMMON_FLAGS=(
  --target node
  --compact true
  --ignore-imports true
  --rename-globals false
  --rename-properties false
  --self-defending false
  --debug-protection false
  --disable-console-output false
  --control-flow-flattening false
  --dead-code-injection false
  --string-array true
  --string-array-threshold 0.65
  --string-array-encoding base64
  --simplify true
  --source-map false
  --seed "$SEED"
  --log false
)

JS_FILES=()
while IFS= read -r -d '' file; do
  JS_FILES+=("$file")
done < <(find "$ROOT_DIR" -type f -name '*.js' \
  ! -path '*/node_modules/*' \
  ! -path '*/.git/*' \
  -print0)

if [ "${#JS_FILES[@]}" -gt 0 ]; then
  JS_IN="$TMP_DIR/js-in"
  JS_OUT="$TMP_DIR/js-out"
  mkdir -p "$JS_IN" "$JS_OUT"
  for file in "${JS_FILES[@]}"; do
    rel="${file#$ROOT_DIR/}"
    mkdir -p "$JS_IN/$(dirname "$rel")"
    cp "$file" "$JS_IN/$rel"
  done

  echo "[protect-js-tree] obfuscating ${#JS_FILES[@]} .js files"
  if npx --yes "javascript-obfuscator@${OBFUSCATOR_VERSION}" "$JS_IN" --output "$JS_OUT" "${COMMON_FLAGS[@]}"; then
    if command -v rsync >/dev/null 2>&1; then
      rsync -a "$JS_OUT/" "$ROOT_DIR/"
    else
      (cd "$JS_OUT" && tar -cf - .) | (cd "$ROOT_DIR" && tar -xf -)
    fi
  else
    fail_or_warn "javascript-obfuscator failed for .js files"
  fi
fi

MODULE_FILES=()
while IFS= read -r -d '' file; do
  MODULE_FILES+=("$file")
done < <(find "$ROOT_DIR" -type f \( -name '*.mjs' -o -name '*.cjs' \) \
  ! -path '*/node_modules/*' \
  ! -path '*/.git/*' \
  -print0)

if [ "${#MODULE_FILES[@]}" -gt 0 ]; then
  echo "[protect-js-tree] obfuscating ${#MODULE_FILES[@]} .mjs/.cjs files"
fi
if [ "${#MODULE_FILES[@]}" -gt 0 ]; then
  MODULE_IN="$TMP_DIR/module-in"
  MODULE_OUT="$TMP_DIR/module-out"
  mkdir -p "$MODULE_IN" "$MODULE_OUT"
  for file in "${MODULE_FILES[@]}"; do
    rel="${file#$ROOT_DIR/}"
    mkdir -p "$MODULE_IN/$(dirname "$rel")"
    cp "$file" "$MODULE_IN/$rel.js"
  done
  if npx --yes "javascript-obfuscator@${OBFUSCATOR_VERSION}" "$MODULE_IN" --output "$MODULE_OUT" "${COMMON_FLAGS[@]}"; then
    for file in "${MODULE_FILES[@]}"; do
      rel="${file#$ROOT_DIR/}"
      mv "$MODULE_OUT/$rel.js" "$file"
    done
  else
    fail_or_warn "javascript-obfuscator failed for .mjs/.cjs files"
  fi
fi

case "$PROFILE" in
  bridge)
    COMMIT=""
    REMOTE_URL="${TROOPER_BRIDGE_REPO_URL:-https://github.com/absurdfounder/trooper-bridge.git}"
    if [ -d "$ROOT_DIR/.git" ]; then
      COMMIT="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || true)"
      REMOTE_URL="$(git -C "$ROOT_DIR" remote get-url origin 2>/dev/null || printf '%s' "$REMOTE_URL")"
    fi
    node - "$ROOT_DIR/.trooper-bridge-target.json" "$COMMIT" "$REMOTE_URL" <<'NODE'
const fs = require('fs');
const [targetPath, commit, remoteUrl] = process.argv.slice(2);
const protectedAt = process.env.TROOPER_PROTECTED_AT
  || (process.env.SOURCE_DATE_EPOCH ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString() : '1970-01-01T00:00:00.000Z');
fs.writeFileSync(targetPath, `${JSON.stringify({
  commit: commit || null,
  remoteUrl: remoteUrl || null,
  protected: true,
  protectedAt,
}, null, 2)}\n`, { mode: 0o600 });
NODE
    rm -rf "$ROOT_DIR/.git"
    ;;
  runtime)
    node - "$ROOT_DIR/.trooper-runtime-protection.json" <<'NODE'
const fs = require('fs');
const [targetPath] = process.argv.slice(2);
const protectedAt = process.env.TROOPER_PROTECTED_AT
  || (process.env.SOURCE_DATE_EPOCH ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString() : '1970-01-01T00:00:00.000Z');
fs.writeFileSync(targetPath, `${JSON.stringify({
  protected: true,
  protectedAt,
}, null, 2)}\n`, { mode: 0o600 });
NODE
    ;;
esac

echo "[protect-js-tree] protected $ROOT_DIR"
