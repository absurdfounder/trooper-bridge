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

repair_openclaw_permissions() {
  # Belt-and-suspenders: keep runtime permissions aligned with entrypoint.sh.
  # Restore can rewrite config/sessions after container start, so this function
  # is run now and repeatedly in the background during the cutover window.
  chown -R 1000:1000 /home/node/.openclaw 2>/dev/null || true
  chown -R 1000:1000 /home/node/.npm 2>/dev/null || true
  find /home/node/.openclaw -type d -exec chmod 777 {} \; 2>/dev/null || true
  find /home/node/.openclaw -type f -exec chmod a+rw {} \; 2>/dev/null || true
  chmod 666 /home/node/.openclaw/openclaw.json /home/node/.openclaw/auth-profiles.json /home/node/.openclaw/agents/main/agent/auth-profiles.json 2>/dev/null || true
  chmod 777 /home/node/.openclaw/devices /home/node/.openclaw/cron /home/node/.openclaw/cron/runs 2>/dev/null || true
  chmod 666 /home/node/.openclaw/devices/*.json /home/node/.openclaw/cron/*.json 2>/dev/null || true
  chmod 755 /home/node/.openclaw/identity 2>/dev/null || true
  chmod 644 /home/node/.openclaw/identity/*.json 2>/dev/null || true
  mkdir -p /var/lib/openclaw/plugin-runtime-deps 2>/dev/null || true
  chown -R 1000:1000 /var/lib/openclaw 2>/dev/null || true
  chmod -R 777 /var/lib/openclaw/plugin-runtime-deps 2>/dev/null || true
}

repair_openclaw_permissions
(for i in $(seq 1 90); do sleep 4; repair_openclaw_permissions; done) &

# Startup optimizations (recommended by openclaw doctor)
export NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache
mkdir -p /var/tmp/openclaw-compile-cache 2>/dev/null || true
chown 1000:1000 /var/tmp/openclaw-compile-cache 2>/dev/null || true
export OPENCLAW_NO_RESPAWN=1

# Auto-repair config after upgrades (prevents crash loops from schema changes).
# Newer OpenClaw releases advertise `doctor --repair`; older builds used `--fix`.
echo "[startup] Running openclaw doctor repair (auto-heal config)..."
su -s /bin/bash node -c "node dist/index.js doctor --repair" 2>&1 \
  || su -s /bin/bash node -c "node dist/index.js doctor --fix" 2>&1 \
  || echo "[startup] WARNING: doctor repair failed (non-fatal)"

# Start gateway as node user
exec su -s /bin/bash node -c "DISPLAY=:99 NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache OPENCLAW_NO_RESPAWN=1 node dist/index.js gateway --allow-unconfigured --bind loopback --port $GATEWAY_PORT"
