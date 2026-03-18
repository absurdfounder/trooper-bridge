# OpenClaw Bridge - Web IDE Support Requirements

## Context

CrabsHQ is adding a lightweight web IDE (Monaco Editor) in the artifact panel to display worktree files, enable editing, and show diffs. The bridge needs to support this with enhanced file and workspace APIs.

## Current File Endpoints

| Method | Path | Status |
|--------|------|--------|
| `GET /files?path=...` | List directory | Exists |
| `GET /files/*` | Read file content | Exists |
| `POST /files/write` | Write file(s) | Exists |

## Required Enhancements

### 1. Workspace Tree Endpoint (New)

```
GET /api/workspace/tree?path={projectFolder}&depth={n}
```

Returns a recursive file tree structure for the IDE panel:

```json
{
  "name": "project-folder",
  "type": "directory",
  "children": [
    { "name": "index.html", "type": "file", "size": 1234, "modified": "2026-03-18T..." },
    { "name": "src", "type": "directory", "children": [...] }
  ]
}
```

**Why:** Current `/files?path=` returns flat directory listings. The IDE needs a recursive tree structure to render the file explorer without multiple round-trips.

### 2. File Read with Metadata (Enhanced)

```
GET /api/workspace/file?path={filePath}
```

Returns file content plus metadata for the editor:

```json
{
  "path": "/workspace/project/src/index.js",
  "content": "...",
  "language": "javascript",
  "size": 1234,
  "modified": "2026-03-18T...",
  "encoding": "utf-8"
}
```

### 3. File Save Endpoint (Enhanced)

```
PUT /api/workspace/file
Body: { "path": "...", "content": "..." }
```

Returns diff info for the chat to show what changed:

```json
{
  "success": true,
  "diff": {
    "path": "src/index.js",
    "before": "old content...",
    "after": "new content...",
    "additions": 5,
    "deletions": 2
  }
}
```

### 4. File Watch via SSE (New - Optional)

```
GET /api/workspace/watch?path={projectFolder}
```

Server-Sent Events stream for file changes (when agent modifies files during a task):

```
event: file_changed
data: {"path":"src/index.js","type":"modified","timestamp":"..."}

event: file_created
data: {"path":"src/new-file.js","type":"created","timestamp":"..."}
```

**Why:** When the agent is actively working on a task and writing files, the IDE panel should update in real-time without polling.

### 5. Git Diff Endpoint (New)

```
GET /api/workspace/diff?path={projectFolder}
```

Returns git-style diffs for all changed files in the workspace:

```json
{
  "files": [
    {
      "path": "src/index.js",
      "status": "modified",
      "before": "...",
      "after": "...",
      "hunks": [...]
    }
  ]
}
```

## Streaming Integration

### Tool Events for IDE

When the agent executes `write`, `edit`, or `read` tools, the bridge already emits `tool_start` / `tool_result` SSE events. These should be enhanced to include file path info so the IDE can:

1. Auto-open files the agent just wrote
2. Show a "file modified" indicator in the tree
3. Scroll to the edited section

Current tool_result for write:
```json
{"eventType": "tool_result", "tool": "write", "success": true, "summary": "Wrote file"}
```

Enhanced:
```json
{
  "eventType": "tool_result",
  "tool": "write",
  "success": true,
  "summary": "Wrote src/index.js",
  "filePath": "src/index.js",
  "fileSize": 1234,
  "language": "javascript"
}
```

## Implementation Priority

1. **Workspace tree endpoint** - Required for file explorer
2. **Enhanced file read** - Required for editor
3. **Enhanced file save** - Required for editing
4. **Enhanced tool events** - Required for live updates
5. **File watch SSE** - Nice to have for real-time sync
6. **Git diff endpoint** - Nice to have for diff view
