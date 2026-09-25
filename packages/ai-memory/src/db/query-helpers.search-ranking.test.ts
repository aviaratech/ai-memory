import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  buildSearchQueryTokens,
  buildSearchReferencePattern,
  normalizeSearchReferenceText,
  rerankHybridSearchRows,
} from './query-helpers.js';

const LOW_SIGNAL_CATEGORY = 'session-summary';
const TEST_PROJECT = 'example/catalog';
const TEST_TIMESTAMP = '2026-02-08T10:00:00.000Z';
const ZUSTAND_CONTENT = 'Zustand store naming pattern uses createFeatureStore.';
const ZUSTAND_QUERY = 'zustand store naming';

test('buildSearchQueryTokens dedupes and strips punctuation', () => {
  assert.deepEqual(buildSearchQueryTokens('  Branch checks, checks! before-coding?? document  '), [
    'branch',
    'checks',
    'before',
    'coding',
    'document',
  ]);
});

test('hybrid reranking prioritizes paraphrased convention memory over semantic-only noise', () => {
  const rows = [
    {
      category: 'convention',
      content: 'Run pnpm run checks:branch:fix before starting implementation work.',
      created_at: '2026-02-06T10:00:00.000Z',
      id: 1,
      keyword_hint: 1,
      project: TEST_PROJECT,
      semantic_relevance: 0.04,
      tags: ['workflow', 'checks', 'builder'],
    },
    {
      category: 'decision',
      content: 'Published PR 946 for command ownership cleanup and wrapper argument forwarding.',
      created_at: '2026-02-07T10:00:00.000Z',
      id: 2,
      keyword_hint: 0,
      project: TEST_PROJECT,
      semantic_relevance: 0.23,
      tags: ['pr-946', 'scripts'],
    },
  ];

  const reranked = rerankHybridSearchRows(rows, {
    limit: 5,
    queryText: 'run branch checks before coding',
  });
  const first = reranked[0];
  const second = reranked[1];
  assert.ok(first !== undefined);
  assert.ok(second !== undefined);
  assert.equal(first.id, 1);
  assert.ok(toNumber(first.relevance) > toNumber(second.relevance));
});

test('hybrid reranking keeps architecture authority memory first for paraphrased query', () => {
  const rows = [
    {
      category: 'architecture',
      content: 'Measurement phase transitions must remain in the PhaseStateMachine single authority.',
      created_at: '2026-02-07T09:00:00.000Z',
      id: 10,
      keyword_hint: 1,
      project: TEST_PROJECT,
      semantic_relevance: 0.05,
      tags: ['state-machine', 'authority'],
    },
    {
      category: 'convention',
      content: 'Use issue-cli templates and PR body sections for every publish.',
      created_at: '2026-02-07T09:30:00.000Z',
      id: 11,
      keyword_hint: 0,
      project: TEST_PROJECT,
      semantic_relevance: 0.21,
      tags: ['workflow', 'issue-cli'],
    },
  ];

  const reranked = rerankHybridSearchRows(rows, {
    limit: 5,
    queryText: 'who owns phase transition authority state machine',
  });
  const top = reranked[0];
  assert.ok(top !== undefined);
  assert.equal(top.id, 10);
  assert.ok(toNumber(top.keyword_relevance) >= 0.5);
});

test('taxonomy weighting boosts actionable category over low-signal at equal relevance', () => {
  const rows = [
    {
      category: LOW_SIGNAL_CATEGORY,
      content: ZUSTAND_CONTENT,
      created_at: TEST_TIMESTAMP,
      id: 20,
      keyword_hint: 1,
      project: TEST_PROJECT,
      semantic_relevance: 0.15,
      tags: ['zustand', 'naming'],
    },
    {
      category: 'convention',
      content: ZUSTAND_CONTENT,
      created_at: TEST_TIMESTAMP,
      id: 21,
      keyword_hint: 1,
      project: TEST_PROJECT,
      semantic_relevance: 0.15,
      tags: ['zustand', 'naming'],
    },
  ];

  const reranked = rerankHybridSearchRows(rows, {
    limit: 5,
    queryText: ZUSTAND_QUERY,
  });
  const first = reranked[0];
  const second = reranked[1];
  assert.ok(first !== undefined);
  assert.ok(second !== undefined);
  assert.equal(first.id, 21, 'convention (actionable) should rank above session-summary (low-signal)');
  assert.ok(toNumber(first.relevance) > toNumber(second.relevance));
});

