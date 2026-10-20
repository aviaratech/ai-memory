import { createHash } from 'node:crypto';
import type { TelemetryEventV1 } from '../telemetry/event.js';
import type { DbPool } from './pool.js';
import { runBoundedQuery } from './query-runner.js';
import * as z from 'zod/v4';
import type { CanonicalWorkflowActivity } from './tool-invocations.js';

export type WorkflowInsertResult = 'stored' | 'duplicate' | 'conflict';

export interface WorkflowReportQuery {
  projectId: string;
  taskId: string;
  windowStartIso: string;
  windowEndIso: string;
  limit: number;
  timeoutMs: number;
}
export interface WorkflowMetricAggregate {
  total: string | null;
  observedSamples: string;
  missingSamples: string;
}
export interface WorkflowGroup {
  dimension: 'stage' | 'source' | 'edge';
  key: string | null;
  samples: string;
  failures: string;
  metrics: Record<string, WorkflowMetricAggregate>;
  evidenceIds: string[];
  omittedEvidenceIds: string;
}
export interface WorkflowOutcomeReference {
  producer: string;
  eventId: string;
  edge: 'accepted' | 'correction';
  stage: string;
  relatedStage: string | null;
  relatedEvent: { producer: string; eventId: string };
  resolved: boolean;
  evidenceIds: string[];
}
export interface WorkflowAggregateData {
  totals: Record<string, WorkflowMetricAggregate>;
  groups: WorkflowGroup[];
  omittedGroups: string;
  coverage: {
    events: string;
    usageObservations: string;
    knownUsageObservations: string;
    unknownUsageObservations: string;
    hostObservations: string;
    invocationOnlyObservations: string;
    uniqueHostTurns: string | null;
    observationsWithoutTime: string;
    ambiguousSessions: string;
  };
  outcomeReferences: WorkflowOutcomeReference[];
  omittedOutcomeReferences: string;
  evidenceIds: string[];
  omittedEvidenceIds: string;
  canonicalActivity: CanonicalWorkflowActivity;
}

const reportQuerySchema = z.strictObject({
  projectId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  taskId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_.:-]+$/u),
  windowStartIso: z.iso.datetime(),
  windowEndIso: z.iso.datetime(),
  limit: z.number().int().min(1).max(100),
  timeoutMs: z.number().int().min(1).max(5000),
});
export function validateWorkflowReportQuery(input: WorkflowReportQuery): void {
  if (!reportQuerySchema.safeParse(input).success) throw new Error('invalid_workflow_scope');
  const duration = Date.parse(input.windowEndIso) - Date.parse(input.windowStartIso);
  if (duration <= 0 || duration > 90 * 86400000) throw new Error('invalid_workflow_scope');
}

/** Shared by the event and canonical projections; only these retained explicit
 * bindings establish scope. A conflicting binding never becomes "latest". */
export const WORKFLOW_BINDINGS_CTE = `WITH target_sessions AS (
  SELECT DISTINCT host, session_id FROM ai_workflow_events
  WHERE kind = 'correlation' AND project_id = $1 AND task_id = $2
    AND ingested_at >= $4::timestamptz - INTERVAL '90 days' AND ingested_at < $4::timestamptz
), bindings AS (
  SELECT b.host, b.session_id, count(DISTINCT (b.project_id, b.task_id)) = 1 AS unambiguous
  FROM ai_workflow_events b JOIN target_sessions t USING (host, session_id)
  WHERE b.kind = 'correlation' AND b.ingested_at >= $4::timestamptz - INTERVAL '90 days'
    AND b.ingested_at < $4::timestamptz
  GROUP BY b.host, b.session_id
)`;

const metricDefinitions = [
  ['inputTokens', 'input_tokens', "kind = 'usage'"],
  ['cachedInputTokens', 'cached_input_tokens', "kind = 'usage'"],
  ['cacheWriteInputTokens', 'cache_write_input_tokens', "kind = 'usage'"],
  ['outputTokens', 'output_tokens', "kind = 'usage'"],
  ['reasoningOutputTokens', 'reasoning_output_tokens', "kind = 'usage'"],
  [
    'nonReadInputTokens',
    "CASE WHEN usage_accounting = 'openai-responses' THEN input_tokens - cached_input_tokens END",
    "kind = 'usage'",
  ],
  [
    'ordinaryInputTokens',
    "CASE WHEN usage_accounting = 'openai-responses' THEN input_tokens - cached_input_tokens - cache_write_input_tokens END",
    "kind = 'usage'",
  ],
  ['executionMs', 'execution_ms', 'true'],
  ['queueMs', 'queue_ms', 'true'],
] as const;

