import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { test } from 'vitest';

import {
  assertLocalDatabaseUrl,
  closePool,
  initializeDatabase,
  pool,
  resolveTimeoutPolicy,
  searchMemories,
} from '@aviaratech/ai-memory/internal';

import { buildBenchmarkQueries, removeSyntheticSearchCorpus, seedSyntheticSearchCorpus } from './search-benchmark.js';

const databaseUrl = process.env.AI_MEMORY_DATABASE_URL;
const SHARED_TERM = 'lanternx';

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
      try {
        await removeSyntheticSearchCorpus(pool, project);
      } finally {
        await closePool();
      }
    }
  },
);
