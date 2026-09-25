/**
 * Regression tests for the ai-memory `recordToolInvocation` wrapper.
 *
 * The wrapper:
 *   1. Sanitizes summary fields via SUMMARY_JSON_ALLOWLIST (`buildSummaryJson`).
 *   2. Inserts into the memory-owned invocation table.
 *
 * These tests guard:
 *   - SQL is the canonical INSERT into `ai_tool_invocations` with 14 params.
 *   - `summary_json` is the redacted allowlist projection (non-empty when
 *     allowlisted fields are present; empty when only column-stored fields
 *     are present). Regression: the write path was silently
 *     disconnected and produced 0 rows in the 7d health-report window.
 *   - All rich ai-memory columns reach the canonical writer.
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { afterEach, test, vi } from 'vitest';

afterEach(() => {
  mock.restoreAll();
});

const SUMMARY_JSON_PARAM_INDEX = 13;
const INVOCATION_ID_PARAM_INDEX = 9;

test('recordToolInvocation writes canonical INSERT with redacted summary_json and rich columns', async () => {
  const mockQuery = mock.fn<(sql: string, params?: unknown[]) => Promise<{ rows: never[] }>>(() =>
    Promise.resolve({ rows: [] }),
  );

  vi.doMock('./runtime.js', () => ({
    pool: { query: mockQuery },
  }));

  const { recordToolInvocation } = await import('./tool-invocations.js');

  // --- Case 1: allowlisted fields present → non-empty summary_json ---
  await recordToolInvocation({
    durationMs: 42,
    invocationId: 'test-invocation-id',
    status: 'ok',
    summaryFields: {
      category: 'root-cause',
      context_needed_count: 1,
      result_count: 3,
      // These should be redacted by SUMMARY_JSON_ALLOWLIST:
      tool_name: 'memory_search',
      warning_count: 0,
    },
    timeoutWarningCount: 0,
    toolCategory: 'read',
    toolName: 'memory_search',
    warningCount: 0,
  });

  assert.equal(mockQuery.mock.calls.length, 1, 'pool.query should be called exactly once');

  const firstCall = mockQuery.mock.calls[0];
  if (firstCall === undefined) {
    assert.fail('expected a call to pool.query');
  }
  const [sql, params] = firstCall.arguments as [string, unknown[]];

  assert.ok(typeof sql === 'string' && sql.includes('INSERT INTO ai_tool_invocations'), 'SQL should be an INSERT');
  assert.ok(
    sql.includes('ON CONFLICT (invocation_id) WHERE invocation_id IS NOT NULL'),
    'SQL should preserve idempotent ON CONFLICT clause',
  );
  assert.equal(params.length, 14, 'canonical writer should pass 14 params');

  const summaryJsonArg = params[SUMMARY_JSON_PARAM_INDEX];
  assert.ok(
    typeof summaryJsonArg === 'string' && summaryJsonArg.length > 2,
    'summary_json should be a non-empty JSON string',
  );

  const parsed = JSON.parse(summaryJsonArg) as Record<string, unknown>;
  assert.equal(parsed.category, 'root-cause', 'allowlisted field category should be in summary_json');
  assert.equal(parsed.context_needed_count, 1, 'allowlisted field context_needed_count should be in summary_json');
  assert.equal(parsed.result_count, 3, 'allowlisted field result_count should be in summary_json');
  assert.ok(!('tool_name' in parsed), 'column-stored tool_name must be redacted from summary_json');
  assert.ok(!('warning_count' in parsed), 'column-stored warning_count must be redacted from summary_json');

  // --- Case 2: no allowlisted fields → empty summary_json ---
  mockQuery.mock.resetCalls();

  await recordToolInvocation({
    durationMs: 10,
    invocationId: 'test-no-summary',
    status: 'error',
    summaryFields: { tool_name: 'memory_store', warning_count: 1 },
    timeoutWarningCount: 0,
    toolCategory: 'write',
    toolName: 'memory_store',
    warningCount: 1,
  });

  assert.equal(mockQuery.mock.calls.length, 1, 'pool.query should be called exactly once in case 2');

  const secondCall = mockQuery.mock.calls[0];
  if (secondCall === undefined) {
    assert.fail('expected a second call to pool.query');
  }
  const [, params2] = secondCall.arguments as [string, unknown[]];
  const summaryJsonArg2 = params2[SUMMARY_JSON_PARAM_INDEX];
  assert.ok(typeof summaryJsonArg2 === 'string', 'summary_json should be a string in case 2');

  const parsed2 = JSON.parse(summaryJsonArg2) as Record<string, unknown>;
  assert.deepEqual(parsed2, {}, 'summary_json should be empty when no allowlisted fields are present');

  // --- Case 3: rich ai-memory columns are forwarded to the canonical writer ---
  mockQuery.mock.resetCalls();

  await recordToolInvocation({
    durationMs: 137,
    invocationId: 'rich-1',
    project: 'example/catalog',
    repoId: 'example/catalog',
    resolvedVia: 'direct',
    responseStatus: 'ok',
    sessionId: 'session-rich',
    status: 'ok',
    summaryFields: {
      category: 'decision',
      result_count: 5,
    },
    timeoutWarningCount: 1,
    toolCategory: 'read',
    toolName: 'memory_orient',
    warningCount: 2,
    writeDisposition: 'insert',
  });

  assert.equal(mockQuery.mock.calls.length, 1, 'pool.query should be called exactly once in case 3');
  const thirdCall = mockQuery.mock.calls[0];
  if (thirdCall === undefined) {
    assert.fail('expected a third call to pool.query');
  }
  const [, params3] = thirdCall.arguments as [string, unknown[]];
  assert.equal(params3.length, 14);
  assert.equal(params3[0], 'memory_orient'); // tool_name
  assert.equal(params3[1], 'read'); // tool_category
  assert.equal(params3[2], 'ok'); // status
  assert.equal(params3[3], 'ok'); // response_status
  assert.equal(params3[4], 137); // duration_ms
  assert.equal(params3[5], 2); // warning_count
  assert.equal(params3[6], 1); // timeout_warning_count
  assert.equal(params3[7], 'direct'); // resolved_via
  assert.equal(params3[8], 'insert'); // write_disposition
  assert.equal(params3[INVOCATION_ID_PARAM_INDEX], 'rich-1'); // invocation_id
  assert.equal(params3[10], 'session-rich'); // session_id
  assert.equal(params3[11], 'example/catalog'); // project
  assert.equal(params3[12], 'example/catalog'); // repo_id

  const parsed3 = JSON.parse(params3[SUMMARY_JSON_PARAM_INDEX] as string) as Record<string, unknown>;
  assert.equal(parsed3.category, 'decision');
  assert.equal(parsed3.result_count, 5);
});
