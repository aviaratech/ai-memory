import assert from 'node:assert/strict';
import { test } from 'vitest';

import type { EvalQuery, QueryResult } from './search-eval.js';

import {
  aggregateResults,
  compareReportToBaseline,
  computeQueryResult,
  loadEvalCorpus,
  mapSearchResultsToFixtureIds,
} from './search-eval.js';

const ROOT_CAUSE = 'root-cause' as const;

// ---------------------------------------------------------------------------
// Fixture validation tests
// ---------------------------------------------------------------------------

test('eval corpus loads without errors', () => {
  const corpus = loadEvalCorpus();
  assert.equal(corpus.version, '1.0');
  assert.ok(Array.isArray(corpus.memories), 'memories must be an array');
  assert.ok(Array.isArray(corpus.queries), 'queries must be an array');
});

test('eval corpus has at least 30 query cases', () => {
  const corpus = loadEvalCorpus();
  assert.ok(corpus.queries.length >= 30, `Expected >= 30 queries, got ${String(corpus.queries.length)}`);
});

test('eval corpus covers all four test categories', () => {
  const corpus = loadEvalCorpus();
  const categories = new Set(corpus.queries.map(q => q.testCategory));
  for (const required of ['architecture', 'convention', 'preference', ROOT_CAUSE] as const) {
    assert.ok(categories.has(required), `Missing test category: ${required}`);
  }
});

test('eval corpus has at least 5 queries per category', () => {
  const corpus = loadEvalCorpus();
  const byCat = new Map<string, number>();
  for (const q of corpus.queries) {
    byCat.set(q.testCategory, (byCat.get(q.testCategory) ?? 0) + 1);
  }
  for (const [cat, count] of byCat) {
    assert.ok(count >= 5, `Category "${cat}" has only ${String(count)} queries, need >= 5`);
  }
});

test('eval corpus has at least 3 multi-word natural-language queries', () => {
  const corpus = loadEvalCorpus();
  const multiWord = corpus.queries.filter(q => {
    const words = q.query.split(/\s+/);
    return words.length >= 4;
  });
  assert.ok(multiWord.length >= 3, `Expected >= 3 multi-word queries (4+ words), got ${String(multiWord.length)}`);
});

test('eval corpus has at least 2 queries with excludedMemoryIds', () => {
  const corpus = loadEvalCorpus();
  const withExcluded = corpus.queries.filter(q => q.excludedMemoryIds !== undefined && q.excludedMemoryIds.length > 0);
  assert.ok(
    withExcluded.length >= 2,
    `Expected >= 2 queries with excludedMemoryIds, got ${String(withExcluded.length)}`,
  );
});

test('all expectedMemoryIds reference valid memory IDs', () => {
  const corpus = loadEvalCorpus();
  const memoryIds = new Set(corpus.memories.map(m => m.id));
  for (const q of corpus.queries) {
    for (const expected of q.expectedMemoryIds) {
      assert.ok(memoryIds.has(expected), `Query "${q.id}" references nonexistent memory "${expected}"`);
    }
  }
});

test('all excludedMemoryIds reference valid memory IDs', () => {
  const corpus = loadEvalCorpus();
  const memoryIds = new Set(corpus.memories.map(m => m.id));
  for (const q of corpus.queries) {
    if (q.excludedMemoryIds === undefined) {
      continue;
    }
    for (const excluded of q.excludedMemoryIds) {
      assert.ok(memoryIds.has(excluded), `Query "${q.id}" excludes nonexistent memory "${excluded}"`);
    }
  }
});

test('no duplicate memory IDs', () => {
  const corpus = loadEvalCorpus();
  const ids = corpus.memories.map(m => m.id);
  assert.equal(ids.length, new Set(ids).size, 'Duplicate memory IDs detected');
});

test('no duplicate query IDs', () => {
  const corpus = loadEvalCorpus();
  const ids = corpus.queries.map(q => q.id);
  assert.equal(ids.length, new Set(ids).size, 'Duplicate query IDs detected');
});

