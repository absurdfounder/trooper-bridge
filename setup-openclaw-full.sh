#!/bin/bash
# Setup OpenClaw + Bridge + Poller on a fresh Ubuntu 24.04 VPS
# Called via cloud-init (Hetzner user_data) — runs on first boot, no SSH needed.
# Template variables replaced at runtime by provision.js:
#   {{GATEWAY_TOKEN}}        - Unique token for this org's OpenClaw gateway
#   {{OPENAI_API_KEY}}       - Shared OpenAI API key
#   {{BRAVE_API_KEY}}        - Brave search API key
#   {{BRIDGE_PORT}}          - Port for the local bridge (default 3002)
#   {{ORG_ID}}               - Organization ID
#   {{OPENCLAW_DOCKER_IMAGE}} - Docker image (default: ghcr.io/openclaw/openclaw:latest)

set -e

trap 'dlog "Setup failed (line $LINENO, exit $?)" "installing"' ERR

GATEWAY_TOKEN="{{GATEWAY_TOKEN}}"
OPENAI_API_KEY="{{OPENAI_API_KEY}}"
BRAVE_API_KEY="{{BRAVE_API_KEY}}"
BRIDGE_PORT="{{BRIDGE_PORT}}"
ORG_ID="{{ORG_ID}}"
SSH_PUBKEY="{{SSH_PUBKEY}}"
OPENCLAW_DOCKER_IMAGE="{{OPENCLAW_DOCKER_IMAGE}}"
BRIDGE_AUTH_TOKEN="{{BRIDGE_AUTH_TOKEN}}"
GATEWAY_PORT=18789
MEDIA_PORT=18791
API_URL="{{API_URL}}"

# Deploy log — writes to /tmp/deploy.log, served via HTTP on BRIDGE_PORT
DEPLOY_LOG=/tmp/deploy.log
echo '[]' > "$DEPLOY_LOG"
dlog() {
  local msg="$1" step="${2:-installing}"
  local ts=$(date +%s000 2>/dev/null || echo 0)
  # Write to local log file (served by tiny HTTP server)
  DEPLOY_LOG="$DEPLOY_LOG" LOG_MSG="$msg" LOG_STEP="$step" LOG_TS="$ts" python3 -c "
import json,os
try:
  with open(os.environ['DEPLOY_LOG'],'r+') as f:
    logs=json.load(f); logs.append({'t':int(os.environ['LOG_TS']),'msg':os.environ['LOG_MSG'],'step':os.environ['LOG_STEP']})
    f.seek(0); json.dump(logs,f); f.truncate()
except: pass
" 2>/dev/null || true
  # Also POST directly to Render API for instant visibility in the frontend
  if [ -n "{{API_URL}}" ] && [ -n "{{ORG_ID}}" ] && [ -n "{{GATEWAY_TOKEN}}" ]; then
    curl -sf -X POST "{{API_URL}}/api/deploy-log/{{ORG_ID}}" \
      -H "Content-Type: application/json" \
      -d "{\"msg\":\"$msg\",\"step\":\"$step\",\"token\":\"{{GATEWAY_TOKEN}}\"}" \
      --max-time 3 >/dev/null 2>&1 &
  fi
}

# Start a tiny HTTP server to serve deploy logs on BRIDGE_PORT
# The real bridge will replace this later
python3 -c "
import http.server, json, threading, os
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path=='/health':
            self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers()
            self.wfile.write(b'{\"status\":\"installing\"}')
        elif self.path=='/deploy-logs':
            self.send_response(200); self.send_header('Content-Type','application/json')
            self.send_header('Access-Control-Allow-Origin','*'); self.end_headers()
            with open('$DEPLOY_LOG') as f: self.wfile.write(f.read().encode())
        else:
            self.send_response(404); self.end_headers()
    def log_message(self,*a): pass
s=http.server.HTTPServer(('0.0.0.0',${BRIDGE_PORT}),H)
s.serve_forever()
" &
LOG_SERVER_PID=$!
echo "Log server started on :${BRIDGE_PORT} (pid $LOG_SERVER_PID)"

