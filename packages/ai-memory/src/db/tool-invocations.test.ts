/**
 * Tests for the ai_tool_invocations DB telemetry module (Issue 1466, Issue 1b).
 *
 * Covers:
 * 1. summary_json redaction contract: only allowlisted keys are persisted
 * 2. Allowlisted fields are preserved intact
 * 3. Fields stored as dedicated columns are not duplicated in summary_json
 * 4. Empty input produces empty summary_json
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { buildSummaryJson, SUMMARY_JSON_ALLOWLIST } from './tool-invocations.js';

// --- buildSummaryJson redaction contract ---

test('buildSummaryJson passes allowlisted fields through intact', () => {
  const input: Record<string, number | string> = {
    category: 'root-cause',
    context_needed_count: 1,
    continuity_complete: 1,
    continuity_pack_budget_chars: 6000,
    continuity_pack_payload_chars: 1420,
    continuity_pack_status: 'found',
    detected_source: 'gpt-builder',
    durable_memories_deduped: 2,
    durable_memories_stored: 3,
    environment_status: 'local_fallback',
    event_limit: 50,
    events_ingested: 5,
    limit: 10,
    next_actions_count: 2,
    open_questions_count: 1,
    orient_payload_budget_chars: 8000,
    orient_payload_budget_exceeded: 0,
    orient_payload_chars: 4200,
    orient_payload_tokens_estimate: 1050,
    query_length: 120,
    result_count: 4,
    search_budget_bytes: 16384,
    search_budget_exceeded: 1,
    search_candidate_count: 8,
    search_detail: 'compact',
    search_requested_count: 8,
    search_response_bytes: 12000,
    search_returned_count: 4,
    search_truncated: 1,
    since: '7d',
    since_days: 7,
    source: 'claude-code',
    stage: 'memory_store',
    state_model_assumptions_count: 1,
    timed_out_steps: 'db.read.search_memories,db.read.search_memories.reversal_penalty',
  };

  const result = buildSummaryJson(input);

  for (const key of SUMMARY_JSON_ALLOWLIST) {
    assert.ok(key in result, `Expected allowlisted key '${key}' to be present in summary_json`);
    assert.equal(result[key], input[key], `Expected key '${key}' to have value '${String(input[key])}'`);
  }
  assert.equal(
    Object.keys(result).length,
    SUMMARY_JSON_ALLOWLIST.size,
    'summary_json should contain exactly the allowlisted keys',
  );
});

test('buildSummaryJson redacts column-stored fields that are not in the allowlist', () => {
  const input: Record<string, number | string> = {
    api_key: 'sk-secret',
    // These are stored as dedicated columns — must not appear in summary_json
    duration_ms: 42,
    invocation_id: 'abc-123',
    project: 'example/catalog',
    // Also must redact any hypothetical raw args or private data
    raw_prompt: 'this must never appear',
    repo_id: 'my-repo',
    resolved_via: 'direct',
    response_status: 'ok',
    session_id: 'session-abc',
    status: 'ok',
    timeout_warning_count: 0,
    token_count: 9999,
    tool_category: 'read',
    tool_name: 'memory_orient',
    warning_count: 1,
    write_disposition: 'insert',
  };

  const result = buildSummaryJson(input);

  const forbiddenKeys = [
    'duration_ms',
    'invocation_id',
    'project',
    'repo_id',
    'resolved_via',
    'response_status',
    'session_id',
    'status',
    'timeout_warning_count',
    'tool_category',
    'tool_name',
    'warning_count',
    'write_disposition',
    'raw_prompt',
    'token_count',
    'api_key',
  ];
  for (const key of forbiddenKeys) {
    assert.ok(!(key in result), `Expected key '${key}' to be redacted from summary_json`);
  }
});

test('buildSummaryJson returns empty object for empty input', () => {
  const result = buildSummaryJson({});
  assert.deepEqual(result, {});
});

test('buildSummaryJson returns empty object when no allowlisted keys are present', () => {
  const input: Record<string, number | string> = {
    duration_ms: 100,
    status: 'ok',
    tool_name: 'memory_orient',
  };
  const result = buildSummaryJson(input);
  assert.deepEqual(result, {});
});

test('buildSummaryJson handles mixed allowlisted and non-allowlisted keys', () => {
  const input: Record<string, number | string> = {
    category: 'decision',
    result_count: 5,
    session_id: 'abc', // column-stored, not in allowlist
    tool_name: 'memory_search', // column-stored, not in allowlist
  };

  const result = buildSummaryJson(input);

  assert.equal(result.category, 'decision', 'allowlisted category should be present');
  assert.equal(result.result_count, 5, 'allowlisted result_count should be present');
  assert.ok(!('tool_name' in result), 'tool_name should be redacted (column-stored)');
  assert.ok(!('session_id' in result), 'session_id should be redacted (column-stored)');
});

// --- removed intervention telemetry fields are redacted ---

test('buildSummaryJson redacts removed intervention telemetry fields', () => {
  const result = buildSummaryJson({
    confidence_adjustment_applied: 1,
    confidence_adjustment_from: 'high',
    confidence_adjustment_to: 'low',
    intervention_active: 1,
    intervention_active_signal_count: 2,
    intervention_adoption: 'used',
  });
  assert.ok(!('intervention_active' in result), 'intervention_active should be redacted');
  assert.ok(!('intervention_active_signal_count' in result), 'intervention_active_signal_count should be redacted');
  assert.ok(!('confidence_adjustment_applied' in result), 'confidence_adjustment_applied should be redacted');
  assert.ok(!('confidence_adjustment_from' in result), 'confidence_adjustment_from should be redacted');
  assert.ok(!('confidence_adjustment_to' in result), 'confidence_adjustment_to should be redacted');
  assert.ok(!('intervention_adoption' in result), 'intervention_adoption should be redacted');
});

// --- SUMMARY_JSON_ALLOWLIST completeness ---

test('SUMMARY_JSON_ALLOWLIST does not include column-stored fields', () => {
  const columnStoredFields = [
    'tool_name',
    'tool_category',
    'status',
    'response_status',
    'duration_ms',
    'warning_count',
    'timeout_warning_count',
    'resolved_via',
    'write_disposition',
    'invocation_id',
    'session_id',
    'project',
    'repo_id',
  ];
  for (const field of columnStoredFields) {
    assert.ok(
      !SUMMARY_JSON_ALLOWLIST.has(field),
      `Column-stored field '${field}' must not be in SUMMARY_JSON_ALLOWLIST to avoid redundancy`,
    );
  }
});

test('SUMMARY_JSON_ALLOWLIST does not include raw prompt, credential fields, or raw token totals', () => {
  const forbiddenPatterns = ['prompt', 'token', 'key', 'secret', 'credential', 'password', 'auth'];
  for (const field of SUMMARY_JSON_ALLOWLIST) {
    if (field === 'orient_payload_tokens_estimate') {
      continue;
    }
    for (const pattern of forbiddenPatterns) {
      assert.ok(
        !field.toLowerCase().includes(pattern),
        `SUMMARY_JSON_ALLOWLIST field '${field}' looks like it may contain sensitive data (matches pattern '${pattern}')`,
      );
    }
  }
});

test('search response metrics retain only content-free allowlisted fields', () => {
  const metrics = {
    search_budget_bytes: 16384,
    search_budget_exceeded: 1,
    search_candidate_count: 8,
    search_detail: 'compact',
    search_requested_count: 8,
    search_response_bytes: 12000,
    search_returned_count: 3,
    search_truncated: 1,
  };
  assert.deepEqual(
    buildSummaryJson({
      ...metrics,
      content: 'secret body',
      evidence: 'secret evidence',
      query: 'secret query',
      response: 'raw payload',
    }),
    metrics,
  );
});
