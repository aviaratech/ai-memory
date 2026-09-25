import type { QueryResultRow } from 'pg';

import assert from 'node:assert/strict';
import { test } from 'vitest';

import { getSessionProjectWithClient, resolveSessionId } from './session-api.js';

interface QueryCall {
  params: unknown[];
  sql: string;
}

const FALLBACK_PATTERN = 'updated_at DESC, session_id DESC';
const DIRECT_PATTERN = 'session_id = $1';
const TEST_SESSION_ID = 'test-session-abc-123';
const TEST_AGENT = 'claude-code';
const TEST_REPO_ID = 'example/catalog';
const TEST_PROJECT = 'example/catalog';
const TEST_STARTED_AT = '2026-02-07T10:00:00.000Z';
const DIRECT_MATCH_ID = 'direct-match';
const EXPECT_FALLBACK = 'should return a fallback result';
const EXPECT_QUERY = 'should have a query';
const EXPECT_RESULT = 'should return a result';

test('session repository recovery is exact and requires qualified stored evidence', async () => {
  for (const [rows, expected] of [
    [[], undefined],
    [[{ repo_id: 'ai' }], undefined],
    [[{ repo_id: 'example/catalog' }], 'example/catalog'],
    [[{ repo_id: 'ai', repo_slug: 'other/ai' }], 'other/ai'],
  ] as const) {
    const calls: QueryCall[] = [];
    const result = await getSessionProjectWithClient(
      {
        query: (sql, params) => {
          calls.push({ params, sql });
          return Promise.resolve({ rows: [...rows] });
        },
      },
      TEST_SESSION_ID,
    );
    assert.equal(result, expected);
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call);
    assert.deepEqual(call.params, [TEST_SESSION_ID]);
    assert.match(call.sql, /WHERE session_id = \$1$/u);
  }
});

function createMockQueryable(responses: Map<string, { rowCount: number; rows: QueryResultRow[] }>) {
  const calls: QueryCall[] = [];
  return {
    calls,
    query(sql: string, params: unknown[] = []) {
      calls.push({ params, sql });
      for (const [pattern, response] of responses) {
        if (sql.includes(pattern)) {
          return Promise.resolve(response);
        }
      }
      return Promise.resolve({ rowCount: 0, rows: [] as QueryResultRow[] });
    },
  };
}

function createSessionRow(overrides?: Record<string, unknown>) {
  return {
    agent: TEST_AGENT,
    repo_id: TEST_REPO_ID,
    session_id: TEST_SESSION_ID,
    started_at: TEST_STARTED_AT,
    status: 'active',
    tool: 'claude-code',
    ...overrides,
  };
}

// --- Direct session_id lookup ---

test('resolveSessionId returns direct match when sessionId exists in database', async () => {
  const row = createSessionRow();
  const queryable = createMockQueryable(new Map([[DIRECT_PATTERN, { rowCount: 1, rows: [row] }]]));

  const result = await resolveSessionId(queryable, {
    agent: undefined,
    project: undefined,
    repoId: undefined,
    sessionId: TEST_SESSION_ID,
  });

  assert.ok(result !== undefined, EXPECT_RESULT);
  assert.equal(result.resolvedVia, 'direct');
  assert.equal(result.sessionId, TEST_SESSION_ID);
  assert.equal(result.row.session_id, TEST_SESSION_ID);
  assert.equal(queryable.calls.length, 1, 'should make exactly one query');
});

// --- Not found (no sessionId, no metadata) ---

test('resolveSessionId rejects an exact session in a foreign project or agent scope', async () => {
  for (const overrides of [{ repo_id: 'fixture/foreign' }, { agent: 'fixture-other-agent' }, { repo_id: null }]) {
    const queryable = createMockQueryable(
      new Map([[DIRECT_PATTERN, { rowCount: 1, rows: [createSessionRow(overrides)] }]]),
    );
    const result = await resolveSessionId(queryable, {
      agent: TEST_AGENT,
      project: TEST_PROJECT,
      repoId: undefined,
      sessionId: TEST_SESSION_ID,
    });
    assert.equal(result, undefined);
    assert.equal(queryable.calls.length, 1, 'an exact foreign identity must not fall back to project recency');
  }
});

