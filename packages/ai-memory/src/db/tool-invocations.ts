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
  'continuity_pack_status',
  'detected_source',
  'durable_memories_deduped',
  'durable_memories_stored',
  'environment_status',
  'event_limit',
  'events_ingested',
  'limit',
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
]);

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

/**
 * Build summary_json from a combined summary map.
 * Applies SUMMARY_JSON_ALLOWLIST: only allowlisted keys are included.
 * Fields already stored as dedicated columns are excluded automatically
 * because they are not in the allowlist.
 */
export function buildSummaryJson(fields: Record<string, number | string>): Record<string, number | string> {
  const result: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(fields)) {
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