test('taxonomy weighting does not overwhelm strong keyword/semantic relevance', () => {
  const rows = [
    {
      category: 'convention',
      content: 'Generic code style note.',
      created_at: TEST_TIMESTAMP,
      id: 30,
      keyword_hint: 0,
      project: TEST_PROJECT,
      semantic_relevance: 0.01,
      tags: [],
    },
    {
      category: LOW_SIGNAL_CATEGORY,
      content: 'Resolved zustand store naming pattern for feature stores using createFeatureStore.',
      created_at: TEST_TIMESTAMP,
      id: 31,
      keyword_hint: 1,
      project: TEST_PROJECT,
      semantic_relevance: 0.3,
      tags: ['zustand', 'naming', 'store'],
    },
  ];

  const reranked = rerankHybridSearchRows(rows, {
    limit: 5,
    queryText: ZUSTAND_QUERY,
  });
  const first = reranked[0];
  assert.ok(first !== undefined);
  assert.equal(first.id, 31, 'strong relevance should still beat taxonomy boost alone');
});

test('OR-semantic signal rescues rows with zero AND-semantic relevance', () => {
  const rows = [
    {
      category: 'architecture',
      confidence: 0.9,
      content: 'document architecture uses layered services with pipeline and session subdirectories.',
      created_at: TEST_TIMESTAMP,
      id: 40,
      keyword_hint: 0,
      or_semantic_relevance: 0.2,
      project: TEST_PROJECT,
      semantic_relevance: 0,
      tags: ['document', 'architecture'],
    },
    {
      category: LOW_SIGNAL_CATEGORY,
      confidence: 0.3,
      content: 'Reviewed some miscellaneous code changes.',
      created_at: TEST_TIMESTAMP,
      id: 41,
      keyword_hint: 0,
      or_semantic_relevance: 0,
      project: TEST_PROJECT,
      semantic_relevance: 0,
      tags: [],
    },
  ];

  const reranked = rerankHybridSearchRows(rows, {
    limit: 5,
    queryText: 'document architecture organized',
  });
  const first = reranked[0];
  assert.ok(first !== undefined);
  assert.equal(first.id, 40, 'OR-semantic match should rank above zero-signal row');
  assert.ok(toNumber(first.relevance) > 0, 'OR-semantic row should have non-zero hybrid relevance');
});

test('confidence signal provides meaningful tiebreaker', () => {
  const rows = [
    {
      category: 'convention',
      confidence: 0.5,
      content: ZUSTAND_CONTENT,
      created_at: TEST_TIMESTAMP,
      id: 50,
      keyword_hint: 1,
      or_semantic_relevance: 0.15,
      project: TEST_PROJECT,
      semantic_relevance: 0.15,
      tags: ['zustand', 'naming'],
    },
    {
      category: 'convention',
      confidence: 0.95,
      content: ZUSTAND_CONTENT,
      created_at: TEST_TIMESTAMP,
      id: 51,
      keyword_hint: 1,
      or_semantic_relevance: 0.15,
      project: TEST_PROJECT,
      semantic_relevance: 0.15,
      tags: ['zustand', 'naming'],
    },
  ];

  const reranked = rerankHybridSearchRows(rows, {
    limit: 5,
    queryText: ZUSTAND_QUERY,
  });
  const first = reranked[0];
  assert.ok(first !== undefined);
  assert.equal(first.id, 51, 'higher confidence should rank above lower confidence when all else is equal');
});