test('every memory has non-empty content and category', () => {
  const corpus = loadEvalCorpus();
  for (const m of corpus.memories) {
    assert.ok(m.content.trim().length > 0, `Memory "${m.id}" has empty content`);
    assert.ok(m.category.trim().length > 0, `Memory "${m.id}" has empty category`);
  }
});

test('every query has non-empty query text and at least one expected ID', () => {
  const corpus = loadEvalCorpus();
  for (const q of corpus.queries) {
    assert.ok(q.query.trim().length > 0, `Query "${q.id}" has empty query text`);
    assert.ok(q.expectedMemoryIds.length > 0, `Query "${q.id}" has no expectedMemoryIds`);
  }
});

// ---------------------------------------------------------------------------
// Metrics computation tests
// ---------------------------------------------------------------------------

function makeQuery(overrides: Partial<EvalQuery> = {}): EvalQuery {
  return {
    expectedMemoryIds: ['m1'],
    id: 'test-q',
    query: 'test query',
    testCategory: 'convention',
    ...overrides,
  };
}

test('computeQueryResult: full match gives recall@K = 1', () => {
  const result = computeQueryResult({
    k: 5,
    query: makeQuery({ expectedMemoryIds: ['m1', 'm2'] }),
    returnedMemoryIds: ['m1', 'm2', 'mx'],
  });
  assert.equal(result.recallAtK, 1);
  assert.equal(result.reciprocalRank, 1);
  assert.equal(result.zeroResults, false);
});

test('computeQueryResult: partial match gives correct recall@K', () => {
  const result = computeQueryResult({
    k: 5,
    query: makeQuery({ expectedMemoryIds: ['m1', 'm2', 'm3'] }),
    returnedMemoryIds: ['m1', 'mx', 'm3', 'my', 'mz'],
  });
  // 2 of 3 expected found in top 5
  assert.ok(Math.abs(result.recallAtK - 2 / 3) < 0.0001, `Expected recall ~0.6667, got ${String(result.recallAtK)}`);
});

test('computeQueryResult: reciprocal rank from first expected hit', () => {
  const result = computeQueryResult({
    k: 5,
    query: makeQuery({ expectedMemoryIds: ['m2'] }),
    returnedMemoryIds: ['mx', 'm2', 'my'],
  });
  // m2 is at position 2 (1-indexed), so RR = 1/2
  assert.equal(result.reciprocalRank, 0.5);
});

test('computeQueryResult: reciprocal rank at position 3', () => {
  const result = computeQueryResult({
    k: 5,
    query: makeQuery({ expectedMemoryIds: ['m1'] }),
    returnedMemoryIds: ['mx', 'my', 'm1', 'mz', 'mw'],
  });
  assert.ok(
    Math.abs(result.reciprocalRank - 1 / 3) < 0.0001,
    `Expected RR ~0.3333, got ${String(result.reciprocalRank)}`,
  );
});

test('computeQueryResult: zero results', () => {
  const result = computeQueryResult({
    k: 5,
    query: makeQuery({ expectedMemoryIds: ['m1'] }),
    returnedMemoryIds: [],
  });
  assert.equal(result.zeroResults, true);
  assert.equal(result.recallAtK, 0);
  assert.equal(result.reciprocalRank, 0);
});

test('computeQueryResult: no expected in results', () => {
  const result = computeQueryResult({
    k: 5,
    query: makeQuery({ expectedMemoryIds: ['m1'] }),
    returnedMemoryIds: ['mx', 'my', 'mz'],
  });
  assert.equal(result.zeroResults, false);
  assert.equal(result.recallAtK, 0);
  assert.equal(result.reciprocalRank, 0);
});

test('computeQueryResult: detects precision violations', () => {
  const result = computeQueryResult({
    k: 5,
    query: makeQuery({
      excludedMemoryIds: ['m-bad'],
      expectedMemoryIds: ['m1'],
    }),
    returnedMemoryIds: ['m1', 'm-bad'],
  });
  assert.deepEqual(result.precisionViolations, ['m-bad']);
});

