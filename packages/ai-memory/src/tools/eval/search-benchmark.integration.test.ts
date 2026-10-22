import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, test } from 'vitest';

import {
  assertLocalDatabaseUrl,
  buildHybridSearchQuery,
  closePool,
  initializeDatabase,
  pool,
  resolveTimeoutPolicy,
  searchMemories,
} from '@aviaratech/ai-memory/internal';

import { buildMemorySearchPoolCtes } from '../../db/memory-sql.js';
import {
  buildSearchExactLookups,
  buildSearchReferencePattern,
  extractSearchReferenceNumbers,
} from '../../db/query-helpers.js';
import { applyReadReversalPenalties } from '../../db/retrieval-penalty.js';
import {
  buildBenchmarkQueries,
  buildBenchmarkVocabulary,
  buildLabelledQueries,
  removeSyntheticSearchCorpus,
  seedSyntheticSearchCorpus,
} from './search-benchmark.js';

const databaseUrl = process.env.AI_MEMORY_DATABASE_URL;
const SHARED_TERM = 'lanternx';

afterAll(async () => {
  if (databaseUrl !== undefined) await closePool();
});

test(
  'search over more than 10k matching memories returns ranked results within the read budget',
  { skip: databaseUrl === undefined, timeout: 300_000 },
  async () => {
    assert.ok(databaseUrl);
    assertLocalDatabaseUrl(databaseUrl);
    const project = `ci/search-scale-${randomUUID()}`;
    try {
      await initializeDatabase();
      await seedSyntheticSearchCorpus(pool, {
        embeddings: false,
        project,
        rows: 12_000,
        seed: 0.17,
        sharedTerm: SHARED_TERM,
      });
      const matched = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM ai_memory_entries WHERE project = $1 AND search_vector @@ to_tsquery('english', $2)",
        [project, SHARED_TERM],
      );
      assert.ok(Number(matched.rows[0]?.count) > 10_000, 'every seeded memory should match the shared term');

      const manyTermQuery = buildBenchmarkQueries().find(query => query.queryClass === 'many-term');
      assert.ok(manyTermQuery);
      const started = performance.now();
      const results = await searchMemories({
        includeEmbedding: false,
        limit: 8,
        project,
        query: `${SHARED_TERM} ${manyTermQuery.text}`,
      });
      const elapsedMs = performance.now() - started;

      assert.equal(results.length, 8);
      assert.ok(results.every(memory => memory.project === project));
      assert.ok(
        elapsedMs < resolveTimeoutPolicy().db.readTimeoutMs,
        `search took ${String(Math.round(elapsedMs))}ms against the read budget`,
      );
    } finally {
      await removeSyntheticSearchCorpus(pool, project);
    }
  },
);

interface PlanNode {
  'Actual Loops'?: number;
  'Index Name'?: string;
  'Node Type': string;
  Plans?: PlanNode[];
  'Relation Name'?: string;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
}

function collectPlanNodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(collectPlanNodes)];
}

/**
 * Plans a statement with sequential scans disabled, so a table scan means no index path exists. With `analyze`,
 * the statement also runs, so the nodes carry the rows they read and discarded.
 */
async function planWithoutSeqScan(sql: string, params: readonly unknown[], analyze = false): Promise<PlanNode[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    const result = await client.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
      `EXPLAIN (${analyze ? 'ANALYZE, ' : ''}FORMAT JSON) ${sql}`,
      [...params],
    );
    const root = result.rows[0]?.['QUERY PLAN'][0]?.Plan;
    assert.ok(root, 'expected a query plan');
    return collectPlanNodes(root);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

function assertNoTableScan(nodes: PlanNode[], label: string) {
  const scans = nodes.filter(node => node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'ai_memory_entries');
  assert.equal(scans.length, 0, `${label} must read ai_memory_entries through an index`);
}

/** Index-order walks that test a filter on every row they pass show up as discarded rows, not as a scan type. */
function assertNoWalkOfTheTable(nodes: PlanNode[], tableRows: number, label: string) {
  for (const node of nodes) {
    if (node['Relation Name'] !== 'ai_memory_entries') continue;
    const discarded =
      (node['Actual Loops'] ?? 1) *
      ((node['Rows Removed by Filter'] ?? 0) + (node['Rows Removed by Index Recheck'] ?? 0));
    assert.ok(
      discarded <= tableRows / 4,
      `${label}: ${node['Node Type']} on ${node['Index Name'] ?? 'the table'} discarded ${String(discarded)} of ${String(tableRows)} rows`,
    );
  }
}

