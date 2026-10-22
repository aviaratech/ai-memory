/**
 * Corpus cleanup: removes stored data that ai-memory no longer keeps.
 *
 * - Memories written by memory_flush (decisions, root causes, checkpoints and
 *   reflections). Flush is session state; it lives in the session snapshot and
 *   the continuity pack.
 * - Session summaries promoted automatically from ingested sessions, and any
 *   other session summary whose expiry has passed.
 * - Session snapshots and deltas that resume no longer reads: everything older
 *   than the history window before the cutoff, except the latest snapshot and
 *   delta per session, the flush snapshots that carry-forward reads (the newest
 *   one and the newest holding each continuity field) and the deltas behind
 *   kept snapshots.
 * - Session events written by the removed inline consolidation.
 *
 * Memories written through memory_store are kept unless they are expired
 * session summaries. A removable row also stays when lineage (`supersedes_id`)
 * links it to a kept memory in either direction, or when it is contested. Only rows created before the cutoff are
 * touched; the cutoff is the verified backup time, so every deleted row can be
 * restored from that backup. The dry run and the apply share one SQL
 * definition bound only by the cutoff, and the apply deletes in a single
 * statement, so on unchanged data it removes exactly the rows the dry run counted.
 */

import type { DbClient } from '../db/pool.js';

import { KNOWLEDGE_MEMORY_SQL } from '../db/knowledge-eligibility.js';

export const DEFAULT_CLEANUP_HISTORY_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
export const MIN_CLEANUP_HISTORY_DAYS = 7;

const FLUSH_MEMORY_SOURCE = 'manual-flush';
// Flush rows carried no key or a derived one; a real key means a deliberate write.
const FLUSH_KEY_SQL = "(m.memory_key IS NULL OR m.memory_key LIKE 'derived-memory:%')";
const FLUSH_WORKFLOW_SYSTEMS = "'memory-flush', 'manual', 'manual-flush'";
const AUTO_SESSION_SUMMARY_CONTRACT = 'memory_delta@0.1';
const REMOVED_SESSION_EVENT_TYPES = "'consolidation_metrics'";

export const CLEANUP_TABLES = [
  'ai_memory_entries',
  'ai_memory_events',
  'ai_session_snapshots',
  'ai_memory_deltas',
  'ai_session_events',
] as const;

export type CleanupTable = (typeof CLEANUP_TABLES)[number];

export interface CleanupCountRow {
  category: null | string;
  reason: string;
  rows: number;
  source: null | string;
  table: CleanupTable;
}

export interface CleanupKeptSummary {
  /** Kept memories with no embedding, which `backfill:embeddings` can fill. */
  activeMissingEmbedding: null | number;
  entries: number;
  /** Removable rows kept for lineage or as part of a contested pair. */
  lineageProtected: number;
}

export interface CorpusCleanupReport {
  cutoff: string;
  historyCutoff: string;
  historyDays: number;
  kept: CleanupKeptSummary;
  rows: CleanupCountRow[];
  totals: Record<CleanupTable, number>;
}

export interface CleanupBounds {
  /** Only rows created (and, for memories, updated) before this time are removed. */
  cutoff: Date;
  /** Snapshots and deltas from this many days before the cutoff are always kept. */
  historyDays: number;
}

type CleanupQueryable = Pick<DbClient, 'query'>;

interface CountQueryRow extends Record<string, unknown> {
  category: null | string;
  reason: string;
  rows: number | string;
  source: null | string;
  table_name: string;
}

// True when the snapshot field holds a non-blank string, as carry-forward reads it.
function hasTextItem(field: string): string {
  return `jsonb_path_exists(snapshot_json, '$.${field}[*] ? (@.type() == "string" && @ like_regex "\\\\S")')`;
}

