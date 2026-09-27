import type { DbClient, DbPool, DbResult } from '@aviaratech/ai-memory/internal';

import assert from 'node:assert/strict';
import { test } from 'vitest';

import { flushSession } from './flush-session.js';

type FailureStage = 'actionable' | 'checkpoint' | 'delta' | 'none';
const TEST_DELTA_ID = 'delta-1381-test';
const TEST_NOW_ISO = '2026-02-23T12:00:00.000Z';
const TEST_SESSION_ID = 'session-1381-test';

test('a resumed basename flush uses only its exact attested session repository', async () => {
  const harness = createHarness('none');
  harness.dependencies.getSessionProject = sessionId => {
    assert.equal(sessionId, TEST_SESSION_ID);
    return Promise.resolve('example/catalog');
  };
  harness.dependencies.refreshContinuityPack = input => {
    assert.equal(input.parsed.project, 'example/catalog');
    assert.equal(input.parsed.task, 'logical-task');
    assert.equal(input.sessionId, TEST_SESSION_ID);
    return Promise.resolve({ reason: 'missing_project', status: 'skipped' });
  };
  await flushSession(
    {
      project: 'ai',
      sessionId: TEST_SESSION_ID,
      summary: 'Continue the same task after repository identity reconciliation.',
      task: 'logical-task',
    },
    harness.dependencies,
  );
});

interface FakeTxState {
  begins: number;
  commits: number;
  committedCoreRows: number;
  releases: number;
  rollbacks: number;
  stagedCoreRows: number;
}
type FlushClient = DbClient;
type FlushDependencies = NonNullable<Parameters<typeof flushSession>[1]>;

interface Harness {
  continuityRefreshCalls: unknown[];
  dependencies: FlushDependencies;
  reflectionCalls: { count: number };
  state: FakeTxState;
  warnings: string[];
}

test('flushSession rolls back all core rows when checkpoint stage fails', async () => {
  const harness = createHarness('checkpoint');

  await assert.rejects(
    flushSession(
      {
        decisions: ['Capture checkpoint decisions.'],
        summary: 'Checkpoint stage failure injection.',
      },
      harness.dependencies,
    ),
    /checkpoint stage failed/u,
  );

  assert.equal(harness.state.committedCoreRows, 0);
  assert.equal(harness.state.commits, 0);
  assert.equal(harness.state.rollbacks, 1);
  assert.equal(harness.reflectionCalls.count, 0);
});

test('flushSession rolls back all core rows when actionable stage fails', async () => {
  const harness = createHarness('actionable');

  await assert.rejects(
    flushSession(
      {
        decisions: ['Persist actionable memory.'],
        summary: 'Actionable stage failure injection.',
      },
      harness.dependencies,
    ),
    /actionable stage failed/u,
  );

  assert.equal(harness.state.committedCoreRows, 0);
  assert.equal(harness.state.commits, 0);
  assert.equal(harness.state.rollbacks, 1);
  assert.equal(harness.reflectionCalls.count, 0);
});

test('flushSession rolls back all core rows when delta stage fails', async () => {
  const harness = createHarness('delta');

  await assert.rejects(
    flushSession(
      {
        decisions: ['Persist continuity writes before delta ingest.'],
        summary: 'Delta stage failure injection.',
      },
      harness.dependencies,
    ),
    /delta stage failed/u,
  );

  assert.equal(harness.state.committedCoreRows, 0);
  assert.equal(harness.state.commits, 0);
  assert.equal(harness.state.rollbacks, 1);
  assert.equal(harness.reflectionCalls.count, 0);
});