describe('index-first search', { skip: databaseUrl === undefined }, () => {
  const project = `ci/search-index-first-${randomUUID()}`;
  const vocabulary = buildBenchmarkVocabulary();
  const hotTerms = [vocabulary[0] ?? '', vocabulary[1] ?? ''];

  async function plant(row: { content: string; evidence?: string[]; key?: string; tags?: string[] }): Promise<number> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO ai_memory_entries (content, project, category, memory_type, tags, source, confidence, memory_key, evidence_refs, created_at)
       VALUES ($1, $2, 'decision', 'semantic', $3, 'planted-fixture', 0.9, $4, $5::jsonb, NOW() - INTERVAL '200 days')
       RETURNING id`,
      [row.content, project, row.tags ?? [], row.key ?? null, JSON.stringify(row.evidence ?? [])],
    );
    return Number(result.rows[0]?.id);
  }

  const planted = { exactKey: 0, goalMatch: 0, oldReference: 0, reference: 0, rareTerm: 0, tag: 0 };
  let tableRows = 0;
  const labelledIds = new Map<string, number>();

  beforeAll(async () => {
    assert.ok(databaseUrl);
    assertLocalDatabaseUrl(databaseUrl);
    await initializeDatabase();
    await seedSyntheticSearchCorpus(pool, { embeddings: false, project, rows: 12_000, seed: 0.31 });
    planted.rareTerm = await plant({ content: 'The zyxwquorum rollout was decided in a long-ago review.' });
    // The key and tag contain only terms that nearly every row also contains.
    planted.exactKey = await plant({ content: 'A pointer record.', key: hotTerms.join(' ') });
    planted.tag = await plant({ content: 'A tagged record.', tags: [`${hotTerms[0] ?? ''}-${hotTerms[1] ?? ''}`] });
    planted.reference = await plant({
      content: 'Follow-up recorded against issue #7777 during the review.',
      evidence: ['https://example.invalid/issues/7777'],
    });
    // One of several hundred rows containing a medium-frequency term, old enough that recency never picks it.
    planted.goalMatch = await plant({ content: `Tracked under issue #7791: ${vocabulary[200] ?? ''}.` });
    planted.oldReference = await plant({ content: 'Resolved under issue #7778 during the long-ago review.' });
    // Two terms that are each common (more than the common-term limit) and never occur together.
    await pool.query(
      `INSERT INTO ai_memory_entries (content, project, category, memory_type, source, confidence)
       SELECT CASE WHEN g % 2 = 0 THEN 'note about aardx number ' ELSE 'note about bbrdx number ' END || g, $1,
         'decision', 'semantic', 'planted-fixture', 0.8
       FROM generate_series(1, 5000) AS g`,
      [project],
    );
    // Newer rows that carry the same number as a plain quantity, not as a reference.
    await pool.query(
      `INSERT INTO ai_memory_entries (content, project, category, memory_type, source, confidence)
       SELECT 'measured 7778 samples in run ' || g, $1, 'decision', 'semantic', 'planted-fixture', 0.8
       FROM generate_series(1, 1500) AS g`,
      [project],
    );
    for (const labelled of buildLabelledQueries()) {
      for (const content of labelled.relevantContents) labelledIds.set(content, await plant({ content }));
    }
    await pool.query('ANALYZE ai_memory_entries');
    tableRows = Number(
      (
        await pool.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM ai_memory_entries WHERE project = $1',
          [project],
        )
      ).rows[0]?.count,
    );
  }, 300_000);

  afterAll(async () => {
    await removeSyntheticSearchCorpus(pool, project);
  }, 300_000);

  async function search(query: string, activeGoal?: string) {
    const results = await searchMemories({
      includeEmbedding: false,
      limit: 8,
      project,
      query,
      ...(activeGoal === undefined ? {} : { activeGoal }),
    });
    return results.map(memory => memory.id);
  }

  /** Ids that the index channels hand to ranking, before any rank is computed. */
  async function poolIds(queryText: string): Promise<number[]> {
    const lookups = buildSearchExactLookups(queryText);
    const numbers = extractSearchReferenceNumbers(queryText);
    const referencePattern = buildSearchReferencePattern(queryText);
    const params: unknown[] = [queryText, lookups.keys, lookups.tags, project];
    if (referencePattern !== undefined) params.push(numbers, referencePattern);
    const ctes = buildMemorySearchPoolCtes({
      baseConditions: [
        "status IN ('active', 'contested')",
        '(expires_at IS NULL OR expires_at > NOW())',
        'project = $4',
      ],
      exactKeysParam: '$2',
      exactTagsParam: '$3',
      queryParams: ['$1'],
      reference: referencePattern === undefined ? undefined : { numbersParam: '$5', patternParam: '$6' },
    });
    const result = await pool.query<{ id: string }>(`WITH ${ctes} SELECT id FROM text_pool`, params);
    return result.rows.map(row => Number(row.id));
  }

  test(
    'puts a rare term in the candidate pool when it sits among many common terms',
    { timeout: 120_000 },
    async () => {
      const manyTerm = buildBenchmarkQueries().find(query => query.queryClass === 'many-term');
      assert.ok(manyTerm);
      const ids = await poolIds(`zyxwquorum ${manyTerm.text}`);
      assert.ok(ids.includes(planted.rareTerm));
      assert.ok(ids.length <= 400, 'the pool stays small enough to rank');
    },
  );

  test(
    'puts a record with an exact memory key in the pool when every query term is common',
    { timeout: 120_000 },
    async () => {
      assert.ok((await poolIds(hotTerms.join(' '))).includes(planted.exactKey));
    },
  );

  test(
    'puts a record with an exact tag in the pool when every query term is common',
    { timeout: 120_000 },
    async () => {
      assert.ok((await poolIds(`${hotTerms[0] ?? ''}-${hotTerms[1] ?? ''}`)).includes(planted.tag));
    },
  );

  test('puts issue references in the pool through the stored-vector index', { timeout: 120_000 }, async () => {
    assert.ok((await poolIds('issue #7777')).includes(planted.reference));
  });

  test('ranks a record that only the rare term matches first', { timeout: 120_000 }, async () => {
    assert.equal((await search('zyxwquorum rollout'))[0], planted.rareTerm);
  });

  test('ranks the record an issue reference names first', { timeout: 120_000 }, async () => {
    assert.equal((await search('issue #7777'))[0], planted.reference);
  });

  test('puts a rare term in the pool wherever it sits in a long query', { timeout: 120_000 }, async () => {
    const common = vocabulary.slice(0, 25).join(' ');
    assert.ok((await poolIds(`${common} zyxwquorum`)).includes(planted.rareTerm), 'rare term last');
    assert.ok((await poolIds(`zyxwquorum ${common}`)).includes(planted.rareTerm), 'rare term first');
  });

  test('never lets a negated term select candidates', { timeout: 120_000 }, async () => {
    const ids = await poolIds(`${hotTerms[0] ?? ''} -zyxwquorum`);
    assert.ok(!ids.includes(planted.rareTerm));
    assert.ok(ids.length > 0);
  });

  test('keeps references in the active goal from selecting candidates', { timeout: 120_000 }, async () => {
    const ids = await search('zyxwquorum rollout', 'finish issue #7777 and issue #7778');
    assert.equal(ids[0], planted.rareTerm);
    assert.ok(!ids.includes(planted.reference), 'a record that only the goal references stays out');
    assert.ok(!ids.includes(planted.oldReference));
  });

  test('lets a goal reference move a row that matches the query to the top', { timeout: 120_000 }, async () => {
    const term = vocabulary[200] ?? '';
    const withGoal = await search(term, 'finish issue #7791');
    assert.equal(withGoal[0], planted.goalMatch, 'the row the goal names and the query matches ranks first');
  });

  test('runs awkward queries without error', { timeout: 120_000 }, async () => {
    const queries = [
      '"zyxwquorum rollout"',
      'zyxwquorum OR harbor',
      'zyxwquorum -harbor',
      '-harbor',
      '-zyxwquorum -harbor',
      '"zyxwquorum rollout" OR -harbor',
      'the and or',
      '!!!',
      "O'Brien's \\ backslash",
      'café naïve',
      'issue4821',
      'issues/4821 -harbor',
      '4821 samples',
    ];
    for (const query of queries) {
      const ids = await search(query);
      assert.ok(Array.isArray(ids), query);
    }
    assert.equal((await search('zyxwquorum -harbor'))[0], planted.rareTerm);
  });

  test('finds an older true reference behind many newer plain numbers', { timeout: 120_000 }, async () => {
    assert.ok((await poolIds('issue #7778')).includes(planted.oldReference));
  });

  test('returns results for two common terms that never occur together', { timeout: 120_000 }, async () => {
    const ids = await search('aardx bbrdx');
    assert.equal(ids.length, 8);
    assert.ok((await poolIds('aardx bbrdx')).length >= 50, 'the newest rows matching either term fill the pool');
  });

  test('ranks planted records for labelled queries over a corpus of thousands', { timeout: 300_000 }, async () => {
    const recall = new Map<string, { hits: number; total: number }>();
    for (const labelled of buildLabelledQueries()) {
      const found = await search(labelled.query);
      const band = recall.get(labelled.frequency) ?? { hits: 0, total: 0 };
      for (const content of labelled.relevantContents) {
        band.total += 1;
        if (found.includes(labelledIds.get(content) ?? -1)) band.hits += 1;
      }
      recall.set(labelled.frequency, band);
    }
    // Queries made of the few most common terms are not asserted: thousands of rows contain every term, and
    // neither this ranking nor the previous release's separates the planted records from them.
    for (const frequency of ['rare', 'medium', 'frequent']) {
      const band = recall.get(frequency);
      assert.ok(band);
      assert.ok(
        band.hits / band.total >= 0.9,
        `${frequency} terms: recall@8 ${String(band.hits)}/${String(band.total)}`,
      );
    }
  });

  test('fills the result limit for a query made only of common terms', { timeout: 120_000 }, async () => {
    const ids = await search(hotTerms.join(' '));
    assert.equal(ids.length, 8);
  });

  test('plans candidate retrieval through indexes without walking the table', { timeout: 120_000 }, async () => {
    const queries = [
      buildBenchmarkQueries().find(query => query.queryClass === 'many-term')?.text ?? '',
      buildBenchmarkQueries().find(query => query.queryClass === 'long')?.text ?? '',
      'issue #7777 review',
      hotTerms[0] ?? '',
      hotTerms.join(' '),
      // Terms that are common but never occur together, and terms whose only matches are filtered out afterwards.
      'aardx bbrdx',
      'session summary',
      'architecture convention',
      'architecture -decision',
    ];
    for (const queryText of queries) {
      const { params, sql } = buildHybridSearchQuery({
        includeInactive: false,
        limit: 8,
        project,
        queryEmbedding: null,
        queryText,
      });
      const label = `search for "${queryText.slice(0, 30)}"`;
      const nodes = await planWithoutSeqScan(sql, params, true);
      assertNoTableScan(nodes, label);
      assertNoWalkOfTheTable(nodes, tableRows, label);
      assert.ok(
        nodes.some(node => node['Index Name'] === 'ai_memory_entries_search_vector_idx'),
        'full-text candidates must come from the stored-vector index',
      );
    }
  });

  test('plans reversal-prior lookups through the tags and author indexes', { timeout: 120_000 }, async () => {
    const statements: { params: readonly unknown[]; sql: string }[] = [];
    const client = {
      query: (sql: string, params?: readonly unknown[]) => {
        statements.push({ params: params ?? [], sql });
        return Promise.resolve({ rows: [] as Record<string, unknown>[] });
      },
    };
    await applyReadReversalPenalties(client, [
      { category: 'decision', source: 'synthetic-benchmark', tags: ['no-such-tag'] },
    ]);
    const tagBatch = statements.find(statement => statement.sql.includes('read_reversal_prior_tag_batch'));
    const categoryBatch = statements.find(statement => statement.sql.includes('read_reversal_prior_category_batch'));
    assert.ok(tagBatch && categoryBatch, 'a thin tag prior falls back to the category prior');

    const tagNodes = await planWithoutSeqScan(tagBatch.sql, tagBatch.params);
    assertNoTableScan(tagNodes, 'tag prior lookup');
    assert.ok(tagNodes.some(node => node['Index Name'] === 'ai_memory_entries_tags_gin_idx'));

    const categoryNodes = await planWithoutSeqScan(categoryBatch.sql, categoryBatch.params);
    assertNoTableScan(categoryNodes, 'category prior lookup');
    assert.ok(categoryNodes.some(node => node['Index Name'] === 'ai_memory_entries_author_category_created_idx'));
  });
});
