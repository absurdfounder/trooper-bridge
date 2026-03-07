#!/bin/bash
# Setup OpenClaw + Bridge + Poller on a fresh Ubuntu 24.04 VPS
# Called via cloud-init (Hetzner user_data) — runs on first boot, no SSH needed.
# Template variables replaced at runtime by provision.js:
# {{GATEWAY_TOKEN}} - Unique token for this org's OpenClaw gateway
# {{OPENAI_API_KEY}} - OpenAI API key (optional)
# {{ANTHROPIC_API_KEY}} - Anthropic/Claude API key (optional)
# {{GEMINI_API_KEY}} - Google Gemini API key (optional)
# {{OPENROUTER_API_KEY}} - OpenRouter API key (optional)
# {{BRAVE_API_KEY}} - Brave search API key
# {{BRIDGE_PORT}} - Port for the local bridge (default 3002)
# {{ORG_ID}} - Organization ID
# {{OPENCLAW_DOCKER_IMAGE}} - Docker image (default: ghcr.io/openclaw/openclaw:latest)
# {{PRIMARY_PROVIDER}} - Preferred model provider (anthropic|openai|gemini|openrouter, default: auto-detect)
# {{PRIMARY_MODEL}} - Preferred model ID (default: auto-detect from provider)

set -e

trap 'EXIT_CODE=$?; FAIL_LINE=$LINENO; dlog "Setup failed at line ${FAIL_LINE} (exit ${EXIT_CODE}). Disk: $(df -h /var/lib/docker 2>/dev/null | tail -1 | awk "{print \$4}") free. Docker: $(docker ps -q 2>/dev/null | wc -l) containers." "failed"; exit ${EXIT_CODE}' ERR

GATEWAY_TOKEN="{{GATEWAY_TOKEN}}"
OPENAI_API_KEY="{{OPENAI_API_KEY}}"
ANTHROPIC_API_KEY="{{ANTHROPIC_API_KEY}}"
GEMINI_API_KEY="{{GEMINI_API_KEY}}"
OPENROUTER_API_KEY="{{OPENROUTER_API_KEY}}"
BRAVE_API_KEY="{{BRAVE_API_KEY}}"
BRIDGE_PORT="{{BRIDGE_PORT}}"
ORG_ID="{{ORG_ID}}"
SSH_PUBKEY="{{SSH_PUBKEY}}"
OPENCLAW_DOCKER_IMAGE="{{OPENCLAW_DOCKER_IMAGE}}"
BRIDGE_AUTH_TOKEN="{{BRIDGE_AUTH_TOKEN}}"
GATEWAY_PORT=18789
MEDIA_PORT=18791
API_URL="{{API_URL}}"
COMPOSIO_API_KEY="{{COMPOSIO_API_KEY}}"
CF_API_TOKEN="{{CF_API_TOKEN}}"
PRIMARY_PROVIDER="{{PRIMARY_PROVIDER}}"
PRIMARY_MODEL="{{PRIMARY_MODEL}}"
BROWSERBASE_API_KEY="{{BROWSERBASE_API_KEY}}"
BROWSERBASE_PROJECT_ID="{{BROWSERBASE_PROJECT_ID}}"

# Detect if booting from a pre-built snapshot (skip heavy installs)
FROM_SNAPSHOT="${CRABHQ_FROM_SNAPSHOT:-0}"

# Dry-run mode: print commands instead of executing them
DRY_RUN="${DRY_RUN:-0}"
run_cmd() {
  if [ "$DRY_RUN" = "1" ]; then
    echo "[DRY-RUN] $*"
  else
    "$@"
  fi
}

# Deploy log — writes to /tmp/deploy.log, served via HTTP on BRIDGE_PORT
DEPLOY_LOG=/tmp/deploy.log
DEPLOY_RAW_LOG=/tmp/deploy-raw.log
echo '[]' > "$DEPLOY_LOG"
: > "$DEPLOY_RAW_LOG"
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

# Capture all script output to raw log (apt-get, docker, etc.) — served via /deploy-logs-raw
exec 1> >(tee -a "$DEPLOY_RAW_LOG") 2>&1

# Background raw log pusher — POSTs tail of raw log to API every 5s
# This bypasses the need for inbound VPS connectivity on port 3002
if [ -n "{{API_URL}}" ] && [ -n "{{ORG_ID}}" ] && [ -n "{{GATEWAY_TOKEN}}" ]; then
  (while true; do
    sleep 5
    [ -s "$DEPLOY_RAW_LOG" ] || continue
    _raw_json=$(tail -c 50000 "$DEPLOY_RAW_LOG" 2>/dev/null | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))' 2>/dev/null) || continue
    curl -sf -X POST "{{API_URL}}/api/deploy-log/{{ORG_ID}}" \
      -H "Content-Type: application/json" \
      -d "{\"msg\":\"_rawlog_sync\",\"step\":\"installing\",\"token\":\"{{GATEWAY_TOKEN}}\",\"rawLog\":${_raw_json}}" \
      --max-time 10 >/dev/null 2>&1 || true
  done) &
  RAW_LOG_PUSHER_PID=$!
fi

# Start a tiny HTTP server to serve deploy logs on BRIDGE_PORT
# The real bridge will replace this later
python3 -c "
import http.server, json, os
class H(http.server.BaseHTTPRequestHandler):
  def do_GET(self):
    if self.path=='/health':
      self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers()
      self.wfile.write(b'{\"status\":\"installing\"}')
    elif self.path=='/deploy-logs':
      self.send_response(200); self.send_header('Content-Type','application/json')
      self.send_header('Access-Control-Allow-Origin','*'); self.end_headers()
      with open('$DEPLOY_LOG') as f: self.wfile.write(f.read().encode())
    elif self.path=='/deploy-logs-raw':
      self.send_response(200); self.send_header('Content-Type','text/plain; charset=utf-8')
      self.send_header('Access-Control-Allow-Origin','*'); self.end_headers()
      try:
        with open('$DEPLOY_RAW_LOG') as f: self.wfile.write(f.read().encode())
      except: self.wfile.write(b'')
    else:
      self.send_response(404); self.end_headers()
  def log_message(self,*a): pass
s=http.server.HTTPServer(('0.0.0.0',${BRIDGE_PORT}),H)
s.serve_forever()
" &
LOG_SERVER_PID=$!
echo "Log server started on :${BRIDGE_PORT} (pid $LOG_SERVER_PID)"

dlog "Starting server setup..." "workspace"

if [ "$FROM_SNAPSHOT" = "1" ]; then
  dlog "Booting from snapshot — skipping package installs" "installing"
fi
if [ "$DRY_RUN" = "1" ]; then
  dlog "Running in dry-run mode" "installing"
fi

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

# Add 2GB swap in background (doesn't block anything)
if [ ! -f /swapfile ]; then
 (fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile \
 && echo '/swapfile none swap sw 0 0' >> /etc/fstab && echo "Swap enabled: $(swapon --show)") &
 SWAP_PID=$!
fi

# ── [2/8] Docker + Node.js + Caddy (batched repo setup + single install) ──
# Instead of 3 separate apt-get update cycles, set up ALL repos first, then install once
if [ "$FROM_SNAPSHOT" != "1" ]; then
dlog "Installing Docker, Node.js, Caddy..."

run_cmd apt-get update -qq
run_cmd apt-get install -y -qq --no-install-recommends ca-certificates curl gnupg unattended-upgrades debian-keyring debian-archive-keyring apt-transport-https
echo 'Unattended-Upgrade::Automatic-Reboot "false";' > /etc/apt/apt.conf.d/51auto-upgrades

# Add Docker repo
if ! command -v docker &> /dev/null; then
 install -m 0755 -d /etc/apt/keyrings
 curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg --yes
 chmod a+r /etc/apt/keyrings/docker.gpg
 echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
fi

# Add Node.js 22 repo
if ! command -v node &> /dev/null; then
 curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
fi

# Add Caddy repo
if ! command -v caddy &> /dev/null; then
 curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg --yes
 curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
fi

# Single apt-get update + install for ALL packages (saves ~30-45s vs 3 separate rounds)
apt-get update -qq
PACKAGES=""
command -v docker &>/dev/null || PACKAGES="$PACKAGES docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"
command -v node &>/dev/null || PACKAGES="$PACKAGES nodejs"
command -v caddy &>/dev/null || PACKAGES="$PACKAGES caddy"
if [ -n "$PACKAGES" ]; then
 apt-get install -y -qq --no-install-recommends $PACKAGES
fi

# Docker setup
if command -v docker &>/dev/null; then
 systemctl enable docker
 systemctl start docker
 mkdir -p /etc/docker
 cat > /etc/docker/daemon.json << 'DOCKERCFG'
{
 "storage-driver": "overlay2",
 "log-driver": "json-file",
 "log-opts": { "max-size": "10m", "max-file": "3" },
 "max-concurrent-downloads": 3,
 "max-concurrent-uploads": 2
}
DOCKERCFG
 systemctl restart docker
 echo "Docker installed"
fi
echo "Node.js installed: $(node --version 2>/dev/null || echo 'N/A')"
echo "Caddy installed: $(caddy version 2>/dev/null || echo 'N/A')"

# Shared socket for Agent Daemon (desktop exec via Unix socket)
mkdir -p /var/run/openclaw
chmod 1777 /var/run/openclaw

# Wait for swap to finish
[ -n "${SWAP_PID:-}" ] && wait $SWAP_PID 2>/dev/null || true

fi # end FROM_SNAPSHOT != 1 (Docker + Node + Caddy install)

# ── Start Docker image pull in BACKGROUND (biggest bottleneck: 2-3 GB download) ──
# While the image downloads, we continue with config generation, git clone, etc.
HOST_ARCH=$(uname -m)
DOCKER_PLATFORM="linux/amd64"
if [ "$HOST_ARCH" = "aarch64" ] || [ "$HOST_ARCH" = "arm64" ]; then
 DOCKER_PLATFORM="linux/arm64"
fi
OPENCLAW_DOCKER_IMAGE="${OPENCLAW_DOCKER_IMAGE:-ghcr.io/absurdfounder/crabhq-gateway:latest}"

if [ "$FROM_SNAPSHOT" = "1" ]; then
  # Image already cached on snapshot — just re-tag it
  dlog "Snapshot boot: tagging cached Docker image as openclaw:local"
  docker tag "${OPENCLAW_DOCKER_IMAGE}" openclaw:local 2>/dev/null || docker tag ghcr.io/absurdfounder/crabhq-gateway:latest openclaw:local
  echo "IMAGE_READY=true" > /tmp/docker-pull-status
  DOCKER_PULL_PID=""
else
dlog "Pulling Docker image in background: ${OPENCLAW_DOCKER_IMAGE}..."
echo "Starting background pull: ${OPENCLAW_DOCKER_IMAGE} (${DOCKER_PLATFORM})..."