test('flushSession emits non-blocking continuity warnings for missing optional continuity payload fields', async () => {
  const harness = createHarness('none');

  const result = await flushSession(
    {
      summary: 'Successful flush with sparse continuity payload.',
    },
    harness.dependencies,
  );

  assert.equal(result.flushed, true);
  assert.equal(result.memoriesStored, 1);
  assert.equal(result.sessionId, TEST_SESSION_ID);
  const warnings = result.warnings ?? [];
  assert.ok(warnings.some(message => message.includes('not an attested host identity')));
  assert.ok(
    warnings.some(message => message.includes('summary is brief')),
    'expected warning about short summary quality',
  );
  assert.ok(
    warnings.includes(
      'Continuity quality warning: nextActions is missing or empty. Add nextActions to this memory_flush call so the next session knows what to do first.',
    ),
  );
  assert.ok(
    warnings.includes(
      'Continuity quality warning: openQuestions is missing or empty. Add openQuestions to this memory_flush call to preserve unresolved decisions for the next session.',
    ),
  );
  assert.ok(
    warnings.includes(
      'Continuity quality warning: stateModel is missing. Add stateModel with assumptions, uncertainty, constraints, and strategy_confidence to this memory_flush call.',
    ),
  );
  assert.ok(
    warnings.includes(
      'Continuity quality warning: envModel is missing. Add envModel (branch, workspaceDirty, openPrs, failingChecks) to this memory_flush call for environment continuity.',
    ),
  );

  assert.equal(harness.state.committedCoreRows, 2, 'checkpoint + delta rows should commit');
  assert.equal(harness.state.commits, 1);
  assert.equal(harness.state.rollbacks, 0);
  assert.equal(harness.reflectionCalls.count, 1);
  assert.equal(harness.continuityRefreshCalls.length, 1);
  assert.ok(
    harness.warnings.some(message => message.includes('Continuity payload is missing optional quality fields.')),
  );
});

test('flushSession refreshes continuity pack after core commit and reflection', async () => {
  const harness = createHarness('none');

  const result = await flushSession(
    {
      agent: 'codex-builder',
      contextNeeded: ['Reviewer approval is required before merge.'],
      decisions: ['Keep continuity pack refresh in the post-commit reflection lifecycle.'],
      envModel: { branch: 'codex/ai-memory-continuity', workspaceDirty: false },
      lead: 'tech-lead',
      nextActions: ['Run session-start and flush orchestration tests.'],
      openQuestions: ['Should compaction sources use lower confidence provenance?'],
      outcome: 'restore-ai-memory-delivery-control',
      project: 'example/catalog',
      sessionId: 'fixture-host-session',
      source: 'manual-flush',
      stateModel: {
        assumptions: ['Existing reflection path remains the trusted compaction source.'],
        strategy_confidence: 'medium',
        uncertainty: [],
      },
      summary:
        'Continuity pack refresh should reuse the existing post-commit reflection path after core flush rows commit.',
      task: 'issue-2930',
    },
    harness.dependencies,
  );

  assert.equal(result.continuityPack?.status, 'updated');
  assert.equal(harness.continuityRefreshCalls.length, 1);
  assert.deepEqual(harness.continuityRefreshCalls[0], {
    parsed: {
      activeGoal: undefined,
      agent: 'codex-builder',
      contextNeeded: ['Reviewer approval is required before merge.'],
      decisions: ['Keep continuity pack refresh in the post-commit reflection lifecycle.'],
      envModel: { branch: 'codex/ai-memory-continuity', workspaceDirty: false },
      lead: 'tech-lead',
      nextActions: ['Run session-start and flush orchestration tests.'],
      normalizationWarnings: [],
      openQuestions: ['Should compaction sources use lower confidence provenance?'],
      outcome: 'restore-ai-memory-delivery-control',
      project: 'example/catalog',
      rootCauses: [],
      sessionId: 'fixture-host-session',
      source: 'manual-flush',
      stateModel: {
        assumptions: ['Existing reflection path remains the trusted compaction source.'],
        strategy_confidence: 'medium',
        uncertainty: [],
      },
      summary:
        'Continuity pack refresh should reuse the existing post-commit reflection path after core flush rows commit.',
      task: 'issue-2930',
    },
    reflectionCount: 0,
    sessionId: 'fixture-host-session',
  });
});