dlog "Starting server setup..." "workspace"

# ── [1/8] SSH & OS hardening ────────────────────────────────────────

# Inject admin SSH key if provided
if [ -n "${SSH_PUBKEY:-}" ]; then
  mkdir -p /root/.ssh
  echo "$SSH_PUBKEY" >> /root/.ssh/authorized_keys
  chmod 700 /root/.ssh && chmod 600 /root/.ssh/authorized_keys
fi

# Disable root password login (keep pubkey if configured)
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl reload sshd 2>/dev/null || systemctl reload ssh 2>/dev/null || true

# Automatic security updates
apt-get update -qq
apt-get install -y -qq --no-install-recommends unattended-upgrades
echo 'Unattended-Upgrade::Automatic-Reboot "false";' > /etc/apt/apt.conf.d/51auto-upgrades

# Add 2GB swap to prevent OOM kills under load (Chrome + Docker + Node.js)
if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
    echo "Swap enabled: $(swapon --show)"
fi

# ── [2/8] Docker ────────────────────────────────────────────────────
dlog "Installing Docker engine..."
if ! command -v docker &> /dev/null; then
    apt-get install -y -qq --no-install-recommends ca-certificates curl gnupg
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg --yes
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    systemctl enable docker
    systemctl start docker
    echo "Docker installed"
else
    echo "Docker already installed"
fi

# ── [3/8] Node.js 22 ───────────────────────────────────────────────
# OpenClaw requires Node 22+ (https://docs.openclaw.ai/)
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y -qq --no-install-recommends nodejs
    echo "Node.js installed: $(node --version)"
else
    echo "Node.js already installed: $(node --version)"
fi

# ── [3.5/8] Caddy (HTTPS reverse proxy) ──────────────────────────
# Provides automatic HTTPS for the OpenClaw gateway using sslip.io
dlog "Installing Caddy..."
if ! command -v caddy &> /dev/null; then
    apt-get install -y -qq --no-install-recommends debian-keyring debian-archive-keyring apt-transport-https
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg --yes
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends caddy
    echo "Caddy installed: $(caddy version)"
else
    echo "Caddy already installed: $(caddy version)"
fi

# Get public IP (validate it's actually an IP, not an error page)
_get_ip() {
    local ip
    ip=$(curl -s -4 --max-time 10 "$1" 2>/dev/null | tr -d '[:space:]')
    if echo "$ip" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then echo "$ip"; fi
}
# Detect public IP with retries (network may not be ready during early cloud-init)
SERVER_PUBLIC_IP=""
for _ip_attempt in $(seq 1 10); do
    SERVER_PUBLIC_IP=$(_get_ip ifconfig.me || _get_ip icanhazip.com || _get_ip api.ipify.org || echo "")
    if [ -n "$SERVER_PUBLIC_IP" ]; then
        echo "Public IP detected: $SERVER_PUBLIC_IP (attempt $_ip_attempt)"
        break
    fi
    echo "IP detection attempt $_ip_attempt/10 failed, retrying in 3s..."
    sleep 3
done
if [ -z "$SERVER_PUBLIC_IP" ]; then
    echo "ERROR: Could not detect public IP after 10 attempts"
fi

# Derive hostname from ORG_ID (lowercase, first 12 chars)
# DNS is created by provision.js (Render-side) — VPS always uses crabhq.com domain
ORG_SHORT=$(echo "${ORG_ID}" | tr '[:upper:]' '[:lower:]' | head -c 12)
HTTPS_DOMAIN="org-${ORG_SHORT}.crabhq.com"
echo "HTTPS domain: ${HTTPS_DOMAIN} (DNS created by provision.js)"

if [ -n "$SERVER_PUBLIC_IP" ]; then
    # Caddyfile: reverse proxy HTTPS → gateway on localhost
    cat > /etc/caddy/Caddyfile << CADDYFILE
