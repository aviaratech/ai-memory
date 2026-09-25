/**
 * Regression tests for `runBoundedQuery` — the bounded-DB-work helper that
 * wraps every read/write in a transaction with per-call `SET LOCAL statement_timeout`,
 * so a caller timeout cannot leave unbounded server-side work running against the
 * same pool without attribution or cleanup.
 *
 * The contract:
 *   1. Issues `BEGIN; SET LOCAL statement_timeout = <budget>; <task>; COMMIT;`
 *      in order on a single client checked out from the pool.
 *   2. On Postgres SQLSTATE 57014 (query_canceled), re-throws a phase-attributed
 *      `TimeoutError` so failure-signature aggregation can pinpoint the SQL step.
 *   3. On any error, issues `ROLLBACK` before releasing the client.
 *   4. Always releases the client (success, error, timeout).
 */
import type { DbClient, DbPool, DbResult } from './pool.js';

import assert from 'node:assert/strict';
import { test } from 'vitest';

import { TimeoutError } from '../timeout-policy.js';
import { runBoundedQuery } from './query-runner.js';

interface MockPool {
  calls: QueryCall[];
  client: DbClient;
  pool: DbPool;
  released: { count: number };
}

interface QueryCall {
  params: readonly unknown[] | undefined;
  sql: string;
}

function createMockPool(options: { taskBehavior?: 'cancel' | 'reject' | 'resolve' }): MockPool {
  const calls: QueryCall[] = [];
  const released = { count: 0 };

  const client: DbClient = {
    query<T>(sql: string, params?: unknown[]): Promise<DbResult<T>> {
      calls.push({ params, sql });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.startsWith('SET LOCAL statement_timeout')) {
        return Promise.resolve({ rowCount: 0, rows: [] as T[] });
      }
      if (options.taskBehavior === 'cancel') {
        const err = new Error('canceling statement due to statement timeout') as Error & {
          code: string;
        };
        err.code = '57014';
        return Promise.reject(err);
      }
      if (options.taskBehavior === 'reject') {
        return Promise.reject(new Error('boom'));
      }
      const okRow = { value: 'ok' } as unknown as T;
      return Promise.resolve({ rowCount: 1, rows: [okRow] });
    },
    release() {
      released.count += 1;
    },
  };

  const pool: DbPool = {
    connect: () => Promise.resolve(client),
    end: () => Promise.resolve(),
    getClient: () => Promise.resolve(client),
    query: <T>(sql: string): Promise<DbResult<T>> =>
      Promise.reject(new Error(`pool.query should not be called in bounded path (got: ${sql})`)),
  };

  return { calls, client, pool, released };
}

test('runBoundedQuery issues BEGIN, SET LOCAL statement_timeout, task SQL, COMMIT in order', async () => {
  const mock = createMockPool({ taskBehavior: 'resolve' });

  await runBoundedQuery({
    phase: 'db.read.test_phase',
    pool: mock.pool,
    task: async client => {
      await client.query('SELECT 1');
    },
    timeoutMs: 5000,
  });

  assert.deepEqual(
    mock.calls.map(c => c.sql),
    ['BEGIN', 'SET LOCAL statement_timeout = 5000', 'SELECT 1', 'COMMIT'],
    'SQL must execute in the exact order: BEGIN → SET LOCAL → task → COMMIT',
  );
});

test('runBoundedQuery returns the task result on success', async () => {
  const mock = createMockPool({ taskBehavior: 'resolve' });

  const result = await runBoundedQuery({
    phase: 'db.read.test_phase',
    pool: mock.pool,
    task: async client => {
      const { rows } = await client.query<{ value: string }>('SELECT value FROM dummy');
      return rows[0]?.value;
    },
    timeoutMs: 5000,
  });

  assert.equal(result, 'ok');
});

test('runBoundedQuery releases the client after success', async () => {
  const mock = createMockPool({ taskBehavior: 'resolve' });

  await runBoundedQuery({
    phase: 'db.read.test_phase',
    pool: mock.pool,
    task: async client => {
      await client.query('SELECT 1');
    },
    timeoutMs: 5000,
  });

  assert.equal(mock.released.count, 1, 'client must be released exactly once on success');
});

test('runBoundedQuery converts pg query_canceled (SQLSTATE 57014) into a phase-attributed TimeoutError', async () => {
  const mock = createMockPool({ taskBehavior: 'cancel' });

  await assert.rejects(
    runBoundedQuery({
      phase: 'db.read.search_memories.semantic',
      pool: mock.pool,
      task: async client => {
        await client.query('SELECT pg_sleep(60)');
      },
      timeoutMs: 5000,
    }),
    err => {
      assert.ok(err instanceof TimeoutError, 'cancellation must be re-thrown as TimeoutError');
      assert.equal(err.operation, 'db.read.search_memories.semantic', 'TimeoutError carries the phase name');
      assert.equal(err.timeoutMs, 5000, 'TimeoutError carries the budget');
      assert.ok(
        err.message.includes('db.read.search_memories.semantic'),
        'TimeoutError message must include the phase so failure signatures can attribute it',
      );
      return true;
    },
  );
});