// $1 = cutoff, $2 = history window in days.
const CANDIDATES_CTE = `
WITH RECURSIVE
entry_candidates AS (
  SELECT m.id, m.source, m.category,
    CASE
      WHEN m.source = '${FLUSH_MEMORY_SOURCE}' AND ${FLUSH_KEY_SQL} THEN 'flush_memory'
      WHEN m.metadata_json->>'source_contract' = '${AUTO_SESSION_SUMMARY_CONTRACT}' THEN 'auto_session_summary'
      ELSE 'expired_session_summary'
    END AS reason
  FROM ai_memory_entries m
  WHERE m.created_at < $1::timestamptz
    AND m.updated_at < $1::timestamptz
    AND (
      (m.source = '${FLUSH_MEMORY_SOURCE}' AND ${FLUSH_KEY_SQL})
      OR (
        m.category = 'session-summary'
        AND (
          m.metadata_json->>'source_contract' = '${AUTO_SESSION_SUMMARY_CONTRACT}'
          OR m.expires_at <= $1::timestamptz
        )
      )
    )
),
-- Lineage runs both ways. A kept memory keeps the rows it supersedes, a
-- removable row that retired a kept memory stays as its replacement (the old
-- inline consolidation refined curated memories this way; a link to a memory
-- that is still active is only history), contested rows stay so
-- memory_resolve_contested can still pair them, and both rules follow chains.
lineage_protected (id) AS (
  SELECT id FROM (
    SELECT k.supersedes_id AS id
    FROM ai_memory_entries k
    WHERE k.supersedes_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM entry_candidates c WHERE c.id = k.id)
    UNION
    SELECT c.id
    FROM entry_candidates c
    JOIN ai_memory_entries m ON m.id = c.id
    JOIN ai_memory_entries t ON t.id = m.supersedes_id
    WHERE t.status <> 'active'
      AND NOT EXISTS (SELECT 1 FROM entry_candidates x WHERE x.id = t.id)
    UNION
    SELECT m.id
    FROM entry_candidates c
    JOIN ai_memory_entries m ON m.id = c.id
    WHERE m.status = 'contested'
  ) seeds
  UNION
  SELECT n.id
  FROM lineage_protected p
  JOIN ai_memory_entries pm ON pm.id = p.id
  JOIN ai_memory_entries n ON n.id = pm.supersedes_id OR n.supersedes_id = pm.id
),
entry_deletes AS (
  SELECT c.*
  FROM entry_candidates c
  WHERE NOT EXISTS (SELECT 1 FROM lineage_protected p WHERE p.id = c.id)
),
history_bound AS (
  SELECT $1::timestamptz - make_interval(days => $2::int) AS before
),
patch_sessions AS (
  SELECT DISTINCT session_id
  FROM ai_memory_deltas
  WHERE snapshot_mode = 'patch' AND session_id IS NOT NULL
),
latest_snapshots AS (
  SELECT DISTINCT ON (session_id) id
  FROM ai_session_snapshots
  ORDER BY session_id, created_at DESC, id DESC
),
flush_snapshots AS (
  SELECT s.id, s.session_id, s.created_at, s.snapshot_json
  FROM ai_session_snapshots s
  JOIN ai_memory_deltas d ON d.delta_id = s.source_delta_id
  WHERE COALESCE(d.raw_json->'workflow'->>'system', '') IN (${FLUSH_WORKFLOW_SYSTEMS})
),
-- Carry-forward takes each continuity field from the newest flush snapshot
-- that has it, so keep that snapshot for every field as well as the newest.
kept_flush_snapshots AS (
  SELECT id FROM (
    SELECT DISTINCT ON (session_id) id FROM flush_snapshots ORDER BY session_id, created_at DESC, id DESC
  ) newest
  UNION
  SELECT id FROM (
    SELECT DISTINCT ON (session_id) id FROM flush_snapshots
    WHERE ${hasTextItem('next_actions')}
    ORDER BY session_id, created_at DESC, id DESC
  ) next_actions
  UNION
  SELECT id FROM (
    SELECT DISTINCT ON (session_id) id FROM flush_snapshots
    WHERE ${hasTextItem('context_needed')}
    ORDER BY session_id, created_at DESC, id DESC
  ) context_needed
  UNION
  SELECT id FROM (
    SELECT DISTINCT ON (session_id) id FROM flush_snapshots
    WHERE ${hasTextItem('open_questions')}
    ORDER BY session_id, created_at DESC, id DESC
  ) open_questions
  UNION
  SELECT id FROM (
    SELECT DISTINCT ON (session_id) id FROM flush_snapshots
    WHERE jsonb_typeof(snapshot_json->'x_state_model') = 'object'
    ORDER BY session_id, created_at DESC, id DESC
  ) state_model
),
snapshot_deletes AS (
  SELECT s.id
  FROM ai_session_snapshots s, history_bound b
  WHERE s.created_at < b.before
    AND NOT EXISTS (SELECT 1 FROM latest_snapshots k WHERE k.id = s.id)
    AND NOT EXISTS (SELECT 1 FROM kept_flush_snapshots k WHERE k.id = s.id)
    AND NOT EXISTS (SELECT 1 FROM patch_sessions p WHERE p.session_id = s.session_id)
),
latest_deltas AS (
  SELECT DISTINCT ON (session_id) delta_id
  FROM ai_memory_deltas
  WHERE session_id IS NOT NULL
  ORDER BY session_id, created_at DESC, delta_id DESC
),
delta_deletes AS (
  SELECT d.delta_id, COALESCE(d.raw_json->'workflow'->>'system', d.produced_by_agent) AS source
  FROM ai_memory_deltas d, history_bound b
  WHERE d.created_at < b.before
    AND d.session_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM latest_deltas k WHERE k.delta_id = d.delta_id)
    AND NOT EXISTS (SELECT 1 FROM patch_sessions p WHERE p.session_id = d.session_id)
    AND NOT EXISTS (
      SELECT 1
      FROM ai_session_snapshots s
      WHERE s.source_delta_id = d.delta_id
        AND NOT EXISTS (SELECT 1 FROM snapshot_deletes x WHERE x.id = s.id)
    )
),
event_deletes AS (
  SELECT e.id, e.event_type
  FROM ai_session_events e
  WHERE e.event_type IN (${REMOVED_SESSION_EVENT_TYPES})
    AND e.created_at < $1::timestamptz
),
cascaded_memory_events AS (
  SELECT e.event_type, COUNT(*) AS rows
  FROM ai_memory_events e
  JOIN entry_deletes d ON d.id = e.memory_id
  GROUP BY e.event_type
)`;