test('flushSession reports continuity pack refresh failure without failing committed flush', async () => {
  const harness = createHarness('none');
  harness.dependencies.refreshContinuityPack = input => {
    assert.equal(harness.state.commits, 1, 'continuity refresh should run after core transaction commit');
    assert.equal(harness.reflectionCalls.count, 1, 'continuity refresh should run after reflection');
    harness.continuityRefreshCalls.push(input);
    return Promise.reject(new Error('continuity pack write failed'));
  };

  const result = await flushSession(
    {
      nextActions: ['Continue from the committed flush even if pack refresh fails.'],
      openQuestions: ['Should operators inspect the refresh warning before retrying?'],
      project: 'example/catalog',
      stateModel: {
        assumptions: ['Continuity pack refresh is ancillary post-commit work.'],
        strategy_confidence: 'medium',
      },
      summary:
        'The core memory_flush commit should remain successful even when the post-commit continuity pack refresh fails.',
    },
    harness.dependencies,
  );

  assert.equal(result.flushed, true);
  const { continuityPack } = result;
  assert.ok(continuityPack !== undefined, 'flush should include continuity pack status');
  if (continuityPack.status !== 'error') {
    assert.fail('expected continuity pack refresh error');
  }
  assert.equal(continuityPack.reason, 'refresh_failed');
  assert.match(continuityPack.message, /continuity pack write failed/u);
  assert.equal(harness.state.committedCoreRows, 2, 'checkpoint + delta rows should commit');
  assert.equal(harness.state.commits, 1);
  assert.equal(harness.state.rollbacks, 0);
  assert.equal(harness.continuityRefreshCalls.length, 1);
  assert.ok(
    (result.warnings ?? []).some(message => message.includes('Continuity pack refresh warning')),
    'flush response should surface non-fatal refresh failure',
  );
  assert.ok(
    harness.warnings.some(message => message.includes('Continuity pack refresh failed after core memory_flush commit')),
    'operator logs should include refresh failure',
  );
});

test('flushSession returns calibration entries for every stored core memory', async () => {
  const harness = createHarness('none');

  const result = await flushSession(
    {
      agent: 'codex-builder',
      decisions: ['Persist calibration-aware decision memory.'],
      project: 'example/catalog',
      summary: 'Flush response should expose write-time calibration for stored checkpoint and decision memories.',
    },
    harness.dependencies,
  );

  const calibration = (
    result as {
      calibration?: {
        entries: {
          calibratedConfidence: number;
          category: string;
          declaredConfidence: number;
          priorMemoryCount: number;
        }[];
        priorMemoryCount: number;
      };
    }
  ).calibration;

  assert.ok(calibration !== undefined, 'memory_flush should include a calibration block');
  assert.equal(calibration.priorMemoryCount, 18);
  assert.deepEqual(
    calibration.entries.map(entry => entry.category),
    ['session-summary', 'decision'],
  );
  const decisionEntry = calibration.entries[1];
  assert.ok(decisionEntry !== undefined, 'expected decision calibration entry');
  assert.equal(decisionEntry.declaredConfidence, 0.7);
  assert.ok(Math.abs(decisionEntry.calibratedConfidence - 0.51) < 0.001);
});

test('flushSession returns consolidation dedupe metrics from post-commit consolidation', async () => {
  const harness = createHarness('none');
  harness.dependencies.isEmbeddingAvailable = () => true;
  harness.dependencies.consolidateMemories = () =>
    Promise.resolve({
      actions: {
        dedupe: 1,
        none: 0,
        refine: 0,
        supersede: 0,
      },
      contradictionsFlagged: 0,
      latencyMs: 12,
      outcomes: [
        {
          actionTaken: 'dedupe',
          candidateMemoryId: 1,
          candidateMemoryKey: 'example/catalog:decision:dup-a',
          newMemoryId: 2,
          newMemoryKey: 'example/catalog:decision:dup-b',
        },
      ],
      pairsClassified: 1,
      pairsExamined: 1,
      sessionId: TEST_SESSION_ID,
    });

  const result = await flushSession(
    {
      decisions: [
        'Zustand stores use the singleton pattern for cross-feature state.',
        'State management uses Zustand singleton stores across features.',
      ],
      summary:
        'Regression coverage for consolidation metrics emitted after memory_flush stores near-duplicate durable memories.',
    },
    harness.dependencies,
  );

  const { consolidation } = result;
  assert.ok(consolidation !== undefined);
  assert.equal(consolidation.pairsExamined, 1);
  assert.equal(consolidation.pairsClassified, 1);
  assert.equal(consolidation.actions.dedupe, 1);
});

function createFakePool(client: FlushClient): DbPool {
  return {
    connect: () => Promise.resolve(client),
    end: () => Promise.resolve(),
    getClient: () => Promise.resolve(client),
    query: <T>(): Promise<DbResult<T>> => Promise.reject(new Error('pool.query is not expected in flush bounded path')),
  };
}

