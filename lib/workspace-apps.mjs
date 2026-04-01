import path from 'path';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
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
    updated_at: stats?.mtimeMs || Date.now(),
  };
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
