import test from 'node:test';
import assert from 'node:assert/strict';
import { createSSESender } from './sse-stream.mjs';

test('createSSESender normalizes payloads and increments sequence', () => {
  const writes = [];
  const res = {
    writableEnded: false,
    write(chunk) {
      writes.push(chunk);
    },
  };

  const sent = [];
  const send = createSSESender(res, {
    normalize(event, data, sequence) {
      return { event, ...data, sequence };
    },
    onSend(event, payload) {
      sent.push({ event, payload });
    },
  });

  const first = send('start', { ok: true });
  const second = send('done', { ok: false });

  assert.equal(first.sequence, 0);
  assert.equal(second.sequence, 1);
  assert.equal(sent.length, 2);
  assert.match(writes[0], /event: start/);
  assert.match(writes[1], /event: done/);
});

test('createSSESender no-ops after stream end', () => {
  const res = {
    writableEnded: true,
    write() {
      throw new Error('should not write');
    },
  };

  const send = createSSESender(res);
  assert.equal(send('done', { ok: true }), null);
});
