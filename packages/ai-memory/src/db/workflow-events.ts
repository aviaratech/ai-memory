import { createHash } from 'node:crypto';
import type { TelemetryEventV1 } from '../telemetry/event.js';
import type { DbPool } from './pool.js';
import { runBoundedQuery } from './query-runner.js';

export type WorkflowInsertResult = 'stored' | 'duplicate' | 'conflict';

const columns = [
  'schema_version',
  'kind',
  'producer',
  'event_id',
  'source',
  'observed_at',
  'project_id',
  'task_id',
  'session_id',
  'turn_id',
  'response_id',
  'host',
  'model',
  'stage',
  'tool_category',
  'edge',
  'attempt',
  'execution_ms',
  'queue_ms',
  'related_producer',
  'related_event_id',
  'evidence_ids',
  'host_event',
  'dedup_coverage',
  'usage_accounting',
  'input_tokens',
  'cached_input_tokens',
  'cache_write_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'payload_fingerprint',
];

/** Primitive fixed-key encoding; property insertion order never affects replay. */
function encodedValues(e: TelemetryEventV1): unknown[] {
  return [
    e.schemaVersion,
    e.kind,
    e.producer,
    e.eventId,
    e.source,
    e.observedAt,
    e.projectId,
    e.taskId,
    e.sessionId,
    e.turnId,
    e.responseId,
    e.host,
    e.model,
    e.stage,
    e.toolCategory,
    e.edge,
    e.attempt,
    e.executionMs,
    e.queueMs,
    e.relatedEvent?.producer ?? null,
    e.relatedEvent?.eventId ?? null,
    e.evidenceIds,
    e.hostEvent,
    e.dedupCoverage,
    e.usage?.accounting ?? null,
    e.usage?.inputTokens ?? null,
    e.usage?.cachedInputTokens ?? null,
    e.usage?.cacheWriteInputTokens ?? null,
    e.usage?.outputTokens ?? null,
    e.usage?.reasoningOutputTokens ?? null,
  ];
}

export async function insertWorkflowEvent(event: TelemetryEventV1, db: DbPool): Promise<WorkflowInsertResult> {
  const values = encodedValues(event);
  const fingerprint = createHash('sha256').update(JSON.stringify(values)).digest('hex');
  values.push(fingerprint);
  return runBoundedQuery({
    phase: 'db.write.workflow_event',
    pool: db,
    timeoutMs: 500,
    task: async client => {
      const inserted = await client.query(
        `INSERT INTO ai_workflow_events (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${String(i + 1)}`).join(', ')}) ON CONFLICT DO NOTHING RETURNING id`,
        values,
      );
      if (inserted.rowCount > 0) return 'stored';
      const prior = await client.query<{ producer: string; event_id: string; payload_fingerprint: string }>(
        `SELECT producer, event_id, payload_fingerprint FROM ai_workflow_events
       WHERE (producer = $1 AND event_id = $2)
          OR (kind = 'usage' AND source = $3 AND response_id = $4)
       ORDER BY CASE WHEN producer = $1 AND event_id = $2 THEN 0 ELSE 1 END LIMIT 2`,
        [event.producer, event.eventId, event.source, event.kind === 'usage' ? event.responseId : null],
      );
      return prior.rows.some(
        row =>
          row.producer === event.producer && row.event_id === event.eventId && row.payload_fingerprint === fingerprint,
      )
        ? 'duplicate'
        : 'conflict';
    },
  });
}