test('decayed importance signal boosts higher-importance results', () => {
  const rows = [
    {
      category: 'convention',
      confidence: 0.8,
      content: ZUSTAND_CONTENT,
      created_at: TEST_TIMESTAMP,
      decayed_importance: 0.15,
      id: 52,
      keyword_hint: 1,
      or_semantic_relevance: 0.15,
      project: TEST_PROJECT,
      semantic_relevance: 0.15,
      tags: ['zustand', 'naming'],
    },
    {
      category: 'convention',
      confidence: 0.8,
      content: ZUSTAND_CONTENT,
      created_at: TEST_TIMESTAMP,
      decayed_importance: 0.85,
      id: 53,
      keyword_hint: 1,
      or_semantic_relevance: 0.15,
      project: TEST_PROJECT,
      semantic_relevance: 0.15,
      tags: ['zustand', 'naming'],
    },
  ];

  const reranked = rerankHybridSearchRows(rows, {
    limit: 5,
    queryText: ZUSTAND_QUERY,
  });
  const first = reranked[0];
  assert.ok(first !== undefined);
  assert.equal(first.id, 53, 'higher decayed importance should rank above lower decayed importance');
});

test('null importance rows still rank via confidence*tier fallback', () => {
  const rows = [
    {
      category: 'decision',
      confidence: 0.85,
      content: ZUSTAND_CONTENT,
      created_at: TEST_TIMESTAMP,
      id: 54,
      importance: null,
      keyword_hint: 1,
      or_semantic_relevance: 0.15,
      project: TEST_PROJECT,
      semantic_relevance: 0.15,
      tags: ['zustand', 'naming'],
    },
    {
      category: 'decision',
      confidence: 0.85,
      content: ZUSTAND_CONTENT,
      created_at: TEST_TIMESTAMP,
      decayed_importance: 0.05,
      id: 55,
      keyword_hint: 1,
      or_semantic_relevance: 0.15,
      project: TEST_PROJECT,
      semantic_relevance: 0.15,
      tags: ['zustand', 'naming'],
    },
  ];

  const reranked = rerankHybridSearchRows(rows, {
    limit: 5,
    queryText: ZUSTAND_QUERY,
  });
  const first = reranked[0];
  assert.ok(first !== undefined);
  assert.equal(first.id, 54, 'legacy null-importance row should get fallback importance signal');
});

test('AND-semantic still dominates when both AND and OR are present', () => {
  const rows = [
    {
      category: 'architecture',
      confidence: 0.85,
      content: 'Architecture uses layered services with pipeline.',
      created_at: TEST_TIMESTAMP,
      id: 60,
      keyword_hint: 1,
      or_semantic_relevance: 0.15,
      project: TEST_PROJECT,
      semantic_relevance: 0.3,
      tags: ['architecture'],
    },
    {
      category: 'architecture',
      confidence: 0.85,
      content: 'Some architecture note.',
      created_at: TEST_TIMESTAMP,
      id: 61,
      keyword_hint: 0,
      or_semantic_relevance: 0.25,
      project: TEST_PROJECT,
      semantic_relevance: 0,
      tags: [],
    },
  ];

  const reranked = rerankHybridSearchRows(rows, {
    limit: 5,
    queryText: 'architecture pipeline',
  });
  const first = reranked[0];
  assert.ok(first !== undefined);
  assert.equal(first.id, 60, 'strong AND-semantic should still rank above OR-only match');
});