const PLAN_SQL = `${CANDIDATES_CTE}
SELECT 'ai_memory_entries' AS table_name, reason, source, category, COUNT(*) AS rows
FROM entry_deletes GROUP BY reason, source, category
UNION ALL
SELECT 'ai_memory_events', 'deleted_with_memory', NULL, event_type, rows FROM cascaded_memory_events
UNION ALL
SELECT 'ai_session_snapshots', 'superseded_snapshot', NULL, NULL, COUNT(*) FROM snapshot_deletes HAVING COUNT(*) > 0
UNION ALL
SELECT 'ai_memory_deltas', 'superseded_delta', source, NULL, COUNT(*) FROM delta_deletes GROUP BY source
UNION ALL
SELECT 'ai_session_events', 'removed_feature', NULL, event_type, COUNT(*) FROM event_deletes GROUP BY event_type`;

const APPLY_SQL = `${CANDIDATES_CTE},
deleted_entries AS (
  DELETE FROM ai_memory_entries m USING entry_deletes d WHERE m.id = d.id
  RETURNING d.reason, d.source, d.category
),
deleted_snapshots AS (
  DELETE FROM ai_session_snapshots s USING snapshot_deletes d WHERE s.id = d.id
  RETURNING s.id
),
deleted_deltas AS (
  DELETE FROM ai_memory_deltas m USING delta_deletes d WHERE m.delta_id = d.delta_id
  RETURNING d.source
),
deleted_events AS (
  DELETE FROM ai_session_events e USING event_deletes d WHERE e.id = d.id
  RETURNING d.event_type
)
SELECT 'ai_memory_entries' AS table_name, reason, source, category, COUNT(*) AS rows
FROM deleted_entries GROUP BY reason, source, category
UNION ALL
SELECT 'ai_memory_events', 'deleted_with_memory', NULL, event_type, rows FROM cascaded_memory_events
UNION ALL
SELECT 'ai_session_snapshots', 'superseded_snapshot', NULL, NULL, COUNT(*) FROM deleted_snapshots HAVING COUNT(*) > 0
UNION ALL
SELECT 'ai_memory_deltas', 'superseded_delta', source, NULL, COUNT(*) FROM deleted_deltas GROUP BY source
UNION ALL
SELECT 'ai_session_events', 'removed_feature', NULL, event_type, COUNT(*) FROM deleted_events GROUP BY event_type`;

const KEPT_SQL = `${CANDIDATES_CTE}
SELECT
  (SELECT COUNT(*) FROM ai_memory_entries m WHERE NOT EXISTS (SELECT 1 FROM entry_deletes d WHERE d.id = m.id)) AS entries,
  (SELECT COUNT(*) FROM entry_candidates c WHERE NOT EXISTS (SELECT 1 FROM entry_deletes d WHERE d.id = c.id))
    AS lineage_protected`;

