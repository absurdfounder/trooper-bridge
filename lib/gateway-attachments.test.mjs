import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
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

test('drops opaque attachments that cannot be sent through the gateway', () => {
  const attachment = { type: 'file', fileName: 'notes.txt' };
  assert.deepEqual(withGatewayAttachments({ message: 'Read this.' }, [attachment]), { message: 'Read this.' });
});

test('drops reference-only image attachments before gateway send', () => {
  const attachment = {
    type: 'image',
    fileName: 'clip.mp4-poster.png',
    path: '/workspace/clip.mp4-poster.png',
    mimeType: 'image/png',
    modelAttachment: false,
  };
  assert.deepEqual(withGatewayAttachments({ message: 'Keep as file ref.' }, [attachment]), { message: 'Keep as file ref.' });
});

test('hydrates workspace image attachments from file paths before gateway send', () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gateway-attachments-'));
  const imagePath = path.join(tempRoot, 'screen.png');
  writeFileSync(imagePath, 'fake-image');

  try {
    const attachment = {
      type: 'image',
      fileName: 'screen.png',
      path: imagePath,
      mimeType: 'image/png',
    };

    assert.deepEqual(withGatewayAttachments({ message: 'Inspect upload.' }, [attachment]), {
      message: 'Inspect upload.',
      attachments: [{
        ...attachment,
        content: Buffer.from('fake-image').toString('base64'),
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: Buffer.from('fake-image').toString('base64'),
        },
      }],
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('drops oversized workspace image attachments instead of hydrating them', () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gateway-attachments-'));
  const imagePath = path.join(tempRoot, 'large-screen.png');
  writeFileSync(imagePath, Buffer.alloc(6 * 1024 * 1024 + 1, 1));

  try {
    const attachment = {
      type: 'image',
      fileName: 'large-screen.png',
      path: imagePath,
      mimeType: 'image/png',
    };

    assert.deepEqual(withGatewayAttachments({ message: 'Inspect upload.' }, [attachment]), { message: 'Inspect upload.' });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('hydrates workspace document attachments from file paths before gateway send', () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gateway-attachments-'));
  const docPath = path.join(tempRoot, 'notes.txt');
  writeFileSync(docPath, 'hello from a text attachment');

  try {
    const attachment = {
      type: 'file',
      fileName: 'notes.txt',
      path: docPath,
      mimeType: 'text/plain',
    };

    assert.deepEqual(withGatewayAttachments({ message: 'Read this.' }, [attachment]), {
      message: 'Read this.',
      attachments: [{
        ...attachment,
        content: Buffer.from('hello from a text attachment').toString('base64'),
        source: {
          type: 'base64',
          media_type: 'text/plain',
          data: Buffer.from('hello from a text attachment').toString('base64'),
        },
      }],
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('drops oversized workspace media attachments instead of hydrating them', () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gateway-attachments-'));
  const videoPath = path.join(tempRoot, 'clip.mp4');
  writeFileSync(videoPath, Buffer.alloc(15 * 1024 * 1024 + 1, 1));

  try {
    const attachment = {
      type: 'video',
      fileName: 'clip.mp4',
      path: videoPath,
      mimeType: 'video/mp4',
    };

    assert.deepEqual(withGatewayAttachments({ message: 'Watch this.' }, [attachment]), { message: 'Watch this.' });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