test('vector similarity boosts result with no text match above zero-signal row', () => {
  const rows = [
    {
      category: 'architecture',
      confidence: 0.8,
      content: 'State management uses Zustand feature stores.',
      created_at: TEST_TIMESTAMP,
      id: 70,
      keyword_hint: 0,
      max_vector_similarity: 0.88,
      project: TEST_PROJECT,
      semantic_relevance: 0,
      tags: [],
    },
    {
      category: 'convention',
      confidence: 0.5,
      content: 'Unrelated note about something else entirely.',
      created_at: TEST_TIMESTAMP,
      id: 71,
      keyword_hint: 0,
      max_vector_similarity: 0,
      project: TEST_PROJECT,
      semantic_relevance: 0,
      tags: [],
    },
  ];

  const reranked = rerankHybridSearchRows(rows, {
    limit: 5,
    queryText: 'zustand state management',
  });
  const first = reranked[0];
  assert.ok(first !== undefined);
  assert.equal(first.id, 70, 'high vector similarity should rank above zero-signal row');
  assert.ok(toNumber(first.relevance) > toNumber(reranked[1]?.relevance), 'vector row should have higher relevance');
});

test('contested status reduces hybrid relevance by 0.5x multiplier', () => {
  const baseRow = {
    category: 'convention',
    confidence: 0.9,
    content: ZUSTAND_CONTENT,
    created_at: TEST_TIMESTAMP,
    keyword_hint: 1,
    project: TEST_PROJECT,
    semantic_relevance: 0.2,
    tags: ['zustand', 'naming'],
  };

  const rows = [
    { ...baseRow, id: 80, status: 'active' },
    { ...baseRow, id: 81, status: 'contested' },
  ];

  const reranked = rerankHybridSearchRows(rows, {
    limit: 5,
    queryText: ZUSTAND_QUERY,
  });
  const active = reranked.find(r => r.id === 80);
  const contested = reranked.find(r => r.id === 81);
  assert.ok(active !== undefined);
  assert.ok(contested !== undefined);
  assert.equal(reranked[0]?.id, 80, 'active should rank above contested with identical signals');
  assert.ok(
    toNumber(active.relevance) > toNumber(contested.relevance),
    'active relevance should exceed contested relevance due to 0.5x multiplier',
  );
  assert.ok(
    toNumber(contested.relevance) > 0,
    'contested relevance should still be non-zero (0.5x of active, not zeroed)',
  );
});

test('reversal penalty down-weights comparable retrieval rows without suppressing them', () => {
  const baseRow = {
    category: 'architecture',
    confidence: 0.9,
    content: 'Architecture decision: retrieval ranking uses comparable author track record evidence.',
    created_at: TEST_TIMESTAMP,
    keyword_hint: 1,
    project: TEST_PROJECT,
    semantic_relevance: 0.2,
    tags: ['retrieval', 'ranking'],
  };

  const rows = [
    { ...baseRow, id: 82, reversal_penalty: 0.5 },
    { ...baseRow, id: 83 },
  ];

  const reranked = rerankHybridSearchRows(rows, {
    limit: 5,
    queryText: 'retrieval ranking author track record',
  });
  const penalized = reranked.find(r => r.id === 82);
  const unpenalized = reranked.find(r => r.id === 83);
  assert.ok(penalized !== undefined);
  assert.ok(unpenalized !== undefined);
  assert.equal(reranked[0]?.id, 83, 'unpenalized row should rank above comparable penalized row');
  assert.ok(toNumber(penalized.relevance) > 0, 'penalized rows retain non-zero relevance');
  assert.ok(
    Math.abs(toNumber(penalized.relevance) - toNumber(unpenalized.relevance) * 0.5) < 0.0001,
    '0.5 reversal penalty should halve the final hybrid relevance',
  );
});

