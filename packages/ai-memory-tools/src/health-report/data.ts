import type { DbPool } from '@aviaratech/ai-memory/internal';
import type { ResolvedLogPath, StrategyConfidence, ToolInvocationRow } from '@aviaratech/ai-memory/internal';
import type { Pool as PgPool } from 'pg';

import {
  buildFailureSignature,
  getCategoryTier,
  queryToolInvocations,
  resolveRetentionConfig,
  resolveTimeoutPolicy,
  STRATEGY_CONFIDENCE_VALUES,
} from '@aviaratech/ai-memory/internal';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';

import type {
  CalibrationActualOutcome,
  CalibrationSignal,
  CategoryCountMetric,
  ConsolidationDailyMetric,
  ConsolidationMetrics,
  ConsolidationTopMemoryKeyMetric,
  ConsolidationTotalsMetric,
  ContinuityChannelMetrics,
  DecisionReversalMetric,
  ECEResult,
  JsonRecord,
  McpUsageMetrics,
  OrchestrationMetrics,
  OrientMetrics,
  ReflectMetrics,
  RepeatedFixMetric,
  RetentionBacklogEntry,
  RetentionLastRun,
  RetentionMetrics,
  ReworkAfterResumeMetric,
  SqlQuery,
  TaxonomyDistributionMetric,
  ToolAggregate,
  ToolInvocation,
  TrackedDecisionCategory,
  UsefulnessContinuityScore,
  UsefulnessMetrics,
  WriteCalibrationCell,
  WriteCalibrationMetrics,
  WriterParticipationFamily,
  WriterParticipationFamilyMetric,
  WriterParticipationFlag,
  WriterParticipationHealth,
} from './types.js';

import {
  ACTIVE_FAILURE_WINDOW_DAYS,
  CODEX_HOOK_DELTA_EVENT_ID_PREFIX,
  DEFAULT_CALIBRATION_MIN_SIGNALS,
  DEFAULT_DECISION_REVERSAL_WINDOW_DAYS,
  DEFAULT_REPEATED_FIX_WINDOW_DAYS,
  EVENT_CONFLICT_TARGET_PCT,
  FAILURE_SIGNATURE_SAMPLE_LIMIT,
  SESSION_END_CONFLICT_WINDOW_DAYS,
  SESSION_END_DELTA_EVENT_ID_PREFIX,
  TOP_FAILURE_SIGNATURE_LIMIT,
  TOP_TIMEOUT_OPERATION_LIMIT,
} from './constants.js';

/**
 * Minimum share each writer family must hold to be considered participating. Set per
 * family rather than per raw source because raw writer sources are high-cardinality (15+
 * distinct labels in real reports) and any flat per-source minimum is mathematically
 * infeasible (15 × 20% = 300% required). With ≤ 5 stable families
 * (`classifyWriterSourceFamily`), a 10% per-family floor is feasible and operator-
 * meaningful: it flags "the system family or codex family went silent" without the
 * spurious LOWs that the previous per-source 20% gate produced.
 */
export const DEFAULT_WRITER_PARTICIPATION_FAMILY_MIN_PCT = 10;

const DAY_MS = 24 * 60 * 60 * 1_000;
const USEFULNESS_RESUME_WRITE_WINDOW_MINUTES = 15;
const USEFULNESS_MIN_BUCKET_SIZE = 30;
import { isRecord, parseJsonObject, parseTimestampMs, percent, toNumber, toText } from './utils.js';

const DECISION_REVERSAL_CATEGORIES: TrackedDecisionCategory[] = ['decision', 'architecture', 'convention'];

const CALIBRATION_PROBABILITY_BY_PREDICTED: Record<StrategyConfidence, number> = {
  high: 0.85,
  low: 0.25,
  medium: 0.55,
};

const CALIBRATION_OUTCOME_BY_ACTUAL: Record<CalibrationActualOutcome, number> = {
  failure: 0,
  partial: 0.5,
  success: 1,
};

const REFLECT_CYCLE_MEMORY_KEY_MARKER = ':methodology:reflect:cycle-';
type Pool = Pick<DbPool, 'query'>;

const CALIBRATION_BINS: {
  max: number;
  min: number;
  range: string;
}[] = [
  { max: 0.4, min: 0, range: '[0, 0.4)' },
  { max: 0.7, min: 0.4, range: '[0.4, 0.7)' },
  { max: 1.0000001, min: 0.7, range: '[0.7, 1.0]' },
];

export interface ReflectCycleRow extends JsonRecord {
  created_at: unknown;
  memory_key: unknown;
  metadata_json: unknown;
}

interface ConsolidationDailyAccumulator extends ConsolidationDailyMetric {
  latencyTotalMs: number;
}

interface ConsolidationEventRow extends JsonRecord {
  created_at: unknown;
  payload_json: unknown;
}

interface WriteCalibrationRow extends JsonRecord {
  author: unknown;
  avg_calibrated_confidence: unknown;
  avg_declared_confidence: unknown;
  category: unknown;
  memory_count: unknown;
  reversal_count: unknown;
}

export function buildReflectMetricsFromRows(
  cycleRows: ReflectCycleRow[],
  provisionalMethodologyMemoriesWritten: number,
): ReflectMetrics {
  const recentCycles = cycleRows
    .map(row => {
      const metadata = parseJsonObject(row.metadata_json) ?? {};
      const createdAt = toText(row.created_at);
      const completedAt = toText(metadata.completedAt) || toText(metadata.cycleTimestamp) || createdAt || null;
      const memoryKey = toText(row.memory_key);
      const cycleId =
        toText(metadata.cycleId) ||
        (memoryKey.includes(REFLECT_CYCLE_MEMORY_KEY_MARKER)
          ? memoryKey.slice(memoryKey.indexOf(REFLECT_CYCLE_MEMORY_KEY_MARKER) + REFLECT_CYCLE_MEMORY_KEY_MARKER.length)
          : '');

      return {
        completedAt,
        cycleId: cycleId.length > 0 ? cycleId : null,
        evaluationCountAtReflection: readNullableNumber(metadata.evaluationCountAtReflection),
        evaluationsSinceLastCycle: readNullableNumber(metadata.evaluationsSinceLastCycle),
        provisionalMethodologyMemoriesWritten: toNumber(metadata.provisionalMethodologyMemoriesWritten),
        skippedTargets: readStringArray(metadata.skippedTargets),
        triggeredBy: toText(metadata.triggeredBy) || null,
      };
    })
    .sort((left, right) => {
      const rightTime = Date.parse(right.completedAt ?? '');
      const leftTime = Date.parse(left.completedAt ?? '');
      return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
    });

  const latest = recentCycles[0];

  return {
    cyclesInWindow: cycleRows.length,
    evaluationsSinceLastCycle: latest?.evaluationsSinceLastCycle ?? null,
    lastCycleIso: latest?.completedAt ?? null,
    provisionalMethodologyMemoriesWritten,
    recentCycles: recentCycles.slice(0, 5).map(cycle => ({
      completedAt: cycle.completedAt,
      cycleId: cycle.cycleId,
      evaluationCountAtReflection: cycle.evaluationCountAtReflection,
      provisionalMethodologyMemoriesWritten: cycle.provisionalMethodologyMemoriesWritten,
      skippedTargets: cycle.skippedTargets,
      triggeredBy: cycle.triggeredBy,
    })),
  };
}

export function buildTaxonomyDistribution(categoryRows: CategoryCountMetric[]): TaxonomyDistributionMetric[] {
  const tierCounts = new Map<TaxonomyDistributionMetric['tier'], number>([
    ['actionable', 0],
    ['contextual', 0],
    ['low-signal', 0],
  ]);

  for (const row of categoryRows) {
    const tier = getCategoryTier(row.category);
    tierCounts.set(tier, (tierCounts.get(tier) ?? 0) + row.count);
  }

  const total = categoryRows.reduce((sum, row) => sum + row.count, 0);

  return (['actionable', 'contextual', 'low-signal'] as const).map(tier => ({
    count: tierCounts.get(tier) ?? 0,
    pct: percent(tierCounts.get(tier) ?? 0, total),
    tier,
  }));
}

/**
 * Aggregates timeout phases from two sources into a top-N breakdown:
 *
 * 1. **Hard failures** — `ai_ingestion_failures` rows whose `error_message` has
 *    the canonical timeout shape (`<phase> timed out after <n>ms`). These come
 *    from MCP tool calls that aborted on a `TimeoutError`.
 * 2. **Warning-only degradation** — `ai_tool_invocations.summary_json.timed_out_steps`,
 *    a comma-separated phase list captured by the tool wrapper when a step
 *    timed out but the tool still returned a payload (the same population the
 *    timeout/degradation launch gate uses). Without this source the new
 *    breakdown would show `(none)` while the launch gate was failing — see
 *    the timeout regression.
 *
 * Phase names come from `TimeoutError` in `runBoundedQuery`, the orient
 * sub-step labels, and the embedding operation labels — see
 * `extractTimedOutSteps` and `query-runner.ts`.
 *
 * Operators reading the rolling health report use this to attribute the
 * timeout/degradation rate to a specific phase instead of inspecting
 * `Top repeated failure signatures` for clues.
 */
