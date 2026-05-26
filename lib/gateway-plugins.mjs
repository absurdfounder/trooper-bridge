import path from 'path';

export const OPENCLAW_PLUGINS_ROOT = '/opt/openclaw-data/plugins';
export const GATEWAY_CONTAINER_NAME = 'openclaw-openclaw-gateway-1';

const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const OPENCLAW_NPM_PLUGIN_ALLOWLIST = new Set([
  '@openclaw/brave-plugin',
]);
const ALLOWLISTED_GATEWAY_EXEC = [
  /^openclaw plugins install \/opt\/openclaw-data\/plugins\/[a-z0-9][a-z0-9_-]{0,63}$/i,
  /^openclaw plugins install @openclaw\/brave-plugin$/i,
];

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

export function normalizePluginId(pluginId) {
  const id = String(pluginId || '').trim();
  if (!PLUGIN_ID_PATTERN.test(id)) {
    throw new Error('Invalid pluginId');
  }
  return id;
}

export function resolvePluginsRoot(pluginsRoot = OPENCLAW_PLUGINS_ROOT) {
  return path.resolve(String(pluginsRoot || OPENCLAW_PLUGINS_ROOT));
}

export function resolvePluginRoot(pluginId, pluginsRoot = OPENCLAW_PLUGINS_ROOT) {
  const id = normalizePluginId(pluginId);
  const root = resolvePluginsRoot(pluginsRoot);
  const pluginRoot = path.resolve(root, id);
  const prefix = `${root}${path.sep}`;
  if (!pluginRoot.startsWith(prefix)) {
    throw new Error('Invalid plugin install path');
  }
  return pluginRoot;
}

export function isOpenClawPluginHostPath(filePath, pluginsRoot = OPENCLAW_PLUGINS_ROOT) {
  const resolved = path.resolve(String(filePath || '').trim());
  const root = resolvePluginsRoot(pluginsRoot);
  return resolved.startsWith(`${root}${path.sep}`);
}

export function resolvePluginFileTarget(pluginRoot, filePath) {
  const raw = String(filePath || '').trim();
  if (!raw) return null;
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(pluginRoot, raw);
  const prefix = `${pluginRoot}${path.sep}`;
  if (!resolved.startsWith(prefix)) return null;
  return resolved;
}

export function inferPluginIdFromHostPath(filePath, pluginsRoot = OPENCLAW_PLUGINS_ROOT) {
  const resolved = path.resolve(String(filePath || '').trim());
  const root = resolvePluginsRoot(pluginsRoot);
  if (!resolved.startsWith(`${root}${path.sep}`)) return null;
  const relative = path.relative(root, resolved);
  const [pluginId] = relative.split(path.sep);
  if (!pluginId || !PLUGIN_ID_PATTERN.test(pluginId)) return null;
  return pluginId;
}

export function validateAllowlistedGatewayExec(command) {
  const cmd = String(command || '').trim();
  if (!cmd) throw new Error('command is required');
  if (!ALLOWLISTED_GATEWAY_EXEC.some((pattern) => pattern.test(cmd))) {
    throw new Error('Command not allowlisted');
  }
  return cmd;
}

export function writePluginFiles({
  pluginId,
  files = [],
  pluginsRoot = OPENCLAW_PLUGINS_ROOT,
  mkdirSync,
  writeFileSync,
  execSync,
} = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('files array required');
  }

  const pluginRoot = resolvePluginRoot(pluginId, pluginsRoot);
  mkdirSync(pluginRoot, { recursive: true });

  let written = 0;
  const writtenPaths = [];

  for (const file of files) {
    const target = resolvePluginFileTarget(pluginRoot, file?.path);
    if (!target || typeof file?.content !== 'string') continue;
    mkdirSync(path.dirname(target), { recursive: true });
    if (file.encoding === 'base64') {
      writeFileSync(target, Buffer.from(file.content, 'base64'));
    } else {
      writeFileSync(target, file.content);
    }
    written += 1;
    writtenPaths.push(target);
  }

  if (written > 0 && execSync) {
    try {
      execSync(`chown -R 1000:1000 ${shellQuote(pluginRoot)}`, { timeout: 5000 });
    } catch {
      // non-fatal
    }
  }

  return { pluginId: normalizePluginId(pluginId), pluginRoot, written, writtenPaths };
}