// The same rows backfill:embeddings fills.
const KEPT_MISSING_EMBEDDING_SQL = `${CANDIDATES_CTE}
SELECT COUNT(*) AS missing
FROM ai_memory_entries m
WHERE m.embedding IS NULL
  AND m.status = 'active'
  AND (m.expires_at IS NULL OR m.expires_at > NOW())
  AND lower(coalesce(m.category, '')) <> 'session-summary'
  AND ${KNOWLEDGE_MEMORY_SQL}
  AND lower(btrim(coalesce(m.source, ''))) NOT IN ('manual-flush', 'memory-flush')
  AND NOT EXISTS (SELECT 1 FROM entry_deletes d WHERE d.id = m.id)`;

/** Counts what an apply would delete and keep. Runs only SELECT statements. */
export async function planCorpusCleanup(client: CleanupQueryable, bounds: CleanupBounds): Promise<CorpusCleanupReport> {
  const params = toParams(bounds);
  const counts = await client.query<CountQueryRow>(PLAN_SQL, params);
  return buildReport(client, bounds, counts.rows);
}

/**
 * Deletes the planned rows in one statement inside the caller's transaction and
 * reports what was deleted, in the same shape as the plan.
 */
export async function applyCorpusCleanup(
  client: CleanupQueryable,
  bounds: CleanupBounds,
): Promise<CorpusCleanupReport> {
  const params = toParams(bounds);
  const deleted = await client.query<CountQueryRow>(APPLY_SQL, params);
  return buildReport(client, bounds, deleted.rows);
}

async function buildReport(
  client: CleanupQueryable,
  bounds: CleanupBounds,
  countRows: CountQueryRow[],
): Promise<CorpusCleanupReport> {
  const params = toParams(bounds);
  const rows = countRows.map(row => toCountRow(row)).sort(compareCountRows);
  const totals = Object.fromEntries(CLEANUP_TABLES.map(table => [table, 0])) as Record<CleanupTable, number>;
  for (const row of rows) totals[row.table] += row.rows;

  const keptRow = (
    await client.query<{ entries: number | string; lineage_protected: number | string }>(KEPT_SQL, params)
  ).rows[0];
  const hasEmbedding = await hasEmbeddingColumn(client);
  const missing = hasEmbedding
    ? Number((await client.query<{ missing: number | string }>(KEPT_MISSING_EMBEDDING_SQL, params)).rows[0]?.missing)
    : null;
  return {
    cutoff: bounds.cutoff.toISOString(),
    historyCutoff: new Date(bounds.cutoff.getTime() - bounds.historyDays * DAY_MS).toISOString(),
    historyDays: bounds.historyDays,
    kept: {
      activeMissingEmbedding: missing,
      entries: Number(keptRow?.entries ?? 0),
      lineageProtected: Number(keptRow?.lineage_protected ?? 0),
    },
    rows,
    totals,
  };
}

function compareCountRows(left: CleanupCountRow, right: CleanupCountRow): number {
  return (
    CLEANUP_TABLES.indexOf(left.table) - CLEANUP_TABLES.indexOf(right.table) ||
    right.rows - left.rows ||
    `${left.reason}\u0000${left.source ?? ''}\u0000${left.category ?? ''}`.localeCompare(
      `${right.reason}\u0000${right.source ?? ''}\u0000${right.category ?? ''}`,
    )
  );
}

async function hasEmbeddingColumn(client: CleanupQueryable): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'ai_memory_entries' AND column_name = 'embedding'
     ) AS present`,
  );
  return result.rows[0]?.present === true;
}

function toCountRow(row: CountQueryRow): CleanupCountRow {
  const table = CLEANUP_TABLES.find(name => name === row.table_name);
  if (table === undefined) throw new Error(`Unexpected cleanup table: ${row.table_name}`);
  return {
    category: row.category,
    reason: row.reason,
    rows: Number(row.rows),
    source: row.source,
    table,
  };
}

function toParams(bounds: CleanupBounds): [string, number] {
  if (!Number.isInteger(bounds.historyDays) || bounds.historyDays < MIN_CLEANUP_HISTORY_DAYS) {
    throw new Error(`historyDays must be an integer of at least ${String(MIN_CLEANUP_HISTORY_DAYS)}.`);
  }
  if (Number.isNaN(bounds.cutoff.getTime())) throw new Error('cutoff must be a valid time.');
  return [bounds.cutoff.toISOString(), bounds.historyDays];
}
