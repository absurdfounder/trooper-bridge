#!/bin/bash
# Simplified startup — Chrome + TigerVNC are pre-installed in the image
GATEWAY_PORT="${1:-18789}"

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

# Belt-and-suspenders: fix permissions for node user
chown -R 1000:1000 /home/node/.openclaw 2>/dev/null || true
chown -R 1000:1000 /home/node/.npm 2>/dev/null || true
chmod 700 /home/node/.openclaw 2>/dev/null || true
chmod 600 /home/node/.openclaw/openclaw.json 2>/dev/null || true
find /home/node/.openclaw/agents -name 'auth-profiles.json' -exec chmod 600 {} \; 2>/dev/null || true

# Startup optimizations (recommended by openclaw doctor)
export NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache
mkdir -p /var/tmp/openclaw-compile-cache 2>/dev/null || true
chown 1000:1000 /var/tmp/openclaw-compile-cache 2>/dev/null || true
export OPENCLAW_NO_RESPAWN=1

# Start gateway as node user
exec su -s /bin/bash node -c "DISPLAY=:99 NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache OPENCLAW_NO_RESPAWN=1 node dist/index.js gateway --allow-unconfigured --bind loopback --port $GATEWAY_PORT"
