import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  allocateSlotPorts,
  buildWorkspaceSlotPaths,
  ensureWorkspaceSlot,
  normalizeWorkspaceSlotId,
  readSlotRegistry,
  updateWorkspaceSlotStatus,
} from './shared-workspace-slots.mjs';

test('normalizeWorkspaceSlotId keeps safe workspace ids', () => {
  assert.equal(normalizeWorkspaceSlotId(' Org ABC !! '), 'org-abc');
  assert.throws(() => normalizeWorkspaceSlotId('!!!'), /workspace slot id is required/);
});

test('buildWorkspaceSlotPaths creates per-workspace isolated roots', () => {
  const paths = buildWorkspaceSlotPaths('org-abc', { root: '/tmp/trooper-workspaces' });
  assert.equal(paths.base, '/tmp/trooper-workspaces/org-abc');
  assert.equal(paths.workspaceRoot, '/tmp/trooper-workspaces/org-abc/openclaw-data/workspace');
  assert.equal(paths.browserProfileRoot, '/tmp/trooper-workspaces/org-abc/browser-profile');
});

test('allocateSlotPorts offsets every shared runtime service', () => {
  assert.deepEqual(allocateSlotPorts(2), {
    bridge: 32002,
    gateway: 33002,
    vnc: 34002,
    websockify: 35002,
    desktopApi: 36002,
  });
});

test('ensureWorkspaceSlot creates registry entry and isolated directories', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'trooper-slots-'));
  const registryPath = path.join(tmp, 'state', 'slots.json');

  try {
    const slot = ensureWorkspaceSlot({
      orgId: 'org-abc',
      orgName: 'Acme',
      ownerUserId: 'user-1',
      publicBaseUrl: 'https://org-abc.crabhq.com',
      root: path.join(tmp, 'workspaces'),
      registryPath,
      now: 123,
    });

    assert.equal(slot.slotId, 'org-abc');
    assert.equal(slot.status, 'cold');
    assert.equal(slot.publicBaseUrl, 'https://org-abc.crabhq.com');
    assert.equal(slot.ports.bridge, 32000);

    const updated = updateWorkspaceSlotStatus({
      slotId: 'org-abc',
      status: 'paused',
      registryPath,
      now: 456,
    });
    assert.equal(updated.status, 'paused');

    const registry = readSlotRegistry(registryPath);
    assert.equal(registry.slots['org-abc'].status, 'paused');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('workspace slot status updates normalize the same id as slot creation', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'trooper-slots-'));
  const registryPath = path.join(tmp, 'state', 'slots.json');

  try {
    const slot = ensureWorkspaceSlot({
      orgId: 'Org ABC !!',
      orgName: 'Acme',
      ownerUserId: 'user-1',
      root: path.join(tmp, 'workspaces'),
      registryPath,
      now: 123,
    });
    assert.equal(slot.slotId, 'org-abc');

    const updated = updateWorkspaceSlotStatus({
      slotId: 'Org ABC !!',
      status: 'starting',
      registryPath,
      now: 456,
    });
    assert.equal(updated.slotId, 'org-abc');
    assert.equal(updated.status, 'starting');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
