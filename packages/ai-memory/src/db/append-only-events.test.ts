import assert from 'node:assert/strict';
import { test } from 'vitest';

import { insertIngestionFailureWithClient, insertSessionEventWithClient } from './failure-events.js';

interface MockClientOptions {
  existingPayload?: Record<string, unknown> | undefined;
  insertRowCount: number;
}

interface QueryCall {
  params: unknown[];
  sql: string;
}

const INGESTION_FAILURES_TABLE = 'ai_ingestion_failures';
const TEST_TIMESTAMP = '2026-02-07T00:00:00.000Z';

function createIngestionFailureMockClient(options: { sessionExists: boolean }) {
  const calls: QueryCall[] = [];

  return {
    calls,
    query(sql: string, params: unknown[] = []) {
      calls.push({ params, sql });

      if (sql.includes('SELECT 1 FROM ai_sessions')) {
        return {
          rowCount: options.sessionExists ? 1 : 0,
          rows: options.sessionExists ? [{ '?column?': 1 }] : [],
        };
      }

      if (sql.includes(`INSERT INTO ${INGESTION_FAILURES_TABLE}`)) {
        return {
          rowCount: 1,
          rows: [
            {
              agent: params[3],
              created_at: new Date(TEST_TIMESTAMP),
              details_json: parseDetails(params[6]),
              error_message: params[5],
              id: 1,
              repo_id: params[4],
              session_id: params[2],
              source: params[0],
              stage: params[1],
            },
          ],
        };
      }

      throw new Error(`Unexpected SQL in mock: ${sql}`);
    },
  };
}

function createMockClient(options: MockClientOptions) {
  const calls: QueryCall[] = [];
  const conflictFailureKeys = new Set<string>();
  let failureInsertCount = 0;

  return {
    calls,
    getFailureInsertCount() {
      return failureInsertCount;
    },
    query(sql: string, params: unknown[] = []) {
      calls.push({ params, sql });

      if (sql.includes('INSERT INTO ai_session_events')) {
        return { rowCount: options.insertRowCount, rows: [] };
      }

      if (sql.includes('SELECT payload_json FROM ai_session_events')) {
        return {
          rowCount: options.existingPayload ? 1 : 0,
          rows: options.existingPayload ? [{ payload_json: options.existingPayload }] : [],
        };
      }

      if (sql.includes('SELECT 1 FROM ai_sessions')) {
        return { rowCount: 1, rows: [{ '?column?': 1 }] };
      }

      if (sql.includes('SELECT pg_advisory_xact_lock')) {
        return { rowCount: 1, rows: [{ pg_advisory_xact_lock: null }] };
      }

      if (sql.includes('SELECT id') && sql.includes(`FROM ${INGESTION_FAILURES_TABLE}`)) {
        const key = [
          String(params[0] ?? ''),
          String(params[1] ?? ''),
          String(params[2] ?? ''),
          String(params[3] ?? ''),
          String(params[4] ?? ''),
          String(params[5] ?? ''),
        ].join('|');
        return {
          rowCount: conflictFailureKeys.has(key) ? 1 : 0,
          rows: conflictFailureKeys.has(key) ? [{ id: 1 }] : [],
        };
      }

      if (sql.includes(`INSERT INTO ${INGESTION_FAILURES_TABLE}`)) {
        const detailsRaw = params[6];
        const details = parseDetails(detailsRaw);
        const key = [
          String(params[0] ?? ''),
          String(params[1] ?? ''),
          String(params[2] ?? ''),
          String(details.eventId ?? ''),
          String(details.existingHash ?? ''),
          String(details.incomingHash ?? ''),
        ].join('|');
        conflictFailureKeys.add(key);
        failureInsertCount += 1;

        return {
          rowCount: 1,
          rows: [
            {
              agent: null,
              created_at: new Date(TEST_TIMESTAMP),
              details_json: details,
              error_message: 'conflict',
              id: 1,
              repo_id: null,
              session_id: 'session-1',
              source: 'ai-memory',
              stage: 'event_conflict_mismatch',
            },
          ],
        };
      }

      throw new Error(`Unexpected SQL in mock: ${sql}`);
    },
  };
}

const baseEvent = {
  createdAt: TEST_TIMESTAMP,
  eventId: 'evt-1',
  eventType: 'checkpoint',
  payloadJson: { summary: 'alpha', ts: TEST_TIMESTAMP, type: 'checkpoint' },
  sessionId: 'session-1',
  summary: 'alpha',
};

test('append-only insert path does not run conflict checks when insert succeeds', async () => {
  const client = createMockClient({
    existingPayload: undefined,
    insertRowCount: 1,
  });

  await insertSessionEventWithClient(client, baseEvent);

  assert.equal(client.calls.length, 1);
  assert.ok(client.calls[0] !== undefined);
  assert.match(client.calls[0].sql, /INSERT INTO ai_session_events/);
});