export function buildTopTimeoutOperations(input: {
  failureSignatureRows: { error_message: unknown }[];
  toolInvocationTimedOutStepsRows?: { timed_out_steps: unknown }[];
}): { count: number; phase: string }[] {
  const counts = new Map<string, number>();
  for (const row of input.failureSignatureRows) {
    const message = toText(row.error_message);
    const match = /^(.*?) timed out after \d+ms\b/iu.exec(message);
    if (match === null) {
      continue;
    }
    const phase = match[1]?.trim() ?? '';
    if (phase.length === 0) {
      continue;
    }
    counts.set(phase, (counts.get(phase) ?? 0) + 1);
  }
  for (const row of input.toolInvocationTimedOutStepsRows ?? []) {
    const raw = toText(row.timed_out_steps);
    if (raw.length === 0) {
      continue;
    }
    for (const piece of raw.split(',')) {
      const phase = piece.trim();
      if (phase.length === 0) {
        continue;
      }
      counts.set(phase, (counts.get(phase) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([phase, count]) => ({ count, phase }))
    .sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      return a.phase.localeCompare(b.phase);
    })
    .slice(0, TOP_TIMEOUT_OPERATION_LIMIT);
}

export function buildWriteCalibrationMetricsFromRows(rows: WriteCalibrationRow[]): WriteCalibrationMetrics {
  const cells: WriteCalibrationCell[] = rows
    .map(row => {
      const memoryCount = toNumber(row.memory_count);
      const reversalCount = toNumber(row.reversal_count);
      return {
        author: toText(row.author) || 'unknown',
        avgCalibratedConfidence: Number(toNumber(row.avg_calibrated_confidence).toFixed(4)),
        avgDeclaredConfidence: Number(toNumber(row.avg_declared_confidence).toFixed(4)),
        brierScore: null,
        category: toText(row.category) || '(uncategorized)',
        memoryCount,
        reversalRate: memoryCount === 0 ? 0 : Number((reversalCount / memoryCount).toFixed(4)),
      };
    })
    .sort((left, right) => {
      const leftDelta = left.avgDeclaredConfidence - left.avgCalibratedConfidence;
      const rightDelta = right.avgDeclaredConfidence - right.avgCalibratedConfidence;
      if (rightDelta !== leftDelta) {
        return rightDelta - leftDelta;
      }
      return right.memoryCount - left.memoryCount;
    });

  return {
    cells,
    topDepleted: cells
      .filter(cell => cell.avgDeclaredConfidence > 0 && cell.avgCalibratedConfidence < cell.avgDeclaredConfidence * 0.5)
      .slice(0, 10),
  };
}

/**
 * Map a raw writer-source label to its stable family. Buckets are matched in declaration
 * order (claude → codex → manual → system) with `other` as the fallthrough. The match list
 * is deliberately broad — adding a new writer source under an existing prefix (e.g.
 * `codex-retro-batch`) keeps it inside the existing family without code changes.
 */
export function classifyWriterSourceFamily(source: string): WriterParticipationFamily {
  const lower = source.toLowerCase().trim();
  if (lower.length === 0) return 'other';

  if (lower === 'claude' || lower === 'claude-code' || lower.startsWith('claude-')) return 'claude';
  if (lower === 'codex' || lower.startsWith('codex-')) return 'codex';
  if (
    lower === 'manual' ||
    lower === 'manual-flush' ||
    lower === 'memory-flush' ||
    lower === 'user' ||
    lower === 'operator'
  ) {
    return 'manual';
  }
  if (
    lower === 'agent' ||
    lower === 'system' ||
    lower === 'background-worker' ||
    lower === 'cron' ||
    lower === 'retro' ||
    lower === 'retention' ||
    lower === 'ingestion' ||
    lower.endsWith('-builder') ||
    lower.endsWith('-reviewer') ||
    lower.endsWith('-retro')
  ) {
    return 'system';
  }
  return 'other';
}

export async function collectDatabaseMetrics({
  pool,
  windowEndIso,
  windowStartIso,
}: {
  pool: Pool;
  windowEndIso: string;
  windowStartIso: string;
}) {
  const activeWindowStartIso = new Date(
    new Date(windowEndIso).getTime() - ACTIVE_FAILURE_WINDOW_DAYS * 24 * 60 * 60 * 1_000,
  ).toISOString();
  const activeWindowEffectiveStartIso = activeWindowStartIso > windowStartIso ? activeWindowStartIso : windowStartIso;
  const historicalWindowStartIso = windowStartIso;
  const historicalWindowEndIso = activeWindowEffectiveStartIso;
  const hasHistoricalWindow = historicalWindowStartIso < historicalWindowEndIso;

  // Historical-window split by resolution status. The reviewer-flagged failure mode (F1)
  // was that a non-zero `total` was always rendered as "historical cleanup debt", even
  // when those rows had been resolved (`resolved_at IS NOT NULL`). Split the count so the
  // renderer can distinguish:
  //   - historical unresolved debt — rows from this window still needing operator action
  //   - historical resolved rows   — rows from this window already closed (not debt)
  const historicalFailureCountsPromise: Promise<{
    resolved: unknown;
    total: unknown;
    unresolved: unknown;
  }> = hasHistoricalWindow
    ? querySingle<{ resolved: unknown; total: unknown; unresolved: unknown }>(pool, {
        params: [historicalWindowStartIso, historicalWindowEndIso],
        sql: `
          SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE resolved_at IS NULL)::int AS unresolved,
            COUNT(*) FILTER (WHERE resolved_at IS NOT NULL)::int AS resolved
          FROM ai_ingestion_failures
          WHERE created_at >= $1::timestamptz
            AND created_at < $2::timestamptz
        `,
      })
    : Promise.resolve({ resolved: 0, total: 0, unresolved: 0 });

  const historicalFailureSourcesPromise: Promise<{ count: unknown; source: unknown }[]> = hasHistoricalWindow
    ? queryRows<{ count: unknown; source: unknown }>(pool, {
        params: [historicalWindowStartIso, historicalWindowEndIso],
        sql: `
          SELECT source, COUNT(*)::int AS count
          FROM ai_ingestion_failures
          WHERE created_at >= $1::timestamptz
            AND created_at < $2::timestamptz
          GROUP BY source
          ORDER BY count DESC, source ASC
        `,
      })
    : Promise.resolve([]);

  const [
    sessionsStarted,
    deltasIngested,
    contextPacksIngested,
    continuityPackRow,
    durableMemoriesCreated,
    durableMemoriesUpdated,
    ingestionFailures,
    failuresBySource,
    failuresByStage,
    mttr,
    activeFailureCounts,
    activeFailuresBySource,
    historicalFailureCounts,
    historicalFailuresBySource,
    sessionEndConflictMismatches14d,
    sessionEndWrites14d,
    durableWritesBySource,
    failureSignatureRows,
    deltaChannelRows,
    categoryRows,
    continuityAdoption,
    continuityAdoptionByChannel,
    continuityReadinessFields,
    continuityReadinessReads,
    continuityAgentWriterCompliance,
    calibrationRows,
    repeatedFixRate,
    decisionReversalRate,
    resolutionCounts,
    memoryTypeNullRow,
    reflectCycleRows,
    provisionalMethodologyMemoriesWritten,
    writeCalibrationRows,
    toolInvocationTimedOutStepsRows,
  ] = await Promise.all([
    queryCount(pool, {
      params: [windowStartIso],
      sql: `SELECT COUNT(*)::int AS value FROM ai_sessions WHERE started_at >= $1::timestamptz`,
    }),
    queryCount(pool, {
      params: [windowStartIso],
      sql: `SELECT COUNT(*)::int AS value FROM ai_memory_deltas WHERE created_at >= $1::timestamptz`,
    }),
    queryCount(pool, {
      params: [windowStartIso],
      sql: `SELECT COUNT(*)::int AS value FROM ai_context_packs WHERE created_at >= $1::timestamptz`,
    }),
    querySingle<{
      avg_payload_chars: unknown;
      max_payload_budget_pct: unknown;
      max_payload_chars: unknown;
      packs: unknown;
      updated_in_window: unknown;
    }>(pool, {
      params: [windowStartIso],
      sql: `
        SELECT
          COUNT(*)::int AS packs,
          COUNT(*) FILTER (WHERE updated_at >= $1::timestamptz)::int AS updated_in_window,
          COALESCE(AVG(payload_chars), 0)::double precision AS avg_payload_chars,
          COALESCE(MAX(
            CASE
              WHEN budget_chars > 0 THEN (payload_chars::double precision / budget_chars::double precision) * 100.0
              ELSE 0
            END
          ), 0)::double precision AS max_payload_budget_pct,
          COALESCE(MAX(payload_chars), 0)::int AS max_payload_chars
        FROM ai_continuity_packs
      `,
    }),
    queryCount(pool, {
      params: [windowStartIso],
      sql: `SELECT COUNT(*)::int AS value FROM ai_memory_entries WHERE created_at >= $1::timestamptz`,
    }),
    queryCount(pool, {
      params: [windowStartIso],
      sql: `
        SELECT COUNT(*)::int AS value
        FROM ai_memory_entries
        WHERE updated_at >= $1::timestamptz AND updated_at > created_at
      `,
    }),
    queryCount(pool, {
      params: [windowStartIso],
      sql: `SELECT COUNT(*)::int AS value FROM ai_ingestion_failures WHERE created_at >= $1::timestamptz`,
    }),
    queryRows<{ count: unknown; source: unknown }>(pool, {
      params: [windowStartIso],
      sql: `
        SELECT source, COUNT(*)::int AS count
        FROM ai_ingestion_failures
        WHERE created_at >= $1::timestamptz
        GROUP BY source
        ORDER BY count DESC, source ASC
      `,
    }),
    queryRows<{ count: unknown; stage: unknown }>(pool, {
      params: [windowStartIso],
      sql: `
        SELECT coalesce(stage, '(unknown)') AS stage, COUNT(*)::int AS count
        FROM ai_ingestion_failures
        WHERE created_at >= $1::timestamptz
        GROUP BY stage
        ORDER BY count DESC, stage ASC
      `,
    }),
    querySingle<{
      avg_mttr_minutes: unknown;
      resolved: unknown;
      total: unknown;
      unresolved: unknown;
    }>(pool, {
      params: [windowStartIso],
      sql: `
        WITH failures AS (
          SELECT id, session_id, created_at
          FROM ai_ingestion_failures
          WHERE created_at >= $1::timestamptz
        ),
        resolutions AS (
          SELECT
            f.id,
            f.created_at,
            MIN(d.created_at) AS resolved_at
          FROM failures f
          LEFT JOIN ai_memory_deltas d
            ON f.session_id IS NOT NULL
            AND d.session_id = f.session_id
            AND d.created_at > f.created_at
          GROUP BY f.id, f.created_at
        )
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE resolved_at IS NOT NULL)::int AS resolved,
          COUNT(*) FILTER (WHERE resolved_at IS NULL)::int AS unresolved,
          COALESCE(
            AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 60.0) FILTER (WHERE resolved_at IS NOT NULL),
            0
          )::double precision AS avg_mttr_minutes
        FROM resolutions
      `,
    }),
    // Active-window split by resolution status. Symmetrical with the historical-window
    // split so the renderer reports both `unresolved` (current incidents) and `resolved`
    // (rows that arrived in-window but have already been closed).
    querySingle<{ resolved: unknown; total: unknown; unresolved: unknown }>(pool, {
      params: [activeWindowEffectiveStartIso, windowEndIso],
      sql: `
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE resolved_at IS NULL)::int AS unresolved,
          COUNT(*) FILTER (WHERE resolved_at IS NOT NULL)::int AS resolved
        FROM ai_ingestion_failures
        WHERE created_at >= $1::timestamptz
          AND created_at <= $2::timestamptz
      `,
    }),
    queryRows<{ count: unknown; source: unknown }>(pool, {
      params: [activeWindowEffectiveStartIso, windowEndIso],
      sql: `
        SELECT source, COUNT(*)::int AS count
        FROM ai_ingestion_failures
        WHERE created_at >= $1::timestamptz
          AND created_at <= $2::timestamptz
        GROUP BY source
        ORDER BY count DESC, source ASC
      `,
    }),
    historicalFailureCountsPromise,
    historicalFailureSourcesPromise,
    queryCount(pool, {
      params: [SESSION_END_DELTA_EVENT_ID_PREFIX, CODEX_HOOK_DELTA_EVENT_ID_PREFIX],
      sql: `
        SELECT COUNT(*)::int AS value
        FROM ai_ingestion_failures
        WHERE created_at >= NOW() - INTERVAL '${String(SESSION_END_CONFLICT_WINDOW_DAYS)} days'
          AND stage = 'event_conflict_mismatch'
          AND (details_json ->> 'eventId' LIKE $1 OR details_json ->> 'eventId' LIKE $2)
      `,
    }),
    queryCount(pool, {
      params: [SESSION_END_DELTA_EVENT_ID_PREFIX, CODEX_HOOK_DELTA_EVENT_ID_PREFIX],
      sql: `
        SELECT COUNT(*)::int AS value
        FROM ai_session_events
        WHERE created_at >= NOW() - INTERVAL '${String(SESSION_END_CONFLICT_WINDOW_DAYS)} days'
          AND (event_id LIKE $1 OR event_id LIKE $2)
      `,
    }),
    queryRows<{ count: unknown; source: unknown }>(pool, {
      params: [windowStartIso],
      sql: `
        SELECT source, COUNT(*)::int AS count
        FROM ai_memory_entries
        WHERE (created_at >= $1::timestamptz OR (updated_at >= $1::timestamptz AND updated_at > created_at))
          AND category IS DISTINCT FROM 'session-summary'
        GROUP BY source
        ORDER BY count DESC, source ASC
      `,
    }),
    queryRows<{ error_message: unknown; source: unknown; stage: unknown }>(pool, {
      params: [windowStartIso, FAILURE_SIGNATURE_SAMPLE_LIMIT],
      sql: `
        SELECT source, coalesce(stage, '(unknown)') AS stage, coalesce(error_message, '') AS error_message
        FROM ai_ingestion_failures
        WHERE created_at >= $1::timestamptz
        ORDER BY created_at DESC
        LIMIT $2::int
      `,
    }),
    queryRows<{ count: unknown; source: unknown }>(pool, {
      params: [windowStartIso],
      sql: `
        SELECT coalesce(raw_json->'workflow'->>'system', '(unknown)') AS source, COUNT(*)::int AS count
        FROM ai_memory_deltas
        WHERE created_at >= $1::timestamptz
        GROUP BY source
        ORDER BY count DESC, source ASC
      `,
    }),
    queryRows<{ category: unknown; count: unknown }>(pool, {
      sql: `
        SELECT coalesce(category, '(uncategorized)') AS category, COUNT(*)::int AS count
        FROM ai_memory_entries
        WHERE status = 'active'
        GROUP BY category
        ORDER BY count DESC, category ASC
      `,
    }),
    querySingle<{
      context_needed_non_empty: unknown;
      env_model_present: unknown;
      next_actions_non_empty: unknown;
      open_questions_non_empty: unknown;
      snapshots: unknown;
      state_model_present: unknown;
    }>(pool, {
      params: [windowStartIso],
      sql: `
        SELECT
          COUNT(*)::int AS snapshots,
          COUNT(*) FILTER (
            WHERE jsonb_typeof(snapshot_json -> 'next_actions') = 'array'
              AND jsonb_array_length(snapshot_json -> 'next_actions') > 0
          )::int AS next_actions_non_empty,
          COUNT(*) FILTER (
            WHERE jsonb_typeof(snapshot_json -> 'open_questions') = 'array'
              AND jsonb_array_length(snapshot_json -> 'open_questions') > 0
          )::int AS open_questions_non_empty,
          COUNT(*) FILTER (
            WHERE jsonb_typeof(snapshot_json -> 'context_needed') = 'array'
              AND jsonb_array_length(snapshot_json -> 'context_needed') > 0
          )::int AS context_needed_non_empty,
          COUNT(*) FILTER (
            WHERE snapshot_json ? 'x_state_model'
          )::int AS state_model_present,
          COUNT(*) FILTER (
            WHERE snapshot_json ? 'x_env_model'
          )::int AS env_model_present
        FROM ai_session_snapshots
        WHERE created_at >= $1::timestamptz
      `,
    }),
    // Snapshot continuity adoption broken down by source channel.
    // Joining `ai_session_snapshots` to `ai_memory_deltas` via `source_delta_id` lets us
    // classify each snapshot as `flush` (explicit memory_flush) or `auto` (codex-hook,
    // claude-session-end, codex-launchd, codex-wrapper, etc.) using the persisted
    // workflow.system value on the source delta. Snapshots whose delta join is missing
    // are reported under `unknown` so they remain accountable.
    queryRows<{
      channel: unknown;
      context_needed_carried_forward: unknown;
      context_needed_derived: unknown;
      context_needed_non_empty: unknown;
      env_model_present: unknown;
      next_actions_carried_forward: unknown;
      next_actions_derived: unknown;
      next_actions_non_empty: unknown;
      open_questions_carried_forward: unknown;
      open_questions_derived: unknown;
      open_questions_non_empty: unknown;
      snapshots: unknown;
      state_model_present: unknown;
    }>(pool, {
      params: [windowStartIso],
      sql: `
        WITH snapshot_channels AS (
          SELECT
            CASE
              WHEN d.raw_json IS NULL THEN 'unknown'
              WHEN coalesce(d.raw_json->'workflow'->>'system', '') IN ('memory-flush', 'manual', 'manual-flush') THEN 'flush'
              ELSE 'auto'
            END AS channel,
            s.snapshot_json
          FROM ai_session_snapshots s
          LEFT JOIN ai_memory_deltas d ON d.delta_id = s.source_delta_id
          WHERE s.created_at >= $1::timestamptz
        )
        SELECT
          channel,
          COUNT(*)::int AS snapshots,
          COUNT(*) FILTER (
            WHERE jsonb_typeof(snapshot_json -> 'next_actions') = 'array'
              AND jsonb_array_length(snapshot_json -> 'next_actions') > 0
          )::int AS next_actions_non_empty,
          COUNT(*) FILTER (
            WHERE jsonb_typeof(snapshot_json -> 'open_questions') = 'array'
              AND jsonb_array_length(snapshot_json -> 'open_questions') > 0
          )::int AS open_questions_non_empty,
          COUNT(*) FILTER (
            WHERE jsonb_typeof(snapshot_json -> 'context_needed') = 'array'
              AND jsonb_array_length(snapshot_json -> 'context_needed') > 0
          )::int AS context_needed_non_empty,
          COUNT(*) FILTER (
            WHERE jsonb_typeof(snapshot_json -> 'next_actions') = 'array'
              AND jsonb_array_length(snapshot_json -> 'next_actions') > 0
              AND snapshot_json ->> 'x_next_actions_provenance' = 'derived'
          )::int AS next_actions_derived,
          COUNT(*) FILTER (
            WHERE jsonb_typeof(snapshot_json -> 'open_questions') = 'array'
              AND jsonb_array_length(snapshot_json -> 'open_questions') > 0
              AND snapshot_json ->> 'x_open_questions_provenance' = 'derived'
          )::int AS open_questions_derived,
          COUNT(*) FILTER (
            WHERE jsonb_typeof(snapshot_json -> 'context_needed') = 'array'
              AND jsonb_array_length(snapshot_json -> 'context_needed') > 0
              AND snapshot_json ->> 'x_context_needed_provenance' = 'derived'
          )::int AS context_needed_derived,
          COUNT(*) FILTER (
            WHERE jsonb_typeof(snapshot_json -> 'next_actions') = 'array'
              AND jsonb_array_length(snapshot_json -> 'next_actions') > 0
              AND snapshot_json ->> 'x_next_actions_provenance' = 'carry-forward'
          )::int AS next_actions_carried_forward,
          COUNT(*) FILTER (
            WHERE jsonb_typeof(snapshot_json -> 'open_questions') = 'array'
              AND jsonb_array_length(snapshot_json -> 'open_questions') > 0
              AND snapshot_json ->> 'x_open_questions_provenance' = 'carry-forward'
          )::int AS open_questions_carried_forward,
          COUNT(*) FILTER (
            WHERE jsonb_typeof(snapshot_json -> 'context_needed') = 'array'
              AND jsonb_array_length(snapshot_json -> 'context_needed') > 0
              AND snapshot_json ->> 'x_context_needed_provenance' = 'carry-forward'
          )::int AS context_needed_carried_forward,
          COUNT(*) FILTER (
            WHERE snapshot_json ? 'x_state_model'
          )::int AS state_model_present,
          COUNT(*) FILTER (
            WHERE snapshot_json ? 'x_env_model'
          )::int AS env_model_present
        FROM snapshot_channels
        GROUP BY channel
      `,
    }),
    querySingle<{
      packs_with_actionable_fields: unknown;
      packs_with_context_needed: unknown;
      packs_with_decisions: unknown;
      packs_with_next_actions: unknown;
      packs_with_open_questions: unknown;
      total_packs_for_field_completeness: unknown;
    }>(pool, {
      sql: `
        WITH pack_field_flags AS (
          SELECT
            CASE
              WHEN jsonb_typeof(pack_json -> 'nextActions') = 'array'
                AND jsonb_array_length(pack_json -> 'nextActions') > 0
                THEN 1
              ELSE 0
            END AS next_actions_present,
            CASE
              WHEN jsonb_typeof(pack_json -> 'openQuestions') = 'array'
                AND jsonb_array_length(pack_json -> 'openQuestions') > 0
                THEN 1
              ELSE 0
            END AS open_questions_present,
            CASE
              WHEN jsonb_typeof(pack_json -> 'decisions') = 'array'
                AND jsonb_array_length(pack_json -> 'decisions') > 0
                THEN 1
              ELSE 0
            END AS decisions_present,
            CASE
              WHEN jsonb_typeof(pack_json -> 'contextNeeded') = 'array'
                AND jsonb_array_length(pack_json -> 'contextNeeded') > 0
                THEN 1
              ELSE 0
            END AS context_needed_present
          FROM ai_continuity_packs
        )
        SELECT
          COUNT(*)::int AS total_packs_for_field_completeness,
          COALESCE(SUM(next_actions_present), 0)::int AS packs_with_next_actions,
          COALESCE(SUM(open_questions_present), 0)::int AS packs_with_open_questions,
          COALESCE(SUM(decisions_present), 0)::int AS packs_with_decisions,
          COALESCE(SUM(context_needed_present), 0)::int AS packs_with_context_needed,
          COALESCE(SUM(
            CASE
              WHEN next_actions_present = 1
                OR open_questions_present = 1
                OR decisions_present = 1
                OR context_needed_present = 1
                THEN 1
              ELSE 0
            END
          ), 0)::int AS packs_with_actionable_fields
        FROM pack_field_flags
      `,
    }),
    querySingle<{
      pack_degraded_reads: unknown;
      pack_found_reads: unknown;
      pack_missing_reads: unknown;
      pack_read_calls: unknown;
      sessions_with_flush_after_pack: unknown;
      sessions_with_pack_read: unknown;
    }>(pool, {
      params: [windowStartIso, windowEndIso],
      sql: `
        WITH raw_pack_reads AS (
          SELECT
            session_id,
            created_at,
            LOWER(
              COALESCE(
                NULLIF(response_status, ''),
                NULLIF(summary_json ->> 'response_status', ''),
                NULLIF(summary_json ->> 'continuity_pack_status', ''),
                NULLIF(status, ''),
                ''
              )
            ) AS read_status
          FROM ai_tool_invocations
          WHERE tool_name = 'memory_continuity_pack'
            AND created_at >= $1::timestamptz
            AND created_at <= $2::timestamptz
        ),
        pack_read_totals AS (
          SELECT
            COUNT(*)::int AS pack_read_calls,
            COUNT(*) FILTER (WHERE read_status = 'found')::int AS pack_found_reads,
            COUNT(*) FILTER (WHERE read_status = 'missing')::int AS pack_missing_reads,
            COUNT(*) FILTER (WHERE read_status IN ('degraded', 'error'))::int AS pack_degraded_reads
          FROM raw_pack_reads
        ),
        session_pack_reads AS (
          SELECT
            session_id,
            MIN(created_at) AS first_pack_read_at
          FROM raw_pack_reads
          WHERE session_id IS NOT NULL
          GROUP BY session_id
        ),
        flush_sessions AS (
          SELECT DISTINCT session_pack_reads.session_id
          FROM session_pack_reads
          JOIN ai_tool_invocations flush_invocation
            ON flush_invocation.session_id = session_pack_reads.session_id
            AND flush_invocation.tool_name = 'memory_flush'
            AND flush_invocation.created_at > session_pack_reads.first_pack_read_at
            AND flush_invocation.created_at <= $2::timestamptz
        ),
        flush_after_sessions AS (
          SELECT
            COUNT(session_pack_reads.session_id)::int AS sessions_with_pack_read,
            COUNT(flush_sessions.session_id)::int AS sessions_with_flush_after_pack
          FROM session_pack_reads
          LEFT JOIN flush_sessions
            ON flush_sessions.session_id = session_pack_reads.session_id
        )
        SELECT
          pack_read_totals.pack_read_calls,
          pack_read_totals.pack_found_reads,
          pack_read_totals.pack_missing_reads,
          pack_read_totals.pack_degraded_reads,
          flush_after_sessions.sessions_with_pack_read,
          flush_after_sessions.sessions_with_flush_after_pack
        FROM pack_read_totals
        CROSS JOIN flush_after_sessions
      `,
    }),
    querySingle<{
      agent_writer_compliant: unknown;
      agent_writer_flushes: unknown;
    }>(pool, {
      params: [windowStartIso],
      sql: `
        WITH memory_flush_invocations AS (
          SELECT
            LOWER(COALESCE(NULLIF(summary_json->>'detected_source', ''), NULLIF(summary_json->>'source', ''), '')) AS writer_source,
            COALESCE((summary_json->>'continuity_complete')::int, 0) AS continuity_complete
          FROM ai_tool_invocations
          WHERE tool_name = 'memory_flush'
            AND created_at >= $1::timestamptz
        ),
        agent_writer_invocations AS (
          SELECT continuity_complete
          FROM memory_flush_invocations
          WHERE writer_source IN ('agent', 'claude-code', 'codex')
            OR writer_source LIKE '%-builder'
            OR writer_source LIKE '%-reviewer'
            OR writer_source LIKE '%-retro'
        )
        SELECT
          COUNT(*)::int AS agent_writer_flushes,
          COUNT(*) FILTER (WHERE continuity_complete = 1)::int AS agent_writer_compliant
        FROM agent_writer_invocations
      `,
    }),
    queryRows<{ calibration_signal: unknown }>(pool, {
      params: [windowStartIso],
      sql: `
        SELECT metadata_json -> 'calibration_signal' AS calibration_signal
        FROM ai_memory_entries
        WHERE category = 'reflective'
          AND created_at >= $1::timestamptz
          AND metadata_json ->> 'calibration_signal' IS NOT NULL
      `,
    }),
    computeRepeatedFixRate(pool, DEFAULT_REPEATED_FIX_WINDOW_DAYS),
    computeDecisionReversalRate(pool, DEFAULT_DECISION_REVERSAL_WINDOW_DAYS),
    querySingle<{ actionable: unknown; resolved_count: unknown }>(pool, {
      params: [windowStartIso],
      sql: `
        SELECT
          COUNT(*) FILTER (WHERE resolved_at IS NULL)::int AS actionable,
          COUNT(*) FILTER (WHERE resolved_at IS NOT NULL)::int AS resolved_count
        FROM ai_ingestion_failures
        WHERE created_at >= $1::timestamptz
      `,
    }),
    querySingle<{ null_rows: unknown; total_rows: unknown }>(pool, {
      params: [windowStartIso],
      sql: `
        SELECT
          COUNT(*)::int AS total_rows,
          COUNT(*) FILTER (WHERE memory_type IS NULL)::int AS null_rows
        FROM ai_memory_entries
        WHERE created_at >= $1::timestamptz
      `,
    }),
    queryRows<ReflectCycleRow>(pool, {
      params: [windowStartIso, windowEndIso],
      sql: `
        SELECT memory_key, created_at::text AS created_at, metadata_json
        FROM ai_memory_entries
        WHERE category = 'methodology'
          AND status = 'active'
          AND memory_key LIKE '%:methodology:reflect:cycle-%'
          AND created_at >= $1::timestamptz
          AND created_at <= $2::timestamptz
        ORDER BY created_at DESC
      `,
    }),
    queryCount(pool, {
      params: [windowStartIso, windowEndIso],
      sql: `
        SELECT COUNT(*)::int AS value
        FROM ai_memory_entries
        WHERE category = 'methodology'
          AND status = 'active'
          AND tags @> ARRAY['provisional']::text[]
          AND created_at >= $1::timestamptz
          AND created_at <= $2::timestamptz
      `,
    }),
    queryRows<WriteCalibrationRow>(pool, {
      params: [windowStartIso, windowEndIso],
      sql: `
        WITH calibrated_writes AS (
          SELECT
            COALESCE(NULLIF(agent, ''), NULLIF(updated_by, ''), NULLIF(source, ''), 'unknown') AS author,
            category,
            COALESCE(declared_confidence, confidence)::double precision AS declared_confidence,
            COALESCE(calibrated_confidence, confidence)::double precision AS calibrated_confidence,
            status
          FROM ai_memory_entries
          WHERE created_at >= $1::timestamptz
            AND created_at <= $2::timestamptz
            AND declared_confidence IS NOT NULL
            AND calibrated_confidence IS NOT NULL
        )
        SELECT
          author,
          category,
          COUNT(*)::int AS memory_count,
          COUNT(*) FILTER (WHERE status IN ('superseded', 'contested-resolved-against'))::int AS reversal_count,
          AVG(declared_confidence)::double precision AS avg_declared_confidence,
          AVG(calibrated_confidence)::double precision AS avg_calibrated_confidence
        FROM calibrated_writes
        GROUP BY author, category
        ORDER BY (AVG(declared_confidence) - AVG(calibrated_confidence)) DESC, memory_count DESC, author ASC, category ASC
      `,
    }),
    queryRows<{ timed_out_steps: unknown }>(pool, {
      params: [windowStartIso, windowEndIso],
      sql: `
        SELECT summary_json->>'timed_out_steps' AS timed_out_steps
        FROM ai_tool_invocations
        WHERE created_at >= $1::timestamptz
          AND created_at <= $2::timestamptz
          AND summary_json ? 'timed_out_steps'
          AND COALESCE(summary_json->>'timed_out_steps', '') <> ''
      `,
    }),
  ]);

  const sessionEndConflictRate14d =
    sessionEndWrites14d === 0 ? 0 : Number(((sessionEndConflictMismatches14d / sessionEndWrites14d) * 100).toFixed(2));

  const writerMixRows = durableWritesBySource.map(row => ({
    count: toNumber(row.count),
    source: toText(row.source),
  }));
  const writerMixTotal = writerMixRows.reduce((sum, row) => sum + row.count, 0);
  const durableWriterMix = writerMixRows.map(row => ({
    count: row.count,
    pct: percent(row.count, writerMixTotal),
    source: row.source,
  }));

  const sourceMixRows = deltaChannelRows.map(row => ({
    count: toNumber(row.count),
    source: toText(row.source),
  }));
  const sourceMixTotal = sourceMixRows.reduce((sum, row) => sum + row.count, 0);
  const deltaSourceMix = sourceMixRows.map(row => ({
    count: row.count,
    pct: percent(row.count, sourceMixTotal),
    source: row.source,
  }));

  const writerParticipationHealth = evaluateWriterParticipation(durableWriterMix, writerMixTotal);
  const topFailureSignatures = buildTopFailureSignatures(failureSignatureRows);
  const topTimeoutOperations = buildTopTimeoutOperations({
    failureSignatureRows,
    toolInvocationTimedOutStepsRows,
  });

  const taxonomyDistribution = buildTaxonomyDistribution(
    categoryRows.map(row => ({
      category: toText(row.category),
      count: toNumber(row.count),
    })),
  );
  const calibrationSignals = calibrationRows
    .map(row => parseCalibrationSignal(row.calibration_signal))
    .filter((signal): signal is CalibrationSignal => signal !== null);
  const calibrationBrierScore = computeBrierScore(calibrationSignals);
  const calibrationECE = computeECE(calibrationSignals);

  const memoryTypeNullSampleCount = toNumber(memoryTypeNullRow.total_rows);
  const memoryTypeNullRawCount = toNumber(memoryTypeNullRow.null_rows);
  const memoryTypeNullRatePct = percent(memoryTypeNullRawCount, memoryTypeNullSampleCount);

  const continuitySnapshots = toNumber(continuityAdoption.snapshots);
  const continuityStateModelPresent = toNumber(continuityAdoption.state_model_present);
  const agentWriterFlushes = toNumber(continuityAgentWriterCompliance.agent_writer_flushes);
  const agentWriterCompliant = toNumber(continuityAgentWriterCompliance.agent_writer_compliant);

  const continuityByChannel = buildContinuityByChannel(continuityAdoptionByChannel);
  const totalPacksForFieldCompleteness = toNumber(continuityReadinessFields.total_packs_for_field_completeness);
  const packsWithNextActions = toNumber(continuityReadinessFields.packs_with_next_actions);
  const packsWithOpenQuestions = toNumber(continuityReadinessFields.packs_with_open_questions);
  const packsWithDecisions = toNumber(continuityReadinessFields.packs_with_decisions);
  const packsWithContextNeeded = toNumber(continuityReadinessFields.packs_with_context_needed);
  const actionableFieldsPopulated =
    packsWithNextActions + packsWithOpenQuestions + packsWithDecisions + packsWithContextNeeded;
  const actionableFieldSlots = totalPacksForFieldCompleteness * 4;

  return {
    actionableFailures: toNumber(resolutionCounts.actionable),
    calibration: {
      assessment: evaluateCalibrationAssessment(calibrationBrierScore, calibrationECE),
      brierScore: calibrationBrierScore,
      ece: calibrationECE,
      signalCount: calibrationSignals.length,
    },
    contextPacksIngested,
    continuityAdoption: {
      agentWriterCompliancePct: percent(agentWriterCompliant, agentWriterFlushes),
      agentWriterCompliant,
      agentWriterFlushes,
      auto: continuityByChannel.auto,
      contextNeededNonEmpty: toNumber(continuityAdoption.context_needed_non_empty),
      envModelPresent: toNumber(continuityAdoption.env_model_present),
      flush: continuityByChannel.flush,
      nextActionsNonEmpty: toNumber(continuityAdoption.next_actions_non_empty),
      openQuestionsNonEmpty: toNumber(continuityAdoption.open_questions_non_empty),
      snapshots: continuitySnapshots,
      stateModelPresent: continuityStateModelPresent,
      unknown: continuityByChannel.unknown,
    },
    continuityPacks: {
      avgPayloadChars: toNumber(continuityPackRow.avg_payload_chars),
      maxPayloadBudgetPct: toNumber(continuityPackRow.max_payload_budget_pct),
      maxPayloadChars: toNumber(continuityPackRow.max_payload_chars),
      packs: toNumber(continuityPackRow.packs),
      updatedInWindow: toNumber(continuityPackRow.updated_in_window),
    },
    continuityReadiness: {
      actionableFieldCompletenessPct: percent(actionableFieldsPopulated, actionableFieldSlots),
      actionableFieldSlots,
      actionableFieldsPopulated,
      packDegradedReads: toNumber(continuityReadinessReads.pack_degraded_reads),
      packFoundReads: toNumber(continuityReadinessReads.pack_found_reads),
      packMissingReads: toNumber(continuityReadinessReads.pack_missing_reads),
      packReadCalls: toNumber(continuityReadinessReads.pack_read_calls),
      packsWithActionableFields: toNumber(continuityReadinessFields.packs_with_actionable_fields),
      packsWithContextNeeded,
      packsWithDecisions,
      packsWithNextActions,
      packsWithOpenQuestions,
      sessionsWithFlushAfterPack: toNumber(continuityReadinessReads.sessions_with_flush_after_pack),
      sessionsWithPackRead: toNumber(continuityReadinessReads.sessions_with_pack_read),
      totalPacksForFieldCompleteness,
    },
    decisionReversalRate,
    deltasIngested,
    deltaSourceMix,
    durableMemoriesCreated,
    durableMemoriesUpdated,
    durableWriterMix,
    failuresBySource: failuresBySource.map(row => ({
      count: toNumber(row.count),
      source: toText(row.source),
    })),
    failuresByStage: failuresByStage.map(row => ({
      count: toNumber(row.count),
      stage: toText(row.stage),
    })),
    failureWindows: {
      active: {
        end: windowEndIso,
        resolved: toNumber(activeFailureCounts.resolved),
        sources: activeFailuresBySource.map(row => ({
          count: toNumber(row.count),
          source: toText(row.source),
        })),
        start: activeWindowEffectiveStartIso,
        total: toNumber(activeFailureCounts.total),
        unresolved: toNumber(activeFailureCounts.unresolved),
      },
      historical: {
        end: historicalWindowEndIso,
        resolved: toNumber(historicalFailureCounts.resolved),
        sources: historicalFailuresBySource.map(row => ({
          count: toNumber(row.count),
          source: toText(row.source),
        })),
        start: historicalWindowStartIso,
        total: toNumber(historicalFailureCounts.total),
        unresolved: toNumber(historicalFailureCounts.unresolved),
      },
    },
    ingestionFailures,
    memoryTypeNullRatePct,
    memoryTypeNullSampleCount,
    mttr: {
      avgMinutes: toNumber(mttr.avg_mttr_minutes),
      resolved: toNumber(mttr.resolved),
      total: toNumber(mttr.total),
      unresolved: toNumber(mttr.unresolved),
    },
    reflect: buildReflectMetricsFromRows(reflectCycleRows, provisionalMethodologyMemoriesWritten),
    repeatedFixRate,
    resolvedFailures: toNumber(resolutionCounts.resolved_count),
    sessionEndConflictRate14d: {
      conflictCount: sessionEndConflictMismatches14d,
      ratePct: sessionEndConflictRate14d,
      targetMet: sessionEndConflictRate14d < EVENT_CONFLICT_TARGET_PCT,
      targetPct: EVENT_CONFLICT_TARGET_PCT,
      windowDays: SESSION_END_CONFLICT_WINDOW_DAYS,
      writeCount: sessionEndWrites14d,
    },
    sessionsStarted,
    stateModelAdoptionPct: percent(continuityStateModelPresent, continuitySnapshots),
    taxonomyDistribution,
    topFailureSignatures,
    topTimeoutOperations,
    writeCalibration: buildWriteCalibrationMetricsFromRows(writeCalibrationRows),
    writerParticipationHealth,
  };
}

export async function collectMcpUsageMetrics({
  logFile,
  logFileSource,
  pool,
  windowEndIso,
  windowStartMs,
}: {
  logFile: string;
  logFileSource: ResolvedLogPath['source'];
  pool: Pool;
  windowEndIso: string;
  windowStartMs: number;
}): Promise<McpUsageMetrics> {
  const windowStartIso = new Date(windowStartMs).toISOString();
  try {
    const dbRows = await queryToolInvocations({
      dbPool: pool as unknown as PgPool,
      windowEndIso,
      windowStartIso,
    });
    return buildMcpUsageMetricsFromRows(dbRows, {
      logFile,
      logFileSource,
      telemetrySource: 'db',
    });
  } catch (error) {
    return {
      ...emptyMcpUsageMetrics({
        logFile,
        logFileSource,
        telemetrySource: 'unavailable',
      }),
      telemetryError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function collectOrchestrationMetrics({
  retrosDir,
  transcriptsDir,
  windowStartMs,
}: {
  retrosDir: string;
  transcriptsDir: string;
  windowStartMs: number;
}): OrchestrationMetrics {
  const transcriptFiles = listJsonFiles(transcriptsDir);
  let approved = 0;
  let error = 0;
  let notApproved = 0;
  let rounds = 0;
  let runs = 0;
  let totalTokens = 0;

  for (const filePath of transcriptFiles) {
    const parsed = readJson(filePath);
    if (!isRecord(parsed)) {
      continue;
    }

    const startedAt = parseTimestampMs(parsed.startedAt);
    if (startedAt === null || startedAt < windowStartMs) {
      continue;
    }

    runs += 1;
    const outcome = toText(parsed.outcome);
    if (outcome === 'approved') {
      approved += 1;
    } else if (outcome === 'error') {
      error += 1;
    } else {
      notApproved += 1;
    }

    if (isRecord(parsed.totals)) {
      rounds += toNumber(parsed.totals.rounds);
      if (isRecord(parsed.totals.tokenUsage)) {
        totalTokens += toNumber(parsed.totals.tokenUsage.total);
      }
    }
  }

  const retroFiles = listFilesByMtime(retrosDir, windowStartMs);
  const insightFiles = retroFiles.filter(filePath => filePath.endsWith('-insights.json')).length;
  const issueSeedFiles = retroFiles.filter(filePath => filePath.endsWith('-issues.json')).length;
  const retroMarkdownFiles = retroFiles.filter(filePath => extname(filePath) === '.md').length;

  return {
    approvalRatePct: percent(approved, runs),
    approved,
    avgRoundsPerRun: runs === 0 ? 0 : Number((rounds / runs).toFixed(2)),
    error,
    insightFiles,
    issueSeedFiles,
    notApproved,
    retroDirectory: retrosDir,
    retroMarkdownFiles,
    runs,
    totalTokens,
    transcriptDirectory: transcriptsDir,
  };
}

export async function collectRetentionMetrics({
  logFile,
  pool: dbPool,
}: {
  logFile: string;
  pool: Pool;
}): Promise<RetentionMetrics> {
  const config = resolveRetentionConfig();

  const backlogQueries: {
    condition: string;
    dataset: string;
    table: string;
    timeColumn?: string;
  }[] = [
    {
      condition: `created_at < NOW() - INTERVAL '${String(config.failureDays)} days'`,
      dataset: 'ai_ingestion_failures',
      table: 'ai_ingestion_failures',
    },
    {
      condition: `category = 'session-summary' AND expires_at IS NOT NULL AND expires_at <= NOW() - INTERVAL '${String(config.expiredGraceDays)} days'`,
      dataset: 'ai_memory_entries (expired session-summaries)',
      table: 'ai_memory_entries',
      timeColumn: 'expires_at',
    },
    {
      condition: `status IN ('superseded', 'archived') AND updated_at < NOW() - INTERVAL '${String(config.supersededDays)} days'`,
      dataset: 'ai_memory_entries (retired durable)',
      table: 'ai_memory_entries',
      timeColumn: 'updated_at',
    },
    {
      condition: `started_at < NOW() - INTERVAL '${String(config.sessionDays)} days'`,
      dataset: 'ai_sessions',
      table: 'ai_sessions',
      timeColumn: 'started_at',
    },
    {
      condition: `created_at < NOW() - INTERVAL '${String(config.sessionDays)} days'`,
      dataset: 'ai_context_packs',
      table: 'ai_context_packs',
    },
    {
      condition: `created_at < NOW() - INTERVAL '${String(config.sessionDays)} days'`,
      dataset: 'ai_memory_deltas',
      table: 'ai_memory_deltas',
    },
    {
      condition: `NOT EXISTS (SELECT 1 FROM ai_memory_entries m WHERE m.id = ai_memory_events.memory_id) AND created_at < NOW() - INTERVAL '${String(config.auditDays)} days'`,
      dataset: 'ai_memory_events (orphaned)',
      table: 'ai_memory_events',
    },
    {
      condition: `created_at < NOW() - INTERVAL '${String(config.telemetryDays)} days'`,
      dataset: 'ai_tool_invocations',
      table: 'ai_tool_invocations',
    },
  ];

  const backlog: RetentionBacklogEntry[] = await Promise.all(
    backlogQueries.map(async ({ condition, dataset, table, timeColumn }) => {
      const countSql = `SELECT COUNT(*)::int AS cnt FROM ${table} WHERE ${condition}`;
      const countResult = await dbPool.query<{ cnt: unknown }>(countSql);
      const candidates = toNumber(countResult.rows[0]?.cnt);

      if (candidates === 0) {
        return { candidates: 0, dataset };
      }

      const col = timeColumn ?? 'created_at';
      const boundsSql = `SELECT MIN(${col})::text AS oldest, MAX(${col})::text AS newest FROM ${table} WHERE ${condition}`;
      const boundsResult = await dbPool.query<{
        newest: unknown;
        oldest: unknown;
      }>(boundsSql);
      const oldest = boundsResult.rows[0]?.oldest;
      const newest = boundsResult.rows[0]?.newest;

      return {
        candidates,
        dataset,
        newestCreatedAt: typeof newest === 'string' ? newest : undefined,
        oldestCreatedAt: typeof oldest === 'string' ? oldest : undefined,
      };
    }),
  );

  const totalBacklog = backlog.reduce((sum, entry) => sum + entry.candidates, 0);
  const lastRun = parseLastRetentionRun(logFile);

  return {
    backlog,
    config: {
      auditDays: config.auditDays,
      batchSize: config.batchSize,
      expiredGraceDays: config.expiredGraceDays,
      failureDays: config.failureDays,
      sessionDays: config.sessionDays,
      supersededDays: config.supersededDays,
      telemetryDays: config.telemetryDays,
    },
    lastRun,
    totalBacklog,
  };
}

export function computeBrierScore(signals: CalibrationSignal[]): null | number {
  if (signals.length < DEFAULT_CALIBRATION_MIN_SIGNALS) {
    return null;
  }

  const total = signals.reduce((sum, signal) => {
    const difference = signal.predictedProbability - signal.actualOutcome;
    return sum + difference ** 2;
  }, 0);

  return Number((total / signals.length).toFixed(4));
}

export async function computeConsolidationMetrics({
  pool,
  windowEndIso,
  windowStartIso,
}: {
  pool: Pool;
  windowEndIso: string;
  windowStartIso: string;
}): Promise<ConsolidationMetrics> {
  const rows = await queryRows<ConsolidationEventRow>(pool, {
    params: [windowStartIso, windowEndIso],
    sql: `
      SELECT created_at::text AS created_at, payload_json
      FROM ai_session_events
      WHERE event_type = 'consolidation_metrics'
        AND created_at >= $1::timestamptz
        AND created_at <= $2::timestamptz
      ORDER BY created_at ASC
    `,
  });

  const totals = createEmptyConsolidationTotals();
  const dailyByDate = new Map<string, ConsolidationDailyAccumulator>();
  const dedupedKeyCounts = new Map<string, number>();

  for (const row of rows) {
    const createdAtMs = parseTimestampMs(row.created_at);
    const payload = parseJsonObject(row.payload_json);
    if (createdAtMs === null || payload === null) {
      continue;
    }

    const date = new Date(createdAtMs).toISOString().slice(0, 10);
    const daily = getDailyConsolidationAccumulator(dailyByDate, date);
    const actions = parseConsolidationActionCounts(payload.actions);
    const latencyMs = toNumber(payload.latency_ms);
    const pairsExamined = toNumber(payload.pairs_examined);
    const pairsClassified = toNumber(payload.pairs_classified);
    const contradictionsFlagged = toNumber(payload.contradictions_flagged);

    addConsolidationCounts(totals, {
      contradictionsFlagged,
      dedupes: actions.dedupes,
      none: actions.none,
      pairsClassified,
      pairsExamined,
      refines: actions.refines,
      sessions: 1,
      supersedes: actions.supersedes,
    });
    addConsolidationCounts(daily, {
      contradictionsFlagged,
      dedupes: actions.dedupes,
      none: actions.none,
      pairsClassified,
      pairsExamined,
      refines: actions.refines,
      sessions: 1,
      supersedes: actions.supersedes,
    });
    daily.latencyTotalMs += latencyMs;
    daily.avgLatencyMs = daily.sessions > 0 ? Math.round(daily.latencyTotalMs / daily.sessions) : 0;

    collectDedupedMemoryKeys(payload.outcomes, dedupedKeyCounts);
  }

  const daily = [...dailyByDate.values()]
    .map(metric => ({
      avgLatencyMs: metric.avgLatencyMs,
      contradictionsFlagged: metric.contradictionsFlagged,
      date: metric.date,
      dedupes: metric.dedupes,
      none: metric.none,
      pairsClassified: metric.pairsClassified,
      pairsExamined: metric.pairsExamined,
      refines: metric.refines,
      sessions: metric.sessions,
      supersedes: metric.supersedes,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const topDedupedMemoryKeys: ConsolidationTopMemoryKeyMetric[] = [...dedupedKeyCounts.entries()]
    .map(([memoryKey, count]) => ({ count, memoryKey }))
    .sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      return a.memoryKey.localeCompare(b.memoryKey);
    })
    .slice(0, 10);

  return {
    contradictionRatePct: percent(totals.contradictionsFlagged, totals.pairsClassified),
    daily,
    noActionRatePct: percent(totals.none, totals.pairsClassified),
    topDedupedMemoryKeys,
    totals,
  };
}

export async function computeDecisionReversalRate(
  pool: Pool,
  windowDays = DEFAULT_DECISION_REVERSAL_WINDOW_DAYS,
): Promise<DecisionReversalMetric> {
  const [count, denominator, reversalRows, denominatorRows] = await Promise.all([
    queryCount(pool, {
      params: [windowDays, DECISION_REVERSAL_CATEGORIES],
      sql: `
        SELECT COUNT(*)::int AS value
        FROM ai_memory_entries current_entry
        INNER JOIN ai_memory_entries superseded_entry
          ON superseded_entry.id = current_entry.supersedes_id
        WHERE current_entry.supersedes_id IS NOT NULL
          AND current_entry.category = ANY($2::text[])
          AND superseded_entry.created_at >= NOW() - ($1::int * INTERVAL '1 day')
      `,
    }),
    queryCount(pool, {
      params: [windowDays, DECISION_REVERSAL_CATEGORIES],
      sql: `
        SELECT COUNT(*)::int AS value
        FROM ai_memory_entries
        WHERE status = 'active'
          AND category = ANY($2::text[])
          AND created_at >= NOW() - ($1::int * INTERVAL '1 day')
      `,
    }),
    queryRows<{ category: unknown; count: unknown }>(pool, {
      params: [windowDays, DECISION_REVERSAL_CATEGORIES],
      sql: `
        SELECT current_entry.category, COUNT(*)::int AS count
        FROM ai_memory_entries current_entry
        INNER JOIN ai_memory_entries superseded_entry
          ON superseded_entry.id = current_entry.supersedes_id
        WHERE current_entry.supersedes_id IS NOT NULL
          AND current_entry.category = ANY($2::text[])
          AND superseded_entry.created_at >= NOW() - ($1::int * INTERVAL '1 day')
        GROUP BY current_entry.category
      `,
    }),
    queryRows<{ category: unknown; count: unknown }>(pool, {
      params: [windowDays, DECISION_REVERSAL_CATEGORIES],
      sql: `
        SELECT category, COUNT(*)::int AS count
        FROM ai_memory_entries
        WHERE status = 'active'
          AND category = ANY($2::text[])
          AND created_at >= NOW() - ($1::int * INTERVAL '1 day')
        GROUP BY category
      `,
    }),
  ]);

  const reversalByCategory = new Map<TrackedDecisionCategory, number>();
  for (const row of reversalRows) {
    const category = toTrackedDecisionCategory(row.category);
    if (category === null) {
      continue;
    }
    reversalByCategory.set(category, toNumber(row.count));
  }

  const denominatorByCategory = new Map<TrackedDecisionCategory, number>();
  for (const row of denominatorRows) {
    const category = toTrackedDecisionCategory(row.category);
    if (category === null) {
      continue;
    }
    denominatorByCategory.set(category, toNumber(row.count));
  }

  const byCategory = DECISION_REVERSAL_CATEGORIES.map(category => {
    const categoryCount = reversalByCategory.get(category) ?? 0;
    const categoryDenominator = denominatorByCategory.get(category) ?? 0;
    return {
      category,
      count: categoryCount,
      denominator: categoryDenominator,
      rate: categoryDenominator === 0 ? 0 : Number((categoryCount / categoryDenominator).toFixed(4)),
    };
  });

  return {
    byCategory,
    count,
    denominator,
    rate: denominator === 0 ? 0 : Number((count / denominator).toFixed(4)),
  };
}

export function computeECE(signals: CalibrationSignal[]): ECEResult | null {
  if (signals.length < DEFAULT_CALIBRATION_MIN_SIGNALS) {
    return null;
  }

  const bins = CALIBRATION_BINS.map(bin => {
    const binSignals = signals.filter(
      signal => signal.predictedProbability >= bin.min && signal.predictedProbability < bin.max,
    );
    const count = binSignals.length;
    const avgPredicted =
      count === 0
        ? 0
        : Number((binSignals.reduce((sum, signal) => sum + signal.predictedProbability, 0) / count).toFixed(4));
    const avgActual =
      count === 0 ? 0 : Number((binSignals.reduce((sum, signal) => sum + signal.actualOutcome, 0) / count).toFixed(4));
    const error = count === 0 ? 0 : Number((Math.abs(avgPredicted - avgActual) * (count / signals.length)).toFixed(4));

    return {
      avgActual,
      avgPredicted,
      count,
      error,
      range: bin.range,
    };
  });

  const ece = Number(bins.reduce((sum, bin) => sum + bin.error, 0).toFixed(4));
  return {
    bins,
    ece,
  };
}

export async function computeRepeatedFixRate(
  pool: Pool,
  windowDays = DEFAULT_REPEATED_FIX_WINDOW_DAYS,
): Promise<RepeatedFixMetric[]> {
  const rows = await queryRows<{ evidence_refs: unknown; id: unknown }>(pool, {
    params: [windowDays],
    sql: `
      SELECT id, evidence_refs
      FROM ai_memory_entries
      WHERE category = 'root-cause'
        AND status = 'active'
        AND created_at >= NOW() - ($1::int * INTERVAL '1 day')
    `,
  });

  const moduleToMemoryIds = new Map<string, Set<number>>();
  for (const row of rows) {
    const memoryId = toNumber(row.id);
    if (!Number.isInteger(memoryId) || memoryId <= 0) {
      continue;
    }

    const modulePathsForMemory = new Set<string>();
    for (const ref of parseEvidenceRefs(row.evidence_refs)) {
      const modulePath = extractModulePath(ref);
      if (modulePath !== null) {
        modulePathsForMemory.add(modulePath);
      }
    }

    for (const modulePath of modulePathsForMemory) {
      const memoryIds = moduleToMemoryIds.get(modulePath) ?? new Set<number>();
      memoryIds.add(memoryId);
      moduleToMemoryIds.set(modulePath, memoryIds);
    }
  }

  return [...moduleToMemoryIds.entries()]
    .map(([module, memoryIds]) => ({
      count: memoryIds.size,
      memoryIds: [...memoryIds].sort((a, b) => a - b),
      module,
    }))
    .filter(metric => metric.count >= 3)
    .sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      return a.module.localeCompare(b.module);
    });
}

export async function computeUsefulnessMetrics({
  pool,
  windowEndIso,
  windowStartIso,
}: {
  pool: Pool;
  windowEndIso: string;
  windowStartIso: string;
}): Promise<UsefulnessMetrics> {
  const writeWindowMs = USEFULNESS_RESUME_WRITE_WINDOW_MINUTES * 60 * 1_000;
  const windowEndMs = Date.parse(windowEndIso);
  const primaryWindowStartMs = Date.parse(windowStartIso);
  const safeWindowEndMs = Number.isNaN(windowEndMs) ? Date.now() : windowEndMs;
  const safePrimaryWindowStartMs = Number.isNaN(primaryWindowStartMs)
    ? safeWindowEndMs - 7 * DAY_MS
    : primaryWindowStartMs;
  const sevenDayStartMs = safeWindowEndMs - 7 * DAY_MS;
  const thirtyDayStartMs = safeWindowEndMs - 30 * DAY_MS;
  const queryWindowStartIso = new Date(Math.min(safePrimaryWindowStartMs, thirtyDayStartMs)).toISOString();

  const [toolRows, snapshotRows] = await Promise.all([
    queryToolInvocations({ dbPool: pool as unknown as PgPool, windowEndIso, windowStartIso: queryWindowStartIso }),
    // Include session_id so we can look up the exact resumed session's snapshot (F2 fix)
    queryRows<{
      created_at: unknown;
      session_id: unknown;
      snapshot_json: unknown;
    }>(pool, {
      params: [windowEndIso],
      sql: `
        SELECT session_id, created_at::text AS created_at, snapshot_json
        FROM ai_session_snapshots
        WHERE session_id IS NOT NULL
          AND created_at <= $1::timestamptz
        ORDER BY session_id, created_at DESC
      `,
    }),
  ]);

  // Build snapshot index: resumed-session-id -> snapshots sorted newest-first.
  // memory_session_resume records the RESUMED session's id in ai_tool_invocations.session_id,
  // so we key by that id to retrieve the exact snapshot the resume call loaded (F2 fix).
  const snapshotsBySessionId = new Map<string, { continuityScore: number; createdAtMs: number }[]>();
  for (const row of snapshotRows) {
    const sessionId = toText(row.session_id);
    const createdAtMs = parseTimestampMs(row.created_at);
    if (sessionId.length === 0 || createdAtMs === null) {
      continue;
    }
    const snapJson = parseJsonObject(row.snapshot_json);
    const score = computeSnapshotContinuityScore(snapJson);
    const list = snapshotsBySessionId.get(sessionId) ?? [];
    list.push({ continuityScore: score, createdAtMs });
    snapshotsBySessionId.set(sessionId, list);
  }

  // Build write index: project -> write events sorted oldest-first.
  // We use project+time attribution instead of session_id because:
  //   - memory_store.sessionId is optional and often null (F3 fix)
  //   - the resume row's session_id is the OLD resumed session, not the current session (F1 fix)
  const writesByProject = new Map<string, { createdAtMs: number; isRootCauseStore: boolean }[]>();
  for (const row of toolRows) {
    const proj = row.project;
    if (!proj || (row.tool_name !== 'memory_store' && row.tool_name !== 'memory_flush')) {
      continue;
    }
    const createdAtMs = parseTimestampMs(row.created_at);
    if (createdAtMs === null) {
      continue;
    }
    const isRootCauseStore = row.tool_name === 'memory_store' && row.memory_category === 'root-cause';
    const list = writesByProject.get(proj) ?? [];
    list.push({ createdAtMs, isRootCauseStore });
    writesByProject.set(proj, list);
  }
  for (const [, writes] of writesByProject) {
    writes.sort((a, b) => a.createdAtMs - b.createdAtMs);
  }

  // First pass: collect qualifying resume events (those that have a prior snapshot).
  // We defer building the exclusivity index until qualification is known so that only
  // qualifying resumes can block writes from earlier qualifying resumes. An unqualified
  // resume cannot claim writes for itself and must not suppress writes for others (F2 fix).
  const candidateResumeRows = toolRows.filter(
    r => r.tool_name === 'memory_session_resume' && r.status === 'ok' && r.session_id && r.project,
  );
  const qualifyingResumeEntries: {
    proj: string;
    resumeAtMs: number;
    score: number;
  }[] = [];
  for (const resume of candidateResumeRows) {
    const sid = resume.session_id; // the RESUMED (prior) session id
    const proj = resume.project;
    if (!sid || !proj) continue;

    const resumeAtMs = parseTimestampMs(resume.created_at);
    if (resumeAtMs === null) continue;

    // Look up the exact resumed session's snapshots (newest-first) and find the one
    // that predates this resume call — this is the continuity data the agent received (F2 fix).
    const sessionSnaps = snapshotsBySessionId.get(sid) ?? [];
    const priorSnapshot = sessionSnaps.find(s => s.createdAtMs < resumeAtMs);
    if (priorSnapshot === undefined) continue;

    qualifyingResumeEntries.push({
      proj,
      resumeAtMs,
      score: priorSnapshot.continuityScore,
    });
  }

  // Build exclusivity index from qualifying resumes only.
  // Unqualified resumes (no prior snapshot) are excluded so they cannot falsely suppress
  // writes from an earlier valid resume via the closer-resume guard.
  const resumeTimesByProject = new Map<string, number[]>();
  for (const { proj, resumeAtMs } of qualifyingResumeEntries) {
    const list = resumeTimesByProject.get(proj) ?? [];
    list.push(resumeAtMs);
    resumeTimesByProject.set(proj, list);
  }

  // Second pass: attribute writes to qualifying resumes
  const primaryResumeEntries = qualifyingResumeEntries.filter(
    entry => entry.resumeAtMs >= safePrimaryWindowStartMs && entry.resumeAtMs <= safeWindowEndMs,
  );
  const qualifyingSessions7d = qualifyingResumeEntries.filter(
    entry => entry.resumeAtMs >= sevenDayStartMs && entry.resumeAtMs <= safeWindowEndMs,
  ).length;
  const qualifyingSessions30d = qualifyingResumeEntries.filter(
    entry => entry.resumeAtMs >= thirtyDayStartMs && entry.resumeAtMs <= safeWindowEndMs,
  ).length;
  const allLatencies: number[] = [];
  const sparseLatencies: number[] = [];
  const richLatencies: number[] = [];
  let qualifyingSessions = 0;
  let sparseSessions = 0;
  let richSessions = 0;
  let sparseRepeatedFixes = 0;
  let richRepeatedFixes = 0;

  for (const { proj, resumeAtMs, score } of primaryResumeEntries) {
    qualifyingSessions += 1;

    // Find post-resume writes for this project within the write window (project+time attribution).
    // This handles null-session writes and correlates correctly since resume.session_id is the OLD
    // session, not the current caller's session id.
    //
    // Exclusivity guard (F2): only attribute a write to this resume if no other qualifying resume
    // for the same project occurred between this resume and the write. This prevents two overlapping
    // qualifying resumes on the same project from both claiming the same write.
    const projectWrites = writesByProject.get(proj) ?? [];
    const projectResumeTimes = resumeTimesByProject.get(proj) ?? [];
    const windowWrites = projectWrites.filter(w => {
      if (w.createdAtMs <= resumeAtMs || w.createdAtMs > resumeAtMs + writeWindowMs) return false;
      // Reject if a more-recent qualifying resume preceded this write (closer-resume guard)
      return !projectResumeTimes.some(t => t > resumeAtMs && t < w.createdAtMs);
    });
    const firstWrite = windowWrites[0]; // oldest-first, so index 0 is first post-resume write
    const latencyMs = firstWrite !== undefined ? firstWrite.createdAtMs - resumeAtMs : null;
    if (latencyMs !== null) {
      allLatencies.push(latencyMs);
    }

    // Count root-cause stores within the post-resume window (F4 fix: windowWrites already
    // filtered to createdAtMs > resumeAtMs, so pre-resume stores are excluded).
    const rootCauseStores = windowWrites.filter(w => w.isRootCauseStore).length;

    if (score <= 1) {
      sparseSessions += 1;
      sparseRepeatedFixes += rootCauseStores;
      if (latencyMs !== null) {
        sparseLatencies.push(latencyMs);
      }
    } else if (score >= 3) {
      richSessions += 1;
      richRepeatedFixes += rootCauseStores;
      if (latencyMs !== null) {
        richLatencies.push(latencyMs);
      }
    }
  }

  const continuityScore: UsefulnessContinuityScore = {
    qualifyingSessions,
    qualifyingSessions7d,
    qualifyingSessions30d,
    richSessions,
    sparseSessions,
  };
  const reworkAfterResume: ReworkAfterResumeMetric = {
    minBucketSize: USEFULNESS_MIN_BUCKET_SIZE,
    provisional: sparseSessions < USEFULNESS_MIN_BUCKET_SIZE || richSessions < USEFULNESS_MIN_BUCKET_SIZE,
    richMedianResumeMs: computeMedian(richLatencies),
    richRepeatedFixes,
    richSessions,
    sparseMedianResumeMs: computeMedian(sparseLatencies),
    sparseRepeatedFixes,
    sparseSessions,
  };

  return {
    continuityScore,
    resumeToFirstWriteMs: computeMedian(allLatencies),
    resumeToFirstWriteP95Ms: computePercentile(allLatencies, 95),
    reworkAfterResume,
    windowMinutes: USEFULNESS_RESUME_WRITE_WINDOW_MINUTES,
  };
}

export function evaluateCalibrationAssessment(brierScore: null | number, eceResult: ECEResult | null): null | string {
  if (brierScore === null) {
    return null;
  }

  let assessment: string;
  if (brierScore < 0.15) {
    assessment = 'well-calibrated';
  } else if (brierScore <= 0.25) {
    assessment = 'acceptable';
  } else {
    assessment = 'needs attention';
  }
  const hasSystematicBias = eceResult !== null && eceResult.ece > 0.2;
  return hasSystematicBias ? `${assessment} (systematic bias detected)` : assessment;
}

/**
 * Compute per-family participation share. Raw `writerMix` keeps its source-level
 * granularity for the diagnostic line in the report; the families breakdown drives
 * the participation gate against a feasible denominator (≤ 5 stable families).
 */
export function evaluateWriterParticipation(
  writerMix: { count: number; pct: number; source: string }[],
  totalWrites: number,
): WriterParticipationHealth {
  const minPct = DEFAULT_WRITER_PARTICIPATION_FAMILY_MIN_PCT;
  const totalSources = writerMix.length;

  const accumulator = new Map<WriterParticipationFamily, { sources: string[]; writes: number }>();
  for (const entry of writerMix) {
    const family = classifyWriterSourceFamily(entry.source);
    const bucket = accumulator.get(family) ?? { sources: [], writes: 0 };
    bucket.writes += entry.count;
    if (entry.source.trim().length > 0 && !bucket.sources.includes(entry.source)) {
      bucket.sources.push(entry.source);
    }
    accumulator.set(family, bucket);
  }

  const families: WriterParticipationFamilyMetric[] = [...accumulator.entries()]
    .map(([family, bucket]) => ({
      family,
      pct: percent(bucket.writes, totalWrites),
      sources: [...bucket.sources].sort((a, b) => a.localeCompare(b)),
      writes: bucket.writes,
    }))
    .sort((a, b) => b.writes - a.writes || a.family.localeCompare(b.family));

  // Single-family or empty mix → healthy by definition; the gate is about cross-family
  // balance, not about insisting on multiple families.
  if (families.length <= 1 || totalWrites === 0) {
    return {
      belowThreshold: [],
      families,
      healthy: true,
      minPct,
      totalSources,
      totalWrites,
    };
  }

  const belowThreshold: WriterParticipationFlag[] = families
    .filter(family => family.pct < minPct)
    .map(family => ({
      actualPct: family.pct,
      family: family.family,
      writes: family.writes,
    }));

  return {
    belowThreshold,
    families,
    healthy: belowThreshold.length === 0,
    minPct,
    totalSources,
    totalWrites,
  };
}

export function extractModulePath(reference: unknown): null | string {
  if (typeof reference === 'string') {
    const trimmed = reference.trim();
    if (trimmed.length === 0) {
      return null;
    }

    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      try {
        const url = new URL(trimmed);
        const segments = normalizePathSegments(url.pathname);
        const blobIndex = segments.indexOf('blob');
        if (blobIndex === -1) {
          return null;
        }
        return toModulePath(segments.slice(blobIndex + 2));
      } catch {
        return null;
      }
    }

    return toModulePath(normalizePathSegments(trimmed));
  }

  if (isRecord(reference) && 'path' in reference) {
    return extractModulePath(reference.path);
  }

  return null;
}

export function parseCalibrationSignal(signal: unknown): CalibrationSignal | null {
  const value = parseJsonObject(signal);
  if (value === null) {
    return null;
  }

  const predicted = value.predicted;
  const actual = value.actual;
  if (!isCalibrationPredictedLevel(predicted) || !isCalibrationActualOutcome(actual)) {
    return null;
  }

  return {
    actual,
    actualOutcome: CALIBRATION_OUTCOME_BY_ACTUAL[actual],
    predicted,
    predictedProbability: CALIBRATION_PROBABILITY_BY_PREDICTED[predicted],
  };
}

function addConsolidationCounts(target: ConsolidationTotalsMetric, delta: ConsolidationTotalsMetric): void {
  target.contradictionsFlagged += delta.contradictionsFlagged;
  target.dedupes += delta.dedupes;
  target.none += delta.none;
  target.pairsClassified += delta.pairsClassified;
  target.pairsExamined += delta.pairsExamined;
  target.refines += delta.refines;
  target.sessions += delta.sessions;
  target.supersedes += delta.supersedes;
}

function aggregateInvocationRows(
  invocations: ToolInvocation[],
): Omit<McpUsageMetrics, 'logFile' | 'logFileSource' | 'telemetrySource' | 'toolTelemetryCoverage'> {
  const byTool = new Map<string, ToolAggregate>();

  let dedupeSuppressed = 0;
  let errors = 0;
  let readInvocations = 0;
  let successfulInvocations = 0;
  let writeInvocations = 0;
  const orient: OrientMetrics = createEmptyOrientMetrics();
  const orientPayloadChars: number[] = [];
  const orientPayloadTokens: number[] = [];
  let orientPayloadBudgetChars = 0;
  let orientPayloadBudgetExceeded = 0;
  const resume = {
    calls: 0,
    errors: 0,
    notFound: 0,
    ok: 0,
    okDirect: 0,
    okFallback: 0,
  };

  for (const invocation of invocations) {
    if (invocation.status === 'error') {
      errors += 1;
    } else {
      successfulInvocations += 1;
    }

    if (invocation.toolCategory === 'read') {
      readInvocations += 1;
    } else if (invocation.toolCategory === 'write') {
      writeInvocations += 1;
    }

    if (invocation.writeDisposition === 'dedupe_update') {
      dedupeSuppressed += 1;
    }
    dedupeSuppressed += invocation.durableMemoriesDeduped;

    updateOrientMetrics(orient, invocation);
    if (invocation.toolName === 'memory_orient') {
      if (invocation.orientPayloadChars > 0) {
        orientPayloadChars.push(invocation.orientPayloadChars);
      }
      if (invocation.orientPayloadTokensEstimate > 0) {
        orientPayloadTokens.push(invocation.orientPayloadTokensEstimate);
      }
      if (invocation.orientPayloadBudgetChars > 0) {
        orientPayloadBudgetChars = Math.max(orientPayloadBudgetChars, invocation.orientPayloadBudgetChars);
      }
      if (invocation.orientPayloadBudgetExceeded > 0) {
        orientPayloadBudgetExceeded += 1;
      }
    }

    updateResumeMetrics(resume, invocation);
    updateToolAggregate(byTool, invocation);
  }

  orient.timeoutRatePct = percent(orient.timeouts, orient.calls);
  orient.payloadBudgetChars = orientPayloadBudgetChars;
  orient.payloadBudgetExceeded = orientPayloadBudgetExceeded;
  orient.payloadBudgetExceededRatePct = percent(orientPayloadBudgetExceeded, orient.calls);
  orient.payloadSamples = orientPayloadChars.length;
  orient.payloadCharsAvg =
    orientPayloadChars.length === 0
      ? 0
      : Number((orientPayloadChars.reduce((sum, value) => sum + value, 0) / orientPayloadChars.length).toFixed(1));
  orient.payloadCharsP95 =
    orientPayloadChars.length === 0
      ? 0
      : percentile(
          [...orientPayloadChars].sort((a, b) => a - b),
          95,
        );
  orient.payloadCharsMax = orientPayloadChars.length === 0 ? 0 : Math.max(...orientPayloadChars);
  orient.payloadTokensAvg =
    orientPayloadTokens.length === 0
      ? 0
      : Number((orientPayloadTokens.reduce((sum, value) => sum + value, 0) / orientPayloadTokens.length).toFixed(1));

  const tools = [...byTool.values()]
    .map(tool => {
      const durations = [...tool._durations].sort((a, b) => a - b);
      const avgDurationMs =
        durations.length === 0
          ? 0
          : Number((durations.reduce((sum, value) => sum + value, 0) / durations.length).toFixed(1));
      const p95DurationMs = durations.length === 0 ? 0 : percentile(durations, 95);
      return {
        avgDurationMs,
        calls: tool.calls,
        environmentStatusCounts: tool.environmentStatusCounts,
        errors: tool.errors,
        p95DurationMs,
        responseStatusCounts: tool.responseStatusCounts,
        successes: tool.successes,
        successRatePct: percent(tool.successes, tool.calls),
        toolCategory: tool.toolCategory,
        toolName: tool.toolName,
      };
    })
    .sort((a, b) => {
      if (b.calls !== a.calls) {
        return b.calls - a.calls;
      }
      return a.toolName.localeCompare(b.toolName);
    });

  return {
    dedupeSuppressed,
    errors,
    invocations: invocations.length,
    orient,
    readInvocations,
    resume,
    successfulInvocations,
    successRatePct: percent(successfulInvocations, invocations.length),
    tools,
    writeInvocations,
  };
}

function buildContinuityByChannel(
  rows: {
    channel: unknown;
    context_needed_carried_forward: unknown;
    context_needed_derived: unknown;
    context_needed_non_empty: unknown;
    env_model_present: unknown;
    next_actions_carried_forward: unknown;
    next_actions_derived: unknown;
    next_actions_non_empty: unknown;
    open_questions_carried_forward: unknown;
    open_questions_derived: unknown;
    open_questions_non_empty: unknown;
    snapshots: unknown;
    state_model_present: unknown;
  }[],
): { auto: ContinuityChannelMetrics; flush: ContinuityChannelMetrics; unknown: ContinuityChannelMetrics } {
  const empty = (): ContinuityChannelMetrics => ({
    contextNeededCarriedForward: 0,
    contextNeededDerived: 0,
    contextNeededNonEmpty: 0,
    envModelPresent: 0,
    nextActionsCarriedForward: 0,
    nextActionsDerived: 0,
    nextActionsNonEmpty: 0,
    openQuestionsCarriedForward: 0,
    openQuestionsDerived: 0,
    openQuestionsNonEmpty: 0,
    snapshots: 0,
    stateModelPresent: 0,
  });
  const result = { auto: empty(), flush: empty(), unknown: empty() };
  const bucketFor = (channel: string): ContinuityChannelMetrics => {
    if (channel === 'flush') return result.flush;
    if (channel === 'auto') return result.auto;
    return result.unknown;
  };
  for (const row of rows) {
    const channel = typeof row.channel === 'string' ? row.channel : 'unknown';
    const bucket = bucketFor(channel);
    bucket.snapshots += toNumber(row.snapshots);
    bucket.contextNeededNonEmpty += toNumber(row.context_needed_non_empty);
    bucket.nextActionsNonEmpty += toNumber(row.next_actions_non_empty);
    bucket.openQuestionsNonEmpty += toNumber(row.open_questions_non_empty);
    bucket.nextActionsDerived += toNumber(row.next_actions_derived);
    bucket.openQuestionsDerived += toNumber(row.open_questions_derived);
    bucket.contextNeededDerived += toNumber(row.context_needed_derived);
    bucket.nextActionsCarriedForward += toNumber(row.next_actions_carried_forward);
    bucket.openQuestionsCarriedForward += toNumber(row.open_questions_carried_forward);
    bucket.contextNeededCarriedForward += toNumber(row.context_needed_carried_forward);
    bucket.stateModelPresent += toNumber(row.state_model_present);
    bucket.envModelPresent += toNumber(row.env_model_present);
  }
  return result;
}

function buildMcpUsageMetricsFromRows(
  rows: ToolInvocationRow[],
  {
    logFile,
    logFileSource,
    telemetrySource,
  }: {
    logFile: string;
    logFileSource: ResolvedLogPath['source'];
    telemetrySource: 'db';
  },
): McpUsageMetrics {
  const invocations: ToolInvocation[] = rows.map(row => ({
    durableMemoriesDeduped: row.durable_memories_deduped,
    durationMs: row.duration_ms,
    environmentStatus: toText(row.environment_status),
    orientPayloadBudgetChars: row.orient_payload_budget_chars,
    orientPayloadBudgetExceeded: row.orient_payload_budget_exceeded,
    orientPayloadChars: row.orient_payload_chars,
    orientPayloadTokensEstimate: row.orient_payload_tokens_estimate,
    resolvedVia: row.resolved_via,
    responseStatus: row.response_status,
    status: row.status,
    timeoutWarningCount: row.timeout_warning_count,
    toolCategory: row.tool_category,
    toolName: row.tool_name,
    warningCount: row.warning_count,
    writeDisposition: row.write_disposition,
  }));

  const metrics = aggregateInvocationRows(invocations);

  return {
    ...metrics,
    logFile,
    logFileSource,
    telemetrySource,
    toolTelemetryCoverage: invocations.length > 0 ? ('full' as const) : ('none' as const),
  };
}

function buildTopFailureSignatures(rows: { error_message: unknown; source: unknown; stage: unknown }[]) {
  const aggregated = new Map<string, { count: number; sources: Map<string, number> }>();

  for (const row of rows) {
    const source = toText(row.source);
    const stage = toText(row.stage);
    const message = toText(row.error_message);
    const signature = buildFailureSignature(stage, message);

    const current = aggregated.get(signature) ?? {
      count: 0,
      sources: new Map<string, number>(),
    };
    current.count += 1;
    current.sources.set(source, (current.sources.get(source) ?? 0) + 1);
    aggregated.set(signature, current);
  }

  return [...aggregated.entries()]
    .map(([signature, value]) => ({
      count: value.count,
      signature,
      sources: [...value.sources.entries()]
        .map(([source, count]) => ({ count, source }))
        .sort((a, b) => {
          if (b.count !== a.count) {
            return b.count - a.count;
          }
          return a.source.localeCompare(b.source);
        }),
    }))
    .filter(metric => metric.count > 1)
    .sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      return a.signature.localeCompare(b.signature);
    })
    .slice(0, TOP_FAILURE_SIGNATURE_LIMIT);
}

