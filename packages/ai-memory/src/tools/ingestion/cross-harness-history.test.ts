import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import {
  buildAutoMemoryDelta,
  parseClaudeTranscriptSummary,
  parseCodexSessionSummary,
  parseGrokSessionExport,
} from './auto-session-ingest.js';
import { GROK_SESSION_EXPORT_FIXTURE } from './grok-session-export.fixture.js';

const EARLY_DECISION_MARKER = 'fixture-early-cross-harness-decision';
const PROJECT = 'example/catalog';
const SOURCE_EVENT_AT = '2026-09-08T12:00:00.000Z';

test('Codex history retains each source model across a model switch and replay without inventing unknown models', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'ai-memory-model-history-'));
  const codexPath = join(fixtureDir, 'codex.jsonl');
  const earlierEntries = [
    { payload: { id: 'mixed-model-session' }, timestamp: '2026-08-20T12:00:00.000Z', type: 'session_meta' },
    {
      payload: { message: 'Earlier response with unknown source model.', type: 'agent_message' },
      timestamp: '2026-08-20T12:01:00.000Z',
      type: 'event_msg',
    },
    { payload: { model: 'fixture-model-a' }, type: 'turn_context' },
    {
      payload: { message: 'A source-attributed decision from model A.', type: 'agent_message' },
      timestamp: '2026-08-20T12:02:00.000Z',
      type: 'event_msg',
    },
  ];
  const laterEntries = [
    { payload: { model: 'fixture-model-b' }, type: 'turn_context' },
    {
      payload: {
        content: [{ text: 'A later decision from model B.', type: 'output_text' }],
        role: 'assistant',
        type: 'message',
      },
      timestamp: SOURCE_EVENT_AT,
      type: 'response_item',
    },
    { payload: {}, type: 'turn_context' },
    {
      payload: { message: 'A later response whose model was not supplied.', type: 'agent_message' },
      timestamp: '2026-09-08T12:01:00.000Z',
      type: 'event_msg',
    },
  ];
  const sourceModels = () =>
    parseCodexSessionSummary(codexPath).history.map(turn => ({ model: turn.model ?? null, turnId: turn.turnId }));

  try {
    writeFileSync(codexPath, earlierEntries.map(entry => JSON.stringify(entry)).join('\n'));
    const earlier = sourceModels();
    assert.deepEqual(
      earlier.map(turn => turn.model),
      [null, 'fixture-model-a'],
    );

    writeFileSync(codexPath, [...earlierEntries, ...laterEntries].map(entry => JSON.stringify(entry)).join('\n'));
    const resumed = sourceModels();
    assert.deepEqual(
      resumed.map(turn => turn.model),
      [null, 'fixture-model-a', 'fixture-model-b', null],
    );
    assert.deepEqual(
      resumed.slice(0, earlier.length),
      earlier,
      'later model changes cannot rewrite earlier attribution',
    );
    assert.deepEqual(sourceModels(), resumed, 'replay retains the same turn attribution');
  } finally {
    rmSync(fixtureDir, { force: true, recursive: true });
  }
});

test('Claude message models and unknown Grok export models survive history parsing', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'ai-memory-harness-models-'));
  const claudePath = join(fixtureDir, 'claude.jsonl');
  try {
    writeFileSync(
      claudePath,
      ['fixture-claude-a', 'fixture-claude-b', undefined]
        .map((model, index) =>
          JSON.stringify({
            message: {
              content: [{ text: `Source-attributed response ${String(index)}.`, type: 'text' }],
              model,
              role: 'assistant',
            },
            timestamp: SOURCE_EVENT_AT,
            type: 'assistant',
          }),
        )
        .join('\n'),
    );
    for (const { expected, history } of [
      {
        expected: ['fixture-claude-a', 'fixture-claude-b', null],
        history: parseClaudeTranscriptSummary(claudePath).history,
      },
      {
        expected: [null, null, null, null],
        history: parseGrokSessionExport(GROK_SESSION_EXPORT_FIXTURE).history,
      },
    ]) {
      assert.deepEqual(
        history.map(turn => turn.model ?? null),
        expected,
      );
    }
  } finally {
    rmSync(fixtureDir, { force: true, recursive: true });
  }
});

