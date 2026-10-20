import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DbPool, DbResult } from './pool.js';
import { insertWorkflowEvent, readWorkflowAggregates } from './workflow-events.js';
import { parseTelemetryEvent } from '../telemetry/event.js';

function fixture() {
  const parsed = parseTelemetryEvent({
    schemaVersion: 1,
    kind: 'edge',
    source: 'producer',
    producer: 'fixture',
    eventId: 'event-1',
    projectId: `sha256:${'a'.repeat(64)}`,
    taskId: 'task-1',
    stage: 'verify',
    edge: 'failure',
    evidenceIds: ['proof-1'],
  });
  assert.ok(parsed.ok);
  return parsed.event;
}

function fakePool(stored: boolean, prior: { producer: string; event_id: string; payload_fingerprint: string }[]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  let released = 0;
  const client = {
    release() {
      released++;
    },
    async query<T>(sql: string, params: unknown[] = []): Promise<DbResult<T>> {
      calls.push({ sql, params });
      const rows = sql.startsWith('INSERT') ? (stored ? [{ id: '1' }] : []) : sql.startsWith('SELECT') ? prior : [];
      return { rowCount: rows.length, rows: rows as T[] };
    },
  };
  const pool: DbPool = {
    connect: async () => client,
    getClient: async () => client,
    end: async () => {
      throw new Error('caller-owned pool closed');
    },
    query: (sql, params) => client.query(sql, params),
  };
  return { pool, calls, released: () => released };
}

test('atomic insert binds only normalized typed values and releases its transaction', async () => {
  const db = fakePool(true, []);
  assert.equal(await insertWorkflowEvent(fixture(), db.pool), 'stored');
  const insert = db.calls.find(c => c.sql.startsWith('INSERT'));
  assert.ok(insert);
  assert.match(insert.sql, /ON CONFLICT DO NOTHING/u);
  assert.equal(insert.sql.includes('event-1'), false);
  assert.ok(insert.params.includes('event-1'));
  assert.equal(insert.params.includes('task-1'), true);
  assert.equal(db.calls.at(-1)?.sql, 'COMMIT');
  assert.equal(db.released(), 1);
});

test('same event identity and fingerprint replay is duplicate; changed or foreign response ownership conflicts', async () => {
  const event = fixture();
  const stored = fakePool(true, []);
  await insertWorkflowEvent(event, stored.pool);
  const digest = stored.calls.find(c => c.sql.startsWith('INSERT'))?.params.at(-1);
  assert.equal(typeof digest, 'string');
  assert.ok(typeof digest === 'string');
  const duplicate = fakePool(false, [{ producer: 'fixture', event_id: 'event-1', payload_fingerprint: digest }]);
  assert.equal(await insertWorkflowEvent(event, duplicate.pool), 'duplicate');
  const changed = fakePool(false, [{ producer: 'fixture', event_id: 'event-1', payload_fingerprint: '0'.repeat(64) }]);
  assert.equal(await insertWorkflowEvent(event, changed.pool), 'conflict');
  const other = fakePool(false, [{ producer: 'other', event_id: 'other-event', payload_fingerprint: digest }]);
  assert.equal(await insertWorkflowEvent(event, other.pool), 'conflict');
  assert.equal(
    changed.calls.some(c => /UPDATE|DELETE/u.test(c.sql)),
    false,
  );
});

test('fingerprint ignores caller property order after strict normalization', async () => {
  const original = fixture();
  const reverse = Object.fromEntries(Object.entries(original).reverse());
  // Public ingestion normalizes the wire form; this internal store must also
  // encode fixed event keys so typed callers cannot alter replay by insertion order.
  const first = fakePool(true, []);
  const second = fakePool(true, []);
  await insertWorkflowEvent(original, first.pool);
  await insertWorkflowEvent(reverse as typeof original, second.pool);
  assert.deepEqual(
    first.calls.find(c => c.sql.startsWith('INSERT'))?.params,
    second.calls.find(c => c.sql.startsWith('INSERT'))?.params,
  );
});

const reportQuery = {
  projectId: `sha256:${'a'.repeat(64)}`,
  taskId: 'task-1',
  windowStartIso: '2026-01-01T00:00:00.000Z',
  windowEndIso: '2026-01-08T00:00:00.000Z',
  limit: 20,
  timeoutMs: 5000,
};
for (const extra of [
  { projectId: 'private/project' },
  { taskId: '../private' },
  { limit: 101 },
  { limit: 0 },
  { timeoutMs: 5001 },
  { windowStartIso: '2025-01-01T00:00:00.000Z' },
  { windowEndIso: '2026-01-01T00:00:00.000Z' },
  { windowStartIso: '2026-02-30T00:00:00.000Z' },
])
  test(`rejects invalid workflow scope before database access ${JSON.stringify(extra)}`, async () => {
    const db = fakePool(true, []);
    await assert.rejects(readWorkflowAggregates({ ...reportQuery, ...extra }, db.pool), /invalid_workflow_scope/u);
    assert.equal(db.calls.length, 0);
  });