function collectDedupedMemoryKeys(outcomes: unknown, counts: Map<string, number>): void {
  if (!Array.isArray(outcomes)) {
    return;
  }

  for (const outcome of outcomes) {
    if (!isRecord(outcome) || outcome.action_taken !== 'dedupe') {
      continue;
    }
    const memoryKey = toText(outcome.candidate_memory_key) || toText(outcome.new_memory_key);
    if (memoryKey.length === 0) {
      continue;
    }
    counts.set(memoryKey, (counts.get(memoryKey) ?? 0) + 1);
  }
}

function computeMedian(values: number[]): null | number {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const lo = sorted[mid - 1];
    const hi = sorted[mid];
    return lo !== undefined && hi !== undefined ? Math.round((lo + hi) / 2) : null;
  }
  const val = sorted[mid];
  return val !== undefined ? Math.round(val) : null;
}

function computePercentile(values: number[], percentileValue: number): null | number {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1));
  const value = sorted[index];
  return value !== undefined ? Math.round(value) : null;
}

function computeSnapshotContinuityScore(snapshot: JsonRecord | null): number {
  if (snapshot === null) {
    return 0;
  }
  let score = 0;
  const nextActions = snapshot.next_actions;
  if (Array.isArray(nextActions) && nextActions.length > 0) {
    score += 1;
  }
  const openQuestions = snapshot.open_questions;
  if (Array.isArray(openQuestions) && openQuestions.length > 0) {
    score += 1;
  }
  if ('x_state_model' in snapshot) {
    score += 1;
  }
  if ('x_env_model' in snapshot) {
    score += 1;
  }
  return score;
}