test('resolveSessionId returns undefined when no sessionId and no metadata', async () => {
  const queryable = createMockQueryable(new Map());

  const result = await resolveSessionId(queryable, {
    agent: undefined,
    project: undefined,
    repoId: undefined,
    sessionId: undefined,
  });

  assert.equal(result, undefined);
  assert.equal(queryable.calls.length, 0, 'should not query the database');
});

// --- Not found (sessionId not in database, no metadata) ---

test('resolveSessionId returns undefined when sessionId not found and no metadata fallback', async () => {
  const queryable = createMockQueryable(new Map());

  const result = await resolveSessionId(queryable, {
    agent: undefined,
    project: undefined,
    repoId: undefined,
    sessionId: 'nonexistent-session-id',
  });

  assert.equal(result, undefined);
  assert.equal(queryable.calls.length, 1, 'should query for direct lookup');
});

// --- Fallback by agent + repoId ---

test('resolveSessionId never widens an absent exact sessionId to fallback metadata', async () => {
  const queryable = createMockQueryable(new Map());

  const result = await resolveSessionId(queryable, {
    agent: TEST_AGENT,
    project: undefined,
    repoId: TEST_REPO_ID,
    sessionId: 'nonexistent-id',
  });

  assert.equal(result, undefined);
  assert.equal(queryable.calls.length, 1, 'should make only the direct lookup');
});

// --- Fallback by agent + project ---

test('resolveSessionId falls back to agent + project (mapped to repo_id)', async () => {
  const fallbackRow = createSessionRow({
    session_id: 'project-fallback-session',
  });
  const queryable = createMockQueryable(new Map([[FALLBACK_PATTERN, { rowCount: 1, rows: [fallbackRow] }]]));

  const result = await resolveSessionId(queryable, {
    agent: TEST_AGENT,
    project: TEST_PROJECT,
    repoId: undefined,
    sessionId: undefined,
  });

  assert.ok(result !== undefined, EXPECT_FALLBACK);
  assert.equal(result.resolvedVia, 'fallback');
  assert.equal(result.sessionId, 'project-fallback-session');

  // Should have used project as repo_id filter
  const fallbackCall = queryable.calls.at(0);
  assert.ok(fallbackCall !== undefined, 'should have a fallback query');
  assert.ok(fallbackCall.sql.includes('agent ='), 'fallback should filter by agent');
  assert.ok(fallbackCall.sql.includes('repo_id ='), 'fallback should filter by repo_id');
  assert.deepEqual(fallbackCall.params, [TEST_AGENT, TEST_PROJECT]);
});

// --- Fallback with no match ---

test('resolveSessionId returns undefined when fallback finds no matching sessions', async () => {
  const queryable = createMockQueryable(new Map());

  const result = await resolveSessionId(queryable, {
    agent: TEST_AGENT,
    project: undefined,
    repoId: TEST_REPO_ID,
    sessionId: undefined,
  });

  assert.equal(result, undefined);
  // Scoped fallback tries exact agent+repo_id only (no NULL-repo relaxation)
  assert.equal(queryable.calls.length, 1, 'should try exact match only');
});

// --- Regression: no cross-repo matches ---

test('resolveSessionId does not return cross-repo sessions', async () => {
  // When agent+repo exact miss and agent+(repo OR NULL) also miss,
  // the function must NOT drop the agent constraint.
  const queryable = createMockQueryable(new Map());

  const result = await resolveSessionId(queryable, {
    agent: TEST_AGENT,
    project: undefined,
    repoId: TEST_REPO_ID,
    sessionId: undefined,
  });

  assert.equal(result, undefined, 'should return not_found rather than cross-repo match');
  // Verify no query was issued without agent scope
  for (const call of queryable.calls) {
    assert.ok(call.sql.includes('agent ='), 'all fallback queries must include agent filter');
  }
});

// --- Regression: no cross-agent matches ---