# Clean stale Docker state
docker system prune -f 2>/dev/null || true

# Background pull — we'll wait for it later before docker compose up
DOCKER_PULL_LOG=/tmp/docker-pull.log
(
 for attempt in 1 2 3; do
 if docker pull --platform "${DOCKER_PLATFORM}" "${OPENCLAW_DOCKER_IMAGE}" > "$DOCKER_PULL_LOG" 2>&1; then
 docker tag "${OPENCLAW_DOCKER_IMAGE}" openclaw:local
 echo "IMAGE_READY=true" > /tmp/docker-pull-status
 exit 0
 fi
 echo "Pull attempt ${attempt} failed" >> "$DOCKER_PULL_LOG"
 docker system prune -a -f 2>/dev/null || true
 systemctl restart docker 2>/dev/null || true
 sleep $((attempt * 4))
 done
 echo "IMAGE_READY=false" > /tmp/docker-pull-status
) &
DOCKER_PULL_PID=$!
fi # end FROM_SNAPSHOT Docker pull

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
 SSLIP_DOMAIN=$(echo "$SERVER_PUBLIC_IP" | tr '.' '-').sslip.io

 # Generate self-signed cert for CF origin (CF Full mode accepts self-signed)
 mkdir -p /etc/caddy/certs
 openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
   -keyout /etc/caddy/certs/cf-origin.key \
   -out /etc/caddy/certs/cf-origin.crt \
   -subj "/CN=*.crabhq.com" 2>/dev/null
 chown caddy:caddy /etc/caddy/certs/cf-origin.key /etc/caddy/certs/cf-origin.crt
 chmod 600 /etc/caddy/certs/cf-origin.key

 # Caddyfile: CF-proxied crabhq.com domain (primary) + sslip.io fallback
 cat > /etc/caddy/Caddyfile << CADDYFILE
