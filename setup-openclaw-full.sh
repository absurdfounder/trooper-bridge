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
CAPTCHA_2CAPTCHA_API_KEY="{{CAPTCHA_2CAPTCHA_API_KEY}}"
COMPOSIO_API_KEY="{{COMPOSIO_API_KEY}}"
PRIMARY_PROVIDER="{{PRIMARY_PROVIDER}}"
PRIMARY_MODEL="{{PRIMARY_MODEL}}"

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

# Configure Docker daemon for reliability (overlay2 + write buffer settings)
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
sleep 2

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
 handle_path /vnc/* {
 reverse_proxy 127.0.0.1:6080
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

# ── [4/9] Model Routing ────────────────────────────────────────────
# Determine which AI model provider and model to use based on available API keys.
# Priority: user-specified > anthropic > openai > gemini > openrouter
dlog "Configuring model routing..." "model-routing"

resolve_primary_model() {
 # If user explicitly specified provider + model, use that
 if [ -n "${PRIMARY_PROVIDER:-}" ] && [ "${PRIMARY_PROVIDER}" != "{{PRIMARY_PROVIDER}}" ] && \
    [ -n "${PRIMARY_MODEL:-}" ] && [ "${PRIMARY_MODEL}" != "{{PRIMARY_MODEL}}" ]; then
  echo "${PRIMARY_PROVIDER}/${PRIMARY_MODEL}"
  return
 fi

 # If user specified provider but not model, pick best model for that provider
 local provider="${PRIMARY_PROVIDER:-}"
 if [ -n "$provider" ] && [ "$provider" != "{{PRIMARY_PROVIDER}}" ]; then
  case "$provider" in
   anthropic) echo "anthropic/claude-sonnet-4-5"; return ;;
   openai)    echo "openai/gpt-5.2"; return ;;
   gemini)    echo "google/gemini-2.5-pro"; return ;;
   openrouter) echo "openrouter/anthropic/claude-sonnet-4-5"; return ;;
  esac
 fi

 # Auto-detect from available API keys (priority: anthropic > openai > gemini > openrouter)
 if [ -n "${ANTHROPIC_API_KEY:-}" ] && [ "${ANTHROPIC_API_KEY}" != "{{ANTHROPIC_API_KEY}}" ]; then
  echo "anthropic/claude-sonnet-4-5"
 elif [ -n "${OPENAI_API_KEY:-}" ] && [ "${OPENAI_API_KEY}" != "{{OPENAI_API_KEY}}" ]; then
  echo "openai/gpt-5.2"
 elif [ -n "${GEMINI_API_KEY:-}" ] && [ "${GEMINI_API_KEY}" != "{{GEMINI_API_KEY}}" ]; then
  echo "google/gemini-2.5-pro"
 elif [ -n "${OPENROUTER_API_KEY:-}" ] && [ "${OPENROUTER_API_KEY}" != "{{OPENROUTER_API_KEY}}" ]; then
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
if [ -n "${ANTHROPIC_API_KEY:-}" ] && [ "${ANTHROPIC_API_KEY}" != "{{ANTHROPIC_API_KEY}}" ]; then
 build_fallback "anthropic/claude-sonnet-4-5"
fi
if [ -n "${OPENAI_API_KEY:-}" ] && [ "${OPENAI_API_KEY}" != "{{OPENAI_API_KEY}}" ]; then
 build_fallback "openai/gpt-5.2"
fi
if [ -n "${GEMINI_API_KEY:-}" ] && [ "${GEMINI_API_KEY}" != "{{GEMINI_API_KEY}}" ]; then
 build_fallback "google/gemini-2.5-pro"
fi
if [ -n "${OPENROUTER_API_KEY:-}" ] && [ "${OPENROUTER_API_KEY}" != "{{OPENROUTER_API_KEY}}" ]; then
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

# .env for docker compose — pass all available provider keys
cat > /opt/openclaw/.env << ENV
OPENCLAW_IMAGE=openclaw:local
OPENCLAW_GATEWAY_PORT=0.0.0.0:${GATEWAY_PORT}
OPENCLAW_BRIDGE_PORT=127.0.0.1:18790
OPENCLAW_GATEWAY_BIND=127.0.0.1
OPENCLAW_CONFIG_DIR=/opt/openclaw-data/config
OPENCLAW_WORKSPACE_DIR=/opt/openclaw-data/workspace
OPENCLAW_GATEWAY_TOKEN=${GATEWAY_TOKEN}
BRAVE_API_KEY=${BRAVE_API_KEY}
CAPTCHA_2CAPTCHA_API_KEY=${CAPTCHA_2CAPTCHA_API_KEY}
COMPOSIO_API_KEY=${COMPOSIO_API_KEY}
CLAUDE_AI_SESSION_KEY=
CLAUDE_WEB_SESSION_KEY=
CLAUDE_WEB_COOKIE=
ENV

# Conditionally add provider API keys to .env (only if set)
[ -n "${OPENAI_API_KEY:-}" ] && [ "${OPENAI_API_KEY}" != "{{OPENAI_API_KEY}}" ] && echo "OPENAI_API_KEY=${OPENAI_API_KEY}" >> /opt/openclaw/.env
[ -n "${ANTHROPIC_API_KEY:-}" ] && [ "${ANTHROPIC_API_KEY}" != "{{ANTHROPIC_API_KEY}}" ] && echo "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}" >> /opt/openclaw/.env
[ -n "${GEMINI_API_KEY:-}" ] && [ "${GEMINI_API_KEY}" != "{{GEMINI_API_KEY}}" ] && echo "GEMINI_API_KEY=${GEMINI_API_KEY}" >> /opt/openclaw/.env
[ -n "${OPENROUTER_API_KEY:-}" ] && [ "${OPENROUTER_API_KEY}" != "{{OPENROUTER_API_KEY}}" ] && echo "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" >> /opt/openclaw/.env

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

if [ -n "${ANTHROPIC_API_KEY:-}" ] && [ "${ANTHROPIC_API_KEY}" != "{{ANTHROPIC_API_KEY}}" ]; then
 add_provider '   "anthropic": {
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

if [ -n "${OPENAI_API_KEY:-}" ] && [ "${OPENAI_API_KEY}" != "{{OPENAI_API_KEY}}" ]; then
 add_provider '   "openai": {
    "baseUrl": "https://api.openai.com/v1",
    "api": "openai-completions",
    "models": [
     { "id": "gpt-5.2", "name": "GPT-5.2", "contextWindow": 128000 },
     { "id": "gpt-5.0", "name": "GPT-5.0", "contextWindow": 128000 }
    ]
   }'
fi

if [ -n "${GEMINI_API_KEY:-}" ] && [ "${GEMINI_API_KEY}" != "{{GEMINI_API_KEY}}" ]; then
 add_provider '   "google": {
    "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
    "api": "google-generative-ai",
    "models": [
     { "id": "gemini-2.5-pro", "name": "Gemini 2.5 Pro", "contextWindow": 1000000 },
     { "id": "gemini-2.5-flash", "name": "Gemini 2.5 Flash", "contextWindow": 1000000 }
    ]
   }'
fi

if [ -n "${OPENROUTER_API_KEY:-}" ] && [ "${OPENROUTER_API_KEY}" != "{{OPENROUTER_API_KEY}}" ]; then
 add_provider '   "openrouter": {
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
 MODELS_PROVIDERS='   "anthropic": {
    "baseUrl": "https://api.anthropic.com",
    "api": "anthropic-messages",
    "models": [
     { "id": "claude-sonnet-4-5", "name": "Claude Sonnet 4.5", "contextWindow": 200000 }
    ]
   }'
fi

# Resolve memorySearch config — always use OpenRouter for embeddings (platform key)
if [ -n "${OPENROUTER_API_KEY:-}" ] && [ "${OPENROUTER_API_KEY}" != "{{OPENROUTER_API_KEY}}" ]; then
 MEMORY_SEARCH_JSON='"memorySearch": { "enabled": true, "provider": "openai", "model": "text-embedding-3-small", "remote": { "baseUrl": "https://openrouter.ai/api/v1/", "apiKey": "'"${OPENROUTER_API_KEY}"'" } }'
elif [ -n "${OPENAI_API_KEY:-}" ] && [ "${OPENAI_API_KEY}" != "{{OPENAI_API_KEY}}" ]; then
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
 "sandbox": {
 "mode": "off"
 }
 }
 ],
 "defaults": {
 "model": { "primary": "${RESOLVED_MODEL}"${FALLBACKS_JSON} },
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
 "model": "${RESOLVED_MODEL}",
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
      - /opt/openclaw-data/2captcha-extension:/opt/openclaw-data/2captcha-extension:ro
    ports:
      - "127.0.0.1:5999:5999"
    group_add:
      - "${DOCKER_GID}"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    environment:
      OPENAI_API_KEY: \${OPENAI_API_KEY:-}
      ANTHROPIC_API_KEY: \${ANTHROPIC_API_KEY:-}
      GEMINI_API_KEY: \${GEMINI_API_KEY:-}
      OPENROUTER_API_KEY: \${OPENROUTER_API_KEY:-}
      MISTRAL_API_KEY: \${MISTRAL_API_KEY:-}
      BRAVE_API_KEY: \${BRAVE_API_KEY}
      CHROME_PATH: /usr/bin/google-chrome-stable
      CHROMIUM_PATH: /usr/bin/google-chrome-stable
      PUPPETEER_EXECUTABLE_PATH: /usr/bin/google-chrome-stable
      OPENCLAW_BROWSER_EXECUTABLE: /usr/bin/google-chrome-stable
      CAPTCHA_2CAPTCHA_API_KEY: \${CAPTCHA_2CAPTCHA_API_KEY}
      COMPOSIO_API_KEY: \${COMPOSIO_API_KEY}
    user: "0:0"
    entrypoint: ["/bin/bash", "/opt/startup.sh"]
    command: ["${GATEWAY_PORT}"]
OVERRIDE

# Startup script that ensures Chrome + Xvfb are installed before starting the gateway
cat > /opt/openclaw-data/startup.sh << 'STARTUP'
#!/bin/bash
# Ensure Chrome is installed (survives container restarts)
# Uses curl (always available in node:22-bookworm) instead of wget
if ! command -v google-chrome-stable &>/dev/null; then
 echo "[startup] Chrome not found, installing..."
 dpkg --configure -a 2>/dev/null
 for _ca in 1 2 3; do
   if curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb; then
     apt-get update -qq 2>/dev/null
     dpkg -i /tmp/chrome.deb 2>/dev/null || apt-get install -y -f 2>/dev/null
     rm -f /tmp/chrome.deb
     echo "[startup] Chrome installed: $(google-chrome-stable --version 2>/dev/null || echo FAILED)"
     break
   fi
   echo "[startup] Chrome download attempt ${_ca} failed, retrying in 5s..."
   sleep 5
 done
else
 echo "[startup] Chrome already installed: $(google-chrome-stable --version 2>/dev/null)"
fi
# Ensure TigerVNC is installed (Xvnc = virtual display + VNC server in one process)
# Replaces Xvfb — provides the display extensions need PLUS live VNC streaming to web app
if [ -n "${CAPTCHA_2CAPTCHA_API_KEY:-}" ] && ! command -v Xvnc &>/dev/null; then
 echo "[startup] Installing TigerVNC for display + VNC support..."
 apt-get update -qq 2>/dev/null && apt-get install -y -qq tigervnc-standalone-server 2>/dev/null
 echo "[startup] TigerVNC installed (Xvnc available)"
elif [ -n "${CAPTCHA_2CAPTCHA_API_KEY:-}" ]; then
 echo "[startup] TigerVNC already installed"
fi
# Install Composio CLI if API key is set and not already installed
if [ -n "${COMPOSIO_API_KEY:-}" ] && ! command -v composio &>/dev/null; then
 echo "[startup] Installing Composio CLI..."
 apt-get update -qq 2>/dev/null
 apt-get install -y -qq python3 python3-pip 2>/dev/null
 pip install --break-system-packages composio-core 2>/dev/null || pip install composio-core 2>/dev/null
 echo "[startup] Composio installed: $(composio --version 2>/dev/null || echo FAILED)"
elif [ -n "${COMPOSIO_API_KEY:-}" ]; then
 echo "[startup] Composio already installed: $(composio --version 2>/dev/null)"
fi
GATEWAY_PORT="${1:-18789}"
# Fix permissions: ensure node user can read config files
# (files may have been written by root via bridge or UI before container started)
chown -R 1000:1000 /home/node/.openclaw 2>/dev/null || true
chmod 700 /home/node/.openclaw 2>/dev/null || true
chmod 600 /home/node/.openclaw/openclaw.json 2>/dev/null || true
find /home/node/.openclaw/agents -name 'auth-profiles.json' -exec chmod 600 {} \; 2>/dev/null || true
# Drop back to node user for the gateway process
exec su -s /bin/bash node -c "node dist/index.js gateway --allow-unconfigured --bind lan --port $GATEWAY_PORT"
STARTUP
chmod +x /opt/openclaw-data/startup.sh

# Auth profiles — dynamically built from all available API keys
AUTH_PROFILES=""
AUTH_LASTGOOD=""
add_auth_profile() {
 local id="$1" provider="$2" key="$3"
 local entry="\"${id}\": { \"type\": \"api_key\", \"provider\": \"${provider}\", \"key\": \"${key}\" }"
 local lastgood="\"${provider}\": \"${id}\""
 if [ -z "$AUTH_PROFILES" ]; then
  AUTH_PROFILES="  $entry"
  AUTH_LASTGOOD="  $lastgood"
 else
  AUTH_PROFILES="${AUTH_PROFILES},
  $entry"
  AUTH_LASTGOOD="${AUTH_LASTGOOD},
  $lastgood"
 fi
}

if [ -n "${ANTHROPIC_API_KEY:-}" ] && [ "${ANTHROPIC_API_KEY}" != "{{ANTHROPIC_API_KEY}}" ]; then
 add_auth_profile "anthropic:default" "anthropic" "${ANTHROPIC_API_KEY}"
fi
if [ -n "${OPENAI_API_KEY:-}" ] && [ "${OPENAI_API_KEY}" != "{{OPENAI_API_KEY}}" ]; then
 add_auth_profile "openai:default" "openai" "${OPENAI_API_KEY}"
fi
if [ -n "${GEMINI_API_KEY:-}" ] && [ "${GEMINI_API_KEY}" != "{{GEMINI_API_KEY}}" ]; then
 add_auth_profile "google:default" "google" "${GEMINI_API_KEY}"
fi
if [ -n "${OPENROUTER_API_KEY:-}" ] && [ "${OPENROUTER_API_KEY}" != "{{OPENROUTER_API_KEY}}" ]; then
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

# ── 2Captcha extension (when API key is set) ─────────────────────────────
mkdir -p /opt/openclaw-data/2captcha-extension
if [ -n "${CAPTCHA_2CAPTCHA_API_KEY:-}" ]; then
  dlog "Configuring 2Captcha extension..."
  apt-get install -y -qq --no-install-recommends unzip 2>/dev/null || true
  curl -fsSL "https://github.com/rucaptcha/2captcha-solver/archive/refs/heads/main.zip" -o /tmp/2captcha-solver.zip
  unzip -o /tmp/2captcha-solver.zip -d /tmp/ 2>/dev/null || true
  if [ -d /tmp/2captcha-solver-main ]; then
    cp -r /tmp/2captcha-solver-main/* /opt/openclaw-data/2captcha-extension/ 2>/dev/null || true
    rm -rf /tmp/2captcha-solver.zip /tmp/2captcha-solver-main
    if [ -f /opt/openclaw-data/2captcha-extension/common/config.js ]; then
      sed -i "s|apiKey: null|apiKey: \"${CAPTCHA_2CAPTCHA_API_KEY}\"|" /opt/openclaw-data/2captcha-extension/common/config.js
    fi
    echo "[setup] 2Captcha extension configured"
  fi
fi

# Load 2Captcha extension via Chrome wrapper + Xvnc (extensions need a display context).
# Xvnc provides BOTH a virtual display AND a VNC server — enabling live browser view
# in the web app via noVNC. Also routes Chrome through 2captcha residential proxy
# so browsing comes from residential IPs (avoids Google/Cloudflare blocks).
if [ -n "${CAPTCHA_2CAPTCHA_API_KEY:-}" ] && [ -d /opt/openclaw-data/2captcha-extension ] && [ -n "$(ls -A /opt/openclaw-data/2captcha-extension 2>/dev/null)" ]; then
  cat > /opt/openclaw-data/chrome-wrapper.sh << 'CHROMEWRAP'
#!/bin/bash
# ── Xvnc: Virtual display + VNC server on :99 (port 5999) ──
# Xvnc replaces Xvfb — same virtual display but also serves VNC for live browser view
if ! pgrep -f "Xvnc :99" >/dev/null 2>&1; then
  Xvnc :99 -geometry 1920x1080 -depth 24 -rfbport 5999 -localhost \
    -SecurityTypes None -AlwaysShared -AcceptKeyEvents -AcceptPointerEvents &
  sleep 0.5
fi
export DISPLAY=:99

# ── Residential proxy via 2captcha (auto-detected from CAPTCHA_2CAPTCHA_API_KEY) ──
# Calls the 2captcha proxy API to get the proxy username, then routes ALL Chrome
# traffic through a residential IP to avoid bot detection by Google/Cloudflare/etc.
PROXY_ARGS=""
EXT_DIRS="/opt/openclaw-data/2captcha-extension"
PROXY_CACHE=/tmp/.2captcha-proxy-user
if [ -n "${CAPTCHA_2CAPTCHA_API_KEY:-}" ]; then
  # Fetch proxy username from 2captcha API (cached — only calls API once per container)
  if [ ! -f "$PROXY_CACHE" ]; then
    PROXY_USERNAME=$(curl -sf "https://api.2captcha.com/proxy?key=${CAPTCHA_2CAPTCHA_API_KEY}" 2>/dev/null \
      | grep -o '"username":"[^"]*"' | cut -d'"' -f4)
    if [ -n "$PROXY_USERNAME" ]; then
      echo "$PROXY_USERNAME" > "$PROXY_CACHE"
    fi
  fi
  PROXY_KEY=$(cat "$PROXY_CACHE" 2>/dev/null || echo "")

  if [ -n "$PROXY_KEY" ]; then
    # Generate fresh session ID for a new residential IP each Chrome launch
    SESSION_ID=$(head -c 12 /dev/urandom | base64 2>/dev/null | tr -dc 'a-zA-Z0-9' | head -c 9)
    PROXY_USER="${PROXY_KEY}-zone-custom-session-${SESSION_ID}-sessTime-120"
    PROXY_PASS="${PROXY_KEY}"
    PROXY_ARGS="--proxy-server=http://na.proxy.2captcha.com:2334"

    # Create a small MV3 extension that handles proxy authentication
    PROXY_EXT_DIR=/tmp/proxy-auth-ext
    mkdir -p "$PROXY_EXT_DIR"
    cat > "$PROXY_EXT_DIR/manifest.json" << 'PMANI'
{"manifest_version":3,"name":"Proxy Auth","version":"1.0","permissions":["webRequest","webRequestAuthProvider"],"host_permissions":["<all_urls>"],"background":{"service_worker":"background.js"}}
PMANI
    cat > "$PROXY_EXT_DIR/background.js" << PBGJS
chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    callback({ authCredentials: { username: "${PROXY_USER}", password: "${PROXY_PASS}" } });
  },
  { urls: ["<all_urls>"] },
  ["asyncBlocking"]
);
PBGJS
    EXT_DIRS="${EXT_DIRS},${PROXY_EXT_DIR}"
  fi
fi

exec /usr/bin/google-chrome-stable \
  --load-extension=${EXT_DIRS} \
  --disable-extensions-except=${EXT_DIRS} \
  --disable-blink-features=AutomationControlled \
  ${PROXY_ARGS} \
  "$@"
CHROMEWRAP
  chmod +x /opt/openclaw-data/chrome-wrapper.sh
  # Set headless:false so OpenClaw doesn't add --headless=new (wrapper uses Xvfb instead)
  sed -i 's|"headless": true|"headless": false|g' /opt/openclaw-data/config/openclaw.json
  # Mount the wrapper into the container and point config at it
  sed -i '/- \/opt\/openclaw-data\/2captcha-extension/a\      - /opt/openclaw-data/chrome-wrapper.sh:/opt/openclaw-data/chrome-wrapper.sh:ro' /opt/openclaw/docker-compose.override.yml
  sed -i 's|/usr/bin/google-chrome-stable|/opt/openclaw-data/chrome-wrapper.sh|g' /opt/openclaw-data/config/openclaw.json
  sed -i 's|/usr/bin/google-chrome-stable|/opt/openclaw-data/chrome-wrapper.sh|g' /opt/openclaw/docker-compose.override.yml
  echo "[setup] 2Captcha: Chrome wrapper + Xvfb configured (headful mode with virtual display)"
fi

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

# Check available disk space (need at least 4GB for Docker image + layers)
AVAIL_KB=$(df /var/lib/docker 2>/dev/null | tail -1 | awk '{print $4}')
AVAIL_GB=$((${AVAIL_KB:-0} / 1024 / 1024))
dlog "Disk available: ${AVAIL_GB}GB on /var/lib/docker"
if [ "${AVAIL_GB}" -lt 4 ] 2>/dev/null; then
  dlog "Low disk space (${AVAIL_GB}GB). Cleaning up Docker and apt caches..."
  docker system prune -a -f 2>/dev/null || true
  docker builder prune -a -f 2>/dev/null || true
  apt-get clean 2>/dev/null || true
  rm -rf /tmp/*.deb /var/cache/apt/archives/*.deb 2>/dev/null || true
fi

# Clean any stale/corrupted Docker state before first pull attempt
docker system prune -f 2>/dev/null || true

IMAGE_READY=false
for attempt in 1 2 3; do
  dlog "Docker pull attempt ${attempt}/3..."
  if docker pull --platform "${DOCKER_PLATFORM}" "${OPENCLAW_DOCKER_IMAGE}" 2>&1; then
    docker tag "${OPENCLAW_DOCKER_IMAGE}" openclaw:local
    dlog "Docker image ready (pull attempt ${attempt})"
    echo "Image pulled and tagged as openclaw:local"
    IMAGE_READY=true
    break
  fi
  dlog "Pull attempt ${attempt} failed"

  # The "failed to send write: must occur at current offset" error is overlay2
  # storage corruption. Fix: remove corrupted layers, restart Docker daemon.
  echo "Cleaning Docker state and restarting daemon (attempt ${attempt})..."
  docker system prune -a -f 2>/dev/null || true
  docker builder prune -a -f 2>/dev/null || true
  systemctl restart docker 2>/dev/null || true
  sleep $((attempt * 4))
done

if [ "$IMAGE_READY" = false ]; then
  dlog "All pull attempts failed, building from source..."
  echo "Pull failed after 3 attempts, falling back to local build..."
  for attempt in 1 2; do
    dlog "Docker build attempt ${attempt}/2..."
    if docker build --no-cache --build-arg OPENCLAW_DOCKER_APT_PACKAGES="wget gnupg fonts-liberation fonts-noto-color-emoji" -t openclaw:local .; then
      IMAGE_READY=true
      dlog "Docker image built from source (attempt ${attempt})"
      break
    fi
    dlog "Build attempt ${attempt} failed"
    docker system prune -a -f 2>/dev/null || true
    docker builder prune -a -f 2>/dev/null || true
    systemctl restart docker 2>/dev/null || true
    sleep $((attempt * 5))
  done
fi

if [ "$IMAGE_READY" = false ]; then
  dlog "FATAL: Could not pull or build Docker image after retries" "failed"
  echo "ERROR: Failed to obtain Docker image after multiple attempts."
  echo "Disk: ${AVAIL_GB}GB available. Check server disk health."
  exit 1
fi

dlog "Starting containers..."
# Start containers (clean up any partial state first)
docker compose down 2>/dev/null || true
docker compose up -d
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

# Wait for startup.sh to finish Chrome install (it runs as the container entrypoint)
dlog "Waiting for Chrome install in container..."
for _chrome_wait in $(seq 1 30); do
  if docker compose exec -T openclaw-gateway bash -c 'command -v google-chrome-stable' >/dev/null 2>&1; then
    echo "Chrome ready after ${_chrome_wait}s"
    break
  fi
  sleep 2
done

# Fallback: if startup.sh didn't install Chrome, install it now using curl
docker compose exec -T openclaw-gateway bash -c '
 if command -v google-chrome-stable &>/dev/null; then
   echo "Chrome: $(google-chrome-stable --version 2>/dev/null)"
   exit 0
 fi
 echo "Chrome not found, installing via curl..."
 for _cr in 1 2 3; do
   if curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb; then
     apt-get update -qq 2>/dev/null
     dpkg -i /tmp/chrome.deb 2>/dev/null || apt-get install -y -f 2>/dev/null
     rm -f /tmp/chrome.deb
     echo "Chrome installed: $(google-chrome-stable --version 2>/dev/null || echo unknown)"
     exit 0
   fi
   echo "Chrome download attempt ${_cr} failed, retrying..."
   sleep 5
 done
 echo "WARNING: Chrome install failed (non-fatal — startup.sh will retry on next restart)"
' || echo "Chrome exec skipped (non-fatal)"
docker image prune -f 2>/dev/null || true

# Run openclaw setup/doctor (use node directly — openclaw CLI is not in PATH)
docker compose exec -T -w /app openclaw-gateway node dist/index.js setup --workspace /home/node/.openclaw/workspace 2>/dev/null || true
docker compose exec -T -w /app openclaw-gateway node dist/index.js doctor --fix 2>/dev/null || true

# ── [6/9] Bridge ────────────────────────────────────────────────────
dlog "Setting up Bridge..."
mkdir -p /opt/openclaw-bridge
dlog "Downloading bridge from GitHub..."
for _dl_attempt in 1 2 3; do
  if curl -fsSL --retry 3 --retry-delay 2 "https://raw.githubusercontent.com/absurdfounder/openclawbridge/main/package.json" -o /opt/openclaw-bridge/package.json && \
     curl -fsSL --retry 3 --retry-delay 2 "https://raw.githubusercontent.com/absurdfounder/openclawbridge/main/index.mjs" -o /opt/openclaw-bridge/index.mjs; then
    dlog "Bridge downloaded ($(wc -c < /opt/openclaw-bridge/index.mjs) bytes)"
    break
  fi
  dlog "Bridge download attempt ${_dl_attempt} failed, retrying..."
  sleep $((${_dl_attempt} * 3))
done

cd /opt/openclaw-bridge && timeout 180 npm install 2>&1 || {
  dlog "npm install failed, retrying with clean cache..."
  npm cache clean --force 2>/dev/null || true
  timeout 180 npm install 2>&1
}

# ── [7/9] Poller (minimal stub — bridge handles everything now) ─────
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

# ── [7.5/9] noVNC + websockify (live browser view via VNC) ────────────
# Installs on the HOST (not in container). Websockify bridges WebSocket → VNC protocol.
# Caddy proxies /vnc/* → websockify:6080 → Xvnc:5999 (inside container, mapped to host).
if [ -n "${CAPTCHA_2CAPTCHA_API_KEY:-}" ]; then
  dlog "Installing noVNC + websockify for live browser streaming..."
  apt-get install -y -qq --no-install-recommends novnc websockify 2>/dev/null || true
  echo "[setup] noVNC + websockify installed for VNC live view"
fi

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
Environment=OPENCLAW_MODEL=${RESOLVED_MODEL}
Environment=POLL_INTERVAL=3000
Environment=REQUEST_TIMEOUT=180000
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
PSVC

# Websockify service — bridges noVNC WebSocket to Xvnc inside the container
# Only enabled when 2captcha is set (which means Xvnc runs in the container)
if [ -n "${CAPTCHA_2CAPTCHA_API_KEY:-}" ]; then
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
fi

systemctl daemon-reload
systemctl enable openclaw-docker openclaw-bridge openclaw-poller
if [ -n "${CAPTCHA_2CAPTCHA_API_KEY:-}" ]; then
  systemctl enable openclaw-vnc
fi
dlog "Starting services..."
# Kill the temporary log server so the real bridge can use the port
kill $LOG_SERVER_PID 2>/dev/null; sleep 1
systemctl start openclaw-bridge
systemctl start openclaw-poller
if [ -n "${CAPTCHA_2CAPTCHA_API_KEY:-}" ]; then
  systemctl start openclaw-vnc
fi
# Start Caddy (HTTPS reverse proxy) — needs gateway container to be up
systemctl restart caddy 2>/dev/null || true

# ── [9/9] Verify ────────────────────────────────────────────────────
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
