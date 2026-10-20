/**
 * ai-memory MCP telemetry adapter for `ai_tool_invocations`.
 *
 * Responsibilities split:
 * - This module owns the canonical ai-memory INSERT and sanitizer.
 * - `SUMMARY_JSON_ALLOWLIST` and `buildSummaryJson` define ai-memory's
 *   redaction contract for MCP tool summaries. The allowlist is the complete
 *   redaction boundary — additions require explicit review.
 * - `queryToolInvocations` owns the health-report read path; it stays here
 *   because health-report semantics (allowlist-aware projections, retention
 *   window shapes) are an ai-memory concern.
 *
 * Redaction contract (SUMMARY_JSON_ALLOWLIST):
 *   Only these keys may appear in summary_json. The function never stores:
 *   - Raw prompt text or tool argument values
 *   - Token counts or cost data
 *   - Private keys, credentials, or PII
 *   Fields already persisted as dedicated columns are excluded from summary_json
 *   to avoid redundancy: tool_name, tool_category, status, response_status,
 *   duration_ms, warning_count, timeout_warning_count, resolved_via,
 *   write_disposition, invocation_id, session_id, project, repo_id.
 */
import type { Pool } from 'pg';

import { createHash } from 'node:crypto';

import { resolveTimeoutPolicy } from '../timeout-policy.js';
import { normalizeProjectScope } from './normalization.js';
import { runBoundedQuery } from './query-runner.js';
import { pool } from './runtime.js';

/**
 * Allowlisted keys for summary_json.
 * Only these keys from the combined request/response summary may be persisted.
 * This list is the complete redaction boundary — additions require explicit review.
 */
export const SUMMARY_JSON_ALLOWLIST = new Set<string>([
  'category',
  'context_needed_count',
  'continuity_complete',
  'continuity_pack_budget_chars',
  'continuity_pack_payload_chars',
  'continuity_pack_projection_chars',
  'continuity_pack_projection_truncated',
  'continuity_pack_status',
  'detected_source',
  'durable_memories_deduped',
  'durable_memories_stored',
  'environment_status',
  'event_limit',
  'events_ingested',
  'limit',
  'injected_memory_ids',
  'memory_host',
  'memory_observed_at',
  'memory_observation',
  'next_actions_count',
  'open_questions_count',
  'orient_payload_budget_chars',
  'orient_payload_budget_exceeded',
  'orient_payload_chars',
  'orient_payload_tokens_estimate',
  'query_length',
  'result_count',
  'search_budget_bytes',
  'search_budget_exceeded',
  'search_candidate_count',
  'search_detail',
  'search_requested_count',
  'search_response_bytes',
  'search_returned_count',
  'search_truncated',
  'since',
  'since_days',
  'source',
  'stage',
  'state_model_assumptions_count',
  'timed_out_steps',
  'used_memory_ids',
]);

export type MemoryHost = 'claude-code' | 'codex';
export interface MemoryHookIdentity {
  host: MemoryHost;
  project: string;
  sessionId: string;
}

export function parseConsumptionMemoryIds(value: unknown): number[] | undefined {
  try {
    const values: unknown = typeof value === 'string' ? JSON.parse(value) : value;
    if (
      !Array.isArray(values) ||
      values.length > 100 ||
      !values.every((id: unknown) => typeof id === 'number' && Number.isSafeInteger(id) && id > 0)
    )
      return undefined;
    return [...new Set(values as number[])];
  } catch {
    return undefined;
  }
}

function validatedHookIdentity(input: MemoryHookIdentity): MemoryHookIdentity {
  const project = normalizeProjectScope({ project: input.project });
  if (
    project === undefined ||
    project !== input.project ||
    project.length > 512 ||
    !['claude-code', 'codex'].includes(input.host) ||
    input.sessionId.trim() !== input.sessionId ||
    input.sessionId.length === 0 ||
    input.sessionId.length > 256
  )
    throw new Error('Invalid memory hook identity.');
  return input;
}

