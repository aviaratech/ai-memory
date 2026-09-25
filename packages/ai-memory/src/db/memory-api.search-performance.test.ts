/**
 * High-cardinality search performance + SQL-shape regression test.
 *
 * Proves three things about the default `searchMemories` path:
 *
 *   1. The actual generated default-search SQL is the hybrid CTE pipeline
 *      (`filtered_candidates` -> `semantic_candidates` / `keyword_candidates` /
 *      `vector_candidates` -> `combined_candidates` -> `deduped_candidates`),
 *      and it uses index-compatible predicates (`websearch_to_tsquery`,
 *      `ts_rank_cd`, `embedding <=> $::vector`). The captured-SQL fixture pins
 *      this shape so a refactor that silently drops a CTE or rewrites a
 *      predicate into a non-index-using form fails this test instead of
 *      degrading production search latency.
 *
 *   2. The deterministic token-fallback SQL is still index-compatible
 *      (`ILIKE '%token%'` -> trigram GIN, `tags @> ARRAY[...]` -> tags GIN),
 *      and the fallback path is deterministic across runs.
 *
 *   3. JS-side processing (rerank + reversal-penalty + dedupe) on a
 *      high-cardinality 1 000-row mock result completes in well under the
 *      5s read budget. This is the JS-overhead bound; the server-side budget
 *      is separately enforced by `runBoundedQuery`'s
 *      `SET LOCAL statement_timeout` (covered by
 *      `query-runner.test.ts` + `flush-session.bounded-timeout.test.ts`).
 *
 * Without a real Postgres instance available to unit tests, the SQL-shape
 * fixture is the strongest available guarantee that the default search path
 * keeps using indexable predicates. The bounded-query helper handles the
 * server-side enforcement of the read budget.
 *
 * The project-approved live-DB evidence path is the operator-run search
 * evaluator at
 * `packages/ai-memory-tools/src/eval/search-eval.ts`
 * (`pnpm --filter @aviaratech/ai-memory run test:search-eval`). That harness
 * seeds a real DB and runs the real `searchMemories` SQL end-to-end. The
 * rationale for keeping the unit gate on SQL-shape + JS bound + bounded
 * server-side enforcement (rather than coupling every PR to live Postgres)
 * is committed in `docs/architecture/adr-ai-memory-bounded-timeout.md`
 * under the "Search Performance Evidence" section.
 */
import type { QueryResult, QueryResultRow } from 'pg';

import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { afterEach, describe, it } from 'vitest';

import { resolveTimeoutPolicy } from '../timeout-policy.js';
import { buildTokenFallbackQuery, searchMemories } from './memory-api.js';
import { mockPoolConnect } from './test-pool-mock.js';

const HIGH_CARDINALITY_ROW_COUNT = 1_000;
const JS_OVERHEAD_BUDGET_MULTIPLIER = 0.25;

const CATEGORY_BY_INDEX_MOD = ['decision', 'architecture', 'convention'];