test('Codex, Claude, and Grok history gives replay-stable deltas without durable memory proposals', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'ai-memory-cross-harness-'));
  const codexPath = join(fixtureDir, 'codex.jsonl');
  const claudePath = join(fixtureDir, 'claude.jsonl');

  try {
    writeFileSync(
      codexPath,
      [
        JSON.stringify({ payload: { id: 'codex-cross-harness' }, type: 'session_meta' }),
        JSON.stringify({
          payload: { message: `Decide ${EARLY_DECISION_MARKER}.`, type: 'user_message' },
          timestamp: '2026-09-08T11:00:00.000Z',
          type: 'event_msg',
        }),
        JSON.stringify({
          payload: { message: `Decision recorded: ${EARLY_DECISION_MARKER}.`, type: 'agent_message' },
          timestamp: '2026-09-08T11:01:00.000Z',
          type: 'event_msg',
        }),
        JSON.stringify({
          payload: { message: 'Later implementation request.', type: 'user_message' },
          timestamp: '2026-09-08T11:02:00.000Z',
          type: 'event_msg',
        }),
        JSON.stringify({
          payload: { message: 'Later response.', type: 'agent_message' },
          timestamp: '2026-09-08T11:03:00.000Z',
          type: 'event_msg',
        }),
      ].join('\n'),
    );
    writeFileSync(
      claudePath,
      [
        JSON.stringify({
          message: { content: [{ text: `Decide ${EARLY_DECISION_MARKER}.`, type: 'text' }], role: 'user' },
          timestamp: '2026-09-08T11:00:00.000Z',
          type: 'user',
        }),
        JSON.stringify({
          message: {
            content: [{ text: `Decision recorded: ${EARLY_DECISION_MARKER}.`, type: 'text' }],
            role: 'assistant',
          },
          timestamp: '2026-09-08T11:01:00.000Z',
          type: 'assistant',
        }),
        JSON.stringify({
          message: { content: [{ text: 'Later implementation request.', type: 'text' }], role: 'user' },
          timestamp: '2026-09-08T11:02:00.000Z',
          type: 'user',
        }),
        JSON.stringify({
          message: { content: [{ text: 'Later response.', type: 'text' }], role: 'assistant' },
          timestamp: '2026-09-08T11:03:00.000Z',
          type: 'assistant',
        }),
      ].join('\n'),
    );

    const cases = [
      {
        agent: 'codex-cli',
        history: parseCodexSessionSummary(codexPath).history,
        sessionId: 'codex-cross-harness',
        source: 'codex-hook',
      },
      {
        agent: 'claude-code',
        history: parseClaudeTranscriptSummary(claudePath).history,
        sessionId: 'claude-cross-harness',
        source: 'claude-session-end',
      },
      {
        agent: 'grok-build',
        history: parseGrokSessionExport(GROK_SESSION_EXPORT_FIXTURE).history,
        sessionId: 'grok-cross-harness',
        source: 'grok-session-end',
      },
    ] as const;

    for (const harness of cases) {
      const sourceHistory =
        harness.source === 'grok-session-end'
          ? harness.history.map(turn => ({
              ...turn,
              content: turn.content.replace('early-decision marker', EARLY_DECISION_MARKER),
            }))
          : harness.history;
      const earlyRun = buildAutoMemoryDelta({
        agent: harness.agent,
        createdAt: SOURCE_EVENT_AT,
        evidenceRefs: [`https://github.com/example/catalog/issues/2930#${harness.sessionId}`],
        history: sourceHistory.slice(0, 2),
        repoId: PROJECT,
        sessionId: harness.sessionId,
        source: harness.source,
      });
      const resumedRun = buildAutoMemoryDelta({
        agent: harness.agent,
        createdAt: SOURCE_EVENT_AT,
        evidenceRefs: [`https://github.com/example/catalog/issues/2930#${harness.sessionId}`],
        history: sourceHistory,
        repoId: PROJECT,
        sessionId: harness.sessionId,
        source: harness.source,
      });
      const replayedRun = buildAutoMemoryDelta({
        agent: harness.agent,
        createdAt: SOURCE_EVENT_AT,
        evidenceRefs: [`https://github.com/example/catalog/issues/2930#${harness.sessionId}`],
        history: sourceHistory,
        repoId: PROJECT,
        sessionId: harness.sessionId,
        source: harness.source,
      });
      assert.notEqual(earlyRun.delta_id, resumedRun.delta_id, `${harness.source} new turns give a new delta`);
      assert.equal(resumedRun.delta_id, replayedRun.delta_id, `${harness.source} replay must be idempotent`);
      assert.equal(resumedRun.created_at, SOURCE_EVENT_AT, `${harness.source} retains source event time`);
      assert.equal('x_durable_memories' in resumedRun, false, `${harness.source} never proposes durable memories`);
      assert.ok(
        sourceHistory.some(turn => turn.content.includes(EARLY_DECISION_MARKER)),
        `${harness.source} parses earlier turns`,
      );

      if (harness.source === 'grok-session-end') {
        assert.ok(
          sourceHistory.every(turn => turn.timestamp === undefined),
          'Grok export must not invent per-turn timestamps',
        );
      } else {
        assert.ok(
          sourceHistory.every(turn => turn.timestamp !== undefined),
          `${harness.source} retains turn timestamps`,
        );
      }
    }
  } finally {
    rmSync(fixtureDir, { force: true, recursive: true });
  }
});