function createEmptyConsolidationTotals(): ConsolidationTotalsMetric {
  return {
    contradictionsFlagged: 0,
    dedupes: 0,
    none: 0,
    pairsClassified: 0,
    pairsExamined: 0,
    refines: 0,
    sessions: 0,
    supersedes: 0,
  };
}

function createEmptyOrientMetrics(): OrientMetrics {
  return {
    calls: 0,
    degraded: 0,
    errors: 0,
    ok: 0,
    partial: 0,
    payloadBudgetChars: 0,
    payloadBudgetExceeded: 0,
    payloadBudgetExceededRatePct: 0,
    payloadCharsAvg: 0,
    payloadCharsMax: 0,
    payloadCharsP95: 0,
    payloadSamples: 0,
    payloadTokensAvg: 0,
    timeoutRatePct: 0,
    timeouts: 0,
    timeoutTargetPct: resolveTimeoutPolicy().health.orientTimeoutTargetPct,
  };
}

function emptyMcpUsageMetrics({
  logFile,
  logFileSource,
  telemetryError,
  telemetrySource = 'db',
}: {
  logFile: string;
  logFileSource: ResolvedLogPath['source'];
  telemetryError?: string;
  telemetrySource?: 'db' | 'unavailable';
}): McpUsageMetrics {
  return {
    dedupeSuppressed: 0,
    errors: 0,
    invocations: 0,
    logFile,
    logFileSource,
    orient: createEmptyOrientMetrics(),
    readInvocations: 0,
    resume: {
      calls: 0,
      errors: 0,
      notFound: 0,
      ok: 0,
      okDirect: 0,
      okFallback: 0,
    },
    successfulInvocations: 0,
    successRatePct: 0,
    telemetrySource,
    tools: [],
    toolTelemetryCoverage: 'none',
    writeInvocations: 0,
    ...(telemetryError !== undefined ? { telemetryError } : {}),
  };
}

