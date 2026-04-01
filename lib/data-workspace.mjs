import { randomUUID } from 'crypto';
import { sqlite } from '../db/index.mjs';

let schemaReady = false;

const OBJECT_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

function nowMs() {
  return Date.now();
}

function slugify(value, fallback = 'table') {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return slug || fallback;
}

function assertObjectName(value) {
  const name = slugify(value);
  if (!OBJECT_NAME_RE.test(name)) {
    throw new Error('Invalid object name');
  }
  return name;
}

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stringifyJson(value) {
  return value == null ? null : JSON.stringify(value);
}

function serializeValue(value, type = 'text') {
  if (value == null) return null;
  if (type === 'boolean') {
    if (value === true || value === 'true' || value === '1' || value === 1) return 'true';
    if (value === false || value === 'false' || value === '0' || value === 0) return 'false';
    return String(value);
  }
  if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
    return JSON.stringify(value);
  }
  return String(value);
}

function deserializeValue(value, field) {
  if (value == null) return '';
  if (!field) return value;
  if (field.type === 'number') {
    const num = Number(value);
    return Number.isFinite(num) ? num : value;
  }
  if (field.type === 'boolean') {
    return value === 'true' || value === '1';
  }
  if (field.type === 'json') {
    return parseJson(value, value);
  }
  return value;
}

function buildCsvLine(values) {
  return values
    .map((value) => {
      const text = value == null ? '' : String(value);
      if (/[",\n]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
      }
      return text;
    })
    .join(',');
}

function parseCsv(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === delimiter && !inQuotes) {
      row.push(cell);
      cell = '';
      continue;
    }

    if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && next === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }

    cell += ch;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows
    .map((items) => items.map((item) => item.trim()))
    .filter((items) => items.some((item) => item !== ''));
}

function inferFieldType(values) {
  const present = values.filter((value) => value != null && String(value).trim() !== '');
  if (present.length === 0) return 'text';

  const allBoolean = present.every((value) => /^(true|false|yes|no|0|1)$/i.test(String(value).trim()));
  if (allBoolean) return 'boolean';

  const allNumber = present.every((value) => {
    const num = Number(String(value).replace(/,/g, ''));
    return Number.isFinite(num);
  });
  if (allNumber) return 'number';

  const allDate = present.every((value) => {
    const date = Date.parse(String(value));
    return !Number.isNaN(date);
  });
  if (allDate) return 'date';

  return 'text';
}

