import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'vitest';
import { createPool, assertLocalDatabaseUrl } from './pool.js';
import { runAiMemoryMigrations } from './run-migrations.js';
import { insertWorkflowEvent } from './workflow-events.js';
import { parseTelemetryEvent } from '../telemetry/event.js';
import { RETENTION_QUERY_DEFS } from './retention-queries.js';
import { resolveRetentionConfig } from '../retention/retentionConfig.js';

const url = process.env.AI_MEMORY_DATABASE_URL;

test(
  'shipped workflow migration arbitrates concurrent replay, response ownership and reconnect recovery',
  { skip: url === undefined, timeout: 0 },
  async () => {
    assert.ok(url);
    assertLocalDatabaseUrl(url);
    assert.equal(new URL(url).pathname, '/ai_memory_test');
    let db = createPool({ connectionString: url, max: 10, connectionTimeoutMillis: 1000 });
    const producer = `fixture-${randomUUID()}`;
    const parse = (extra: Record<string, unknown>) => {
      const result = parseTelemetryEvent({
        schemaVersion: 1,
        kind: 'usage',
        producer,
        source: 'openai-responses',
        eventId: 'response-observation',
        responseId: `response-${randomUUID()}`,
        projectId: `sha256:${'b'.repeat(64)}`,
        taskId: 'task-1',
        ...extra,
      });
      assert.ok(result.ok);
      return result.event;
    };
    try {
      await runAiMemoryMigrations(db);
      const ledger = await db.query<{ name: string }>('SELECT name FROM ai_memory_pgmigrations WHERE name=$1', [
        '009_workflow_telemetry',
      ]);
      assert.equal(ledger.rowCount, 1);
      const event = parse({
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 80, cache_write_tokens: 10 },
          output_tokens: 20,
        },
      });
      const results = await Promise.all(Array.from({ length: 8 }, () => insertWorkflowEvent(event, db)));
      assert.equal(results.filter(r => r === 'stored').length, 1);
      assert.equal(results.filter(r => r === 'duplicate').length, 7);
      assert.equal(await insertWorkflowEvent({ ...event, model: 'changed-model' }, db), 'conflict');
      assert.equal(
        await insertWorkflowEvent({ ...event, producer: `${producer}-other`, eventId: 'second-claim' }, db),
        'conflict',
      );
      assert.equal((await db.query('SELECT id FROM ai_workflow_events WHERE producer=$1', [producer])).rowCount, 1);
      await db.end();
      db = createPool({ connectionString: url, max: 2, connectionTimeoutMillis: 1000 });
      assert.equal(await insertWorkflowEvent(event, db), 'duplicate');
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM ai_workflow_events WHERE producer=$1', [producer]);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      assert.equal(await insertWorkflowEvent(event, db), 'duplicate');
      const index = await db.query<{ indexdef: string }>('SELECT indexdef FROM pg_indexes WHERE tablename=$1', [
        'ai_workflow_events',
      ]);
      assert.ok(index.rows.some(r => r.indexdef.includes('ingested_at, id')));
      await assert.rejects(
        db.query('UPDATE ai_workflow_events SET evidence_ids=$2 WHERE producer=$1', [producer, ['not/a/machine/id']]),
      );
      await assert.rejects(db.query('UPDATE ai_workflow_events SET input_tokens=-1 WHERE producer=$1', [producer]));
      assert.equal(
        (await db.query('SELECT session_id FROM ai_sessions WHERE session_id=$1', [event.sessionId])).rowCount,
        0,
      );
    } finally {
      try {
        await db.query('DELETE FROM ai_workflow_events WHERE producer=$1 OR producer=$2', [
          producer,
          `${producer}-other`,
        ]);
      } finally {
        await db.end();
      }
    }
  },
);

test(
  'workflow retention uses ingestion time, preserves the exact cutoff and is idempotent',
  { skip: url === undefined, timeout: 0 },
  async () => {
    assert.ok(url);
    assertLocalDatabaseUrl(url);
    assert.equal(new URL(url).pathname, '/ai_memory_test');
    const db = createPool({ connectionString: url, max: 2 });
    const producer = `fixture-${randomUUID()}`;
    try {
      await runAiMemoryMigrations(db);
      for (const eventId of ['old', 'cutoff', 'fresh', 'foreign']) {
        const parsed = parseTelemetryEvent({
          schemaVersion: 1,
          kind: 'edge',
          source: 'producer',
          producer,
          eventId,
          projectId: `sha256:${(eventId === 'foreign' ? 'c' : 'b').repeat(64)}`,
          taskId: 'task-1',
          stage: 'verify',
          edge: 'stage',
          evidenceIds: ['synthetic-proof'],
        });
        assert.ok(parsed.ok);
        await insertWorkflowEvent(parsed.event, db);
      }
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          "UPDATE ai_workflow_events SET ingested_at = NOW() - INTERVAL '90 days' - CASE WHEN event_id='old' THEN INTERVAL '1 millisecond' ELSE INTERVAL '0' END, observed_at = NOW()+INTERVAL '5 years' WHERE producer=$1 AND event_id IN ('old','cutoff')",
          [producer],
        );
        const condition = RETENTION_QUERY_DEFS.ai_workflow_events.buildCondition(resolveRetentionConfig());
        const candidates = await client.query<{ event_id: string }>(
          `SELECT event_id FROM ai_workflow_events WHERE producer=$1 AND ${condition}`,
          [producer],
        );
        assert.deepEqual(
          candidates.rows.map(r => r.event_id),
          ['old'],
        );
        const removed = await client.query(`DELETE FROM ai_workflow_events WHERE producer=$1 AND ${condition}`, [
          producer,
        ]);
        assert.equal(removed.rowCount, 1);
        assert.equal(
          (await client.query(`DELETE FROM ai_workflow_events WHERE producer=$1 AND ${condition}`, [producer]))
            .rowCount,
          0,
        );
        const kept = await client.query<{ event_id: string }>(
          'SELECT event_id FROM ai_workflow_events WHERE producer=$1 ORDER BY event_id',
          [producer],
        );
        assert.deepEqual(
          kept.rows.map(r => r.event_id),
          ['cutoff', 'foreign', 'fresh'],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } finally {
      try {
        await db.query('DELETE FROM ai_workflow_events WHERE producer=$1', [producer]);
      } finally {
        await db.end();
      }
    }
  },
);