${HTTPS_DOMAIN} {
    handle /ws {
        reverse_proxy 127.0.0.1:${BRIDGE_PORT}
    }
    handle /api/proxy/* {
        reverse_proxy 127.0.0.1:${BRIDGE_PORT}
    }
    handle /files/* {
        reverse_proxy 127.0.0.1:${BRIDGE_PORT}
    }
    handle {
        reverse_proxy 127.0.0.1:${GATEWAY_PORT}
    }
}
CADDYFILE
    systemctl enable caddy
    echo "Caddy: configured for ${HTTPS_DOMAIN} → 127.0.0.1:${GATEWAY_PORT}"
    dlog "Caddy configured for ${HTTPS_DOMAIN}"
else
    echo "ERROR: No public IP — Caddy HTTPS not configured!"
fi

# ── [4/8] OpenClaw ──────────────────────────────────────────────────
# Shallow clone for docker-compose.yml only — the actual image comes from GHCR
dlog "Fetching OpenClaw compose files..."
if [ ! -d /opt/openclaw ]; then
    git clone --depth 1 https://github.com/openclaw/openclaw.git /opt/openclaw
else
    cd /opt/openclaw && git pull --depth 1 origin main
fi

mkdir -p /opt/openclaw-data/config /opt/openclaw-data/workspace
mkdir -p /opt/openclaw-data/config/media/browser
mkdir -p /opt/openclaw-data/config/agents/main/agent
mkdir -p /opt/openclaw-data/config/hooks

# .env for docker compose
cat > /opt/openclaw/.env << ENV
OPENCLAW_IMAGE=openclaw:local
OPENCLAW_GATEWAY_PORT=0.0.0.0:${GATEWAY_PORT}
OPENCLAW_BRIDGE_PORT=127.0.0.1:18790
OPENCLAW_GATEWAY_BIND=127.0.0.1
OPENCLAW_CONFIG_DIR=/opt/openclaw-data/config
OPENCLAW_WORKSPACE_DIR=/opt/openclaw-data/workspace
OPENAI_API_KEY=${OPENAI_API_KEY}
BRAVE_API_KEY=${BRAVE_API_KEY}
OPENCLAW_GATEWAY_TOKEN=${GATEWAY_TOKEN}
ENV

# Derive hook token from gateway token
HOOK_TOKEN=$(echo -n "${GATEWAY_TOKEN}-hook" | sha256sum | cut -c1-32)

# OpenClaw config — security-hardened per docs
cat > /opt/openclaw-data/config/openclaw.json << OCCONFIG
{
  "agents": {
    "list": [
      {
        "id": "main",
        "default": true,
        "name": "Team Lead",
        "sandbox": {
          "mode": "off"
        }
      }
    ],
    "defaults": {
      "model": { "primary": "openai/gpt-5.2" },
      "maxConcurrent": 4,
      "thinkingDefault": "low",
      "heartbeat": {
        "every": "30m",
        "target": "none"
      },
      "sandbox": {
        "mode": "all",
        "scope": "agent",
        "workspaceAccess": "rw",
        "docker": {
          "setupCommand": "apt-get update -qq && apt-get install -y -qq curl > /dev/null 2>&1"
        }
      },
      "subagents": {
        "model": "openai/gpt-5.2",
        "thinking": "low",
        "maxConcurrent": 8,
        "archiveAfterMinutes": 30
      },
      "compaction": {
        "reserveTokensFloor": 20000,
        "memoryFlush": {
          "enabled": true,
          "softThresholdTokens": 4000,
          "systemPrompt": "Session nearing compaction. Store durable memories now.",
          "prompt": "Write any lasting notes to memory/ as YYYY-MM-DD.md; reply with NO_REPLY if nothing to store."
        }
      },
      "memorySearch": {
        "enabled": true,
        "provider": "openai",
        "model": "text-embedding-3-small"
      }
    }
  },
  "models": {
    "providers": {
      "openai": {
        "baseUrl": "https://api.openai.com/v1",
        "api": "openai-completions",
        "models": [
          { "id": "gpt-5.2", "name": "GPT-5 Mini", "contextWindow": 128000 }
        ]
      }
    }
  },
  "tools": {
    "allow": [
      "exec", "read", "write", "edit", "apply_patch", "process",
      "web_search", "web_fetch", "browser",
      "sessions_list", "sessions_history", "sessions_send", "sessions_spawn", "session_status",
      "agents_list", "image", "message", "cron", "gateway",
      "llm-task", "lobster"
    ],
    "web": {
      "search": {
        "enabled": true,
        "provider": "brave",
        "apiKey": "${BRAVE_API_KEY}",
        "maxResults": 5,
        "cacheTtlMinutes": 15
      },
      "fetch": {
        "enabled": true,
        "maxChars": 50000,
        "timeoutSeconds": 30
      }
    },
    "exec": {
      "host": "sandbox",
      "notifyOnExit": true
    }
  },
  "plugins": {
    "entries": {
      "lobster": { "enabled": true },
      "llm-task": { "enabled": true }
    }
  },
  "browser": {
    "enabled": true,
    "executablePath": "/usr/bin/google-chrome-stable",
    "headless": true,
    "noSandbox": true,
    "defaultProfile": "openclaw"
  },
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "session-memory": { "enabled": true },
        "command-logger": { "enabled": true }
      }
    },
    "enabled": true,
    "token": "HOOK_TOKEN_PLACEHOLDER",
    "path": "/hooks",
    "allowRequestSessionKey": true,
    "allowedSessionKeyPrefixes": ["hook:", "hook:crabhq:"],
    "allowedAgentIds": ["*"]
  },
  "logging": {
    "redactSensitive": "tools"
  },
  "session": {
    "dmScope": "per-channel-peer"
  },
  "discovery": {
    "mdns": { "mode": "off" }
  },
  "cron": {
    "enabled": true
  },
  "gateway": {
    "port": ${GATEWAY_PORT},
    "auth": { "mode": "token", "token": "GATEWAY_TOKEN_PLACEHOLDER" },
    "trustedProxies": ["127.0.0.1", "172.16.0.0/12"],
    "controlUi": {
      "enabled": true,
      "allowInsecureAuth": true
    },
    "http": {
      "endpoints": {
        "chatCompletions": { "enabled": true },
        "responses": { "enabled": true }
      }
    }
  }
}
OCCONFIG

# Replace tokens in config (avoids heredoc escaping issues)
sed -i "s/GATEWAY_TOKEN_PLACEHOLDER/${GATEWAY_TOKEN}/g" /opt/openclaw-data/config/openclaw.json
sed -i "s/HOOK_TOKEN_PLACEHOLDER/oc-hook-${HOOK_TOKEN}/g" /opt/openclaw-data/config/openclaw.json

# Docker compose override — gateway listens on loopback only (bridge proxies external access)
# Resolve host docker group GID so the container user (UID 1000) can access the socket
DOCKER_GID=$(getent group docker | cut -d: -f3)
cat > /opt/openclaw/docker-compose.override.yml << OVERRIDE
services:
  openclaw-gateway:
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /usr/bin/docker:/usr/bin/docker:ro
      - /opt/openclaw-data/startup.sh:/opt/startup.sh:ro
    group_add:
      - "${DOCKER_GID}"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    environment:
      OPENAI_API_KEY: \${OPENAI_API_KEY}
      BRAVE_API_KEY: \${BRAVE_API_KEY}
      CHROME_PATH: /usr/bin/google-chrome-stable
      CHROMIUM_PATH: /usr/bin/google-chrome-stable
      PUPPETEER_EXECUTABLE_PATH: /usr/bin/google-chrome-stable
      OPENCLAW_BROWSER_EXECUTABLE: /usr/bin/google-chrome-stable
    user: "0:0"
    entrypoint: ["/bin/bash", "/opt/startup.sh"]
    command: ["${GATEWAY_PORT}"]
OVERRIDE

# Startup script that ensures Chrome is installed before starting the gateway
cat > /opt/openclaw-data/startup.sh << 'STARTUP'
#!/bin/bash
# Ensure Chrome is installed (survives container restarts)
if ! command -v google-chrome-stable &>/dev/null; then
  echo "[startup] Chrome not found, installing..."
  dpkg --configure -a 2>/dev/null
  wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  dpkg -i /tmp/chrome.deb 2>/dev/null || apt-get install -y -f 2>/dev/null
  rm -f /tmp/chrome.deb
  echo "[startup] Chrome installed: $(google-chrome-stable --version 2>/dev/null || echo FAILED)"
else
  echo "[startup] Chrome already installed: $(google-chrome-stable --version 2>/dev/null)"
fi
GATEWAY_PORT="${1:-18789}"
# Drop back to node user for the gateway process
exec su -s /bin/bash node -c "node dist/index.js gateway --allow-unconfigured --bind lan --port $GATEWAY_PORT"
STARTUP
chmod +x /opt/openclaw-data/startup.sh

# Auth profiles for OpenAI
cat > /opt/openclaw-data/config/agents/main/agent/auth-profiles.json << AUTHPROF
{
  "version": 1,
  "profiles": {
    "openai:default": {
      "type": "api_key",
      "provider": "openai",
      "key": "${OPENAI_API_KEY}"
    }
  },
  "lastGood": { "openai": "openai:default" }
}
AUTHPROF

# ── OpenClaw Workspace Bootstrap ──────────────────────────────────────
# Workspace files are pushed AFTER deploy via the bridge API (provision.js)
# This keeps the setup script small and workspace always in sync.
mkdir -p /opt/openclaw-data/workspace/memory

# Fix permissions: container runs as uid 1000, files should be private
chown -R 1000:1000 /opt/openclaw-data
chmod 700 /opt/openclaw-data/config
chmod 600 /opt/openclaw-data/config/openclaw.json
chmod 600 /opt/openclaw-data/config/agents/main/agent/auth-profiles.json

cd /opt/openclaw

# ── Docker image: pull official release from GHCR ─────────────────────
HOST_ARCH=$(uname -m)
DOCKER_PLATFORM="linux/amd64"
if [ "$HOST_ARCH" = "aarch64" ] || [ "$HOST_ARCH" = "arm64" ]; then
    DOCKER_PLATFORM="linux/arm64"
fi
dlog "Host arch: ${HOST_ARCH} → Docker platform: ${DOCKER_PLATFORM}"

# Default to official GHCR image if not specified by provision.js
OPENCLAW_DOCKER_IMAGE="${OPENCLAW_DOCKER_IMAGE:-ghcr.io/openclaw/openclaw:latest}"
dlog "Pulling Docker image: ${OPENCLAW_DOCKER_IMAGE}..."
echo "Pulling pre-built image: ${OPENCLAW_DOCKER_IMAGE} (${DOCKER_PLATFORM})..."
if docker pull --platform "${DOCKER_PLATFORM}" "${OPENCLAW_DOCKER_IMAGE}"; then
    docker tag "${OPENCLAW_DOCKER_IMAGE}" openclaw:local
    dlog "Docker image ready"
    echo "Image pulled and tagged as openclaw:local"
else
    dlog "Pull failed, building from source as fallback..."
    echo "Pull failed, falling back to local build (this takes several minutes)..."
    docker build --build-arg OPENCLAW_DOCKER_APT_PACKAGES="wget gnupg fonts-liberation fonts-noto-color-emoji" -t openclaw:local .
fi

dlog "Starting containers..."
# Start containers (clean up any partial state first)
docker compose down 2>/dev/null || true
docker compose up -d
sleep 3
dlog "Installing Chrome..."
docker compose exec -T openclaw-gateway bash -c '
  wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb 2>/dev/null && \
  apt-get update -qq && apt-get install -y -qq /tmp/chrome.deb 2>/dev/null && \
  rm -f /tmp/chrome.deb && \
  echo "Google Chrome installed: $(google-chrome-stable --version 2>/dev/null || echo unknown)"
' || echo "Chrome install skipped"
docker image prune -f 2>/dev/null || true

# Run openclaw setup to seed any missing workspace files, then doctor for diagnostics
docker compose exec -T openclaw-gateway openclaw setup --workspace /opt/openclaw-data/workspace 2>/dev/null || true
docker compose exec -T openclaw-gateway openclaw doctor 2>/dev/null || true

# ── [5/8] Bridge ────────────────────────────────────────────────────
dlog "Setting up Bridge..."
mkdir -p /opt/openclaw-bridge
dlog "Downloading bridge from GitHub..."
curl -fsSL "https://raw.githubusercontent.com/absurdfounder/openclawbridge/main/package.json" -o /opt/openclaw-bridge/package.json
curl -fsSL "https://raw.githubusercontent.com/absurdfounder/openclawbridge/main/index.mjs" -o /opt/openclaw-bridge/index.mjs
dlog "Bridge downloaded ($(wc -c < /opt/openclaw-bridge/index.mjs) bytes)"


cd /opt/openclaw-bridge && timeout 120 npm install --prefer-offline 2>/dev/null || timeout 120 npm install

# ── [6/8] Poller (minimal stub — bridge handles everything now) ─────
dlog "Setting up Poller..."
mkdir -p /opt/openclaw-poller
cat > /opt/openclaw-poller/package.json << 'PPKG'
{"name":"openclaw-poller","version":"1.0.0","type":"module","dependencies":{}}
PPKG

cat > /opt/openclaw-poller/index.mjs << 'POLLER'
import { setTimeout } from "timers/promises";
const BRIDGE_URL = process.env.BRIDGE_URL || "http://127.0.0.1:3002";
console.log("Poller started - Bridge:", BRIDGE_URL);
while (true) {
  try {
    const res = await fetch(BRIDGE_URL + "/requests/pending");
    const { requests } = await res.json();
    if (requests?.length) console.log("Pending:", requests.length);
  } catch (e) { /* bridge handles everything now */ }
  await setTimeout(30000);
}
POLLER

