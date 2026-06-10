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
#      Operators can explicitly set TROOPER_UNATTENDED_UPGRADE_MODE=apply
#      for break-glass environments that accept that risk.
#   4. Log every run to /var/log/openclaw-updater.log with timestamps.

set -euo pipefail
LOG=/var/log/openclaw-updater.log
exec >> "$LOG" 2>&1
echo "[$(date -Iseconds)] check-update.sh starting"

# Source bridge env for MISSION_CONTROL_URL + BRIDGE_AUTH_TOKEN.
if [ -f /etc/openclaw-bridge.env ]; then
  set -a
  # shellcheck disable=SC1091
  source /etc/openclaw-bridge.env
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

if [ -z "$TARGET_BRIDGE" ] && [ -z "$TARGET_GATEWAY" ] && [ -z "$TARGET_RUNTIME" ]; then
  echo "  no target SHAs in response; nothing to do"
  exit 0
fi

LOCAL_BRIDGE=$(git -C /opt/openclaw-bridge rev-parse HEAD 2>/dev/null || echo "")
LOCAL_GATEWAY_DIGESTS=$(docker inspect openclaw:local --format='{{range .RepoDigests}}{{println .}}{{end}}' 2>/dev/null || echo "")
LOCAL_RUNTIME=$(jq -r '.runtimeTarballUrl // empty' /opt/trooper-org-runtime/.trooper-runtime-target.json 2>/dev/null || echo "")

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

if [ "$DRIFT" -eq 0 ]; then
  echo "  no drift; nothing to do"
  exit 0
fi

UNATTENDED_MODE="${TROOPER_UNATTENDED_UPGRADE_MODE:-report}"
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
  '{
    scope: "all",
    target: {
      openclawBridgeCommit: $bridge,
      gatewayImage: $gateway,
      runtimeTarballUrl: $runtime
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
