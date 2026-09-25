/**
 * Focused regression test.
 *
 * `findSimilarCandidates` is the post-commit flush-promotion candidate
 * lookup. When the bounded `db.read.memory_flush.promotion.candidates`
 * SELECT exceeds the read budget, the catch path:
 *
 *   1. Logs the timeout (operator-visible).
 *   2. Records a phase-attributed warning detail into the
 *      AsyncLocalStorage warning collector so the active tool invocation
 *      can persist the phase into
 *      `ai_tool_invocations.summary_json.timed_out_steps` and the health
 *      report's top-timeout-operations breakdown.
 *   3. Returns `[]` so the post-commit pipeline continues — flush-promotion
 *      timeouts are warning-only degradation, not failures.
 *
 * Before the fix the warning was log-only and never reached
 * `timed_out_steps`, so operators could not see promotion-candidate
 * timeouts in the failure dashboards.
 *
 * The test mocks `./runtime.js` and `../db/embeddings.js` so the bounded
 * `findSimilarCandidates` SELECT raises pg's `57014`
 * (`canceling statement due to statement timeout`) inside the per-call
 * transaction — exactly the on-disk shape `runBoundedQuery` translates
 * into a phase-attributed `TimeoutError`.
 */
import type { DbClient, DbPool, DbResult } from '../db/pool.js';

import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { afterEach, describe, it, vi } from 'vitest';

/**
 * Mirrors the public `extractTimedOutSteps` regex from
 * `@aviaratech/ai-memory-tools/src/telemetry-summary.ts` so the test can
 * prove the canonical warning message shape is parseable into a phase
 * name without taking a reverse-direction cross-package import (this
 * package is the leaf; ai-memory-tools depends on it, not the other
 * way around).
 */
const TIMED_OUT_STEP_PATTERN = / timed out after \d+ms\b/iu;

const PG_SQLSTATE_QUERY_CANCELED = '57014';

interface ClientCallLog {
  begins: number;
  commits: number;
  releases: number;
  rollbacks: number;
  setLocalStatements: string[];
}

function createFakePool(log: ClientCallLog): DbPool {
  const client: DbClient = {
    query<T>(sql: string): Promise<DbResult<T>> {
      const normalized = sql.trim().toUpperCase();
      if (normalized === 'BEGIN') {
        log.begins += 1;
        return Promise.resolve({ rowCount: 0, rows: [] });
      }
      if (normalized === 'COMMIT') {
        log.commits += 1;
        return Promise.resolve({ rowCount: 0, rows: [] });
      }
      if (normalized === 'ROLLBACK') {
        log.rollbacks += 1;
        return Promise.resolve({ rowCount: 0, rows: [] });
      }
      if (normalized.startsWith('SET LOCAL STATEMENT_TIMEOUT')) {
        log.setLocalStatements.push(sql);
        return Promise.resolve({ rowCount: 0, rows: [] });
      }
      // findSimilarCandidates SELECT — drive the canonical timeout shape.
      if (normalized.includes('FROM AI_MEMORY_ENTRIES')) {
        return rejectAsQueryCanceled(
          'canceling statement due to statement timeout (db.read.memory_flush.promotion.candidates)',
        );
      }
      // Best-effort metric INSERT (recordConsolidationMetric) — succeed so
      // the only warning detail captured is the candidate-lookup timeout.
      return Promise.resolve({ rowCount: 1, rows: [] });
    },
    release() {
      log.releases += 1;
    },
  };

  return {
    connect: () => Promise.resolve(client),
    end: () => Promise.resolve(),
    getClient: () => Promise.resolve(client),
    query: <T>(): Promise<DbResult<T>> =>
      Promise.reject(new Error('pool.query not expected in bounded flush-promotion path')),
  };
}

function rejectAsQueryCanceled<T>(message: string): Promise<DbResult<T>> {
  const err = new Error(message) as Error & { code: string };
  err.code = PG_SQLSTATE_QUERY_CANCELED;
  return Promise.reject(err);
}

afterEach(() => {
  mock.restoreAll();
});

