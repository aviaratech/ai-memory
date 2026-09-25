import type { DbClient } from './pool.js';
import type { QueryResultRow } from 'pg';

import { resolveTimeoutPolicy } from '../timeout-policy.js';
import { insertIngestionFailureWithClient } from './failure-events.js';
import {
  normalizeFailureDetails,
  normalizeFailureMessage,
  normalizeLimit,
  normalizeOptionalText,
  normalizeOptionalTimestamp,
  normalizeProjectScope,
  normalizeRequiredText,
} from './normalization.js';
import { runBoundedQuery } from './query-runner.js';
import { toIngestionFailureRecord, toSessionEventRecord, toSessionRecord, toSessionSnapshotRecord } from './records.js';
import { pool } from './runtime.js';
import { isRecord } from './type-guards.js';

export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rowCount: number; rows: QueryResultRow[] }>;
}

export interface SessionResolveResult {
  resolvedVia: 'direct' | 'fallback';
  row: SessionRow;
  sessionId: string;
}

interface ContextPackRefRow extends QueryResultRow {
  created_at?: Date | string;
  pack_id?: string;
}

interface DeltaRefRow extends QueryResultRow {
  created_at?: Date | string;
  delta_id?: string;
}

interface FallbackFilter {
  agent?: string | undefined;
  repoFilter?: string | undefined;
}

interface SessionEventRow extends QueryResultRow {
  created_at?: Date | string;
  event_id?: string;
  event_type?: string;
  id?: number;
  payload_json?: unknown;
  session_id?: string;
  summary?: string;
}

interface SessionRow extends QueryResultRow {
  agent?: string;
  ended_at?: Date | string;
  metadata_json?: unknown;
  model?: string;
  org_id?: string;
  repo_id?: string;
  repo_slug?: string;
  session_id?: string;
  started_at?: Date | string;
  status?: string;
  task_id?: string;
  task_title?: string;
  task_type?: string;
  tool?: string;
  updated_at?: Date | string;
  user_id?: string;
}

interface SessionSnapshotRow extends QueryResultRow {
  created_at?: Date | string;
  id?: number;
  schema_version?: string;
  session_id?: string;
  snapshot_id?: string;
  snapshot_json?: unknown;
  source_delta_id?: string;
}

/** Exact caller session only; never infer a repository from background recency. */
export function getSessionProject(sessionId: string): Promise<string | undefined> {
  return runBoundedQuery({
    phase: 'db.read.session_project',
    pool,
    task: client => getSessionProjectWithClient(client, sessionId),
    timeoutMs: resolveTimeoutPolicy().db.readTimeoutMs,
  });
}

export async function getSessionProjectWithClient(
  client: {
    query: (
      sql: string,
      params: unknown[],
    ) => Promise<{ rows: Record<string, unknown>[] }> | { rows: Record<string, unknown>[] };
  },
  sessionId: string,
): Promise<string | undefined> {
  const result = await client.query('SELECT repo_id, repo_slug FROM ai_sessions WHERE session_id = $1', [sessionId]);
  const row = result.rows[0];
  return normalizeProjectScope({ repoId: row?.repo_id, repoSlug: row?.repo_slug });
}

