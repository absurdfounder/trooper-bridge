#!/usr/bin/env python3
"""Apply Gap 4 of the VPS-migration fix to openclawbridge/index.mjs.

This script is idempotent - running it twice is harmless. It finds the
REST `GET /api/tasks` handler and threads `req.firebaseUser?.uid` into
`listTasks(...)` so the handler is user-scoped. This closes the
cross-tenant leakage risk introduced when the Render crabs-hq server
started reading tasks through this endpoint.

Run from the openclawbridge repo root:
    python3 patches/fix-task-persistence/apply.py

After it reports OK, verify and push:
    node --check index.mjs
    git add index.mjs && git commit -m "fix(tasks): user-scope REST GET /api/tasks handler" && git push
"""
from pathlib import Path
import sys

FILE = Path("index.mjs")
OLD = """app.get('/api/tasks', (req, res) => {
  try {
    const { status, assigneeId, projectId, limit } = req.query;
    const result = listTasks({ status, assigneeId, projectId, limit: limit ? parseInt(limit) : 50 });
    res.json({ tasks: result });"""
NEW = """app.get('/api/tasks', (req, res) => {
  try {
    const { status, assigneeId, projectId, limit } = req.query;
    const userId = req.firebaseUser?.uid || null;
    const result = listTasks({ userId, status, assigneeId, projectId, limit: limit ? parseInt(limit) : 50 });
    res.json({ tasks: result });"""


def main() -> int:
    if not FILE.exists():
        print(f"ERROR: {FILE} not found. Run from the openclawbridge repo root.", file=sys.stderr)
        return 2
    src = FILE.read_text()
    if NEW in src:
        print("OK (already applied): Gap 4 user-scoping is present in index.mjs")
        return 0
    if OLD not in src:
        print("WARN: Could not locate the original GET /api/tasks block. "
              "Either the file has diverged or the fix is already applied in "
              "a different form. Inspect manually around app.get('/api/tasks'.", file=sys.stderr)
        return 1
    FILE.write_text(src.replace(OLD, NEW, 1))
    print(f"OK: applied Gap 4 user-scoping to {FILE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
