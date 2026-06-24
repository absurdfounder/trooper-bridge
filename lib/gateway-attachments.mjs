import path from 'path';
import { existsSync, readFileSync, statSync } from 'fs';

const WORKSPACE_HOST_ROOT = '/opt/openclaw-data/workspace';
const WORKSPACE_CONTAINER_ROOT = '/home/node/.openclaw/workspace';
const MAX_GATEWAY_ATTACHMENT_IMAGE_BYTES = 768 * 1024;
const IMAGE_EXT_TO_MIME = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.bmp', 'image/bmp'],
  ['.heic', 'image/heic'],
  ['.tiff', 'image/tiff'],
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
  return IMAGE_EXT_TO_MIME.get(ext) || '';
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
  if (!content) {
    if (!mimeType.startsWith('image/')) return null;
    const resolvedPath = resolveAttachmentFilePath(attachment);
    if (!resolvedPath) return null;
    const fileStat = statSync(resolvedPath);
    if (fileStat.size > MAX_GATEWAY_ATTACHMENT_IMAGE_BYTES) return null;
    const fileContent = readFileSync(resolvedPath).toString('base64');
    if (!fileContent) return null;
    return {
      ...attachment,
      mimeType,
      content: fileContent,
      source: {
        type: 'base64',
        media_type: mimeType,
        data: fileContent,
      },
    };
  }
  if (!mimeType) return null;
  if (Buffer.byteLength(content.replace(/^data:[^,]+,/, '').replace(/\s+/g, ''), 'base64') > MAX_GATEWAY_ATTACHMENT_IMAGE_BYTES) {
    return null;
  }

  // OpenClaw builds have accepted both the compact RPC shape
  // (`content`) and Anthropic-style source blocks. Send both so native
  // helper screenshots survive mixed gateway versions during rollout.
  return {
    ...attachment,
    content,
    mimeType,
    source: {
      type: 'base64',
      media_type: mimeType,
      data: content,
    },
  };
}

export function withGatewayAttachments(params = {}, attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return params;
  const normalized = attachments.map(normalizeGatewayAttachment).filter(Boolean);
  if (normalized.length === 0) return params;
  return { ...params, attachments: normalized };
}