export function writePluginFilesFromAbsolutePaths({
  files = [],
  pluginsRoot = OPENCLAW_PLUGINS_ROOT,
  mkdirSync,
  writeFileSync,
  execSync,
} = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('files array required');
  }

  const pluginIds = new Set();
  let written = 0;
  const writtenPaths = [];

  for (const file of files) {
    const rawPath = String(file?.path || '').trim();
    if (!rawPath || typeof file?.content !== 'string') continue;
    if (!isOpenClawPluginHostPath(rawPath, pluginsRoot)) continue;

    const pluginId = inferPluginIdFromHostPath(rawPath, pluginsRoot);
    if (!pluginId) continue;
    pluginIds.add(pluginId);

    const pluginRoot = resolvePluginRoot(pluginId, pluginsRoot);
    const target = resolvePluginFileTarget(pluginRoot, rawPath);
    if (!target) continue;

    mkdirSync(path.dirname(target), { recursive: true });
    if (file.encoding === 'base64') {
      writeFileSync(target, Buffer.from(file.content, 'base64'));
    } else {
      writeFileSync(target, file.content);
    }
    written += 1;
    writtenPaths.push(target);
  }

  for (const pluginId of pluginIds) {
    if (!execSync) continue;
    try {
      const pluginRoot = resolvePluginRoot(pluginId, pluginsRoot);
      execSync(`chown -R 1000:1000 ${shellQuote(pluginRoot)}`, { timeout: 5000 });
    } catch {
      // non-fatal
    }
  }

  return { written, writtenPaths, pluginIds: [...pluginIds] };
}

export function installOpenClawPlugin({
  pluginPath,
  pluginId,
  pluginsRoot = OPENCLAW_PLUGINS_ROOT,
  execSync,
  containerName = GATEWAY_CONTAINER_NAME,
} = {}) {
  const resolved = path.resolve(String(pluginPath || '').trim() || resolvePluginRoot(pluginId, pluginsRoot));
  if (!isOpenClawPluginHostPath(resolved, pluginsRoot)) {
    throw new Error('Plugin path not allowlisted');
  }

  const output = execSync(
    `docker exec ${containerName} openclaw plugins install ${shellQuote(resolved)} 2>&1`,
    { timeout: 120000, encoding: 'utf8' },
  );

  return { installed: true, pluginPath: resolved, output: String(output || '').trim() };
}

export function installOpenClawNpmPlugin({
  packageName,
  execSync,
  containerName = GATEWAY_CONTAINER_NAME,
} = {}) {
  const normalized = String(packageName || '').trim().toLowerCase();
  if (!OPENCLAW_NPM_PLUGIN_ALLOWLIST.has(normalized)) {
    throw new Error('Plugin package not allowlisted');
  }

  const output = execSync(
    `docker exec ${containerName} openclaw plugins install ${shellQuote(normalized)} 2>&1`,
    { timeout: 120000, encoding: 'utf8' },
  );

  try {
    execSync(
      `docker exec -u 0 ${containerName} sh -lc ${shellQuote(`chown -R root:root /home/node/.openclaw/npm/node_modules/${normalized} 2>/dev/null || true`)}`,
      { timeout: 30000, encoding: 'utf8' },
    );
  } catch {
    // non-fatal: OpenClaw doctor will report blocked plugin ownership if this fails.
  }

  return { installed: true, packageName: normalized, output: String(output || '').trim() };
}

export function runAllowlistedGatewayExec({
  command,
  cwd = '/',
  execSync,
  containerName = GATEWAY_CONTAINER_NAME,
} = {}) {
  const allowed = validateAllowlistedGatewayExec(command);
  const safeCwd = String(cwd || '/').trim() || '/';
  const output = execSync(
    `docker exec -w ${shellQuote(safeCwd)} ${containerName} ${allowed} 2>&1`,
    { timeout: 120000, encoding: 'utf8' },
  );
  return { command: allowed, cwd: safeCwd, output: String(output || '').trim() };
}

export function syncGatewayPlugin({
  pluginId,
  files = [],
  install = true,
  pluginsRoot = OPENCLAW_PLUGINS_ROOT,
  mkdirSync,
  writeFileSync,
  execSync,
  containerName = GATEWAY_CONTAINER_NAME,
} = {}) {
  const writeResult = writePluginFiles({
    pluginId,
    files,
    pluginsRoot,
    mkdirSync,
    writeFileSync,
    execSync,
  });

  if (writeResult.written === 0) {
    throw new Error('No plugin files were written');
  }

  if (!install) return { ...writeResult, installed: false };

  const installResult = installOpenClawPlugin({
    pluginPath: writeResult.pluginRoot,
    pluginsRoot,
    execSync,
    containerName,
  });

  return {
    ...writeResult,
    installed: true,
    installOutput: installResult.output,
  };
}