function buildHighCardinalityRow(index: number, overrides: Record<string, unknown> = {}) {
  const id = index + 1;
  const createdAt = new Date(Date.UTC(2026, 0, 1) + index * 1_000);
  return {
    agent: null,
    category: CATEGORY_BY_INDEX_MOD[index % 3],
    confidence: 0.5 + (index % 50) / 100,
    content: `High-cardinality fixture row ${String(id)}: search performance regression coverage.`,
    created_at: createdAt,
    decayed_importance: 0.6,
    dedupe_hash: `sha256:fixture-${String(id)}`,
    evidence_refs: [],
    id,
    keyword_hint: index % 2,
    metadata_json: {},
    or_semantic_relevance: (index % 7) / 10,
    project: 'example/catalog',
    semantic_relevance: (index % 11) / 10,
    source: 'high-cardinality-fixture',
    status: 'active',
    tags: ['issue-1323', 'high-cardinality'],
    updated_at: createdAt,
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

describe('searchMemories default-SQL shape + high-cardinality JS bound', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('default search ranks narrow candidates before hydrating complete memory rows', async () => {
    const capturedSql: string[] = [];

    mockPoolConnect((sql: string) => {
      capturedSql.push(sql);
      if (sql.includes('read_reversal_prior_category')) {
        return Promise.resolve(toQueryResult([]));
      }
      // Return the high-cardinality fixture so we exercise the rerank path
      // on the same result shape the SQL would produce in production.
      return Promise.resolve(
        toQueryResult(Array.from({ length: HIGH_CARDINALITY_ROW_COUNT }, (_, index) => buildHighCardinalityRow(index))),
      );
    });

    await searchMemories({ limit: 8, query: 'hybrid pipeline shape coverage' });

    const defaultSearchSql = capturedSql.find(sql => sql.includes('filtered_candidates'));
    assert.ok(defaultSearchSql !== undefined, 'expected the default-search SQL with the filtered_candidates CTE');

    // CTE pipeline shape — every named CTE listed here is unconditionally
    // emitted by the default search path; if a future refactor drops one, the
    // rerank invariant breaks silently. `vector_candidates` is asserted in the
    // separate "vector candidate CTE" test where the embedding path is wired
    // up explicitly, since the CTE is only emitted when the embedding column
    // and a query embedding are both available.
    for (const cte of [
      'WITH filtered_candidates AS',
      'semantic_candidates AS',
      'keyword_candidates AS',
      'combined_candidates AS',
      'deduped_candidates AS',
    ]) {
      assert.ok(defaultSearchSql.includes(cte), `default SQL must include CTE: ${cte}`);
    }

    const candidatePipeline = defaultSearchSql.slice(0, defaultSearchSql.indexOf('JOIN ai_memory_entries AS entries'));
    assert.ok(
      candidatePipeline.includes('SELECT\n        id,'),
      'candidate pipeline must project an ID and ranking metadata instead of complete memory rows',
    );
    assert.ok(
      !candidatePipeline.includes('SELECT\n        *,'),
      'candidate pipeline must not materialize complete memory rows before candidate limits apply',
    );
    assert.ok(
      defaultSearchSql.includes('JOIN ai_memory_entries AS entries ON entries.id = candidates.id'),
      'complete memory rows must be hydrated only after candidates have been deduped and limited',
    );

    // Index-compatible predicates — these are the predicates Postgres can
    // execute against the GIN/tsvector indexes. Vector ops are asserted in
    // the vector-CTE test where the embedding path is enabled.
    for (const predicate of ["websearch_to_tsquery('english',", 'ts_rank_cd(', 'ROW_NUMBER() OVER (PARTITION BY id']) {
      assert.ok(
        defaultSearchSql.includes(predicate),
        `default SQL must include index-compatible predicate: ${predicate}`,
      );
    }

    const filteredMemoriesWhere = defaultSearchSql.slice(
      defaultSearchSql.indexOf('FROM ai_memory_entries'),
      defaultSearchSql.indexOf('semantic_candidates AS'),
    );
    assert.ok(
      !filteredMemoriesWhere.includes('lower(content) LIKE'),
      'default SQL prefilter must not use lower(content) LIKE; it forces sequential scans despite trigram/full-text indexes',
    );
    assert.ok(
      !filteredMemoriesWhere.includes('unnest(tags)'),
      'default SQL prefilter must not unnest tags; it forces row-by-row tag scans',
    );
  });

  it('joined issue references receive priority before bounded candidate selection without widening the prefilter', async () => {
    let referenceSql = '';
    let referenceParams: readonly unknown[] = [];
    mockPoolConnect((sql, params) => {
      if (sql.includes('filtered_candidates')) {
        referenceSql = sql;
        referenceParams = params ?? [];
      }
      return Promise.resolve(toQueryResult([buildHighCardinalityRow(0)]));
    });

    await searchMemories({
      includeEmbedding: false,
      limit: 5,
      project: 'fixture/recovery',
      query: 'issue4821 bounded output',
    });

    assert.equal(referenceParams[0], 'issue4821 bounded output');
    assert.equal(referenceParams[1], 'issue 4821 bounded output');
    assert.equal(typeof referenceParams[2], 'string');
    assert.equal(referenceParams[3], 'fixture/recovery');
    const prefilter = referenceSql.slice(
      referenceSql.indexOf('FROM ai_memory_entries'),
      referenceSql.indexOf('semantic_candidates AS'),
    );
    assert.ok(prefilter.includes("websearch_to_tsquery('english', $1)"));
    assert.ok(
      prefilter.includes("websearch_to_tsquery('english', $2)"),
      'normalized membership is additive to original joined-term membership',
    );
    assert.ok(prefilter.includes("status IN ('active', 'contested')"));
    assert.ok(prefilter.includes('project = $4'));
    assert.ok(!prefilter.includes('~ $3'), 'reference ranking must not add an unindexed alternative predicate');
    assert.ok(!referenceSql.includes('concat_ws'), 'reference ranking must not synthesize references across fields');
    assert.ok(referenceSql.includes('AS reference_fields'));
    assert.ok(referenceSql.includes('jsonb_array_elements(evidence_refs)'));
    for (const [start, end] of [
      ['semantic_candidates AS', 'keyword_candidates AS'],
      ['keyword_candidates AS', 'combined_candidates AS'],
      ['limited_candidates AS', 'JOIN ai_memory_entries AS entries'],
    ]) {
      assert.ok(start !== undefined && end !== undefined);
      const selection = referenceSql.slice(referenceSql.indexOf(start), referenceSql.indexOf(end));
      assert.match(selection, /ORDER BY reference_hint DESC[\s\S]*LIMIT \$\d+/u);
    }
    assert.deepEqual(referenceParams.slice(4), [10, 10, 10], 'existing candidate caps remain bounded');
  });

  it('measurement queries cannot give same-number issue rows priority before candidate caps', async () => {
    const captured: string[] = [];
    mockPoolConnect(sql => {
      if (sql.includes('filtered_candidates')) captured.push(sql);
      return Promise.resolve(toQueryResult([buildHighCardinalityRow(0)]));
    });
    for (const number of [4821, 7042]) {
      await searchMemories({
        includeEmbedding: false,
        limit: 5,
        query: `sampling report counted ${String(number)} evaluations histogram bucket`,
      });
    }
    assert.equal(captured.length, 2);
    for (const sql of captured) assert.ok(sql.includes('CASE WHEN FALSE THEN 1 ELSE 0 END AS reference_hint'));
  });

  it('default search returns 1 000-row fixture and rerank+penalty stays well under the JS-overhead budget', async () => {
    const readBudgetMs = resolveTimeoutPolicy().db.readTimeoutMs;
    const jsOverheadBudgetMs = readBudgetMs * JS_OVERHEAD_BUDGET_MULTIPLIER;
    const fixtureRows = Array.from({ length: HIGH_CARDINALITY_ROW_COUNT }, (_, index) =>
      buildHighCardinalityRow(index),
    );

    mockPoolConnect((sql: string) => {
      if (sql.includes('read_reversal_prior_category')) {
        return Promise.resolve(toQueryResult([]));
      }
      return Promise.resolve(toQueryResult(fixtureRows));
    });

    const startedAt = process.hrtime.bigint();
    const memories = await searchMemories({ limit: 8, query: 'high-cardinality search performance' });
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

    assert.ok(memories.length > 0, 'high-cardinality fixture should yield at least one reranked row');
    assert.ok(memories.length <= 8, `reranker should respect the limit; got ${String(memories.length)} rows`);
    // JS-side overhead is what we can measure here; server-side enforcement of
    // the read budget is handled separately by `runBoundedQuery`'s
    // `SET LOCAL statement_timeout` (covered by `query-runner.test.ts`).
    assert.ok(
      elapsedMs < jsOverheadBudgetMs,
      `JS-side rerank+penalty must complete well under the ${String(readBudgetMs)}ms read budget; ` +
        `headroom budget=${jsOverheadBudgetMs.toFixed(0)}ms, observed=${elapsedMs.toFixed(2)}ms`,
    );
  });

  it('token fallback SQL keeps index-compatible predicates (trigram ILIKE + tags GIN)', () => {
    const { params, sql } = buildTokenFallbackQuery({
      category: 'decision',
      includeInactive: false,
      limit: 8,
      memoryType: 'semantic',
      project: 'example/catalog',
      tokens: ['budget', 'timeout'],
    });

    // GIN trigram-index-compatible predicate (`content ILIKE '%token%'` and
    // `category ILIKE '%token%'`) — these only use the trigram GIN index when
    // expressed with a leading wildcard via `%`.
    assert.ok(sql.includes('content ILIKE'), 'token fallback must keep `content ILIKE` for trigram GIN');
    assert.ok(sql.includes('category ILIKE'), 'token fallback must keep `category ILIKE` for trigram GIN');
    // tags GIN-compatible element-containment predicate.
    assert.ok(sql.includes('tags @> ARRAY['), 'token fallback must keep `tags @> ARRAY[]` for tags GIN');
    // `decayed_importance` projection (used by reranker) must be present.
    assert.ok(sql.includes('AS decayed_importance'), 'token fallback must expose decayed_importance');
    // Wildcards must be bound parameters, not interpolated strings.
    assert.ok(params.some(value => typeof value === 'string' && value.startsWith('%') && value.endsWith('%')));
  });

  it('token fallback returns deterministic results within the read budget when hybrid yields zero rows', async () => {
    const readBudgetMs = resolveTimeoutPolicy().db.readTimeoutMs;
    const fallbackRows = Array.from({ length: HIGH_CARDINALITY_ROW_COUNT }, (_, index) =>
      buildHighCardinalityRow(index, { keyword_hint: 0, or_semantic_relevance: 0, semantic_relevance: 0 }),
    );

    let invocation = 0;
    mockPoolConnect((sql: string) => {
      invocation += 1;
      if (sql.includes('read_reversal_prior_category')) {
        return Promise.resolve(toQueryResult([]));
      }
      // First call is the hybrid SQL — return zero rows to force the fallback.
      // Subsequent calls are the fallback SQL — return the full fixture set.
      if (invocation === 1) {
        return Promise.resolve(toQueryResult([]));
      }
      return Promise.resolve(toQueryResult(fallbackRows));
    });

    const startedAt = process.hrtime.bigint();
    const memoriesFirstRun = await searchMemories({ limit: 8, query: 'token fallback performance' });
    const firstElapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

    assert.ok(memoriesFirstRun.length > 0, 'token fallback should return rows when hybrid pipeline yields zero');
    assert.ok(
      firstElapsedMs < readBudgetMs,
      `fallback path must complete within ${String(readBudgetMs)}ms read budget; took ${firstElapsedMs.toFixed(2)}ms`,
    );

    // Reset invocation counter and confirm determinism across runs.
    invocation = 0;
    const memoriesSecondRun = await searchMemories({ limit: 8, query: 'token fallback performance' });
    assert.deepEqual(
      memoriesSecondRun.map(memory => memory.id),
      memoriesFirstRun.map(memory => memory.id),
      'token fallback must produce deterministic ordering across runs (regression: deterministic-rerank invariant)',
    );
  });
});
