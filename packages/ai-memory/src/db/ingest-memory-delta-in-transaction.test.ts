import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';

import type { IngestMemoryDeltaClient } from './ingest-memory-delta-in-transaction.js';
import { isRecord } from './type-guards.js';

const storedInputs: Record<string, unknown>[] = [];

// Exercise real delta validation, normalization, and persistence-input assembly.
// Only the database writer is replaced; no real memory or retention write runs.
vi.doMock('./memory-store.js', () => ({
  storeMemoryWithClient: (_client: unknown, input: unknown) => {
    assert.ok(isRecord(input));
    storedInputs.push(input);
    return Promise.resolve({ id: storedInputs.length, writeDisposition: 'keyed_upsert' });
  },
}));

const { ingestMemoryDeltaInTransaction } = await import('./ingest-memory-delta-in-transaction.js');
const client: IngestMemoryDeltaClient = { query: () => Promise.resolve({ rows: [] }) };
const SESSION_STARTED_AT = '2026-08-20T12:00:00.000Z';
const TURN_AT = '2026-09-08T12:00:00.000Z';

function historyDelta(proposals: Record<string, unknown>[], producerModel = 'fixture-producer-b') {
  return {
    append_events: [],
    artifacts: [],
    created_at: SESSION_STARTED_AT,
    delta_id: `fixture-history-${producerModel}`,
    produced_by: { agent: 'codex-cli', model: producerModel },
    schema_version: 'memory_delta@0.1',
    session_id: 'fixture-long-lived-session',
    snapshot: {
      mode: 'replace',
      value: {
        anchors: { focus_paths: [], related_links: [] },
        context_needed: [],
        created_at: SESSION_STARTED_AT,
        goal: 'Source-attributed history regression fixture.',
        next_actions: [],
        open_questions: [],
        plan: [],
        progress: { blockers: [], completed: [], in_flight: [] },
        snapshot_id: `fixture-snapshot-${producerModel}`,
      },
    },
    tenancy: { repo_id: 'example/catalog' },
    x_durable_memories: proposals.map((proposal, index) => ({
      category: 'session-summary',
      confidence: 0.3,
      content: `Source-attributed history regression ${String(index)}.`,
      memory_key: `fixture-long-lived-session:turn:${String(index)}`,
      project: 'example/catalog',
      source: 'codex-session-end',
      tags: ['session-history'],
      ttl_days: 14,
      ...proposal,
    })),
  };
}

beforeEach(() => {
  storedInputs.length = 0;
});

test('all harness delta producers normalize their verified repository basename before deriving identity', async () => {
  for (const source of ['codex-session-end', 'claude-session-end', 'grok-session-end']) {
    await ingestMemoryDeltaInTransaction(client, historyDelta([{ project: 'catalog', source }]));
    const stored = storedInputs.at(-1);
    assert.ok(stored);
    assert.equal(stored.project, 'example/catalog');
    assert.equal(stored.source, source);
    assert.equal(stored.sessionId, 'fixture-long-lived-session');
  }
});

test('durable history expiry uses turn time while timestamp-free proposals retain delta-time TTL', async () => {
  await ingestMemoryDeltaInTransaction(client, historyDelta([{ source_timestamp: TURN_AT }, {}]));

  assert.equal(storedInputs[0]?.expiresAt, '2026-09-22T12:00:00.000Z');
  assert.equal(storedInputs[1]?.expiresAt, '2026-09-03T12:00:00.000Z');
  const metadata = storedInputs[0].metadata;
  assert.ok(isRecord(metadata));
  assert.equal(metadata.source_turn_timestamp, TURN_AT);
});

test('durable replay preserves source-turn model separately from producer and explicit unknown attribution', async () => {
  const proposals = [{ source_model: 'fixture-source-a' }, { source_model: null }, {}];
  await ingestMemoryDeltaInTransaction(client, historyDelta(proposals));
  await ingestMemoryDeltaInTransaction(client, historyDelta(proposals, 'fixture-producer-c'));

  for (const offset of [0, 3]) {
    const known = storedInputs[offset]?.metadata;
    const unknown = storedInputs[offset + 1]?.metadata;
    const legacy = storedInputs[offset + 2]?.metadata;
    assert.ok(isRecord(known));
    assert.ok(isRecord(unknown));
    assert.ok(isRecord(legacy));
    assert.equal(known.source_turn_model, 'fixture-source-a');
    assert.equal(unknown.source_turn_model, null);
    assert.equal(
      Object.hasOwn(legacy, 'source_turn_model'),
      false,
      'legacy proposals do not fabricate source attribution',
    );
  }
  assert.equal(storedInputs[0]?.memoryKey, storedInputs[3]?.memoryKey, 'replay uses the original source turn key');
  assert.equal(storedInputs[0]?.model, 'fixture-producer-b');
  assert.equal(storedInputs[3]?.model, 'fixture-producer-c');
});