test('reversal penalty down-weights otherwise comparable hybrid results without hiding them', () => {
  const baseRow = {
    category: 'convention',
    confidence: 0.9,
    content: ZUSTAND_CONTENT,
    created_at: TEST_TIMESTAMP,
    keyword_hint: 1,
    project: TEST_PROJECT,
    semantic_relevance: 0.2,
    tags: ['zustand', 'naming'],
  };

  const rows = [
    { ...baseRow, id: 82 },
    {
      ...baseRow,
      id: 83,
      signals: {
        priorMemoryCount: 18,
        reversalPenalty: 0.5,
        reversalRate: 1,
        scope: 'author x category',
      },
    },
  ];

  const reranked = rerankHybridSearchRows(rows, {
    limit: 5,
    queryText: ZUSTAND_QUERY,
  });
  const unpenalized = reranked.find(r => r.id === 82);
  const penalized = reranked.find(r => r.id === 83);

  assert.equal(reranked[0]?.id, 82, 'unpenalized row should outrank comparable high-reversal row');
  assert.ok(unpenalized !== undefined);
  assert.ok(penalized !== undefined);
  assert.ok(toNumber(unpenalized.relevance) > toNumber(penalized.relevance));
  assert.ok(toNumber(penalized.relevance) > 0, 'penalized row retains non-zero relevance at the 50% cap');
  assert.deepEqual(
    penalized.signals,
    (rows[1] as Record<string, unknown> | undefined)?.signals,
    'diagnostic signals should stay attached to result rows',
  );
});

test('weight redistribution — relative ordering is preserved when vector_similarity is absent', () => {
  // Both rows have no vector_similarity; the redistribution should not change relative ranking
  const rows = [
    {
      category: 'convention',
      confidence: 0.9,
      content: ZUSTAND_CONTENT,
      created_at: TEST_TIMESTAMP,
      id: 90,
      keyword_hint: 1,
      project: TEST_PROJECT,
      semantic_relevance: 0.2,
      tags: ['zustand', 'naming'],
    },
    {
      category: LOW_SIGNAL_CATEGORY,
      confidence: 0.3,
      content: 'Some session summary entry.',
      created_at: TEST_TIMESTAMP,
      id: 91,
      keyword_hint: 0,
      project: TEST_PROJECT,
      semantic_relevance: 0.05,
      tags: [],
    },
  ];

  const reranked = rerankHybridSearchRows(rows, {
    limit: 5,
    queryText: ZUSTAND_QUERY,
  });
  assert.ok(reranked[0] !== undefined);
  assert.equal(reranked[0].id, 90, 'convention with keyword match should rank above low-signal without vector signal');
  assert.ok(
    toNumber(reranked[0].relevance) > toNumber(reranked[1]?.relevance),
    'higher-quality row should have higher relevance even without vector signals',
  );
});

test('goal-conditioned boost reranks rows with overlapping goal tokens', () => {
  const rows = [
    {
      category: 'decision',
      confidence: 0.7,
      content: 'Release readiness update for onboarding messaging.',
      created_at: '2026-02-08T11:00:00.000Z',
      id: 100,
      keyword_hint: 1,
      project: TEST_PROJECT,
      semantic_relevance: 0.23,
      tags: ['release', 'readiness'],
    },
    {
      category: 'decision',
      confidence: 0.7,
      content: 'Release readiness update for document quality gate thresholds.',
      created_at: '2026-02-08T10:00:00.000Z',
      id: 101,
      keyword_hint: 1,
      project: TEST_PROJECT,
      semantic_relevance: 0.17,
      tags: ['document', 'quality-gate', 'input'],
    },
  ];

  const withoutGoal = rerankHybridSearchRows(rows, {
    limit: 5,
    queryText: 'release readiness update',
  });
  assert.equal(withoutGoal[0]?.id, 100, 'higher base semantic score should lead without goal conditioning');

  const withGoal = rerankHybridSearchRows(rows, {
    goalText: 'Ship document quality gate input accuracy improvements',
    limit: 5,
    queryText: 'release readiness update',
  });
  assert.equal(withGoal[0]?.id, 101, 'goal overlap should boost the document-related row');
});