test('runBoundedQuery rolls back the transaction after task failure (including statement_timeout cancel)', async () => {
  const mock = createMockPool({ taskBehavior: 'cancel' });

  await assert.rejects(
    runBoundedQuery({
      phase: 'db.read.test_phase',
      pool: mock.pool,
      task: async client => {
        await client.query('SELECT pg_sleep(60)');
      },
      timeoutMs: 5000,
    }),
  );

  const sqls = mock.calls.map(c => c.sql);
  assert.ok(sqls.includes('ROLLBACK'), 'ROLLBACK must be issued to free locks server-side');
  assert.ok(!sqls.includes('COMMIT'), 'COMMIT must not be issued after task failure');
});

test('runBoundedQuery releases the client after task failure', async () => {
  const mock = createMockPool({ taskBehavior: 'cancel' });

  await assert.rejects(
    runBoundedQuery({
      phase: 'db.read.test_phase',
      pool: mock.pool,
      task: async client => {
        await client.query('SELECT pg_sleep(60)');
      },
      timeoutMs: 5000,
    }),
  );

  assert.equal(mock.released.count, 1, 'client must be released exactly once even on cancel');
});

test('runBoundedQuery propagates non-timeout errors verbatim with rollback + release', async () => {
  const mock = createMockPool({ taskBehavior: 'reject' });

  await assert.rejects(
    runBoundedQuery({
      phase: 'db.read.test_phase',
      pool: mock.pool,
      task: async client => {
        await client.query('SELECT 1');
      },
      timeoutMs: 5000,
    }),
    err => err instanceof Error && err.message === 'boom',
  );

  assert.ok(
    mock.calls.some(c => c.sql === 'ROLLBACK'),
    'ROLLBACK must run on any error',
  );
  assert.equal(mock.released.count, 1, 'client released even on non-timeout error');
});

test('runBoundedQuery clamps timeoutMs to a positive integer', async () => {
  const mock = createMockPool({ taskBehavior: 'resolve' });

  await runBoundedQuery({
    phase: 'db.read.test_phase',
    pool: mock.pool,
    task: async client => {
      await client.query('SELECT 1');
    },
    timeoutMs: 0.4,
  });

  const setLocal = mock.calls.find(c => c.sql.startsWith('SET LOCAL statement_timeout'));
  assert.ok(setLocal !== undefined, 'SET LOCAL statement_timeout must be issued');
  assert.equal(setLocal.sql, 'SET LOCAL statement_timeout = 1', 'sub-millisecond budgets clamp up to 1ms');
});

test('runBoundedQuery TimeoutError uses base phase when no sub-phase was set', async () => {
  const mock = createMockPool({ taskBehavior: 'cancel' });

  await assert.rejects(
    runBoundedQuery({
      phase: 'db.write.memory_flush',
      pool: mock.pool,
      task: async client => {
        // Do not call ctx.setPhase — verify base phase is preserved when no sub-phase is set.
        await client.query('SELECT pg_sleep(60)');
      },
      timeoutMs: 5000,
    }),
    err => {
      assert.ok(err instanceof TimeoutError);
      assert.equal(err.operation, 'db.write.memory_flush');
      return true;
    },
  );
});

test('runBoundedQuery TimeoutError appends most-recent sub-phase to the base phase', async () => {
  const mock = createMockPool({ taskBehavior: 'cancel' });

  await assert.rejects(
    runBoundedQuery({
      phase: 'db.write.memory_flush',
      pool: mock.pool,
      task: async (client, ctx) => {
        ctx.setPhase('checkpoint');
        ctx.setPhase('actionable');
        ctx.setPhase('delta');
        await client.query('SELECT pg_sleep(60)');
      },
      timeoutMs: 5000,
    }),
    err => {
      assert.ok(err instanceof TimeoutError);
      assert.equal(
        err.operation,
        'db.write.memory_flush.delta',
        'TimeoutError must attribute to the most-recent sub-phase set inside the transaction',
      );
      return true;
    },
  );
});

test('runBoundedQuery TimeoutError attributes to checkpoint sub-phase when cancel fires before later sub-phases', async () => {
  const mock = createMockPool({ taskBehavior: 'cancel' });

  await assert.rejects(
    runBoundedQuery({
      phase: 'db.write.memory_flush',
      pool: mock.pool,
      task: async (client, ctx) => {
        ctx.setPhase('checkpoint');
        // Cancel fires inside the checkpoint sub-step before actionable/delta run.
        await client.query('SELECT pg_sleep(60)');
      },
      timeoutMs: 5000,
    }),
    err => {
      assert.ok(err instanceof TimeoutError);
      assert.equal(err.operation, 'db.write.memory_flush.checkpoint');
      return true;
    },
  );
});
