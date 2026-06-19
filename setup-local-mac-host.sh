#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer is for macOS only." >&2
  exit 1
fi

need_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required environment variable: $name" >&2
    exit 1
  fi
}

need_env ORG_ID
need_env API_URL
need_env GATEWAY_TOKEN
need_env BRIDGE_AUTH_TOKEN

TROOPER_HOME="${TROOPER_HOME:-$HOME/Library/Application Support/Trooper/runtime}"
BRIDGE_DIR="${BRIDGE_DIR:-$TROOPER_HOME/bridge}"
OPENCLAW_DATA_DIR="${OPENCLAW_DATA_DIR:-$TROOPER_HOME/openclaw-data}"
LOG_DIR="$TROOPER_HOME/logs"
BIN_DIR="$TROOPER_HOME/bin"
PLIST_DIR="$HOME/Library/LaunchAgents"
ENV_FILE="$TROOPER_HOME/trooper-local-host.env"
TROOPER_PARENT_DIR="$(dirname "$TROOPER_HOME")"

HOST_DEVICE_ID="${HOST_DEVICE_ID:-mac-$(scutil --get LocalHostName 2>/dev/null || hostname | tr -cd '[:alnum:]-' | tr '[:upper:]' '[:lower:]')}"
BRIDGE_PORT="${BRIDGE_PORT:-3002}"
GATEWAY_PORT="${GATEWAY_PORT:-18789}"
BROWSER_MODE="${BROWSER_MODE:-managed}"
TUNNEL_PROVIDER="${TUNNEL_PROVIDER:-cloudflare}"
TROOPER_BRIDGE_REPO_URL="${TROOPER_BRIDGE_REPO_URL:-https://github.com/absurdfounder/trooper-bridge.git}"
OPENCLAW_DOCKER_IMAGE="${OPENCLAW_DOCKER_IMAGE:-ghcr.io/absurdfounder/openclaw:latest}"

export PATH="/opt/homebrew/bin:/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin:$HOME/Applications/Docker.app/Contents/Resources/bin:/usr/bin:/bin:/usr/sbin:/sbin"

if [[ "$EUID" -eq 0 ]]; then
  echo "Run this installer as your signed-in macOS user, not with sudo." >&2
  exit 1
fi

# Repair files left by older installers that incorrectly ran the whole setup as root.
ROOT_OWNED_PATHS=()
for path in "$TROOPER_PARENT_DIR" "$TROOPER_HOME" "$PLIST_DIR"/so.trooper.local-*.plist; do
  if [[ -e "$path" && ! -O "$path" ]]; then
    ROOT_OWNED_PATHS+=("$path")
  fi
