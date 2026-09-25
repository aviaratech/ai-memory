/**
 * Centralized retention query definitions for purge paths.
 *
 * Each entry documents the backing index, deterministic ordering, and
 * correct PK column for batch deletes. The retention runner consumes these
 * definitions instead of building queries inline.
 */
import type { RetentionConfig } from '../retention/retentionConfig.js';

const PURGE_TABLE_ORDER = [
  'ai_ingestion_failures',
  'ai_memory_entries_expired',
  'ai_memory_entries_retired',
  'ai_sessions',
  'ai_context_packs',
  'ai_memory_deltas',
  'ai_memory_events',
  'ai_tool_invocations',
] as const;

type PurgeTableKey = (typeof PURGE_TABLE_ORDER)[number];

interface RetentionQueryDef {
  /** Column used in MIN/MAX bounds queries */
  boundsColumn: string;
  /** Build the WHERE condition from retention config */
  buildCondition: (config: RetentionConfig) => string;
  /** Name of the index backing this predicate (for validation/documentation) */
  coveringIndex: string;
  /** Display name used in result reporting */
  displayName: string;
  /** Column used in DELETE ... WHERE idColumn IN (SELECT idColumn ...) */
  idColumn: string;
  /**
   * Comma-separated ORDER BY clause for deterministic batch delete.
   * Must be index-aligned: the leading column matches the covering index's
   * predicate column, and a unique tie-breaker column follows to guarantee
   * deterministic ordering when the predicate column has duplicate values.
   */
  orderColumn: string;
  /** Physical table name */
  table: string;
}

/**
 * Query definitions for each retention purge target.
 *
 * coveringIndex references the migration-defined index that backs the
 * WHERE predicate. These names are validated by retention-queries.test.ts
 * to guard against index/query drift.
 */
const RETENTION_QUERY_DEFS: Record<PurgeTableKey, RetentionQueryDef> = {
  ai_context_packs: {
    boundsColumn: 'created_at',
    buildCondition: (c: RetentionConfig) => `created_at < NOW() - INTERVAL '${String(c.sessionDays)} days'`,
    coveringIndex: 'ai_context_packs_retention_created_idx',
    displayName: 'ai_context_packs',
    idColumn: 'pack_id',
    orderColumn: 'created_at, pack_id',
    table: 'ai_context_packs',
  },
  ai_ingestion_failures: {
    boundsColumn: 'created_at',
    buildCondition: (c: RetentionConfig) => `created_at < NOW() - INTERVAL '${String(c.failureDays)} days'`,
    coveringIndex: 'ai_ingestion_failures_retention_created_idx',
    displayName: 'ai_ingestion_failures',
    idColumn: 'id',
    orderColumn: 'created_at, id',
    table: 'ai_ingestion_failures',
  },
  ai_memory_deltas: {
    boundsColumn: 'created_at',
    buildCondition: (c: RetentionConfig) => `created_at < NOW() - INTERVAL '${String(c.sessionDays)} days'`,
    coveringIndex: 'ai_memory_deltas_retention_created_idx',
    displayName: 'ai_memory_deltas',
    idColumn: 'delta_id',
    orderColumn: 'created_at, delta_id',
    table: 'ai_memory_deltas',
  },
  ai_memory_entries_expired: {
    boundsColumn: 'created_at',
    buildCondition: (c: RetentionConfig) =>
      `category = 'session-summary' AND expires_at IS NOT NULL AND expires_at <= NOW() - INTERVAL '${String(c.expiredGraceDays)} days'`,
    coveringIndex: 'ai_memory_entries_retention_expired_idx',
    displayName: 'ai_memory_entries (expired session-summaries)',
    idColumn: 'id',
    orderColumn: 'expires_at, id',
    table: 'ai_memory_entries',
  },
  ai_memory_entries_retired: {
    boundsColumn: 'created_at',
    buildCondition: (c: RetentionConfig) =>
      `status IN ('superseded', 'archived') AND updated_at < NOW() - INTERVAL '${String(c.supersededDays)} days'`,
    coveringIndex: 'ai_memory_entries_retention_retired_idx',
    displayName: 'ai_memory_entries (retired durable)',
    idColumn: 'id',
    orderColumn: 'updated_at, id',
    table: 'ai_memory_entries',
  },
  ai_memory_events: {
    boundsColumn: 'created_at',
    buildCondition: (c: RetentionConfig) =>
      `NOT EXISTS (SELECT 1 FROM ai_memory_entries m WHERE m.id = ai_memory_events.memory_id) AND created_at < NOW() - INTERVAL '${String(c.auditDays)} days'`,
    coveringIndex: 'ai_memory_events_retention_created_idx',
    displayName: 'ai_memory_events',
    idColumn: 'id',
    orderColumn: 'created_at, id',
    table: 'ai_memory_events',
  },
  ai_sessions: {
    boundsColumn: 'started_at',
    buildCondition: (c: RetentionConfig) => `started_at < NOW() - INTERVAL '${String(c.sessionDays)} days'`,
    coveringIndex: 'ai_sessions_retention_started_idx',
    displayName: 'ai_sessions',
    idColumn: 'session_id',
    orderColumn: 'started_at, session_id',
    table: 'ai_sessions',
  },
  ai_tool_invocations: {
    boundsColumn: 'created_at',
    buildCondition: (c: RetentionConfig) => `created_at < NOW() - INTERVAL '${String(c.telemetryDays)} days'`,
    coveringIndex: 'ai_tool_invocations_retention_created_idx',
    displayName: 'ai_tool_invocations',
    idColumn: 'id',
    orderColumn: 'created_at, id',
    table: 'ai_tool_invocations',
  },
};

export type { PurgeTableKey, RetentionQueryDef };
export { PURGE_TABLE_ORDER, RETENTION_QUERY_DEFS };
