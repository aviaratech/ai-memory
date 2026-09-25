import type { QueryResult, QueryResultRow } from 'pg';

import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { afterEach, describe, it } from 'vitest';

import { getMemoryEntries } from './memory-api.js';
import { mockPoolConnect } from './test-pool-mock.js';

function createMemoryRow(id: number, overrides: Record<string, unknown> = {}) {
  return {
    category: 'decision',
    confidence: 0.8,
    content: `Memory row ${String(id)}`,
    created_at: new Date('2026-02-22T00:00:00.000Z'),
    dedupe_hash: `sha256:test-${String(id)}`,
    evidence_refs: [],
    id,
    memory_type: 'episodic',
    metadata_json: {},
    project: 'example/catalog',
    source: 'codex-test',
    status: 'active',
    tags: [],
    updated_at: new Date('2026-02-22T00:00:00.000Z'),
    ...overrides,
  };
}

describe('memory_get / getMemoryEntries', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('deduplicates ids while preserving caller-provided order', async () => {
    const capturedQueries: { params: readonly unknown[]; sql: string }[] = [];
    mockPoolConnect((sql: string, params?: readonly unknown[]) => {
      capturedQueries.push({ params: params ?? [], sql });
      const result: QueryResult<QueryResultRow> = {
        command: 'SELECT',
        fields: [],
        oid: 0,
        rowCount: 3,
        rows: [createMemoryRow(3), createMemoryRow(5), createMemoryRow(9)],
      };
      return Promise.resolve(result);
    });

    const memories = await getMemoryEntries({ id: 3, ids: [5, 3, 9] });
    const query = capturedQueries[0];

    assert.ok(query !== undefined, 'expected query to be captured');
    assert.ok(query.sql.includes('id = ANY($1::bigint[])'));
    assert.ok(query.sql.includes('ORDER BY array_position($1::bigint[], id)'));
    assert.deepEqual(query.params[0], [3, 5, 9]);
    assert.deepEqual(
      memories.map(memory => memory.id),
      [3, 5, 9],
    );
  });

  it('applies active/expiry + project filters when includeInactive=false', async () => {
    const capturedQueries: { params: readonly unknown[]; sql: string }[] = [];
    mockPoolConnect((sql: string, params?: readonly unknown[]) => {
      capturedQueries.push({ params: params ?? [], sql });
      const result: QueryResult<QueryResultRow> = {
        command: 'SELECT',
        fields: [],
        oid: 0,
        rowCount: 1,
        rows: [createMemoryRow(11)],
      };
      return Promise.resolve(result);
    });

    await getMemoryEntries({
      ids: [11],
      includeInactive: false,
      project: 'example/catalog',
    });

    const query = capturedQueries[0];
    assert.ok(query !== undefined, 'expected query to be captured');
    assert.ok(query.sql.includes("status IN ('active', 'contested')"));
    assert.ok(query.sql.includes('(expires_at IS NULL OR expires_at > NOW())'));
    assert.ok(query.sql.includes('project = $2'));
    assert.deepEqual(query.params, [[11], 'example/catalog']);
  });

  it('requires id or ids input', async () => {
    await assert.rejects(getMemoryEntries({}), /Provide id or ids to fetch memory records\./u);
  });

  it('rejects invalid ids payloads', async () => {
    await assert.rejects(getMemoryEntries({ id: 0 }), /id must contain positive integer memory ids\./u);
    await assert.rejects(getMemoryEntries({ ids: 'not-an-array' }), /ids must be an array of positive integers\./u);
  });

  it('rejects ids arrays larger than 100 unique ids', async () => {
    const tooManyIds = Array.from({ length: 101 }, (_, index) => index + 1);
    await assert.rejects(getMemoryEntries({ ids: tooManyIds }), /ids must contain at most 100 unique ids\./u);
  });
});
