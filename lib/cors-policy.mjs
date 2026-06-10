const DEFAULT_ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/(?:[a-z0-9-]+\.)*trooper\.so$/i,
  /^https:\/\/(?:[a-z0-9-]+\.)*crabhq\.com$/i,
  /^https:\/\/(?:[a-z0-9-]+\.)*trooper\.com$/i,
  /^https?:\/\/localhost(?::\d+)?$/i,
  /^https?:\/\/127\.0\.0\.1(?::\d+)?$/i,
];

function normalizeOrigin(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    return url.origin === text ? url.origin : '';
  } catch {
    return '';
  }
}

export function parseExplicitCorsOrigins(value = '') {
  return new Set(
    String(value || '')
      .split(',')
      .map(normalizeOrigin)
      .filter(Boolean),
  );
}

export function isAllowedCorsOrigin(
  origin,
  explicitOrigins = process.env.BRIDGE_CORS_ALLOWED_ORIGINS || '',
) {
  if (!origin) return true;
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  if (parseExplicitCorsOrigins(explicitOrigins).has(normalized)) return true;
  return DEFAULT_ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(normalized));
}