describe('consolidateMemories flush-promotion candidate timeout', () => {
  it('records db.read.memory_flush.promotion.candidates timeout into warning channel for timed_out_steps', async () => {
    const log: ClientCallLog = { begins: 0, commits: 0, releases: 0, rollbacks: 0, setLocalStatements: [] };
    const pool = createFakePool(log);

    // Replace the live `pool` with our fake, but preserve every other
    // `runtime.js` named export so transitive importers (hashing.js,
    // failure-events.js, normalization.js, …) still get their constants.
    // The module mock replaces named exports of the target module, so
    // omitted exports become `undefined` and break downstream module
    // initialization.
    vi.doMock('../db/runtime.js', () => ({
      CONTEXT_PACK_TOOL: 'context-pack',
      DERIVED_MEMORY_KEY_PREFIX: 'derived-memory',
      getDatabaseUrl: () => undefined,
      MEMORY_DELTA_TOOL: 'memory-delta',
      MEMORY_IDENTITY_HASH_VERSION: 'v1',
      MEMORY_STATUS_VALUES: ['active', 'contested', 'superseded', 'expired', 'archived'],
      MIN_DURABLE_CONTENT_CHARS: 24,
      MIN_HIGH_CONFIDENCE_DURABLE: 0.5,
      PATCH_BACKFILL_SESSION_FAILURE_STAGE: 'backfill_patch_snapshots_session',
      PATCH_BACKFILL_SOURCE: 'backfill-patch-snapshots',
      PATCH_OUT_OF_ORDER_STAGE: 'ingest_memory_delta_patch_out_of_order',
      PATCH_SNAPSHOT_ID_PREFIX: 'patch-snapshot',
      pool,
      SENSITIVITY_VALUES: ['public', 'internal', 'confidential', 'restricted'],
      SESSION_SNAPSHOT_SCHEMA_VERSION: 'session_snapshot@0.1',
      SESSION_SUMMARY_CATEGORY: 'session-summary',
      SESSION_SUMMARY_MAX_CONFIDENCE: 0.5,
      UNKNOWN_INGESTION_FAILURE: 'unknown ingestion failure',
      UNSAFE_JSON_POINTER_KEYS: new Set(['__proto__', 'constructor', 'prototype']),
    }));
    vi.doMock('../db/embeddings.js', () => ({
      getEmbedding: () => Promise.resolve(Array.from({ length: 8 }, () => 0.1)),
      isEmbeddingAvailable: () => true,
    }));

    const { consolidateMemories } = await import('./consolidateMemories.js');
    const { createAiMemoryWarningCollector, listAiMemoryWarningDetails, runWithAiMemoryWarningCollector } =
      await import('../warning-channel.js');

    const collector = createAiMemoryWarningCollector();
    await runWithAiMemoryWarningCollector(collector, () =>
      consolidateMemories(
        [
          {
            category: 'decision',
            confidence: 0.7,
            content: 'flush-promotion candidate lookup must surface phase-attributed timeouts',
            id: 4242,
            memoryKey: 'example/catalog:test:flush-promotion-timeout',
            memoryType: null,
          },
        ],
        'session-flush-promotion-timeout',
      ),
    );

    const details = listAiMemoryWarningDetails(collector);
    assert.ok(details.length > 0, `expected at least one warning detail; got ${JSON.stringify(details)}`);

    const candidateTimeout = details.find(
      detail =>
        detail.code === 'consolidation.vector_query_timed_out' &&
        /db\.read\.memory_flush\.promotion\.candidates timed out after \d+ms/u.test(detail.message),
    );
    assert.ok(
      candidateTimeout !== undefined,
      `expected phase-attributed promotion-candidate timeout warning; got: ${JSON.stringify(details)}`,
    );

    // `summarizeWarnings` -> `extractTimedOutSteps` is what server.ts uses to
    // promote AsyncLocalStorage warnings into summary_json.timed_out_steps;
    // it parses messages of the form `<phase> timed out after <n>ms` and
    // returns the phase prefix. Drive the same parse here so this test
    // covers the end-to-end attribution shape rather than only the local
    // record. (Importing the helper directly from `@aviaratech/ai-memory-tools`
    // is forbidden because that package depends on this one — see the
    // package dependency graph in the root AGENTS.md.)
    const phasesFromMessages = details.flatMap(detail => {
      const match = TIMED_OUT_STEP_PATTERN.exec(detail.message);
      return match === null ? [] : [detail.message.slice(0, match.index).trim()];
    });
    assert.ok(
      phasesFromMessages.includes('db.read.memory_flush.promotion.candidates'),
      `expected an extractable timed_out phase = db.read.memory_flush.promotion.candidates; got phases: ${JSON.stringify(phasesFromMessages)}`,
    );

    // The bounded read must roll back the per-call transaction even though
    // the consolidation pipeline degrades gracefully and continues.
    assert.equal(log.rollbacks >= 1, true, 'bounded read must roll back on statement_timeout');
    assert.equal(log.releases >= 1, true, 'bounded read must release the client even on cancellation');
  });
});
