import assert from 'node:assert/strict';
import { test } from 'vitest';

import { buildAutoMemoryDelta, loadGrokSessionExport, parseGrokSessionExport } from './auto-session-ingest.js';
import { GROK_SESSION_EXPORT_FIXTURE } from './grok-session-export.fixture.js';

const TEST_CREATED_AT = '2026-09-08T12:00:00.000Z';
const TEST_SESSION_ID = 'grok-fixture-session';

test('parseGrokSessionExport preserves ordered user and assistant turns while counting tool evidence', () => {
  const parsed = parseGrokSessionExport(GROK_SESSION_EXPORT_FIXTURE);

  assert.deepEqual(
    parsed.history.map(turn => [turn.role, turn.turnId]),
    [
      ['user', 'grok-user-1'],
      ['assistant', 'grok-assistant-1'],
      ['user', 'grok-user-2'],
      ['assistant', 'grok-assistant-2'],
    ],
  );
  assert.equal(parsed.toolCallCount, 1);
  assert.match(parsed.history[0]?.content ?? '', /early-decision marker/u);
  assert.match(parsed.lastAssistantMessage ?? '', /bounded continuity pack/u);
});

test('Grok export keeps an earlier decision searchable after a newer turn and resumes idempotently', () => {
  const parsed = parseGrokSessionExport(GROK_SESSION_EXPORT_FIXTURE);
  const firstRun = buildAutoMemoryDelta({
    agent: 'grok-build',
    autoDurablePromotionEnabled: true,
    createdAt: TEST_CREATED_AT,
    evidenceRefs: [`grok://session/${TEST_SESSION_ID}`],
    history: parsed.history.slice(0, 2),
    repoId: 'example/catalog',
    sessionId: TEST_SESSION_ID,
    source: 'grok-session-end',
  });
  const resumedRun = buildAutoMemoryDelta({
    agent: 'grok-build',
    autoDurablePromotionEnabled: true,
    createdAt: TEST_CREATED_AT,
    evidenceRefs: [`grok://session/${TEST_SESSION_ID}`],
    history: parsed.history,
    repoId: 'example/catalog',
    sessionId: TEST_SESSION_ID,
    source: 'grok-session-end',
  });

  const firstKeys = new Set(firstRun.x_durable_memories?.map(memory => memory.memory_key) ?? []);
  const resumedMemories = resumedRun.x_durable_memories ?? [];
  const resumedKeys = resumedMemories.map(memory => memory.memory_key);

  assert.ok(
    resumedMemories.some(memory => /early-decision marker/u.test(memory.content)),
    'the earlier decision must remain in the searchable durable proposals after later turns arrive',
  );
  assert.equal(new Set(resumedKeys).size, resumedKeys.length, 'one replay must not create duplicate turn keys');
  for (const key of firstKeys) {
    assert.ok(resumedKeys.includes(key), `resumed ingestion must retain stable key ${key}`);
  }
  assert.equal(resumedRun.created_at, TEST_CREATED_AT, 'the source event timestamp must be retained on the delta');
});

test('loadGrokSessionExport invokes the supported exporter without exposing transcript content', async () => {
  const calls: { args: string[]; command: string; timeout: number }[] = [];
  const parsed = await loadGrokSessionExport({ command: '/mock/grok', sessionId: TEST_SESSION_ID }, input => {
    calls.push({ args: input.args, command: input.command, timeout: input.options.timeout ?? 0 });
    return Promise.resolve({ stdout: GROK_SESSION_EXPORT_FIXTURE });
  });

  assert.deepEqual(calls, [
    {
      args: ['--no-auto-update', 'export', TEST_SESSION_ID],
      command: '/mock/grok',
      timeout: 10_000,
    },
  ]);
  assert.equal(parsed.history.length, 4);
});

test('loadGrokSessionExport reports an unsupported export format explicitly', async () => {
  await assert.rejects(
    () =>
      loadGrokSessionExport({ sessionId: TEST_SESSION_ID }, () =>
        Promise.resolve({ stdout: 'unstructured text without supported conversation sections' }),
      ),
    /did not contain supported conversation sections/u,
  );
});
