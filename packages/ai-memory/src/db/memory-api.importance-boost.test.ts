import type { QueryResult, QueryResultRow } from 'pg';

import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { afterEach, describe, it } from 'vitest';

import { recallMemories, searchMemories } from './memory-api.js';
import { pool as runtimePool } from './runtime.js';
import { mockPoolConnect } from './test-pool-mock.js';

interface CapturedCall {
  params: readonly unknown[] | undefined;
  sql: string;
}

const IMPORTANCE_BOOST_SQL_MARKER = 'importance = LEAST';
const ASYNC_BOOST_POLL_LIMIT = 20;

function buildBaseRow(overrides: Record<string, unknown> = {}) {
  return {
    category: 'decision',
    confidence: 0.85,
    content: 'Importance boost behavior should be tested for returned rows.',
    created_at: new Date('2026-02-22T00:00:00.000Z'),
    decayed_importance: 0.7,
    dedupe_hash: 'sha256:test',
    evidence_refs: [],
    id: 91,
    metadata_json: {},
    project: 'example/catalog',
    source: 'codex-test',
    status: 'active',
    tags: ['importance', 'boost'],
    updated_at: new Date('2026-02-22T00:00:00.000Z'),
    ...overrides,
  };
}

function toQueryResult(rows: QueryResultRow[]): QueryResult<QueryResultRow> {
  return {
    command: 'SELECT',
    fields: [],
    oid: 0,
    rowCount: rows.length,
    rows,
  };
}

async function waitForSqlPattern(calls: { sql: string }[], pattern: string): Promise<void> {
  // The boost is fire-and-forget on top of `pool.connect()`, so the UPDATE SQL
  // does not reach the test handler until a few microtasks after the caller
  // returns. Poll briefly so tests do not race the bounded transaction setup
  // (BEGIN → SET LOCAL → UPDATE → COMMIT).
  for (let i = 0; i < ASYNC_BOOST_POLL_LIMIT; i += 1) {
    if (calls.some(call => call.sql.includes(pattern))) {
      return;
    }
    await new Promise(resolve => setImmediate(resolve));
  }
}