export async function getSessionResume(input: unknown) {
  const request = isRecord(input) ? input : {};
  const sessionId = normalizeOptionalText(request.sessionId);
  const agent = normalizeOptionalText(request.agent);
  const project = normalizeOptionalText(request.project);
  const repoId = normalizeOptionalText(request.repoId);
  const eventLimit = normalizeLimit(request.eventLimit, {
    fallback: 25,
    max: 500,
  });

  const hasIdentifier = sessionId !== undefined || agent !== undefined || project !== undefined || repoId !== undefined;
  if (!hasIdentifier) {
    throw new Error('At least one of sessionId, agent, project, or repoId is required');
  }

  const resolved = await runDbReadQuery({
    operation: 'resolve_session_id',
    task: client => resolveSessionId(client, { agent, project, repoId, sessionId }),
  });
  if (resolved === undefined) {
    return {
      contextPackId: undefined,
      deltaId: undefined,
      events: [],
      resolvedVia: 'not_found' as const,
      session: undefined,
      sessionId: sessionId ?? '',
      snapshot: undefined,
      status: 'not_found',
    };
  }

  const resolvedSessionId = resolved.sessionId;
  const [snapshotResult, eventsResult, latestDeltaResult, latestContextPackResult] = await Promise.all([
    runDbReadQuery({
      operation: 'session_resume_snapshot',
      task: client =>
        client.query<SessionSnapshotRow>(
          `
        SELECT *
        FROM ai_session_snapshots
        WHERE session_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `,
          [resolvedSessionId],
        ),
    }),
    runDbReadQuery({
      operation: 'session_resume_events',
      task: client =>
        client.query<SessionEventRow>(
          `
        SELECT *
        FROM ai_session_events
        WHERE session_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2
      `,
          [resolvedSessionId, eventLimit],
        ),
    }),
    runDbReadQuery({
      operation: 'session_resume_latest_delta',
      task: client =>
        client.query<DeltaRefRow>(
          `
        SELECT delta_id, created_at
        FROM ai_memory_deltas
        WHERE session_id = $1
        ORDER BY created_at DESC
        LIMIT 1
      `,
          [resolvedSessionId],
        ),
    }),
    runDbReadQuery({
      operation: 'session_resume_latest_context_pack',
      task: client =>
        client.query<ContextPackRefRow>(
          `
        SELECT pack_id, created_at
        FROM ai_context_packs
        WHERE session_id = $1
        ORDER BY created_at DESC
        LIMIT 1
      `,
          [resolvedSessionId],
        ),
    }),
  ]);

  const latestDelta = latestDeltaResult.rows.at(0);
  const latestContextPack = latestContextPackResult.rows.at(0);
  const latestSnapshot = snapshotResult.rows.at(0);
  const recentEvents = [...eventsResult.rows].reverse().map(row => toSessionEventRecord(row));

  return {
    contextPackCreatedAt:
      latestContextPack?.created_at instanceof Date
        ? latestContextPack.created_at.toISOString()
        : latestContextPack?.created_at,
    contextPackId: latestContextPack?.pack_id,
    deltaCreatedAt:
      latestDelta?.created_at instanceof Date ? latestDelta.created_at.toISOString() : latestDelta?.created_at,
    deltaId: latestDelta?.delta_id,
    events: recentEvents,
    resolvedVia: resolved.resolvedVia,
    session: toSessionRecord(resolved.row),
    sessionId: resolvedSessionId,
    snapshot: latestSnapshot === undefined ? undefined : toSessionSnapshotRecord(latestSnapshot),
    status: 'ok',
  };
}

export async function listIngestionFailures(input: unknown = {}) {
  const request = isRecord(input) ? input : {};
  const source = normalizeOptionalText(request.source);
  const stage = normalizeOptionalText(request.stage);
  const sessionId = normalizeOptionalText(request.sessionId);
  const limit = normalizeLimit(request.limit, { fallback: 20, max: 200 });

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (source !== undefined) {
    params.push(source);
    conditions.push(`source = $${String(params.length)}`);
  }

  if (stage !== undefined) {
    params.push(stage);
    conditions.push(`stage = $${String(params.length)}`);
  }

  if (sessionId !== undefined) {
    params.push(sessionId);
    conditions.push(`session_id = $${String(params.length)}`);
  }

  params.push(limit);
  const limitParam = `$${String(params.length)}`;
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `
    SELECT *
    FROM ai_ingestion_failures
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT ${limitParam}
  `;

  const result = await runDbReadQuery({
    operation: 'list_ingestion_failures',
    task: client => client.query(sql, params),
  });
  return result.rows.map(row => toIngestionFailureRecord(row));
}

export async function listSessionEvents(input: unknown) {
  const request = isRecord(input) ? input : {};
  const sessionId = normalizeRequiredText(request.sessionId, 'sessionId');
  const limit = normalizeLimit(request.limit, { fallback: 50, max: 500 });
  const since = normalizeOptionalTimestamp(request.since, 'since');

  const conditions = ['session_id = $1'];
  const params: unknown[] = [sessionId];

  if (since !== undefined) {
    params.push(since);
    conditions.push(`created_at >= $${String(params.length)}::timestamptz`);
  }

  params.push(limit);
  const limitParam = `$${String(params.length)}`;
  const whereClause = `WHERE ${conditions.join(' AND ')}`;
  const sql = `
    SELECT *
    FROM ai_session_events
    ${whereClause}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limitParam}
  `;

  const result = await runDbReadQuery({
    operation: 'list_session_events',
    task: client => client.query<SessionEventRow>(sql, params),
  });
  const events = [...result.rows].reverse().map(row => toSessionEventRecord(row));

  return {
    count: events.length,
    events,
    limit,
    sessionId,
    since,
  };
}

