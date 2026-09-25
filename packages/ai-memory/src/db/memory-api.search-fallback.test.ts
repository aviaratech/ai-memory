import assert from 'node:assert/strict';
import { test } from 'vitest';

import { buildTokenFallbackQuery } from './memory-api.js';
import { buildSearchQueryTokens, rerankHybridSearchRows } from './query-helpers.js';

const TEST_PROJECT = 'test-project';

test('buildTokenFallbackQuery uses ILIKE instead of lower() LIKE for trigram index compatibility', () => {
  const { sql } = buildTokenFallbackQuery({
    category: undefined,
    includeInactive: false,
    limit: 5,
    memoryType: undefined,
    project: TEST_PROJECT,
    tokens: ['zustand', 'store'],
  });

  assert.ok(sql.includes('content ILIKE'), 'should use ILIKE (trigram-accelerable) not lower() LIKE');
  assert.ok(!sql.includes('lower(content)'), 'should not wrap content in lower()');
  assert.ok(!sql.includes('unnest(tags)'), 'should not use unnest(tags) which bypasses GIN index');
  assert.ok(sql.includes('tags @>'), 'should use GIN-indexed array containment for tags');
});

test('buildTokenFallbackQuery binds parameters for each token correctly', () => {
  const tokens = ['zustand', 'store'];
  const { params } = buildTokenFallbackQuery({
    category: undefined,
    includeInactive: false,
    limit: 5,
    memoryType: undefined,
    project: TEST_PROJECT,
    tokens,
  });

  // project param + 2 tokens * 2 params each (ILIKE pattern + exact tag) + candidateLimit
  assert.equal(params.length, 1 + tokens.length * 2 + 1);
  assert.equal(params[0], TEST_PROJECT);
  assert.equal(params[1], '%zustand%');
  assert.equal(params[2], 'zustand');
  assert.equal(params[3], '%store%');
  assert.equal(params[4], 'store');
});

test('buildTokenFallbackQuery enforces candidate limit bounded to 3x limit, max 80', () => {
  const { params: smallParams, sql: smallSql } = buildTokenFallbackQuery({
    category: undefined,
    includeInactive: false,
    limit: 5,
    memoryType: undefined,
    project: undefined,
    tokens: ['test'],
  });
  const smallLimit = smallParams[smallParams.length - 1];
  assert.equal(smallLimit, 15, 'limit 5 * 3 = 15');
  assert.ok(smallSql.includes('LIMIT'), 'SQL must include LIMIT clause');

  const { params: largeParams } = buildTokenFallbackQuery({
    category: undefined,
    includeInactive: false,
    limit: 50,
    memoryType: undefined,
    project: undefined,
    tokens: ['test'],
  });
  const largeLimit = largeParams[largeParams.length - 1];
  assert.equal(largeLimit, 80, 'limit 50 * 3 = 150 capped to 80');
});

test('buildTokenFallbackQuery includes status and expiry filters when active-only', () => {
  const { sql } = buildTokenFallbackQuery({
    category: undefined,
    includeInactive: false,
    limit: 5,
    memoryType: undefined,
    project: undefined,
    tokens: ['test'],
  });

  assert.ok(sql.includes("status = 'active'"), 'should filter to active status');
  assert.ok(sql.includes('expires_at IS NULL OR expires_at > NOW()'), 'should filter unexpired');
});

test('buildTokenFallbackQuery omits status filters when includeInactive is true', () => {
  const { sql } = buildTokenFallbackQuery({
    category: undefined,
    includeInactive: true,
    limit: 5,
    memoryType: undefined,
    project: undefined,
    tokens: ['test'],
  });

  assert.ok(!sql.includes("status = 'active'"), 'should not filter by status');
});

test('buildTokenFallbackQuery adds project and category filters when provided', () => {
  const { params, sql } = buildTokenFallbackQuery({
    category: 'convention',
    includeInactive: false,
    limit: 5,
    memoryType: undefined,
    project: TEST_PROJECT,
    tokens: ['test'],
  });

  assert.ok(sql.includes('project ='), 'should include project filter');
  assert.ok(sql.includes('category ='), 'should include category filter');
  assert.ok(params.includes(TEST_PROJECT));
  assert.ok(params.includes('convention'));
});

test('buildTokenFallbackQuery outputs zero semantic/or_semantic/keyword_hint columns', () => {
  const { sql } = buildTokenFallbackQuery({
    category: undefined,
    includeInactive: false,
    limit: 5,
    memoryType: undefined,
    project: undefined,
    tokens: ['test'],
  });

  assert.ok(sql.includes('0::double precision AS semantic_relevance'), 'should zero semantic_relevance');
  assert.ok(sql.includes('0::double precision AS or_semantic_relevance'), 'should zero or_semantic_relevance');
  assert.ok(sql.includes('0 AS keyword_hint'), 'should zero keyword_hint');
  assert.ok(sql.includes('AS decayed_importance'), 'should compute decayed_importance for fallback rows');
});

test('fallback-style rows are reranked by keyword signal and bounded to limit', () => {
  // Simulate fallback rows: zero semantic scores, keyword-only differentiation
  const fallbackRows = [
    {
      category: 'convention',
      confidence: 0.85,
      content: 'Zustand store naming pattern uses createFeatureStore with a hook.',
      created_at: '2026-02-08T10:00:00.000Z',
      id: 1,
      keyword_hint: 0,
      or_semantic_relevance: 0,
      project: 'example/catalog',
      semantic_relevance: 0,
      tags: ['zustand', 'naming'],
    },
    {
      category: 'decision',
      confidence: 0.7,
      content: 'Decided to use Redux for global state management.',
      created_at: '2026-02-08T11:00:00.000Z',
      id: 2,
      keyword_hint: 0,
      or_semantic_relevance: 0,
      project: 'example/catalog',
      semantic_relevance: 0,
      tags: ['redux', 'state'],
    },
    {
      category: 'convention',
      confidence: 0.9,
      content: 'Store files live in feature/store/ directory.',
      created_at: '2026-02-08T09:00:00.000Z',
      id: 3,
      keyword_hint: 0,
      or_semantic_relevance: 0,
      project: 'example/catalog',
      semantic_relevance: 0,
      tags: ['store', 'directory'],
    },
  ];

  const queryText = 'zustand store naming';
  const reranked = rerankHybridSearchRows(fallbackRows, {
    limit: 2,
    queryText,
  });

  assert.equal(reranked.length, 2, 'result count should be bounded to limit');

  const first = reranked[0];
  assert.ok(first !== undefined);
  assert.equal(first.id, 1, 'row with most keyword token matches should rank first');
});

test('empty tokens produce no fallback candidates', () => {
  const tokens = buildSearchQueryTokens('');
  assert.equal(tokens.length, 0, 'empty query produces no tokens');

  // With no tokens, fallback should not generate any SQL conditions
  // (the caller checks tokens.length === 0 and returns [] early)
});