function promptMarkerId(input: MemoryHookIdentity): string {
  const identity = validatedHookIdentity(input);
  return `prompt-marker:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}

/** Startup is the only arming event. Existing consumed/unarmed markers are never reset. */
export async function armPromptRetrieval(input: MemoryHookIdentity): Promise<void> {
  await runBoundedQuery({
    phase: 'db.write.prompt_marker.arm',
    pool,
    timeoutMs: resolveTimeoutPolicy().db.writeTimeoutMs,
    task: async client => {
      await client.query(
        `INSERT INTO ai_tool_invocations
        (tool_name, tool_category, status, invocation_id, session_id, project, write_disposition, summary_json)
        VALUES ('memory_prompt_marker', 'lifecycle', 'ok', $1, $2, $3, 'pending', $4::jsonb)
        ON CONFLICT (invocation_id) WHERE invocation_id IS NOT NULL DO NOTHING`,
        [promptMarkerId(input), input.sessionId, input.project, JSON.stringify({ memory_host: input.host })],
      );
    },
  });
}

/** Missing/expired startup markers become ineligible; only one pending transition can win. */
export async function consumePromptRetrieval(input: MemoryHookIdentity): Promise<boolean> {
  return runBoundedQuery({
    phase: 'db.write.prompt_marker.consume',
    pool,
    timeoutMs: resolveTimeoutPolicy().db.writeTimeoutMs,
    task: async client => {
      const result = await client.query<{ write_disposition: string }>(
        `INSERT INTO ai_tool_invocations
        (tool_name, tool_category, status, invocation_id, session_id, project, write_disposition, summary_json)
        VALUES ('memory_prompt_marker', 'lifecycle', 'ok', $1, $2, $3, 'unarmed', $4::jsonb)
        ON CONFLICT (invocation_id) WHERE invocation_id IS NOT NULL DO UPDATE
          SET write_disposition = 'consumed'
          WHERE ai_tool_invocations.write_disposition = 'pending'
        RETURNING write_disposition`,
        [promptMarkerId(input), input.sessionId, input.project, JSON.stringify({ memory_host: input.host })],
      );
      return result.rows[0]?.write_disposition === 'consumed';
    },
  });
}

export interface MemoryConsumptionInput extends MemoryHookIdentity {
  kind: 'injected' | 'used';
  memoryIds: number[];
  observation: 'citation' | 'get' | 'prompt';
  observedAt?: string;
}

/** ID-only observations share the existing telemetry sanitizer and retention. */
export async function recordMemoryConsumption(input: MemoryConsumptionInput): Promise<void> {
  validatedHookIdentity(input);
  let memoryIds = parseConsumptionMemoryIds(input.memoryIds);
  if (memoryIds === undefined || memoryIds.length === 0) return;
  const observedAt = input.observedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error('Invalid observation timestamp.');
  if (input.kind === 'used') {
    const injected = await runBoundedQuery({
      phase: 'db.read.injected_memory_ids',
      pool,
      timeoutMs: resolveTimeoutPolicy().db.readTimeoutMs,
      task: client =>
        client.query<{ injected_memory_ids: string; memory_observed_at: string }>(
          `SELECT summary_json->>'injected_memory_ids' AS injected_memory_ids,
          summary_json->>'memory_observed_at' AS memory_observed_at
        FROM ai_tool_invocations WHERE tool_name='memory_injected' AND status='ok'
          AND project=$1 AND session_id=$2 AND summary_json->>'memory_host'=$3
          AND created_at <= $4::timestamptz ORDER BY created_at DESC LIMIT 100`,
          [input.project, input.sessionId, input.host, observedAt],
        ),
    });
    const allowed = new Set(
      injected.rows.flatMap(row =>
        Date.parse(row.memory_observed_at) < Date.parse(observedAt)
          ? (parseConsumptionMemoryIds(row.injected_memory_ids) ?? [])
          : [],
      ),
    );
    memoryIds = memoryIds.filter(id => allowed.has(id));
    if (memoryIds.length === 0) return;
  }
  const summaryFields = {
    memory_host: input.host,
    memory_observed_at: new Date(observedAt).toISOString(),
    memory_observation: input.observation,
    [input.kind === 'injected' ? 'injected_memory_ids' : 'used_memory_ids']: JSON.stringify(memoryIds),
  };
  const invocationId = `memory-consumption:${createHash('sha256')
    .update(JSON.stringify([input.host, input.project, input.sessionId, input.kind, summaryFields]))
    .digest('hex')}`;
  await recordToolInvocation({
    durationMs: null,
    invocationId,
    project: input.project,
    sessionId: input.sessionId,
    status: 'ok',
    summaryFields,
    timeoutWarningCount: 0,
    toolCategory: 'lifecycle',
    toolName: `memory_${input.kind}`,
    warningCount: 0,
  });
}

export interface ToolInvocationInput {
  durationMs: null | number;
  invocationId: string;
  project?: string | undefined;
  repoId?: string | undefined;
  resolvedVia?: string | undefined;
  responseStatus?: string | undefined;
  sessionId?: string | undefined;
  status: 'error' | 'ok';
  /** Combined request + response summary fields (both already sanitized by summarizeToolArgs/summarizeToolPayload) */
  summaryFields: Record<string, number | string>;
  timeoutWarningCount: number;
  toolCategory: string;
  toolName: string;
  warningCount: number;
  writeDisposition?: string | undefined;
}

export interface ToolInvocationRow {
  created_at: string;
  durable_memories_deduped: number;
  duration_ms: null | number;
  environment_status: string;
  memory_category: string;
  orient_payload_budget_chars: number;
  orient_payload_budget_exceeded: number;
  orient_payload_chars: number;
  orient_payload_tokens_estimate: number;
  project: null | string;
  resolved_via: string;
  response_status: string;
  session_id: null | string;
  status: string;
  timeout_warning_count: number;
  tool_category: string;
  tool_name: string;
  warning_count: number;
  write_disposition: string;
}

export interface MemoryConsumptionRow {
  created_at: string;
  injected_memory_ids: string;
  memory_host: string;
  memory_observation: string;
  memory_observed_at: string;
  project: string | null;
  session_id: string | null;
  tool_name: string;
  used_memory_ids: string;
}

export async function queryMemoryConsumption(input: {
  dbPool: Pool;
  windowStartIso: string;
  windowEndIso: string;
}): Promise<MemoryConsumptionRow[]> {
  const result = await input.dbPool.query<MemoryConsumptionRow>(
    `SELECT created_at::text AS created_at, tool_name, session_id, project,
    COALESCE(summary_json->>'memory_host', '') AS memory_host,
    COALESCE(summary_json->>'memory_observation', '') AS memory_observation,
    COALESCE(summary_json->>'memory_observed_at', '') AS memory_observed_at,
    COALESCE(summary_json->>'injected_memory_ids', '') AS injected_memory_ids,
    COALESCE(summary_json->>'used_memory_ids', '') AS used_memory_ids
    FROM ai_tool_invocations WHERE tool_name IN ('memory_injected', 'memory_used') AND status='ok'
      AND created_at >= $1::timestamptz AND created_at <= $2::timestamptz`,
    [input.windowStartIso, input.windowEndIso],
  );
  return result.rows;
}

/**
 * Build summary_json from a combined summary map.
 * Applies SUMMARY_JSON_ALLOWLIST: only allowlisted keys are included.
 * Fields already stored as dedicated columns are excluded automatically
 * because they are not in the allowlist.
 */
export function buildSummaryJson(fields: Record<string, number | string>): Record<string, number | string> {
  const result: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'continuity_pack_projection_chars' || key === 'continuity_pack_projection_truncated') {
      if (
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value >= 0 &&
        (key === 'continuity_pack_projection_chars' || value <= 1)
      )
        result[key] = value;
      continue;
    }
    if (key === 'injected_memory_ids' || key === 'used_memory_ids') {
      const ids = parseConsumptionMemoryIds(value);
      if (ids !== undefined) result[key] = JSON.stringify(ids);
      continue;
    }
    if (key === 'memory_host') {
      if (value === 'codex' || value === 'claude-code') result[key] = value;
      continue;
    }
    if (key === 'memory_observed_at') {
      if (
        typeof value === 'string' &&
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) &&
        Number.isFinite(Date.parse(value))
      )
        result[key] = value;
      continue;
    }
    if (key === 'memory_observation') {
      if (value === 'prompt' || value === 'get' || value === 'citation') result[key] = value;
      continue;
    }
    if (SUMMARY_JSON_ALLOWLIST.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Query tool invocations for health-report DB-first metrics.
 * Returns rows in the window with the fields needed to build McpUsageMetrics.
 */
export async function queryToolInvocations({
  dbPool,
  windowEndIso,
  windowStartIso,
}: {
  dbPool: Pool;
  windowEndIso: string;
  windowStartIso: string;
}): Promise<ToolInvocationRow[]> {
  const sql = `
    SELECT
      tool_name,
      tool_category,
      status,
      COALESCE(response_status, '') AS response_status,
      duration_ms,
      warning_count,
      timeout_warning_count,
      COALESCE(resolved_via, '') AS resolved_via,
      COALESCE(write_disposition, '') AS write_disposition,
      COALESCE((summary_json->>'durable_memories_deduped')::int, 0) AS durable_memories_deduped,
      COALESCE(summary_json->>'environment_status', '') AS environment_status,
      COALESCE((summary_json->>'orient_payload_chars')::int, 0) AS orient_payload_chars,
      COALESCE((summary_json->>'orient_payload_tokens_estimate')::int, 0) AS orient_payload_tokens_estimate,
      COALESCE((summary_json->>'orient_payload_budget_chars')::int, 0) AS orient_payload_budget_chars,
      COALESCE((summary_json->>'orient_payload_budget_exceeded')::int, 0) AS orient_payload_budget_exceeded,
      created_at::text AS created_at,
      session_id,
      project,
      COALESCE(summary_json->>'category', '') AS memory_category
    FROM ai_tool_invocations
    WHERE created_at >= $1::timestamptz
      AND created_at <= $2::timestamptz
  `;
  const result = await dbPool.query<ToolInvocationRow>(sql, [windowStartIso, windowEndIso]);
  return result.rows;
}

/**
 * Sanitize and persist an ai-memory MCP tool invocation.
 *
 * Runs `buildSummaryJson` (SUMMARY_JSON_ALLOWLIST) over the caller-supplied
 * `summaryFields` before writing the canonical table. Best-effort: callers should swallow rejections so
 * telemetry failures never break tool responses.
 */
export async function recordToolInvocation(input: ToolInvocationInput): Promise<void> {
  await pool.query(
    `INSERT INTO ai_tool_invocations (
      timestamp, tool_name, tool_category, status, response_status, duration_ms,
      warning_count, timeout_warning_count, resolved_via, write_disposition,
      invocation_id, session_id, project, repo_id, summary_json
    ) VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    ON CONFLICT (invocation_id) WHERE invocation_id IS NOT NULL DO NOTHING`,
    [
      input.toolName,
      input.toolCategory,
      input.status,
      input.responseStatus ?? null,
      input.durationMs,
      input.warningCount,
      input.timeoutWarningCount,
      input.resolvedVia ?? null,
      input.writeDisposition ?? null,
      input.invocationId,
      input.sessionId ?? null,
      input.project ?? null,
      input.repoId ?? null,
      JSON.stringify(buildSummaryJson(input.summaryFields)),
    ],
  );
}