export function recordIngestionFailure(input: unknown) {
  const request = isRecord(input) ? input : {};
  const source = normalizeRequiredText(request.source, 'source');
  const stage = normalizeOptionalText(request.stage) ?? 'unknown';
  const sessionId = normalizeOptionalText(request.sessionId);
  const agent = normalizeOptionalText(request.agent);
  const repoId = normalizeOptionalText(request.repoId);
  const errorMessage = normalizeFailureMessage(request.errorMessage ?? request.error);
  const details = normalizeFailureDetails(request.details);
  return insertIngestionFailureWithClient(pool, {
    agent,
    details,
    errorMessage,
    repoId,
    sessionId,
    source,
    stage,
  });
}

export async function resolveSessionId(
  queryable: Queryable,
  params: {
    agent: string | undefined;
    project: string | undefined;
    repoId: string | undefined;
    sessionId: string | undefined;
  },
): Promise<SessionResolveResult | undefined> {
  const { agent, project, repoId, sessionId } = params;
  const repoFilter = repoId ?? project;

  // Priority 1: direct session_id lookup
  if (sessionId !== undefined) {
    const result = await queryable.query(`SELECT * FROM ai_sessions WHERE session_id = $1 LIMIT 1`, [sessionId]);
    const row = result.rows.at(0);
    if (
      row !== undefined &&
      (repoFilter === undefined || row.repo_id === repoFilter) &&
      (agent === undefined || row.agent === agent)
    ) {
      return { resolvedVia: 'direct', row, sessionId };
    }
    return undefined;
  }

  // Priority 2: scoped fallback by metadata
  // When both agent and repo are provided, first try exact match, then
  // relax repo_id to include NULL values (catches sessions stored without
  // repo_id) while preserving agent scope to prevent cross-agent matches.
  const hasMetadataFilter = agent !== undefined || repoFilter !== undefined;
  if (!hasMetadataFilter) {
    return undefined;
  }

  // Tier 1: exact match with all provided conditions
  const exactRow = await queryFallbackSession(queryable, { agent, repoFilter });
  if (exactRow !== undefined) {
    const resolvedId = typeof exactRow.session_id === 'string' ? exactRow.session_id : '';
    return { resolvedVia: 'fallback', row: exactRow, sessionId: resolvedId };
  }

  return undefined;
}

async function queryFallbackSession(queryable: Queryable, filters: FallbackFilter): Promise<SessionRow | undefined> {
  const conditions: string[] = [];
  const queryParams: unknown[] = [];

  if (filters.agent !== undefined) {
    queryParams.push(filters.agent);
    conditions.push(`agent = $${String(queryParams.length)}`);
  }

  if (filters.repoFilter !== undefined) {
    queryParams.push(filters.repoFilter);
    conditions.push(`repo_id = $${String(queryParams.length)}`);
  }

  if (conditions.length === 0) {
    return undefined;
  }

  const whereClause = conditions.join(' AND ');
  const sql =
    `SELECT * FROM ai_sessions WHERE ${whereClause} ` +
    `ORDER BY (status = 'active')::int DESC, updated_at DESC, session_id DESC LIMIT 1`;
  const result = await queryable.query(sql, queryParams);

  return result.rows.at(0);
}

/**
 * Phase-attributed bounded read for session/ingestion-failure queries. Wraps the
 * task in a transaction with per-call `SET LOCAL statement_timeout`, so server-
 * side cancellation enforces the budget and the connection is released within
 * budget — even if the caller-level wrapper would otherwise leave the pg query
 * running until the pool-wide `statement_timeout`. On `query_canceled`, the
 * helper re-throws a phase-attributed `TimeoutError(db.read.<operation>)` so
 * failure-signature aggregation can pinpoint the SQL step.
 */
function runDbReadQuery<T>(input: { operation: string; task: (client: DbClient) => Promise<T> }): Promise<T> {
  return runBoundedQuery({
    phase: `db.read.${input.operation}`,
    pool,
    task: input.task,
    timeoutMs: resolveTimeoutPolicy().db.readTimeoutMs,
  });
}
