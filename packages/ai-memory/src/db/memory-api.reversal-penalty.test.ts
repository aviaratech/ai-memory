import type { QueryResult, QueryResultRow } from 'pg';

import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { afterEach, describe, it } from 'vitest';

import { recallMemories, searchMemories } from './memory-api.js';
import { mockPoolConnect } from './test-pool-mock.js';

function buildComparableRow(overrides: Record<string, unknown> = {}) {
  return {
    agent: null,
    category: 'convention',
    confidence: 0.9,
    content: 'Convention: reversal-aware retrieval ranking uses author track record as a soft penalty.',
    created_at: new Date('2026-04-29T10:00:00.000Z'),
    decayed_importance: 0.8,
    dedupe_hash: 'sha256:reversal-test',
    evidence_refs: [],
    id: 201,
    keyword_hint: 1,
    metadata_json: {},
    or_semantic_relevance: 0.2,
    project: 'example/catalog',
    semantic_relevance: 0.2,
    source: 'stable-author',
    status: 'active',
    tags: ['ai-memory', 'reversal-aware'],
    updated_at: new Date('2026-04-29T10:00:00.000Z'),
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

describe('retrieval reversal penalties', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('searchMemories down-weights high-reversal authors and exposes the penalty signal', async () => {
    mockPoolConnect((sql: string) => {
      if (sql.includes('read_reversal_prior_category')) {
        return Promise.resolve(
          toQueryResult([
            {
              author: 'volatile-author',
              category: 'convention',
              prior_memory_count: 18,
              reversal_count: 9,
            },
          ]),
        );
      }
      if (sql.includes('read_reversal_prior_tag')) {
        return Promise.resolve(toQueryResult([]));
      }
      if (sql.includes('WITH filtered_candidates')) {
        return Promise.resolve(
          toQueryResult([
            buildComparableRow({
              created_at: new Date('2026-04-29T12:00:00.000Z'),
              id: 201,
              source: 'volatile-author',
            }),
            buildComparableRow({
              created_at: new Date('2026-04-29T11:00:00.000Z'),
              id: 202,
              source: 'stable-author',
            }),
          ]),
        );
      }
      return Promise.resolve(toQueryResult([]));
    });

    const results = await searchMemories({
      limit: 2,
      query: 'reversal aware retrieval ranking author track record',
    });

    assert.equal(results[0]?.id, 202, 'stable author should outrank comparable high-reversal author');
    assert.equal(results[1]?.id, 201);
    assert.deepEqual(results[1].signals, {
      priorMemoryCount: 18,
      reversalPenalty: 0.5,
      reversalRate: 0.5,
      scope: 'author x category',
      window: '30d',
    });
  });

  it('recallMemories applies reversal penalty after baseline recall ranking', async () => {
    mockPoolConnect((sql: string) => {
      if (sql.includes('read_reversal_prior_category')) {
        return Promise.resolve(
          toQueryResult([
            {
              author: 'volatile-author',
              category: 'convention',
              prior_memory_count: 12,
              reversal_count: 12,
            },
          ]),
        );
      }
      if (sql.includes('read_reversal_prior_tag')) {
        return Promise.resolve(toQueryResult([]));
      }
      if (sql.includes('FROM ai_memory_entries') && sql.includes('ORDER BY')) {
        return Promise.resolve(
          toQueryResult([
            buildComparableRow({
              decayed_importance: 0.95,
              id: 301,
              source: 'volatile-author',
            }),
            buildComparableRow({
              decayed_importance: 0.8,
              id: 302,
              source: 'stable-author',
            }),
          ]),
        );
      }
      return Promise.resolve(toQueryResult([]));
    });

    const results = await recallMemories({ limit: 2, sinceDays: 30 });

    assert.equal(results[0]?.id, 302, 'stable author should outrank capped high-reversal author after penalty');
    assert.equal(results[1]?.id, 301);
    assert.deepEqual(results[1].signals, {
      priorMemoryCount: 12,
      reversalPenalty: 0.5,
      reversalRate: 1,
      scope: 'author x category',
      window: '30d',
    });
  });
});
