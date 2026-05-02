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
#   3. If drift exists (any field mismatches), POST localhost:3002/upgrade
#      with the Bearer token from /etc/openclaw-bridge.env.
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

if [ -z "$TARGET_BRIDGE" ] && [ -z "$TARGET_GATEWAY" ]; then
  echo "  no target SHAs in response; nothing to do"
  exit 0
fi

LOCAL_BRIDGE=$(git -C /opt/openclaw-bridge rev-parse HEAD 2>/dev/null || echo "")
LOCAL_GATEWAY=$(docker inspect openclaw:local --format='{{.Id}}' 2>/dev/null || echo "")

DRIFT=0
if [ -n "$TARGET_BRIDGE" ] && [ -n "$LOCAL_BRIDGE" ]; then
  case "$LOCAL_BRIDGE" in
    "$TARGET_BRIDGE"*) ;;
    *) DRIFT=1; echo "  bridge drift: local=${LOCAL_BRIDGE:0:7} target=${TARGET_BRIDGE:0:7}";;
  esac
fi
# Gateway image comparison is best-effort; the docker .Id is sha256:... and
# target is a tag like 'ghcr.io/.../crabhq-gateway:latest'. Just check whether
# docker can pull a newer version; this is cheap (no-op when up-to-date).
if [ -n "$TARGET_GATEWAY" ]; then
  PULL_OUT=$(docker pull "$TARGET_GATEWAY" 2>&1 || true)
  if ! echo "$PULL_OUT" | grep -q "Image is up to date"; then
    echo "  gateway image newer than local; flagging drift"
    DRIFT=1
  fi
fi

if [ "$DRIFT" -eq 0 ]; then
  echo "  no drift; nothing to do"
  exit 0
fi

if [ -z "${BRIDGE_AUTH_TOKEN:-}" ]; then
  echo "  drift detected but BRIDGE_AUTH_TOKEN unset; cannot self-upgrade"
  exit 1
fi

echo "  triggering local /upgrade"
RES=$(curl -fsSL --max-time 300 -X POST \
  -H "Authorization: Bearer ${BRIDGE_AUTH_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"scope":"all"}' \
  http://127.0.0.1:3002/upgrade 2>&1 || true)
echo "  /upgrade response: $RES" | head -c 500
echo

echo "[$(date -Iseconds)] check-update.sh complete"
