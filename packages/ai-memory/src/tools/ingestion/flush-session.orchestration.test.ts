import type { DbClient, DbPool, DbResult } from '@aviaratech/ai-memory/internal';

import assert from 'node:assert/strict';
import { test } from 'vitest';

import { flushSession } from './flush-session.js';

type FailureStage = 'delta' | 'none';
const TEST_DELTA_ID = 'delta-1381-test';
const TEST_NOW_ISO = '2026-02-23T12:00:00.000Z';
const TEST_SESSION_ID = 'session-1381-test';

test('flush commits one checkpoint delta and keeps decisions and root causes in its snapshot', async () => {
  const harness = createHarness('none');
  const result = await flushSession(
    {
      decisions: ['Retry the bounded synthetic fixture after checking its input.'],
      rootCauses: ['The synthetic fixture had an inconsistent input value.'],
      sessionId: TEST_SESSION_ID,
      summary: 'Checkpoint the synthetic fixture result and its pending verification.',
    },
    harness.dependencies,
  );
  assert.equal(harness.state.committedCoreRows, 1, 'only the delta is written');
  assert.equal(harness.deltaInputs.length, 1);
  const delta = harness.deltaInputs[0] as { memoryDelta: { snapshot: { value: Record<string, unknown> } } };
  assert.deepEqual(delta.memoryDelta.snapshot.value.x_decisions, [
    'Retry the bounded synthetic fixture after checking its input.',
  ]);
  assert.deepEqual(delta.memoryDelta.snapshot.value.x_root_causes, [
    'The synthetic fixture had an inconsistent input value.',
  ]);
  assert.ok(result.warnings?.some(warning => warning.includes('Store reusable knowledge with memory_store')));
  assert.equal('memoriesStored' in result, false);
});

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
  deltaInputs: unknown[];
  dependencies: FlushDependencies;
  state: FakeTxState;
  warnings: string[];
}

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
  assert.equal(harness.continuityRefreshCalls.length, 0);
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
      'Continuity quality warning: openQuestions is missing or empty. Include unresolved questions when present; leave this empty when none remain.',
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

  assert.equal(harness.state.committedCoreRows, 1, 'the checkpoint delta should commit');
  assert.equal(harness.state.commits, 1);
  assert.equal(harness.state.rollbacks, 0);
  assert.equal(harness.continuityRefreshCalls.length, 1);
  assert.ok(
    harness.warnings.some(message => message.includes('Continuity payload is missing optional quality fields.')),
  );
});

test('sparse agent checkpoint commits unchanged narrative and returns advisory warnings', async () => {
  const harness = createHarness('none');
  const nextActions = ['Review releaseverificationandfinalownedcleanup.'];
  harness.dependencies.refreshContinuityPack = input => {
    assert.deepEqual(input.parsed.nextActions, nextActions);
    assert.deepEqual(input.parsed.openQuestions, []);
    return Promise.resolve({ reason: 'missing_project', status: 'skipped' });
  };
  const result = await flushSession(
    {
      source: 'codex',
      sessionId: TEST_SESSION_ID,
      nextActions,
      summary:
        'The verified checkpoint has no unresolved questions or assumptions. Review the remaining delivery work before proceeding.',
    },
    harness.dependencies,
  );
  assert.equal(result.flushed, true);
  assert.equal(harness.state.commits, 1);
  assert.equal(harness.state.rollbacks, 0);
  assert.equal(harness.state.committedCoreRows, 1);
  assert.ok(result.warnings?.some(warning => warning.includes('openQuestions')));
  assert.equal(result.warnings?.filter(warning => warning.includes('compressed')).length, 1);
  assert.ok(!result.warnings?.some(warning => warning.includes('releaseverificationandfinalownedcleanup')));
});

test('flushSession refreshes continuity pack after core commit', async () => {
  const harness = createHarness('none');

  const result = await flushSession(
    {
      agent: 'codex-builder',
      contextNeeded: ['Reviewer approval is required before merge.'],
      decisions: ['Keep continuity pack refresh in the post-commit lifecycle.'],
      envModel: { branch: 'codex/ai-memory-continuity', workspaceDirty: false },
      lead: 'tech-lead',
      nextActions: ['Run session-start and flush orchestration tests.'],
      openQuestions: ['Should compaction sources use lower confidence provenance?'],
      outcome: 'restore-ai-memory-delivery-control',
      project: 'example/catalog',
      sessionId: 'fixture-host-session',
      source: 'manual-flush',
      stateModel: {
        assumptions: ['Explicit flushes remain the trusted compaction source.'],
        strategy_confidence: 'medium',
        uncertainty: [],
      },
      summary:
        'Continuity pack refresh should run after the core flush commit and keep the checkpoint fields together.',
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
      decisions: ['Keep continuity pack refresh in the post-commit lifecycle.'],
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
        assumptions: ['Explicit flushes remain the trusted compaction source.'],
        strategy_confidence: 'medium',
        uncertainty: [],
      },
      summary:
        'Continuity pack refresh should run after the core flush commit and keep the checkpoint fields together.',
      task: 'issue-2930',
    },
    sessionId: 'fixture-host-session',
  });
});

test('flushSession reports continuity pack refresh failure without failing committed flush', async () => {
  const harness = createHarness('none');
  harness.dependencies.refreshContinuityPack = input => {
    assert.equal(harness.state.commits, 1, 'continuity refresh should run after core transaction commit');
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
  assert.equal(harness.state.committedCoreRows, 1, 'the checkpoint delta should commit');
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
  const deltaInputs: unknown[] = [];
  const fakeClient = createFakeTransactionClient(state);

  const dependencies: FlushDependencies = {
    getSessionProject: () => Promise.resolve(undefined),
    ingestMemoryDeltaInTransaction: async (client, input) => {
      deltaInputs.push(input);
      await client.query('INSERT CORE DELTA');
      if (failureStage === 'delta') {
        throw new Error('delta stage failed');
      }

      return {
        deltaId: TEST_DELTA_ID,
        eventsIngested: 1,
        schemaVersion: 'memory_delta@0.1',
        sessionId: TEST_SESSION_ID,
        status: 'ok',
      };
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
      continuityRefreshCalls.push(input);
      return Promise.resolve({
        budgetChars: 6000,
        payloadChars: 480,
        scopeKey: 'project:example/catalog',
        status: 'updated',
        truncated: false,
      });
    },
    uuid: () => TEST_SESSION_ID,
  };

  return {
    continuityRefreshCalls,
    deltaInputs,
    dependencies,
    state,
    warnings,
  };
}
