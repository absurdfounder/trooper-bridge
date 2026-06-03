#!/bin/bash
# Simplified startup — Chrome + TigerVNC are pre-installed in the image
GATEWAY_PORT="${1:-18789}"
GATEWAY_PORT="$(printf '%s' "$GATEWAY_PORT" | tr -cd '0-9')"
if [ -z "$GATEWAY_PORT" ] || [ "$GATEWAY_PORT" -lt 1 ] || [ "$GATEWAY_PORT" -gt 65535 ]; then
  echo "[startup] Invalid gateway port '${1:-}', falling back to 18789"
  GATEWAY_PORT=18789
fi

# Start Xvnc on :99 for live browser view
if command -v Xvnc &>/dev/null; then
  if ! pgrep -f "Xvnc :99" >/dev/null 2>&1 && [ -f /tmp/.X99-lock ]; then
    echo "[startup] Removing stale /tmp/.X99-lock"
    rm -f /tmp/.X99-lock || true
  fi
  if ! pgrep -f "Xvnc :99" >/dev/null 2>&1; then
    echo "[startup] Starting Xvnc on :99 (port 5999)..."
    Xvnc :99 -geometry 1920x1080 -depth 24 -rfbport 5999 -localhost \
      -SecurityTypes None -AlwaysShared -AcceptKeyEvents -AcceptPointerEvents >/tmp/xvnc.log 2>&1 &
    sleep 1
  fi
  if DISPLAY=:99 xdpyinfo >/dev/null 2>&1; then
    echo "[startup] Xvnc ready on :99"
  else
    echo "[startup] WARNING: Xvnc failed to become ready on :99"
  fi
fi

# Belt-and-suspenders: keep runtime permissions aligned with entrypoint.sh.
# The bridge-side helpers may run under a different UID than the in-container
# node user, so config/device paths must stay traversable and group/world
# readable instead of being re-hardened back to 600/700 here.
chown -R 1000:1000 /home/node/.openclaw 2>/dev/null || true
chown -R 1000:1000 /home/node/.npm 2>/dev/null || true
find /home/node/.openclaw -type d -exec chmod 755 {} \; 2>/dev/null || true
find /home/node/.openclaw -name '*.json' -exec chmod 664 {} \; 2>/dev/null || true
chmod 777 /home/node/.openclaw/devices 2>/dev/null || true
chmod 666 /home/node/.openclaw/devices/*.json 2>/dev/null || true
chmod 755 /home/node/.openclaw/identity 2>/dev/null || true
chmod 644 /home/node/.openclaw/identity/*.json 2>/dev/null || true

# Startup optimizations (recommended by openclaw doctor)
export NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache
export JITI_CACHE_DIR=/var/tmp/jiti
export OPENCLAW_TMPDIR=/home/node/.cache/openclaw/tmp
export OPENCLAW_NATIVE_HOOK_RELAY_DIR=/home/node/.cache/openclaw/native-hook-relays
export TMPDIR="$OPENCLAW_TMPDIR"
export TMP="$OPENCLAW_TMPDIR"
export TEMP="$OPENCLAW_TMPDIR"
mkdir -p /var/tmp/openclaw-compile-cache /var/tmp/jiti "$OPENCLAW_TMPDIR" "$OPENCLAW_NATIVE_HOOK_RELAY_DIR" 2>/dev/null || true
chown -R 1000:1000 /var/tmp/openclaw-compile-cache /var/tmp/jiti /home/node/.cache/openclaw 2>/dev/null || true
chmod 755 /var/tmp/openclaw-compile-cache /var/tmp/jiti "$OPENCLAW_TMPDIR" "$OPENCLAW_NATIVE_HOOK_RELAY_DIR" 2>/dev/null || true
export OPENCLAW_NO_RESPAWN=1

# Auto-repair config after upgrades (prevents crash loops from schema changes).
# Newer OpenClaw releases advertise `doctor --repair`; older builds used `--fix`.
echo "[startup] Running openclaw doctor repair (auto-heal config)..."
run_as_node() {
  if [ "$(id -u)" = "0" ]; then
    su -s /bin/bash node -c "$1"
  else
    bash -lc "$1"
  fi
}
run_as_node "node dist/index.js doctor --repair" 2>&1 \
  || run_as_node "node dist/index.js doctor --fix" 2>&1 \
  || echo "[startup] WARNING: doctor repair failed (non-fatal)"

# Start gateway as node user
if [ "$(id -u)" = "0" ]; then
  exec su -s /bin/bash node -c "DISPLAY=:99 NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache JITI_CACHE_DIR=/var/tmp/jiti TMPDIR=/home/node/.cache/openclaw/tmp TMP=/home/node/.cache/openclaw/tmp TEMP=/home/node/.cache/openclaw/tmp OPENCLAW_TMPDIR=/home/node/.cache/openclaw/tmp OPENCLAW_NATIVE_HOOK_RELAY_DIR=/home/node/.cache/openclaw/native-hook-relays OPENCLAW_NO_RESPAWN=1 node dist/index.js gateway --allow-unconfigured --bind lan --port '$GATEWAY_PORT'"
else
  exec bash -lc "DISPLAY=:99 NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache JITI_CACHE_DIR=/var/tmp/jiti TMPDIR=/home/node/.cache/openclaw/tmp TMP=/home/node/.cache/openclaw/tmp TEMP=/home/node/.cache/openclaw/tmp OPENCLAW_TMPDIR=/home/node/.cache/openclaw/tmp OPENCLAW_NATIVE_HOOK_RELAY_DIR=/home/node/.cache/openclaw/native-hook-relays OPENCLAW_NO_RESPAWN=1 node dist/index.js gateway --allow-unconfigured --bind lan --port '$GATEWAY_PORT'"
fi
