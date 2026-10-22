import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'vitest';

import { assertLocalDatabaseUrl, closePool, initializeDatabase, pool } from '@aviaratech/ai-memory/internal';

import { applyReadReversalPenalties } from './retrieval-penalty.js';
import { removeSyntheticSearchCorpus } from '../tools/eval/search-benchmark.js';

const databaseUrl = process.env.AI_MEMORY_DATABASE_URL;

test(
  'selective tag priors use the tags index while preserving counts and category fallback',
  { skip: databaseUrl === undefined, timeout: 0 },
  async () => {
    assert.ok(databaseUrl);
    assertLocalDatabaseUrl(databaseUrl);
    const project = `ci/tag-prior-${randomUUID()}`;
    const author = `synthetic-${randomUUID()}`;
    const captured: { params: readonly unknown[] | undefined; sql: string }[] = [];
    const client = {
      async query(sql: string, params?: readonly unknown[]) {
        if (sql.includes('read_reversal_prior_tag_batch')) captured.push({ params, sql });
        return pool.query<Record<string, unknown>>(sql, params === undefined ? undefined : [...params]);
      },
    };
    try {
      await initializeDatabase();
      await pool.query(
        `INSERT INTO ai_memory_entries (content, project, category, memory_type, agent, tags, confidence, status)
         SELECT 'Synthetic prior index fixture', $1, 'ARCHITECTURE', 'semantic', $2,
           ARRAY[CASE WHEN g <= 320 THEN 'target-' || ((g - 1) / 20)::text ELSE 'noise-' || g::text END],
           0.8, CASE WHEN g <= 320 AND g % 4 = 0 THEN 'superseded' ELSE 'active' END
         FROM generate_series(1, 47882) AS g`,
        [project, author],
      );
      await pool.query('ANALYZE ai_memory_entries');

      const rows = await applyReadReversalPenalties(
        client,
        Array.from({ length: 16 }, (_, id) => ({
          agent: author,
          category: 'architecture',
          id,
          tags: [`target-${id}`],
        })),
      );
      assert.equal(captured.length, 1, 'all selective tag priors remain one batched lookup');
      for (const row of rows) {
        assert.equal(row.reversal_penalty, 0.75);
        assert.deepEqual(row.signals, {
          priorMemoryCount: 20,
          reversalPenalty: 0.75,
          reversalRate: 0.25,
          scope: 'author x category x tag',
          window: '30d',
        });
      }
      const query = captured[0];
      assert.ok(query);
      const plan = await pool.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`,
        query.params === undefined ? undefined : [...query.params],
      );
      assert.ok(
        JSON.stringify(plan.rows).includes('ai_memory_entries_tags_gin_idx'),
        'selective per-tag aggregates should use the existing tags GIN without planner overrides',
      );

      const fallback = await applyReadReversalPenalties(client, [
        { agent: author, category: 'architecture', id: 100, tags: ['absent-tag'] },
        { agent: `${author}-absent`, category: 'architecture', id: 101, tags: ['absent-tag'] },
      ]);
      assert.equal(fallback[0]?.reversal_prior_memory_count, 47882);
      assert.equal(fallback[0]?.reversal_prior_scope, 'author x category');
      assert.equal(fallback[1]?.reversal_penalty, undefined, 'zero tag and category counts must remain a thin prior');
    } finally {
      try {
        await removeSyntheticSearchCorpus(pool, project);
      } finally {
        await closePool();
      }
    }
  },
);