done
if (( ${#ROOT_OWNED_PATHS[@]} > 0 )); then
  echo "Repairing ownership from an earlier Trooper local-host installation..."
  sudo chown -R "$(id -u):$(id -g)" "${ROOT_OWNED_PATHS[@]}"
fi

mkdir -p "$TROOPER_HOME" "$BRIDGE_DIR" "$OPENCLAW_DATA_DIR" "$LOG_DIR" "$BIN_DIR" "$PLIST_DIR"

if ! command -v git >/dev/null 2>&1; then
  echo "git is required. Install Xcode Command Line Tools, then rerun this installer." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required. Install Node.js 20+ or run: brew install node" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required. Install Node.js 20+ or run: brew install node" >&2
  exit 1
fi

docker_ready() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

install_colima_docker_runtime() {
  if [[ "${TROOPER_SKIP_DOCKER_INSTALL:-0}" == "1" ]]; then
    return 1
  fi

  if ! command -v brew >/dev/null 2>&1; then
    return 1
  fi

  echo "Installing Docker CLI runtime with Colima..."
  brew install colima docker docker-compose docker-buildx

  local brew_prefix
  brew_prefix="$(brew --prefix)"
  mkdir -p "$HOME/.docker/cli-plugins"
  if [[ -x "$brew_prefix/opt/docker-compose/bin/docker-compose" ]]; then
    ln -sfn "$brew_prefix/opt/docker-compose/bin/docker-compose" "$HOME/.docker/cli-plugins/docker-compose"
  fi
  if [[ -x "$brew_prefix/opt/docker-buildx/bin/docker-buildx" ]]; then
    ln -sfn "$brew_prefix/opt/docker-buildx/bin/docker-buildx" "$HOME/.docker/cli-plugins/docker-buildx"
  fi
  hash -r

  echo "Starting Colima..."
  colima start
}

start_docker_desktop() {
  if [[ "${TROOPER_SKIP_DOCKER_DESKTOP:-0}" == "1" ]]; then
    return 1
  fi

  if [[ ! -d "/Applications/Docker.app" && ! -d "$HOME/Applications/Docker.app" ]]; then
    return 1
  fi

  open -a Docker >/dev/null 2>&1 || true
  echo "Waiting for Docker Desktop to start..."
  for _ in {1..60}; do
    docker_ready && return 0
    sleep 2
  done
  return 1
}

ensure_docker_runtime() {
  if docker_ready; then
    return 0
  fi

  if install_colima_docker_runtime && docker_ready; then
    return 0
  fi

  if start_docker_desktop && docker_ready; then
    return 0
  fi

  echo "A Docker-compatible local runtime is required for the local AI gateway." >&2
  if command -v brew >/dev/null 2>&1; then
    echo "Trooper tried to install/start Colima. You can retry manually with:" >&2
    echo "  brew install colima docker docker-compose docker-buildx && colima start" >&2
  else
    echo "Install Homebrew, then rerun this installer so Trooper can install Colima automatically." >&2
    open "https://brew.sh/" >/dev/null 2>&1 || true
  fi
  return 1
}

if ! ensure_docker_runtime; then
  exit 1
fi

if [[ ! -d "$BRIDGE_DIR/.git" ]]; then
  git clone "$TROOPER_BRIDGE_REPO_URL" "$BRIDGE_DIR"
else
  git -C "$BRIDGE_DIR" fetch --all --prune
  git -C "$BRIDGE_DIR" pull --ff-only || true
fi

if [[ -n "${OPENCLAWBRIDGE_GIT_SHA:-}" ]]; then
  git -C "$BRIDGE_DIR" checkout "$OPENCLAWBRIDGE_GIT_SHA"
fi

npm --prefix "$BRIDGE_DIR" install --omit=dev

cat > "$ENV_FILE" <<EOF
ORG_ID=$ORG_ID
API_URL=$API_URL
GATEWAY_TOKEN=$GATEWAY_TOKEN
BRIDGE_AUTH_TOKEN=$BRIDGE_AUTH_TOKEN
HOST_DEVICE_ID=$HOST_DEVICE_ID
BRIDGE_PORT=$BRIDGE_PORT
PORT=$BRIDGE_PORT
GATEWAY_PORT=$GATEWAY_PORT
OPENCLAW_GATEWAY_URL=http://127.0.0.1:$GATEWAY_PORT
PUBLIC_BRIDGE_URL=${PUBLIC_BRIDGE_URL:-}
PUBLIC_GATEWAY_URL=${PUBLIC_GATEWAY_URL:-}
TUNNEL_ID=${TUNNEL_ID:-}
TUNNEL_PROVIDER=$TUNNEL_PROVIDER
BROWSER_MODE=$BROWSER_MODE
TROOPER_LOCAL_MAC_HOST=1
TROOPER_LOCAL_UNPAIRED=${TROOPER_LOCAL_UNPAIRED:-0}
TROOPER_BRIDGE_DIR=$BRIDGE_DIR
TROOPER_HOME=$TROOPER_HOME
OPENCLAW_DATA_DIR=$OPENCLAW_DATA_DIR
OPENCLAW_DOCKER_IMAGE=$OPENCLAW_DOCKER_IMAGE
CLOUDFLARE_TUNNEL_TOKEN=${CLOUDFLARE_TUNNEL_TOKEN:-}
TROOPER_MAC_ACCESSIBILITY=${TROOPER_MAC_ACCESSIBILITY:-0}
TROOPER_MAC_AUTOMATION=${TROOPER_MAC_AUTOMATION:-0}
TROOPER_MAC_SCREEN_RECORDING=${TROOPER_MAC_SCREEN_RECORDING:-0}
TROOPER_ALLOW_EXISTING_BROWSER=${TROOPER_ALLOW_EXISTING_BROWSER:-0}
EOF
chmod 600 "$ENV_FILE"

cat > "$BIN_DIR/start-bridge.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
ENV_FILE="${TROOPER_HOME:-$HOME/Library/Application Support/Trooper/runtime}/trooper-local-host.env"
set -a
source "$ENV_FILE"
set +a
cd "$TROOPER_BRIDGE_DIR"
exec node index.mjs
EOF

cat > "$BIN_DIR/start-gateway.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
ENV_FILE="${TROOPER_HOME:-$HOME/Library/Application Support/Trooper/runtime}/trooper-local-host.env"
set -a
source "$ENV_FILE"
set +a

if command -v docker >/dev/null 2>&1; then
  docker rm -f trooper-local-gateway >/dev/null 2>&1 || true
  exec docker run --name trooper-local-gateway --pull=always \
    -p "127.0.0.1:${GATEWAY_PORT}:${GATEWAY_PORT}" \
    -v "${OPENCLAW_DATA_DIR}:/data" \
    -e "OPENCLAW_HOST=0.0.0.0" \
    -e "OPENCLAW_PORT=${GATEWAY_PORT}" \
    -e "GATEWAY_TOKEN=${GATEWAY_TOKEN}" \
    "${OPENCLAW_DOCKER_IMAGE}"
fi

echo "Docker Desktop is not installed. Install Docker Desktop or set up a direct OpenClaw gateway runner." >&2
sleep 30
exit 1
EOF

cat > "$BIN_DIR/start-tunnel.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
ENV_FILE="${TROOPER_HOME:-$HOME/Library/Application Support/Trooper/runtime}/trooper-local-host.env"
set -a
source "$ENV_FILE"
set +a

if [[ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]] && command -v cloudflared >/dev/null 2>&1; then
  exec cloudflared tunnel run --token "$CLOUDFLARE_TUNNEL_TOKEN"
fi

echo "No managed tunnel token configured yet. Waiting for PUBLIC_BRIDGE_URL or Cloudflare tunnel token..."
while true; do sleep 3600; done
EOF

cat > "$BIN_DIR/heartbeat.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
ENV_FILE="${TROOPER_HOME:-$HOME/Library/Application Support/Trooper/runtime}/trooper-local-host.env"
set -a
source "$ENV_FILE"
set +a

if [[ "${TROOPER_LOCAL_UNPAIRED:-0}" == "1" || "${ORG_ID:-}" == "local-unpaired" ]]; then
  echo "Trooper local host is installed but not paired yet. Open Trooper to connect this Mac to a workspace."
  while true; do sleep 3600; done
fi

post_json() {
  local path="$1"
  local body="$2"
  curl -fsS -X POST "$API_URL/api/organizations/$ORG_ID/$path" \
    -H 'Content-Type: application/json' \
    --data "$body" >/dev/null
}

while true; do
  HEALTH_JSON="$(curl -fsS "http://127.0.0.1:${BRIDGE_PORT}/health" 2>/dev/null || printf '{}')"
  BODY="$(HEALTH_JSON="$HEALTH_JSON" python3 - <<'PY'
import json, os
try:
    health = json.loads(os.environ.get("HEALTH_JSON") or "{}")
except Exception:
    health = {}
payload = {
    "token": os.environ.get("BRIDGE_AUTH_TOKEN"),
    "hostDeviceId": os.environ.get("HOST_DEVICE_ID"),
    "bridgeUrl": os.environ.get("PUBLIC_BRIDGE_URL") or f"http://127.0.0.1:{os.environ.get('BRIDGE_PORT', '3002')}",
    "gatewayUrl": os.environ.get("PUBLIC_GATEWAY_URL") or f"http://127.0.0.1:{os.environ.get('GATEWAY_PORT', '18789')}",
    "tunnelId": os.environ.get("TUNNEL_ID"),
    "tunnelProvider": os.environ.get("TUNNEL_PROVIDER") or "cloudflare",
    "platform": "macOS",
    "status": "ready" if health.get("status") == "ok" else "local_pending",
    "health": health,
    "browserModes": {
        "default": os.environ.get("BROWSER_MODE") or "managed",
        "managed": True,
        "existingOsBrowser": True,
        "vpsDesktop": False,
    },
    "permissions": {
        "accessibility": os.environ.get("TROOPER_MAC_ACCESSIBILITY") == "1",
        "automation": os.environ.get("TROOPER_MAC_AUTOMATION") == "1",
        "screenRecording": os.environ.get("TROOPER_MAC_SCREEN_RECORDING") == "1",
        "existingBrowser": os.environ.get("TROOPER_ALLOW_EXISTING_BROWSER") == "1",
    },
}
print(json.dumps(payload, separators=(",", ":")))
PY
)"
  post_json local-host/heartbeat "$BODY" || true
  if [[ -n "${PUBLIC_BRIDGE_URL:-}" ]]; then
    post_json local-host/complete "$BODY" || true
  fi
  sleep 30
done
EOF

chmod +x "$BIN_DIR/start-bridge.sh" "$BIN_DIR/start-gateway.sh" "$BIN_DIR/start-tunnel.sh" "$BIN_DIR/heartbeat.sh"

write_plist() {
  local label="$1"
  local program="$2"
  local plist="$PLIST_DIR/$label.plist"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$program</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$HOME</string>
    <key>TROOPER_HOME</key><string>$TROOPER_HOME</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin:$HOME/Applications/Docker.app/Contents/Resources/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key><string>$LOG_DIR/$label.out.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/$label.err.log</string>
  <key>WorkingDirectory</key><string>$TROOPER_HOME</string>
</dict>
</plist>
EOF
}

write_plist so.trooper.local-bridge "$BIN_DIR/start-bridge.sh"
write_plist so.trooper.local-gateway "$BIN_DIR/start-gateway.sh"
write_plist so.trooper.local-tunnel "$BIN_DIR/start-tunnel.sh"
write_plist so.trooper.local-heartbeat "$BIN_DIR/heartbeat.sh"

for label in so.trooper.local-gateway so.trooper.local-bridge so.trooper.local-tunnel so.trooper.local-heartbeat; do
  launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST_DIR/$label.plist"
done

cat <<EOF
Trooper Local Mac Host installed.

Host device: $HOST_DEVICE_ID
Runtime dir: $TROOPER_HOME
Bridge: http://127.0.0.1:$BRIDGE_PORT
Gateway: http://127.0.0.1:$GATEWAY_PORT

If you installed without a Trooper setup token, open Trooper to connect this Mac
to a workspace. The local host can keep running while it waits for pairing.

This Mac mode does not install LXQt, Xvnc, noVNC, or a Linux desktop.
For hosted app access, configure PUBLIC_BRIDGE_URL/PUBLIC_GATEWAY_URL or CLOUDFLARE_TUNNEL_TOKEN in:
$ENV_FILE
EOF
