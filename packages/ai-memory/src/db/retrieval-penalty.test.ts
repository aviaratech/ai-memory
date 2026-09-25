import assert from 'node:assert/strict';
import { test } from 'vitest';

import { applyReadReversalPenalties } from './retrieval-penalty.js';

type ReadPenaltyClient = Parameters<typeof applyReadReversalPenalties>[0];

function createClient(rows: Record<string, unknown>[]) {
  const calls: { params: readonly unknown[] | undefined; sql: string }[] = [];
  const client: ReadPenaltyClient = {
    query(sql: string, params?: readonly unknown[]) {
      calls.push({ params, sql });
      return Promise.resolve({ rowCount: rows.length, rows });
    },
  };
  return {
    calls,
    client,
  };
}

test('applyReadReversalPenalties annotates non-trivial priors and caps penalty at half weight', async () => {
  const { calls, client } = createClient([
    {
      author: 'agent-a',
      category: 'architecture',
      mean_declared_confidence: 0.8,
      prior_memory_count: 12,
      reversal_count: 10,
      tag: 'retrieval',
    },
  ]);

  const rows = await applyReadReversalPenalties(client, [
    {
      agent: 'agent-a',
      category: 'architecture',
      id: 1,
      source: 'manual',
      tags: ['retrieval'],
    },
  ]);

  assert.equal(calls.length, 1, 'one prior lookup should be enough for one author/category/tag cell');
  assert.equal(calls[0]?.params?.[0], 'agent-a');
  assert.equal(rows[0]?.reversal_penalty, 0.5);
  assert.deepEqual(rows[0].signals, {
    priorMemoryCount: 12,
    reversalPenalty: 0.5,
    reversalRate: 0.8333,
    scope: 'author x category x tag',
    window: '30d',
  });
  assert.equal(Object.hasOwn(rows[0], 'reversal_histogram_7d'), false);
  assert.equal(Object.hasOwn(rows[0].signals, 'reversalHistogram7d'), false);
});

test('applyReadReversalPenalties omits penalty signals for thin priors', async () => {
  const { client } = createClient([
    {
      mean_declared_confidence: 0.8,
      prior_memory_count: 9,
      reversal_count: 8,
    },
    {
      mean_declared_confidence: 0.8,
      prior_memory_count: 9,
      reversal_count: 8,
    },
  ]);

  const rows = await applyReadReversalPenalties(client, [
    {
      category: 'architecture',
      id: 1,
      source: 'manual',
      tags: ['retrieval'],
    },
  ]);

  assert.equal(rows[0]?.reversal_penalty, undefined);
  assert.equal(rows[0]?.signals, undefined);
});

test('applyReadReversalPenalties batches prior lookups for multiple retrieval rows', async () => {
  const calls: { params: readonly unknown[] | undefined; sql: string }[] = [];
  const client: ReadPenaltyClient = {
    query(sql: string, params?: readonly unknown[]) {
      calls.push({ params, sql });
      if (sql.includes('read_reversal_prior_tag_batch')) {
        return Promise.resolve({
          rows: [
            {
              author: 'author-a',
              category: 'architecture',
              mean_declared_confidence: 0.8,
              prior_memory_count: 12,
              reversal_count: 6,
              tag: 'fast',
            },
          ],
        });
      }
      if (sql.includes('read_reversal_prior_category_batch')) {
        return Promise.resolve({
          rows: [
            {
              author: 'author-b',
              category: 'decision',
              mean_declared_confidence: 0.8,
              prior_memory_count: 20,
              reversal_count: 5,
            },
            {
              author: 'author-c',
              category: 'convention',
              mean_declared_confidence: 0.8,
              prior_memory_count: 9,
              reversal_count: 9,
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    },
  };

  const rows = await applyReadReversalPenalties(client, [
    {
      category: 'architecture',
      id: 1,
      source: 'author-a',
      tags: ['fast'],
    },
    {
      category: 'decision',
      id: 2,
      source: 'author-b',
      tags: ['slow'],
    },
    {
      category: 'convention',
      id: 3,
      source: 'author-c',
      tags: [],
    },
  ]);

  assert.equal(calls.length, 2, 'tag-scoped and category-scoped priors should be batched');
  assert.ok(calls[0]?.sql.includes('read_reversal_prior_tag_batch'));
  assert.ok(calls[1]?.sql.includes('read_reversal_prior_category_batch'));
  assert.deepEqual(
    rows.map(row => row.reversal_penalty),
    [0.5, 0.75, undefined],
  );
  assert.deepEqual(
    rows.map(row => (isRecord(row.signals) ? row.signals.scope : undefined)),
    ['author x category x tag', 'author x category', undefined],
  );
});

test('applyReadReversalPenalties preserves retrieval rows when prior lookup fails', async () => {
  const client: ReadPenaltyClient = {
    query() {
      return Promise.reject(new Error('prior lookup timeout'));
    },
  };
  const inputRow = {
    category: 'architecture',
    id: 1,
    source: 'manual',
    tags: ['retrieval'],
  };

  const rows = await applyReadReversalPenalties(client, [inputRow]);

  assert.deepEqual(rows, [inputRow]);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
