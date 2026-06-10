import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedCorsOrigin, parseExplicitCorsOrigins } from './cors-policy.mjs';

test('bridge CORS permits Trooper production and local development origins', () => {
  assert.equal(isAllowedCorsOrigin(undefined), true);
  assert.equal(isAllowedCorsOrigin('https://app.trooper.so'), true);
  assert.equal(isAllowedCorsOrigin('https://preview.trooper.so'), true);
  assert.equal(isAllowedCorsOrigin('https://org-example.crabhq.com'), true);
  assert.equal(isAllowedCorsOrigin('https://legacy.trooper.com'), true);
  assert.equal(isAllowedCorsOrigin('http://localhost:5173'), true);
  assert.equal(isAllowedCorsOrigin('http://127.0.0.1:3000'), true);
});

test('bridge CORS rejects malformed, insecure, and suffix-confusion origins', () => {
  assert.equal(isAllowedCorsOrigin('https://example.com'), false);
  assert.equal(isAllowedCorsOrigin('https://deploy-preview-42.netlify.app'), false);
  assert.equal(isAllowedCorsOrigin('https://app.trooper.so.evil.example'), false);
  assert.equal(isAllowedCorsOrigin('http://app.trooper.so'), false);
  assert.equal(isAllowedCorsOrigin('https://org-example.crabhq.com/path'), false);
  assert.equal(isAllowedCorsOrigin('not-an-origin'), false);
});

test('bridge CORS supports exact deployment-specific origins from the environment', () => {
  const configured = 'https://staging.example.com, https://customer.example.org';
  assert.deepEqual(
    [...parseExplicitCorsOrigins(configured)],
    ['https://staging.example.com', 'https://customer.example.org'],
  );
  assert.equal(isAllowedCorsOrigin('https://staging.example.com', configured), true);
  assert.equal(isAllowedCorsOrigin('https://other.example.com', configured), false);
});
