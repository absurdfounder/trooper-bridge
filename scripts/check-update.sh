#!/bin/bash
# Pull-based update backstop for the openclawbridge VPS fleet.
#
# Phase 6 / Workstream 6 of CRABBOX_FLEET_AUTOMATION_PLAN. Runs hourly via
# systemd timer (openclaw-updater.timer). Catches VPSes the push rollout
# missed (Render outage, network blip, transient bridge failure).
#
# Flow:
#   1. Resolve target from $MISSION_CONTROL_URL/api/current-versions.
#   2. Compare to local /opt/openclaw-bridge HEAD and /opt/openclaw HEAD.
#   3. If drift exists, report it. Local mutation is disabled by default
#      because it bypasses the control plane's verified rollback snapshot.
#      Self-hosted operators can explicitly set
#      TROOPER_UNATTENDED_UPGRADE_MODE=apply for break-glass environments
#      that accept that risk. Managed Trooper servers always remain report-only
#      because their rollback snapshot is owned by the control plane.
#   4. Log every run to /var/log/openclaw-updater.log with timestamps.

set -euo pipefail
LOG=/var/log/openclaw-updater.log
exec >> "$LOG" 2>&1
echo "[$(date -Iseconds)] check-update.sh starting"

# Source legacy bridge env first, then the updater-specific file written by
# setup-openclaw-full.sh. The latter is authoritative for managed deployments.
if [ -f /etc/openclaw-bridge.env ]; then
  set -a
  # shellcheck disable=SC1091
  source /etc/openclaw-bridge.env
  set +a
fi
if [ -f /etc/default/openclaw-updater ]; then
  set -a
  # shellcheck disable=SC1091
  source /etc/default/openclaw-updater
  set +a
fi

if [ -z "${MISSION_CONTROL_URL:-}" ]; then
  echo "  MISSION_CONTROL_URL unset; skipping (likely a snapshot-builder VPS)"
  exit 0
fi

# Best-effort jitter so 50 VPSes don't all wake at :00 sharp.
JITTER=$((RANDOM % 60))
sleep "$JITTER"

TARGET=$(curl -fsSL --max-time 10 "${MISSION_CONTROL_URL%/}/api/current-versions" || echo "")
if [ -z "$TARGET" ]; then
  echo "  /api/current-versions unreachable or returned empty; nothing to do"
  exit 0
fi

TARGET_BRIDGE=$(echo "$TARGET" | jq -r '.openclawBridgeCommit // empty')
TARGET_GATEWAY=$(echo "$TARGET" | jq -r '.gatewayImage // empty')
TARGET_RUNTIME=$(echo "$TARGET" | jq -r '.runtimeTarballUrl // empty')
TARGET_RUNTIME_SHA256=$(echo "$TARGET" | jq -r '.runtimeTarballSha256 // empty')
TARGET_RUNTIME_SCHEMA=$(echo "$TARGET" | jq -r '.runtimeSchemaVersion // 1')
TARGET_RUNTIME_MIN_SOURCE=$(echo "$TARGET" | jq -r '.minimumSourceRuntimeSchemaVersion // 1')
TARGET_RUNTIME_MAX_SOURCE=$(echo "$TARGET" | jq -r '.maximumSourceRuntimeSchemaVersion // (.runtimeSchemaVersion // 1)')

if [ -z "$TARGET_BRIDGE" ] && [ -z "$TARGET_GATEWAY" ] && [ -z "$TARGET_RUNTIME" ]; then
  echo "  no target SHAs in response; nothing to do"
  exit 0
fi

LOCAL_BRIDGE=$(git -C /opt/openclaw-bridge rev-parse HEAD 2>/dev/null || echo "")
LOCAL_GATEWAY_DIGESTS=$(docker inspect openclaw:local --format='{{range .RepoDigests}}{{println .}}{{end}}' 2>/dev/null || echo "")
LOCAL_RUNTIME=$(jq -r '.runtimeTarballUrl // empty' /opt/trooper-org-runtime/.trooper-runtime-target.json 2>/dev/null || echo "")
LOCAL_RUNTIME_SHA256=$(jq -r '.runtimeTarballSha256 // empty' /opt/trooper-org-runtime/.trooper-runtime-target.json 2>/dev/null || echo "")