test('resolveSessionId does not return cross-agent sessions when agent is provided', async () => {
  // When both agent and repo are provided but nothing matches,
  // the function must NOT issue a repo-only query without agent.
  const queryable = createMockQueryable(new Map());

  const result = await resolveSessionId(queryable, {
    agent: TEST_AGENT,
    project: TEST_PROJECT,
    repoId: undefined,
    sessionId: undefined,
  });

  assert.equal(result, undefined, 'should return not_found rather than cross-agent match');
  // Verify no query dropped the agent filter
  for (const call of queryable.calls) {
    assert.ok(call.sql.includes('agent ='), 'all fallback queries must retain agent when provided');
  }
});

// --- Direct match takes priority over fallback ---

test('resolveSessionId prefers direct match over fallback metadata', async () => {
  const directRow = createSessionRow({ session_id: DIRECT_MATCH_ID });
  const queryable = createMockQueryable(new Map([[DIRECT_PATTERN, { rowCount: 1, rows: [directRow] }]]));

  const result = await resolveSessionId(queryable, {
    agent: TEST_AGENT,
    project: TEST_PROJECT,
    repoId: TEST_REPO_ID,
    sessionId: DIRECT_MATCH_ID,
  });

  assert.ok(result !== undefined, EXPECT_RESULT);
  assert.equal(result.resolvedVia, 'direct');
  assert.equal(result.sessionId, DIRECT_MATCH_ID);
  assert.equal(queryable.calls.length, 1, 'should only make direct lookup (no fallback)');
});

// --- Fallback with only repoId (no agent) ---

test('resolveSessionId handles fallback with only repoId', async () => {
  const fallbackRow = createSessionRow({ session_id: 'repo-only-session' });
  const queryable = createMockQueryable(new Map([[FALLBACK_PATTERN, { rowCount: 1, rows: [fallbackRow] }]]));

  const result = await resolveSessionId(queryable, {
    agent: undefined,
    project: undefined,
    repoId: TEST_REPO_ID,
    sessionId: undefined,
  });

  assert.ok(result !== undefined, EXPECT_FALLBACK);
  assert.equal(result.resolvedVia, 'fallback');

  const call = queryable.calls.at(0);
  assert.ok(call !== undefined, EXPECT_QUERY);
  assert.ok(call.sql.includes('repo_id ='), 'should filter by repo_id');
  assert.ok(!call.sql.includes('agent ='), 'should not filter by agent');
});

// --- Fallback prefers active sessions with deterministic ordering ---

test('resolveSessionId fallback uses activity-aware deterministic ordering', async () => {
  const fallbackRow = createSessionRow({ session_id: 'ordered-session' });
  const queryable = createMockQueryable(new Map([[FALLBACK_PATTERN, { rowCount: 1, rows: [fallbackRow] }]]));

  await resolveSessionId(queryable, {
    agent: TEST_AGENT,
    project: undefined,
    repoId: TEST_REPO_ID,
    sessionId: undefined,
  });

  const call = queryable.calls.at(0);
  assert.ok(call !== undefined, EXPECT_QUERY);
  assert.ok(call.sql.includes("(status = 'active')::int DESC"), 'should prefer active sessions');
  assert.ok(call.sql.includes('updated_at DESC'), 'should order by updated_at');
  assert.ok(call.sql.includes('session_id DESC'), 'should have session_id tie-breaker');
});

// --- Fallback with only agent (no repoId, no project) ---

test('resolveSessionId handles fallback with only agent', async () => {
  const fallbackRow = createSessionRow({ session_id: 'agent-only-session' });
  const queryable = createMockQueryable(new Map([[FALLBACK_PATTERN, { rowCount: 1, rows: [fallbackRow] }]]));

  const result = await resolveSessionId(queryable, {
    agent: TEST_AGENT,
    project: undefined,
    repoId: undefined,
    sessionId: undefined,
  });

  assert.ok(result !== undefined, EXPECT_FALLBACK);
  assert.equal(result.resolvedVia, 'fallback');

  const call = queryable.calls.at(0);
  assert.ok(call !== undefined, EXPECT_QUERY);
  assert.ok(call.sql.includes('agent ='), 'should filter by agent');
  assert.ok(!call.sql.includes('repo_id ='), 'should not filter by repo_id');
});
