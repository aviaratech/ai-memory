import assert from 'node:assert/strict';
import { beforeEach, test } from 'vitest';

import { type IngestMemoryDeltaClient, ingestMemoryDeltaInTransaction } from './ingest-memory-delta-in-transaction.js';

const statements: string[] = [];
// Records every statement; no database is involved.
const client: IngestMemoryDeltaClient = {
  query: (sql: string) => {
    statements.push(sql);
    return Promise.resolve({ rows: [] });
  },
};
const CREATED_AT = '2026-08-20T12:00:00.000Z';

function delta(extensions: Record<string, unknown> = {}) {
  return {
    append_events: [{ summary: 'Synthetic checkpoint.', ts: CREATED_AT, type: 'checkpoint' }],
    artifacts: [],
    created_at: CREATED_AT,
    delta_id: 'fixture-delta',
    produced_by: { agent: 'codex-cli', model: 'fixture-producer' },
    schema_version: 'memory_delta@0.1',
    session_id: 'fixture-session',
    snapshot: {
      mode: 'replace',
      value: {
        anchors: { focus_paths: [], related_links: [] },
        context_needed: [],
        created_at: CREATED_AT,
        goal: 'Synthetic delta ingestion fixture.',
        next_actions: [],
        open_questions: [],
        plan: [],
        progress: { blockers: [], completed: [], in_flight: [] },
        snapshot_id: 'fixture-snapshot',
      },
    },
    tenancy: { repo_id: 'example/catalog' },
    ...extensions,
  };
}

beforeEach(() => {
  statements.length = 0;
});

test('delta ingestion records session state and never writes memories', async () => {
  const result = await ingestMemoryDeltaInTransaction(client, delta());

  assert.deepEqual(result, {
    deltaId: 'fixture-delta',
    eventsIngested: 1,
    schemaVersion: 'memory_delta@0.1',
    sessionId: 'fixture-session',
    status: 'ok',
  });
  assert.ok(statements.some(sql => sql.includes('ai_memory_deltas')));
  assert.ok(statements.some(sql => sql.includes('ai_session_events')));
  assert.ok(!statements.some(sql => /INSERT INTO ai_memory_entries/u.test(sql)));
});

test('delta ingestion rejects durable memory proposals before any write', async () => {
  await assert.rejects(
    ingestMemoryDeltaInTransaction(
      client,
      delta({ x_durable_memories: [{ category: 'decision', confidence: 0.9, content: 'A promoted fragment.' }] }),
    ),
    /x_durable_memories is no longer accepted/u,
  );
  assert.deepEqual(statements, []);
});
