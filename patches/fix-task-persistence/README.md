# Fix: Gap 4 -- user-scope REST `GET /api/tasks`

Part of the Firebase -> VPS task-persistence fix set. Companion patches
live in `absurdfounder/crabs-hq:patches/fix-task-persistence/`.

## What this patch does

The REST `GET /api/tasks` handler in `index.mjs` previously called
`listTasks(...)` without threading `req.firebaseUser?.uid` through.
After the crabs-hq Render server started reading tasks via this
endpoint (Gap 1 fix), that created a cross-tenant leakage risk.

This patch adds `const userId = req.firebaseUser?.uid || null;` and
passes `userId` into `listTasks(...)` so results are scoped to the
authenticated user. The underlying `listTasks` already accepts
`userId` (commit `376fedd`) and filters `creator_id`/`assignee_id`
with an `isNull` fallback for legacy unscoped rows.

## Apply

From the openclawbridge repo root:

```bash
python3 patches/fix-task-persistence/apply.py
node --check index.mjs
git add index.mjs
git commit -m "fix(tasks): user-scope REST GET /api/tasks handler"
git push origin HEAD:main   # or merge into main via PR
```

Re-running the script is a no-op; the script checks for the new code
before replacing. If the script reports `WARN: Could not locate the
original block`, the file has diverged -- inspect
`app.get('/api/tasks', ...)` manually.

## Deploy

The openclawbridge service on the Hetzner VPS needs the change live.
On the VPS:

```bash
cd /opt/openclawbridge   # or wherever the working copy lives
git pull origin main
docker compose restart openclaw-bridge
# or: pm2 restart openclaw-bridge   (depending on your deployment setup)
```

## Verify

```bash
# As user A -- should only return A's tasks
curl -H "Authorization: Bearer <A_firebase_token>" \
  https://<bridge-host>/api/tasks | jq '.tasks | length'

# As user B -- should be disjoint
curl -H "Authorization: Bearer <B_firebase_token>" \
  https://<bridge-host>/api/tasks | jq '.tasks | length'

# Database-level spot check
docker exec openclaw-bridge sqlite3 /opt/openclaw-data/crabhq.db \
  "select id, title, creator_id, assignee_id from tasks order by created_at desc limit 10"
```