test('append-only idempotent conflict with identical payload logs nothing', async () => {
  const client = createMockClient({
    existingPayload: {
      summary: 'alpha',
      ts: '2026-02-07T00:01:00.000Z',
      type: 'checkpoint',
    },
    insertRowCount: 0,
  });

  await insertSessionEventWithClient(client, baseEvent);

  assert.equal(client.calls.length, 2);
  assert.ok(client.calls[1] !== undefined);
  assert.match(client.calls[1].sql, /SELECT payload_json FROM ai_session_events/);
  assert.equal(client.getFailureInsertCount(), 0);
});

test('append-only out-of-order timestamp replay is idempotent', async () => {
  const client = createMockClient({
    existingPayload: {
      summary: 'alpha',
      ts: '2026-02-07T00:05:00.000Z',
      type: 'checkpoint',
    },
    insertRowCount: 0,
  });

  await insertSessionEventWithClient(client, {
    ...baseEvent,
    payloadJson: {
      summary: 'alpha',
      ts: '2026-02-06T23:59:00.000Z',
      type: 'checkpoint',
    },
  });

  assert.equal(client.calls.length, 2);
  assert.equal(client.getFailureInsertCount(), 0);
});

test('append-only conflict with changed payload logs mismatch failure', async () => {
  const client = createMockClient({
    existingPayload: {
      summary: 'different',
      ts: TEST_TIMESTAMP,
      type: 'checkpoint',
    },
    insertRowCount: 0,
  });

  await insertSessionEventWithClient(client, baseEvent);

  assert.equal(client.calls.length, 6);
  assert.ok(client.calls[2] !== undefined);
  assert.match(client.calls[2].sql, /pg_advisory_xact_lock/);
  assert.ok(client.calls[3] !== undefined);
  assert.match(client.calls[3].sql, /FROM ai_ingestion_failures/);
  assert.ok(client.calls[4] !== undefined);
  assert.match(client.calls[4].sql, /SELECT 1 FROM ai_sessions/);
  assert.ok(client.calls[5] !== undefined);
  assert.match(client.calls[5].sql, /INSERT INTO ai_ingestion_failures/);
  assert.equal(client.getFailureInsertCount(), 1);
});

test('append-only concurrent mismatch path acquires lock and dedupes replays', async () => {
  const client = createMockClient({
    existingPayload: {
      summary: 'different',
      ts: TEST_TIMESTAMP,
      type: 'checkpoint',
    },
    insertRowCount: 0,
  });

  await insertSessionEventWithClient(client, baseEvent);
  await insertSessionEventWithClient(client, baseEvent);

  const lockCalls = client.calls.filter(call => call.sql.includes('pg_advisory_xact_lock'));
  const conflictInserts = client.calls.filter(call => call.sql.includes(`INSERT INTO ${INGESTION_FAILURES_TABLE}`));
  assert.equal(lockCalls.length, 2);
  assert.equal(conflictInserts.length, 1);
  assert.equal(client.getFailureInsertCount(), 1);
});

test('ingestion failure audit unlinks missing session ids before insert', async () => {
  const client = createIngestionFailureMockClient({ sessionExists: false });

  const record = await insertIngestionFailureWithClient(client, {
    details: { reason: 'rolled_back_delta' },
    errorMessage: 'delta failed',
    sessionId: 'missing-session',
    source: 'auto-session-ingest',
    stage: 'ingest_memory_delta',
  });

  const insertCall = client.calls.find(call => call.sql.includes(`INSERT INTO ${INGESTION_FAILURES_TABLE}`));
  assert.ok(insertCall !== undefined);
  assert.equal(insertCall.params[2], null);
  assert.deepEqual(parseDetails(insertCall.params[6]), {
    reason: 'rolled_back_delta',
    session_link_status: 'missing_session',
    unlinked_session_id: 'missing-session',
  });
  assert.equal(record.sessionId, null);
});

test('ingestion failure audit preserves existing session links', async () => {
  const client = createIngestionFailureMockClient({ sessionExists: true });

  const record = await insertIngestionFailureWithClient(client, {
    details: { reason: 'session_scoped_failure' },
    errorMessage: 'session-scoped failure',
    sessionId: 'session-1',
    source: 'auto-session-ingest',
    stage: 'ingest_memory_delta',
  });

  const insertCall = client.calls.find(call => call.sql.includes(`INSERT INTO ${INGESTION_FAILURES_TABLE}`));
  assert.ok(insertCall !== undefined);
  assert.equal(insertCall.params[2], 'session-1');
  assert.deepEqual(parseDetails(insertCall.params[6]), { reason: 'session_scoped_failure' });
  assert.equal(record.sessionId, 'session-1');
});

function parseDetails(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') {
    return {};
  }

  const parsed: unknown = JSON.parse(value);
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...parsed } : {};
}
