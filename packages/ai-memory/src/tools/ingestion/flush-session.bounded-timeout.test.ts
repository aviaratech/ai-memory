/**
 * Bounded-timeout tests for `commitCoreFlushWrites`.
 *
 * Proves that:
 *   1. The flush write transaction runs through `runBoundedQuery`, which
 *      issues `BEGIN; SET LOCAL statement_timeout = <writeTimeoutMs>; ...; COMMIT`
 *      on a per-call client. Without this wrapper, a caller-level timeout
 *      could leave the connection blocked server-side until the pool-wide
 *      session statement_timeout (default 15s).
 *   2. `TimeoutError` is phase-attributed to the active sub-step
 *      (`db.write.memory_flush.checkpoint|actionable|delta`) so the
 *      health-report top-timeout-operations breakdown can pinpoint the step.
 *   3. The transaction is rolled back and the connection released on any
 *      cancellation, not just clean failures.
 */
import type { DbClient, DbPool, DbResult } from '@aviaratech/ai-memory/internal';

import { isTimeoutError } from '@aviaratech/ai-memory/internal';
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { flushSession } from './flush-session.js';

type FlushDependencies = NonNullable<Parameters<typeof flushSession>[1]>;

interface TxState {
  commits: number;
  releases: number;
  rollbacks: number;
  setLocalStatements: string[];
}

const FLUSH_INPUT = {
  decisions: ['Bounded-flush regression coverage'],
  nextActions: ['Verify per-call statement_timeout fires'],
  openQuestions: ['none'],
  stateModel: {
    assumptions: ['runBoundedQuery is the sole write path'],
    strategy_confidence: 'medium',
  },
  summary:
    'Bounded flush test fixture: drives commitCoreFlushWrites through runBoundedQuery and asserts SET LOCAL statement_timeout is issued before the transaction body.',
};

function createTxObserver(): {
  buildClient: (behavior: 'cancel-on-actionable' | 'cancel-on-checkpoint' | 'cancel-on-delta' | 'success') => DbClient;
  buildPool: (client: DbClient) => DbPool;
  state: TxState;
} {
  const state: TxState = { commits: 0, releases: 0, rollbacks: 0, setLocalStatements: [] };

  const buildClient = (
    behavior: 'cancel-on-actionable' | 'cancel-on-checkpoint' | 'cancel-on-delta' | 'success',
  ): DbClient => {
    let storeCallCount = 0;
    return {
      query<T>(sql: string): Promise<DbResult<T>> {
        const normalized = sql.trim().toUpperCase();
        if (normalized === 'BEGIN') {
          return Promise.resolve({ rowCount: 0, rows: [] });
        }
        if (normalized === 'COMMIT') {
          state.commits += 1;
          return Promise.resolve({ rowCount: 0, rows: [] });
        }
        if (normalized === 'ROLLBACK') {
          state.rollbacks += 1;
          return Promise.resolve({ rowCount: 0, rows: [] });
        }
        if (normalized.startsWith('SET LOCAL STATEMENT_TIMEOUT')) {
          state.setLocalStatements.push(sql);
          return Promise.resolve({ rowCount: 0, rows: [] });
        }
        if (normalized.startsWith('INSERT CORE STORE')) {
          storeCallCount += 1;
          if (behavior === 'cancel-on-checkpoint' && storeCallCount === 1) {
            return rejectAsQueryCanceled('statement_timeout fired during checkpoint write');
          }
          if (behavior === 'cancel-on-actionable' && storeCallCount === 2) {
            return rejectAsQueryCanceled('statement_timeout fired during actionable write');
          }
        }
        if (normalized.startsWith('INSERT CORE DELTA') && behavior === 'cancel-on-delta') {
          return rejectAsQueryCanceled('statement_timeout fired during delta write');
        }
        return Promise.resolve({ rowCount: 0, rows: [] });
      },
      release() {
        state.releases += 1;
      },
    };
  };

  const buildPool = (client: DbClient): DbPool => ({
    connect: () => Promise.resolve(client),
    end: () => Promise.resolve(),
    getClient: () => Promise.resolve(client),
    query: <T>(): Promise<DbResult<T>> => Promise.reject(new Error('pool.query not expected in bounded path')),
  });

  return { buildClient, buildPool, state };
}

