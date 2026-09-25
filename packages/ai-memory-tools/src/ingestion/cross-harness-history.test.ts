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
  const parseDelta = () => {
    const parsed = parseCodexSessionSummary(codexPath);
    return buildAutoMemoryDelta({
      agent: 'codex-cli',
      autoDurablePromotionEnabled: true,
      createdAt: parsed.createdAt,
      history: parsed.history,
      model: parsed.model,
      repoId: PROJECT,
      sessionId: parsed.sessionId,
      source: 'codex-session-end',
    });
  };
  const sourceModels = (delta: ReturnType<typeof buildAutoMemoryDelta>) =>
    (delta.x_durable_memories ?? [])
      .filter(memory => memory.tags.includes('session-history'))
      .map(memory => ({
        key: memory.memory_key,
        model: memory.source_model,
      }));

  try {
    writeFileSync(codexPath, earlierEntries.map(entry => JSON.stringify(entry)).join('\n'));
    const earlier = sourceModels(parseDelta());
    assert.deepEqual(
      earlier.map(turn => turn.model),
      [null, 'fixture-model-a'],
    );

    writeFileSync(codexPath, [...earlierEntries, ...laterEntries].map(entry => JSON.stringify(entry)).join('\n'));
    const resumed = sourceModels(parseDelta());
    assert.deepEqual(
      resumed.map(turn => turn.model),
      [null, 'fixture-model-a', 'fixture-model-b', null],
    );
    assert.deepEqual(
      resumed.slice(0, earlier.length),
      earlier,
      'later model changes cannot rewrite earlier attribution',
    );
    assert.deepEqual(sourceModels(parseDelta()), resumed, 'replay retains the same turn attribution');
  } finally {
    rmSync(fixtureDir, { force: true, recursive: true });
  }
});

test('Claude message models and unknown Grok export models survive durable history construction', () => {
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
    for (const { expected, history, source } of [
      {
        expected: ['fixture-claude-a', 'fixture-claude-b', null],
        history: parseClaudeTranscriptSummary(claudePath).history,
        source: 'claude-session-end',
      },
      {
        expected: [null, null, null, null],
        history: parseGrokSessionExport(GROK_SESSION_EXPORT_FIXTURE).history,
        source: 'grok-session-end',
      },
    ]) {
      const delta = buildAutoMemoryDelta({
        agent: source,
        autoDurablePromotionEnabled: true,
        createdAt: SOURCE_EVENT_AT,
        history,
        model: 'enclosing-producer-is-not-the-source-turn',
        repoId: PROJECT,
        sessionId: source,
        source,
      });
      const durable = (delta.x_durable_memories ?? []).filter(memory => memory.tags.includes('session-history'));
      assert.deepEqual(
        durable.map(memory => memory.source_model),
        expected,
      );
    }
  } finally {
    rmSync(fixtureDir, { force: true, recursive: true });
  }
});

test('Codex, Claude, and Grok retain bounded earlier decisions with stable source-linked turn identity', () => {
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
        autoDurablePromotionEnabled: true,
        createdAt: SOURCE_EVENT_AT,
        evidenceRefs: [`https://github.com/example/catalog/issues/2930#${harness.sessionId}`],
        history: sourceHistory.slice(0, 2),
        repoId: PROJECT,
        sessionId: harness.sessionId,
        source: harness.source,
      });
      const resumedRun = buildAutoMemoryDelta({
        agent: harness.agent,
        autoDurablePromotionEnabled: true,
        createdAt: SOURCE_EVENT_AT,
        evidenceRefs: [`https://github.com/example/catalog/issues/2930#${harness.sessionId}`],
        history: sourceHistory,
        repoId: PROJECT,
        sessionId: harness.sessionId,
        source: harness.source,
      });
      const replayedRun = buildAutoMemoryDelta({
        agent: harness.agent,
        autoDurablePromotionEnabled: true,
        createdAt: SOURCE_EVENT_AT,
        evidenceRefs: [`https://github.com/example/catalog/issues/2930#${harness.sessionId}`],
        history: sourceHistory,
        repoId: PROJECT,
        sessionId: harness.sessionId,
        source: harness.source,
      });
      const earlyKeys = new Set(earlyRun.x_durable_memories?.map(memory => memory.memory_key) ?? []);
      const durable = resumedRun.x_durable_memories ?? [];
      const durableKeys = durable.map(memory => memory.memory_key);

      assert.ok(
        durable.some(memory => memory.content.includes(EARLY_DECISION_MARKER)),
        `${harness.source} must preserve an earlier decision after later turns arrive`,
      );
      assert.equal(new Set(durableKeys).size, durableKeys.length, `${harness.source} turn keys must be unique`);
      for (const key of earlyKeys) {
        assert.ok(durableKeys.includes(key), `${harness.source} must preserve turn key ${key}`);
      }
      assert.equal(resumedRun.delta_id, replayedRun.delta_id, `${harness.source} replay must be idempotent`);
      assert.equal(resumedRun.created_at, SOURCE_EVENT_AT, `${harness.source} retains source event time`);
      assert.ok(
        durable.some(memory => memory.tags.includes(harness.source)),
        `${harness.source} must retain harness provenance in a searchable tag`,
      );
      assert.ok(
        durable.every(memory => memory.source === harness.source),
        `${harness.source} must retain harness provenance at the persistence boundary`,
      );
      assert.ok(
        durable.some(memory => memory.evidence_refs.some(ref => ref.type === 'provided')),
        `${harness.source} must retain an evidence reference`,
      );

      if (harness.source === 'grok-session-end') {
        assert.ok(
          sourceHistory.every(turn => turn.timestamp === undefined),
          'Grok export must not invent per-turn timestamps',
        );
        assert.ok(
          durable.every(memory => memory.source_timestamp === undefined),
          'Grok durable history must not invent timestamps',
        );
      } else {
        assert.ok(
          sourceHistory.every(turn => turn.timestamp !== undefined),
          `${harness.source} retains turn timestamps`,
        );
        assert.ok(
          durable
            .filter(memory => memory.tags.includes('session-history'))
            .every(memory => memory.source_timestamp !== undefined),
          `${harness.source} must persist source turn timestamps with bounded history`,
        );
      }
    }
  } finally {
    rmSync(fixtureDir, { force: true, recursive: true });
  }
});