function getDailyConsolidationAccumulator(
  dailyByDate: Map<string, ConsolidationDailyAccumulator>,
  date: string,
): ConsolidationDailyAccumulator {
  const existing = dailyByDate.get(date);
  if (existing !== undefined) {
    return existing;
  }

  const created = {
    ...createEmptyConsolidationTotals(),
    avgLatencyMs: 0,
    date,
    latencyTotalMs: 0,
  };
  dailyByDate.set(date, created);
  return created;
}

function isCalibrationActualOutcome(value: unknown): value is CalibrationActualOutcome {
  return value === 'success' || value === 'partial' || value === 'failure';
}

function isCalibrationPredictedLevel(value: unknown): value is StrategyConfidence {
  return (STRATEGY_CONFIDENCE_VALUES as readonly unknown[]).includes(value);
}

function listFilesByMtime(directory: string, windowStartMs: number): string[] {
  if (!existsSync(directory)) {
    return [];
  }

  const files: string[] = [];
  for (const name of readdirSync(directory)) {
    const filePath = resolve(directory, name);
    const stats = statSync(filePath);
    if (!stats.isFile()) {
      continue;
    }
    if (stats.mtimeMs < windowStartMs) {
      continue;
    }
    files.push(filePath);
  }

  return files;
}

function listJsonFiles(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory)
    .filter(name => name.endsWith('.json'))
    .map(name => resolve(directory, name));
}