test('computeQueryResult: no precision violations when excluded not in results', () => {
  const result = computeQueryResult({
    k: 5,
    query: makeQuery({
      excludedMemoryIds: ['m-bad'],
      expectedMemoryIds: ['m1'],
    }),
    returnedMemoryIds: ['m1', 'mx'],
  });
  assert.deepEqual(result.precisionViolations, []);
});

test('computeQueryResult: detects ordering violations for expectedBefore guards', () => {
  const result = computeQueryResult({
    k: 5,
    query: makeQuery({
      expectedBefore: [{ after: 'm-volatile', before: 'm-stable' }],
      expectedMemoryIds: ['m-stable'],
    }),
    returnedMemoryIds: ['m-volatile', 'm-stable'],
  });

  assert.deepEqual(result.orderingViolations, ['m-stable before m-volatile']);
});

test('computeQueryResult: passes ordering guard when preferred result ranks first', () => {
  const result = computeQueryResult({
    k: 5,
    query: makeQuery({
      expectedBefore: [{ after: 'm-volatile', before: 'm-stable' }],
      expectedMemoryIds: ['m-stable'],
    }),
    returnedMemoryIds: ['m-stable', 'm-volatile'],
  });

  assert.deepEqual(result.orderingViolations, []);
});

test('computeQueryResult: truncates to top K', () => {
  const result = computeQueryResult({
    k: 3,
    query: makeQuery({ expectedMemoryIds: ['m5'] }),
    returnedMemoryIds: ['m1', 'm2', 'm3', 'm4', 'm5'],
  });
  // m5 is at position 5, beyond k=3
  assert.equal(result.recallAtK, 0);
  assert.equal(result.returnedMemoryIds.length, 3);
});

// ---------------------------------------------------------------------------
// Aggregation tests
// ---------------------------------------------------------------------------

test('aggregateResults: correct mean metrics', () => {
  const queryResults: QueryResult[] = [
    {
      expectedMemoryIds: ['m1'],
      precisionViolations: [],
      query: 'a',
      queryId: 'q1',
      recallAtK: 0,
      reciprocalRank: 0,
      returnedMemoryIds: [],
      testCategory: 'convention',
      zeroResults: true,
    },
    {
      expectedMemoryIds: ['m1'],
      precisionViolations: [],
      query: 'b',
      queryId: 'q2',
      recallAtK: 1,
      reciprocalRank: 1,
      returnedMemoryIds: ['m1'],
      testCategory: 'convention',
      zeroResults: false,
    },
  ];

  const report = aggregateResults({ k: 5, queryResults });
  assert.equal(report.meanRecallAtK, 0.5);
  assert.equal(report.mrr, 0.5);
  assert.equal(report.zeroResultRate, 0.5);
  assert.equal(report.totalQueries, 2);
  assert.equal(report.precisionViolationCount, 0);
});

test('aggregateResults: per-category breakdown', () => {
  const queryResults: QueryResult[] = [
    {
      expectedMemoryIds: ['m1'],
      precisionViolations: [],
      query: 'a',
      queryId: 'q1',
      recallAtK: 1,
      reciprocalRank: 1,
      returnedMemoryIds: ['m1'],
      testCategory: 'architecture',
      zeroResults: false,
    },
    {
      expectedMemoryIds: ['m2'],
      precisionViolations: [],
      query: 'b',
      queryId: 'q2',
      recallAtK: 0,
      reciprocalRank: 0,
      returnedMemoryIds: [],
      testCategory: ROOT_CAUSE,
      zeroResults: true,
    },
  ];

  const report = aggregateResults({ k: 5, queryResults });
  assert.ok('architecture' in report.byCategory);
  assert.ok(ROOT_CAUSE in report.byCategory);
  assert.equal(report.byCategory.architecture.meanRecallAtK, 1);
  assert.equal(report.byCategory[ROOT_CAUSE].zeroResultRate, 1);
});

test('aggregateResults: empty input', () => {
  const report = aggregateResults({ k: 5, queryResults: [] });
  assert.equal(report.totalQueries, 0);
  assert.equal(report.meanRecallAtK, 0);
  assert.equal(report.mrr, 0);
  assert.equal(report.zeroResultRate, 0);
});