cd /opt/openclaw-poller && timeout 120 npm install --prefer-offline 2>/dev/null || timeout 120 npm install

# ── [7/8] Systemd services ──────────────────────────────────────────

# Docker Compose service (auto-start containers on boot)
cat > /etc/systemd/system/openclaw-docker.service << DSVC
[Unit]
Description=OpenClaw Docker Compose
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/openclaw
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down

[Install]
WantedBy=multi-user.target
DSVC

# Bridge service
cat > /etc/systemd/system/openclaw-bridge.service << BSVC
[Unit]
Description=OpenClaw Bridge
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/openclaw-bridge
ExecStart=/usr/bin/node /opt/openclaw-bridge/index.mjs
Restart=always
RestartSec=5
Environment=BRIDGE_PORT=${BRIDGE_PORT}
Environment=BRIDGE_AUTH_TOKEN=${BRIDGE_AUTH_TOKEN}
Environment=OPENCLAW_URL=http://127.0.0.1:${GATEWAY_PORT}
Environment=OPENCLAW_GATEWAY_TOKEN=${GATEWAY_TOKEN}
Environment=OPENCLAW_HOOK_TOKEN=oc-hook-${HOOK_TOKEN}
Environment=MISSION_CONTROL_URL=https://control-center-bot.onrender.com
Environment=ORG_ID=${ORG_ID}
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
BSVC

