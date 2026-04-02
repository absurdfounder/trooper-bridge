import path from 'path';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'fs';

const WORKSPACE_APPS_DIR = '/opt/openclaw-data/workspace/apps';
const APP_SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/i;

function slugify(value, fallback = 'app') {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || fallback;
}

function assertAppSlug(value) {
  const slug = slugify(value);
  if (!APP_SLUG_RE.test(slug)) {
    throw new Error('Invalid app slug');
  }
  return slug;
}

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function escapeHtml(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getAppRoot(slug) {
  const safeSlug = assertAppSlug(slug);
  const root = path.resolve(WORKSPACE_APPS_DIR, safeSlug);
  if (!root.startsWith(WORKSPACE_APPS_DIR)) {
    throw new Error('App path is not allowed');
  }
  return root;
}

function resolveAppFile(slug, relativePath = '') {
  const root = getAppRoot(slug);
  const cleaned = String(relativePath || '')
    .replace(/^\/+/, '')
    .replace(/\0/g, '');
  const absolute = path.resolve(root, cleaned || '.');
  if (!absolute.startsWith(root)) {
    throw new Error('Asset path is not allowed');
  }
  return { root, absolute, relativePath: cleaned };
}

function guessContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const byExt = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.jsx': 'text/javascript; charset=utf-8',
    '.ts': 'text/plain; charset=utf-8',
    '.tsx': 'text/plain; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
  };
  return byExt[ext] || 'application/octet-stream';
}

function readAppManifest(slug) {
  const { root } = resolveAppFile(slug);
  const manifestPath = path.join(root, 'manifest.json');
  const raw = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : '';
  const manifest = parseJson(raw, {}) || {};
  const inferredEntry = manifest.entry || manifest.main || 'index.html';
  const entryPath = path.join(root, inferredEntry);
  const hasEntry = existsSync(entryPath);
  const stats = existsSync(root) ? statSync(root) : null;

  return {
    slug,
    name: manifest.name || manifest.title || slug,
    description: manifest.description || '',
    icon: manifest.icon || 'PanelsTopLeft',
    entry: inferredEntry,
    hasEntry,
    rootPath: root,
    manifest,
    projectId: manifest.projectId || manifest.project?.id || null,
    projectName: manifest.projectName || manifest.project?.name || '',
    surfaces: Array.isArray(manifest.surfaces) ? manifest.surfaces : [],
    updated_at: stats?.mtimeMs || Date.now(),
  };
}