test('aggregateResults: precision violations counted', () => {
  const queryResults: QueryResult[] = [
    {
      expectedMemoryIds: ['m1'],
      precisionViolations: ['m-bad1', 'm-bad2'],
      query: 'a',
      queryId: 'q1',
      recallAtK: 1,
      reciprocalRank: 1,
      returnedMemoryIds: ['m1', 'm-bad1', 'm-bad2'],
      testCategory: 'preference',
      zeroResults: false,
    },
    {
      expectedMemoryIds: ['m2'],
      precisionViolations: ['m-bad3'],
      query: 'b',
      queryId: 'q2',
      recallAtK: 1,
      reciprocalRank: 1,
      returnedMemoryIds: ['m2', 'm-bad3'],
      testCategory: 'preference',
      zeroResults: false,
    },
  ];

  const report = aggregateResults({ k: 5, queryResults });
  assert.equal(report.precisionViolationCount, 3);
});

test('aggregateResults: ordering violations counted', () => {
  const queryResults: QueryResult[] = [
    {
      expectedMemoryIds: ['m1'],
      orderingViolations: ['m1 before m2'],
      precisionViolations: [],
      query: 'a',
      queryId: 'q1',
      recallAtK: 1,
      reciprocalRank: 1,
      returnedMemoryIds: ['m2', 'm1'],
      testCategory: 'convention',
      zeroResults: false,
    },
    {
      expectedMemoryIds: ['m3'],
      orderingViolations: [],
      precisionViolations: [],
      query: 'b',
      queryId: 'q2',
      recallAtK: 1,
      reciprocalRank: 1,
      returnedMemoryIds: ['m3'],
      testCategory: 'convention',
      zeroResults: false,
    },
  ];

  const report = aggregateResults({ k: 5, queryResults });
  assert.equal(report.orderingViolationCount, 1);
});

// ---------------------------------------------------------------------------
// Baseline comparison tests
// ---------------------------------------------------------------------------

test('compareReportToBaseline: throws when k does not match baseline', () => {
  assert.throws(
    () =>
      compareReportToBaseline({
        baseline: {
          k: 5,
          thresholds: {
            maxZeroResultRate: 0.5,
            minMeanRecallAtK: 0.4,
            minMrr: 0.4,
          },
        },
        report: {
          k: 10,
          meanRecallAtK: 0.5,
          mrr: 0.5,
          zeroResultRate: 0.4,
        },
      }),
    /Baseline K mismatch/i,
  );
});

test('compareReportToBaseline: returns regressions when report breaches thresholds', () => {
  const regressions = compareReportToBaseline({
    baseline: {
      k: 5,
      thresholds: {
        maxZeroResultRate: 0.2,
        minMeanRecallAtK: 0.8,
        minMrr: 0.7,
      },
    },
    report: {
      k: 5,
      meanRecallAtK: 0.6,
      mrr: 0.65,
      zeroResultRate: 0.25,
    },
  });

  assert.equal(regressions.length, 3);
});

// ---------------------------------------------------------------------------
// Search result mapping tests
// ---------------------------------------------------------------------------

test('mapSearchResultsToFixtureIds: maps all result IDs when fixtures are known', () => {
  const mapped = mapSearchResultsToFixtureIds({
    dbIdToFixtureId: new Map([
      [101, 'm-1'],
      [102, 'm-2'],
    ]),
    query: { id: 'q-1', query: 'test query' },
    results: [{ id: 101 }, { id: 102 }],
  });

  assert.deepEqual(mapped, ['m-1', 'm-2']);
});

test('mapSearchResultsToFixtureIds: throws when DB returns unmapped IDs', () => {
  assert.throws(
    () =>
      mapSearchResultsToFixtureIds({
        dbIdToFixtureId: new Map([[101, 'm-1']]),
        query: { id: 'q-2', query: 'unmapped id query' },
        results: [{ id: 101 }, { id: 999 }],
      }),
    /Search eval contamination detected/i,
  );
});
