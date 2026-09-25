import type { PoolClient, QueryResult, QueryResultRow } from 'pg';

import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { afterEach, describe, test } from 'vitest';

import { countContestedMemories, listContestedMemories, resolveContestedMemory } from './memory-api.js';
import { pool } from './runtime.js';
import { mockPoolConnect } from './test-pool-mock.js';

interface QueryCall {
  params: readonly unknown[];
  sql: string;
}

afterEach(() => {
  mock.restoreAll();
});

describe('resolveContestedMemory', () => {
  test('rejects when action is missing', async () => {
    await assert.rejects(resolveContestedMemory({ memoryIdA: 10, memoryIdB: 20 }), {
      message: /action must be one of/,
    });
  });

  test('rejects when memoryIdA is missing', async () => {
    await assert.rejects(resolveContestedMemory({ action: 'keep_first', memoryIdB: 20 }), {
      message: /memoryIdA must be a positive integer/,
    });
  });

  test('rejects when memoryIdB is missing', async () => {
    await assert.rejects(resolveContestedMemory({ action: 'keep_first', memoryIdA: 10 }), {
      message: /memoryIdB must be a positive integer/,
    });
  });

  test('rejects when memory ids are identical', async () => {
    await assert.rejects(
      resolveContestedMemory({
        action: 'keep_first',
        memoryIdA: 10,
        memoryIdB: 10,
      }),
      {
        message: /must reference different memories/,
      },
    );
  });

  test('rejects when mergedContent is missing for merge action', async () => {
    await assert.rejects(resolveContestedMemory({ action: 'merge', memoryIdA: 10, memoryIdB: 20 }), {
      message: /mergedContent is required/,
    });
  });

  test('rejects when mergedContent is empty for merge action', async () => {
    await assert.rejects(
      resolveContestedMemory({
        action: 'merge',
        memoryIdA: 10,
        memoryIdB: 20,
        mergedContent: '   ',
      }),
      { message: /mergedContent is required/ },
    );
  });

  test('rejects invalid action string', async () => {
    await assert.rejects(
      resolveContestedMemory({
        action: 'invalid',
        memoryIdA: 10,
        memoryIdB: 20,
      }),
      {
        message: /action must be one of/,
      },
    );
  });

  test('rejects non-positive memoryIdA', async () => {
    await assert.rejects(
      resolveContestedMemory({
        action: 'keep_first',
        memoryIdA: 0,
        memoryIdB: 20,
      }),
      {
        message: /memoryIdA must be a positive integer/,
      },
    );
  });

  test('rejects non-integer memoryIdA', async () => {
    await assert.rejects(
      resolveContestedMemory({
        action: 'keep_first',
        memoryIdA: 1.5,
        memoryIdB: 20,
      }),
      {
        message: /memoryIdA must be a positive integer/,
      },
    );
  });

  test('locks rows with FOR UPDATE and enforces contested status precondition', async () => {
    const queries: QueryCall[] = [];
    let released = false;

    const client = {
      query: (sql: string, params: readonly unknown[] = []) => {
        queries.push({ params, sql });

        if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql.startsWith('SET LOCAL statement_timeout')) {
          return Promise.resolve(createQueryResult([]));
        }

        if (sql.includes('SELECT * FROM ai_memory_entries WHERE id IN ($1, $2) FOR UPDATE')) {
          return Promise.resolve(
            createQueryResult([createContestedRow(10, 'contested'), createContestedRow(20, 'active')]),
          );
        }

        throw new Error(`Unexpected SQL in mocked resolve flow: ${sql}`);
      },
      release: () => {
        released = true;
      },
    };

    mock.method(pool, 'connect', () => Promise.resolve(client as PoolClient));

    await assert.rejects(
      resolveContestedMemory({
        action: 'keep_first',
        memoryIdA: 10,
        memoryIdB: 20,
      }),
      /must both be in contested status before resolution/,
    );

    assert.ok(
      queries.some(call => call.sql.includes('FOR UPDATE')),
      'expected contested rows to be row-locked',
    );
    assert.ok(
      queries.some(call => call.sql === 'ROLLBACK'),
      'expected transaction rollback on precondition failure',
    );
    assert.equal(released, true);
  });

  test('resolves contested pair when database ids are returned as strings', async () => {
    let released = false;

    const client = {
      query: (sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql.startsWith('SET LOCAL statement_timeout')) {
          return Promise.resolve(createQueryResult([]));
        }

        if (sql.includes('SELECT * FROM ai_memory_entries WHERE id IN ($1, $2) FOR UPDATE')) {
          return Promise.resolve(
            createQueryResult([createContestedRow('10', 'contested'), createContestedRow('20', 'contested')]),
          );
        }

        if (sql.includes("SET status = 'active'")) {
          return Promise.resolve(createQueryResult([], 2));
        }

        if (sql.includes('INSERT INTO ai_memory_events')) {
          return Promise.resolve(createQueryResult([]));
        }

        throw new Error(`Unexpected SQL in string-id flow: ${sql}`);
      },
      release: () => {
        released = true;
      },
    };

    mock.method(pool, 'connect', () => Promise.resolve(client as PoolClient));

    const result = await resolveContestedMemory({
      action: 'keep_both',
      memoryIdA: 10,
      memoryIdB: 20,
    });

    assert.deepEqual(result, {
      action: 'keep_both',
      keptIds: [10, 20],
      supersededIds: [],
    });
    assert.equal(released, true);
  });

  test('fails fast when locked rows cannot be updated consistently', async () => {
    const client = {
      query: (sql: string, params: readonly unknown[] = []) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql.startsWith('SET LOCAL statement_timeout')) {
          return Promise.resolve(createQueryResult([]));
        }

        if (sql.includes('SELECT * FROM ai_memory_entries WHERE id IN ($1, $2) FOR UPDATE')) {
          return Promise.resolve(
            createQueryResult([createContestedRow(10, 'contested'), createContestedRow(20, 'contested')]),
          );
        }

        if (sql.includes("SET status = 'active'")) {
          return Promise.resolve(createQueryResult([], 0));
        }

        if (sql.includes('INSERT INTO ai_memory_events')) {
          return Promise.resolve(createQueryResult([]));
        }

        if (sql.includes("SET status = 'superseded'")) {
          return Promise.resolve(createQueryResult([]));
        }

        throw new Error(`Unexpected SQL in mocked conflict flow: ${sql} | ${JSON.stringify(params)}`);
      },
      release: () => undefined,
    };

    mock.method(pool, 'connect', () => Promise.resolve(client as PoolClient));

    await assert.rejects(
      resolveContestedMemory({
        action: 'keep_first',
        memoryIdA: 10,
        memoryIdB: 20,
      }),
      /resolved concurrently; refresh and retry/,
    );
  });
});

