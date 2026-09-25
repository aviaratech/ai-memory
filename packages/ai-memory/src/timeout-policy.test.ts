import assert from 'node:assert/strict';
import { test } from 'vitest';

import { hasTimeoutWarning, resolveTimeoutPolicy, TimeoutError, withTimeout } from './timeout-policy.js';

test('resolveTimeoutPolicy returns defaults when env is empty', () => {
  const policy = resolveTimeoutPolicy({});

  assert.equal(policy.db.readTimeoutMs, 5000);
  assert.equal(policy.db.writeTimeoutMs, 15000);
  assert.equal(policy.db.queryTimeoutMs, 15000);
  assert.equal(policy.db.statementTimeoutMs, 15000);
  assert.equal(policy.embedding.timeoutMs, 5000);
  assert.equal(policy.orient.stepTimeoutMs, 5000);
  assert.equal(policy.health.orientTimeoutTargetPct, 1);
});

test('resolveTimeoutPolicy applies positive env overrides', () => {
  const policy = resolveTimeoutPolicy({
    AI_MEMORY_DB_READ_TIMEOUT_MS: '1234',
    AI_MEMORY_DB_WRITE_TIMEOUT_MS: '9876',
    AI_MEMORY_EMBEDDING_TIMEOUT_MS: '3333',
    AI_MEMORY_ORIENT_STEP_TIMEOUT_MS: '2222',
    AI_MEMORY_ORIENT_TIMEOUT_TARGET_PCT: '0.8',
  });

  assert.equal(policy.db.readTimeoutMs, 1234);
  assert.equal(policy.db.writeTimeoutMs, 9876);
  assert.equal(policy.db.queryTimeoutMs, 9876);
  assert.equal(policy.db.statementTimeoutMs, 9876);
  assert.equal(policy.embedding.timeoutMs, 3333);
  assert.equal(policy.orient.stepTimeoutMs, 2222);
  assert.equal(policy.health.orientTimeoutTargetPct, 0.8);
});

test('withTimeout rejects with TimeoutError when task exceeds timeout', async () => {
  await assert.rejects(
    withTimeout({
      operation: 'test.operation',
      task: () => new Promise(() => undefined),
      timeoutMs: 10,
    }),
    error => error instanceof TimeoutError && error.message.includes('test.operation timed out after 10ms'),
  );
});

test('hasTimeoutWarning detects timeout phrasing', () => {
  assert.equal(hasTimeoutWarning('memory_orient.search timed out after 20ms'), true);
  assert.equal(hasTimeoutWarning('search failed: connection reset'), false);
});