test('goal-conditioned boost is additive and absent when goalText is not provided', () => {
  const rows = [
    {
      category: 'decision',
      confidence: 0.8,
      content: 'Finalize issue workflow messaging.',
      created_at: '2026-02-08T10:00:00.000Z',
      id: 110,
      keyword_hint: 1,
      project: TEST_PROJECT,
      semantic_relevance: 0.2,
      tags: ['workflow'],
    },
  ];

  const withoutGoal = rerankHybridSearchRows(rows, {
    limit: 5,
    queryText: 'workflow messaging',
  });
  const withGoal = rerankHybridSearchRows(rows, {
    goalText: 'document accuracy milestone for quality gate',
    limit: 5,
    queryText: 'workflow messaging',
  });

  const topWithoutGoal = withoutGoal[0];
  const topWithGoal = withGoal[0];
  assert.ok(topWithoutGoal !== undefined);
  assert.ok(topWithGoal !== undefined);
  assert.equal(topWithoutGoal.id, 110);
  assert.equal(topWithGoal.id, 110);
  const actual = toNumber(topWithGoal.relevance);
  const expected = toNumber(topWithoutGoal.relevance);
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `row with no goal overlap should not receive a boost (|${String(actual)} - ${String(expected)}| < 1e-9)`,
  );
});

test('hybrid reranking promotes a precise memory key or issue evidence reference over generic historical context', () => {
  const rows = [
    {
      category: 'session-summary',
      confidence: 0.3,
      content: 'Recent source-attributed checkpoint.',
      created_at: '2026-09-08T12:00:00.000Z',
      evidence_refs: [{ type: 'github_issue', url: 'https://github.com/example/catalog/issues/2930' }],
      id: 120,
      keyword_hint: 1,
      memory_key: 'example/catalog:primary-cross-harness-memory-2026-09-08',
      project: TEST_PROJECT,
      semantic_relevance: 0.04,
      source: 'grok-session-end',
      tags: ['grok-session-end', 'session-history'],
    },
    {
      category: 'decision',
      confidence: 0.95,
      content: 'Historical generic memory workflow guidance.',
      created_at: '2026-08-01T12:00:00.000Z',
      evidence_refs: [],
      id: 121,
      keyword_hint: 0,
      memory_key: 'example/catalog:historical-workflow-guidance',
      project: TEST_PROJECT,
      semantic_relevance: 0.14,
      source: 'memory-delta',
      tags: ['workflow'],
    },
  ];

  const byKey = rerankHybridSearchRows(rows, {
    limit: 2,
    queryText: 'primary-cross-harness-memory-2026-09-08',
  });
  const byEvidence = rerankHybridSearchRows(rows, {
    limit: 2,
    queryText: 'github.com/example/catalog/issues/2930',
  });

  assert.equal(byKey[0]?.id, 120, 'known memory-key terms must outrank unrelated historical context');
  assert.equal(byEvidence[0]?.id, 120, 'issue/PR evidence terms must retrieve their source-linked record');
});

function toNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

test('reference matching handles joined and held-out issue wording without matching measurements or longer IDs', () => {
  for (const number of [4821, 7042]) {
    for (const query of [String(number), `Issue${String(number)} delivered`, `issue #${String(number)}`]) {
      const pattern = buildSearchReferencePattern(query);
      assert.ok(pattern !== undefined);
      const matcher = new RegExp(pattern, 'iu');
      for (const reference of [
        `Issue${String(number)} delivered`,
        `issue-${String(number)}`,
        `https://example.invalid/repo/issues/${String(number)}`,
      ]) {
        assert.ok(matcher.test(reference), reference);
      }
      assert.equal(matcher.test(`${String(number)} sampling evaluations`), false);
      assert.equal(matcher.test(`Issue${String(number)}0`), false);
    }
  }
  assert.equal(normalizeSearchReferenceText('Issue4821 accepted'), 'Issue 4821 accepted');
  assert.equal(buildSearchReferencePattern('offline archive constraint'), undefined);
});