function metricAggregatesSql(): string {
  return `jsonb_build_object(${metricDefinitions
    .map(
      ([name, value, denominator]) =>
        `'${name}', jsonb_build_object('total', (sum(${value}) FILTER (WHERE ${denominator}))::text,
      'observedSamples', (count(${value}) FILTER (WHERE ${denominator}))::text,
      'missingSamples', ((count(*) FILTER (WHERE ${denominator})) - (count(${value}) FILTER (WHERE ${denominator})))::text)`,
    )
    .join(', ')})`;
}

const knownUsage =
  '(input_tokens IS NOT NULL OR cached_input_tokens IS NOT NULL OR cache_write_input_tokens IS NOT NULL OR output_tokens IS NOT NULL OR reasoning_output_tokens IS NOT NULL)';
const aggregateSql = `${WORKFLOW_BINDINGS_CTE}, retained AS (
  SELECT e.* FROM ai_workflow_events e
  WHERE e.ingested_at >= $4::timestamptz - INTERVAL '90 days' AND e.ingested_at < $4::timestamptz
), scoped AS (
  SELECT e.* FROM retained e WHERE e.ingested_at >= $3::timestamptz AND (
    (e.project_id = $1 AND e.task_id = $2) OR
    (e.project_id IS NULL AND e.task_id IS NULL AND EXISTS (
      SELECT 1 FROM bindings b WHERE b.unambiguous AND b.host = e.host AND b.session_id = e.session_id
    ))
  )
), grouped AS (
  SELECT 'stage' AS dimension, stage AS key, count(*)::text AS samples,
    (count(*) FILTER (WHERE edge = 'failure'))::text AS failures, ${metricAggregatesSql()} AS metrics FROM scoped GROUP BY stage
  UNION ALL SELECT 'source', source, count(*)::text,
    (count(*) FILTER (WHERE edge = 'failure'))::text, ${metricAggregatesSql()} FROM scoped GROUP BY source
  UNION ALL SELECT 'edge', edge, count(*)::text,
    (count(*) FILTER (WHERE edge = 'failure'))::text, ${metricAggregatesSql()} FROM scoped WHERE kind = 'edge' GROUP BY edge
), ranked_groups AS (
  SELECT *, row_number() OVER (PARTITION BY dimension ORDER BY samples::numeric DESC, key NULLS LAST) AS rank FROM grouped
), evidence AS (
  SELECT DISTINCT ev.value FROM scoped CROSS JOIN LATERAL unnest(evidence_ids) AS ev(value)
), outcomes AS (
  SELECT e.id, e.producer, e.event_id, e.stage, e.edge, e.related_producer, e.related_event_id, e.evidence_ids,
    (SELECT target.stage FROM retained target WHERE target.producer = e.related_producer AND target.event_id = e.related_event_id
      AND target.kind = 'edge' AND target.project_id = $1 AND target.task_id = $2 AND target.id <> e.id) AS related_stage,
    EXISTS (SELECT 1 FROM retained target WHERE target.producer = e.related_producer AND target.event_id = e.related_event_id
      AND target.kind = 'edge' AND target.project_id = $1 AND target.task_id = $2 AND target.id <> e.id) AS resolved
  FROM scoped e WHERE e.kind = 'edge' AND e.edge IN ('accepted','correction')
)
SELECT jsonb_build_object(
  'totals', (SELECT ${metricAggregatesSql()} FROM scoped),
  'groups', COALESCE((SELECT jsonb_agg(jsonb_build_object('dimension',g.dimension,'key',g.key,'samples',g.samples,'failures',g.failures,'metrics',g.metrics,
    'evidenceIds', COALESCE((SELECT jsonb_agg(value ORDER BY value) FROM (SELECT DISTINCT ev.value FROM scoped s CROSS JOIN LATERAL unnest(s.evidence_ids) ev(value)
      WHERE CASE g.dimension WHEN 'stage' THEN s.stage IS NOT DISTINCT FROM g.key WHEN 'source' THEN s.source IS NOT DISTINCT FROM g.key ELSE s.edge IS NOT DISTINCT FROM g.key END ORDER BY ev.value LIMIT 8) limited), '[]'::jsonb),
    'omittedEvidenceIds', (SELECT greatest(0,count(DISTINCT ev.value)-8)::text FROM scoped s CROSS JOIN LATERAL unnest(s.evidence_ids) ev(value)
      WHERE CASE g.dimension WHEN 'stage' THEN s.stage IS NOT DISTINCT FROM g.key WHEN 'source' THEN s.source IS NOT DISTINCT FROM g.key ELSE s.edge IS NOT DISTINCT FROM g.key END)
    ) ORDER BY g.dimension,g.rank) FROM ranked_groups g WHERE g.rank <= $5), '[]'::jsonb),
  'omittedGroups', (SELECT count(*)::text FROM ranked_groups WHERE rank > $5),
  'coverage', (SELECT jsonb_build_object(
    'events', count(*)::text,
    'usageObservations', (count(*) FILTER (WHERE kind='usage'))::text,
    'knownUsageObservations', (count(*) FILTER (WHERE kind='usage' AND ${knownUsage}))::text,
    'unknownUsageObservations', (count(*) FILTER (WHERE kind='usage' AND NOT ${knownUsage}))::text,
    'hostObservations', (count(*) FILTER (WHERE kind='host'))::text,
    'invocationOnlyObservations', (count(*) FILTER (WHERE kind='host' AND dedup_coverage='invocation-only'))::text,
    'uniqueHostTurns', CASE WHEN count(*) FILTER (WHERE kind='host')=0 OR count(*) FILTER (WHERE kind='host' AND dedup_coverage='invocation-only')>0 THEN NULL ELSE (count(DISTINCT (host,session_id,turn_id)) FILTER (WHERE kind='host' AND dedup_coverage='host-turn'))::text END,
    'observationsWithoutTime', (count(*) FILTER (WHERE observed_at IS NULL))::text,
    'ambiguousSessions', (SELECT count(*)::text FROM bindings WHERE NOT unambiguous)
  ) FROM scoped),
  'outcomeReferences', COALESCE((SELECT jsonb_agg(jsonb_build_object('producer',producer,'eventId',event_id,'stage',stage,'relatedStage',related_stage,'edge',edge,'relatedEvent',jsonb_build_object('producer',related_producer,'eventId',related_event_id),'resolved',resolved,'evidenceIds',evidence_ids) ORDER BY id) FROM (SELECT * FROM outcomes ORDER BY id LIMIT $5) limited), '[]'::jsonb),
  'omittedOutcomeReferences', (SELECT greatest(0,count(*)-$5)::text FROM outcomes),
  'evidenceIds', COALESCE((SELECT jsonb_agg(value ORDER BY value) FROM (SELECT value FROM evidence ORDER BY value LIMIT 100) limited), '[]'::jsonb),
  'omittedEvidenceIds', (SELECT greatest(0,count(*)-100)::text FROM evidence)
) AS data`;

export async function readWorkflowAggregates(input: WorkflowReportQuery, db: DbPool): Promise<WorkflowAggregateData> {
  validateWorkflowReportQuery(input);
  return runBoundedQuery({
    phase: 'db.read.workflow_report',
    pool: db,
    timeoutMs: input.timeoutMs,
    task: async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const result = await client.query<{ data: Omit<WorkflowAggregateData, 'canonicalActivity'> }>(aggregateSql, [
        input.projectId,
        input.taskId,
        input.windowStartIso,
        input.windowEndIso,
        input.limit,
      ]);
      const data = result.rows[0]?.data;
      if (data === undefined) throw new Error('workflow_report_unavailable');
      // Lazy import avoids operational module initialization for pure event ingestion.
      const { queryWorkflowToolActivity } = await import('./tool-invocations.js');
      return { ...data, canonicalActivity: await queryWorkflowToolActivity(input, client) };
    },
  });
}

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
