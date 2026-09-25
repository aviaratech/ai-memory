import assert from 'node:assert/strict';
import { test } from 'vitest';

import { runRetentionPurgeWithClient } from './retentionRunner.js';

interface MockClientOptions {
  candidateCounts?: Record<string, number>;
  deleteRowCounts?: Record<string, number>;
  errorOnTable?: string;
}

interface QueryCall {
  params: unknown[];
  sql: string;
}

function createMockClient(options: MockClientOptions = {}) {
  const calls: QueryCall[] = [];
  const candidateCounts = options.candidateCounts ?? {};
  const deleteRowCounts = options.deleteRowCounts ?? {};
  const errorOnTable = options.errorOnTable;

  return {
    calls,
    query(sql: string, params: unknown[] = []) {
      calls.push({ params, sql });

      if (errorOnTable !== undefined) {
        for (const table of Object.keys(candidateCounts)) {
          if (sql.includes(table) && errorOnTable === table) {
            throw new Error(`Simulated failure on ${table}`);
          }
        }
      }

      if (sql.includes('SELECT COUNT')) {
        for (const [table, count] of Object.entries(candidateCounts)) {
          if (sql.includes(table)) {
            return { rowCount: 1, rows: [{ cnt: count }] };
          }
        }

        return { rowCount: 1, rows: [{ cnt: 0 }] };
      }

      if (sql.includes('MIN(') || sql.includes('MIN(started_at')) {
        return {
          rowCount: 1,
          rows: [{ newest: '2026-01-15T00:00:00Z', oldest: '2025-10-01T00:00:00Z' }],
        };
      }

      if (sql.startsWith('DELETE FROM')) {
        for (const [table] of Object.entries(deleteRowCounts)) {
          if (sql.includes(table)) {
            const remaining = deleteRowCounts[table] ?? 0;
            if (remaining <= 0) {
              return { rowCount: 0, rows: [] };
            }

            const batchMatch = /LIMIT (\d+)/.exec(sql);
            const batchSize = batchMatch !== null ? Number(batchMatch[1]) : 1000;
            const deleted = Math.min(remaining, batchSize);
            deleteRowCounts[table] = remaining - deleted;
            return { rowCount: deleted, rows: [] };
          }
        }

        return { rowCount: 0, rows: [] };
      }

      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
}

test('dry-run returns candidate counts with zero deleted', async () => {
  const client = createMockClient({
    candidateCounts: {
      ai_context_packs: 5,
      ai_ingestion_failures: 10,
      ai_memory_deltas: 3,
      ai_memory_entries: 7,
      ai_memory_events: 2,
      ai_sessions: 4,
    },
  });

  const result = await runRetentionPurgeWithClient(client, { dryRun: true });

  assert.equal(result.dryRun, true);
  assert.equal(result.status, 'ok');
  assert.equal(result.totalDeleted, 0);
  assert.ok(result.totalCandidates > 0);
  assert.equal(result.errors.length, 0);

  for (const table of result.tables) {
    assert.equal(table.deleted, 0);
  }

  const deleteCalls = client.calls.filter(call => call.sql.startsWith('DELETE'));
  assert.equal(deleteCalls.length, 0);
});

test('apply mode batches deletes and sums rowCounts', async () => {
  const client = createMockClient({
    candidateCounts: {
      ai_ingestion_failures: 15,
    },
    deleteRowCounts: {
      ai_ingestion_failures: 15,
    },
  });

  const result = await runRetentionPurgeWithClient(client, {
    batchSize: 10,
    config: { failureDays: 30 },
    dryRun: false,
  });

  assert.equal(result.dryRun, false);
  assert.equal(result.status, 'ok');

  const failureTable = result.tables.find(t => t.table === 'ai_ingestion_failures');
  assert.ok(failureTable);
  assert.equal(failureTable.candidates, 15);
  assert.equal(failureTable.deleted, 15);

  const deleteCalls = client.calls.filter(
    call => call.sql.startsWith('DELETE') && call.sql.includes('ai_ingestion_failures'),
  );
  assert.equal(deleteCalls.length, 2);
});

test('partial failure: one table throws, other tables processed', async () => {
  const client = createMockClient({
    candidateCounts: {
      ai_ingestion_failures: 5,
    },
    errorOnTable: 'ai_ingestion_failures',
  });

  const result = await runRetentionPurgeWithClient(client, { dryRun: true });

  assert.equal(result.status, 'partial');
  assert.equal(result.errors.length, 1);
  const firstError = result.errors[0];
  assert.ok(firstError !== undefined);
  assert.ok(firstError.error.includes('ai_ingestion_failures'));
  assert.ok(result.tables.length > 0);
});

test('idempotent rerun: zero candidates produces all-empty results', async () => {
  const client = createMockClient({});

  const result = await runRetentionPurgeWithClient(client, { dryRun: false });

  assert.equal(result.status, 'ok');
  assert.equal(result.totalCandidates, 0);
  assert.equal(result.totalDeleted, 0);
  assert.equal(result.errors.length, 0);

  for (const table of result.tables) {
    assert.equal(table.candidates, 0);
    assert.equal(table.deleted, 0);
  }
});

test('dataset filter scopes to single table', async () => {
  const client = createMockClient({
    candidateCounts: {
      ai_ingestion_failures: 10,
      ai_sessions: 5,
    },
  });

  const result = await runRetentionPurgeWithClient(client, {
    dataset: 'ai_ingestion_failures',
    dryRun: true,
  });

  assert.equal(result.tables.length, 1);
  const firstTable = result.tables[0];
  assert.ok(firstTable !== undefined);
  assert.equal(firstTable.table, 'ai_ingestion_failures');
  assert.equal(firstTable.candidates, 10);
});

test('config overrides appear in result', async () => {
  const client = createMockClient({});

  const result = await runRetentionPurgeWithClient(client, {
    config: {
      auditDays: 365,
      failureDays: 14,
      sessionDays: 60,
    },
    dryRun: true,
  });

  assert.equal(result.config.failureDays, 14);
  assert.equal(result.config.sessionDays, 60);
  assert.equal(result.config.auditDays, 365);
});

test('batch size respected in DELETE LIMIT', async () => {
  const client = createMockClient({
    candidateCounts: {
      ai_ingestion_failures: 50,
    },
    deleteRowCounts: {
      ai_ingestion_failures: 50,
    },
  });

  const result = await runRetentionPurgeWithClient(client, {
    batchSize: 25,
    dryRun: false,
  });

  const failureTable = result.tables.find(t => t.table === 'ai_ingestion_failures');
  assert.ok(failureTable);
  assert.equal(failureTable.deleted, 50);

  const deleteCalls = client.calls.filter(
    call => call.sql.startsWith('DELETE') && call.sql.includes('ai_ingestion_failures'),
  );
  // 25 + 25 = 50 deleted, then a third batch returns 0 (< batchSize) ending the loop
  assert.equal(deleteCalls.length, 3);

  for (const call of deleteCalls) {
    assert.ok(call.sql.includes('LIMIT 25'));
  }
});

test('orphaned audit events query references memory_id column', async () => {
  const client = createMockClient({
    candidateCounts: {
      ai_memory_events: 3,
    },
  });

  const result = await runRetentionPurgeWithClient(client, {
    dataset: 'ai_memory_events',
    dryRun: true,
  });

  assert.equal(result.tables.length, 1);
  const eventsTable = result.tables[0];
  assert.ok(eventsTable !== undefined);
  assert.equal(eventsTable.candidates, 3);

  const countCalls = client.calls.filter(call => call.sql.includes('ai_memory_events'));
  assert.ok(countCalls.length > 0);
  const countSql = countCalls[0];
  assert.ok(countSql !== undefined);
  assert.ok(countSql.sql.includes('ai_memory_events.memory_id'));
  assert.ok(!countSql.sql.includes('session_id'));
});

const BATCH_SIZE_ERROR = 'batchSize must be a positive integer';

test('batchSize of zero throws validation error', async () => {
  const client = createMockClient({});

  await assert.rejects(
    () => runRetentionPurgeWithClient(client, { batchSize: 0, dryRun: true }),
    (error: Error) => {
      assert.ok(error.message.includes(BATCH_SIZE_ERROR));
      return true;
    },
  );
});

test('negative batchSize throws validation error', async () => {
  const client = createMockClient({});

  await assert.rejects(
    () => runRetentionPurgeWithClient(client, { batchSize: -5, dryRun: true }),
    (error: Error) => {
      assert.ok(error.message.includes(BATCH_SIZE_ERROR));
      return true;
    },
  );
});

test('non-integer batchSize throws validation error', async () => {
  const client = createMockClient({});

  await assert.rejects(
    () => runRetentionPurgeWithClient(client, { batchSize: 2.5, dryRun: true }),
    (error: Error) => {
      assert.ok(error.message.includes(BATCH_SIZE_ERROR));
      return true;
    },
  );
});

test('invalid dataset filter throws validation error', async () => {
  const client = createMockClient({});

  await assert.rejects(
    () =>
      runRetentionPurgeWithClient(client, {
        dataset: 'nonexistent_table',
        dryRun: true,
      }),
    (error: Error) => {
      assert.ok(error.message.includes("Unknown dataset 'nonexistent_table'"));
      assert.ok(error.message.includes('Allowed values:'));
      return true;
    },
  );
});

test('context_packs delete uses pack_id column', async () => {
  const client = createMockClient({
    candidateCounts: {
      ai_context_packs: 5,
    },
    deleteRowCounts: {
      ai_context_packs: 5,
    },
  });

  await runRetentionPurgeWithClient(client, {
    dataset: 'ai_context_packs',
    dryRun: false,
  });

  const deleteCalls = client.calls.filter(
    call => call.sql.startsWith('DELETE') && call.sql.includes('ai_context_packs'),
  );
  assert.ok(deleteCalls.length > 0);
  const firstDelete = deleteCalls[0];
  assert.ok(firstDelete !== undefined);
  assert.ok(firstDelete.sql.includes('pack_id'), `Expected pack_id in DELETE sql, got: ${firstDelete.sql}`);
});

test('memory_deltas delete uses delta_id column', async () => {
  const client = createMockClient({
    candidateCounts: {
      ai_memory_deltas: 5,
    },
    deleteRowCounts: {
      ai_memory_deltas: 5,
    },
  });

  await runRetentionPurgeWithClient(client, {
    dataset: 'ai_memory_deltas',
    dryRun: false,
  });

  const deleteCalls = client.calls.filter(
    call => call.sql.startsWith('DELETE') && call.sql.includes('ai_memory_deltas'),
  );
  assert.ok(deleteCalls.length > 0);
  const firstDelete = deleteCalls[0];
  assert.ok(firstDelete !== undefined);
  assert.ok(firstDelete.sql.includes('delta_id'), `Expected delta_id in DELETE sql, got: ${firstDelete.sql}`);
});

test('sessions delete uses session_id column and started_at ordering', async () => {
  const client = createMockClient({
    candidateCounts: {
      ai_sessions: 5,
    },
    deleteRowCounts: {
      ai_sessions: 5,
    },
  });

  await runRetentionPurgeWithClient(client, {
    dataset: 'ai_sessions',
    dryRun: false,
  });

  const deleteCalls = client.calls.filter(call => call.sql.startsWith('DELETE') && call.sql.includes('ai_sessions'));
  assert.ok(deleteCalls.length > 0);
  const firstDelete = deleteCalls[0];
  assert.ok(firstDelete !== undefined);
  assert.ok(firstDelete.sql.includes('session_id'), `Expected session_id in DELETE sql, got: ${firstDelete.sql}`);
  assert.ok(
    firstDelete.sql.includes('ORDER BY started_at, session_id'),
    `Expected ORDER BY started_at, session_id in DELETE sql, got: ${firstDelete.sql}`,
  );
});

test('sessions bounds query uses started_at column', async () => {
  const client = createMockClient({
    candidateCounts: {
      ai_sessions: 5,
    },
  });

  await runRetentionPurgeWithClient(client, {
    dataset: 'ai_sessions',
    dryRun: true,
  });

  const boundsCalls = client.calls.filter(
    call => call.sql.includes('MIN(started_at)') && call.sql.includes('ai_sessions'),
  );
  assert.ok(boundsCalls.length > 0, 'Expected bounds query to use MIN(started_at) for sessions');
});
