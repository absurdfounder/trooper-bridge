# OpenClawBridge — Self-Hosted Deployment Plan

> Changes needed in the bridge to support self-hosted deployments where user data stays on their server and the frontend connects directly.

---

## 1. Overview

The bridge becomes the **single source of truth** for all user data. Currently it already stores most data in SQLite and files — the main changes are:

1. Add Firebase token auth to REST endpoints (so frontend can connect directly)
2. Add admin endpoints for backup/restore/restart (so provisioning doesn't need 30-min polling)
3. Add deploy-complete callback to setup script
4. Clean up setup script for self-hosted use

---

## 2. Auth: Firebase Token Verification for REST

### Current state
- REST endpoints use `BRIDGE_AUTH_TOKEN` (shared secret, server-to-server)
- WebSocket uses Firebase ID token verification (already implemented in `lib/firebase-auth.mjs`)
- `/api/*` routes are **exempt** from the bridge auth middleware

### Required change
Add a second auth layer: Firebase token verification for end-user REST requests.

**New middleware** in `lib/firebase-auth.mjs`:

```js
// Verify Firebase ID token from Authorization header
// Used for direct frontend → bridge REST calls
export function requireFirebaseAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  
  if (!token) {
    // Fall back to bridge auth token (server-to-server)
    return next();
  }
  
  verifyFirebaseToken(token)
    .then(decoded => {
      req.user = decoded;
      next();
    })
    .catch(() => res.status(401).json({ error: 'Invalid Firebase token' }));
}
```

**Apply to routes** in `lib/api-routes.mjs`:
- All `/api/*` endpoints get Firebase token auth
- Bridge auth token still accepted (for Render → bridge server-to-server calls)
- Either auth method is sufficient (OR logic, not AND)

**Files to change:**
| File | Change |
|------|--------|
| `lib/firebase-auth.mjs` | Add `requireFirebaseAuth` middleware for REST |
| `lib/api-routes.mjs` | Apply middleware to all `/api/*` routes |
| `index.mjs` | Update exempt path list — `/api/*` should no longer be exempt from all auth |

---

## 3. CORS for Direct Frontend Access

### Current state
CORS is enabled broadly. When the frontend connects directly, we need explicit origin allowlisting.

**New CORS config** in `index.mjs`:

```js
const ALLOWED_ORIGINS = [
  /\.crabhq\.com$/,           // org-xxx.crabhq.com (same-origin, but just in case)
  /\.netlify\.app$/,          // crabhq.netlify.app (frontend)
  /^https?:\/\/localhost/,    // dev
  /^https?:\/\/127\.0\.0\.1/, // dev
];

// Also allow custom domains configured in bridge config
const customOrigin = config.get('cors.allowedOrigin');
if (customOrigin) ALLOWED_ORIGINS.push(new RegExp(customOrigin));
```

**Files to change:**
| File | Change |
|------|--------|
| `index.mjs` | Update CORS config with explicit origin allowlist |
| Config | Add `cors.allowedOrigin` setting for custom domains |

---

## 4. Admin Endpoints for Provisioning

### 4.1 Restart Services

```
POST /admin/restart-services
Auth: Bridge auth token (server-to-server only)
```

Restarts Docker containers without data loss:
```bash
cd /opt/openclaw && docker compose down && docker compose up -d
```

Returns: `{ ok: true, restarted: ["openclaw-gateway", "bridge"] }`

### 4.2 Local Backup

```
POST /admin/backup
Auth: Bridge auth token
```

Creates a backup tarball on the VPS:
```bash
tar -czf /opt/openclaw-backup/backup-$(date +%s).tar.gz \
  /opt/openclaw-data/bridge.db \
  /opt/openclaw-data/workspace/ \
  /opt/openclaw-data/config/ \
  /opt/openclaw-data/cron/
```

Returns: `{ ok: true, path: "/opt/openclaw-backup/backup-1712345678.tar.gz", size: 1234567 }`

### 4.3 Local Restore

```
POST /admin/restore
Auth: Bridge auth token
Body: { path: "/opt/openclaw-backup/backup-1712345678.tar.gz" } (optional, defaults to latest)
```

Stops services, extracts tarball, restarts services.

Returns: `{ ok: true, restored: "/opt/openclaw-backup/backup-1712345678.tar.gz" }`

### 4.4 Health with details

The existing `/health` endpoint already returns status. Enhance it:

```json
{
  "status": "ok",
  "version": "2.1.0",
  "uptime": 86400,
  "services": {
    "gateway": "running",
    "caddy": "running",
    "sqlite": "ok",
    "disk": { "used": "2.1GB", "available": "18GB" }
  },
  "lastBackup": "2026-04-02T10:00:00Z"
}
```

**Files to change:**
| File | Change |
|------|--------|
| `index.mjs` | Add `/admin/restart-services`, `/admin/backup`, `/admin/restore` |
| `index.mjs` | Enhance `/health` response with service details |

---

## 5. Setup Script Changes

### 5.1 Deploy-Complete Callback

At the end of `setup-openclaw-full.sh`, after all services are confirmed running:

```bash
# Notify CrabsHQ central API that setup is complete
if [ -n "$API_URL" ] && [ -n "$ORG_ID" ]; then
  for i in 1 2 3 4 5; do
    STATUS=$(curl -sf -X POST "${API_URL}/api/deploy-complete/${ORG_ID}" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer ${GATEWAY_TOKEN}" \
      -d "{\"ip\":\"$(curl -sf ifconfig.me)\",\"bridgePort\":${BRIDGE_PORT},\"status\":\"ready\"}" \
      --max-time 10 \
      -o /dev/null -w "%{http_code}" 2>/dev/null)
    if [ "$STATUS" = "200" ]; then
      echo "[setup] Deploy-complete callback sent successfully"
      break
    fi
    echo "[setup] Deploy-complete callback failed (attempt $i/5), retrying in 5s..."
    sleep 5
  done
fi
```

This eliminates the need for Render to poll the VPS for 30 minutes.

### 5.2 Self-Hosted Mode

Add `--self-hosted` flag or `SELF_HOSTED=1` env var:

```bash
if [ "${SELF_HOSTED:-0}" = "1" ]; then
  # Skip CrabsHQ-specific steps:
  # - No CF DNS setup (user manages their own DNS)
  # - No VNC/noVNC setup (optional, saves resources)
  # - No automatic backup config (user manages)
  # - Simpler Caddyfile (just reverse proxy, user provides cert or uses Let's Encrypt)
fi
```

### 5.3 Env vars instead of template placeholders

Currently the setup script uses `{{GATEWAY_TOKEN}}` placeholders that get `sed`-replaced. For self-hosted, env vars are passed directly.

Change from:
```bash
GATEWAY_TOKEN="{{GATEWAY_TOKEN}}"
```

To:
```bash
GATEWAY_TOKEN="${GATEWAY_TOKEN:?GATEWAY_TOKEN is required}"
```

The `sed` substitution in `provision.js` still works (it replaces the whole line), but self-hosted users can just `export` the vars and run the script.

### 5.4 Systemd Services

Add systemd unit files so services survive reboots:

```ini
# /etc/systemd/system/openclaw.service
[Unit]
Description=OpenClaw Gateway + Bridge
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/openclaw
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=120

[Install]
WantedBy=multi-user.target
```

### 5.5 Update Script

```bash
#!/bin/bash
# /usr/local/bin/crabhq-update
set -e
cd /opt/openclaw
echo "Pulling latest images..."
docker compose pull
echo "Restarting services..."
docker compose down
docker compose up -d
echo "Update complete."
```

**Files to change:**
| File | Change |
|------|--------|
| `setup-openclaw-full.sh` | Add deploy-complete callback, self-hosted mode, env var support, systemd units, update/uninstall scripts |

---

## 6. Data Completeness

Currently some data endpoints return partial data that gets supplemented by Firestore on the Render side. For direct frontend → VPS to work, the bridge must return **complete** responses.

### Audit needed:

| Endpoint | Current | Required |
|----------|---------|----------|
| `GET /api/agents` | Returns bridge-local agents | Must include all agent metadata (avatar, title, role, soul) |
| `GET /api/tasks` | Returns tasks from SQLite | Must include subtasks, comments, assignment info |
| `GET /api/messages` | Returns messages from SQLite | Already complete |
| `GET /api/memories` | Returns memories from SQLite | Already complete |
| Organization info | Not on bridge | Add `GET /api/organization` — returns org name, settings, team members (synced during onboarding) |

The key gap is **organization metadata** (name, member list, settings). Currently this lives in Firestore. Options:

1. **Sync on provision** — during setup, push org metadata to bridge SQLite. Bridge serves it locally.
2. **Proxy from frontend** — frontend gets org metadata from Firebase (it already does), only gets data from bridge.

**Recommendation**: Option 2. Org metadata is not sensitive (just names and roles). Keep it in Firebase for multi-device sync. Bridge handles data; Firebase handles identity and org structure.

---

## 7. WebSocket Protocol — No Changes Needed

The WebSocket server (`lib/ws-server.mjs`) already:
- Accepts Firebase ID tokens for auth
- Handles chat messages, agent responses, typing indicators
- Streams agent execution in real-time

The frontend just needs to point its WebSocket connection to `wss://org-xxx.crabhq.com/ws` instead of the Render WebSocket.

---

## 8. Docker Image Strategy

### Current
The bridge runs from source (Node.js files copied into Docker image).

### For self-hosted
Ship as a **private Docker image** on GitHub Container Registry:

```
ghcr.io/absurdfounder/crabhq-gateway:latest    ← OpenClaw + Bridge combined
```

This is already how it works. The image contains:
- OpenClaw Gateway (compiled)
- Bridge (Node.js source — visible if someone execs into the container)
- Chrome + VNC for browser automation

### Future option: Compiled bridge
Bundle the bridge with `bun build --compile` or `pkg` to produce a single binary. This makes the code harder (not impossible) to read:

```dockerfile
# Instead of copying source
COPY . /app

# Compile to binary
RUN bun build --compile --minify ./index.mjs --outfile /app/bridge
```

**Not a priority for Phase 1-3.** The bridge is an integration layer, not the secret sauce.

---

## 9. Implementation Checklist

### Phase 1: Provisioning reliability
- [ ] Add deploy-complete callback to `setup-openclaw-full.sh`
- [ ] Add `/admin/restart-services` endpoint
- [ ] Add `/admin/backup` and `/admin/restore` endpoints
- [ ] Enhance `/health` with service details
- [ ] Add systemd unit for openclaw services

### Phase 2: Direct frontend connection
- [ ] Add `requireFirebaseAuth` middleware for REST
- [ ] Apply to all `/api/*` routes (alongside existing bridge auth)
- [ ] Update CORS config for direct frontend access
- [ ] Ensure all data endpoints return complete responses
- [ ] Test direct frontend → bridge for all data operations

### Phase 3: Self-hosted mode
- [ ] Add self-hosted mode to setup script (skip CrabsHQ-specific steps)
- [ ] Switch from template placeholders to env vars (backward compatible)
- [ ] Add `crabhq-update` script
- [ ] Add `crabhq-uninstall` script
- [ ] Test full self-hosted flow: user runs script → frontend connects → everything works