function createFakeTransactionClient(state: FakeTxState): FlushClient {
  return {
    query<Row>(sql: string): Promise<DbResult<Row>> {
      const normalizedSql = sql.trim().toUpperCase();

      if (normalizedSql === 'BEGIN') {
        state.begins += 1;
        state.stagedCoreRows = 0;
        return Promise.resolve({ rowCount: 0, rows: [] });
      }

      if (normalizedSql === 'COMMIT') {
        state.commits += 1;
        state.committedCoreRows += state.stagedCoreRows;
        state.stagedCoreRows = 0;
        return Promise.resolve({ rowCount: 0, rows: [] });
      }

      if (normalizedSql === 'ROLLBACK') {
        state.rollbacks += 1;
        state.stagedCoreRows = 0;
        return Promise.resolve({ rowCount: 0, rows: [] });
      }

      if (normalizedSql.startsWith('SET LOCAL STATEMENT_TIMEOUT')) {
        return Promise.resolve({ rowCount: 0, rows: [] });
      }

      if (normalizedSql.startsWith('INSERT CORE')) {
        state.stagedCoreRows += 1;
      }

      return Promise.resolve({ rowCount: 0, rows: [] });
    },
    release() {
      state.releases += 1;
    },
  };
}

function createHarness(failureStage: FailureStage): Harness {
  const state: FakeTxState = {
    begins: 0,
    commits: 0,
    committedCoreRows: 0,
    releases: 0,
    rollbacks: 0,
    stagedCoreRows: 0,
  };
  const warnings: string[] = [];
  const continuityRefreshCalls: unknown[] = [];
  const reflectionCalls = { count: 0 };
  const fakeClient = createFakeTransactionClient(state);

  let storeCallCount = 0;

  const dependencies: FlushDependencies = {
    consolidateMemories: () => Promise.resolve(undefined),
    getEmbedding: () => Promise.resolve(null),
    getSessionProject: () => Promise.resolve(undefined),
    ingestMemoryDeltaInTransaction: async client => {
      await client.query('INSERT CORE DELTA');
      if (failureStage === 'delta') {
        throw new Error('delta stage failed');
      }

      return {
        deltaId: TEST_DELTA_ID,
        durableMemoriesDeduped: 0,
        durableMemoriesInserted: 0,
        durableMemoriesStored: 0,
        durableMemoriesUpdated: 0,
        eventsIngested: 1,
        schemaVersion: 'memory_delta@0.1',
        sessionId: TEST_SESSION_ID,
        status: 'ok',
        storedDurableMemoryIds: [],
      };
    },
    isEmbeddingAvailable: () => false,
    logError: () => {
      // No-op for deterministic tests.
    },
    logWarn: (_event, fields) => {
      if (fields !== undefined && typeof fields.message === 'string') {
        warnings.push(fields.message);
      }
    },
    now: () => new Date(TEST_NOW_ISO),
    pool: createFakePool(fakeClient),
    refreshContinuityPack: input => {
      assert.equal(state.commits, 1, 'continuity refresh should run after core transaction commit');
      assert.equal(reflectionCalls.count, 1, 'continuity refresh should run after reflection');
      continuityRefreshCalls.push(input);
      return Promise.resolve({
        budgetChars: 6000,
        payloadChars: 480,
        scopeKey: 'project:example/catalog',
        status: 'updated',
        truncated: false,
      });
    },
    runReflection: () => {
      reflectionCalls.count += 1;
      return Promise.resolve({
        reflectionResult: undefined,
        storedMemories: [],
      });
    },
    storeMemoryWithAuditEvent: async client => {
      storeCallCount += 1;
      await client.query(`INSERT CORE STORE ${String(storeCallCount)}`);

      if (failureStage === 'checkpoint' && storeCallCount === 1) {
        throw new Error('checkpoint stage failed');
      }
      if (failureStage === 'actionable' && storeCallCount === 2) {
        throw new Error('actionable stage failed');
      }

      return {
        calibration: {
          calibratedConfidence: storeCallCount === 1 ? 0.45 : 0.51,
          declaredConfidence: storeCallCount === 1 ? 0.45 : 0.7,
          meanDeclaredConfidence: 0.76,
          priorMemoryCount: 18,
          reversalRate: 0.2778,
          scope: 'author x category',
          window: '30d',
        },
        category: storeCallCount === 1 ? 'session-summary' : 'decision',
        confidence: storeCallCount === 1 ? 0.45 : 0.51,
        id: storeCallCount,
        memoryType: null,
      };
    },
    uuid: () => TEST_SESSION_ID,
  };

  return {
    continuityRefreshCalls,
    dependencies,
    reflectionCalls,
    state,
    warnings,
  };
}
