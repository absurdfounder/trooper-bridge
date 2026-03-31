export function createSSESender(res, {
  normalize = (_event, data) => data,
  onSend = null,
} = {}) {
  let sequence = 0;

  return (event, data = {}) => {
    if (res.writableEnded) return null;
    const payload = normalize(event, data, sequence++);
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    if (typeof onSend === 'function') onSend(event, payload);
    return payload;
  };
}