describe('listContestedMemories', () => {
  test('is exported and callable', () => {
    assert.equal(typeof listContestedMemories, 'function');
  });

  test('applies default bounded limit and stable ordering', async () => {
    const calls: QueryCall[] = [];
    mockPoolConnect((sql: string, params: readonly unknown[] = []) => {
      calls.push({ params, sql });
      return Promise.resolve(createQueryResult([createContestedRow(1, 'contested')]));
    });

    const records = await listContestedMemories({});
    const firstCall = calls[0];

    assert.ok(firstCall !== undefined, 'expected contested list query to run');
    assert.ok(firstCall.sql.includes('ORDER BY updated_at DESC, id DESC'));
    assert.ok(firstCall.sql.includes('LIMIT $1'), 'expected bounded LIMIT clause');
    assert.equal(firstCall.params[0], 100, 'expected default contested list limit of 100');
    assert.equal(records.length, 1);
  });

  test('caps explicit limit and preserves project filter', async () => {
    const calls: QueryCall[] = [];
    mockPoolConnect((sql: string, params: readonly unknown[] = []) => {
      calls.push({ params, sql });
      return Promise.resolve(createQueryResult([]));
    });

    await listContestedMemories({
      limit: 5_000,
      project: 'example/catalog',
    });
    const firstCall = calls[0];

    assert.ok(firstCall !== undefined, 'expected contested list query to run');
    assert.ok(firstCall.sql.includes('project = $1'));
    assert.equal(firstCall.params[0], 'example/catalog');
    assert.equal(firstCall.params[1], 500, 'expected limit to be capped at 500');
  });
});

describe('countContestedMemories', () => {
  test('is exported and callable', () => {
    assert.equal(typeof countContestedMemories, 'function');
  });
});

function createContestedRow(id: number | string, status: string): Record<string, unknown> {
  return {
    category: 'decision',
    content: `Contested memory ${String(id)}`,
    created_at: new Date('2026-02-22T00:00:00.000Z'),
    id,
    memory_type: 'episodic',
    status,
    updated_at: new Date('2026-02-23T00:00:00.000Z'),
  };
}

function createQueryResult(rows: Record<string, unknown>[], rowCount = rows.length): QueryResult<QueryResultRow> {
  return {
    command: 'SELECT',
    fields: [],
    oid: 0,
    rowCount,
    rows,
  };
}