function normalizePathSegments(pathValue: string): string[] {
  return pathValue
    .replaceAll('\\', '/')
    .split('/')
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0);
}

function orientTimeoutWarningCountsAgainstLaunchGate(invocation: ToolInvocation): boolean {
  if (invocation.timeoutWarningCount <= 0) {
    return false;
  }
  if (invocation.status === 'error') {
    return true;
  }
  return invocation.responseStatus !== 'ok';
}

function parseConsolidationActionCounts(value: unknown): {
  dedupes: number;
  none: number;
  refines: number;
  supersedes: number;
} {
  const actions = parseJsonObject(value);
  return {
    dedupes: toNumber(actions?.dedupe),
    none: toNumber(actions?.none),
    refines: toNumber(actions?.refine),
    supersedes: toNumber(actions?.supersede),
  };
}

function parseEvidenceRefs(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parseLastRetentionRun(logFile: string): null | RetentionLastRun {
  if (!existsSync(logFile)) {
    return null;
  }

  const lines = readFileSync(logFile, 'utf8').split('\n');
  let lastRun: null | RetentionLastRun = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (!isRecord(record) || record.event !== 'retention.purge_complete') {
      continue;
    }

    const ts = toText(record.ts);
    if (ts.length === 0) {
      continue;
    }

    lastRun = {
      dryRun: record.dryRun === true,
      durationMs: toNumber(record.durationMs),
      errorCount: toNumber(record.errorCount),
      status: toText(record.status),
      timestamp: ts,
      totalCandidates: toNumber(record.totalCandidates),
      totalDeleted: toNumber(record.totalDeleted),
    };
  }

  return lastRun;
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) {
    return 0;
  }
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * values.length) - 1));
  const value = values[index];
  return value !== undefined ? Number(value.toFixed(1)) : 0;
}