test('reference ranking preserves field boundaries while matching real references in each field', () => {
  const rows = [
    {
      content: 'Historical note ending in issue',
      evidence_refs: [],
      id: 1,
      memory_key: '9364-note',
      semantic_relevance: 0.1,
      status: 'active',
      tags: [],
    },
    {
      content: 'Issue 9364 decision',
      evidence_refs: [],
      id: 2,
      memory_key: 'ordinary-key',
      semantic_relevance: 0.1,
      status: 'active',
      tags: [],
    },
    {
      content: 'Evidence-backed decision',
      evidence_refs: ['https://example.invalid/repo/issues/9364'],
      id: 3,
      memory_key: 'evidence-key',
      semantic_relevance: 0.1,
      status: 'active',
      tags: [],
    },
    {
      content: 'Tagged decision',
      evidence_refs: [],
      id: 4,
      memory_key: 'tag-key',
      semantic_relevance: 0.1,
      status: 'active',
      tags: ['issue-9364'],
    },
  ];

  const ranked = rerankHybridSearchRows(rows, { limit: rows.length, queryText: 'issue9364' });
  const relevance = new Map(ranked.map(row => [row.id, toNumber(row.relevance)]));
  for (const id of [2, 3, 4]) assert.ok((relevance.get(id) ?? 0) > (relevance.get(1) ?? 0));
});

test('explicit references survive long wording and goal-only references without promoting quantities', () => {
  for (const number of [4821, 7042]) {
    const wording = 'Recover the current source decision with original approval and precise evidence for';
    for (const [query, goal] of [
      [`${wording} issue${String(number)}`, ''],
      [wording, `issue${String(number)}`],
    ]) {
      const pattern = buildSearchReferencePattern(query ?? '', goal);
      assert.ok(pattern !== undefined);
      assert.match(`issue-${String(number)}`, new RegExp(pattern, 'iu'));
    }
    for (const query of [
      `sampling report counted ${String(number)} evaluations histogram bucket`,
      `${String(number)} evaluations were counted in the sampling report`,
    ]) {
      assert.equal(buildSearchReferencePattern(query), undefined);
      const rows = [
        { content: query, id: 1, semantic_relevance: 0.1, status: 'active' },
        ...Array.from({ length: 12 }, (_, index) => ({
          content: `Issue #${String(number)} unrelated discussion.`,
          id: index + 2,
          semantic_relevance: 0.01,
          status: 'active',
        })),
      ];
      assert.equal(rerankHybridSearchRows(rows, { limit: 5, queryText: query })[0]?.id, 1);
    }
  }
});

test('reference ranking separates issue recovery from an explicit measurement query', () => {
  const rows = [
    {
      category: 'decision',
      content: 'Issue4821 delivered bounded output with Astra/Medium and disabled ai-reviewer.',
      evidence_refs: ['https://example.invalid/repo/issues/4821'],
      id: 8101,
      semantic_relevance: 0.04,
      status: 'active',
    },
    {
      category: 'decision',
      content: 'The sampling report counted 4821 evaluations with a histogram bucket labelled Medium.',
      evidence_refs: ['https://example.invalid/evidence/measurement'],
      id: 8102,
      semantic_relevance: 0.04,
      status: 'active',
    },
    {
      category: 'architecture',
      content: 'Old ai-reviewer architecture discussed bounded output and Medium model choices.',
      evidence_refs: ['https://example.invalid/repo/issues/1934'],
      id: 8103,
      semantic_relevance: 0.05,
      status: 'active',
    },
  ];
  assert.equal(
    rerankHybridSearchRows(rows, { limit: 3, queryText: '4821 bounded output Medium ai-reviewer' })[0]?.id,
    8101,
  );
  assert.equal(
    rerankHybridSearchRows(rows, {
      limit: 3,
      queryText: 'sampling report counted 4821 evaluations histogram bucket',
    })[0]?.id,
    8102,
  );
});