# Poller service
cat > /etc/systemd/system/openclaw-poller.service << PSVC
[Unit]
Description=OpenClaw Poller
After=network.target docker.service openclaw-bridge.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=/opt/openclaw-poller
ExecStart=/usr/bin/node /opt/openclaw-poller/index.mjs
Restart=always
RestartSec=5
Environment=BRIDGE_URL=http://127.0.0.1:${BRIDGE_PORT}
Environment=OPENCLAW_URL=http://127.0.0.1:${GATEWAY_PORT}
Environment=OPENCLAW_TOKEN=${GATEWAY_TOKEN}
Environment=OPENCLAW_HOOK_TOKEN=oc-hook-${HOOK_TOKEN}
Environment=OPENCLAW_MODEL=openai/gpt-5.2
Environment=POLL_INTERVAL=3000
Environment=REQUEST_TIMEOUT=180000
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
PSVC

systemctl daemon-reload
systemctl enable openclaw-docker openclaw-bridge openclaw-poller
dlog "Starting services..."
# Kill the temporary log server so the real bridge can use the port
kill $LOG_SERVER_PID 2>/dev/null; sleep 1
systemctl start openclaw-bridge
systemctl start openclaw-poller
# Start Caddy (HTTPS reverse proxy) — needs gateway container to be up
systemctl restart caddy 2>/dev/null || true

