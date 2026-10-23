/**
 * High-cardinality search performance + SQL-shape regression test.
 *
 * Proves three things about the default `searchMemories` path:
 *
 *   1. The actual generated default-search SQL is the index-first hybrid CTE
 *      pipeline (capped `phrase_candidates` / `term_candidates` /
 *      `exact_candidates` channels -> `text_pool` -> `candidate_features` ->
 *      `filtered_candidates` -> `semantic_candidates` / `keyword_candidates` /
 *      `vector_candidates` -> `combined_candidates` -> `deduped_candidates`),
 *      and it uses index-compatible predicates (`search_vector @@`,
 *      `embedding <=> $::vector`) with ranks computed only for the pool. The
 *      captured-SQL fixture pins this shape so a refactor that silently drops a
 *      channel or ranks every matching row fails this test instead of
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
 * `packages/ai-memory/src/tools/eval/search-eval.ts`
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
import { buildMemorySearchSemanticRankSql, SEARCH_CHANNEL_ROW_CAP } from './memory-sql.js';
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
      'WITH search_query AS',
      'phrase_candidates AS',
      'term_candidates AS',
      'exact_candidates AS',
      'fill_candidates AS',
      'text_pool AS MATERIALIZED',
      'candidate_features AS MATERIALIZED',
      'filtered_candidates AS',
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
    for (const predicate of [
      'search_vector @@',
      "websearch_to_tsquery('english',",
      'ts_rank_cd(',
      'ROW_NUMBER() OVER (PARTITION BY id',
    ]) {
      assert.ok(
        defaultSearchSql.includes(predicate),
        `default SQL must include index-compatible predicate: ${predicate}`,
      );
    }

    // Every channel returns ids from one index and is capped; ranks and hints
    // exist only after the pool is formed.
    const poolStart = defaultSearchSql.indexOf('WITH search_query AS');
    const featuresStart = defaultSearchSql.indexOf('candidate_features AS MATERIALIZED');
    const channels = defaultSearchSql.slice(poolStart, featuresStart);
    assert.ok(
      (channels.match(new RegExp(`LIMIT ${String(SEARCH_CHANNEL_ROW_CAP)}\\b`, 'gu')) ?? []).length >= 4,
      'phrase, term, and exact channels (two reads) must each be capped',
    );
    for (const expensive of ['ts_rank_cd(', 'lower(content) LIKE', 'unnest(tags)', 'jsonb_array_elements']) {
      assert.ok(
        !channels.includes(expensive),
        `candidate channels must not compute ${expensive}; it belongs after the pool is formed`,
      );
    }
    assert.ok(
      defaultSearchSql.slice(featuresStart).includes('WHERE id IN (SELECT id FROM text_pool)'),
      'features and ranks must be computed only for rows in the candidate pool',
    );
  });

  it('joined issue references reach the pool through the stored-vector index before bounded candidate selection', async () => {
    let referenceSql = '';
    let referenceParams: readonly unknown[] = [];
    mockPoolConnect((sql, params) => {
      if (sql.includes('candidate_features AS MATERIALIZED')) {
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
    assert.deepEqual(referenceParams[3], ['4821'], 'reference numbers are looked up as indexed terms');
    assert.deepEqual(referenceParams[4], ['issue4821 bounded output'], 'exact memory-key lookups');
    assert.deepEqual(
      referenceParams[5],
      ['issue4821 bounded output', 'issue4821', 'bounded', 'output'],
      'exact tag lookups use the query and its tokens',
    );
    assert.equal(referenceParams[6], 'fixture/recovery');
    const referenceChannel = referenceSql.slice(
      referenceSql.indexOf('reference_candidates AS'),
      referenceSql.indexOf('text_pool AS MATERIALIZED'),
    );
    assert.ok(
      referenceChannel.includes('search_vector @@ ('),
      'the reference channel must read the stored-vector index before applying the regex',
    );
    assert.ok(
      referenceChannel.indexOf('search_vector @@') < referenceChannel.indexOf('~ $3'),
      'the reference regex only confirms rows the index already returned',
    );
    assert.ok(referenceChannel.includes('project = $7'));
    const queryInput = referenceSql.slice(
      referenceSql.indexOf('search_query AS'),
      referenceSql.indexOf('phrase_candidates AS'),
    );
    assert.ok(queryInput.includes("websearch_to_tsquery('english', $1)"));
    assert.ok(
      queryInput.includes("websearch_to_tsquery('english', $2)"),
      'normalized membership is additive to original joined-term membership',
    );
    assert.ok(referenceSql.includes("status IN ('active', 'contested')"));
    assert.ok(
      !referenceSql.includes("concat_ws(' ', content"),
      'reference ranking must not synthesize references across fields',
    );
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
    assert.deepEqual(referenceParams.slice(7), [10, 10, 10], 'existing candidate caps remain bounded');
  });

  it('lets references in the active goal select only rows that also match the query', async () => {
    const captured: { params: readonly unknown[]; sql: string }[] = [];
    mockPoolConnect((sql, params) => {
      if (sql.includes('candidate_features AS MATERIALIZED')) captured.push({ params: params ?? [], sql });
      return Promise.resolve(toQueryResult([buildHighCardinalityRow(0)]));
    });

    await searchMemories({
      activeGoal: 'finish issue #947 and issue #2260',
      includeEmbedding: false,
      project: 'fixture/recovery',
      query: 'bounded output',
    });
    await searchMemories({
      activeGoal: 'finish issue #947 and issue #2260',
      includeEmbedding: false,
      project: 'fixture/recovery',
      query: 'bounded output for issue #4821',
    });

    const [goalOnly, queryAndGoal] = captured;
    assert.ok(goalOnly && queryAndGoal);
    assert.ok(!goalOnly.sql.includes('reference_candidates AS'), 'a goal-only reference must not select candidates');
    assert.ok(goalOnly.sql.includes('AS reference_hint'), 'the goal reference still feeds the reference hint');
    assert.ok(goalOnly.sql.includes('goal_candidates AS'));
    const goalChannel = goalOnly.sql.slice(
      goalOnly.sql.indexOf('goal_candidates AS'),
      goalOnly.sql.indexOf('fill_candidates AS'),
    );
    assert.ok(goalChannel.includes('SELECT goal_query FROM search_query'));
    assert.ok(
      /&& \(CASE WHEN[\s\S]*AS goal_query/u.test(goalOnly.sql.slice(0, goalOnly.sql.indexOf('phrase_candidates AS'))),
      'goal rows must also match a query term',
    );
    assert.ok(goalOnly.params.some(value => Array.isArray(value) && value.join() === '947,2260'));
    assert.ok(goalOnly.params.some(value => typeof value === 'string' && value.includes('947|2260')));

    assert.ok(queryAndGoal.sql.includes('reference_candidates AS'));
    const numberLists = queryAndGoal.params.filter(
      (value): value is string[] => Array.isArray(value) && value.every(item => /^\d+$/u.test(String(item))),
    );
    assert.deepEqual(numberLists[0], ['4821'], 'only the query text selects candidates by reference number alone');
    assert.deepEqual(numberLists[1], ['4821', '947', '2260'], 'the goal channel looks up the goal numbers too');
    const patterns = queryAndGoal.params.filter(
      value => typeof value === 'string' && value.includes('issues?|prs?|pulls?'),
    );
    assert.equal(patterns.length, 2, 'the hint pattern includes the goal; the pool pattern does not');
    assert.ok(patterns.some(value => String(value).includes('947')));
    assert.ok(patterns.some(value => !String(value).includes('947') && String(value).includes('4821')));
  });

  it('uses the stored vector for the ranks of pooled rows, including original and normalized reference text', async () => {
    let sql = '';
    mockPoolConnect(statement => {
      if (statement.includes('candidate_features AS MATERIALIZED')) sql = statement;
      return Promise.resolve(toQueryResult([buildHighCardinalityRow(0)]));
    });

    await searchMemories({ includeEmbedding: false, project: 'fixture/recovery', query: 'issue4821 scoped reference' });

    const featuresAt = sql.indexOf('candidate_features AS MATERIALIZED');
    assert.ok(featuresAt > 0);
    const projection = sql.slice(featuresAt, sql.indexOf('FROM ai_memory_entries', featuresAt));
    assert.ok(
      projection.includes("(search_vector || ''::tsvector) AS search_vector,"),
      'candidate projection must read each stored vector from TOAST once, not once per ranked lexeme',
    );
    assert.ok(
      !projection.includes('to_tsvector'),
      'candidate projection must use the database-maintained stored vector',
    );
    const featuresFrom = sql.slice(
      sql.indexOf('FROM ai_memory_entries', featuresAt),
      sql.indexOf('filtered_candidates AS', featuresAt),
    );
    assert.ok(
      featuresFrom.includes('WHERE id IN (SELECT id FROM text_pool)') && !featuresFrom.includes('@@'),
      'membership is decided by the index channels, not by a query evaluated on every candidate row',
    );
    const ranking = sql.slice(sql.indexOf('ts_rank_cd(search_vector'), sql.indexOf('semantic_candidates AS'));
    assert.ok(ranking.includes("ts_rank_cd(search_vector, websearch_to_tsquery('english', $1))"));
    assert.ok(
      sql.includes(`${buildMemorySearchSemanticRankSql('$1')} AS semantic_relevance`),
      'primary rank must skip documents that cannot match the websearch query',
    );
    assert.ok(ranking.includes('FROM candidate_features'));
    assert.ok(!ranking.includes('coalesce(content'), 'ranking must reuse the stored document vector');
    assert.ok(!ranking.includes('ai_memory_reference_search_terms'));
  });

  it('measurement queries cannot give same-number issue rows priority before candidate caps', async () => {
    const captured: string[] = [];
    mockPoolConnect(sql => {
      if (sql.includes('candidate_features AS MATERIALIZED')) captured.push(sql);
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