function buildStarterAppHtml(appMeta) {
  const safeName = escapeHtml(appMeta.name || appMeta.slug);
  const safeDescription = escapeHtml(appMeta.description || 'Internal workspace app for routines, data tables, and files.');
  const safeProject = escapeHtml(appMeta.projectName || '');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${safeName}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f7f3ed;
        --card: #fffaf4;
        --line: #e7ded2;
        --text: #1c1917;
        --muted: #78716c;
        --accent: #a16207;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: linear-gradient(180deg, #fdfaf6 0%, var(--bg) 100%);
        color: var(--text);
      }
      .shell {
        min-height: 100vh;
        padding: 28px;
      }
      .hero, .card {
        background: rgba(255, 250, 244, 0.92);
        border: 1px solid var(--line);
        border-radius: 24px;
        box-shadow: 0 20px 50px rgba(120, 113, 108, 0.08);
      }
      .hero {
        padding: 28px;
      }
      .eyebrow {
        font-size: 12px;
        letter-spacing: 0.22em;
        text-transform: uppercase;
        color: var(--accent);
        font-weight: 700;
      }
      h1 {
        margin: 8px 0 10px;
        font-size: 34px;
        line-height: 1.05;
      }
      p {
        margin: 0;
        color: var(--muted);
        line-height: 1.6;
      }
      .meta {
        margin-top: 14px;
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        border-radius: 999px;
        background: white;
        border: 1px solid var(--line);
        padding: 8px 12px;
        font-size: 12px;
        color: var(--muted);
      }
      .grid {
        margin-top: 18px;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 16px;
      }
      .card {
        padding: 18px;
      }
      .card h2 {
        margin: 0 0 12px;
        font-size: 15px;
      }
      .metric {
        font-size: 30px;
        font-weight: 700;
        margin: 0 0 4px;
      }
      ul {
        margin: 12px 0 0;
        padding-left: 18px;
        color: var(--muted);
      }
      li + li { margin-top: 6px; }
      .empty {
        color: #a8a29e;
        font-style: italic;
      }
      .error {
        margin-top: 12px;
        padding: 12px;
        border-radius: 16px;
        border: 1px solid #fecaca;
        background: #fff1f2;
        color: #be123c;
        font-size: 13px;
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <section class="hero">
        <div class="eyebrow">Workspace App</div>
        <h1>${safeName}</h1>
        <p>${safeDescription}</p>
        <div class="meta">
          <div class="pill">Built for routines, tables, and files</div>
          ${safeProject ? `<div class="pill">Linked project: ${safeProject}</div>` : ''}
        </div>
        <div id="error" class="error" hidden></div>
      </section>

      <section class="grid">
        <article class="card">
          <h2>Tables</h2>
          <div class="metric" id="table-count">-</div>
          <p>Structured data this app can read or update.</p>
          <ul id="table-list"><li class="empty">Loading tables…</li></ul>
        </article>
        <article class="card">
          <h2>Routines</h2>
          <div class="metric" id="routine-count">-</div>
          <p>Cron jobs and workflow runs behind this app.</p>
          <ul id="routine-list"><li class="empty">Loading routines…</li></ul>
        </article>
        <article class="card">
          <h2>Files</h2>
          <div class="metric" id="file-count">-</div>
          <p>Files stored inside this app workspace.</p>
          <ul id="file-list"><li class="empty">Loading files…</li></ul>
        </article>
      </section>
    </div>

    <script>
      function setList(id, items, formatter) {
        const root = document.getElementById(id);
        if (!root) return;
        if (!items || items.length === 0) {
          root.innerHTML = '<li class="empty">Nothing connected yet.</li>';
          return;
        }
        root.innerHTML = items.slice(0, 6).map((item) => '<li>' + formatter(item) + '</li>').join('');
      }

      async function loadAppState() {
        const errorEl = document.getElementById('error');
        try {
          const [tables, jobs, filePayload] = await Promise.all([
            window.crab?.data?.listObjects?.().catch(() => []),
            window.crab?.cron?.listJobs?.().catch(() => []),
            window.crab?.files?.list?.('').catch(() => ({ files: [] })),
          ]);

          const files = Array.isArray(filePayload?.files)
            ? filePayload.files.filter((item) => item.type !== 'dir' && item.name !== 'manifest.json')
            : [];

          document.getElementById('table-count').textContent = String(tables.length);
          document.getElementById('routine-count').textContent = String(jobs.length);
          document.getElementById('file-count').textContent = String(files.length);

          setList('table-list', tables, (item) => item.label || item.name || 'Table');
          setList('routine-list', jobs, (item) => item.name || item.id || 'Routine');
          setList('file-list', files, (item) => item.name || item.path || 'File');
        } catch (error) {
          if (errorEl) {
            errorEl.hidden = false;
            errorEl.textContent = error?.message || 'Failed to load app context.';
          }
        }
      }

      window.addEventListener('crab:ready', loadAppState);
      if (window.crab) loadAppState();
    </script>
  </body>
</html>
`;
}

export function createWorkspaceApp(payload = {}) {
  const slug = assertAppSlug(payload.slug || payload.name || 'app');
  const root = getAppRoot(slug);
  if (existsSync(root)) {
    const error = new Error(`App "${slug}" already exists`);
    error.code = 'APP_EXISTS';
    throw error;
  }

  const name = String(payload.name || slug).trim() || slug;
  const description = String(payload.description || '').trim();
  const projectId = String(payload.projectId || '').trim() || null;
  const projectName = String(payload.projectName || '').trim() || null;
  const manifest = {
    name,
    slug,
    description,
    entry: 'index.html',
    icon: 'PanelsTopLeft',
    surfaces: ['routines', 'data', 'files'],
    projectId,
    projectName,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  writeFileSync(path.join(root, 'index.html'), buildStarterAppHtml(manifest), 'utf8');

  return readAppManifest(slug);
}

export function listWorkspaceApps() {
  if (!existsSync(WORKSPACE_APPS_DIR)) return [];

  return readdirSync(WORKSPACE_APPS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => readAppManifest(entry.name))
    .sort((left, right) => (right.updated_at || 0) - (left.updated_at || 0));
}

export function getWorkspaceApp(slug) {
  const app = readAppManifest(slug);
  if (!existsSync(app.rootPath)) {
    throw new Error(`App "${slug}" not found`);
  }
  return app;
}

function buildSdkScript(appMeta) {
  const appContext = JSON.stringify({
    slug: appMeta.slug,
    name: appMeta.name,
    description: appMeta.description,
    icon: appMeta.icon,
    entry: appMeta.entry,
    rootPath: appMeta.rootPath,
    manifest: appMeta.manifest,
  }).replace(/</g, '\\u003c');

  return `
<script>
(() => {
  const app = Object.freeze(${appContext});
  const listeners = new Map();

  function emit(type, detail) {
    const handlers = listeners.get(type);
    if (!handlers) return;
    for (const handler of handlers) {
      try { handler(detail); } catch (error) { console.warn('[crab-sdk] listener error', error); }
    }
  }

  function on(type, handler) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(handler);
    return () => listeners.get(type)?.delete(handler);
  }

  function off(type, handler) {
    listeners.get(type)?.delete(handler);
  }

  function postToHost(type, payload = {}) {
    try {
      window.parent?.postMessage({
        source: 'crab-app',
        slug: app.slug,
        type,
        payload,
      }, '*');
    } catch (error) {
      console.warn('[crab-sdk] host message failed', error);
    }
  }

  async function readResponse(response, fallbackMessage) {
    const text = await response.text();
    const contentType = response.headers.get('content-type') || '';
    let payload = text;

    if (contentType.includes('application/json')) {
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = { error: 'Invalid JSON response' };
      }
    }

    if (!response.ok) {
      const error = payload?.error || payload?.message || text || fallbackMessage || 'Request failed';
      throw new Error(error);
    }

    return payload;
  }

  async function request(url, init = {}) {
    const headers = init.headers instanceof Headers
      ? init.headers
      : new Headers(init.headers || {});
    let body = init.body;

    if (body != null && !(body instanceof FormData) && typeof body !== 'string') {
      headers.set('Content-Type', headers.get('Content-Type') || 'application/json');
      body = JSON.stringify(body);
    }

    const response = await fetch(url, {
      ...init,
      headers,
      body,
      cache: 'no-store',
    });

    return readResponse(response, 'Request failed');
  }

  function resolveWorkspacePath(relativePath = '') {
    const cleaned = String(relativePath || '').replace(/^\\/+/, '');
    return cleaned ? app.rootPath + '/' + cleaned : app.rootPath;
  }

  function buildQuery(params = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {})) {
      if (value == null || value === '') continue;
      query.set(key, String(value));
    }
    const text = query.toString();
    return text ? '?' + text : '';
  }

  const files = Object.freeze({
    list(relativePath = '') {
      return request('/api/bridge/files?path=' + encodeURIComponent(resolveWorkspacePath(relativePath)));
    },
    async read(relativePath = '') {
      const response = await fetch('/api/bridge/files/view?path=' + encodeURIComponent(resolveWorkspacePath(relativePath)), {
        cache: 'no-store',
      });
      const text = await response.text();
      if (!response.ok) throw new Error(text || 'Failed to read file');
      return text;
    },
    write(relativePath = '', content = '') {
      const cleaned = String(relativePath || '').replace(/^\\/+/, '');
      if (!cleaned) throw new Error('relativePath is required');
      return request('/api/bridge/files/write', {
        method: 'POST',
        body: {
          agentName: 'main',
          files: [
            {
              path: 'apps/' + app.slug + '/' + cleaned,
              content: String(content ?? ''),
            },
          ],
        },
      });
    },
  });

  const data = Object.freeze({
    listObjects(query = '') {
      return request('/api/bridge/data/objects' + buildQuery({ q: query })).then((payload) => payload.objects || []);
    },
    getObject(name, query = '') {
      return request('/api/bridge/data/objects/' + encodeURIComponent(name) + buildQuery({ q: query }));
    },
    createObject(payload = {}) {
      return request('/api/bridge/data/objects', { method: 'POST', body: payload });
    },
    createField(name, payload = {}) {
      return request('/api/bridge/data/objects/' + encodeURIComponent(name) + '/fields', { method: 'POST', body: payload });
    },
    createEntry(name, values = {}) {
      return request('/api/bridge/data/objects/' + encodeURIComponent(name) + '/entries', { method: 'POST', body: { values } });
    },
    updateEntry(name, entryId, values = {}) {
      return request('/api/bridge/data/objects/' + encodeURIComponent(name) + '/entries/' + encodeURIComponent(entryId), {
        method: 'PATCH',
        body: { values },
      });
    },
    enrichRows(name, payload = {}) {
      return request('/api/data/objects/' + encodeURIComponent(name) + '/enrich', {
        method: 'POST',
        body: payload,
      });
    },
    listActions(name) {
      return request('/api/bridge/data/objects/' + encodeURIComponent(name) + '/actions').then((payload) => payload.actions || []);
    },
    listActionRuns(name, params = {}) {
      return request('/api/bridge/data/objects/' + encodeURIComponent(name) + '/actions/runs' + buildQuery(params))
        .then((payload) => payload.runs || []);
    },
    exportUrl(name) {
      return '/api/bridge/data/objects/' + encodeURIComponent(name) + '/export.csv';
    },
  });

  const cron = Object.freeze({
    listJobs() {
      return request('/api/cron/jobs').then((payload) => payload.jobs || []);
    },
    listHistory(params = {}) {
      return request('/api/cron/history' + buildQuery(params)).then((payload) => payload.runs || []);
    },
    createJob(payload = {}) {
      return request('/api/cron/jobs', { method: 'POST', body: payload });
    },
    runJob(jobId) {
      return request('/api/cron/jobs/' + encodeURIComponent(jobId) + '/run', { method: 'POST' });
    },
    toggleJob(jobId, enabled) {
      return request('/api/cron/jobs/' + encodeURIComponent(jobId) + '/toggle', {
        method: 'POST',
        body: { enabled },
      });
    },
  });

  const ui = Object.freeze({
    openArtifact(artifact) {
      postToHost('ui.openArtifact', { artifact });
    },
    openData(objectName, title) {
      postToHost('ui.openArtifact', {
        artifact: {
          type: 'data',
          title: title || objectName || 'Data',
          lang: 'data',
          code: JSON.stringify({ object: objectName }),
        },
      });
    },
    openApp(slug, title) {
      postToHost('ui.openArtifact', {
        artifact: {
          type: 'app',
          title: title || slug || 'Workspace App',
          lang: 'app',
          code: JSON.stringify({ slug }),
        },
      });
    },
    navigate(page) {
      postToHost('ui.navigate', { page });
    },
  });

  const chat = Object.freeze({
    send(content, options = {}) {
      postToHost('chat.send', { content, options });
    },
  });

  window.crab = Object.freeze({
    version: '0.1.0',
    app,
    api: request,
    files,
    data,
    objects: data,
    chat,
    cron,
    ui,
    events: Object.freeze({ on, off, emit }),
    tools: Object.freeze({
      request,
    }),
    refresh() {
      location.reload();
    },
  });

  window.dispatchEvent(new CustomEvent('crab:ready', { detail: app }));
})();
</script>
  `.trim();
}

function injectSdkIntoHtml(html, appMeta) {
  const sdkScript = buildSdkScript(appMeta);
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${sdkScript}\n</head>`);
  }
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${sdkScript}\n</body>`);
  }
  return `${html}\n${sdkScript}`;
}

export function registerWorkspaceAppRoutes(app) {
  app.get('/api/apps', (req, res) => {
    try {
      res.json({ apps: listWorkspaceApps() });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/apps', (req, res) => {
    try {
      const created = createWorkspaceApp(req.body || {});
      res.status(201).json({ app: created });
    } catch (error) {
      if (error?.code === 'APP_EXISTS') {
        return res.status(409).json({ error: error.message });
      }
      return res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/apps/:slug', (req, res) => {
    try {
      res.json({ app: getWorkspaceApp(req.params.slug) });
    } catch (error) {
      res.status(404).json({ error: error.message });
    }
  });

  app.get('/api/apps/:slug/view', (req, res) => {
    try {
      const appMeta = getWorkspaceApp(req.params.slug);
      if (!appMeta.hasEntry) {
        return res.status(404).json({ error: `App "${appMeta.slug}" is missing ${appMeta.entry}` });
      }

      const { absolute } = resolveAppFile(appMeta.slug, appMeta.entry);
      const html = readFileSync(absolute, 'utf8');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(injectSdkIntoHtml(html, appMeta));
    } catch (error) {
      return res.status(404).json({ error: error.message });
    }
  });

  app.get('/api/apps/:slug/*', (req, res) => {
    try {
      const relativePath = req.params[0] || '';
      const { absolute } = resolveAppFile(req.params.slug, relativePath);
      if (!existsSync(absolute)) {
        return res.status(404).json({ error: 'Asset not found' });
      }

      const stats = statSync(absolute);
      if (stats.isDirectory()) {
        return res.status(400).json({ error: 'Directories cannot be served as assets' });
      }

      const contentType = guessContentType(absolute);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'no-store');
      return res.send(readFileSync(absolute));
    } catch (error) {
      return res.status(404).json({ error: error.message });
    }
  });
}