describe('memory access importance boosts', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('recallMemories returns before async boost query resolves and uses throttle params', async () => {
    const calls: CapturedCall[] = [];
    let resolveBoost: (() => void) | undefined;
    const pendingBoost = new Promise<QueryResult<QueryResultRow>>(resolve => {
      resolveBoost = () => {
        resolve({
          command: 'UPDATE',
          fields: [],
          oid: 0,
          rowCount: 1,
          rows: [],
        });
      };
    });

    mockPoolConnect((sql: string, params?: readonly unknown[]) => {
      calls.push({ params, sql });
      if (sql.includes('UPDATE ai_memory_entries') && sql.includes(IMPORTANCE_BOOST_SQL_MARKER)) {
        return pendingBoost;
      }
      return Promise.resolve(toQueryResult([buildBaseRow()]));
    });

    const memories = await recallMemories({ limit: 1, sinceDays: 30 });
    assert.equal(memories.length, 1, 'recall should return without waiting for boost update');

    await waitForSqlPattern(calls, IMPORTANCE_BOOST_SQL_MARKER);

    const boostCall = calls.find(call => call.sql.includes(IMPORTANCE_BOOST_SQL_MARKER));
    assert.ok(boostCall !== undefined, 'boost update should be issued');
    const boostParams = boostCall.params;
    assert.ok(boostParams !== undefined, 'boost update should include params');
    assert.deepEqual(boostParams[0], [91], 'should boost only returned memory ids');
    assert.equal(boostParams[1], 0.02, 'should increment importance by +0.02');
    assert.equal(boostParams[2], 24, 'should throttle boosts to one per 24 hours');
    assert.ok(boostCall.sql.includes('updated_at <= NOW() - make_interval(hours => $3::int)'));

    resolveBoost?.();
  });

  it('searchMemories schedules boost only for reranked returned rows', async () => {
    const calls: CapturedCall[] = [];

    mockPoolConnect((sql: string, params?: readonly unknown[]) => {
      calls.push({ params, sql });
      if (sql.includes('WITH filtered_candidates')) {
        return Promise.resolve(
          toQueryResult([
            buildBaseRow({
              id: 111,
              keyword_hint: 1,
              or_semantic_relevance: 0.1,
              semantic_relevance: 0.2,
            }),
          ]),
        );
      }
      return Promise.resolve(
        toQueryResult([
          {
            id: 111,
          },
        ]),
      );
    });

    const memories = await searchMemories({
      limit: 5,
      query: 'importance boost retrieval ranking',
    });
    assert.equal(memories.length, 1);

    await waitForSqlPattern(calls, IMPORTANCE_BOOST_SQL_MARKER);

    const boostCall = calls.find(call => call.sql.includes(IMPORTANCE_BOOST_SQL_MARKER));
    assert.ok(boostCall !== undefined, 'search results should trigger boost update');
    const boostParams = boostCall.params;
    assert.ok(boostParams !== undefined, 'boost update should include params');
    assert.deepEqual(boostParams[0], [111], 'only returned ids should be boosted');
  });

  it('background importance boost runs through pool.connect() (bounded transaction), not direct pool.query()', async () => {
    // Regression: the boost update used to fire-and-forget via direct
    // `pool.query(...)` — a hidden, unbounded write that could outlive any
    // caller timeout. After F4 the boost runs inside `runBoundedQuery`, which
    // acquires a client via `pool.connect()` and issues BEGIN/SET LOCAL/UPDATE/
    // COMMIT on it. This test proves the boost path goes through `pool.connect`
    // (bounded) rather than `pool.query` (unbounded).
    const directPoolQueryCalls: { sql: string }[] = [];
    const connectClientSqlCalls: { sql: string }[] = [];
    let resolveBoostUpdate: ((value: QueryResult<QueryResultRow>) => void) | undefined;
    const pendingBoostUpdate = new Promise<QueryResult<QueryResultRow>>(resolve => {
      resolveBoostUpdate = resolve;
    });

    mock.method(runtimePool, 'connect', () => {
      let sawSetLocal = false;
      return Promise.resolve({
        query: (sql: string) => {
          connectClientSqlCalls.push({ sql });
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
            return Promise.resolve({ command: 'SET', fields: [], oid: 0, rowCount: 0, rows: [] });
          }
          if (sql.startsWith('SET LOCAL statement_timeout')) {
            sawSetLocal = true;
            return Promise.resolve({ command: 'SET', fields: [], oid: 0, rowCount: 0, rows: [] });
          }
          if (sql.includes(IMPORTANCE_BOOST_SQL_MARKER)) {
            assert.ok(sawSetLocal, 'SET LOCAL statement_timeout must be issued before the boost UPDATE');
            return pendingBoostUpdate;
          }
          return Promise.resolve(toQueryResult([buildBaseRow({ id: 501 })]));
        },
        release: () => undefined,
      });
    });
    mock.method(runtimePool, 'query', (sql: string) => {
      directPoolQueryCalls.push({ sql });
      return Promise.resolve(toQueryResult([buildBaseRow({ id: 501 })]));
    });

    const memories = await recallMemories({ limit: 1, sinceDays: 30 });
    assert.equal(memories.length, 1);

    await waitForSqlPattern(connectClientSqlCalls, IMPORTANCE_BOOST_SQL_MARKER);

    const boostUpdateOnConnect = connectClientSqlCalls.some(call => call.sql.includes(IMPORTANCE_BOOST_SQL_MARKER));
    assert.ok(
      boostUpdateOnConnect,
      `boost UPDATE must run on a pool.connect() client (bounded path); observed connect SQL: ${JSON.stringify(connectClientSqlCalls.map(c => c.sql))}`,
    );
    const directBoost = directPoolQueryCalls.some(call => call.sql.includes(IMPORTANCE_BOOST_SQL_MARKER));
    assert.equal(directBoost, false, 'boost UPDATE must NOT run as direct pool.query() (unbounded path)');

    resolveBoostUpdate?.({
      command: 'UPDATE',
      fields: [],
      oid: 0,
      rowCount: 1,
      rows: [],
    });
    await pendingBoostUpdate;
  });
});