async function queryCount(pool: Pool, query: SqlQuery): Promise<number> {
  const row = await querySingle(pool, query);
  return toNumber(row.value);
}

async function queryRows<T extends JsonRecord>(pool: Pool, query: SqlQuery): Promise<T[]> {
  const result = await pool.query<T>(query.sql, query.params ?? []);
  return result.rows;
}

async function querySingle<T extends JsonRecord>(pool: Pool, query: SqlQuery): Promise<T> {
  const result = await pool.query<T>(query.sql, query.params ?? []);
  return (result.rows[0] ?? {}) as T;
}

function readJson(filePath: string): unknown {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    return parsed;
  } catch {
    return null;
  }
}

function readNullableNumber(value: unknown): null | number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function toModulePath(segments: string[]): null | string {
  const first = segments[0];
  const second = segments[1];
  if (first === undefined || second === undefined) {
    return null;
  }
  return `${first}/${second}`;
}

function toTrackedDecisionCategory(value: unknown): null | TrackedDecisionCategory {
  const category = toText(value);
  if (category === 'decision' || category === 'architecture' || category === 'convention') {
    return category;
  }
  return null;
}

function updateOrientMetrics(orient: OrientMetrics, invocation: ToolInvocation): void {
  if (invocation.toolName !== 'memory_orient') {
    return;
  }

  orient.calls += 1;
  if (orientTimeoutWarningCountsAgainstLaunchGate(invocation)) {
    orient.timeouts += 1;
  }

  if (invocation.status === 'error') {
    orient.errors += 1;
    return;
  }

  if (invocation.responseStatus === 'ok') {
    orient.ok += 1;
    return;
  }

  if (invocation.responseStatus === 'partial') {
    orient.partial += 1;
    return;
  }

  if (invocation.responseStatus === 'degraded') {
    orient.degraded += 1;
  }
}

