#!/bin/bash
# Setup OpenClaw + Bridge + Poller on a fresh Ubuntu 24.04 VPS
# Works in two modes:
#   1. Cloud-init (Trooper Cloud): Template vars replaced by provision.js via sed
#   2. Self-hosted: User exports env vars before running the script
# Template variables are only used if the env var is NOT already set.

set -e

trap 'EXIT_CODE=$?; FAIL_LINE=$LINENO; dlog "Setup failed at line ${FAIL_LINE} (exit ${EXIT_CODE}). Disk: $(df -h /var/lib/docker 2>/dev/null | tail -1 | awk "{print \$4}") free. Docker: $(docker ps -q 2>/dev/null | wc -l) containers." "failed"; exit ${EXIT_CODE}' ERR

# Use env vars if set, otherwise fall back to template placeholders (for cloud-init mode).
# Avoid bash ${VAR:-{{PLACEHOLDER}}} because the trailing braces leak into the value.
_resolve_input() {
  local current_value="$1"
  local template_value="$2"
  if [ -n "$current_value" ]; then
    printf '%s' "$current_value"
  else
    printf '%s' "$template_value"
  fi
}

# Template placeholders like {{GATEWAY_TOKEN}} are replaced by provision.js via sed.
GATEWAY_TOKEN="$(_resolve_input "${GATEWAY_TOKEN:-}" "{{GATEWAY_TOKEN}}")"
OPENAI_API_KEY="$(_resolve_input "${OPENAI_API_KEY:-}" "{{OPENAI_API_KEY}}")"
OPENAI_CODEX_AUTH_PROFILE_B64="$(_resolve_input "${OPENAI_CODEX_AUTH_PROFILE_B64:-}" "{{OPENAI_CODEX_AUTH_PROFILE_B64}}")"
ANTHROPIC_API_KEY="$(_resolve_input "${ANTHROPIC_API_KEY:-}" "{{ANTHROPIC_API_KEY}}")"
GEMINI_API_KEY="$(_resolve_input "${GEMINI_API_KEY:-}" "{{GEMINI_API_KEY}}")"
OPENROUTER_API_KEY="$(_resolve_input "${OPENROUTER_API_KEY:-}" "{{OPENROUTER_API_KEY}}")"
BRAVE_API_KEY="$(_resolve_input "${BRAVE_API_KEY:-}" "{{BRAVE_API_KEY}}")"
BRIDGE_PORT="$(_resolve_input "${BRIDGE_PORT:-}" "{{BRIDGE_PORT}}")"
ORG_ID="$(_resolve_input "${ORG_ID:-}" "{{ORG_ID}}")"
SSH_PUBKEY="$(_resolve_input "${SSH_PUBKEY:-}" "{{SSH_PUBKEY}}")"
OPENCLAW_DOCKER_IMAGE="$(_resolve_input "${OPENCLAW_DOCKER_IMAGE:-}" "{{OPENCLAW_DOCKER_IMAGE}}")"
BRIDGE_AUTH_TOKEN="$(_resolve_input "${BRIDGE_AUTH_TOKEN:-}" "{{BRIDGE_AUTH_TOKEN}}")"
GATEWAY_PORT=18789
MEDIA_PORT=18791
API_URL="$(_resolve_input "${API_URL:-}" "{{API_URL}}")"
COMPOSIO_API_KEY="$(_resolve_input "${COMPOSIO_API_KEY:-}" "{{COMPOSIO_API_KEY}}")"
CF_API_TOKEN="$(_resolve_input "${CF_API_TOKEN:-}" "{{CF_API_TOKEN}}")"
PRIMARY_PROVIDER="$(_resolve_input "${PRIMARY_PROVIDER:-}" "{{PRIMARY_PROVIDER}}")"
PRIMARY_MODEL="$(_resolve_input "${PRIMARY_MODEL:-}" "{{PRIMARY_MODEL}}")"
BROWSERBASE_API_KEY="$(_resolve_input "${BROWSERBASE_API_KEY:-}" "{{BROWSERBASE_API_KEY}}")"
BROWSERBASE_PROJECT_ID="$(_resolve_input "${BROWSERBASE_PROJECT_ID:-}" "{{BROWSERBASE_PROJECT_ID}}")"
RUNTIME_AUTH_SECRET="$(_resolve_input "${RUNTIME_AUTH_SECRET:-}" "{{RUNTIME_AUTH_SECRET}}")"
TROOPER_RUNTIME_TARBALL_URL="$(_resolve_input "${TROOPER_RUNTIME_TARBALL_URL:-}" "{{TROOPER_RUNTIME_TARBALL_URL}}")"
TROOPER_RUNTIME_PORT=3101
TROOPER_RUNTIME_DATA_DIR=/var/lib/trooper-org-runtime

# Defaults must be applied before validation. Snapshot-builder bootstrap may
# omit optional values, but BRIDGE_PORT is required by the early log server.
if [ -z "$OPENCLAW_DOCKER_IMAGE" ] || echo "$OPENCLAW_DOCKER_IMAGE" | grep -q '{{.*}}'; then
  OPENCLAW_DOCKER_IMAGE="ghcr.io/absurdfounder/trooper-gateway:latest"
fi
if [ -z "$BRIDGE_PORT" ] || echo "$BRIDGE_PORT" | grep -q '{{.*}}'; then
  BRIDGE_PORT="3002"
fi

# Input validation — fail fast if critical vars are missing or still have template placeholders
_validate_var() {
  local name="$1" value="$2" required="$3"
  if [ "$required" = "required" ]; then
    if [ -z "$value" ] || echo "$value" | grep -q '{{.*}}'; then
      echo "FATAL: $name is required but not set. Export it before running this script."
      echo "  Example: export $name='your-value'"
      exit 1
    fi
  else
    # Optional: clear template placeholder if not replaced
    if echo "$value" | grep -q '{{.*}}'; then
      eval "$name=''"
    fi
  fi
}
_validate_var GATEWAY_TOKEN "$GATEWAY_TOKEN" required
_validate_var ORG_ID "$ORG_ID" required
_validate_var BRIDGE_PORT "$BRIDGE_PORT" required
_validate_var BRIDGE_AUTH_TOKEN "$BRIDGE_AUTH_TOKEN" optional
_validate_var API_URL "$API_URL" optional
_validate_var OPENAI_API_KEY "$OPENAI_API_KEY" optional
_validate_var OPENAI_CODEX_AUTH_PROFILE_B64 "$OPENAI_CODEX_AUTH_PROFILE_B64" optional
_validate_var ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY" optional
_validate_var GEMINI_API_KEY "$GEMINI_API_KEY" optional
_validate_var OPENROUTER_API_KEY "$OPENROUTER_API_KEY" optional
_validate_var BRAVE_API_KEY "$BRAVE_API_KEY" optional
_validate_var SSH_PUBKEY "$SSH_PUBKEY" optional
_validate_var OPENCLAW_DOCKER_IMAGE "$OPENCLAW_DOCKER_IMAGE" optional
_validate_var CF_API_TOKEN "$CF_API_TOKEN" optional
_validate_var COMPOSIO_API_KEY "$COMPOSIO_API_KEY" optional
_validate_var PRIMARY_PROVIDER "$PRIMARY_PROVIDER" optional
_validate_var PRIMARY_MODEL "$PRIMARY_MODEL" optional
_validate_var RUNTIME_AUTH_SECRET "$RUNTIME_AUTH_SECRET" optional
_validate_var TROOPER_RUNTIME_TARBALL_URL "$TROOPER_RUNTIME_TARBALL_URL" optional

PLATFORM_API_URL="${API_URL:-https://trooper-production.up.railway.app}"

# Detect if booting from a pre-built snapshot (skip heavy installs)
FROM_SNAPSHOT="${TROOPER_FROM_SNAPSHOT:-0}"

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
 # Also POST directly to Render API for instant visibility in the frontend.
 # Use resolved env/template values here so env-only installs still stream logs.
 if [ -n "${API_URL:-}" ] && [ -n "${ORG_ID:-}" ] && [ -n "${GATEWAY_TOKEN:-}" ]; then
 local _payload=''
 _payload=$(LOG_MSG="$msg" LOG_STEP="$step" GATEWAY_TOKEN="$GATEWAY_TOKEN" python3 -c 'import json, os; print(json.dumps({"msg": os.environ.get("LOG_MSG", ""), "step": os.environ.get("LOG_STEP", "installing"), "token": os.environ.get("GATEWAY_TOKEN", "")}))' 2>/dev/null) || _payload=''
 if [ -n "$_payload" ]; then
 curl -sf -X POST "${API_URL}/api/deploy-log/${ORG_ID}" \
 -H "Content-Type: application/json" \
 -d "$_payload" \
 --max-time 3 >/dev/null 2>&1 &
 fi
 fi
}

# Capture all script output to raw log (apt-get, docker, etc.) — served via /deploy-logs-raw
exec 1> >(tee -a "$DEPLOY_RAW_LOG") 2>&1

# Background raw log pusher — POSTs tail of raw log to API every 5s
# This bypasses the need for inbound VPS connectivity on port 3002
if [ -n "${API_URL:-}" ] && [ -n "${ORG_ID:-}" ] && [ -n "${GATEWAY_TOKEN:-}" ]; then
  (while true; do
    sleep 5
    [ -s "$DEPLOY_RAW_LOG" ] || continue
    _raw_payload=$(RAW_LOG_TAIL="$(tail -c 50000 "$DEPLOY_RAW_LOG" 2>/dev/null)" GATEWAY_TOKEN="$GATEWAY_TOKEN" python3 -c 'import json, os; print(json.dumps({"msg": "_rawlog_sync", "step": "installing", "token": os.environ.get("GATEWAY_TOKEN", ""), "rawLog": os.environ.get("RAW_LOG_TAIL", "")}))' 2>/dev/null) || continue
    curl -sf -X POST "${API_URL}/api/deploy-log/${ORG_ID}" \
      -H "Content-Type: application/json" \
      -d "$_raw_payload" \
      --max-time 10 >/dev/null 2>&1 || true
  done) &
  RAW_LOG_PUSHER_PID=$!
fi

# Snapshot images may boot previously-enabled services before cloud-init runs.
# Stop them before re-rendering per-org config so old ports/processes do not
# race the temporary progress server or final service startup.
_free_progress_port() {
  local port="$1"
  if ! command -v ss >/dev/null 2>&1; then
    return 0
  fi
  local pids
  pids=$(ss -ltnp "sport = :${port}" 2>/dev/null | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | sort -u)
  if [ -z "$pids" ]; then
    return 0
  fi
  for pid in $pids; do
    [ "$pid" = "$$" ] && continue
    echo "[setup] Stopping stale process on port ${port} (pid ${pid})"
    kill "$pid" 2>/dev/null || true
  done
  sleep 1
  pids=$(ss -ltnp "sport = :${port}" 2>/dev/null | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | sort -u)
  for pid in $pids; do
    [ "$pid" = "$$" ] && continue
    echo "[setup] Force-stopping stale process on port ${port} (pid ${pid})"
    kill -9 "$pid" 2>/dev/null || true
  done
}

if [ "$FROM_SNAPSHOT" = "1" ]; then
  systemctl stop openclaw-bridge trooper-org-runtime trooper-server openclaw-poller openclaw-vnc trooper-desktop trooper-desktop-api trooper-playwright 2>/dev/null || true
  _free_progress_port "${BRIDGE_PORT}"
fi

# Start a tiny HTTP server to serve deploy logs on BRIDGE_PORT.
# The real bridge will replace this later. If a baked service still owns the
# port, skip the temporary server rather than failing the whole setup.
python3 -c "
import http.server, json, os, sys
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
try:
  s=http.server.HTTPServer(('0.0.0.0',${BRIDGE_PORT}),H)
except OSError as e:
  print(f'Temporary log server skipped on :${BRIDGE_PORT}: {e}', flush=True)
  sys.exit(0)
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
OPENCLAW_DOCKER_IMAGE="${OPENCLAW_DOCKER_IMAGE:-ghcr.io/absurdfounder/trooper-gateway:latest}"