function ensureDataSchema() {
  if (schemaReady) return;

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS data_objects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      description TEXT,
      icon TEXT,
      default_view TEXT NOT NULL DEFAULT 'table',
      display_field TEXT,
      immutable INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS data_fields (
      id TEXT PRIMARY KEY,
      object_id TEXT NOT NULL REFERENCES data_objects(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      label TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'text',
      required INTEGER NOT NULL DEFAULT 0,
      default_value TEXT,
      config TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(object_id, key)
    );

    CREATE TABLE IF NOT EXISTS data_entries (
      id TEXT PRIMARY KEY,
      object_id TEXT NOT NULL REFERENCES data_objects(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS data_entry_values (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id TEXT NOT NULL REFERENCES data_entries(id) ON DELETE CASCADE,
      field_id TEXT NOT NULL REFERENCES data_fields(id) ON DELETE CASCADE,
      value TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(entry_id, field_id)
    );

    CREATE TABLE IF NOT EXISTS data_saved_views (
      id TEXT PRIMARY KEY,
      object_id TEXT NOT NULL REFERENCES data_objects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      view_type TEXT NOT NULL DEFAULT 'table',
      filters TEXT,
      sort TEXT,
      columns TEXT,
      settings TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(object_id, name)
    );

    CREATE TABLE IF NOT EXISTS data_actions (
      id TEXT PRIMARY KEY,
      object_id TEXT NOT NULL REFERENCES data_objects(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      label TEXT NOT NULL,
      instruction TEXT NOT NULL,
      target_fields TEXT,
      config TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(object_id, key)
    );

    CREATE TABLE IF NOT EXISTS data_action_runs (
      id TEXT PRIMARY KEY,
      object_id TEXT NOT NULL REFERENCES data_objects(id) ON DELETE CASCADE,
      entry_id TEXT,
      action_id TEXT NOT NULL,
      action_label TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      result TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS data_snapshots (
      id TEXT PRIMARY KEY,
      object_id TEXT NOT NULL REFERENCES data_objects(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      reason TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      snapshot TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_data_fields_object_id ON data_fields(object_id);
    CREATE INDEX IF NOT EXISTS idx_data_entries_object_id ON data_entries(object_id);
    CREATE INDEX IF NOT EXISTS idx_data_entry_values_entry_id ON data_entry_values(entry_id);
    CREATE INDEX IF NOT EXISTS idx_data_entry_values_field_id ON data_entry_values(field_id);
    CREATE INDEX IF NOT EXISTS idx_data_actions_object_id ON data_actions(object_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_data_snapshots_object_id ON data_snapshots(object_id, created_at DESC);
  `);

  schemaReady = true;
}

function getObjectRowByName(name) {
  ensureDataSchema();
  return sqlite
    .prepare('SELECT * FROM data_objects WHERE name = ? LIMIT 1')
    .get(assertObjectName(name));
}

function listFieldsForObject(objectId) {
  ensureDataSchema();
  const rows = sqlite
    .prepare('SELECT * FROM data_fields WHERE object_id = ? ORDER BY sort_order ASC, created_at ASC')
    .all(objectId);

  return rows.map((row) => {
    const config = parseJson(row.config, {});
    return {
      id: row.id,
      key: row.key,
      name: row.label,
      label: row.label,
      type: row.type,
      required: !!row.required,
      default_value: row.default_value,
      sort_order: row.sort_order,
      enum_values: Array.isArray(config.enumValues) ? config.enumValues : undefined,
      enum_colors: Array.isArray(config.enumColors) ? config.enumColors : undefined,
      config,
    };
  });
}

function buildEntriesForObject(objectRow, fields, search = '') {
  ensureDataSchema();
  const entryRows = sqlite
    .prepare('SELECT * FROM data_entries WHERE object_id = ? ORDER BY created_at DESC, id DESC')
    .all(objectRow.id);

  if (entryRows.length === 0) {
    return [];
  }

  const valueRows = sqlite
    .prepare(`
      SELECT ev.entry_id, ev.value, f.id AS field_id, f.key, f.label, f.type, f.config
      FROM data_entry_values ev
      JOIN data_fields f ON f.id = ev.field_id
      WHERE ev.entry_id IN (${entryRows.map(() => '?').join(',')})
    `)
    .all(...entryRows.map((row) => row.id));

  const fieldById = new Map(fields.map((field) => [field.id, field]));
  const entryMap = new Map(
    entryRows.map((row) => [
      row.id,
      {
        entry_id: row.id,
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
    ]),
  );

  for (const valueRow of valueRows) {
    const entry = entryMap.get(valueRow.entry_id);
    const field = fieldById.get(valueRow.field_id);
    if (!entry || !field) continue;
    entry[field.key] = deserializeValue(valueRow.value, field);
  }

  let entries = Array.from(entryMap.values());
  if (search && search.trim()) {
    const needle = search.trim().toLowerCase();
    entries = entries.filter((entry) =>
      fields.some((field) => String(entry[field.key] ?? '').toLowerCase().includes(needle)),
    );
  }

  return entries;
}

function getObjectSummary(row) {
  return {
    id: row.id,
    name: row.name,
    label: row.label,
    description: row.description || '',
    icon: row.icon || 'table',
    default_view: row.default_view || 'table',
    display_field: row.display_field || null,
    immutable: !!row.immutable,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function touchObject(objectId) {
  sqlite.prepare('UPDATE data_objects SET updated_at = ? WHERE id = ?').run(nowMs(), objectId);
}

export function listDataObjects({ search = '' } = {}) {
  ensureDataSchema();
  const needle = search.trim() ? `%${search.trim().toLowerCase()}%` : null;
  const rows = needle
    ? sqlite.prepare(`
        SELECT
          o.*,
          (SELECT COUNT(*) FROM data_entries e WHERE e.object_id = o.id) AS row_count,
          (SELECT COUNT(*) FROM data_fields f WHERE f.object_id = o.id) AS field_count
        FROM data_objects o
        WHERE LOWER(o.name) LIKE ? OR LOWER(o.label) LIKE ? OR LOWER(COALESCE(o.description, '')) LIKE ?
        ORDER BY o.updated_at DESC, o.label ASC
      `).all(needle, needle, needle)
    : sqlite.prepare(`
        SELECT
          o.*,
          (SELECT COUNT(*) FROM data_entries e WHERE e.object_id = o.id) AS row_count,
          (SELECT COUNT(*) FROM data_fields f WHERE f.object_id = o.id) AS field_count
        FROM data_objects o
        ORDER BY o.updated_at DESC, o.label ASC
      `).all();

  return rows.map((row) => ({
    ...getObjectSummary(row),
    rowCount: row.row_count || 0,
    fieldCount: row.field_count || 0,
  }));
}

export function createDataObject({
  name,
  label,
  description = '',
  icon = 'table',
  defaultView = 'table',
  fields = [],
} = {}) {
  ensureDataSchema();
  const objectName = assertObjectName(name || label);
  const existing = getObjectRowByName(objectName);
  if (existing) {
    throw new Error(`Object "${objectName}" already exists`);
  }

  const timestamp = nowMs();
  const objectId = randomUUID();
  const objectLabel = String(label || objectName)
    .trim()
    .replace(/\s+/g, ' ') || objectName;

  sqlite.prepare(`
    INSERT INTO data_objects (id, name, label, description, icon, default_view, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(objectId, objectName, objectLabel, description, icon, defaultView, timestamp, timestamp);

  const fieldDefs = Array.isArray(fields) && fields.length > 0
    ? fields
    : [{ key: 'name', label: 'Name', type: 'text' }];

  const insertField = sqlite.prepare(`
    INSERT INTO data_fields (id, object_id, key, label, type, required, default_value, config, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  fieldDefs.forEach((field, index) => {
    const fieldKey = slugify(field.key || field.name || field.label || `field_${index + 1}`, `field_${index + 1}`);
    insertField.run(
      randomUUID(),
      objectId,
      fieldKey,
      String(field.label || field.name || fieldKey).trim() || fieldKey,
      field.type || 'text',
      field.required ? 1 : 0,
      serializeValue(field.defaultValue ?? field.default_value, field.type || 'text'),
      stringifyJson({
        enumValues: field.enumValues || field.enum_values || null,
        enumColors: field.enumColors || field.enum_colors || null,
      }),
      index,
      timestamp,
      timestamp,
    );
  });

  return getDataObject(objectName);
}

export function getDataObject(name, { search = '' } = {}) {
  const objectRow = getObjectRowByName(name);
  if (!objectRow) return null;

  const fields = listFieldsForObject(objectRow.id);
  const entries = buildEntriesForObject(objectRow, fields, search);

  return {
    object: getObjectSummary(objectRow),
    fields,
    entries,
    totalCount: entries.length,
  };
}

export function createDataField(objectName, {
  key,
  name,
  label,
  type = 'text',
  required = false,
  defaultValue = '',
  enumValues = [],
  enumColors = [],
} = {}) {
  ensureDataSchema();
  const objectRow = getObjectRowByName(objectName);
  if (!objectRow) {
    throw new Error(`Object "${objectName}" not found`);
  }

  const fieldKey = slugify(key || name || label || 'field', `field_${Date.now()}`);
  const existing = sqlite
    .prepare('SELECT id FROM data_fields WHERE object_id = ? AND key = ? LIMIT 1')
    .get(objectRow.id, fieldKey);
  if (existing) {
    throw new Error(`Field "${fieldKey}" already exists`);
  }

  const timestamp = nowMs();
  const sortOrderRow = sqlite
    .prepare('SELECT COALESCE(MAX(sort_order), -1) AS max_sort_order FROM data_fields WHERE object_id = ?')
    .get(objectRow.id);
  const sortOrder = Number(sortOrderRow?.max_sort_order || -1) + 1;
  const fieldId = randomUUID();

  sqlite.prepare(`
    INSERT INTO data_fields (id, object_id, key, label, type, required, default_value, config, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fieldId,
    objectRow.id,
    fieldKey,
    String(label || name || fieldKey).trim() || fieldKey,
    type,
    required ? 1 : 0,
    serializeValue(defaultValue, type),
    stringifyJson({
      enumValues: Array.isArray(enumValues) ? enumValues : [],
      enumColors: Array.isArray(enumColors) ? enumColors : [],
    }),
    sortOrder,
    timestamp,
    timestamp,
  );

  touchObject(objectRow.id);
  return listFieldsForObject(objectRow.id).find((field) => field.id === fieldId);
}

export function createDataEntry(objectName, { values = {} } = {}) {
  ensureDataSchema();
  const objectRow = getObjectRowByName(objectName);
  if (!objectRow) {
    throw new Error(`Object "${objectName}" not found`);
  }

  const fields = listFieldsForObject(objectRow.id);
  const timestamp = nowMs();
  const entryId = randomUUID();

  sqlite.prepare(`
    INSERT INTO data_entries (id, object_id, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(entryId, objectRow.id, timestamp, timestamp, timestamp);

  const upsertValue = sqlite.prepare(`
    INSERT INTO data_entry_values (entry_id, field_id, value, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(entry_id, field_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);

  for (const field of fields) {
    const incoming = Object.prototype.hasOwnProperty.call(values, field.key)
      ? values[field.key]
      : field.default_value;
    if (incoming == null || incoming === '') continue;
    upsertValue.run(
      entryId,
      field.id,
      serializeValue(incoming, field.type),
      timestamp,
      timestamp,
    );
  }

  touchObject(objectRow.id);
  return { entryId };
}

export function updateDataEntry(objectName, entryId, { values = {} } = {}) {
  ensureDataSchema();
  const objectRow = getObjectRowByName(objectName);
  if (!objectRow) {
    throw new Error(`Object "${objectName}" not found`);
  }

  const entryRow = sqlite
    .prepare('SELECT id FROM data_entries WHERE id = ? AND object_id = ? LIMIT 1')
    .get(entryId, objectRow.id);
  if (!entryRow) {
    throw new Error(`Entry "${entryId}" not found`);
  }

  const fields = listFieldsForObject(objectRow.id);
  const fieldByKey = new Map(fields.map((field) => [field.key, field]));
  const timestamp = nowMs();

  const upsertValue = sqlite.prepare(`
    INSERT INTO data_entry_values (entry_id, field_id, value, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(entry_id, field_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  const deleteValue = sqlite.prepare('DELETE FROM data_entry_values WHERE entry_id = ? AND field_id = ?');

  for (const [fieldKey, nextValue] of Object.entries(values || {})) {
    const field = fieldByKey.get(fieldKey);
    if (!field) continue;

    if (nextValue == null || nextValue === '') {
      deleteValue.run(entryId, field.id);
      continue;
    }

    upsertValue.run(
      entryId,
      field.id,
      serializeValue(nextValue, field.type),
      timestamp,
      timestamp,
    );
  }

  sqlite.prepare('UPDATE data_entries SET updated_at = ? WHERE id = ?').run(timestamp, entryId);
  touchObject(objectRow.id);

  return { ok: true };
}

export function importCsvIntoObject({
  objectName,
  objectLabel,
  csvText,
  replace = false,
  delimiter = ',',
} = {}) {
  ensureDataSchema();
  if (!csvText || !String(csvText).trim()) {
    throw new Error('CSV content is required');
  }

  const rows = parseCsv(String(csvText), delimiter);
  if (rows.length === 0) {
    throw new Error('CSV content is empty');
  }

  const headers = rows[0];
  const body = rows.slice(1);
  const normalizedName = assertObjectName(objectName || objectLabel || 'imported_table');
  let objectRow = getObjectRowByName(normalizedName);

  if (!objectRow) {
    const fieldDefs = headers.map((header, index) => {
      const samples = body.map((row) => row[index]).filter((value) => value != null && value !== '');
      return {
        key: slugify(header || `column_${index + 1}`, `column_${index + 1}`),
        label: header || `Column ${index + 1}`,
        type: inferFieldType(samples),
      };
    });

    createDataObject({
      name: normalizedName,
      label: objectLabel || normalizedName,
      description: 'Imported from CSV',
      fields: fieldDefs,
    });
    objectRow = getObjectRowByName(normalizedName);
  }

  const fields = listFieldsForObject(objectRow.id);
  const fieldByKey = new Map(fields.map((field) => [field.key, field]));

  headers.forEach((header, index) => {
    const key = slugify(header || `column_${index + 1}`, `column_${index + 1}`);
    if (!fieldByKey.has(key)) {
      const samples = body.map((row) => row[index]).filter((value) => value != null && value !== '');
      const created = createDataField(normalizedName, {
        key,
        label: header || `Column ${index + 1}`,
        type: inferFieldType(samples),
      });
      fieldByKey.set(created.key, created);
    }
  });

  if (replace) {
    sqlite.prepare('DELETE FROM data_entries WHERE object_id = ?').run(objectRow.id);
  }

  const currentFields = listFieldsForObject(objectRow.id);
  const currentFieldByKey = new Map(currentFields.map((field) => [field.key, field]));
  const insertEntry = sqlite.prepare(`
    INSERT INTO data_entries (id, object_id, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertValue = sqlite.prepare(`
    INSERT INTO data_entry_values (entry_id, field_id, value, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  let insertedRows = 0;
  for (const row of body) {
    if (!row.some((value) => value != null && value !== '')) continue;
    const timestamp = nowMs();
    const entryId = randomUUID();
    insertEntry.run(entryId, objectRow.id, timestamp, timestamp, timestamp);

    headers.forEach((header, index) => {
      const fieldKey = slugify(header || `column_${index + 1}`, `column_${index + 1}`);
      const field = currentFieldByKey.get(fieldKey);
      const value = row[index];
      if (!field || value == null || value === '') return;
      insertValue.run(
        entryId,
        field.id,
        serializeValue(value, field.type),
        timestamp,
        timestamp,
      );
    });
    insertedRows += 1;
  }

  touchObject(objectRow.id);
  return {
    object: getDataObject(normalizedName)?.object,
    insertedRows,
  };
}

export function exportObjectAsCsv(objectName) {
  const data = getDataObject(objectName);
  if (!data) {
    throw new Error(`Object "${objectName}" not found`);
  }

  const headers = data.fields.map((field) => field.label || field.key);
  const lines = [buildCsvLine(headers)];

  for (const entry of data.entries) {
    lines.push(
      buildCsvLine(
        data.fields.map((field) => {
          const value = entry[field.key];
          if (typeof value === 'boolean') return value ? 'true' : 'false';
          if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
            return JSON.stringify(value);
          }
          return value ?? '';
        }),
      ),
    );
  }

  return lines.join('\n');
}

function buildSnapshotDocument(data) {
  if (!data?.object) {
    throw new Error('Object snapshot data is required');
  }

  return {
    object: data.object,
    fields: Array.isArray(data.fields)
      ? data.fields.map((field) => ({
          id: field.id,
          key: field.key,
          label: field.label,
          type: field.type || 'text',
          required: !!field.required,
          default_value: field.default_value ?? null,
          sort_order: Number(field.sort_order || 0),
          config: field.config || {},
        }))
      : [],
    entries: Array.isArray(data.entries)
      ? data.entries.map((entry) => ({ ...entry }))
      : [],
  };
}

export function listDataSnapshots(objectName, { limit = 20 } = {}) {
  ensureDataSchema();
  const objectRow = getObjectRowByName(objectName);
  if (!objectRow) {
    throw new Error(`Object "${objectName}" not found`);
  }

  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  const rows = sqlite.prepare(`
    SELECT *
    FROM data_snapshots
    WHERE object_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(objectRow.id, safeLimit);

  return rows.map((row) => {
    const snapshot = parseJson(row.snapshot, {});
    return {
      id: row.id,
      object_id: row.object_id,
      label: row.label,
      reason: row.reason || '',
      source: row.source || 'manual',
      field_count: Array.isArray(snapshot?.fields) ? snapshot.fields.length : 0,
      row_count: Array.isArray(snapshot?.entries) ? snapshot.entries.length : 0,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  });
}

export function getDataSnapshot(objectName, snapshotId) {
  ensureDataSchema();
  const objectRow = getObjectRowByName(objectName);
  if (!objectRow) {
    throw new Error(`Object "${objectName}" not found`);
  }

  const row = sqlite.prepare(`
    SELECT *
    FROM data_snapshots
    WHERE object_id = ? AND id = ?
    LIMIT 1
  `).get(objectRow.id, snapshotId);

  if (!row) {
    throw new Error(`Snapshot "${snapshotId}" not found`);
  }

  const snapshot = parseJson(row.snapshot, null);
  return {
    id: row.id,
    object_id: row.object_id,
    label: row.label,
    reason: row.reason || '',
    source: row.source || 'manual',
    snapshot,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createDataSnapshot(objectName, {
  label = '',
  reason = '',
  source = 'manual',
} = {}) {
  ensureDataSchema();
  const objectRow = getObjectRowByName(objectName);
  if (!objectRow) {
    throw new Error(`Object "${objectName}" not found`);
  }

  const objectData = getDataObject(objectName);
  const snapshotDocument = buildSnapshotDocument(objectData);
  const timestamp = nowMs();
  const snapshotId = randomUUID();
  const resolvedLabel = String(label || `${objectData.object?.label || objectName} snapshot`).trim()
    || `${objectData.object?.label || objectName} snapshot`;

  sqlite.prepare(`
    INSERT INTO data_snapshots (id, object_id, label, reason, source, snapshot, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    snapshotId,
    objectRow.id,
    resolvedLabel,
    reason ? String(reason) : null,
    String(source || 'manual'),
    stringifyJson(snapshotDocument),
    timestamp,
    timestamp,
  );

  return getDataSnapshot(objectName, snapshotId);
}

export function restoreDataSnapshot(objectName, snapshotId, {
  createBackup = true,
} = {}) {
  ensureDataSchema();
  const objectRow = getObjectRowByName(objectName);
  if (!objectRow) {
    throw new Error(`Object "${objectName}" not found`);
  }

  const snapshotRecord = getDataSnapshot(objectName, snapshotId);
  const snapshot = snapshotRecord.snapshot;
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('Snapshot payload is missing');
  }

  const snapshotFields = Array.isArray(snapshot.fields) ? snapshot.fields : [];
  const snapshotEntries = Array.isArray(snapshot.entries) ? snapshot.entries : [];
  if (snapshotFields.length === 0) {
    throw new Error('Snapshot has no fields to restore');
  }

  let backupSnapshot = null;
  if (createBackup) {
    backupSnapshot = createDataSnapshot(objectName, {
      label: `Backup before restore ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
      reason: `Auto backup before restoring snapshot "${snapshotRecord.label}"`,
      source: 'restore-backup',
    });
  }

  const timestamp = nowMs();
  const updateObjectStmt = sqlite.prepare(`
    UPDATE data_objects
    SET label = ?, description = ?, icon = ?, default_view = ?, display_field = ?, updated_at = ?
    WHERE id = ?
  `);
  const deleteEntriesStmt = sqlite.prepare('DELETE FROM data_entries WHERE object_id = ?');
  const deleteFieldsStmt = sqlite.prepare('DELETE FROM data_fields WHERE object_id = ?');
  const insertFieldStmt = sqlite.prepare(`
    INSERT INTO data_fields (id, object_id, key, label, type, required, default_value, config, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEntryStmt = sqlite.prepare(`
    INSERT INTO data_entries (id, object_id, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertValueStmt = sqlite.prepare(`
    INSERT INTO data_entry_values (entry_id, field_id, value, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const restoreTxn = sqlite.transaction(() => {
    const resolvedFields = [];

    updateObjectStmt.run(
      snapshot.object?.label || objectRow.label,
      snapshot.object?.description || '',
      snapshot.object?.icon || 'table',
      snapshot.object?.default_view || 'table',
      snapshot.object?.display_field || null,
      timestamp,
      objectRow.id,
    );

    deleteEntriesStmt.run(objectRow.id);
    deleteFieldsStmt.run(objectRow.id);

    for (const field of snapshotFields) {
      const fieldId = field.id || randomUUID();
      const fieldKey = slugify(field.key || field.label || 'field');
      insertFieldStmt.run(
        fieldId,
        objectRow.id,
        fieldKey,
        String(field.label || field.key || 'Field').trim() || 'Field',
        field.type || 'text',
        field.required ? 1 : 0,
        serializeValue(field.default_value, field.type || 'text'),
        stringifyJson(field.config || {}),
        Number(field.sort_order || 0),
        timestamp,
        timestamp,
      );
      resolvedFields.push({
        ...field,
        id: fieldId,
        key: fieldKey,
      });
    }

    for (let index = 0; index < snapshotEntries.length; index += 1) {
      const entry = snapshotEntries[index] || {};
      const entryId = entry.entry_id || randomUUID();
      insertEntryStmt.run(
        entryId,
        objectRow.id,
        Number(entry.sort_order || entry.created_at || index),
        Number(entry.created_at || timestamp),
        Number(entry.updated_at || timestamp),
      );

      for (const field of resolvedFields) {
        if (!Object.prototype.hasOwnProperty.call(entry, field.key)) continue;
        const value = entry[field.key];
        if (value == null || value === '') continue;
        insertValueStmt.run(
          entryId,
          field.id,
          serializeValue(value, field.type || 'text'),
          timestamp,
          timestamp,
        );
      }
    }
  });

  restoreTxn();

  return {
    ok: true,
    object: getDataObject(objectName)?.object || getObjectSummary(objectRow),
    snapshot: getDataSnapshot(objectName, snapshotId),
    backupSnapshot,
    restoredRows: snapshotEntries.length,
    restoredFields: snapshotFields.length,
  };
}

export function listDataActions(objectName) {
  ensureDataSchema();
  const objectRow = getObjectRowByName(objectName);
  if (!objectRow) {
    throw new Error(`Object "${objectName}" not found`);
  }

  const rows = sqlite.prepare(`
    SELECT *
    FROM data_actions
    WHERE object_id = ?
    ORDER BY updated_at DESC, created_at DESC, label ASC
  `).all(objectRow.id);

  return rows.map((row) => ({
    id: row.id,
    object_id: row.object_id,
    key: row.key,
    label: row.label,
    instruction: row.instruction,
    target_fields: parseJson(row.target_fields, []),
    config: parseJson(row.config, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

export function createDataAction(objectName, {
  key,
  label,
  instruction,
  targetFields = [],
  config = {},
} = {}) {
  ensureDataSchema();
  const objectRow = getObjectRowByName(objectName);
  if (!objectRow) {
    throw new Error(`Object "${objectName}" not found`);
  }

  const resolvedLabel = String(label || key || '').trim();
  const resolvedInstruction = String(instruction || '').trim();
  if (!resolvedLabel) {
    throw new Error('Action label is required');
  }
  if (!resolvedInstruction) {
    throw new Error('Action instruction is required');
  }

  const actionKey = slugify(key || resolvedLabel, `action_${Date.now()}`);
  const existing = sqlite
    .prepare('SELECT id FROM data_actions WHERE object_id = ? AND key = ? LIMIT 1')
    .get(objectRow.id, actionKey);
  if (existing) {
    throw new Error(`Action "${actionKey}" already exists`);
  }

  const timestamp = nowMs();
  const actionId = randomUUID();
  sqlite.prepare(`
    INSERT INTO data_actions (id, object_id, key, label, instruction, target_fields, config, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    actionId,
    objectRow.id,
    actionKey,
    resolvedLabel,
    resolvedInstruction,
    stringifyJson(Array.isArray(targetFields) ? targetFields : []),
    stringifyJson(config && typeof config === 'object' ? config : {}),
    timestamp,
    timestamp,
  );

  touchObject(objectRow.id);
  return listDataActions(objectName).find((item) => item.id === actionId);
}

export function updateDataAction(objectName, actionId, {
  key,
  label,
  instruction,
  targetFields,
  config,
} = {}) {
  ensureDataSchema();
  const objectRow = getObjectRowByName(objectName);
  if (!objectRow) {
    throw new Error(`Object "${objectName}" not found`);
  }

  const current = sqlite
    .prepare('SELECT * FROM data_actions WHERE id = ? AND object_id = ? LIMIT 1')
    .get(actionId, objectRow.id);
  if (!current) {
    throw new Error(`Action "${actionId}" not found`);
  }

  const nextKey = key != null
    ? slugify(key || label || current.label, current.key)
    : current.key;
  if (nextKey !== current.key) {
    const duplicate = sqlite
      .prepare('SELECT id FROM data_actions WHERE object_id = ? AND key = ? AND id != ? LIMIT 1')
      .get(objectRow.id, nextKey, actionId);
    if (duplicate) {
      throw new Error(`Action "${nextKey}" already exists`);
    }
  }

  const nextLabel = label != null ? String(label).trim() || current.label : current.label;
  const nextInstruction = instruction != null ? String(instruction).trim() || current.instruction : current.instruction;
  if (!nextLabel) {
    throw new Error('Action label is required');
  }
  if (!nextInstruction) {
    throw new Error('Action instruction is required');
  }

  const nextTargetFields = targetFields === undefined ? current.target_fields : stringifyJson(Array.isArray(targetFields) ? targetFields : []);
  const nextConfig = config === undefined ? current.config : stringifyJson(config && typeof config === 'object' ? config : {});

  sqlite.prepare(`
    UPDATE data_actions
    SET key = ?, label = ?, instruction = ?, target_fields = ?, config = ?, updated_at = ?
    WHERE id = ? AND object_id = ?
  `).run(
    nextKey,
    nextLabel,
    nextInstruction,
    nextTargetFields,
    nextConfig,
    nowMs(),
    actionId,
    objectRow.id,
  );

  touchObject(objectRow.id);
  return listDataActions(objectName).find((item) => item.id === actionId);
}

export function deleteDataAction(objectName, actionId) {
  ensureDataSchema();
  const objectRow = getObjectRowByName(objectName);
  if (!objectRow) {
    throw new Error(`Object "${objectName}" not found`);
  }

  const existing = sqlite
    .prepare('SELECT id FROM data_actions WHERE id = ? AND object_id = ? LIMIT 1')
    .get(actionId, objectRow.id);
  if (!existing) {
    throw new Error(`Action "${actionId}" not found`);
  }

  sqlite.prepare('DELETE FROM data_actions WHERE id = ? AND object_id = ?').run(actionId, objectRow.id);
  touchObject(objectRow.id);
  return { ok: true, id: actionId };
}

export function listDataActionRuns(objectName, { limit = 30, actionId = null } = {}) {
  ensureDataSchema();
  const objectRow = getObjectRowByName(objectName);
  if (!objectRow) {
    throw new Error(`Object "${objectName}" not found`);
  }

  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 30));
  const rows = actionId
    ? sqlite.prepare(`
        SELECT *
        FROM data_action_runs
        WHERE object_id = ? AND action_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(objectRow.id, String(actionId), safeLimit)
    : sqlite.prepare(`
        SELECT *
        FROM data_action_runs
        WHERE object_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(objectRow.id, safeLimit);

  return rows.map((row) => ({
    id: row.id,
    object_id: row.object_id,
    entry_id: row.entry_id || null,
    action_id: row.action_id,
    action_label: row.action_label || row.action_id,
    status: row.status,
    result: parseJson(row.result, row.result),
    error: row.error || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

export function getDataActionRun(objectName, runId) {
  ensureDataSchema();
  const objectRow = getObjectRowByName(objectName);
  if (!objectRow) {
    throw new Error(`Object "${objectName}" not found`);
  }

  const row = sqlite.prepare(`
    SELECT *
    FROM data_action_runs
    WHERE object_id = ? AND id = ?
    LIMIT 1
  `).get(objectRow.id, runId);

  if (!row) {
    throw new Error(`Action run "${runId}" not found`);
  }

  return {
    id: row.id,
    object_id: row.object_id,
    entry_id: row.entry_id || null,
    action_id: row.action_id,
    action_label: row.action_label || row.action_id,
    status: row.status,
    result: parseJson(row.result, row.result),
    error: row.error || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createDataActionRun(objectName, {
  entryId = null,
  actionId = 'custom',
  actionLabel = '',
  status = 'pending',
  result = null,
  error = null,
} = {}) {
  ensureDataSchema();
  const objectRow = getObjectRowByName(objectName);
  if (!objectRow) {
    throw new Error(`Object "${objectName}" not found`);
  }

  if (entryId) {
    const entryRow = sqlite
      .prepare('SELECT id FROM data_entries WHERE id = ? AND object_id = ? LIMIT 1')
      .get(entryId, objectRow.id);
    if (!entryRow) {
      throw new Error(`Entry "${entryId}" not found`);
    }
  }

  const timestamp = nowMs();
  const runId = randomUUID();
  sqlite.prepare(`
    INSERT INTO data_action_runs (id, object_id, entry_id, action_id, action_label, status, result, error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    objectRow.id,
    entryId,
    String(actionId || 'custom'),
    String(actionLabel || actionId || 'Custom action'),
    String(status || 'pending'),
    stringifyJson(result),
    error ? String(error) : null,
    timestamp,
    timestamp,
  );

  return listDataActionRuns(objectName, { limit: 1 })[0];
}

export function updateDataActionRun(objectName, runId, {
  status,
  result,
  error,
} = {}) {
  ensureDataSchema();
  const objectRow = getObjectRowByName(objectName);
  if (!objectRow) {
    throw new Error(`Object "${objectName}" not found`);
  }

  const existing = sqlite
    .prepare('SELECT id FROM data_action_runs WHERE id = ? AND object_id = ? LIMIT 1')
    .get(runId, objectRow.id);
  if (!existing) {
    throw new Error(`Action run "${runId}" not found`);
  }

  const current = sqlite
    .prepare('SELECT * FROM data_action_runs WHERE id = ? LIMIT 1')
    .get(runId);
  const nextStatus = status != null ? String(status) : current.status;
  const nextResult = result === undefined ? current.result : stringifyJson(result);
  const nextError = error === undefined ? current.error : (error ? String(error) : null);

  sqlite.prepare(`
    UPDATE data_action_runs
    SET status = ?, result = ?, error = ?, updated_at = ?
    WHERE id = ? AND object_id = ?
  `).run(nextStatus, nextResult, nextError, nowMs(), runId, objectRow.id);

  return getDataActionRun(objectName, runId);
}

export function registerDataApiRoutes(app) {
  app.get('/api/data/objects', (req, res) => {
    try {
      const search = String(req.query.q || '');
      res.json({ objects: listDataObjects({ search }) });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/data/objects', (req, res) => {
    try {
      const result = createDataObject(req.body || {});
      res.status(201).json(result);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/data/objects/:name', (req, res) => {
    try {
      const result = getDataObject(req.params.name, { search: String(req.query.q || '') });
      if (!result) {
        return res.status(404).json({ error: 'Object not found' });
      }
      return res.json(result);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/data/objects/:name/fields', (req, res) => {
    try {
      const field = createDataField(req.params.name, req.body || {});
      res.status(201).json({ field });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/data/objects/:name/entries', (req, res) => {
    try {
      const result = createDataEntry(req.params.name, req.body || {});
      res.status(201).json(result);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.patch('/api/data/objects/:name/entries/:entryId', (req, res) => {
    try {
      const result = updateDataEntry(req.params.name, req.params.entryId, req.body || {});
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/data/objects/:name/snapshots', (req, res) => {
    try {
      const snapshots = listDataSnapshots(req.params.name, {
        limit: Number(req.query.limit || 20),
      });
      res.json({ snapshots });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/data/objects/:name/snapshots/:snapshotId', (req, res) => {
    try {
      const snapshot = getDataSnapshot(req.params.name, req.params.snapshotId);
      res.json({ snapshot });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/data/objects/:name/snapshots', (req, res) => {
    try {
      const snapshot = createDataSnapshot(req.params.name, req.body || {});
      res.status(201).json({ snapshot });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/data/objects/:name/snapshots/:snapshotId/restore', (req, res) => {
    try {
      const result = restoreDataSnapshot(req.params.name, req.params.snapshotId, req.body || {});
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/data/objects/:name/actions', (req, res) => {
    try {
      const actions = listDataActions(req.params.name);
      res.json({ actions });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/data/objects/:name/actions', (req, res) => {
    try {
      const action = createDataAction(req.params.name, req.body || {});
      res.status(201).json({ action });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.patch('/api/data/objects/:name/actions/:actionId', (req, res) => {
    try {
      const action = updateDataAction(req.params.name, req.params.actionId, req.body || {});
      res.json({ action });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.delete('/api/data/objects/:name/actions/:actionId', (req, res) => {
    try {
      const result = deleteDataAction(req.params.name, req.params.actionId);
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/data/objects/:name/actions/runs', (req, res) => {
    try {
      const runs = listDataActionRuns(req.params.name, {
        limit: Number(req.query.limit || 30),
        actionId: req.query.actionId ? String(req.query.actionId) : null,
      });
      res.json({ runs });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/data/objects/:name/actions/runs/:runId', (req, res) => {
    try {
      const run = getDataActionRun(req.params.name, req.params.runId);
      res.json({ run });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/data/objects/:name/actions/runs', (req, res) => {
    try {
      const run = createDataActionRun(req.params.name, req.body || {});
      res.status(201).json({ run });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.patch('/api/data/objects/:name/actions/runs/:runId', (req, res) => {
    try {
      const run = updateDataActionRun(req.params.name, req.params.runId, req.body || {});
      res.json({ run });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/data/import/csv', (req, res) => {
    try {
      const result = importCsvIntoObject(req.body || {});
      res.status(201).json(result);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get('/api/data/objects/:name/export.csv', (req, res) => {
    try {
      const csv = exportObjectAsCsv(req.params.name);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}.csv"`);
      res.send(csv);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
}
