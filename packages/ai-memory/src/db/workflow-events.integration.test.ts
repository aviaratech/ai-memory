import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'vitest';
import { createPool, assertLocalDatabaseUrl } from './pool.js';
import { runAiMemoryMigrations } from './run-migrations.js';
import { insertWorkflowEvent, readWorkflowAggregates } from './workflow-events.js';
import { parseTelemetryEvent, projectIdForTelemetry, projectHostTelemetry } from '../telemetry/event.js';
import { collectWorkflowReport, renderWorkflowReport } from '../tools/health-report/workflow.js';
import { RETENTION_QUERY_DEFS } from './retention-queries.js';
import { resolveRetentionConfig } from '../retention/retentionConfig.js';

const url = process.env.AI_MEMORY_DATABASE_URL;

test(
  'real task aggregates preserve subsets, explicit scope, snapshot, outcome evidence and top-N coverage',
  { skip: url === undefined, timeout: 0 },
  async () => {
    assert.ok(url);
    assertLocalDatabaseUrl(url);
    assert.ok(['/ai_memory_test', '/ai_memory_ci'].includes(new URL(url).pathname));
    const db = createPool({ connectionString: url, max: 4, connectionTimeoutMillis: 1000 });
    const suffix = randomUUID();
    const producer = `fixture-${suffix}`;
    const canonicalProject = `fixture/workflow-${suffix}`;
    const projectId = projectIdForTelemetry(canonicalProject);
    const sessionId = `session-${suffix}`;
    const taskId = `task-${suffix}`;
    const query = {
      projectId,
      taskId,
      windowStartIso: new Date(Date.now() - 86400000).toISOString(),
      windowEndIso: new Date(Date.now() + 86400000).toISOString(),
      limit: 20,
      timeoutMs: 5000,
    };
    const emit = async (eventId: string, extra: Record<string, unknown> = {}) => {
      const parsed = parseTelemetryEvent({
        schemaVersion: 1,
        kind: 'edge',
        source: 'producer',
        producer,
        eventId,
        projectId,
        taskId,
        stage: 'verify',
        edge: 'stage',
        evidenceIds: [`proof-${eventId}`],
        ...extra,
      });
      assert.ok(parsed.ok);
      return insertWorkflowEvent(parsed.event, db);
    };
    const canonical = async (
      id: string,
      tool: string,
      summary: Record<string, unknown>,
      status = 'ok',
      project = canonicalProject,
    ) =>
      db.query(
        'INSERT INTO ai_tool_invocations(tool_name,tool_category,status,duration_ms,invocation_id,session_id,project,summary_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [tool, 'read', status, 25, `${suffix}-${id}`, sessionId, project, JSON.stringify(summary)],
      );
    try {
      await runAiMemoryMigrations(db);
      await emit('accepted-1', { edge: 'accepted', relatedEvent: { producer, eventId: 'corrected-1' } });
      let report = await collectWorkflowReport(query, db);
      assert.equal(report.outcomeReferences[0]?.resolved, false);
      await emit('corrected-1', { edge: 'correction', relatedEvent: { producer, eventId: 'failed-1' } });
      await emit('failed-1', { edge: 'failure', executionMs: 10000, queueMs: 2000 });
      await emit('failed-2', { edge: 'failure', executionMs: 20000, queueMs: 3000 });
      await emit('retry-1', { edge: 'retry', attempt: 2 });
      for (const [eventId, usage] of [
        [
          'usage-1',
          {
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 80, cache_write_tokens: 10 },
            output_tokens: 20,
            output_tokens_details: { reasoning_tokens: 5 },
          },
        ],
        [
          'usage-2',
          {
            input_tokens: 200,
            input_tokens_details: { cached_tokens: 50, cache_write_tokens: 20 },
            output_tokens: 40,
            output_tokens_details: { reasoning_tokens: 10 },
          },
        ],
        ['usage-unknown', null],
      ] as const)
        await emit(eventId, {
          kind: 'usage',
          source: 'openai-responses',
          edge: null,
          responseId: `${suffix}-${eventId}`,
          usage,
        });
      await emit('binding', { kind: 'correlation', edge: null, host: 'codex', sessionId });
      const host = projectHostTelemetry(
        'codex',
        {
          hook_event_name: 'Stop',
          session_id: sessionId,
          turn_id: 'turn-1',
          transcript_path: '/synthetic/do-not-read',
          last_assistant_message: 'PRIVATE_SENTINEL',
        },
        () => randomUUID(),
      );
      assert.ok(host.ok);
      // Use this fixture's producer for exact cleanup without touching other hosts.
      const hostEvent = { ...host.event, producer };
      assert.equal(await insertWorkflowEvent(hostEvent, db), 'stored');
      assert.equal(await insertWorkflowEvent(hostEvent, db), 'duplicate');
      await canonical('pack', 'memory_continuity_pack', {
        memory_host: 'codex',
        continuity_pack_payload_chars: 1420,
        continuity_pack_projection_chars: 900,
        continuity_pack_projection_truncated: 1,
        injected_memory_ids: 'PRIVATE_ID_LIST',
      });
      await canonical('old-pack', 'memory_continuity_pack', { memory_host: 'codex' });
      await canonical(
        'get',
        'memory_get',
        { memory_host: 'codex', prompt: 'PRIVATE_SENTINEL', used_memory_ids: 'PRIVATE_ID_LIST' },
        'error',
      );
      await canonical('foreign-get', 'memory_get', { memory_host: 'codex' }, 'error', `${canonicalProject}-foreign`);
      report = await collectWorkflowReport(query, db);
      for (const [name, want] of Object.entries({
        inputTokens: '300',
        cachedInputTokens: '130',
        cacheWriteInputTokens: '30',
        nonReadInputTokens: '170',
        ordinaryInputTokens: '140',
        outputTokens: '60',
        reasoningOutputTokens: '15',
      })) {
        assert.deepEqual(report.totals[name], { total: want, observedSamples: '2', missingSamples: '1' });
      }
      assert.equal(report.totals.executionMs?.total, '30000');
      assert.equal(report.totals.queueMs?.total, '5000');
      assert.equal(report.coverage.usageObservations, '3');
      assert.equal(report.coverage.unknownUsageObservations, '1');
      assert.equal(report.coverage.hostObservations, '1');
      assert.equal(report.coverage.uniqueHostTurns, '1');
      assert.equal(report.outcomeReferences.filter(r => r.resolved).length, 2);
      assert.equal(report.canonicalActivity.invocations, '3');
      assert.equal(report.canonicalActivity.errors, '1');
      assert.deepEqual(report.canonicalActivity.packProjectionChars, {
        total: '900',
        observedSamples: '1',
        missingSamples: '1',
      });
      assert.deepEqual(report.canonicalActivity.projectionTruncation, {
        observedSamples: '1',
        missingSamples: '1',
        truncatedSamples: '1',
      });
      assert.equal(JSON.stringify(report).includes('PRIVATE_SENTINEL'), false);
      assert.equal(JSON.stringify(report).includes('PRIVATE_ID_LIST'), false);
      assert.match(renderWorkflowReport(report), /producer-reported/u);
      const beforeSnapshot = report.canonicalActivity.invocations;
      let inserted = false;
      const snapshotPool = {
        ...db,
        connect: async () => {
          const actual = await db.connect();
          return {
            release: (error?: boolean | Error) => {
              actual.release(error);
            },
            query: async <T>(sql: string, params?: unknown[]) => {
              const result = await actual.query<T>(sql, params);
              if (!inserted && sql.includes('WITH target_sessions') && !sql.includes('ai_tool_invocations')) {
                inserted = true;
                await canonical('concurrent', 'memory_get', { memory_host: 'codex' });
              }
              return result;
            },
          };
        },
      };
      assert.equal((await readWorkflowAggregates(query, snapshotPool)).canonicalActivity.invocations, beforeSnapshot);
      assert.equal((await readWorkflowAggregates(query, db)).canonicalActivity.invocations, '4');
      await emit('foreign-edge', {
        projectId: projectIdForTelemetry(`${canonicalProject}-foreign`),
        taskId: 'foreign-task',
        edge: 'failure',
      });
      await emit('foreign-reference', { edge: 'accepted', relatedEvent: { producer, eventId: 'foreign-edge' } });
      const foreignReference = (await readWorkflowAggregates(query, db)).outcomeReferences.find(
        r => r.eventId === 'foreign-reference',
      );
      assert.equal(foreignReference?.resolved, false);
      assert.equal(foreignReference.relatedStage, null);
      await emit('ambiguous-binding', {
        kind: 'correlation',
        edge: null,
        host: 'codex',
        sessionId,
        projectId: projectIdForTelemetry(`${canonicalProject}-foreign`),
        taskId: 'foreign-task',
      });
      const ambiguous = await readWorkflowAggregates(query, db);
      assert.equal(ambiguous.coverage.ambiguousSessions, '1');
      assert.equal(ambiguous.coverage.hostObservations, '0');
      assert.equal(ambiguous.canonicalActivity.invocations, '0');
      assert.equal(ambiguous.canonicalActivity.unattributedRows, '4');
      for (let i = 0; i < 25; i++)
        await emit(`bounded-${String(i)}`, {
          stage: `stage-${String(i)}`,
          evidenceIds: Array.from({ length: 8 }, (_, j) => `evidence-${String(i)}-${String(j)}`),
        });
      const bounded = await readWorkflowAggregates({ ...query, limit: 2 }, db);
      assert.equal(bounded.totals.inputTokens?.total, '300');
      assert.ok(BigInt(bounded.omittedGroups) > 0n);
      assert.ok(BigInt(bounded.omittedEvidenceIds) > 0n);
      assert.ok(bounded.evidenceIds.length <= 100);
      for (const dimension of ['stage', 'source', 'edge'])
        assert.ok(bounded.groups.filter(g => g.dimension === dimension).length <= 2);
      const largeTask = `${taskId}-large`;
      for (let i = 0; i < 3; i++)
        await emit(`large-${String(i)}`, {
          kind: 'usage',
          source: 'openai-responses',
          edge: null,
          taskId: largeTask,
          responseId: `${suffix}-large-${String(i)}`,
          usage: {
            input_tokens: i < 2 ? Number.MAX_SAFE_INTEGER : 0,
            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
            output_tokens: 0,
            output_tokens_details: { reasoning_tokens: 0 },
          },
        });
      const large = await readWorkflowAggregates({ ...query, taskId: largeTask }, db);
      assert.deepEqual(large.totals.inputTokens, {
        total: '18014398509481982',
        observedSamples: '3',
        missingSamples: '0',
      });
      assert.deepEqual(large.totals.outputTokens, { total: '0', observedSamples: '3', missingSamples: '0' });
      const timedTask = `${taskId}-timed`;
      await emit('timed-usage', {
        kind: 'usage',
        source: 'openai-responses',
        edge: null,
        taskId: timedTask,
        responseId: `${suffix}-timed`,
        usage: null,
        executionMs: 7,
        queueMs: 3,
      });
      const timed = await readWorkflowAggregates({ ...query, taskId: timedTask }, db);
      assert.deepEqual(timed.totals.executionMs, { total: '7', observedSamples: '1', missingSamples: '0' });
      assert.deepEqual(timed.totals.queueMs, { total: '3', observedSamples: '1', missingSamples: '0' });
      const empty = await readWorkflowAggregates({ ...query, taskId: `${taskId}-empty` }, db);
      assert.deepEqual(empty.totals.inputTokens, { total: null, observedSamples: '0', missingSamples: '0' });
      assert.equal(empty.coverage.events, '0');
    } finally {
      try {
        await db.query('DELETE FROM ai_workflow_events WHERE producer=$1', [producer]);
        await db.query('DELETE FROM ai_tool_invocations WHERE project=$1 OR project=$2', [
          canonicalProject,
          `${canonicalProject}-foreign`,
        ]);
      } finally {
        await db.end();
      }
    }
  },
);

test(
  'shipped workflow migration arbitrates concurrent replay, response ownership and reconnect recovery',
  { skip: url === undefined, timeout: 0 },
  async () => {
    assert.ok(url);
    assertLocalDatabaseUrl(url);
    assert.ok(['/ai_memory_test', '/ai_memory_ci'].includes(new URL(url).pathname));
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
    assert.ok(['/ai_memory_test', '/ai_memory_ci'].includes(new URL(url).pathname));
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