function makeDependencies(pool: DbPool): FlushDependencies {
  let storeCallCount = 0;
  return {
    consolidateMemories: () => Promise.resolve(undefined),
    getEmbedding: () => Promise.resolve(null),
    ingestMemoryDeltaInTransaction: async client => {
      await client.query('INSERT CORE DELTA');
      return {
        deltaId: 'delta-bounded-test',
        durableMemoriesDeduped: 0,
        durableMemoriesInserted: 0,
        durableMemoriesStored: 0,
        durableMemoriesUpdated: 0,
        eventsIngested: 1,
        schemaVersion: 'memory_delta@0.1',
        sessionId: 'session-bounded-test',
        status: 'ok',
        storedDurableMemoryIds: [],
      };
    },
    isEmbeddingAvailable: () => false,
    logError: () => undefined,
    logWarn: () => undefined,
    now: () => new Date('2026-05-12T00:00:00.000Z'),
    pool,
    runReflection: () => Promise.resolve({ reflectionResult: undefined, storedMemories: [] }),
    storeMemoryWithAuditEvent: async client => {
      storeCallCount += 1;
      await client.query(`INSERT CORE STORE ${String(storeCallCount)}`);
      return {
        category: storeCallCount === 1 ? 'session-summary' : 'decision',
        confidence: 0.5,
        id: storeCallCount,
        memoryType: null,
      };
    },
    uuid: () => 'session-bounded-test',
    writeTimeoutMs: 4321,
  };
}

function rejectAsQueryCanceled<T>(message: string): Promise<DbResult<T>> {
  const err = new Error(message) as Error & { code: string };
  err.code = '57014';
  return Promise.reject(err);
}

describe('memory_flush bounded-timeout coverage', () => {
  it('issues SET LOCAL statement_timeout before transaction body and commits on success', async () => {
    const observer = createTxObserver();
    const client = observer.buildClient('success');
    const pool = observer.buildPool(client);
    const dependencies = makeDependencies(pool);

    const result = await flushSession(FLUSH_INPUT, dependencies);

    assert.equal(result.flushed, true);
    assert.equal(observer.state.commits, 1, 'transaction must commit on success');
    assert.equal(observer.state.rollbacks, 0, 'no rollback on success');
    assert.equal(observer.state.releases, 1, 'connection must be released exactly once on success');
    assert.deepEqual(
      observer.state.setLocalStatements,
      ['SET LOCAL statement_timeout = 4321'],
      'SET LOCAL statement_timeout must use the dependency-provided writeTimeoutMs (4321)',
    );
  });

  it('phase-attributes TimeoutError to checkpoint sub-step on statement_timeout during checkpoint write', async () => {
    const observer = createTxObserver();
    const client = observer.buildClient('cancel-on-checkpoint');
    const pool = observer.buildPool(client);
    const dependencies = makeDependencies(pool);

    await assert.rejects(flushSession(FLUSH_INPUT, dependencies), err => {
      assert.ok(err instanceof Error);
      assert.ok(isTimeoutError(err), 'cancel during checkpoint must surface as TimeoutError');
      assert.match(
        err.message,
        /db\.write\.memory_flush\.checkpoint timed out after 4321ms/u,
        `expected phase-attributed message for checkpoint sub-step; got: ${err.message}`,
      );
      return true;
    });
    assert.equal(observer.state.rollbacks, 1, 'rollback must run after cancel');
    assert.equal(observer.state.commits, 0, 'no commit after cancel');
    assert.equal(observer.state.releases, 1, 'connection released even after cancel');
  });

  it('phase-attributes TimeoutError to actionable sub-step on statement_timeout during actionable write', async () => {
    const observer = createTxObserver();
    const client = observer.buildClient('cancel-on-actionable');
    const pool = observer.buildPool(client);
    const dependencies = makeDependencies(pool);
    // Force actionable write to exist by giving the flush input a decision.
    const inputWithActionable = {
      ...FLUSH_INPUT,
      decisions: ['Persist actionable decision so the actionable phase is exercised'],
    };

    await assert.rejects(flushSession(inputWithActionable, dependencies), err => {
      assert.ok(err instanceof Error);
      assert.ok(isTimeoutError(err));
      assert.match(
        err.message,
        /db\.write\.memory_flush\.actionable timed out after 4321ms/u,
        `expected phase-attributed message for actionable sub-step; got: ${err.message}`,
      );
      return true;
    });
  });

  it('phase-attributes TimeoutError to delta sub-step on statement_timeout during delta write', async () => {
    const observer = createTxObserver();
    const client = observer.buildClient('cancel-on-delta');
    const pool = observer.buildPool(client);
    const dependencies = makeDependencies(pool);

    await assert.rejects(flushSession(FLUSH_INPUT, dependencies), err => {
      assert.ok(err instanceof Error);
      assert.ok(isTimeoutError(err));
      assert.match(
        err.message,
        /db\.write\.memory_flush\.delta timed out after 4321ms/u,
        `expected phase-attributed message for delta sub-step; got: ${err.message}`,
      );
      return true;
    });
  });
});