if [ "$FROM_SNAPSHOT" = "1" ]; then
  # Image already cached on snapshot — just re-tag it
  dlog "Snapshot boot: tagging cached Docker image as openclaw:local"
  docker tag "${OPENCLAW_DOCKER_IMAGE}" openclaw:local 2>/dev/null || docker tag ghcr.io/absurdfounder/trooper-gateway:latest openclaw:local
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
 handle /health {
 reverse_proxy 127.0.0.1:${BRIDGE_PORT}
 }
 handle /healthz {
 reverse_proxy 127.0.0.1:${BRIDGE_PORT}
 }
 handle /webhook/* {
 reverse_proxy 127.0.0.1:${BRIDGE_PORT}
 }
 handle /admin/* {
 reverse_proxy 127.0.0.1:${BRIDGE_PORT}
 }
 handle /api/memories/* {
 reverse_proxy 127.0.0.1:${BRIDGE_PORT}
 }
 handle /api/memories {
 reverse_proxy 127.0.0.1:${BRIDGE_PORT}
 }
 @orgmemory path_regexp orgmem ^/api/organizations/[^/]+/memory(/.*)?$
 handle @orgmemory {
 reverse_proxy 127.0.0.1:${BRIDGE_PORT}
 }
 handle /api/api-keys/* {
 reverse_proxy 127.0.0.1:${BRIDGE_PORT}
 }
 handle /api/api-keys {
 reverse_proxy 127.0.0.1:${BRIDGE_PORT}
 }
 handle /api/* {
 reverse_proxy 127.0.0.1:3001
 }
 handle /agents/* {
 reverse_proxy 127.0.0.1:${BRIDGE_PORT}
 }
 handle /recording/* {
 reverse_proxy 127.0.0.1:${BRIDGE_PORT}
 }
 handle /llm/* {
 reverse_proxy 127.0.0.1:${BRIDGE_PORT}
 }
 handle /debug/* {
 reverse_proxy 127.0.0.1:${BRIDGE_PORT}
 }
 handle /files {
 reverse_proxy 127.0.0.1:${BRIDGE_PORT}
 }
 handle /files/* {
 reverse_proxy 127.0.0.1:${BRIDGE_PORT}
 }
 handle /skills/* {
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
 handle /runtime-api/* {
 uri strip_prefix /runtime-api
 reverse_proxy 127.0.0.1:${TROOPER_RUNTIME_PORT}
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
 handle /health {
 reverse_proxy 127.0.0.1:${BRIDGE_PORT}
 }
 handle /healthz {
 reverse_proxy 127.0.0.1:${BRIDGE_PORT}
 }
 handle /webhook/* {
 reverse_proxy 127.0.0.1:${BRIDGE_PORT}
 }
 handle /admin/* {
 reverse_proxy 127.0.0.1:${BRIDGE_PORT}
 }
 handle /api/memories/* {
 reverse_proxy 127.0.0.1:${BRIDGE_PORT}
 }
 handle /api/memories {
 reverse_proxy 127.0.0.1:${BRIDGE_PORT}
 }
 @orgmemory path_regexp orgmem ^/api/organizations/[^/]+/memory(/.*)?$
 handle @orgmemory {
 reverse_proxy 127.0.0.1:${BRIDGE_PORT}
 }
 handle /api/api-keys/* {
 reverse_proxy 127.0.0.1:${BRIDGE_PORT}
 }
 handle /api/api-keys {
 reverse_proxy 127.0.0.1:${BRIDGE_PORT}
 }
 handle /api/* {
 reverse_proxy 127.0.0.1:3001
 }
 handle /agents/* {
 reverse_proxy 127.0.0.1:${BRIDGE_PORT}
 }
 handle /recording/* {
 reverse_proxy 127.0.0.1:${BRIDGE_PORT}
 }
 handle /llm/* {
 reverse_proxy 127.0.0.1:${BRIDGE_PORT}
 }
 handle /debug/* {
 reverse_proxy 127.0.0.1:${BRIDGE_PORT}
 }
 handle /files {
 reverse_proxy 127.0.0.1:${BRIDGE_PORT}
 }
 handle /files/* {
 reverse_proxy 127.0.0.1:${BRIDGE_PORT}
 }
 handle /skills/* {
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
 handle /runtime-api/* {
 uri strip_prefix /runtime-api
 reverse_proxy 127.0.0.1:${TROOPER_RUNTIME_PORT}
 }
 handle {
 reverse_proxy 127.0.0.1:${GATEWAY_PORT}
 }
}
CADDYFILE
 systemctl enable caddy
 systemctl restart caddy 2>/dev/null || true
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

     # Route DNS to tunnel (CNAME) — upsert to handle stale records from previous deploys
     CF_ZONE_ID="da3b8c817a0e3479c05f3f2aac6e04e7"
     EXISTING_DNS_ID=$(curl -sf \
       -H "Authorization: Bearer ${CF_API_TOKEN}" \
       "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records?name=${HTTPS_DOMAIN}" | \
       python3 -c "import sys,json; r=json.load(sys.stdin).get('result',[]); print(r[0]['id'] if r else '')" 2>/dev/null || true)
     DNS_PAYLOAD="{\"type\":\"CNAME\",\"name\":\"${HTTPS_DOMAIN}\",\"content\":\"${TUNNEL_ID}.cfargotunnel.com\",\"ttl\":1,\"proxied\":true}"
     if [ -n "$EXISTING_DNS_ID" ]; then
       # Update existing record (may be stale A record or old CNAME)
       curl -sf -X PUT \
         -H "Authorization: Bearer ${CF_API_TOKEN}" \
         -H "Content-Type: application/json" \
         "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records/${EXISTING_DNS_ID}" \
         -d "$DNS_PAYLOAD" >/dev/null 2>&1 || true
       echo "DNS record updated: ${HTTPS_DOMAIN} → ${TUNNEL_ID}.cfargotunnel.com"
     else
       # Create new record
       curl -sf -X POST \
         -H "Authorization: Bearer ${CF_API_TOKEN}" \
         -H "Content-Type: application/json" \
         "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records" \
         -d "$DNS_PAYLOAD" >/dev/null 2>&1 || true
       echo "DNS record created: ${HTTPS_DOMAIN} → ${TUNNEL_ID}.cfargotunnel.com"
     fi

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

has_codex_auth_profile() {
 [ -n "${OPENAI_CODEX_AUTH_PROFILE_B64:-}" ] && [ "${OPENAI_CODEX_AUTH_PROFILE_B64}" != "__UNSET_OPENAI_CODEX_AUTH_PROFILE_B64__" ]
}

ensure_auth_profile_secret_key_source() {
 local secret_dir="/opt/openclaw-data/auth-profile-secrets"
 local secret_file="${secret_dir}/auth-profile-secret-key"
 mkdir -p "$secret_dir"
 if [ ! -s "$secret_file" ]; then
  (umask 077; od -An -N 32 -tx1 /dev/urandom | tr -d ' \n' > "$secret_file")
 fi
 chown -R node:node "$secret_dir" 2>/dev/null || chown -R 1000:1000 "$secret_dir" 2>/dev/null || true
 chmod 700 "$secret_dir" 2>/dev/null || true
 chmod 600 "$secret_file" 2>/dev/null || true
}

restore_codex_oauth_sidecars() {
 if ! has_codex_auth_profile; then
  return 0
 fi
 OPENAI_CODEX_AUTH_PROFILE_B64="$OPENAI_CODEX_AUTH_PROFILE_B64" python3 - <<'PYCODEXSIDECAR' || true
import base64
import json
import os
import pathlib
import re

raw = os.environ.get("OPENAI_CODEX_AUTH_PROFILE_B64", "").strip()
if not raw:
    raise SystemExit(0)
try:
    incoming = json.loads(base64.b64decode(raw).decode("utf-8"))
except Exception:
    raise SystemExit(0)
if not isinstance(incoming, dict) or not incoming.get("access"):
    raise SystemExit(0)

profile_id_hint = incoming.get("id") if isinstance(incoming.get("id"), str) else "openai-codex:default"
material = {
    key: incoming[key]
    for key in ("access", "refresh", "idToken")
    if isinstance(incoming.get(key), str) and incoming.get(key).strip()
}
if not material:
    raise SystemExit(0)

auth_paths = [
    pathlib.Path("/opt/openclaw-data/config/agents/main/agent/auth-profiles.json"),
    pathlib.Path("/opt/openclaw-data/config/auth-profiles.json"),
]
sidecar_root = pathlib.Path("/opt/openclaw-data/config/credentials/auth-profiles")
sidecar_root.mkdir(parents=True, exist_ok=True)

ref_re = re.compile(r"^[a-f0-9]{32}$")
written = 0

for auth_path in auth_paths:
    if not auth_path.exists():
        continue
    try:
        doc = json.loads(auth_path.read_text())
    except Exception:
        continue
    profiles = doc.get("profiles")
    if not isinstance(profiles, dict):
        continue
    for profile_id, profile in list(profiles.items()):
        if not isinstance(profile, dict) or profile.get("provider") != "openai-codex":
            continue
        if profile_id != profile_id_hint and not str(profile_id).startswith("openai-codex:"):
            continue
        ref = profile.get("oauthRef")
        if not isinstance(ref, dict):
            continue
        if ref.get("source") != "openclaw-credentials" or ref.get("provider") != "openai-codex":
            continue
        ref_id = ref.get("id")
        if not isinstance(ref_id, str) or not ref_re.match(ref_id):
            continue
        sidecar = {
            "version": 1,
            "profileId": profile_id,
            "provider": "openai-codex",
            **material,
        }
        (sidecar_root / f"{ref_id}.json").write_text(json.dumps(sidecar, indent=2) + "\n")
        written += 1

if written:
    print(f"[setup] Restored Codex OAuth sidecar material for {written} auth profile reference(s)")
PYCODEXSIDECAR
 chown -R node:node /opt/openclaw-data/config/credentials 2>/dev/null || chown -R 1000:1000 /opt/openclaw-data/config/credentials 2>/dev/null || true
 find /opt/openclaw-data/config/credentials -type d -exec chmod 755 {} \; 2>/dev/null || true
 find /opt/openclaw-data/config/credentials -type f -exec chmod 600 {} \; 2>/dev/null || true
}

resolve_non_codex_model() {
 if [ -n "${ANTHROPIC_API_KEY:-}" ] && [ "${ANTHROPIC_API_KEY}" != "__UNSET_ANTHROPIC_API_KEY__" ]; then
 echo "anthropic/claude-sonnet-4-5"
 elif [ -n "${OPENAI_API_KEY:-}" ] && [ "${OPENAI_API_KEY}" != "__UNSET_OPENAI_API_KEY__" ]; then
 echo "openai/gpt-5.2"
 elif [ -n "${GEMINI_API_KEY:-}" ] && [ "${GEMINI_API_KEY}" != "__UNSET_GEMINI_API_KEY__" ]; then
 echo "google/gemini-2.5-pro"
 elif [ -n "${OPENROUTER_API_KEY:-}" ] && [ "${OPENROUTER_API_KEY}" != "__UNSET_OPENROUTER_API_KEY__" ]; then
 echo "openrouter/openai/gpt-5-mini"
 else
 echo "openrouter/openai/gpt-5-mini"
 fi
}

RESOLVED_MODEL=$(resolve_primary_model)
if echo "$RESOLVED_MODEL" | grep -q '^openai-codex/' && ! has_codex_auth_profile; then
 dlog "Codex model was requested but no Codex OAuth profile was supplied; falling back to an available API-key provider." "model-routing"
 RESOLVED_MODEL=$(resolve_non_codex_model)
fi
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
 cd /opt/openclaw && git fetch --depth 1 origin main && git reset --hard FETCH_HEAD || true
fi

mkdir -p /opt/openclaw-data/config /opt/openclaw-data/workspace
mkdir -p /opt/openclaw-data/config/media/browser
mkdir -p /opt/openclaw-data/config/agents/main/agent
mkdir -p /opt/openclaw-data/config/hooks
mkdir -p /opt/openclaw-data/config/credentials
ensure_auth_profile_secret_key_source

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
OPENCLAW_AUTH_PROFILE_SECRET_DIR=/opt/openclaw-data/auth-profile-secrets
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
 { "id": "qwen/qwen3.7-max", "name": "Trooper Auto", "contextWindow": 128000 },
 { "id": "moonshotai/kimi-k2.6", "name": "Trooper Premium", "contextWindow": 128000 },
 { "id": "anthropic/claude-sonnet-4-5", "name": "Claude Sonnet 4.5 (OR)", "contextWindow": 200000 },
 { "id": "openai/gpt-5.2", "name": "GPT-5.2 (OR)", "contextWindow": 128000 },
 { "id": "openai/gpt-5-mini", "name": "GPT-5 Mini (OR)", "contextWindow": 128000 },
 { "id": "google/gemini-2.5-pro", "name": "Gemini 2.5 Pro (OR)", "contextWindow": 1000000 }
 ]
 }'
fi

if has_codex_auth_profile; then
 add_provider ' "openai-codex": {
 "baseUrl": "https://chatgpt.com/backend-api",
 "api": "openai-codex-responses",
 "models": [
 { "id": "gpt-5.4", "name": "gpt-5.4", "api": "openai-codex-responses" }
 ]
 }'
fi

# Optional: local llama.cpp provider (for self-hosted setups running llama-server on the VPS)
if [ -n "${LOCAL_MODEL_PORT:-}" ]; then
 add_provider ' "local-llamacpp": {
 "baseUrl": "http://localhost:'"${LOCAL_MODEL_PORT}"'/v1",
 "api": "openai-completions",
 "models": [
 { "id": "local-model", "name": "Local Model", "contextWindow": 262144 }
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

DREAMING_FREQUENCY="${OPENCLAW_DREAMING_FREQUENCY:-0 3 * * *}"
DREAMING_TIMEZONE="${OPENCLAW_DREAMING_TIMEZONE:-UTC}"

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
 "memory_recall", "memory_search", "memory_get",
 "sessions_list", "sessions_history", "sessions_send", "sessions_spawn", "session_status",
 "agents_list", "image", "message", "cron", "gateway", "nodes",
 "llm-task", "lobster"
 ],
 "exec": {
 "host": "gateway",
 "notifyOnExit": true
 }
 },
 "plugins": {
 "entries": {
 "memory-core": {
 "enabled": true,
 "config": {
 "dreaming": {
 "enabled": true,
 "frequency": "${DREAMING_FREQUENCY}",
 "timezone": "${DREAMING_TIMEZONE}"
 }
 }
 },
 "active-memory": {
 "enabled": true,
 "config": {
 "enabled": true,
 "agents": ["main"],
 "allowedChatTypes": ["direct", "channel"],
 "queryMode": "recent",
 "promptStyle": "balanced",
 "timeoutMs": 10000,
 "maxSummaryChars": 220,
 "persistTranscripts": false,
 "logging": false
 }
 },
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
 "command-logger": { "enabled": true },
 "boot-md": { "enabled": true },
 "bootstrap-extra-files": { "enabled": true, "paths": ["Tasks/*/AGENTS.md"] }
 }
 },
 "enabled": true,
 "token": "HOOK_TOKEN_PLACEHOLDER",
 "path": "/hooks",
 "allowRequestSessionKey": true,
 "allowedSessionKeyPrefixes": ["hook:", "hook:trooper:"],
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
 "streaming": {
 "mode": "partial"
 },
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

