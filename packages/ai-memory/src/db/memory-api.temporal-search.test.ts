import type { QueryResult, QueryResultRow } from 'pg';

import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { afterEach, describe, it } from 'vitest';

import { searchTemporalMemories } from './memory-api.js';
import { pool } from './runtime.js';

interface CapturedCall {
  params: readonly unknown[] | undefined;
  sql: string;
}

const NON_TASK_SQL_PREFIXES = ['BEGIN', 'COMMIT', 'ROLLBACK', 'SET LOCAL statement_timeout'];

function buildBaseRow(overrides: Record<string, unknown> = {}) {
  return {
    category: 'decision',
    confidence: 0.8,
    content: 'Temporal search test content.',
    created_at: new Date('2026-03-22T00:00:00.000Z'),
    decayed_importance: 0.7,
    dedupe_hash: 'sha256:temporal-test',
    evidence_refs: [],
    id: 401,
    metadata_json: {},
    project: 'example/catalog',
    source: 'test',
    status: 'contested',
    supersedes_id: 400,
    tags: ['temporal', 'test'],
    updated_at: new Date('2026-03-22T00:00:00.000Z'),
    ...overrides,
  };
}

function isTaskSql(sql: string): boolean {
  return !NON_TASK_SQL_PREFIXES.some(prefix => sql.startsWith(prefix));
}

function mockPoolConnect(handler: (sql: string, params?: readonly unknown[]) => Promise<QueryResult<QueryResultRow>>) {
  mock.method(pool, 'connect', () => {
    return Promise.resolve({
      query: (sql: string, params?: readonly unknown[]) => {
        if (!isTaskSql(sql)) {
          return Promise.resolve({ command: 'SET', fields: [], oid: 0, rowCount: 0, rows: [] });
        }
        return handler(sql, params);
      },
      release: () => undefined,
    });
  });
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

describe('searchTemporalMemories', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('queries contested and supersession-linked rows', async () => {
    const calls: CapturedCall[] = [];

    mockPoolConnect((sql: string, params?: readonly unknown[]) => {
      calls.push({ params, sql });
      return Promise.resolve(toQueryResult([buildBaseRow()]));
    });

    const results = await searchTemporalMemories({ project: 'example/catalog', query: 'retrieval testing' });
    assert.equal(results.length, 1);
    assert.ok(calls[0]?.sql.includes("status = 'contested'"));
    assert.ok(calls[0]?.sql.includes('supersedes_id IS NOT NULL'));
  });

  it('forwards project scoping to the query', async () => {
    const calls: CapturedCall[] = [];

    mockPoolConnect((sql: string, params?: readonly unknown[]) => {
      calls.push({ params, sql });
      return Promise.resolve(toQueryResult([]));
    });

    await searchTemporalMemories({ project: 'aviaratech/platform', query: 'test query' });
    assert.ok(calls[0]?.sql.includes('project ='));
    assert.ok(calls[0]?.params?.includes('aviaratech/platform'));
  });

  it('forwards memoryType scoping to the query', async () => {
    const calls: CapturedCall[] = [];

    mockPoolConnect((sql: string, params?: readonly unknown[]) => {
      calls.push({ params, sql });
      return Promise.resolve(toQueryResult([]));
    });

    await searchTemporalMemories({ memoryType: 'semantic', query: 'test query' });
    assert.ok(calls[0]?.sql.includes('memory_type ='));
    assert.ok(calls[0]?.params?.includes('semantic'));
  });

  it('excludes expired and inactive rows by default', async () => {
    const calls: CapturedCall[] = [];

    mockPoolConnect((sql: string, params?: readonly unknown[]) => {
      calls.push({ params, sql });
      return Promise.resolve(toQueryResult([]));
    });

    await searchTemporalMemories({ query: 'test query' });
    assert.ok(
      calls[0]?.sql.includes("status IN ('active', 'contested')"),
      'should filter to active/contested status by default',
    );
    assert.ok(calls[0]?.sql.includes('expires_at IS NULL OR expires_at > NOW()'));
  });

  it('orders by temporal_priority DESC then updated_at DESC', async () => {
    const calls: CapturedCall[] = [];

    mockPoolConnect((sql: string, params?: readonly unknown[]) => {
      calls.push({ params, sql });
      return Promise.resolve(toQueryResult([]));
    });

    await searchTemporalMemories({ query: 'test query' });
    assert.ok(calls[0]?.sql.includes('ORDER BY temporal_priority DESC, updated_at DESC'));
  });

  it('normalizes rows through toMemoryRecord', async () => {
    mockPoolConnect(() =>
      Promise.resolve(
        toQueryResult([
          buildBaseRow({
            content: 'Normalized content check',
            id: 500,
            supersedes_id: 499,
          }),
        ]),
      ),
    );

    const results = await searchTemporalMemories({ query: 'normalize check' });
    assert.equal(results.length, 1);
    const record = results[0] as Record<string, unknown>;
    // toMemoryRecord normalizes snake_case to camelCase
    assert.equal(record.id, 500);
    assert.equal(record.content, 'Normalized content check');
  });

  it('throws when query is missing', async () => {
    await assert.rejects(searchTemporalMemories({}), /query must be a non-empty string/u);
  });
});
