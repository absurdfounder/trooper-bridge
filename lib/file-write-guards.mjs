import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

export const USER_CENTRIC_OPENCLAW_KEYS = Object.freeze(new Set([
  'agents',
  'auth',
  'channels',
  'context',
  'contexts',
  'mailboxes',
  'mcp',
  'memory',
  'models',
  'permissions',
  'plugins',
  'routines',
  'secrets',
  'skills',
  'tools',
  'workflows',
]));

export function stableJson(value) {
  return JSON.stringify(sortJsonValue(value), null, 2);
}

export function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value)
    .sort()
    .reduce((next, key) => {
      next[key] = sortJsonValue(value[key]);
      return next;
    }, {});
}

export function stripTrooperFileMetadata(value) {
  if (!value || typeof value !== 'object') return value;
  const next = JSON.parse(JSON.stringify(value));
  delete next._trooper;
  return next;
}

export function jsonFileHash(value) {
  return createHash('sha256')
    .update(stableJson(stripTrooperFileMetadata(value)))
    .digest('hex');
}

export function attachConfigFileMetadata(value, file) {
  const payload = value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : {};
  payload._trooper = {
    ...(payload._trooper || {}),
    file,
    hash: jsonFileHash(payload),
    loadedAt: Date.now(),
    conflictSafe: true,
  };
  return payload;
}

export function getSubmittedConfigHash(value) {
  const meta = value?._trooper || {};
  return typeof meta.hash === 'string' ? meta.hash : '';
}

export function isForcedConfigWrite(value) {
  const meta = value?._trooper || {};
  return meta.forceWrite === true || meta.resolveConflict === 'accept_update';
}

export function topLevelChangedKeys(left, right) {
  const a = stripTrooperFileMetadata(left) || {};
  const b = stripTrooperFileMetadata(right) || {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return Array.from(keys)
    .filter((key) => stableJson(a[key]) !== stableJson(b[key]))
    .sort();
}

export function userCentricChangedKeys({ file, current, submitted }) {
  const changed = topLevelChangedKeys(current, submitted);
  if (file === 'auth-profiles.json') return changed;
  if (file !== 'openclaw.json') return changed;
  return changed.filter((key) => USER_CENTRIC_OPENCLAW_KEYS.has(String(key).toLowerCase()));
}

export function buildConfigConflict({ file, current, submitted }) {
  const changedKeys = userCentricChangedKeys({ file, current, submitted });
  return {
    conflict: true,
    error: 'config_conflict',
    message: `${file} changed after this editor loaded. Trooper preserved the current file; choose which version to keep before restarting.`,
    file,
    currentHash: jsonFileHash(current),
    submittedBaseHash: getSubmittedConfigHash(submitted),
    changedKeys,
  };
}

export function shouldRejectConfigWrite({ file, current, submitted }) {
  const submittedHash = getSubmittedConfigHash(submitted);
  if (!submittedHash || isForcedConfigWrite(submitted)) return false;
  if (submittedHash === jsonFileHash(current)) return false;
  return userCentricChangedKeys({ file, current, submitted }).length > 0;
}

export function preserveSystemManagedSections({ file, current, submitted }) {
  const next = stripTrooperFileMetadata(submitted || {});
  if (file !== 'openclaw.json' || !current || typeof current !== 'object' || !next || typeof next !== 'object') {
    return next;
  }
  const currentClean = stripTrooperFileMetadata(current) || {};
  for (const key of topLevelChangedKeys(currentClean, next)) {
    if (USER_CENTRIC_OPENCLAW_KEYS.has(String(key).toLowerCase())) continue;
    if (Object.prototype.hasOwnProperty.call(currentClean, key)) {
      next[key] = JSON.parse(JSON.stringify(currentClean[key]));
    } else {
      delete next[key];
    }
  }
  return next;
}

export function writeTimestampedBackup(filePath, content, label = 'backup') {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(path.dirname(filePath), '.trooper-backups');
  mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `${path.basename(filePath)}.${timestamp}.${label}.bak`);
  writeFileSync(backupPath, String(content ?? ''), 'utf8');
  return backupPath;
}

export function writeTextFileIfChanged(filePath, content, options = {}) {
  const next = String(content ?? '');
  let previous = null;
  if (existsSync(filePath)) {
    try {
      previous = readFileSync(filePath, options.encoding || 'utf8');
    } catch {
      previous = null;
    }
  }
  if (previous === next) {
    return { written: false, unchanged: true };
  }
  if (options.ensureDir !== false) {
    mkdirSync(path.dirname(filePath), { recursive: true });
  }
  writeFileSync(filePath, next, options.encoding || 'utf8');
  return { written: true, unchanged: false };
}

export function writeJsonFileIfChanged(filePath, value, options = {}) {
  return writeTextFileIfChanged(filePath, stableJson(value), options);
}
export function resolveContainedPath(basePath, filePath) {
  const root = path.resolve(String(basePath || ''));
  const target = path.resolve(root, String(filePath || ''));
  const relative = path.relative(root, target);
  if (!relative || relative === '.') return target;
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    return null;
  }
  return target;
}