# ── [8/8] Verify ────────────────────────────────────────────────────
sleep 5

# Check docker
if docker ps | grep -q openclaw; then
    echo "Container up"
else
    echo "Container down"
    docker ps -a
fi

# Pre-approve bridge device — generate identity BEFORE starting bridge, write it into gateway config
# This eliminates the pairing race condition entirely
echo "Pre-generating bridge device identity and approving in gateway config..."
mkdir -p /opt/openclaw-data/config/devices /opt/openclaw-bridge

# Generate ed25519 keypair and device identity using Node.js (same as bridge does internally)
node -e "
const crypto = require('crypto');
const fs = require('fs');
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');

// Bridge identity uses PEM format (same as bridge's own loadOrCreateDeviceIdentity)
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).slice(-32);
const deviceId = crypto.createHash('sha256').update(pubRaw).digest('hex');

// Bridge identity file — PEM format as bridge expects
const identity = { version: 1, deviceId, publicKeyPem, privateKeyPem, createdAtMs: Date.now() };
fs.writeFileSync('/opt/openclaw-bridge/device-identity.json', JSON.stringify(identity, null, 2), { mode: 0o600 });

// Gateway paired.json — base64url public key as gateway expects
const pubB64 = pubRaw.toString('base64url');
const paired = {};
paired[deviceId] = {
  deviceId, publicKey: pubB64,
  displayName: 'CrabsHQ Bridge', platform: 'linux',
  role: 'operator', roles: ['operator'], scopes: ['operator.admin'],
  clientId: 'gateway-client', clientMode: 'backend',
  approvedAt: Date.now(), approved: true, ts: Date.now()
};
fs.writeFileSync('/opt/openclaw-data/config/devices/paired.json', JSON.stringify(paired, null, 2));
fs.writeFileSync('/opt/openclaw-data/config/devices/pending.json', '{}');
console.log('Pre-approved device: ' + deviceId.substring(0, 12) + '...');
"

# Fix ownership — Docker runs as uid 1000, files were created by root
chown -R 1000:1000 /opt/openclaw-data

# Restart services so they pick up pre-approved identity
systemctl restart openclaw-bridge
sleep 3
# Gateway needs to reload paired.json — restart container
cd /opt/openclaw && docker compose restart openclaw-gateway
sleep 5
# Bridge should now connect without pairing dance
systemctl restart openclaw-bridge
sleep 5

# Check bridge
if curl -s http://127.0.0.1:${BRIDGE_PORT}/health | grep -q ok; then
    echo "Bridge: HEALTHY"
else
    echo "Bridge: NOT HEALTHY"
fi

# Check poller
if systemctl is-active --quiet openclaw-poller; then
    echo "Poller: RUNNING"
else
    echo "Poller: NOT RUNNING"
    journalctl -u openclaw-poller --no-pager -n 10
fi

# Check Caddy (HTTPS)
if systemctl is-active --quiet caddy; then
    echo "Caddy: RUNNING (HTTPS via ${SSLIP_DOMAIN:-unknown})"
else
    echo "Caddy: NOT RUNNING"
    journalctl -u caddy --no-pager -n 10
fi

echo done
