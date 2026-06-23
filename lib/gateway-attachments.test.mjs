import test from 'node:test';
import assert from 'node:assert/strict';
import { withGatewayAttachments } from './gateway-attachments.mjs';

test('forwards native screen image attachments to the gateway agent request', () => {
  const attachments = [{
    type: 'image',
    mimeType: 'image/jpeg',
    fileName: 'mac-screen.jpg',
    content: '/9j/AA==',
  }];

  assert.deepEqual(withGatewayAttachments({ message: 'Inspect my screen.' }, attachments), {
    message: 'Inspect my screen.',
    attachments: [{
      ...attachments[0],
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: '/9j/AA==',
      },
    }],
  });
});

test('leaves gateway requests unchanged when no attachment exists', () => {
  const params = { message: 'Text only.' };
  assert.equal(withGatewayAttachments(params, []), params);
  assert.equal(withGatewayAttachments(params, null), params);
});

test('preserves opaque attachments that do not have base64 image content', () => {
  const attachment = { type: 'file', fileName: 'notes.txt' };
  assert.deepEqual(withGatewayAttachments({ message: 'Read this.' }, [attachment]), {
    message: 'Read this.',
    attachments: [attachment],
  });
});
