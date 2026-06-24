import path from 'path';
import { existsSync, readFileSync, statSync } from 'fs';

const WORKSPACE_HOST_ROOT = '/opt/openclaw-data/workspace';
const WORKSPACE_CONTAINER_ROOT = '/home/node/.openclaw/workspace';
const MAX_GATEWAY_ATTACHMENT_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_GATEWAY_ATTACHMENT_MEDIA_BYTES = 15 * 1024 * 1024;
const EXT_TO_MIME = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.bmp', 'image/bmp'],
  ['.heic', 'image/heic'],
  ['.tiff', 'image/tiff'],
  ['.mp4', 'video/mp4'],
  ['.mov', 'video/quicktime'],
  ['.webm', 'video/webm'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.m4a', 'audio/mp4'],
  ['.pdf', 'application/pdf'],
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.csv', 'text/csv'],
  ['.json', 'application/json'],
]);

function inferAttachmentMimeType(attachment = {}) {
  const explicitMimeType = typeof attachment.mimeType === 'string'
    ? attachment.mimeType.trim().toLowerCase()
    : '';
  if (explicitMimeType) return explicitMimeType;
  const source = String(
    attachment.fileName
    || attachment.name
    || attachment.path
    || attachment.filePath
    || ''
  ).trim();
  const ext = path.extname(source).toLowerCase();
  return EXT_TO_MIME.get(ext) || '';
}

function maxBytesForMimeType(mimeType = '') {
  if (mimeType.startsWith('image/')) return MAX_GATEWAY_ATTACHMENT_IMAGE_BYTES;
  if (mimeType.startsWith('video/') || mimeType.startsWith('audio/')) return MAX_GATEWAY_ATTACHMENT_MEDIA_BYTES;
  if (mimeType === 'application/pdf' || mimeType.startsWith('text/') || mimeType.startsWith('application/')) {
    return MAX_GATEWAY_ATTACHMENT_MEDIA_BYTES;
  }
  return 0;
}

function decodedBase64Bytes(content = '') {
  const data = String(content || '').replace(/^data:[^,]+,/, '').replace(/\s+/g, '');
  if (!data) return 0;
  return Buffer.byteLength(data, 'base64');
}

function safeAttachmentFileName(attachment = {}, resolvedPath = '') {
  return String(
    attachment.fileName
    || attachment.name
    || (resolvedPath ? path.basename(resolvedPath) : '')
    || 'attachment'
  )
    .replace(/[/\\\0]/g, '-')
    .trim()
    .slice(0, 160) || 'attachment';
}

function resolveAttachmentFilePath(attachment = {}) {
  const rawPath = String(attachment.path || attachment.filePath || '').trim();
  if (!rawPath) return null;
  const relativePath = rawPath.replace(/^\/+/, '');
  const candidates = [
    rawPath,
    path.join(WORKSPACE_HOST_ROOT, relativePath),
    path.join(WORKSPACE_CONTAINER_ROOT, relativePath),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

function normalizeGatewayAttachment(attachment = null) {
  if (!attachment || typeof attachment !== 'object') return null;
  if (attachment.modelAttachment === false) return null;
  const content = typeof attachment.content === 'string' ? attachment.content.trim() : '';
  const mimeType = inferAttachmentMimeType(attachment);
  const maxBytes = maxBytesForMimeType(mimeType);
  if (!mimeType || maxBytes <= 0) return null;
  if (!content) {
    const resolvedPath = resolveAttachmentFilePath(attachment);
    if (!resolvedPath) return null;
    const fileStat = statSync(resolvedPath);
    if (fileStat.size > maxBytes) return null;
    const fileContent = readFileSync(resolvedPath).toString('base64');
    if (!fileContent) return null;
    return {
      ...attachment,
      mimeType,
      fileName: safeAttachmentFileName(attachment, resolvedPath),
      content: fileContent,
      source: {
        type: 'base64',
        media_type: mimeType,
        data: fileContent,
      },
    };
  }
  if (decodedBase64Bytes(content) > maxBytes) {
    return null;
  }
  const dataUrlMatch = content.match(/^data:([^;,]+);base64,(.+)$/is);
  const normalizedContent = dataUrlMatch ? dataUrlMatch[2].replace(/\s+/g, '') : content.replace(/\s+/g, '');

  // OpenClaw builds have accepted both the compact RPC shape
  // (`content`) and Anthropic-style source blocks. Send both so native
  // helper screenshots survive mixed gateway versions during rollout.
  return {
    ...attachment,
    fileName: safeAttachmentFileName(attachment),
    content: normalizedContent,
    mimeType,
    source: {
      type: 'base64',
      media_type: mimeType,
      data: normalizedContent,
    },
  };
}

export function withGatewayAttachments(params = {}, attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return params;
  const normalized = attachments.map(normalizeGatewayAttachment).filter(Boolean);
  if (normalized.length === 0) return params;
  return { ...params, attachments: normalized };
}