DRIFT=0
if [ -n "$TARGET_BRIDGE" ] && [ "$LOCAL_BRIDGE" != "$TARGET_BRIDGE" ]; then
  DRIFT=1
  echo "  bridge drift: local=${LOCAL_BRIDGE:0:7} target=${TARGET_BRIDGE:0:7}"
fi
if [ -n "$TARGET_GATEWAY" ] && ! grep -Fxq "$TARGET_GATEWAY" <<<"$LOCAL_GATEWAY_DIGESTS"; then
  echo "  gateway drift: promoted digest is not installed"
  DRIFT=1
fi
if [ -n "$TARGET_RUNTIME" ] && [ "$LOCAL_RUNTIME" != "$TARGET_RUNTIME" ]; then
  echo "  runtime bundle drift: promoted asset is not installed"
  DRIFT=1
fi
if [ -n "$TARGET_RUNTIME_SHA256" ] && [ "$LOCAL_RUNTIME_SHA256" != "$TARGET_RUNTIME_SHA256" ]; then
  echo "  runtime checksum drift: installed bytes do not match the promoted digest"
  DRIFT=1
fi

if [ "$DRIFT" -eq 0 ]; then
  echo "  no drift; nothing to do"
  exit 0
fi

UNATTENDED_MODE="${TROOPER_UNATTENDED_UPGRADE_MODE:-report}"
if [ "${TROOPER_MANAGED_DEPLOYMENT:-0}" = "1" ] && [ "$UNATTENDED_MODE" = "apply" ]; then
  echo "  managed deployment detected; refusing local unattended mutation"
  echo "  await a verified control-plane rollout with a provider rollback snapshot"
  exit 1
fi

if [ "$UNATTENDED_MODE" != "apply" ]; then
  echo "  drift detected; awaiting a verified control-plane rollout"
  echo "  local unattended mutation is disabled (mode=${UNATTENDED_MODE})"
  exit 0
fi

if [ -z "${BRIDGE_AUTH_TOKEN:-}" ]; then
  echo "  drift detected but BRIDGE_AUTH_TOKEN unset; cannot self-upgrade"
  exit 1
fi

echo "  WARNING: applying local unattended upgrade without a control-plane rollback snapshot"
UPGRADE_BODY=$(jq -cn \
  --arg bridge "$TARGET_BRIDGE" \
  --arg gateway "$TARGET_GATEWAY" \
  --arg runtime "$TARGET_RUNTIME" \
  --arg runtimeSha256 "$TARGET_RUNTIME_SHA256" \
  --argjson runtimeSchema "$TARGET_RUNTIME_SCHEMA" \
  --argjson runtimeMinSource "$TARGET_RUNTIME_MIN_SOURCE" \
  --argjson runtimeMaxSource "$TARGET_RUNTIME_MAX_SOURCE" \
  '{
    scope: "all",
    target: {
      openclawBridgeCommit: $bridge,
      gatewayImage: $gateway,
      runtimeTarballUrl: $runtime,
      runtimeTarballSha256: $runtimeSha256,
      runtimeSchemaVersion: $runtimeSchema,
      minimumSourceRuntimeSchemaVersion: $runtimeMinSource,
      maximumSourceRuntimeSchemaVersion: $runtimeMaxSource
    }
  }')
RES=$(curl -fsSL --max-time 300 -X POST \
  -H "Authorization: Bearer ${BRIDGE_AUTH_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d "$UPGRADE_BODY" \
  http://127.0.0.1:3002/upgrade 2>&1 || true)
echo "  /upgrade response: $RES" | head -c 500
echo
if ! jq -e '.success == true' >/dev/null 2>&1 <<<"$RES"; then
  echo "  upgrade request failed"
  exit 1
fi

echo "[$(date -Iseconds)] check-update.sh complete"
