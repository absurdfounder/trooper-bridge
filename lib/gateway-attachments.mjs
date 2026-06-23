function normalizeGatewayAttachment(attachment = null) {
  if (!attachment || typeof attachment !== 'object') return null;
  const content = typeof attachment.content === 'string' ? attachment.content.trim() : '';
  const mimeType = typeof attachment.mimeType === 'string' ? attachment.mimeType.trim() : '';
  if (!content || !mimeType) return attachment;

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
  return { ...params, attachments: attachments.map(normalizeGatewayAttachment).filter(Boolean) };
}