function updateResumeMetrics(
  resume: {
    calls: number;
    errors: number;
    notFound: number;
    ok: number;
    okDirect: number;
    okFallback: number;
  },
  invocation: ToolInvocation,
): void {
  if (invocation.toolName !== 'memory_session_resume') {
    return;
  }

  resume.calls += 1;
  if (invocation.status === 'error') {
    resume.errors += 1;
    return;
  }

  if (invocation.responseStatus === 'not_found') {
    resume.notFound += 1;
    return;
  }

  resume.ok += 1;
  if (invocation.resolvedVia === 'fallback') {
    resume.okFallback += 1;
  } else {
    resume.okDirect += 1;
  }
}

function updateToolAggregate(byTool: Map<string, ToolAggregate>, invocation: ToolInvocation): void {
  if (invocation.toolName.length === 0) {
    return;
  }

  const existing: ToolAggregate = byTool.get(invocation.toolName) ?? {
    _durations: [] as number[],
    calls: 0,
    environmentStatusCounts: {},
    errors: 0,
    responseStatusCounts: {},
    successes: 0,
    toolCategory: invocation.toolCategory,
    toolName: invocation.toolName,
  };

  existing.calls += 1;
  existing.toolCategory = invocation.toolCategory.length > 0 ? invocation.toolCategory : existing.toolCategory;
  if (invocation.status === 'error') {
    existing.errors += 1;
  } else {
    existing.successes += 1;
  }
  if (invocation.responseStatus.length > 0) {
    existing.responseStatusCounts[invocation.responseStatus] =
      (existing.responseStatusCounts[invocation.responseStatus] ?? 0) + 1;
  }
  if (invocation.environmentStatus.length > 0) {
    existing.environmentStatusCounts[invocation.environmentStatus] =
      (existing.environmentStatusCounts[invocation.environmentStatus] ?? 0) + 1;
  }
  if (invocation.durationMs !== null && Number.isFinite(invocation.durationMs)) {
    existing._durations.push(invocation.durationMs);
  }

  byTool.set(invocation.toolName, existing);
}