# Fix jiti cache permissions — files in /tmp/jiti get created as root during startup
# because the gateway bootstraps plugins before su fully takes effect.
# Nuclear cleanup: kill any leftover node processes, nuke the dir, recreate world-writable.
pkill -9 -u 1000 node 2>/dev/null || true
rm -rf /tmp/jiti /tmp/node-* 2>/dev/null || true
mkdir -p /tmp/jiti && chmod 1777 /tmp/jiti
# Also set JITI_CACHE_DIR to a node-owned location as fallback
export JITI_CACHE_DIR="/home/node/.cache/jiti"
mkdir -p "$JITI_CACHE_DIR" && chown 1000:1000 "$JITI_CACHE_DIR" && chmod 755 "$JITI_CACHE_DIR"

# Fix devices dir permissions so bridge (host process) can write paired.json
chmod 777 /home/node/.openclaw/devices 2>/dev/null || true
chmod 666 /home/node/.openclaw/devices/*.json 2>/dev/null || true

# Drop back to node user for the gateway process
exec su -s /bin/bash node -c "DISPLAY=:99 JITI_CACHE_DIR=/home/node/.cache/jiti node dist/index.js gateway --allow-unconfigured --bind loopback --port $GATEWAY_PORT"
STARTUP
chmod +x /opt/openclaw-data/startup.sh

# Auth profiles — dynamically built from all available API keys
AUTH_PROFILES=""
AUTH_LASTGOOD=""
append_auth_profile_entry() {
 local id="$1" provider="$2"
 local entry="$3"
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
 append_auth_profile_entry "$id" "$provider" "$entry"
}

add_raw_auth_profile() {
 local id="$1" provider="$2" profile_json="$3"
 append_auth_profile_entry "$id" "$provider" "\"${id}\": ${profile_json}"
}

if [ -n "${ANTHROPIC_API_KEY:-}" ] && [ "${ANTHROPIC_API_KEY}" != "__UNSET_ANTHROPIC_API_KEY__" ]; then
 add_auth_profile "anthropic:default" "anthropic" "${ANTHROPIC_API_KEY}"
fi
if [ -n "${OPENAI_API_KEY:-}" ] && [ "${OPENAI_API_KEY}" != "__UNSET_OPENAI_API_KEY__" ]; then
 add_auth_profile "openai:default" "openai" "${OPENAI_API_KEY}"
fi
if [ -n "${OPENAI_CODEX_AUTH_PROFILE_B64:-}" ] && [ "${OPENAI_CODEX_AUTH_PROFILE_B64}" != "__UNSET_OPENAI_CODEX_AUTH_PROFILE_B64__" ]; then
 CODEX_AUTH_RECORD="$(OPENAI_CODEX_AUTH_PROFILE_B64="$OPENAI_CODEX_AUTH_PROFILE_B64" python3 - <<'PYCODEXAUTH' || true
import base64
import json
import os
import sys

raw = os.environ.get("OPENAI_CODEX_AUTH_PROFILE_B64", "").strip()
if not raw:
    sys.exit(0)
try:
    profile = json.loads(base64.b64decode(raw).decode("utf-8"))
except Exception:
    sys.exit(0)
if not isinstance(profile, dict) or not profile.get("access"):
    sys.exit(0)
profile["type"] = "oauth"
profile["provider"] = "openai-codex"
profile.pop("key", None)
profile_id = profile.pop("id", None) or "openai-codex:default"
print(profile_id)
print(json.dumps(profile, separators=(",", ":")))
PYCODEXAUTH
)"
 CODEX_AUTH_ID="$(printf '%s\n' "$CODEX_AUTH_RECORD" | sed -n '1p')"
 CODEX_AUTH_PROFILE_JSON="$(printf '%s\n' "$CODEX_AUTH_RECORD" | sed -n '2p')"
 if [ -n "$CODEX_AUTH_ID" ] && [ -n "$CODEX_AUTH_PROFILE_JSON" ]; then
  add_raw_auth_profile "$CODEX_AUTH_ID" "openai-codex" "$CODEX_AUTH_PROFILE_JSON"
 fi
fi
if [ -n "${GEMINI_API_KEY:-}" ] && [ "${GEMINI_API_KEY}" != "__UNSET_GEMINI_API_KEY__" ]; then
 add_auth_profile "google:default" "google" "${GEMINI_API_KEY}"
fi
if [ -n "${OPENROUTER_API_KEY:-}" ] && [ "${OPENROUTER_API_KEY}" != "__UNSET_OPENROUTER_API_KEY__" ]; then
 add_auth_profile "openrouter:default" "openrouter" "${OPENROUTER_API_KEY}"
fi
if [ -n "${LOCAL_MODEL_PORT:-}" ]; then
 add_auth_profile "local-llamacpp:default" "local-llamacpp" "local-model"
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

dlog "Auth profiles configured for: $(echo "$AUTH_LASTGOOD" | grep -o '"[a-z0-9-]*"' | tr '\n' ' ' || echo 'none')"

# ── OpenClaw Workspace Bootstrap ──────────────────────────────────────
# Workspace files are pushed AFTER deploy via the bridge API (provision.js)
# This keeps the setup script small and workspace always in sync.
mkdir -p /opt/openclaw-data/workspace/memory /opt/openclaw-data/workspace/skills

cat > /opt/openclaw-data/workspace/MEMORY.md << 'MEMORYMD'
# Memory

## Active Context
No active context has been synced yet.

## Preferences
No preferences have been captured yet.

## Decisions Log
No decisions have been captured yet.

## Lessons Learned
No lessons have been captured yet.
MEMORYMD

cat > /opt/openclaw-data/workspace/MEMORIES.md << 'MEMORIESMD'
# Structured Memories

_No structured memories have been synced yet. This file is generated from Trooper memory._
MEMORIESMD

cat > /opt/openclaw-data/workspace/KNOWLEDGE.md << 'KNOWLEDGEMD'
# Team Knowledge

_No durable knowledge entries have been synced yet. This file is generated from Trooper knowledge._
KNOWLEDGEMD

cat > /opt/openclaw-data/workspace/skills/README.md << 'SKILLSREADME'
# Skills

_No workspace skills installed yet._
SKILLSREADME

# Materialize OpenClaw native/runtime skills before the first doctor run.
# These are lightweight SKILL.md wrappers over built-in or host-provided CLIs.
cat > /tmp/trooper-openclaw-runtime-skills.mjs <<'RUNTIMESKILLS'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const roots = [
  '/opt/openclaw-data/workspace/skills',
  '/opt/openclaw-data/config/skills',
  '/opt/openclaw-data/config/.agents/skills',
  '/home/node/.openclaw/skills',
  '/home/node/.openclaw/.agents/skills',
];

const skills = [
  { slug: '1password', name: '1Password', category: 'Secrets', cli: 'op', description: 'Set up and use 1Password CLI for sign-in, desktop integration, and reading or injecting secrets.' },
  { slug: 'apple-notes', name: 'Apple Notes', category: 'Productivity', cli: 'memo', description: 'Create, view, edit, delete, search, move, or export Apple Notes via the memo CLI on macOS.' },
  { slug: 'apple-reminders', name: 'Apple Reminders', category: 'Productivity', cli: 'remindctl', description: 'List, add, edit, complete, or delete Apple Reminders and reminder lists via remindctl.' },
  { slug: 'bear-notes', name: 'Bear Notes', category: 'Productivity', cli: 'grizzly', description: 'Create, search, and manage Bear notes via the grizzly CLI.' },
  { slug: 'blogwatcher', name: 'Blogwatcher', category: 'Research', cli: 'blogwatcher', description: 'Monitor blogs and RSS/Atom feeds for updates using the blogwatcher CLI.' },
  { slug: 'blucli', name: 'BluOS CLI', category: 'Home & media', cli: 'blu', description: 'BluOS CLI for discovery, playback, grouping, and volume control.' },
  { slug: 'camsnap', name: 'Camsnap', category: 'Media', cli: 'camsnap', description: 'Capture frames or clips from RTSP/ONVIF cameras.' },
  { slug: 'canvas', name: 'Canvas', category: 'Display', cli: 'canvas', description: 'Present HTML on connected OpenClaw node canvases, navigate, evaluate, snapshot, and debug canvas host URLs.' },
  { slug: 'clawhub', name: 'ClawHub', category: 'Skills', cli: 'clawhub', description: 'Search, install, update, sync, or publish agent skills with the ClawHub CLI and registry.' },
  { slug: 'coding-agent', name: 'Coding Agent', category: 'Coding', cli: 'coding-agent', description: 'Delegate coding work to Codex, Claude Code, OpenCode, or Pi as background workers.' },
  { slug: 'diagram-maker', name: 'Diagram Maker', category: 'Design', cli: 'diagram-maker', description: 'Create SVG, HTML, or Excalidraw diagrams for concepts, architecture, flows, and whiteboards.' },
  { slug: 'discord', name: 'Discord', category: 'Messaging', cli: 'discord', description: 'Discord message operations: send, read, edit, delete, react, poll, pin, thread, search, presence, media, and components.' },
  { slug: 'eightctl', name: 'Eight Sleep', category: 'Home & health', cli: 'eightctl', description: 'Control Eight Sleep pods including status, temperature, alarms, and schedules.' },
  { slug: 'gemini', name: 'Gemini CLI', category: 'AI', cli: 'gemini', description: 'Gemini CLI one-shot prompts, summaries, generation, skills, hooks, MCP, or Gemma routing.' },
  { slug: 'gh-issues', name: 'GitHub Issues', category: 'Coding', cli: 'gh', description: 'Fetch GitHub issues, select candidates, spawn background fix agents, open PRs, and process PR review comments.' },
  { slug: 'gifgrep', name: 'Gifgrep', category: 'Media', cli: 'gifgrep', description: 'Search GIF providers with CLI/TUI, download results, and extract stills or sheets.' },
  { slug: 'github', name: 'GitHub', category: 'Coding', cli: 'gh', description: 'GitHub CLI for issues, PRs, CI logs, comments, reviews, releases, repositories, and gh api queries.' },
  { slug: 'gog', name: 'Google Workspace', category: 'Productivity', cli: 'gog', description: 'Google Workspace CLI for Gmail, Calendar, Drive, Contacts, Sheets, and Docs.' },
  { slug: 'goplaces', name: 'Google Places', category: 'Research', cli: 'goplaces', description: 'Query Google Places for text search, place details, resolve, reviews, or scriptable JSON via goplaces.' },
  { slug: 'healthcheck', name: 'Healthcheck', category: 'Operations', cli: 'healthcheck', description: 'Audit and harden OpenClaw hosts: SSH, firewall, updates, exposure, backups, disk encryption, and gateway security.' },
  { slug: 'himalaya', name: 'Himalaya', category: 'Messaging', cli: 'himalaya', description: 'Himalaya CLI for IMAP/SMTP mail: list, read, search, compose, reply, forward, copy, move, and delete.' },
  { slug: 'imsg', name: 'iMessage', category: 'Messaging', cli: 'imsg', description: 'iMessage and SMS CLI for listing chats, history, and sending messages via Messages.app.' },
  { slug: 'mcporter', name: 'MCP Porter', category: 'Automation', cli: 'mcporter', description: 'List, configure, authenticate, call, and inspect MCP servers/tools with mcporter over HTTP or stdio.' },
  { slug: 'meme-maker', name: 'Meme Maker', category: 'Media', cli: 'meme-maker', description: 'Search meme templates, suggest formats, and generate local or hosted image memes.' },
  { slug: 'model-usage', name: 'Model Usage', category: 'Observability', cli: 'model-usage', description: 'Summarize local model cost logs by model for Codex or Claude, including current or full breakdowns.' },
  { slug: 'nano-pdf', name: 'Nano PDF', category: 'Documents', cli: 'nano-pdf', description: 'Edit PDFs with natural-language instructions using the nano-pdf CLI.' },
  { slug: 'node-connect', name: 'Node Connect', category: 'Operations', cli: 'node-connect', description: 'Diagnose OpenClaw Android, iOS, or macOS node pairing, QR/setup code, route, auth, and connection failures.' },
  { slug: 'node-inspect-debugger', name: 'Node Inspect Debugger', category: 'Coding', cli: 'node', description: 'Debug Node.js with node inspect, --inspect, breakpoints, CDP, heap, and CPU profiles.' },
  { slug: 'notion', name: 'Notion', category: 'Productivity', cli: 'notion', description: 'Notion CLI/API for pages, Markdown content, data sources, files, comments, search, Workers, and raw API calls.' },
  { slug: 'obsidian', name: 'Obsidian', category: 'Productivity', cli: 'obsidian', description: 'Work with Obsidian vaults using the official Obsidian CLI: read, search, create, edit notes, tasks, links, properties, and plugins.' },
  { slug: 'openai-whisper', name: 'OpenAI Whisper', category: 'Audio', cli: 'whisper', description: 'Local speech-to-text with the Whisper CLI without an API key.' },
  { slug: 'openai-whisper-api', name: 'OpenAI Whisper API', category: 'Audio', cli: 'curl', description: 'OpenAI Audio Transcriptions API via curl; gpt-4o-transcribe, mini, diarize, or whisper-1.' },
  { slug: 'openhue', name: 'OpenHue', category: 'Home & media', cli: 'openhue', description: 'Control Philips Hue lights and scenes via the OpenHue CLI.' },
  { slug: 'oracle', name: 'Oracle', category: 'AI', cli: 'oracle', description: 'Second-model review, debug, refactor, or design with selected files, dry-run token checks, API, or browser engine.' },
  { slug: 'ordercli', name: 'Order CLI', category: 'Lifestyle', cli: 'ordercli', description: 'Foodora-only CLI for checking past orders and active order status.' },
  { slug: 'peekaboo', name: 'Peekaboo', category: 'Automation', cli: 'peekaboo', description: 'Capture and automate macOS UI with the Peekaboo CLI.' },
  { slug: 'python-debugpy', name: 'Python Debugpy', category: 'Coding', cli: 'python', description: 'Debug Python with pdb, breakpoint(), post-mortem inspection, and debugpy remote attach.' },
  { slug: 'sag', name: 'Sag', category: 'Audio', cli: 'sag', description: 'ElevenLabs text-to-speech with mac-style say UX.' },
  { slug: 'session-logs', name: 'Session Logs', category: 'Observability', cli: 'jq', description: 'Search and analyze local session logs and older or parent conversations using jq.' },
  { slug: 'sherpa-onnx-tts', name: 'Sherpa ONNX TTS', category: 'Audio', cli: 'sherpa-onnx-tts', description: 'Local text-to-speech via sherpa-onnx, offline and no cloud required.' },
  { slug: 'skill-creator', name: 'Skill Creator', category: 'Skills', cli: 'skill-creator', description: 'Create, edit, audit, tidy, validate, or restructure AgentSkills and SKILL.md files.' },
  { slug: 'slack', name: 'Slack', category: 'Messaging', cli: 'slack', description: 'Slack actions: send, read, edit, delete messages, react, pin and unpin, list pins/reactions/emoji, and member info.' },
  { slug: 'songsee', name: 'Songsee', category: 'Audio', cli: 'songsee', description: 'Generate spectrograms and feature-panel visualizations from audio with the songsee CLI.' },
  { slug: 'sonoscli', name: 'Sonos CLI', category: 'Home & media', cli: 'sonoscli', description: 'Control Sonos speakers including discovery, status, play, volume, and grouping.' },
  { slug: 'spike', name: 'Spike', category: 'Research', cli: 'spike', description: 'Run throwaway prototypes to validate feasibility, compare approaches, and report a verdict.' },
  { slug: 'spotify-player', name: 'Spotify Player', category: 'Home & media', cli: 'spogo', description: 'Terminal Spotify playback and search via spogo or spotify_player.' },
  { slug: 'summarize', name: 'Summarize', category: 'Research', cli: 'summarize', description: 'Summarize or transcribe URLs, YouTube videos, podcasts, articles, transcripts, PDFs, and local files.' },
  { slug: 'taskflow', name: 'TaskFlow', category: 'Automation', cli: 'taskflow', description: 'Coordinate multi-step detached tasks as one durable TaskFlow job with owner context, state, waits, and child tasks.' },
  { slug: 'taskflow-inbox-triage', name: 'TaskFlow Inbox Triage', category: 'Automation', cli: 'taskflow', description: 'Example TaskFlow pattern for inbox triage, intent routing, waiting on replies, and later summaries.' },
  { slug: 'things-mac', name: 'Things Mac', category: 'Productivity', cli: 'things', description: 'Add, update, list, search, or inspect Things 3 todos, inbox, today, projects, areas, and tags on macOS.' },
  { slug: 'tmux', name: 'Tmux', category: 'Automation', cli: 'tmux', description: 'Control tmux sessions and panes for interactive CLIs: list, capture output, send keys, paste text, and monitor prompts.' },
  { slug: 'trello', name: 'Trello', category: 'Project Management', cli: 'trello', description: 'Manage Trello boards, lists, and cards via the Trello REST API.' },
  { slug: 'video-frames', name: 'Video Frames', category: 'Media', cli: 'ffmpeg', description: 'Extract frames or short clips from videos using ffmpeg.' },
  { slug: 'voice-call', name: 'Voice Call', category: 'Voice', cli: 'voice-call', description: 'Start voice calls via the OpenClaw voice-call plugin.' },
  { slug: 'wacli', name: 'WhatsApp CLI', category: 'Messaging', cli: 'wacli', description: 'Send third-party WhatsApp messages or sync/search WhatsApp history via wacli.' },
  { slug: 'weather', name: 'Weather', category: 'Research', cli: 'curl', description: 'Current weather and forecasts with wttr.in via curl for locations, rain, temperature, and travel planning.' },
  { slug: 'xurl', name: 'X URL', category: 'Social Media', cli: 'xurl', description: 'xurl CLI for authenticated X posts, replies, reads/search, DMs, media upload, followers, auth status, or raw v2 API calls.' },
];

const normalizeContent = (value = '') => `${String(value || '').trim()}\n`;
const yamlQuote = (value = '') => JSON.stringify(String(value || ''));

function buildSkillContent(skill) {
  const keywords = [skill.slug, skill.name, skill.cli, skill.category]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, '-'));

  return normalizeContent(`
---
summary: ${yamlQuote(skill.description)}
whenToUse: ${yamlQuote(`Use when the task needs the OpenClaw ${skill.name} runtime capability or the ${skill.cli} CLI.`)}
allowedTools:
  - exec
keywords:
${keywords.map((keyword) => `  - ${keyword}`).join('\n')}
---
# ${skill.name}

${skill.description}

## Runtime
- Capability slug: \`${skill.slug}\`
- Preferred CLI/tool: \`${skill.cli}\`
- Category: ${skill.category}

## Workflow
1. Confirm the task really needs this runtime capability.
2. Check whether required auth, tokens, desktop access, or local devices are configured before taking side effects.
3. Use \`${skill.cli}\` through the shell/runtime tool path for read operations first.
4. Preview external mutations before posting, sending, deleting, purchasing, or changing connected systems.
5. Report missing credentials or unavailable binaries clearly instead of pretending the action completed.

## Safety
- Do not expose secrets, tokens, private messages, or unrelated account data.
- Ask before irreversible or externally visible actions.
- Keep command output concise and cite the exact operation attempted when something fails.
`);
}

let writes = 0;
for (const root of roots) {
  mkdirSync(root, { recursive: true });
  for (const skill of skills) {
    const skillDir = path.join(root, skill.slug);
    const skillPath = path.join(skillDir, 'SKILL.md');
    const content = buildSkillContent(skill);
    mkdirSync(skillDir, { recursive: true });
    const current = existsSync(skillPath) ? readFileSync(skillPath, 'utf8') : null;
    if (current !== content) {
      writeFileSync(skillPath, content, 'utf8');
      writes += 1;
    }
  }
}

console.log(`[setup] OpenClaw runtime skills provisioned: ${skills.length} skills across ${roots.length} roots (${writes} files written)`);
RUNTIMESKILLS
node /tmp/trooper-openclaw-runtime-skills.mjs || echo "WARNING: could not provision OpenClaw runtime skill wrappers"
rm -f /tmp/trooper-openclaw-runtime-skills.mjs
chown -R 1000:1000 /opt/openclaw-data/workspace/skills /opt/openclaw-data/config/skills /opt/openclaw-data/config/.agents /home/node/.openclaw/skills /home/node/.openclaw/.agents 2>/dev/null || true

# BOOT.md — runs on gateway startup via boot-md hook
cat > /opt/openclaw-data/workspace/BOOT.md << 'BOOTMD'
# Boot

On startup:
1. Read MEMORY.md and today's memory file to restore context
2. Read graphify-out/GRAPH_REPORT.md before broad codebase, architecture, or research work
3. Check if any tasks are in_progress or blocked — report status
4. Say nothing if everything is normal (NO_REPLY)
BOOTMD

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
- You receive tasks from Trooper (mission control) via hooks
- Delegate specialized work to SPC agents using the `message` or `sessions_spawn` tools
- Monitor SPC progress and aggregate results
- Report back to mission control with deliverables
- Use `memory_search` to recall past work before starting new tasks
- Read `graphify-out/GRAPH_REPORT.md` before broad codebase, architecture, or research work, then verify with raw files and tools

## Task Delegation
When you receive a task:
1. Break it into subtasks by specialty
2. Assign each subtask to the most relevant SPC
3. Monitor progress and collect results
4. Compile final deliverable and report back

## CRITICAL: Enforce Tool Usage
When executing tasks directly (not delegating):
- **USE the Write tool** to create actual files for build/code tasks
- **NEVER** just describe what code would look like — create the actual files
- **THE SYSTEM TRACKS TOOL USAGE.** Tasks that produce long text without any tool calls are REJECTED.
- For "build an app" → use Write to create actual HTML/CSS/JS files
- For research → use web_search/web_fetch to get real data

## Browser & Desktop
When the user asks you to open a website, browse, or interact with a GUI, **always ask first**:
> "Want me to do this headless (faster, I'll report back), or spin it up on the virtual desktop so you can watch it live?"

### Two modes:
1. **Headless** — Use the `browser` tool normally. Faster, no GUI. You report results as text/screenshots.
2. **Live desktop** — Launch Chrome on `DISPLAY=:99` so it appears in the **Browser Live View** panel in Trooper. The user can see everything in real-time.

### How live desktop works:
- The VPS has a virtual display on `:99` (Xvnc, port 5999) — this is the **Browser Live View** in Trooper
- There's also a full LXQt desktop on `:1` (port 5901) — this is the **Desktop** panel in Trooper
- To launch Chrome visibly: `DISPLAY=:99 google-chrome-stable --no-sandbox <url> &`
- The user sees it live in their dashboard — no VNC client needed
- **Never say you can't share the GUI** — the user CAN see it via Trooper panels

### When to use which:
- Quick lookups, scraping, screenshots → headless
- Demos, debugging, "show me" requests → live desktop
- If unsure → ask the user

## Task Context (Persistent Memory)
Tasks carry context from previous attempts. If you see "Previous Context" in the task prompt:
- **Read it first.** Don't repeat what failed.
- **Build on what worked.** Don't redo completed steps.
- **Update your approach** based on blockers and failures listed.

The system auto-saves context after each run. You don't need to write it manually.

Format (auto-generated, ~500 tokens):
```
# Task: Title | Attempt: N | Last: YYYY-MM-DD
## Status — Complete/Partial/Blocked
## What works — one line per success
## What failed — one line per failure + why
## Files touched — space-separated paths
```

## Context & Memory
- **Read COMPANY.md first** — know the company, its products, its voice
- **Read CAPABILITIES.md** — model routing slots & API reference for all capabilities (image gen, video, TTS, social search, web search, etc.)
- **Read MEMORIES.md** — structured team knowledge (facts, preferences, decisions, learnings)
- **Read graphify-out/GRAPH_REPORT.md** — relationship and architecture map for code, docs, and memory
- **Use memory_search before starting work** — check if the team has done related work before
- **Write daily notes to memory/YYYY-MM-DD.md** — log delegations, outcomes, key decisions
- **Facts** go in MEMORIES.md: "This repo uses pnpm", "Staging API at X"
- **Task-specific notes** are auto-saved — don't dump task details into MEMORIES.md
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

# USER.md — location + user context for personalized responses
cat > /opt/openclaw-data/workspace/USER.md << 'USERMD'
# USER.md - About Your Human

- **Name:** (set during onboarding)
- **Timezone:** Asia/Calcutta (GMT+5:30)
- **Location:** (set during onboarding)
- **Coordinates:** (set during onboarding)

## Location Notes

Use the location above for weather, local recommendations, nearby services, time-based greetings, etc.
When using browser tools that request geolocation, use the coordinates above.
USERMD

# TOOLS.md — environment-specific tool notes
cat > /opt/openclaw-data/workspace/TOOLS.md << 'TOOLSMD'
# TOOLS.md - Local Notes

## Browser

- Running Chrome on headless VPS with virtual display (Xvnc :99)
- Browser tool available for web searches, screenshots, automation
- Use web_fetch for quick lookups, browser tool for interactive sites

## Web Search

- Brave Search API configured (when available)
- Fallback: use browser tool with DuckDuckGo or Google

## Environment

- VPS: Hetzner Cloud
- Docker: OpenClaw gateway container
- Bridge: local service on port 3002
TOOLSMD

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
 --use-fake-device-for-media-stream \
 --use-fake-ui-for-media-stream \
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

# Devices dir and cron dir must be writable by BOTH container (uid 1000) and host bridge process.
# Use 777 so any UID can read/write device approval and cron state.
mkdir -p /opt/openclaw-data/config/devices /opt/openclaw-data/config/cron/runs
chmod 777 /opt/openclaw-data/config/devices
chmod 666 /opt/openclaw-data/config/devices/*.json 2>/dev/null || true
chmod 777 /opt/openclaw-data/config/cron
chmod 666 /opt/openclaw-data/config/cron/*.json 2>/dev/null || true
chmod 777 /opt/openclaw-data/config/cron/runs

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
docker compose exec -T -w /app openclaw-gateway node dist/index.js doctor --repair 2>/dev/null \
  || docker compose exec -T -w /app openclaw-gateway node dist/index.js doctor --fix 2>/dev/null \
  || true
restore_codex_oauth_sidecars

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
run_cmd apt-get install -y -qq --no-install-recommends novnc websockify ffmpeg 2>/dev/null || true
echo "[setup] noVNC + websockify installed for VNC live view"

# Custom embedded VNC page — no toolbar, no CtrlAltDel, clean iframe embed
cat > /usr/share/novnc/vnc_embed.html << 'VNCEMBED'
<!DOCTYPE html>
<html lang="en">
<head>
    <title>Trooper Desktop</title>
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
        const host = readParam('host', location.hostname);
        const port = readParam('port', location.port);
        const path = readParam('path', 'websockify');
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const url = proto + '://' + host + (port ? ':' + port : '') + '/' + path;
        const resizeMode = readParam('resize', '');
        const shouldReconnect = readParam('reconnect', 'false') === 'true';
        const reconnectDelay = Math.max(parseInt(readParam('reconnect_delay', '3000'), 10) || 3000, 500);
        const scaleViewport = resizeMode === 'scale' || readParam('scale', '') === 'true';
        const resizeSession = resizeMode === 'remote';
        const viewOnly = readParam('view_only', 'false') === 'true';
        let rfb = null;
        let reconnectTimer = null;
        let tornDown = false;

        function queueReconnect() {
            if (!shouldReconnect || tornDown || reconnectTimer) return;
            statusEl.textContent = 'Reconnecting...';
            reconnectTimer = window.setTimeout(() => {
                reconnectTimer = null;
                connect();
            }, reconnectDelay);
        }

        function connect() {
            if (tornDown) return;
            statusEl.classList.remove('connected');
            statusEl.textContent = 'Connecting...';

            if (rfb) {
                try { rfb.disconnect(); } catch {}
                rfb = null;
            }

            rfb = new RFB(document.getElementById('screen'), url, {
                credentials: { password: readParam('password', '') }
            });
            rfb.scaleViewport = scaleViewport;
            rfb.resizeSession = resizeSession;
            rfb.viewOnly = viewOnly;
            rfb.touchButton = 1;

            rfb.addEventListener('connect', () => {
                statusEl.classList.add('connected');
            });
            rfb.addEventListener('disconnect', (e) => {
                statusEl.classList.remove('connected');
                if (tornDown) {
                    statusEl.textContent = 'Disconnected';
                    return;
                }
                statusEl.textContent = e.detail.clean ? 'Disconnected' : 'Connection lost';
                queueReconnect();
            });
            rfb.addEventListener('credentialsrequired', () => {
                statusEl.classList.remove('connected');
                statusEl.textContent = 'Password required';
            });
            rfb.addEventListener('securityfailure', () => {
                statusEl.classList.remove('connected');
                statusEl.textContent = 'Security handshake failed';
                queueReconnect();
            });
        }

        window.addEventListener('beforeunload', () => {
            tornDown = true;
            if (reconnectTimer) window.clearTimeout(reconnectTimer);
            reconnectTimer = null;
            if (rfb) {
                try { rfb.disconnect(); } catch {}
            }
        });

        connect();
    </script>
</head>
<body>
    <div id="status">Loading</div>
    <div id="screen"></div>
</body>
</html>
VNCEMBED

# ── Desktop (LXQt) setup — manual use via Trooper Desktop panel ──────────────
dlog "Installing desktop packages (LXQt, x11vnc, apps)..."
run_cmd apt-get install -y -qq --no-install-recommends \
 xvfb xorg openbox x11vnc xterm xdotool \
 dbus dbus-x11 \
 lxqt-core lxqt-panel lxqt-runner \
 pcmanfm-qt feh papirus-icon-theme \
 fonts-dejavu fonts-liberation \
 xdg-utils wget \
 python3 python3-venv python3-pip 2>/dev/null || true
# Install snap Firefox (Ubuntu 24.04 doesn't have firefox-esr deb)
run_cmd snap install firefox 2>/dev/null || true
echo "[setup] LXQt desktop packages installed"
fi # end FROM_SNAPSHOT != 1 (noVNC + desktop packages)

# ── Pre-seed ALL desktop configs BEFORE anything starts ──
# These must exist before trooper-desktop-start runs, otherwise
# pcmanfm/openbox launch with defaults (black bg, no icons, broken menu).

# LXQt session config (openbox as WM)
mkdir -p /root/.config/lxqt
printf '[General]\n__userfile__=true\nwindow_manager=openbox\n' > /root/.config/lxqt/session.conf

# LXQt global icon theme
cat > /root/.config/lxqt/lxqt.conf << 'LXQTCONF'
[General]
__userfile__=true
icon_theme=Papirus
theme=system
LXQTCONF

# Default icon theme for all Qt apps
mkdir -p /root/.icons/default
printf '[Icon Theme]\nInherits=Papirus\n' > /root/.icons/default/index.theme

# pcmanfm-qt config — BOTH profiles (desktop runs --profile lxqt)
PCMAN_CONF='[Behavior]
SingleClick=true
QuickExec=true

[Desktop]
BgColor=#e8e8ee
FgColor=#333333
ShadowColor=#ffffff
DesktopIconSize=48
WallpaperMode=none
WorkAreaMargins=12, 12, 12, 12

[System]
FallbackIconThemeName=Papirus
Terminal=xterm'

mkdir -p /root/.config/pcmanfm-qt/default /root/.config/pcmanfm-qt/lxqt
echo "$PCMAN_CONF" > /root/.config/pcmanfm-qt/default/settings.conf
echo "$PCMAN_CONF" > /root/.config/pcmanfm-qt/lxqt/settings.conf

# Openbox right-click menu
mkdir -p /root/.config/openbox
cat > /root/.config/openbox/menu.xml << 'OBMENU'
<?xml version="1.0" encoding="UTF-8"?>
<openbox_menu xmlns="http://openbox.org/3.4/menu">
  <menu id="root-menu" label="Desktop">
    <item label="Terminal"><action name="Execute"><execute>xterm</execute></action></item>
    <item label="Firefox"><action name="Execute"><execute>/snap/bin/firefox --no-sandbox</execute></action></item>
    <item label="File Manager"><action name="Execute"><execute>pcmanfm-qt</execute></action></item>
    <separator />
    <item label="Reconfigure"><action name="Reconfigure" /></item>
  </menu>
</openbox_menu>
OBMENU

# Desktop icons
mkdir -p /root/Desktop
cat > /root/Desktop/firefox.desktop << 'DKICON'
[Desktop Entry]
Version=1.0
Type=Application
Name=Firefox
Exec=/snap/bin/firefox --no-sandbox
Icon=firefox
Terminal=false
DKICON
cat > /root/Desktop/files.desktop << 'DKICON'
[Desktop Entry]
Version=1.0
Type=Application
Name=Files
Exec=pcmanfm-qt
Icon=system-file-manager
Terminal=false
DKICON
cat > /root/Desktop/terminal.desktop << 'DKICON'
[Desktop Entry]
Version=1.0
Type=Application
Name=Terminal
Exec=qterminal
Icon=utilities-terminal
Terminal=false
DKICON
chmod +x /root/Desktop/*.desktop

echo "[setup] Desktop configs pre-seeded (icons, menu, pcmanfm, lxqt)"

# Desktop start script — called by control API
cat > /usr/local/bin/trooper-desktop-start << 'DSTART'
#!/bin/bash
set +e
# Stable desktop on :1 — deterministic boot, no fragile desktop-icon dependency.
# Display :99 is reserved for AI browser live view.

export XDG_RUNTIME_DIR=/tmp/runtime-root
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

pkill -f 'pcmanfm-qt --desktop' 2>/dev/null || true
pkill -f 'lxqt-session' 2>/dev/null || true
pkill -f 'lxqt-panel' 2>/dev/null || true
pkill -f 'openbox' 2>/dev/null || true
pkill -f 'xterm -hold -geometry 100x28+80+60' 2>/dev/null || true
pkill -f 'x11vnc.*5901' 2>/dev/null || true
pkill -f 'websockify.*6081' 2>/dev/null || true
pkill -f 'Xvfb :1' 2>/dev/null || true
sleep 1

nohup Xvfb :1 -screen 0 1280x800x24 > /var/log/xvfb.log 2>&1 &
sleep 2
export DISPLAY=:1

DBUS_ENV_FILE=/tmp/dbus-desktop-env
rm -f "$DBUS_ENV_FILE"
eval "$(dbus-launch --sh-syntax)"
if [ -z "$DBUS_SESSION_BUS_ADDRESS" ]; then
 apt-get install -y dbus dbus-x11 2>/dev/null
 eval "$(dbus-launch --sh-syntax)"
fi
cat > "$DBUS_ENV_FILE" << EOF2
DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS
DBUS_SESSION_BUS_PID=$DBUS_SESSION_BUS_PID
EOF2
export DBUS_SESSION_BUS_ADDRESS DBUS_SESSION_BUS_PID

python3 - << 'PYBG'
from pathlib import Path
w,h=1280,800
with open('/tmp/trooper-bg.ppm','wb') as f:
    f.write(f'P6\n{w} {h}\n255\n'.encode())
    for y in range(h):
        t=y/(h-1)
        r=int(219*(1-t)+235*t)
        g=int(228*(1-t)+239*t)
        b=int(238*(1-t)+247*t)
        f.write(bytes([r,g,b])*w)
PYBG
DISPLAY=:1 feh --bg-fill /tmp/trooper-bg.ppm >/var/log/feh-desktop.log 2>&1 || DISPLAY=:1 xsetroot -solid '#dbe4ee'

nohup openbox > /var/log/openbox.log 2>&1 &
sleep 1
nohup lxqt-panel > /var/log/lxqt-panel.log 2>&1 &
sleep 1

# Create a few reliable launchers/shortcuts so the desktop is actually usable.
mkdir -p /root/Desktop /root/.local/share/applications
cat > /root/Desktop/Terminal.desktop << 'DESK1'
[Desktop Entry]
Type=Application
Name=Terminal
Exec=xterm -fa Monospace -fs 11
Icon=utilities-terminal
Terminal=false
DESK1
cat > /root/Desktop/Browser.desktop << 'DESK2'
[Desktop Entry]
Type=Application
Name=Browser
Exec=/opt/chrome-wrapper.sh
Icon=google-chrome
Terminal=false
DESK2
cat > /root/Desktop/Workspace.desktop << 'DESK3'
[Desktop Entry]
Type=Application
Name=Workspace
Exec=pcmanfm-qt /home/node/.openclaw/workspace
Icon=folder
Terminal=false
DESK3
chmod +x /root/Desktop/*.desktop

# Always launch one visible terminal so the desktop never looks dead.
nohup xterm -hold -geometry 100x28+80+60 -fa Monospace -fs 11 -bg '#111827' -fg '#e5e7eb' -e /bin/bash -lc "echo Trooper Desktop Ready; echo; echo '- Use the desktop shortcuts for Browser / Workspace / Terminal.'; echo '- If panel/icons are missing, the session is still alive.'; echo; exec bash" > /var/log/xterm-desktop.log 2>&1 &
sleep 1

nohup x11vnc -display :1 -forever -nopw -shared -rfbport 5901 -noxdamage \
 -o /var/log/x11vnc-desktop.log -quiet > /dev/null 2>&1 &
sleep 1
nohup websockify --web=/usr/share/novnc 6081 localhost:5901 > /var/log/websockify-desktop.log 2>&1 &

systemctl start trooper-agent-daemon 2>/dev/null || true

echo 'Desktop started on :1, noVNC on port 6081'
exit 0
DSTART
chmod +x /usr/local/bin/trooper-desktop-start

# Desktop stop script
cat > /usr/local/bin/trooper-desktop-stop << 'DSTOP'
#!/bin/bash
systemctl stop trooper-agent-daemon 2>/dev/null || true
pkill -f "websockify.*6081" 2>/dev/null || true
pkill -f "x11vnc.*5901" 2>/dev/null || true
pkill -f "pcmanfm-qt" 2>/dev/null || true
pkill -f "lxqt-panel" 2>/dev/null || true
pkill -f "lxqt-session" 2>/dev/null || true
pkill -f "openbox" 2>/dev/null || true
pkill -f "Xvfb :1" 2>/dev/null || true
# Kill the shared dbus session
DBUS_PID="$(grep DBUS_SESSION_BUS_PID /tmp/dbus-desktop-env 2>/dev/null | cut -d= -f2 | tr -d "'\"; ")"
[ -n "$DBUS_PID" ] && kill "$DBUS_PID" 2>/dev/null || true
rm -f /tmp/dbus-desktop-env
echo "Desktop stopped"
DSTOP
chmod +x /usr/local/bin/trooper-desktop-stop

# ── Self-hosted management scripts ──
cat > /usr/local/bin/trooper-update << 'CUPDATE'
#!/bin/bash
set -e
echo "Updating Trooper services..."
cd /opt/openclaw
echo "Pulling latest Docker images..."
docker compose pull
echo "Restarting Docker containers..."
docker compose down
docker compose up -d
echo "Restarting bridge..."
systemctl restart openclaw-bridge 2>/dev/null || true
echo "Restarting Caddy..."
systemctl restart caddy 2>/dev/null || true
# Wait for bridge health
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:${BRIDGE_PORT:-3002}/health | grep -q ok 2>/dev/null; then
    echo "Bridge healthy after ${i}s"
    break
  fi
  sleep 1
done
echo "Update complete."
CUPDATE
chmod +x /usr/local/bin/trooper-update

cat > /usr/local/bin/trooper-restart << 'CRESTART'
#!/bin/bash
set -e
echo "Restarting Trooper services..."
systemctl restart openclaw-docker 2>/dev/null || (cd /opt/openclaw && docker compose down && docker compose up -d)
systemctl restart openclaw-bridge 2>/dev/null || true
systemctl restart trooper-org-runtime 2>/dev/null || true
systemctl restart caddy 2>/dev/null || true
echo "Restart complete. Checking health..."
sleep 3
if curl -sf http://127.0.0.1:${BRIDGE_PORT:-3002}/health | grep -q ok 2>/dev/null; then
  echo "Bridge: HEALTHY"
else
  echo "Bridge: NOT READY (may need a few more seconds)"
fi
CRESTART
chmod +x /usr/local/bin/trooper-restart

cat > /usr/local/bin/trooper-status << 'CSTATUS'
#!/bin/bash
echo "=== Trooper Service Status ==="
echo ""
for svc in openclaw-docker openclaw-bridge trooper-org-runtime caddy openclaw-vnc openclaw-poller; do
  STATUS=$(systemctl is-active "$svc" 2>/dev/null || echo "not-found")
  printf "  %-25s %s\n" "$svc" "$STATUS"
done
echo ""
echo "=== Docker Containers ==="
docker ps --format "  {{.Names}}\t{{.Status}}" 2>/dev/null || echo "  (docker not available)"
echo ""
echo "=== Bridge Health ==="
curl -sf http://127.0.0.1:${BRIDGE_PORT:-3002}/health 2>/dev/null | python3 -m json.tool 2>/dev/null || echo "  Bridge not responding"
echo ""
echo "=== Disk Usage ==="
df -h / | tail -1 | awk '{print "  Used: "$3" / "$2"  ("$5" full)  Available: "$4}'
CSTATUS
chmod +x /usr/local/bin/trooper-status

# Desktop control API — Node.js HTTP server on port 4567
mkdir -p /opt/trooper-desktop-api
cat > /opt/trooper-desktop-api/server.mjs << 'JSEOF'
import http from 'http';
import net from 'net';
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
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const portOpen = (port, host = '127.0.0.1', timeout = 800) => new Promise((resolve) => {
 const socket = net.createConnection({ port, host });
 let settled = false;
 const finish = (ok) => {
 if (settled) return;
 settled = true;
 socket.destroy();
 resolve(ok);
 };
 socket.setTimeout(timeout);
 socket.once('connect', () => finish(true));
 socket.once('timeout', () => finish(false));
 socket.once('error', () => finish(false));
 socket.once('close', () => finish(false));
});

async function desktopReadiness() {
 const [novnc, vnc, panel, novncPort, vncPort] = await Promise.all([
 running('websockify.*6081'),
 running('x11vnc.*5901'),
 running('lxqt-panel'),
 portOpen(6081),
 portOpen(5901),
 ]);
 return {
 novnc,
 vnc,
 panel,
 novncPort,
 vncPort,
 active: novnc && vnc && novncPort && vncPort,
 };
}

http.createServer(async (req, res) => {
 res.setHeader('Content-Type', 'application/json');
 res.setHeader('Access-Control-Allow-Origin', '*');
 const url = new URL(req.url, `http://localhost`);
 try {
 if (req.method === 'POST' && url.pathname === '/desktop/start') {
 await run('/usr/local/bin/trooper-desktop-start');
 let readiness = await desktopReadiness();
 if (!readiness.active) {
 const deadline = Date.now() + 15000;
 while (Date.now() < deadline && !readiness.active) {
 await sleep(500);
 readiness = await desktopReadiness();
 }
 }
 res.end(JSON.stringify({ ok: true, ready: readiness.active, ...readiness }));
 } else if (req.method === 'POST' && url.pathname === '/desktop/stop') {
 await run('/usr/local/bin/trooper-desktop-stop');
 res.end(JSON.stringify({ ok: true }));
 } else if (req.method === 'GET' && url.pathname === '/desktop/status') {
 const readiness = await desktopReadiness();
 res.end(JSON.stringify(readiness));
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
}).listen(PORT, '127.0.0.1', () => console.log(`[desktop-api] :${PORT} (localhost only)`));
JSEOF
echo "[setup] Desktop control API written"

# Agent Daemon — Unix socket server for desktop exec (OpenClaw native integration)
mkdir -p /opt/trooper-agent-daemon
curl -fsSL "https://raw.githubusercontent.com/absurdfounder/openclawbridge/main/agent-daemon.mjs" -o /opt/trooper-agent-daemon/agent-daemon.mjs 2>/dev/null || true
if [ -s /opt/trooper-agent-daemon/agent-daemon.mjs ]; then
  chmod +x /opt/trooper-agent-daemon/agent-daemon.mjs
  cat > /etc/systemd/system/trooper-agent-daemon.service << 'AGENTDAEMON'
[Unit]
Description=Trooper Agent Daemon (desktop exec)
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/trooper-agent-daemon/agent-daemon.mjs
Environment=WORKSPACE_DIR=/opt/openclaw-data/workspace
Environment=AGENT_DAEMON_SOCKET=/var/run/openclaw/agent-daemon.sock
Environment=DISPLAY=:1
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
AGENTDAEMON
  systemctl enable trooper-agent-daemon
  echo "[setup] Agent Daemon installed"
fi

# Install Playwright for VPS browser server
if [ "$FROM_SNAPSHOT" != "1" ]; then
cd /opt/trooper-desktop-api
npm init -y 2>/dev/null
npm install playwright 2>/dev/null || true
echo "[setup] Playwright installed"
fi # end FROM_SNAPSHOT != 1 (Playwright)

# Playwright browser server — launches Chromium on :1, exposes WS for Render backend
cat > /opt/trooper-desktop-api/playwright-server.mjs << 'PWEOF'
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
 -O /usr/local/share/trooper-wallpaper.jpg 2>/dev/null || true

# (pcmanfm + lxqt + icon configs already pre-seeded above)

# (desktop icons + openbox menu already pre-seeded above)

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

# ── [7b/9] Trooper org runtime install ─────────────────────────────
dlog "Preparing Trooper org runtime..."
mkdir -p /opt/trooper-org-runtime /var/lib/trooper-org-runtime

dlog "Installing Trooper org runtime..."
if [ "${TROOPER_SNAPSHOT_BUILD:-0}" = "1" ]; then
  echo "[setup] TROOPER_SNAPSHOT_BUILD=1 - skipping per-org runtime install (boot.sh re-fetches at customer boot)"
  mkdir -p /opt/trooper-org-runtime/server/org-runtime
  printf 'snapshot-build-placeholder\n' > /opt/trooper-org-runtime/.snapshot-builder
  cat > /opt/trooper-org-runtime/server/package.json <<'PKG'
{"name":"trooper-org-runtime-snapshot-placeholder","version":"0.0.0","private":true}
PKG
  cat > /opt/trooper-org-runtime/server/org-runtime/index.js <<'RUNTIMEJS'
const http = require('http');
const port = Number(process.env.ORG_RUNTIME_PORT || process.env.PORT || 3101);
http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', snapshotPlaceholder: true }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'snapshot-placeholder' }));
}).listen(port, '127.0.0.1');
RUNTIMEJS
  cat > /opt/trooper-org-runtime/server/index.js <<'SERVERJS'
const http = require('http');
const port = Number(process.env.PORT || 3001);
http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', snapshotPlaceholder: true }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'snapshot-placeholder' }));
}).listen(port, '127.0.0.1');
SERVERJS
else
  if { [ -z "${TROOPER_RUNTIME_TARBALL_URL:-}" ] || [ "${TROOPER_RUNTIME_TARBALL_URL}" = "{{TROOPER_RUNTIME_TARBALL_URL}}" ]; } && [ -s /tmp/trooper-runtime-url ]; then
    _recovered_runtime_url="$(tr -d '\r\n' < /tmp/trooper-runtime-url)"
    if [ -n "$_recovered_runtime_url" ] && [ "$_recovered_runtime_url" != "{{TROOPER_RUNTIME_TARBALL_URL}}" ]; then
      TROOPER_RUNTIME_TARBALL_URL="$_recovered_runtime_url"
      echo "[setup] Runtime bundle URL recovered from /tmp/trooper-runtime-url"
    else
      echo "[setup] Runtime bundle marker was present but unusable"
    fi
  fi

  if [ -n "${TROOPER_RUNTIME_TARBALL_URL:-}" ] && [ "${TROOPER_RUNTIME_TARBALL_URL}" != "{{TROOPER_RUNTIME_TARBALL_URL}}" ]; then
    dlog "Downloading Trooper org runtime bundle..."
    echo "[setup] Runtime bundle URL: ${TROOPER_RUNTIME_TARBALL_URL}"
    if [[ "$TROOPER_RUNTIME_TARBALL_URL" == https://api.github.com/repos/*/releases/assets/* ]]; then
      curl -fsSL -H "Accept: application/octet-stream" "$TROOPER_RUNTIME_TARBALL_URL" -o /tmp/trooper-org-runtime.tar.gz || { echo "ERROR: failed to download runtime bundle from ${TROOPER_RUNTIME_TARBALL_URL}" >&2; exit 1; }
    else
      curl -fsSL "$TROOPER_RUNTIME_TARBALL_URL" -o /tmp/trooper-org-runtime.tar.gz || { echo "ERROR: failed to download runtime bundle from ${TROOPER_RUNTIME_TARBALL_URL}" >&2; exit 1; }
    fi
    tar -xzf /tmp/trooper-org-runtime.tar.gz -C /opt/trooper-org-runtime --strip-components=1 || { echo "ERROR: failed to extract runtime bundle" >&2; exit 1; }
    dlog "Trooper org runtime installed from bundle"
  elif git clone --depth 1 https://github.com/absurdfounder/Trooper.git /tmp/trooper-clone 2>/dev/null; then
    cp -r /tmp/trooper-clone/server /opt/trooper-org-runtime/
    rm -rf /tmp/trooper-clone
    dlog "Trooper org runtime cloned from GitHub"
  else
    echo "ERROR: failed to install Trooper org runtime from bundle or git" >&2
    exit 1
  fi
fi

if [ ! -f /opt/trooper-org-runtime/server/package.json ] || [ ! -f /opt/trooper-org-runtime/server/org-runtime/index.js ]; then
  echo "ERROR: runtime files missing after install" >&2
  exit 1
fi

dlog "Installing Trooper org runtime dependencies..."
cd /opt/trooper-org-runtime/server
npm install --omit=dev >/tmp/trooper-org-runtime-npm.log 2>&1 || (tail -n 50 /tmp/trooper-org-runtime-npm.log; exit 1)
cd /opt/openclaw

cat > /etc/default/trooper-org-runtime << CRENV
ORG_RUNTIME_PORT=${TROOPER_RUNTIME_PORT}
ORG_RUNTIME_ORG_ID=${ORG_ID}
RUNTIME_AUTH_SECRET=${RUNTIME_AUTH_SECRET}
BRIDGE_AUTH_TOKEN=${BRIDGE_AUTH_TOKEN}
LOCAL_RUNTIME_DATA_DIR=${TROOPER_RUNTIME_DATA_DIR}
PREFER_LOCAL_RUNTIME_MEMORY=1
BRIDGE_URL=http://127.0.0.1:${BRIDGE_PORT}
PLATFORM_API_URL=${PLATFORM_API_URL}
FRONTEND_URL=https://app.trooper.so
CRENV

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
# Run as root: bridge needs write access to Docker volume files owned by uid 1000
# (paired.json, cron/jobs.json, auth-profiles.json). Running as host's node user
# (uid 996) fails with EACCES since container creates files as uid 1000 mode 600.
User=root
Group=root
WorkingDirectory=/opt/openclaw-bridge
ExecStart=/usr/bin/node /opt/openclaw-bridge/index.mjs
Restart=always
RestartSec=5
Environment=BRIDGE_PORT=${BRIDGE_PORT}
Environment=BRIDGE_AUTH_TOKEN=${BRIDGE_AUTH_TOKEN}
Environment=OPENCLAW_URL=http://127.0.0.1:${GATEWAY_PORT}
Environment=OPENCLAW_GATEWAY_TOKEN=${GATEWAY_TOKEN}
Environment=OPENCLAW_HOOK_TOKEN=oc-hook-${HOOK_TOKEN}
Environment=MISSION_CONTROL_URL=https://trooper-production.up.railway.app
Environment=ORG_ID=${ORG_ID}
Environment=TROOPER_SNAPSHOT_BUILD=${TROOPER_SNAPSHOT_BUILD:-0}
Environment=NODE_ENV=production
Environment=BROWSERBASE_API_KEY=${BROWSERBASE_API_KEY}
Environment=BROWSERBASE_PROJECT_ID=${BROWSERBASE_PROJECT_ID}

[Install]
WantedBy=multi-user.target
BSVC

# Trooper org runtime service
cat > /etc/systemd/system/trooper-org-runtime.service << CRUNTIME
[Unit]
Description=Trooper Org Runtime
After=network-online.target openclaw-bridge.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/trooper-org-runtime/server
EnvironmentFile=/etc/default/trooper-org-runtime
ExecStart=/usr/bin/node /opt/trooper-org-runtime/server/org-runtime/index.js
Restart=always
RestartSec=5
User=root
Group=root
StandardOutput=append:/var/log/trooper-org-runtime.log
StandardError=append:/var/log/trooper-org-runtime.log

[Install]
WantedBy=multi-user.target
CRUNTIME

# Trooper VPS server (local API for tasks, agents — proxies to Render for Firebase/auth)
cat > /etc/default/trooper-server << CSENV
PORT=3001
NODE_ENV=production
ORG_ID=${ORG_ID}
DEFAULT_ORG_ID=${ORG_ID}
RUNTIME_AUTH_SECRET=${RUNTIME_AUTH_SECRET}
OPENAI_API_KEY=${OPENAI_API_KEY}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
OPENROUTER_API_KEY=${OPENROUTER_API_KEY}
GEMINI_API_KEY=${GEMINI_API_KEY}
BRIDGE_URL=http://127.0.0.1:${BRIDGE_PORT}
BRIDGE_AUTH_TOKEN=${BRIDGE_AUTH_TOKEN}
BRIDGE_PORT=${BRIDGE_PORT}
OPENCLAW_GATEWAY_URL=http://127.0.0.1:${GATEWAY_PORT}
OPENCLAW_GATEWAY_TOKEN=${GATEWAY_TOKEN}
OPENCLAW_HOOK_TOKEN=oc-hook-${HOOK_TOKEN}
PLATFORM_API_URL=${PLATFORM_API_URL}
FRONTEND_URL=https://app.trooper.so
COMPOSIO_API_KEY=${COMPOSIO_API_KEY}
CSENV

cat > /etc/systemd/system/trooper-server.service << CSSVC
[Unit]
Description=Trooper Server (local API + task runner)
After=network-online.target openclaw-bridge.service openclaw-docker.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/trooper-org-runtime/server
EnvironmentFile=/etc/default/trooper-server
ExecStart=/usr/bin/node /opt/trooper-org-runtime/server/index.js
Restart=always
RestartSec=5
User=root
Group=root
StandardOutput=append:/var/log/trooper-server.log
StandardError=append:/var/log/trooper-server.log

[Install]
WantedBy=multi-user.target
CSSVC

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

# Pull-based update backstop. Installed from the checked-out bridge repo so
# snapshot bakes keep the exact script/unit versions for the baked commit.
if [ -f /opt/openclaw-bridge/scripts/check-update.sh ]; then
 install -m 0755 /opt/openclaw-bridge/scripts/check-update.sh /usr/local/bin/check-update.sh
 install -m 0644 /opt/openclaw-bridge/scripts/openclaw-updater.service /etc/systemd/system/openclaw-updater.service
 install -m 0644 /opt/openclaw-bridge/scripts/openclaw-updater.timer /etc/systemd/system/openclaw-updater.timer
else
 echo "[setup] openclaw updater assets missing; skipping pull-backstop install"
fi

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

const operatorScopes = [
 'operator.admin',
 'operator.read',
 'operator.write',
 'operator.pairing',
 'operator.approvals',
 'operator.talk.secrets',
];
const makeOperatorToken = () => ({
 token: crypto.randomBytes(32).toString('base64url'),
 role: 'operator',
 scopes: operatorScopes,
 createdAtMs: Date.now()
});
const paired = {};
paired[deviceId] = {
 deviceId, publicKey: pubB64,
 displayName: 'Trooper Bridge', platform: 'linux',
 role: 'operator', roles: ['operator'], scopes: operatorScopes, approvedScopes: operatorScopes,
 tokens: { operator: makeOperatorToken() },
 clientId: 'gateway-client', clientMode: 'backend',
 createdAtMs: Date.now(), approvedAtMs: Date.now(), approvedAt: Date.now(), approved: true, ts: Date.now()
};
paired[gwDeviceId] = {
 deviceId: gwDeviceId, publicKey: gwPubB64,
 displayName: 'Gateway Internal', platform: 'linux',
 role: 'operator', roles: ['operator'], scopes: operatorScopes, approvedScopes: operatorScopes,
 tokens: { operator: makeOperatorToken() },
 clientId: 'gateway-internal', clientMode: 'backend',
 createdAtMs: Date.now(), approvedAtMs: Date.now(), approvedAt: Date.now(), approved: true, ts: Date.now()
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
cat > /etc/systemd/system/trooper-desktop.service << 'DESKSVC'
[Unit]
Description=Trooper Desktop Environment (display :1)
After=network.target

[Service]
Type=oneshot
Environment=DISPLAY=:1
Environment=XDG_RUNTIME_DIR=/tmp/runtime-root
ExecStart=/usr/local/bin/trooper-desktop-start
ExecStop=/usr/local/bin/trooper-desktop-stop
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
DESKSVC

# Desktop Control API service (port 4567)
cat > /etc/systemd/system/trooper-desktop-api.service << DAPI
[Unit]
Description=Trooper Desktop Control API
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/trooper-desktop-api/server.mjs
Environment=GATEWAY_URL=https://${HTTPS_DOMAIN}
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
DAPI

# Playwright browser server service (port 3333)
cat > /etc/systemd/system/trooper-playwright.service << 'PWSVC'
[Unit]
Description=Trooper Playwright Browser Server
After=network.target trooper-desktop-api.service

[Service]
Type=simple
ExecStart=/usr/bin/node /opt/trooper-desktop-api/playwright-server.mjs
WorkingDirectory=/opt/trooper-desktop-api
Environment=DISPLAY=:1
Environment=XAUTHORITY=/root/.Xauthority
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
PWSVC

if [ ! -f /opt/trooper-org-runtime/server/org-runtime/index.js ]; then
  echo "ERROR: refusing to install trooper-org-runtime systemd service without runtime files" >&2
  exit 1
fi

run_cmd systemctl daemon-reload
run_cmd systemctl enable openclaw-docker openclaw-bridge trooper-org-runtime trooper-server openclaw-poller openclaw-vnc trooper-desktop trooper-desktop-api trooper-playwright
if [ -f /etc/systemd/system/openclaw-updater.timer ]; then
 run_cmd systemctl enable openclaw-updater.timer
fi

# ── [9/9] Start all services (single clean startup) ──────────────────
dlog "Starting services..."
# Kill the temporary log server so the real bridge can use the port
kill "$LOG_SERVER_PID" 2>/dev/null || true
sleep 1

# Start bridge immediately — binds in ~5s, minimizes log gap (provision.js polls port 3002)
run_cmd systemctl restart openclaw-bridge
sleep 2
if systemctl is-active --quiet openclaw-bridge; then
 echo "Bridge Service: RUNNING"
else
 echo "Bridge Service: NOT RUNNING"
 journalctl -u openclaw-bridge --no-pager -n 60 || true
 echo "FATAL: openclaw-bridge service failed to start"
 exit 1
fi

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

# Start org runtime, poller, VNC, desktop API, playwright (bridge already running)
run_cmd systemctl start trooper-org-runtime
run_cmd systemctl start trooper-server
run_cmd systemctl start openclaw-poller
run_cmd systemctl start openclaw-vnc
run_cmd systemctl start trooper-desktop
run_cmd systemctl start trooper-desktop-api
run_cmd systemctl start trooper-playwright
run_cmd systemctl restart caddy 2>/dev/null || true

# ── Security hardening ──
dlog "Configuring firewall and permissions..."

# Firewall: only allow SSH (22), HTTP (80), HTTPS (443) from the internet.
# All other ports (3002 bridge, 5999 VNC, 6080 noVNC, 18789 gateway, 4567 desktop API)
# are blocked from external access — only accessible via localhost or Caddy reverse proxy.
if command -v ufw &> /dev/null; then
  ufw --force reset >/dev/null 2>&1
  ufw default deny incoming >/dev/null 2>&1
  ufw default allow outgoing >/dev/null 2>&1
  ufw allow 22/tcp >/dev/null 2>&1      # SSH
  ufw allow 80/tcp >/dev/null 2>&1      # HTTP (Caddy redirect)
  ufw allow 443/tcp >/dev/null 2>&1     # HTTPS (Caddy)
  ufw allow ${BRIDGE_PORT}/tcp >/dev/null 2>&1  # Bridge API (has its own auth via BRIDGE_AUTH_TOKEN)
  ufw --force enable >/dev/null 2>&1
  echo "Firewall: enabled (22, 80, 443, ${BRIDGE_PORT} open; VNC/gateway/desktop blocked)"
else
  apt-get install -y -qq ufw >/dev/null 2>&1
  ufw --force reset >/dev/null 2>&1
  ufw default deny incoming >/dev/null 2>&1
  ufw default allow outgoing >/dev/null 2>&1
  ufw allow 22/tcp >/dev/null 2>&1
  ufw allow 80/tcp >/dev/null 2>&1
  ufw allow 443/tcp >/dev/null 2>&1
  ufw allow ${BRIDGE_PORT}/tcp >/dev/null 2>&1
  ufw --force enable >/dev/null 2>&1
  echo "Firewall: installed and enabled"
fi

# Fix file permissions. Keep them consistent with the runtime bootstrap and the
# host bridge access model: config dirs must stay traversable, config JSON must
# stay readable, and devices/cron state must remain writable for temp-file
# replacement flows used by the gateway.
chmod 600 /opt/openclaw/.env 2>/dev/null || true
find /opt/openclaw-data/config -type d -exec chmod 755 {} \; 2>/dev/null || true
chmod 664 /opt/openclaw-data/config/openclaw.json 2>/dev/null || true
chmod 664 /opt/openclaw-data/config/agents/main/agent/auth-profiles.json 2>/dev/null || true
chmod 664 /opt/openclaw-data/config/auth-profiles.json 2>/dev/null || true
chmod 777 /opt/openclaw-data/config/devices 2>/dev/null || true
chmod 666 /opt/openclaw-data/config/devices/*.json 2>/dev/null || true
chmod 777 /opt/openclaw-data/config/cron 2>/dev/null || true
chmod 666 /opt/openclaw-data/config/cron/*.json 2>/dev/null || true
chmod 777 /opt/openclaw-data/config/cron/runs 2>/dev/null || true
echo "File permissions: aligned for runtime + bridge access"

# Configure unattended-upgrades for automatic security updates
cat > /etc/apt/apt.conf.d/50unattended-upgrades << 'UUCFG'
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}-security";
    "${distro_id}ESMApps:${distro_codename}-apps-security";
};
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
UUCFG
cat > /etc/apt/apt.conf.d/20auto-upgrades << 'AUOCFG'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
AUOCFG
echo "Unattended security upgrades: configured"

dlog "Security hardening complete"

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

if systemctl is-active --quiet trooper-org-runtime; then
 echo "Org Runtime: RUNNING"
else
 echo "Org Runtime: NOT RUNNING"
 journalctl -u trooper-org-runtime --no-pager -n 20 || true
fi

_org_runtime_ready=0
for i in $(seq 1 90); do
 if curl -sf http://127.0.0.1:${TROOPER_RUNTIME_PORT}/health >/dev/null 2>&1; then
 echo "Org Runtime Local Health: OK (ready after $((i * 2))s)"
 _org_runtime_ready=1
 break
 fi
 if ! systemctl is-active --quiet trooper-org-runtime; then
 echo "Org Runtime: NOT RUNNING DURING HEALTH WAIT"
 journalctl -u trooper-org-runtime --no-pager -n 60 || true
 echo "FATAL: trooper-org-runtime service exited before local health became ready"
 exit 1
 fi
 sleep 2
done
if [ "$_org_runtime_ready" -eq 0 ]; then
 echo "Org Runtime Local Health: FAILED"
 journalctl -u trooper-org-runtime --no-pager -n 60 || true
 echo "FATAL: trooper-org-runtime local health did not become ready after 180s"
 exit 1
fi

if curl -sf https://${HTTPS_DOMAIN}/runtime-api/health >/dev/null 2>&1 || curl -sf https://${SSLIP_DOMAIN}/runtime-api/health >/dev/null 2>&1; then
 echo "Org Runtime Public Health: OK"
else
 echo "Org Runtime Public Health: PENDING (TLS may still be provisioning — backend will retry)"
fi

# Kill the background raw log pusher — setup is done, no need to keep POSTing to API
if [ -n "${RAW_LOG_PUSHER_PID:-}" ]; then
  kill "$RAW_LOG_PUSHER_PID" 2>/dev/null || true
  echo "Raw log pusher stopped (PID $RAW_LOG_PUSHER_PID)"
fi

# ── Security: scrub sensitive data from cloud-init and environment ──
# Cloud-init user data may contain CF_API_TOKEN and other secrets.
# Remove it so VPS operators can't read it after setup.
echo "Scrubbing sensitive cloud-init data..."
rm -f /var/lib/cloud/instance/user-data.txt 2>/dev/null || true
rm -f /var/lib/cloud/instance/scripts/runcmd 2>/dev/null || true
rm -f /var/lib/cloud/instance/scripts/part-001 2>/dev/null || true
# Clear the CF token from this process's environment (it's only needed during setup)
unset CF_API_TOKEN 2>/dev/null || true
echo "Sensitive data scrubbed"

# ── Deploy-complete callback ──
# Notify Trooper central API that setup is finished so it can run post-install
# finalization (DNS, workspace push, API keys) without polling for 30 minutes.
if [ -n "${API_URL:-}" ] && [ -n "${ORG_ID:-}" ] && [ -n "${GATEWAY_TOKEN:-}" ]; then
  _my_ip=$(curl -sf --max-time 5 ifconfig.me 2>/dev/null || echo "")
  dlog "Sending deploy-complete callback to ${API_URL}..."
  for _cb_attempt in 1 2 3 4 5; do
    _cb_status=$(curl -sf -X POST "${API_URL}/api/deploy-complete/${ORG_ID}" \
      -H "Content-Type: application/json" \
      -d "{\"ip\":\"${_my_ip}\",\"bridgePort\":${BRIDGE_PORT},\"status\":\"ready\",\"token\":\"${GATEWAY_TOKEN}\"}" \
      --max-time 10 \
      -o /dev/null -w "%{http_code}" 2>/dev/null || echo "000")
    if [ "$_cb_status" = "200" ]; then
      dlog "Deploy-complete callback sent successfully"
      break
    fi
    dlog "Deploy-complete callback failed (HTTP ${_cb_status}, attempt ${_cb_attempt}/5), retrying in 5s..."
    sleep 5
  done
else
  echo "Skipping deploy-complete callback (API_URL, ORG_ID, or GATEWAY_TOKEN not set)"
fi

if [ "${TROOPER_SNAPSHOT_BUILD:-0}" = "1" ]; then
  echo "[setup] Preparing snapshot image for reusable first boot..."
  cat > /usr/local/sbin/trooper-snapshot-firstboot-guard.sh <<'SNAPGUARD'
#!/usr/bin/env bash
set -euo pipefail

if [ ! -f /opt/trooper-org-runtime/.snapshot-builder ]; then
  systemctl disable trooper-snapshot-firstboot-guard.service >/dev/null 2>&1 || true
  exit 0
fi

echo "[snapshot-firstboot] Clearing baked setup markers before customer cloud-init"
rm -f /tmp/openclaw-setup-complete /opt/openclaw-bridge/.setup-complete 2>/dev/null || true
systemctl stop openclaw-bridge trooper-org-runtime trooper-server openclaw-poller openclaw-vnc trooper-desktop trooper-desktop-api trooper-playwright 2>/dev/null || true
systemctl disable trooper-snapshot-firstboot-guard.service >/dev/null 2>&1 || true
SNAPGUARD
  chmod +x /usr/local/sbin/trooper-snapshot-firstboot-guard.sh
  cat > /etc/systemd/system/trooper-snapshot-firstboot-guard.service <<'SNAPGUARDSVC'
[Unit]
Description=Trooper snapshot first-boot guard
DefaultDependencies=no
After=local-fs.target
Before=network-pre.target cloud-init-local.service cloud-init.service openclaw-bridge.service trooper-org-runtime.service trooper-server.service openclaw-poller.service
ConditionPathExists=/opt/trooper-org-runtime/.snapshot-builder

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/trooper-snapshot-firstboot-guard.sh

[Install]
WantedBy=multi-user.target
SNAPGUARDSVC
  systemctl enable trooper-snapshot-firstboot-guard.service >/dev/null 2>&1 || true
  rm -f /tmp/deploy.log /tmp/deploy-raw.log /tmp/trooper-setup-failed 2>/dev/null || true
  rm -f /var/log/cloud-init.log /var/log/cloud-init-output.log 2>/dev/null || true
  rm -f /var/lib/cloud/instance/user-data.txt 2>/dev/null || true
  rm -f /var/lib/cloud/instance/scripts/runcmd 2>/dev/null || true
  rm -f /var/lib/cloud/instance/scripts/part-001 2>/dev/null || true
  rm -rf /var/lib/cloud/instances/* /var/lib/cloud/instance /var/lib/cloud/sem/* 2>/dev/null || true
  if command -v cloud-init >/dev/null 2>&1; then
    cloud-init clean --logs --machine-id >/dev/null 2>&1 || cloud-init clean --logs >/dev/null 2>&1 || true
  fi
  : > /etc/machine-id 2>/dev/null || true
  rm -f /var/lib/dbus/machine-id 2>/dev/null || true
  sync 2>/dev/null || true
  echo "[setup] Snapshot image prepared for cloud-init rerun on cloned servers"
fi

# Signal to bridge that setup is complete (bridge /health transitions from 'installing' → 'ok')
# /tmp marker is ephemeral; /opt marker persists across reboots. For snapshot
# builds this happens only after cloud-init and first-boot cleanup are complete.
touch /tmp/openclaw-setup-complete
touch /opt/openclaw-bridge/.setup-complete

echo done
