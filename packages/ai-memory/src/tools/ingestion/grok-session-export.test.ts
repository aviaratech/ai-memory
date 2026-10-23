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

test('Grok export resumes idempotently and never proposes durable memories', () => {
  const parsed = parseGrokSessionExport(GROK_SESSION_EXPORT_FIXTURE);
  const firstRun = buildAutoMemoryDelta({
    agent: 'grok-build',
    createdAt: TEST_CREATED_AT,
    evidenceRefs: [`grok://session/${TEST_SESSION_ID}`],
    history: parsed.history.slice(0, 2),
    repoId: 'example/catalog',
    sessionId: TEST_SESSION_ID,
    source: 'grok-session-end',
  });
  const resumedRun = buildAutoMemoryDelta({
    agent: 'grok-build',
    createdAt: TEST_CREATED_AT,
    evidenceRefs: [`grok://session/${TEST_SESSION_ID}`],
    history: parsed.history,
    repoId: 'example/catalog',
    sessionId: TEST_SESSION_ID,
    source: 'grok-session-end',
  });

  const replayedRun = buildAutoMemoryDelta({
    agent: 'grok-build',
    createdAt: TEST_CREATED_AT,
    evidenceRefs: [`grok://session/${TEST_SESSION_ID}`],
    history: parsed.history,
    repoId: 'example/catalog',
    sessionId: TEST_SESSION_ID,
    source: 'grok-session-end',
  });

  assert.notEqual(firstRun.delta_id, resumedRun.delta_id, 'new turns give a new delta');
  assert.equal(resumedRun.delta_id, replayedRun.delta_id, 'replay must be idempotent');
  assert.equal('x_durable_memories' in resumedRun, false, 'ingestion never proposes durable memories');
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
