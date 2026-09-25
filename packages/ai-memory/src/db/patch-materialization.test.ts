import assert from 'node:assert/strict';
import { test } from 'vitest';

import { applySnapshotPatch } from './patch.js';

const SNAPSHOT_CREATED_AT = '2026-02-07T00:00:00.000Z';

test('applySnapshotPatch supports add/set/remove semantics without mutating base snapshot', () => {
  const baseSnapshot = {
    arr: [1, 2],
    created_at: SNAPSHOT_CREATED_AT,
    metrics: { hr: 70 },
    snapshot_id: 'snap-base',
  };

  const patched = applySnapshotPatch(baseSnapshot, {
    patch: {
      ops: [
        { op: 'set', path: '/metrics/hr', value: 72 },
        { op: 'add', path: '/arr/-', value: 3 },
        { op: 'remove', path: '/metrics/missing' },
      ],
    },
  });

  assert.deepEqual(baseSnapshot, {
    arr: [1, 2],
    created_at: SNAPSHOT_CREATED_AT,
    metrics: { hr: 70 },
    snapshot_id: 'snap-base',
  });
  assert.deepEqual(patched, {
    arr: [1, 2, 3],
    created_at: SNAPSHOT_CREATED_AT,
    metrics: { hr: 72 },
    snapshot_id: 'snap-base',
  });
});

test('applySnapshotPatch rejects unsafe pointer tokens', () => {
  assert.throws(() => {
    applySnapshotPatch(
      {},
      {
        patch: {
          ops: [{ op: 'set', path: '/__proto__/polluted', value: true }],
        },
      },
    );
  }, /protected object token/);
});