# Primary: CF-proxied domain (self-signed cert — CF terminates external SSL)
${HTTPS_DOMAIN} {
 tls /etc/caddy/certs/cf-origin.crt /etc/caddy/certs/cf-origin.key
 handle /ws {
 reverse_proxy 127.0.0.1:${BRIDGE_PORT}
 }
 handle /api/proxy/* {
 reverse_proxy 127.0.0.1:${BRIDGE_PORT}
 }
 handle /files/* {
 reverse_proxy 127.0.0.1:${BRIDGE_PORT}
 }
 handle_path /vnc/* {
 uri replace /vnc.html /vnc_embed.html
 reverse_proxy 127.0.0.1:6080
 }
 handle_path /desktop-vnc/* {
 uri replace /vnc.html /vnc_embed.html
 reverse_proxy 127.0.0.1:6081
 }
 handle_path /playwright-ws/* {
 reverse_proxy 127.0.0.1:3333
 }
 handle /desktop-api/* {
 uri strip_prefix /desktop-api
 reverse_proxy 127.0.0.1:4567
 }
 handle {
 reverse_proxy 127.0.0.1:${GATEWAY_PORT}
 }
}

# Fallback: sslip.io (direct HTTPS via Let's Encrypt, no CF dependency)
${SSLIP_DOMAIN} {
 handle /ws {
 reverse_proxy 127.0.0.1:${BRIDGE_PORT}
 }
 handle /api/proxy/* {
 reverse_proxy 127.0.0.1:${BRIDGE_PORT}
 }
 handle /files/* {
 reverse_proxy 127.0.0.1:${BRIDGE_PORT}
 }
 handle_path /vnc/* {
 uri replace /vnc.html /vnc_embed.html
 reverse_proxy 127.0.0.1:6080
 }
 handle_path /desktop-vnc/* {
 uri replace /vnc.html /vnc_embed.html
 reverse_proxy 127.0.0.1:6081
 }
 handle_path /playwright-ws/* {
 reverse_proxy 127.0.0.1:3333
 }
 handle /desktop-api/* {
 uri strip_prefix /desktop-api
 reverse_proxy 127.0.0.1:4567
 }
 handle {
 reverse_proxy 127.0.0.1:${GATEWAY_PORT}
 }
}
CADDYFILE
 systemctl enable caddy
 echo "Caddy: configured for ${HTTPS_DOMAIN} + ${SSLIP_DOMAIN} → 127.0.0.1:${GATEWAY_PORT}"
 dlog "Caddy configured for ${HTTPS_DOMAIN}"
else
 echo "ERROR: No public IP — Caddy HTTPS not configured!"
fi

# ── [3b/9] Cloudflare Tunnel (primary HTTPS, Caddy kept as fallback) ──
# Non-fatal: if tunnel setup fails, Caddy handles HTTPS
if [ -n "${CF_API_TOKEN:-}" ] && [ -n "${ORG_ID:-}" ]; then
 (
 set +e  # Don't exit on errors inside tunnel setup
 dlog "Setting up Cloudflare Tunnel..." "cloudflare-tunnel"

 # Install cloudflared if not present
 if ! command -v cloudflared &>/dev/null; then
   CLOUDFLARED_URL=$(curl -sf "https://api.github.com/repos/cloudflare/cloudflared/releases/latest" | \
     python3 -c "import sys,json; releases=json.load(sys.stdin)['assets']; print(next(a['browser_download_url'] for a in releases if a['name']=='cloudflared-linux-amd64.deb'))" 2>/dev/null || \
     echo "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb")
   curl -fsSL -o /tmp/cloudflared.deb "$CLOUDFLARED_URL"
   dpkg -i /tmp/cloudflared.deb
   rm -f /tmp/cloudflared.deb
 fi

 # Get Cloudflare account ID
 CF_ACCOUNT_ID=$(curl -sf -H "Authorization: Bearer ${CF_API_TOKEN}" \
   "https://api.cloudflare.com/client/v4/accounts?page=1&per_page=1" | \
   python3 -c "import sys,json; print(json.load(sys.stdin)['result'][0]['id'])" 2>/dev/null || true)

 if [ -n "$CF_ACCOUNT_ID" ]; then
   TUNNEL_NAME="org-${ORG_ID}"

   # Check if tunnel already exists
   EXISTING_TUNNEL=$(curl -sf -H "Authorization: Bearer ${CF_API_TOKEN}" \
     "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/cfd_tunnel?name=${TUNNEL_NAME}&is_deleted=false" | \
     python3 -c "import sys,json; r=json.load(sys.stdin)['result']; print(r[0]['id'] if r else '')" 2>/dev/null || true)

   if [ -n "$EXISTING_TUNNEL" ]; then
     TUNNEL_ID="$EXISTING_TUNNEL"
     echo "Cloudflare Tunnel already exists: ${TUNNEL_ID}"
   else
     # Create tunnel via API
     TUNNEL_SECRET=$(openssl rand -base64 32)
     TUNNEL_RESPONSE=$(curl -sf -X POST \
       -H "Authorization: Bearer ${CF_API_TOKEN}" \
       -H "Content-Type: application/json" \
       "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/cfd_tunnel" \
       -d "{\"name\":\"${TUNNEL_NAME}\",\"tunnel_secret\":\"${TUNNEL_SECRET}\"}" 2>/dev/null || true)
     TUNNEL_ID=$(echo "$TUNNEL_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['id'])" 2>/dev/null || true)
     echo "Cloudflare Tunnel created: ${TUNNEL_ID}"
   fi

   if [ -n "$TUNNEL_ID" ]; then
     # Get tunnel token for cloudflared connector
     TUNNEL_TOKEN=$(curl -sf -H "Authorization: Bearer ${CF_API_TOKEN}" \
       "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${TUNNEL_ID}/token" | \
       python3 -c "import sys,json; print(json.load(sys.stdin)['result'])" 2>/dev/null || true)

     # Configure tunnel ingress via API
     curl -sf -X PUT \
       -H "Authorization: Bearer ${CF_API_TOKEN}" \
       -H "Content-Type: application/json" \
       "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${TUNNEL_ID}/configurations" \
       -d "{\"config\":{\"ingress\":[
         {\"hostname\":\"${HTTPS_DOMAIN}\",\"path\":\"ws\",\"service\":\"http://localhost:${BRIDGE_PORT}\"},
         {\"hostname\":\"${HTTPS_DOMAIN}\",\"path\":\"vnc/*\",\"service\":\"http://localhost:6080\"},
         {\"hostname\":\"${HTTPS_DOMAIN}\",\"service\":\"http://localhost:${GATEWAY_PORT}\"},
         {\"service\":\"http_status:404\"}
       ]}}" >/dev/null 2>&1

     # Route DNS to tunnel (CNAME)
     CF_ZONE_ID="da3b8c817a0e3479c05f3f2aac6e04e7"
     curl -sf -X POST \
       -H "Authorization: Bearer ${CF_API_TOKEN}" \
       -H "Content-Type: application/json" \
       "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records" \
       -d "{\"type\":\"CNAME\",\"name\":\"${HTTPS_DOMAIN}\",\"content\":\"${TUNNEL_ID}.cfargotunnel.com\",\"ttl\":1,\"proxied\":true}" >/dev/null 2>&1 || true

     # Set up cloudflared as a systemd service using tunnel token
     if [ -n "$TUNNEL_TOKEN" ]; then
       mkdir -p /etc/cloudflared
       cat > /etc/systemd/system/cloudflared.service << CFDSERVICE
[Unit]
Description=Cloudflare Tunnel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/cloudflared tunnel --no-autoupdate run --token ${TUNNEL_TOKEN}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
CFDSERVICE
       systemctl daemon-reload
       systemctl enable --now cloudflared
       echo "Cloudflare Tunnel: running (${TUNNEL_NAME} → ${HTTPS_DOMAIN})"
       dlog "Cloudflare Tunnel configured: ${HTTPS_DOMAIN}"
     else
       echo "WARNING: Could not get tunnel token — cloudflared not started"
     fi
   else
     echo "WARNING: Cloudflare Tunnel creation failed — falling back to Caddy"
   fi
 else
   echo "WARNING: Could not get Cloudflare account ID — falling back to Caddy"
 fi
 ) || echo "WARNING: Cloudflare Tunnel setup failed (non-fatal) — Caddy will handle HTTPS"
else
 echo "Cloudflare Tunnel: skipped (no CF_API_TOKEN)"
fi

# ── [4/9] Model Routing ────────────────────────────────────────────
# Determine which AI model provider and model to use based on available API keys.
# Priority: user-specified > anthropic > openai > gemini > openrouter
dlog "Configuring model routing..." "model-routing"

resolve_primary_model() {
 # If user explicitly specified provider + model, use that
 if [ -n "${PRIMARY_PROVIDER:-}" ] && [ "${PRIMARY_PROVIDER}" != "__UNSET_PRIMARY_PROVIDER__" ] && \
 [ -n "${PRIMARY_MODEL:-}" ] && [ "${PRIMARY_MODEL}" != "__UNSET_PRIMARY_MODEL__" ]; then
 echo "${PRIMARY_PROVIDER}/${PRIMARY_MODEL}"
 return
 fi

 # If user specified provider but not model, pick best model for that provider
 local provider="${PRIMARY_PROVIDER:-}"
 if [ -n "$provider" ] && [ "$provider" != "__UNSET_PRIMARY_PROVIDER__" ]; then
 case "$provider" in
 anthropic) echo "anthropic/claude-sonnet-4-5"; return ;;
 openai) echo "openai/gpt-5.2"; return ;;
 gemini) echo "google/gemini-2.5-pro"; return ;;
 openrouter) echo "openrouter/anthropic/claude-sonnet-4-5"; return ;;
 esac
 fi

 # Auto-detect from available API keys (priority: anthropic > openai > gemini > openrouter)
 if [ -n "${ANTHROPIC_API_KEY:-}" ] && [ "${ANTHROPIC_API_KEY}" != "__UNSET_ANTHROPIC_API_KEY__" ]; then
 echo "anthropic/claude-sonnet-4-5"
 elif [ -n "${OPENAI_API_KEY:-}" ] && [ "${OPENAI_API_KEY}" != "__UNSET_OPENAI_API_KEY__" ]; then
 echo "openai/gpt-5.2"
 elif [ -n "${GEMINI_API_KEY:-}" ] && [ "${GEMINI_API_KEY}" != "__UNSET_GEMINI_API_KEY__" ]; then
 echo "google/gemini-2.5-pro"
 elif [ -n "${OPENROUTER_API_KEY:-}" ] && [ "${OPENROUTER_API_KEY}" != "__UNSET_OPENROUTER_API_KEY__" ]; then
 echo "openrouter/openai/gpt-5-mini"
 else
 # Fallback — no keys found, default to cheap model
 echo "openrouter/openai/gpt-5-mini"
 fi
}

RESOLVED_MODEL=$(resolve_primary_model)
RESOLVED_PROVIDER=$(echo "$RESOLVED_MODEL" | cut -d'/' -f1)
RESOLVED_MODEL_ID=$(echo "$RESOLVED_MODEL" | cut -d'/' -f2-)
dlog "Model routing: ${RESOLVED_MODEL} (provider: ${RESOLVED_PROVIDER})"
echo "Model routing resolved: ${RESOLVED_MODEL}"

# Build fallback chain — include all providers that have keys
MODEL_FALLBACKS=""
build_fallback() {
 local ref="$1"
 if [ "$ref" != "$RESOLVED_MODEL" ]; then
 if [ -z "$MODEL_FALLBACKS" ]; then
 MODEL_FALLBACKS="\"${ref}\""
 else
 MODEL_FALLBACKS="${MODEL_FALLBACKS}, \"${ref}\""
 fi
 fi
}
if [ -n "${ANTHROPIC_API_KEY:-}" ] && [ "${ANTHROPIC_API_KEY}" != "__UNSET_ANTHROPIC_API_KEY__" ]; then
 build_fallback "anthropic/claude-sonnet-4-5"
fi
if [ -n "${OPENAI_API_KEY:-}" ] && [ "${OPENAI_API_KEY}" != "__UNSET_OPENAI_API_KEY__" ]; then
 build_fallback "openai/gpt-5.2"
fi
if [ -n "${GEMINI_API_KEY:-}" ] && [ "${GEMINI_API_KEY}" != "__UNSET_GEMINI_API_KEY__" ]; then
 build_fallback "google/gemini-2.5-pro"
fi
if [ -n "${OPENROUTER_API_KEY:-}" ] && [ "${OPENROUTER_API_KEY}" != "__UNSET_OPENROUTER_API_KEY__" ]; then
 build_fallback "openrouter/openai/gpt-5-mini"
fi

# Build fallbacks JSON (may be empty)
if [ -n "$MODEL_FALLBACKS" ]; then
 FALLBACKS_JSON=", \"fallbacks\": [${MODEL_FALLBACKS}]"
else
 FALLBACKS_JSON=""
fi

echo "Fallback chain: ${MODEL_FALLBACKS:-none}"

# ── [5/9] OpenClaw ──────────────────────────────────────────────────
# Shallow clone for docker-compose.yml only — the actual image comes from GHCR
dlog "Fetching OpenClaw compose files..."
if [ ! -d /opt/openclaw ]; then
 for _git_attempt in 1 2 3; do
 if git clone --depth 1 https://github.com/openclaw/openclaw.git /opt/openclaw; then
 break
 fi
 dlog "Git clone attempt ${_git_attempt} failed, retrying..."
 rm -rf /opt/openclaw 2>/dev/null || true
 sleep $((${_git_attempt} * 3))
 done
else
 cd /opt/openclaw && git pull --depth 1 origin main || true
fi

mkdir -p /opt/openclaw-data/config /opt/openclaw-data/workspace
mkdir -p /opt/openclaw-data/config/media/browser
mkdir -p /opt/openclaw-data/config/agents/main/agent
mkdir -p /opt/openclaw-data/config/hooks
mkdir -p /opt/openclaw-data/config/credentials

# Create node user on host — bridge service uses /home/node/.openclaw for CLI sub-connections (browser, cron tools)
if ! id -u node >/dev/null 2>&1; then
  useradd -r -m -s /bin/bash node 2>/dev/null || true
fi
# Add node to docker group so it can exec into containers
usermod -aG docker node 2>/dev/null || true
# Add node to systemd-journal so bridge can read poller/bridge logs via journalctl
usermod -aG systemd-journal node 2>/dev/null || true
mkdir -p /home/node/.openclaw/identity /home/node/.openclaw/config
chown -R node:node /home/node/.openclaw 2>/dev/null || chown -R 1000:1000 /home/node/.openclaw 2>/dev/null || true
# Also chown the bridge dir so node can read its own identity file
chown -R node:node /opt/openclaw-bridge 2>/dev/null || true

# .env for docker compose — pass all available provider keys
cat > /opt/openclaw/.env << ENV
OPENCLAW_IMAGE=openclaw:local
OPENCLAW_GATEWAY_PORT=0.0.0.0:${GATEWAY_PORT}
OPENCLAW_BRIDGE_PORT=127.0.0.1:18790
OPENCLAW_CONFIG_DIR=/opt/openclaw-data/config
OPENCLAW_WORKSPACE_DIR=/opt/openclaw-data/workspace
OPENCLAW_GATEWAY_TOKEN=${GATEWAY_TOKEN}
BRAVE_API_KEY=${BRAVE_API_KEY}
COMPOSIO_API_KEY=${COMPOSIO_API_KEY}
CLAUDE_AI_SESSION_KEY=
CLAUDE_WEB_SESSION_KEY=
CLAUDE_WEB_COOKIE=
ENV

# Conditionally add provider API keys to .env (only if set)
[ -n "${OPENAI_API_KEY:-}" ] && [ "${OPENAI_API_KEY}" != "__UNSET_OPENAI_API_KEY__" ] && echo "OPENAI_API_KEY=${OPENAI_API_KEY}" >> /opt/openclaw/.env
[ -n "${ANTHROPIC_API_KEY:-}" ] && [ "${ANTHROPIC_API_KEY}" != "__UNSET_ANTHROPIC_API_KEY__" ] && echo "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}" >> /opt/openclaw/.env
[ -n "${GEMINI_API_KEY:-}" ] && [ "${GEMINI_API_KEY}" != "__UNSET_GEMINI_API_KEY__" ] && echo "GEMINI_API_KEY=${GEMINI_API_KEY}" >> /opt/openclaw/.env
[ -n "${OPENROUTER_API_KEY:-}" ] && [ "${OPENROUTER_API_KEY}" != "__UNSET_OPENROUTER_API_KEY__" ] && echo "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" >> /opt/openclaw/.env

# Fix ownership so bridge (node user) can update .env later
chown node:node /opt/openclaw/.env 2>/dev/null || chown 1000:1000 /opt/openclaw/.env 2>/dev/null || true

# Derive hook token from gateway token
HOOK_TOKEN=$(echo -n "${GATEWAY_TOKEN}-hook" | sha256sum | cut -c1-32)

# ── Build dynamic models.providers JSON ──
# Only include providers whose API keys are available
MODELS_PROVIDERS=""
add_provider() {
 local entry="$1"
 if [ -z "$MODELS_PROVIDERS" ]; then
 MODELS_PROVIDERS="$entry"
 else
 MODELS_PROVIDERS="${MODELS_PROVIDERS},
$entry"
 fi
}

if [ -n "${ANTHROPIC_API_KEY:-}" ] && [ "${ANTHROPIC_API_KEY}" != "__UNSET_ANTHROPIC_API_KEY__" ]; then
 add_provider ' "anthropic": {
 "baseUrl": "https://api.anthropic.com",
 "api": "anthropic-messages",
 "models": [
 { "id": "claude-opus-4-6", "name": "Claude Opus 4.6", "contextWindow": 200000 },
 { "id": "claude-sonnet-4-5", "name": "Claude Sonnet 4.5", "contextWindow": 200000 },
 { "id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6", "contextWindow": 200000 },
 { "id": "claude-haiku-4-5", "name": "Claude Haiku 4.5", "contextWindow": 200000 }
 ]
 }'
fi

if [ -n "${OPENAI_API_KEY:-}" ] && [ "${OPENAI_API_KEY}" != "__UNSET_OPENAI_API_KEY__" ]; then
 add_provider ' "openai": {
 "baseUrl": "https://api.openai.com/v1",
 "api": "openai-completions",
 "models": [
 { "id": "gpt-5.2", "name": "GPT-5.2", "contextWindow": 128000 },
 { "id": "gpt-5.0", "name": "GPT-5.0", "contextWindow": 128000 }
 ]
 }'
fi

if [ -n "${GEMINI_API_KEY:-}" ] && [ "${GEMINI_API_KEY}" != "__UNSET_GEMINI_API_KEY__" ]; then
 add_provider ' "google": {
 "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
 "api": "google-generative-ai",
 "models": [
 { "id": "gemini-2.5-pro", "name": "Gemini 2.5 Pro", "contextWindow": 1000000 },
 { "id": "gemini-2.5-flash", "name": "Gemini 2.5 Flash", "contextWindow": 1000000 }
 ]
 }'
fi

if [ -n "${OPENROUTER_API_KEY:-}" ] && [ "${OPENROUTER_API_KEY}" != "__UNSET_OPENROUTER_API_KEY__" ]; then
 add_provider ' "openrouter": {
 "baseUrl": "https://openrouter.ai/api/v1",
 "api": "openai-completions",
 "models": [
 { "id": "anthropic/claude-sonnet-4-5", "name": "Claude Sonnet 4.5 (OR)", "contextWindow": 200000 },
 { "id": "openai/gpt-5.2", "name": "GPT-5.2 (OR)", "contextWindow": 128000 },
 { "id": "openai/gpt-5-mini", "name": "GPT-5 Mini (OR)", "contextWindow": 128000 },
 { "id": "google/gemini-2.5-pro", "name": "Gemini 2.5 Pro (OR)", "contextWindow": 1000000 }
 ]
 }'
fi

# Fallback: if no providers configured, add anthropic as default
if [ -z "$MODELS_PROVIDERS" ]; then
 MODELS_PROVIDERS=' "anthropic": {
 "baseUrl": "https://api.anthropic.com",
 "api": "anthropic-messages",
 "models": [
 { "id": "claude-sonnet-4-5", "name": "Claude Sonnet 4.5", "contextWindow": 200000 }
 ]
 }'
fi

# Resolve memorySearch config — always use OpenRouter for embeddings (platform key)
if [ -n "${OPENROUTER_API_KEY:-}" ] && [ "${OPENROUTER_API_KEY}" != "__UNSET_OPENROUTER_API_KEY__" ]; then
 MEMORY_SEARCH_JSON='"memorySearch": { "enabled": true, "provider": "openai", "model": "text-embedding-3-small", "remote": { "baseUrl": "https://openrouter.ai/api/v1/", "apiKey": "'"${OPENROUTER_API_KEY}"'" } }'
elif [ -n "${OPENAI_API_KEY:-}" ] && [ "${OPENAI_API_KEY}" != "__UNSET_OPENAI_API_KEY__" ]; then
 MEMORY_SEARCH_JSON='"memorySearch": { "enabled": true, "provider": "openai", "model": "text-embedding-3-small" }'
else
 MEMORY_SEARCH_JSON='"memorySearch": { "enabled": true }'
fi

# OpenClaw config — security-hardened, multi-model support
cat > /opt/openclaw-data/config/openclaw.json << OCCONFIG
{
 "agents": {
 "list": [
 {
 "id": "main",
 "default": true,
 "name": "Team Lead",
 "sandbox": { "mode": "off" }
 }
 ],
 "defaults": {
 "model": { "primary": "${RESOLVED_MODEL}"${FALLBACKS_JSON} },
 "maxConcurrent": 4,
 "thinkingDefault": "low",
 "heartbeat": {
 "every": "30m",
 "target": "none",
 "directPolicy": "allow"
 },
 "sandbox": {
 "mode": "off"
 },
 "subagents": {
 "model": "${RESOLVED_MODEL}",
 "thinking": "low",
 "maxConcurrent": 8,
 "maxSpawnDepth": 3,
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
 ${MEMORY_SEARCH_JSON}
 }
 },
 "models": {
 "providers": {
${MODELS_PROVIDERS}
 }
 },
 "tools": {
 "allow": [
 "exec", "read", "write", "edit", "process",
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
 "host": "gateway",
 "notifyOnExit": true
 }
 },
 "plugins": {
 "entries": {
 "lobster": { "enabled": true },
 "llm-task": { "enabled": true },
 "acpx": { "enabled": true }
 }
 },
 "acp": {
 "enabled": true,
 "backend": "acpx",
 "defaultAgent": "claude",
 "allowedAgents": ["claude", "codex", "gemini", "opencode"],
 "maxConcurrentSessions": 3,
 "dispatch": { "enabled": true }
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
 "redactSensitive": "tools",
 "maxFileBytes": 100000000
 },
 "session": {
 "dmScope": "per-channel-peer"
 },
 "discovery": {
 "mdns": { "mode": "off" }
 },
 "channels": {
 "telegram": {
 "enabled": true,
 "streaming": "partial",
 "groupPolicy": "allowlist"
 }
 },
 "cron": {
 "enabled": true,
 "maxConcurrentRuns": 3
 },
 "gateway": {
 "mode": "local",
 "port": ${GATEWAY_PORT},
 "auth": { "mode": "token", "token": "GATEWAY_TOKEN_PLACEHOLDER" },
 "trustedProxies": ["127.0.0.1", "172.16.0.0/12", "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22"],
 "controlUi": {
 "enabled": true,
 "allowInsecureAuth": true,
 "dangerouslyAllowHostHeaderOriginFallback": true,
 "dangerouslyDisableDeviceAuth": true
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

# Docker compose override — host networking so gateway binds to loopback directly
# This ensures all connections (bridge, internal tools) come from 127.0.0.1,
# which auto-approves device pairing (no manual approval needed after restarts).
DOCKER_GID=$(getent group docker | cut -d: -f3)
cat > /opt/openclaw/docker-compose.override.yml << OVERRIDE
services:
  openclaw-gateway:
    network_mode: host
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /usr/bin/docker:/usr/bin/docker:ro
      - /opt/openclaw-data/startup.sh:/opt/startup.sh:ro
      - /opt/openclaw-data/chrome-wrapper.sh:/opt/chrome-wrapper.sh:ro
      - /var/run/openclaw:/var/run/openclaw
    group_add:
      - "${DOCKER_GID}"
    environment:
      OPENAI_API_KEY: \${OPENAI_API_KEY:-}
      ANTHROPIC_API_KEY: \${ANTHROPIC_API_KEY:-}
      GEMINI_API_KEY: \${GEMINI_API_KEY:-}
      OPENROUTER_API_KEY: \${OPENROUTER_API_KEY:-}
      MISTRAL_API_KEY: \${MISTRAL_API_KEY:-}
      BRAVE_API_KEY: \${BRAVE_API_KEY}
      CHROME_PATH: /opt/chrome-wrapper.sh
      CHROMIUM_PATH: /opt/chrome-wrapper.sh
      PUPPETEER_EXECUTABLE_PATH: /opt/chrome-wrapper.sh
      OPENCLAW_BROWSER_EXECUTABLE: /opt/chrome-wrapper.sh
      COMPOSIO_API_KEY: \${COMPOSIO_API_KEY}
    user: "0:0"
    entrypoint: ["/bin/bash", "/opt/entrypoint.sh"]
    command: ["${GATEWAY_PORT}"]
  openclaw-cli:
    profiles: ["disabled"]
OVERRIDE

# Startup script — Chrome + TigerVNC are pre-installed in the custom Docker image
# Only need: Xvnc start, permission fix, gateway start
cat > /opt/openclaw-data/startup.sh << 'STARTUP'
#!/bin/bash
GATEWAY_PORT="${1:-18789}"

# Start Xvnc on :99 for live browser view
if command -v Xvnc &>/dev/null && ! pgrep -f "Xvnc :99" >/dev/null 2>&1; then
  echo "[startup] Starting Xvnc on :99 (port 5999)..."
  Xvnc :99 -geometry 1920x1080 -depth 24 -rfbport 5999 -localhost \
    -SecurityTypes None -AlwaysShared -AcceptKeyEvents -AcceptPointerEvents &
  sleep 0.5
  echo "[startup] Xvnc started on :99"
fi

# Fix permissions: ensure node user can read config files
# NOTE: Do NOT chmod 700 or chmod 600 — the bridge runs as a different UID on the host
# and needs to traverse dirs (755) and read config files (664)
chown -R 1000:1000 /home/node/.openclaw 2>/dev/null || true
chown -R 1000:1000 /home/node/.npm 2>/dev/null || true
find /home/node/.openclaw -type d -exec chmod 755 {} \; 2>/dev/null || true
find /home/node/.openclaw -name '*.json' -exec chmod 664 {} \; 2>/dev/null || true

# Fix jiti cache permissions — Xvnc/root startup may have created files in /tmp/jiti owned by root
# which blocks the node user from loading plugins
rm -rf /tmp/jiti 2>/dev/null || true
mkdir -p /tmp/jiti && chown 1000:1000 /tmp/jiti

# Drop back to node user for the gateway process
exec su -s /bin/bash node -c "DISPLAY=:99 node dist/index.js gateway --allow-unconfigured --bind loopback --port $GATEWAY_PORT"
STARTUP
chmod +x /opt/openclaw-data/startup.sh

# Auth profiles — dynamically built from all available API keys
AUTH_PROFILES=""
AUTH_LASTGOOD=""
add_auth_profile() {
 local id="$1" provider="$2" key="$3"
 local entry
 # Anthropic OAuth tokens (sk-ant-oat-*) need type "token" with field "token", not "key"
 # Regular API keys (sk-ant-api*) use type "api_key" with field "key"
 if [ "$provider" = "anthropic" ] && echo "$key" | grep -q '^sk-ant-oat'; then
  entry="\"${id}\": { \"type\": \"token\", \"provider\": \"${provider}\", \"token\": \"${key}\" }"
 else
  entry="\"${id}\": { \"type\": \"api_key\", \"provider\": \"${provider}\", \"key\": \"${key}\" }"
 fi
 local lastgood="\"${provider}\": \"${id}\""
 if [ -z "$AUTH_PROFILES" ]; then
 AUTH_PROFILES=" $entry"
 AUTH_LASTGOOD=" $lastgood"
 else
 AUTH_PROFILES="${AUTH_PROFILES},
 $entry"
 AUTH_LASTGOOD="${AUTH_LASTGOOD},
 $lastgood"
 fi
}

if [ -n "${ANTHROPIC_API_KEY:-}" ] && [ "${ANTHROPIC_API_KEY}" != "__UNSET_ANTHROPIC_API_KEY__" ]; then
 add_auth_profile "anthropic:default" "anthropic" "${ANTHROPIC_API_KEY}"
fi
if [ -n "${OPENAI_API_KEY:-}" ] && [ "${OPENAI_API_KEY}" != "__UNSET_OPENAI_API_KEY__" ]; then
 add_auth_profile "openai:default" "openai" "${OPENAI_API_KEY}"
fi
if [ -n "${GEMINI_API_KEY:-}" ] && [ "${GEMINI_API_KEY}" != "__UNSET_GEMINI_API_KEY__" ]; then
 add_auth_profile "google:default" "google" "${GEMINI_API_KEY}"
fi
if [ -n "${OPENROUTER_API_KEY:-}" ] && [ "${OPENROUTER_API_KEY}" != "__UNSET_OPENROUTER_API_KEY__" ]; then
 add_auth_profile "openrouter:default" "openrouter" "${OPENROUTER_API_KEY}"
fi

# Fallback: if no keys, create empty profiles
if [ -z "$AUTH_PROFILES" ]; then
 AUTH_PROFILES=""
 AUTH_LASTGOOD=""
fi

cat > /opt/openclaw-data/config/agents/main/agent/auth-profiles.json << AUTHPROF
{
 "version": 1,
 "profiles": {
${AUTH_PROFILES}
 },
 "lastGood": {
${AUTH_LASTGOOD}
 }
}
AUTHPROF

# ALSO create auth-profiles.json at the root config level — Control UI reads from here
cp /opt/openclaw-data/config/agents/main/agent/auth-profiles.json /opt/openclaw-data/config/auth-profiles.json

dlog "Auth profiles configured for: $(echo "$AUTH_LASTGOOD" | grep -o '"[a-z]*"' | tr '\n' ' ' || echo 'none')"

# ── OpenClaw Workspace Bootstrap ──────────────────────────────────────
# Workspace files are pushed AFTER deploy via the bridge API (provision.js)
# This keeps the setup script small and workspace always in sync.
mkdir -p /opt/openclaw-data/workspace/memory

# Team Lead AGENTS.md — core operating rules for lead agents
cat > /opt/openclaw-data/workspace/AGENTS.md << 'AGENTSMD'
# Team Lead
You are the Team Lead. You coordinate the team, delegate tasks to SPCs, and ensure quality output.

## Lead Rules (MANDATORY)
1. **Fix errors immediately.** Don't ask. Don't wait. If something breaks, fix it now.
2. **Spawn subagents for all execution.** Never do inline work. Delegate to SPCs or spawn subagents for every task.
3. **Never force push, delete branches, or rewrite git history.** Protect the repo at all costs.
4. **Never guess config changes.** Read docs first. Backup before editing. If unsure, research — don't experiment on production.

## How You Work
- You receive tasks from CrabsHQ (mission control) via hooks
- Delegate specialized work to SPC agents using the `message` or `sessions_spawn` tools
- Monitor SPC progress and aggregate results
- Report back to mission control with deliverables
- Use `memory_search` to recall past work before starting new tasks

## Task Delegation
When you receive a task:
1. Break it into subtasks by specialty
2. Assign each subtask to the most relevant SPC
3. Monitor progress and collect results
4. Compile final deliverable and report back

## Browser & Desktop
When the user asks you to open a website, browse, or interact with a GUI, **always ask first**:
> "Want me to do this headless (faster, I'll report back), or spin it up on the virtual desktop so you can watch it live?"

### Two modes:
1. **Headless** — Use the `browser` tool normally. Faster, no GUI. You report results as text/screenshots.
2. **Live desktop** — Launch Chrome on `DISPLAY=:99` so it appears in the **Browser Live View** panel in CrabsHQ. The user can see everything in real-time.

### How live desktop works:
- The VPS has a virtual display on `:99` (Xvnc, port 5999) — this is the **Browser Live View** in CrabsHQ
- There's also a full LXQt desktop on `:1` (port 5901) — this is the **Desktop** panel in CrabsHQ
- To launch Chrome visibly: `DISPLAY=:99 google-chrome-stable --no-sandbox <url> &`
- The user sees it live in their dashboard — no VNC client needed
- **Never say you can't share the GUI** — the user CAN see it via CrabsHQ panels

### When to use which:
- Quick lookups, scraping, screenshots → headless
- Demos, debugging, "show me" requests → live desktop
- If unsure → ask the user

## Context & Memory
- **Read COMPANY.md first** — know the company, its products, its voice
- **Read CAPABILITIES.md** — model routing slots & API reference for all capabilities (image gen, video, TTS, social search, web search, etc.)
- **Read MEMORIES.md** — structured team knowledge (facts, preferences, decisions, learnings)
- **Use memory_search before starting work** — check if the team has done related work before
- **Write daily notes to memory/YYYY-MM-DD.md** — log delegations, outcomes, key decisions
AGENTSMD

# ── CAPABILITIES.md — Model routing & API reference for Lead + SPCs ──────
cat > /opt/openclaw-data/workspace/CAPABILITIES.md << 'CAPMD'
# Capabilities — Model Routing & API Reference

This file documents the AI capabilities available to ALL agents (Lead + SPCs).
When a task requires one of these capabilities, use the corresponding API via curl.
The org's `modelRouting` settings in Firestore determine which model/provider to use per slot.

## How Model Routing Works
Each org has `settings.modelRouting` with slot→model mappings. When performing a task, check
which model is assigned to the relevant slot. If unset, fall back to the default chat model.

## Capability Slots

### 💬 Chat & Reasoning (`chat`)
General conversation, task execution, code generation. This is the default model.
- Used for: all standard agent tasks, planning, writing, coding
- API: OpenRouter / Anthropic / OpenAI depending on org's configured model

### 🎨 Image Generation (`image_gen`)
Create images from text prompts.
- **OpenAI DALL-E**: `curl -X POST https://api.openai.com/v1/images/generations -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"model":"dall-e-3","prompt":"...","size":"1024x1024"}'`
- **OpenRouter (if available)**: route through OpenRouter with image model
- Use for: SPC social media posts needing visuals, marketing assets, product mockups

### 🎬 Video Generation (`video_gen`)
Generate video clippings based on prompts.
- **Runway**: `curl -X POST https://api.runwayml.com/v1/generations -H "Authorization: Bearer $KEY" -d '{"prompt":"..."}'`
- **Luma AI**: `curl -X POST https://api.lumalabs.ai/dream-machine/v1/generations -H "Authorization: Bearer $KEY" -d '{"prompt":"..."}'`
- Use for: SPC social content videos, product demos, short-form content

### 🔊 Text-to-Speech (`tts`)
Convert text to natural-sounding audio.
- **OpenAI TTS**: `curl -X POST https://api.openai.com/v1/audio/speech -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"model":"tts-1","input":"...","voice":"alloy"}' --output speech.mp3`
- **ElevenLabs**: `curl -X POST "https://api.elevenlabs.io/v1/text-to-speech/{voice_id}" -H "xi-api-key: $KEY" -H "Content-Type: application/json" -d '{"text":"...","model_id":"eleven_multilingual_v2"}'`
- Use for: podcast generation, audio content, voiceovers for video

### 🎙️ Speech-to-Text (`stt`)
Transcribe audio and voice to text.
- **OpenAI Whisper**: `curl -X POST https://api.openai.com/v1/audio/transcriptions -H "Authorization: Bearer $KEY" -F file=@audio.mp3 -F model=whisper-1`
- Use for: meeting transcription, voice note processing, audio analysis

### 🎵 Music Generation (`music_gen`)
Generate music and audio from text prompts.
- **Suno**: `curl -X POST https://api.suno.ai/v1/generations -H "Authorization: Bearer $KEY" -d '{"prompt":"...","duration":30}'`
- **Udio**: via their API when available
- Use for: SPC social content background music, jingles, brand audio

### 🔍 Social Search (`social_search`)
Search trends and what's happening on X/Twitter.
- **Twitter/X API v2**: `curl "https://api.twitter.com/2/tweets/search/recent?query=..." -H "Authorization: Bearer $TWITTER_BEARER"`
- **Twitter Trends**: `curl "https://api.twitter.com/2/trends/by/woeid/1" -H "Authorization: Bearer $TWITTER_BEARER"`
- **SocialData.tools**: `curl "https://api.socialdata.tools/twitter/search?query=..." -H "Authorization: Bearer $KEY"`
- Use for: LEADS — finding potential customers talking about relevant topics; SPC — trending content ideas, competitor monitoring, engagement opportunities

### 🌐 Web Search (`web_search`)
Search the web using AI providers.
- **Brave Search**: `curl "https://api.search.brave.com/res/v1/web/search?q=..." -H "X-Subscription-Token: $BRAVE_KEY"`
- **Perplexity (AI search)**: `curl -X POST https://api.perplexity.ai/chat/completions -H "Authorization: Bearer $KEY" -d '{"model":"sonar","messages":[{"role":"user","content":"..."}]}'`
- **Tavily**: `curl -X POST https://api.tavily.com/search -d '{"api_key":"$KEY","query":"..."}'`
- Use for: LEADS — researching companies, finding contact info, market analysis; SPC — fact-checking, competitive research, content sourcing

## Usage for SPC Tasks
- **SPC (Social Post Content)**: Use `image_gen` for post visuals, `video_gen` for reels/clips, `social_search` for trending topics & engagement, `music_gen` for audio content, `web_search` for research & sourcing
- **LEADS (Lead Generation)**: Use `social_search` to find prospects discussing relevant pain points, `web_search` to research companies & contacts, `chat` for composing outreach messages

## API Key Locations
Keys are stored in the org's Firestore doc under `keys.*` and in the VPS environment:
- `OPENAI_API_KEY` — OpenAI (DALL-E, TTS, Whisper)
- `ANTHROPIC_API_KEY` — Anthropic Claude
- `OPENROUTER_API_KEY` — OpenRouter (200+ models)
- `TWITTER_BEARER_TOKEN` — X/Twitter API
- `BRAVE_SEARCH_API_KEY` — Brave Search
- `ELEVENLABS_API_KEY` — ElevenLabs TTS
- Check org's Firestore `keys` for any additional provider keys
CAPMD

# ── Chrome wrapper with Xvnc for live browser view ───────────────────────
# Chrome wrapper: starts Xvnc so noVNC live view works, then launches Chrome.
cat > /opt/openclaw-data/chrome-wrapper.sh << 'CHROMEWRAP_BASE'
#!/bin/bash
# ── Xvnc: Virtual display + VNC server on :99 (port 5999) ──
# Xvnc provides a virtual display AND serves VNC — enabling live browser view via noVNC
if ! pgrep -f "Xvnc :99" >/dev/null 2>&1; then
 Xvnc :99 -geometry 1920x1080 -depth 24 -rfbport 5999 -localhost \
 -SecurityTypes None -AlwaysShared -AcceptKeyEvents -AcceptPointerEvents &
 sleep 0.5
fi
export DISPLAY=:99
exec /usr/bin/google-chrome-stable \
 --disable-blink-features=AutomationControlled \
 "$@"
CHROMEWRAP_BASE
chmod +x /opt/openclaw-data/chrome-wrapper.sh
# Set headless:false so OpenClaw doesn't add --headless (Chrome uses the Xvnc display)
sed -i 's|"headless": true|"headless": false|g' /opt/openclaw-data/config/openclaw.json
# Point browser config at the wrapper
sed -i 's|/usr/bin/google-chrome-stable|/opt/chrome-wrapper.sh|g' /opt/openclaw-data/config/openclaw.json



# Fix permissions: container runs as uid 1000, bridge runs as host node user
# Config dir MUST be traversable (755) so both UIDs can access files inside
chown -R 1000:1000 /opt/openclaw-data
chmod 755 /opt/openclaw-data/config
find /opt/openclaw-data/config -type d -exec chmod 755 {} \;
# Config files: readable by both container (uid 1000) and host node user
chmod 664 /opt/openclaw-data/config/openclaw.json
chmod 664 /opt/openclaw-data/config/agents/main/agent/auth-profiles.json
chmod 664 /opt/openclaw-data/config/auth-profiles.json

# Bridge runs on HOST as node (uid may differ from container's 1000).
# It needs write access to config files for API key sync, model updates, and device approval.
HOST_NODE_UID=$(id -u node 2>/dev/null || echo 1000)
if [ "$HOST_NODE_UID" != "1000" ]; then
  echo "Host node UID ($HOST_NODE_UID) differs from container (1000), setting ACLs for bridge..."
  # Make bridge-writable paths accessible to host node user
  chown "$HOST_NODE_UID" /opt/openclaw/.env 2>/dev/null || true
  chown "$HOST_NODE_UID" /opt/openclaw-data/config/openclaw.json 2>/dev/null || true
  chown "$HOST_NODE_UID" /opt/openclaw-data/config/agents/main/agent/auth-profiles.json 2>/dev/null || true
  chown "$HOST_NODE_UID" /opt/openclaw-data/config/auth-profiles.json 2>/dev/null || true
  mkdir -p /opt/openclaw-data/config/devices
  chown -R "$HOST_NODE_UID" /opt/openclaw-data/config/devices 2>/dev/null || true
  # Container still needs read access — both UIDs can read via group or mode
  chmod 666 /opt/openclaw/.env 2>/dev/null || true
  chmod 660 /opt/openclaw-data/config/openclaw.json 2>/dev/null || true
  chmod 660 /opt/openclaw-data/config/agents/main/agent/auth-profiles.json 2>/dev/null || true
  chmod 660 /opt/openclaw-data/config/auth-profiles.json 2>/dev/null || true
fi

cd /opt/openclaw

# ── Wait for background Docker image pull ─────────────────────────────
dlog "Waiting for Docker image pull to complete..."
echo "Waiting for background Docker pull (PID: ${DOCKER_PULL_PID:-none})..."
[ -n "${DOCKER_PULL_PID:-}" ] && wait $DOCKER_PULL_PID 2>/dev/null || true

# Check pull result
IMAGE_READY=false
if [ -f /tmp/docker-pull-status ]; then
 source /tmp/docker-pull-status
fi
cat "$DOCKER_PULL_LOG" 2>/dev/null || true

if [ "$IMAGE_READY" = "true" ]; then
 dlog "Docker image ready"
 echo "Image pulled and tagged as openclaw:local"
else
 dlog "Pull failed, falling back to local build..."
 echo "Pull failed, falling back to local build..."
 AVAIL_KB=$(df /var/lib/docker 2>/dev/null | tail -1 | awk '{print $4}')
 AVAIL_GB=$((${AVAIL_KB:-0} / 1024 / 1024))
 for attempt in 1 2; do
 dlog "Docker build attempt ${attempt}/2..."
 if docker build --no-cache --build-arg OPENCLAW_DOCKER_APT_PACKAGES="wget gnupg fonts-liberation fonts-noto-color-emoji" -t openclaw:local .; then
 IMAGE_READY=true
 dlog "Docker image built from source (attempt ${attempt})"
 break
 fi
 dlog "Build attempt ${attempt} failed"
 docker system prune -a -f 2>/dev/null || true
 systemctl restart docker 2>/dev/null || true
 sleep $((attempt * 5))
 done
fi

if [ "$IMAGE_READY" != "true" ]; then
 dlog "FATAL: Could not pull or build Docker image after retries" "failed"
 echo "ERROR: Failed to obtain Docker image after multiple attempts."
 exit 1
fi

dlog "Starting containers..."
# Start containers (clean up any partial state first)
run_cmd docker compose down 2>/dev/null || true
# Retry docker compose up — host network mode can fail with namespace race on first boot
for _dc_attempt in 1 2 3; do
  run_cmd docker compose up -d 2>&1 && break || true
  echo "docker compose up failed (attempt $_dc_attempt), retrying in 3s..."
  sleep 3
  run_cmd docker compose down 2>/dev/null || true
done
# Verify gateway container is actually running (CLI container failure is non-fatal)
if ! docker compose ps --format json 2>/dev/null | grep -q '"running"'; then
  echo "WARNING: gateway container may not be running, proceeding anyway"
fi
# Wait for container to be healthy before running exec commands
dlog "Waiting for container to start..."
for _cw in $(seq 1 20); do
 if docker compose ps --format json 2>/dev/null | grep -q '"running"'; then
 echo "Container running after ${_cw}s"
 break
 fi
 sleep 1
done
sleep 2

# Chrome + TigerVNC are pre-installed in the custom Docker image — no runtime install needed
# Verify they're available
docker compose exec -T openclaw-gateway bash -c '
  echo "Chrome: $(google-chrome-stable --version 2>/dev/null || echo NOT_FOUND)"
  echo "Xvnc: $(Xvnc -version 2>&1 | head -1 || echo NOT_FOUND)"
' || echo "Container exec skipped (non-fatal)"

docker image prune -f 2>/dev/null || true

# Wait for gateway to be listening before running setup/doctor
# startup.sh installs Chrome first, then starts the gateway — we must wait for both
dlog "Waiting for OpenClaw gateway to start listening..."
_gw_ready=0
for _gw_wait in $(seq 1 45); do
 if docker compose exec -T openclaw-gateway node -e "fetch('http://127.0.0.1:${GATEWAY_PORT}/',{signal:AbortSignal.timeout(3000)}).then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>/dev/null; then
 echo "Gateway ready after ${_gw_wait}s"
 _gw_ready=1
 break
 fi
 sleep 2
done
if [ "$_gw_ready" -eq 0 ]; then
 echo "WARNING: Gateway did not respond after 90s — running setup/doctor anyway"
 # Dump container logs for debugging
 docker compose logs --tail 40 openclaw-gateway 2>/dev/null || true
fi

# Run openclaw setup/doctor (use node directly — openclaw CLI is not in PATH)
docker compose exec -T -w /app openclaw-gateway node dist/index.js setup --workspace /home/node/.openclaw/workspace 2>/dev/null || true
docker compose exec -T -w /app openclaw-gateway node dist/index.js doctor --fix 2>/dev/null || true

# ── [6/9] Bridge + Sandbox + Poller (PARALLEL where possible) ─────────
# Download bridge, create poller, and start sandbox build concurrently

# Clone bridge repo (git clone always gets latest — no CDN caching issues)
dlog "Setting up Bridge..."
dlog "Cloning bridge from GitHub..."
rm -rf /opt/openclaw-bridge 2>/dev/null || true
for _dl_attempt in 1 2 3; do
 if git clone --depth 1 https://github.com/absurdfounder/openclawbridge.git /opt/openclaw-bridge; then
 dlog "Bridge cloned ($(wc -c < /opt/openclaw-bridge/index.mjs) bytes)"
 break
 fi
 dlog "Bridge clone attempt ${_dl_attempt} failed, retrying..."
 rm -rf /opt/openclaw-bridge 2>/dev/null || true
 sleep $((${_dl_attempt} * 3))
done

# Create poller stub (fast)
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

# Start 3 parallel tasks: bridge npm install, sandbox build, and poller npm + librarium
dlog "Installing bridge, sandbox, and dependencies in parallel..."

# Task 1: Bridge npm install (background)
(cd /opt/openclaw-bridge && timeout 180 npm install 2>&1 || {
 npm cache clean --force 2>/dev/null || true
 timeout 180 npm install 2>&1
}) &
BRIDGE_NPM_PID=$!

# Task 2: Sandbox base image build (background)
if [ "$FROM_SNAPSHOT" != "1" ]; then
(
 cd /opt/openclaw
 dlog "Building sandbox base image..."
 if bash scripts/sandbox-setup.sh 2>&1; then
 echo "Sandbox image built: openclaw-sandbox:bookworm-slim"
 else
 echo "WARNING: Sandbox image build failed (non-fatal)"
 fi
) &
SANDBOX_PID=$!
else
SANDBOX_PID=""
fi

# Task 3: Poller npm + librarium + noVNC (foreground — fastest)
cd /opt/openclaw-poller && timeout 120 npm install --prefer-offline 2>/dev/null || timeout 120 npm install
timeout 120 npm install -g librarium 2>&1 || {
 dlog "librarium install failed (non-fatal, deep research will be unavailable)"
}

if [ "$FROM_SNAPSHOT" != "1" ]; then
# noVNC + websockify — enables live browser streaming for all orgs
dlog "Installing noVNC + websockify for live browser streaming..."
run_cmd apt-get install -y -qq --no-install-recommends novnc websockify 2>/dev/null || true
echo "[setup] noVNC + websockify installed for VNC live view"

# Custom embedded VNC page — no toolbar, no CtrlAltDel, clean iframe embed
cat > /usr/share/novnc/vnc_embed.html << 'VNCEMBED'
<!DOCTYPE html>
<html lang="en">
<head>
    <title>CrabsHQ Desktop</title>
    <meta charset="utf-8">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        html, body { height: 100%; overflow: hidden; background: #1a1a1a; }
        #screen { width: 100%; height: 100%; }
        #status {
            position: fixed; top: 0; left: 0; right: 0;
            text-align: center; padding: 8px;
            font: 12px/1 -apple-system, sans-serif;
            color: #999; background: rgba(0,0,0,0.7);
            z-index: 10; transition: opacity 0.5s;
        }
        #status.connected { opacity: 0; pointer-events: none; }
    </style>
    <script type="module" crossorigin="anonymous">
        import RFB from './core/rfb.js';
        const statusEl = document.getElementById('status');
        function readParam(name, def) {
            const m = document.location.href.concat(location.hash).match(new RegExp('.*[?&]' + name + '=([^&#]*)'));
            return m ? decodeURIComponent(m[1]) : def;
        }
        statusEl.textContent = 'Connecting...';
        const host = readParam('host', location.hostname);
        const port = readParam('port', location.port);
        const path = readParam('path', 'websockify');
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const url = proto + '://' + host + (port ? ':' + port : '') + '/' + path;
        const rfb = new RFB(document.getElementById('screen'), url, {
            credentials: { password: readParam('password', '') }
        });
        rfb.addEventListener('connect', () => { statusEl.classList.add('connected'); });
        rfb.addEventListener('disconnect', (e) => {
            statusEl.classList.remove('connected');
            statusEl.textContent = e.detail.clean ? 'Disconnected' : 'Connection lost';
        });
        rfb.addEventListener('credentialsrequired', () => { statusEl.textContent = 'Password required'; });
        rfb.scaleViewport = readParam('scale', false);
        rfb.resizeSession = readParam('resize', false);
        rfb.viewOnly = readParam('view_only', false);
    </script>
</head>
<body>
    <div id="status">Loading</div>
    <div id="screen"></div>
</body>
</html>
VNCEMBED

# ── Desktop (LXQt) setup — manual use via CrabsHQ Desktop panel ──────────────
dlog "Installing desktop packages (LXQt, x11vnc, apps)..."
run_cmd apt-get install -y -qq --no-install-recommends \
 xvfb xorg openbox x11vnc xterm xdotool \
 lxqt-core lxqt-panel lxqt-runner \
 pcmanfm-qt feh papirus-icon-theme \
 fonts-dejavu fonts-liberation \
 xdg-utils wget 2>/dev/null || true
# Install snap Firefox (Ubuntu 24.04 doesn't have firefox-esr deb)
run_cmd snap install firefox 2>/dev/null || true
echo "[setup] LXQt desktop packages installed"
fi # end FROM_SNAPSHOT != 1 (noVNC + desktop packages)

# Pre-seed LXQt session config (openbox as WM, skip first-run dialog)
mkdir -p /root/.config/lxqt
printf '[General]\n__userfile__=true\nwindow_manager=openbox\n' > /root/.config/lxqt/session.conf
echo "[setup] LXQt session config pre-seeded (openbox WM)"

# Desktop start script — called by control API
cat > /usr/local/bin/crabhq-desktop-start << 'DSTART'
#!/bin/bash
# Start LXQt on display :1 + x11vnc + websockify on port 6081
# Display :99 is reserved for AI browser live view

# Required for dbus-run-session
export XDG_RUNTIME_DIR=/tmp/runtime-root
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

# Start Xvfb on display :1
if ! pgrep -f 'Xvfb :1' > /dev/null 2>&1; then
 nohup Xvfb :1 -screen 0 1280x800x24 > /var/log/xvfb.log 2>&1 &
 sleep 2
fi

export DISPLAY=:1

# Pre-seed LXQt config
mkdir -p /root/.config/lxqt
printf '[General]\n__userfile__=true\nwindow_manager=openbox\n' > /root/.config/lxqt/session.conf

# Start openbox first (WM must run before lxqt-session, no --display flag)
if ! pgrep -f 'openbox' > /dev/null 2>&1; then
 nohup openbox > /var/log/openbox.log 2>&1 &
 sleep 2
fi

# Start LXQt session (openbox already running, skips WM dialog)
if ! pgrep -f 'lxqt-session' > /dev/null 2>&1; then
 nohup dbus-run-session lxqt-session > /var/log/lxqt.log 2>&1 &
 sleep 3
fi

# Explicitly start lxqt-panel (autostart unreliable in headless env)
if ! pgrep -f 'lxqt-panel' > /dev/null 2>&1; then
 nohup lxqt-panel > /var/log/lxqt-panel.log 2>&1 &
 sleep 1
fi

# Start x11vnc on display :1, port 5901
if ! pgrep -f 'x11vnc.*5901' > /dev/null 2>&1; then
 nohup x11vnc -display :1 -forever -nopw -shared -rfbport 5901 \
 -o /var/log/x11vnc-desktop.log -quiet > /dev/null 2>&1 &
 sleep 1
fi

# Set wallpaper
feh --bg-fill /usr/local/share/crabhq-wallpaper.jpg 2>/dev/null || true

# Start pcmanfm-qt in desktop mode (shows icons)
if ! pgrep -f 'pcmanfm-qt --desktop' > /dev/null 2>&1; then
 nohup pcmanfm-qt --desktop > /var/log/pcmanfm-desktop.log 2>&1 &
 sleep 1
fi

# Start websockify bridging port 6081 → VNC 5901
if ! pgrep -f "websockify.*6081" > /dev/null 2>&1; then
 nohup websockify --web=/usr/share/novnc 6081 localhost:5901 \
 > /var/log/websockify-desktop.log 2>&1 &
fi

systemctl start crabhq-agent-daemon 2>/dev/null || true

echo 'Desktop started on :1, noVNC on port 6081'
DSTART
chmod +x /usr/local/bin/crabhq-desktop-start

# Desktop stop script
cat > /usr/local/bin/crabhq-desktop-stop << 'DSTOP'
#!/bin/bash
systemctl stop crabhq-agent-daemon 2>/dev/null || true
pkill -f "websockify.*6081" 2>/dev/null || true
pkill -f "x11vnc.*5901" 2>/dev/null || true
pkill -f "lxqt-session" 2>/dev/null || true
pkill -f "Xorg :1" 2>/dev/null || true
echo "Desktop stopped"
DSTOP
chmod +x /usr/local/bin/crabhq-desktop-stop

# Desktop control API — Node.js HTTP server on port 4567
mkdir -p /opt/crabhq-desktop-api
cat > /opt/crabhq-desktop-api/server.mjs << 'JSEOF'
import http from 'http';
import { exec } from 'child_process';
import { readFileSync } from 'fs';

const PORT = 4567;
const TOKEN_FILE = '/tmp/playwright-ws-token';
const GATEWAY_URL = process.env.GATEWAY_URL || '';

const run = (cmd) => new Promise((res, rej) =>
 exec(cmd, (err, out) => err ? rej(err.message) : res(out.trim()))
);
const running = (pat) => new Promise(res =>
 exec(`pgrep -f "${pat}"`, err => res(!err))
);

http.createServer(async (req, res) => {
 res.setHeader('Content-Type', 'application/json');
 res.setHeader('Access-Control-Allow-Origin', '*');
 const url = new URL(req.url, `http://localhost`);
 try {
 if (req.method === 'POST' && url.pathname === '/desktop/start') {
 await run('/usr/local/bin/crabhq-desktop-start');
 res.end(JSON.stringify({ ok: true }));
 } else if (req.method === 'POST' && url.pathname === '/desktop/stop') {
 await run('/usr/local/bin/crabhq-desktop-stop');
 res.end(JSON.stringify({ ok: true }));
 } else if (req.method === 'GET' && url.pathname === '/desktop/status') {
 const [novnc, vnc, lxqt] = await Promise.all([
 running('websockify.*6081'),
 running('x11vnc.*5901'),
 running('lxqt-session'),
 ]);
 res.end(JSON.stringify({ active: novnc && vnc, novnc, vnc, lxqt }));
 } else if (req.method === 'GET' && url.pathname === '/browser/endpoint') {
 try {
 const token = readFileSync(TOKEN_FILE, 'utf8').trim();
 const wsUrl = `${GATEWAY_URL.replace('https://', 'wss://')}/playwright-ws/${token}`;
 res.end(JSON.stringify({ wsEndpoint: wsUrl, ready: true }));
 } catch {
 res.writeHead(503);
 res.end(JSON.stringify({ ready: false, error: 'Playwright server not ready' }));
 }
 } else {
 res.writeHead(404);
 res.end(JSON.stringify({ error: 'not found' }));
 }
 } catch (err) {
 res.writeHead(500);
 res.end(JSON.stringify({ error: String(err) }));
 }
}).listen(PORT, '0.0.0.0', () => console.log(`[desktop-api] :${PORT}`));
JSEOF
echo "[setup] Desktop control API written"

# Agent Daemon — Unix socket server for desktop exec (OpenClaw native integration)
mkdir -p /opt/crabhq-agent-daemon
curl -fsSL "https://raw.githubusercontent.com/absurdfounder/openclawbridge/main/agent-daemon.mjs" -o /opt/crabhq-agent-daemon/agent-daemon.mjs 2>/dev/null || true
if [ -s /opt/crabhq-agent-daemon/agent-daemon.mjs ]; then
  chmod +x /opt/crabhq-agent-daemon/agent-daemon.mjs
  cat > /etc/systemd/system/crabhq-agent-daemon.service << 'AGENTDAEMON'
[Unit]
Description=CrabsHQ Agent Daemon (desktop exec)
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/crabhq-agent-daemon/agent-daemon.mjs
Environment=WORKSPACE_DIR=/opt/openclaw-data/workspace
Environment=AGENT_DAEMON_SOCKET=/var/run/openclaw/agent-daemon.sock
Environment=DISPLAY=:1
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
AGENTDAEMON
  systemctl enable crabhq-agent-daemon
  echo "[setup] Agent Daemon installed"
fi

# Install Playwright for VPS browser server
if [ "$FROM_SNAPSHOT" != "1" ]; then
cd /opt/crabhq-desktop-api
npm init -y 2>/dev/null
npm install playwright 2>/dev/null || true
echo "[setup] Playwright installed"
fi # end FROM_SNAPSHOT != 1 (Playwright)

# Playwright browser server — launches Chromium on :1, exposes WS for Render backend
cat > /opt/crabhq-desktop-api/playwright-server.mjs << 'PWEOF'
import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

const PORT = 3333;
const TOKEN_FILE = '/tmp/playwright-ws-token';
let retryCount = 0;

async function startServer() {
 try {
 const server = await chromium.launchServer({
 headless: false,
 executablePath: '/usr/bin/chromium-browser',
 args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1280,800'],
 env: { ...process.env, DISPLAY: ':1', XAUTHORITY: '/root/.Xauthority' },
 port: PORT,
 });
 const token = server.wsEndpoint().split('/').pop();
 writeFileSync(TOKEN_FILE, token, 'utf8');
 console.log(`[playwright-server] Ready — token: ${token}`);
 retryCount = 0;
 server.process().on('exit', () => {
 console.log('[playwright-server] Chromium exited, restarting in 3s...');
 setTimeout(startServer, 3000);
 });
 } catch (err) {
 retryCount++;
 const delay = Math.min(retryCount * 2000, 30000);
 console.error(`[playwright-server] Failed (attempt ${retryCount}): ${err.message}`);
 setTimeout(startServer, delay);
 }
}
startServer();
PWEOF
echo "[setup] Playwright server script written"

# Download wallpaper
mkdir -p /usr/local/share
wget -q 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=1280&h=800&fit=crop' \
 -O /usr/local/share/crabhq-wallpaper.jpg 2>/dev/null || true

# Configure pcmanfm-qt desktop (wallpaper + single-click + Papirus icons)
mkdir -p /root/.config/pcmanfm-qt/default
cat > /root/.config/pcmanfm-qt/default/settings.conf << 'PCMANCONF'
[Behavior]
SingleClick=true
QuickExec=true

[Desktop]
Wallpaper=/usr/local/share/crabhq-wallpaper.jpg
WallpaperMode=zoom
DesktopIconSize=48
FgColor=#ffffff
ShadowColor=#000000
WorkAreaMargins=12, 12, 12, 12

[System]
FallbackIconThemeName=Papirus
Terminal=xterm
PCMANCONF

# Desktop icons
mkdir -p /root/Desktop
cat > /root/Desktop/firefox.desktop << 'EOF'
[Desktop Entry]
Version=1.0
Type=Application
Name=Firefox
Exec=/snap/bin/firefox
Icon=firefox-bin
Terminal=false
EOF
cat > /root/Desktop/files.desktop << 'EOF'
[Desktop Entry]
Version=1.0
Type=Application
Name=Files
Exec=pcmanfm-qt
Icon=system-file-manager
Terminal=false
EOF
cat > /root/Desktop/terminal.desktop << 'EOF'
[Desktop Entry]
Version=1.0
Type=Application
Name=Terminal
Exec=xterm
Icon=utilities-terminal
Terminal=false
EOF
chmod +x /root/Desktop/*.desktop

# Openbox right-click menu
mkdir -p /root/.config/openbox
cat > /root/.config/openbox/menu.xml << 'EOF'
 
 
 
 /snap/bin/firefox 
 pcmanfm-qt 
 xterm 
 
 
 
 
EOF

# Hide noVNC sidebar by default (inject <style> after <head> tag)
sed -i '/<head>/a <style>#noVNC_control_bar_anchor { display: none !important; }</style>' \
 /usr/share/novnc/vnc.html 2>/dev/null || true

echo "[setup] Desktop UI configured (wallpaper, icons, menu, noVNC sidebar hidden)"

# Wait for parallel tasks to complete
dlog "Waiting for bridge npm install..."
wait $BRIDGE_NPM_PID 2>/dev/null || {
 dlog "Bridge npm install may have failed, retrying..."
 cd /opt/openclaw-bridge && npm cache clean --force 2>/dev/null; timeout 180 npm install 2>&1
}
dlog "Waiting for sandbox build..."
[ -n "${SANDBOX_PID:-}" ] && wait $SANDBOX_PID 2>/dev/null || true

cd /opt/openclaw

# ── [8/9] Systemd services ──────────────────────────────────────────

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
After=network.target openclaw-docker.service
Requires=openclaw-docker.service

[Service]
Type=simple
User=node
Group=node
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
Environment=BROWSERBASE_API_KEY=${BROWSERBASE_API_KEY}
Environment=BROWSERBASE_PROJECT_ID=${BROWSERBASE_PROJECT_ID}

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
Environment=OPENCLAW_MODEL=${RESOLVED_MODEL}
Environment=POLL_INTERVAL=3000
Environment=REQUEST_TIMEOUT=180000
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
PSVC

# Websockify service — bridges noVNC WebSocket to Xvnc inside the container
# Xvnc runs inside the container on :99 (port 5999), websockify exposes it via WebSocket on 6080
cat > /etc/systemd/system/openclaw-vnc.service << VNCSVC
[Unit]
Description=noVNC Websockify (browser live view)
After=docker.service openclaw-docker.service
Requires=docker.service

[Service]
Type=simple
ExecStart=/usr/bin/websockify --web=/usr/share/novnc 6080 localhost:5999
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
VNCSVC

# ── Pre-approve bridge device BEFORE starting any services ──────────
# Generate identity + paired.json first, so bridge connects on first start (no restarts needed)
echo "Pre-generating bridge device identity and approving in gateway config..."
mkdir -p /opt/openclaw-data/config/devices /opt/openclaw-bridge

node -e "
const crypto = require('crypto');
const fs = require('fs');
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).slice(-32);
const deviceId = crypto.createHash('sha256').update(pubRaw).digest('hex');
const identity = { version: 1, deviceId, publicKeyPem, privateKeyPem, createdAtMs: Date.now() };
fs.writeFileSync('/opt/openclaw-bridge/device-identity.json', JSON.stringify(identity, null, 2), { mode: 0o600 });
const pubB64 = pubRaw.toString('base64url');
// Also generate the gateway's own identity so we can pre-pair it
const gw = crypto.generateKeyPairSync('ed25519');
const gwPubPem = gw.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const gwPrivPem = gw.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const gwPubRaw = gw.publicKey.export({ type: 'spki', format: 'der' }).slice(-32);
const gwDeviceId = crypto.createHash('sha256').update(gwPubRaw).digest('hex');
const gwPubB64 = gwPubRaw.toString('base64url');
const gwIdentity = { version: 1, deviceId: gwDeviceId, publicKeyPem: gwPubPem, privateKeyPem: gwPrivPem, createdAtMs: Date.now() };
fs.mkdirSync('/opt/openclaw-data/config/identity', { recursive: true });
fs.writeFileSync('/opt/openclaw-data/config/identity/device.json', JSON.stringify(gwIdentity, null, 2));
console.log('Gateway identity: ' + gwDeviceId.substring(0, 12) + '...');

const paired = {};
paired[deviceId] = {
 deviceId, publicKey: pubB64,
 displayName: 'CrabsHQ Bridge', platform: 'linux',
 role: 'operator', roles: ['operator'], scopes: ['operator.admin'],
 clientId: 'gateway-client', clientMode: 'backend',
 approvedAt: Date.now(), approved: true, ts: Date.now()
};
paired[gwDeviceId] = {
 deviceId: gwDeviceId, publicKey: gwPubB64,
 displayName: 'Gateway Internal', platform: 'linux',
 role: 'operator', roles: ['operator'], scopes: ['operator.admin'],
 clientId: 'gateway-internal', clientMode: 'backend',
 approvedAt: Date.now(), approved: true, ts: Date.now()
};
fs.writeFileSync('/opt/openclaw-data/config/devices/paired.json', JSON.stringify(paired, null, 2));
fs.writeFileSync('/opt/openclaw-data/config/devices/pending.json', '{}');
console.log('Pre-approved 2 devices: bridge + gateway internal');
"

# Fix ownership — Docker runs as uid 1000, files were created by root
chown -R 1000:1000 /opt/openclaw-data
# ALL directories under config MUST be traversable (755) so both container (uid 1000)
# and host bridge (uid varies) can access files. chown -R resets dir perms to 700.
find /opt/openclaw-data/config -type d -exec chmod 755 {} \;
# Config files need to be readable by both UIDs
chmod 664 /opt/openclaw-data/config/openclaw.json /opt/openclaw-data/config/agents/main/agent/auth-profiles.json /opt/openclaw-data/config/auth-profiles.json 2>/dev/null || true
HOST_NODE_UID=$(id -u node 2>/dev/null || echo 1000)
if [ "$HOST_NODE_UID" != "1000" ]; then
  # Host node user needs write access for bridge API key sync, model updates
  chown "$HOST_NODE_UID" /opt/openclaw/.env /opt/openclaw-data/config/openclaw.json /opt/openclaw-data/config/agents/main/agent/auth-profiles.json /opt/openclaw-data/config/auth-profiles.json 2>/dev/null || true
  mkdir -p /opt/openclaw-data/config/devices && chown -R "$HOST_NODE_UID" /opt/openclaw-data/config/devices 2>/dev/null || true
fi

# CRITICAL: chown bridge identity AFTER creation (was written by root above, node user must be able to read it)
# Without this the bridge can't read its own identity and generates a NEW random one that doesn't match paired.json
chown node:node /opt/openclaw-bridge/device-identity.json 2>/dev/null || chown 1000:1000 /opt/openclaw-bridge/device-identity.json 2>/dev/null || true
chmod 600 /opt/openclaw-bridge/device-identity.json 2>/dev/null || true

# Desktop Control API service (port 4567)
# Desktop environment service (display :1 — LXQt + x11vnc + websockify:6081)
cat > /etc/systemd/system/crabhq-desktop.service << 'DESKSVC'
[Unit]
Description=CrabsHQ Desktop Environment (display :1)
After=network.target

[Service]
Type=forking
ExecStart=/usr/local/bin/crabhq-desktop-start
ExecStop=/usr/local/bin/crabhq-desktop-stop
RemainAfterExit=yes
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
DESKSVC

# Desktop Control API service (port 4567)
cat > /etc/systemd/system/crabhq-desktop-api.service << DAPI
[Unit]
Description=CrabsHQ Desktop Control API
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/crabhq-desktop-api/server.mjs
Environment=GATEWAY_URL=https://${HTTPS_DOMAIN}
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
DAPI

# Playwright browser server service (port 3333)
cat > /etc/systemd/system/crabhq-playwright.service << 'PWSVC'
[Unit]
Description=CrabHQ Playwright Browser Server
After=network.target crabhq-desktop-api.service

[Service]
Type=simple
ExecStart=/usr/bin/node /opt/crabhq-desktop-api/playwright-server.mjs
WorkingDirectory=/opt/crabhq-desktop-api
Environment=DISPLAY=:1
Environment=XAUTHORITY=/root/.Xauthority
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
PWSVC

run_cmd systemctl daemon-reload
run_cmd systemctl enable openclaw-docker openclaw-bridge openclaw-poller openclaw-vnc crabhq-desktop crabhq-desktop-api crabhq-playwright

# ── [9/9] Start all services (single clean startup) ──────────────────
dlog "Starting services..."
# Kill the temporary log server so the real bridge can use the port
kill $LOG_SERVER_PID 2>/dev/null; sleep 1

# Start bridge immediately — binds in ~5s, minimizes log gap (provision.js polls port 3002)
run_cmd systemctl start openclaw-bridge

# Start docker containers
run_cmd systemctl start openclaw-docker

# Wait for gateway to be ready — up to 3 minutes (acpx plugin install on first boot takes ~2min)
dlog "Waiting for OpenClaw gateway (up to 3 min for first boot acpx install)..."
_gw_alive=0
for i in $(seq 1 90); do
 if curl -sf --max-time 2 http://127.0.0.1:${GATEWAY_PORT}/ >/dev/null 2>&1; then
 echo "Gateway: ALIVE (ready after $((i * 2))s)"
 _gw_alive=1
 break
 fi
 sleep 2
done
if [ "$_gw_alive" -eq 0 ]; then
 echo "WARNING: Gateway did not respond after 180s"
 docker compose logs --tail 20 openclaw-gateway 2>/dev/null || true
fi

# Start poller, VNC, desktop API, playwright (bridge already running)
run_cmd systemctl start openclaw-poller
run_cmd systemctl start openclaw-vnc
run_cmd systemctl start crabhq-desktop
run_cmd systemctl start crabhq-desktop-api
run_cmd systemctl start crabhq-playwright
run_cmd systemctl restart caddy 2>/dev/null || true

# Brief settle time, then verify
sleep 3

# ── Verify ──
if docker ps | grep -q openclaw; then echo "Container: UP"; else echo "Container: DOWN"; docker ps -a; fi

if curl -s http://127.0.0.1:${BRIDGE_PORT}/health | grep -q ok; then
 echo "Bridge: HEALTHY"
else
 echo "Bridge: NOT HEALTHY (may need a few more seconds)"
fi

if systemctl is-active --quiet openclaw-poller; then
 echo "Poller: RUNNING"
else
 echo "Poller: NOT RUNNING"
 journalctl -u openclaw-poller --no-pager -n 10
fi

if systemctl is-active --quiet caddy; then
 echo "Caddy: RUNNING (HTTPS via ${HTTPS_DOMAIN:-unknown})"
else
 echo "Caddy: NOT RUNNING"
 journalctl -u caddy --no-pager -n 10
fi

# Kill the background raw log pusher — setup is done, no need to keep POSTing to API
if [ -n "${RAW_LOG_PUSHER_PID:-}" ]; then
  kill "$RAW_LOG_PUSHER_PID" 2>/dev/null || true
  echo "Raw log pusher stopped (PID $RAW_LOG_PUSHER_PID)"
fi

# Signal to bridge that setup is complete (bridge /health transitions from 'installing' → 'ok')
# /tmp marker is ephemeral; /opt marker persists across reboots
touch /tmp/openclaw-setup-complete
touch /opt/openclaw-bridge/.setup-complete

echo done
