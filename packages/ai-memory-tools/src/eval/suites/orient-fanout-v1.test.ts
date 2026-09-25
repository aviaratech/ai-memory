import type { MemoryOrientResponse } from '@aviaratech/ai-memory/internal';

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'vitest';

import { validateExperimentReport } from '../experiment-harness.js';
import { runOrientFanoutV1Suite } from './orient-fanout-v1.js';

test('runOrientFanoutV1Suite returns skip when fixtures are missing', async () => {
  const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'ai-memory-orient-fanout-v1-'));
  try {
    const report = await runOrientFanoutV1Suite({ fixturesRoot: fixtureRoot });
    assert.equal(report.suite, 'orient-fanout-v1');
    assert.equal(report.skipped, 1);
    assert.equal(report.passed, 0);
    assert.equal(report.failed, 0);
    validateExperimentReport(report);
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

test('runOrientFanoutV1Suite evaluates fixtures with mocked orient', async () => {
  const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'ai-memory-orient-fanout-v1-'));
  const suiteDir = resolve(fixtureRoot, 'orient-fanout-v1');
  mkdirSync(suiteDir, { recursive: true });

  writeFileSync(
    resolve(suiteDir, 'test-fixture.json'),
    JSON.stringify({
      expectedTaskRelevantIds: [1, 2],
      memories: [
        { category: 'decision', content: 'Test memory one', id: 1, tags: ['test'] },
        { category: 'convention', content: 'Test memory two', id: 2, tags: ['test'] },
      ],
      name: 'test-fixture',
      task: 'test task query',
    }),
  );

  try {
    const report = await runOrientFanoutV1Suite({
      dependencies: {
        orientMemory: (): Promise<MemoryOrientResponse> =>
          Promise.resolve({
            capabilities: {
              embedding: true,
              envProbe: 'local',
              search: true,
              searchAvailable: true,
              sessionResume: true,
            },
            orientation: {
              activeGoal: null,
              contested: 0,
              environment: null,
              environmentStatus: 'disabled',
              fullContentTopN: 0,
              memoryDetail: 'compact',
              memoryPayloadApproxTokens: 0,
              memoryPayloadBudgetChars: 0,
              memoryPayloadBudgetExceeded: false,
              memoryPayloadChars: 0,
              priorSession: null,
              recentMemories: [],
              retrievalDiagnostics: {
                intents: {
                  direct: { durationMs: 5, hitCount: 2, selectedCount: 2, status: 'ok' },
                  implication: { durationMs: 5, hitCount: 0, selectedCount: 0, status: 'ok' },
                  temporal: { durationMs: 5, hitCount: 0, selectedCount: 0, status: 'ok' },
                },
                merge: {
                  candidateCount: 2,
                  decisions: [],
                  decisionSampleTruncated: false,
                  dedupedCount: 0,
                  selectedCount: 2,
                },
                overlap: {
                  allThree: 0,
                  directImplication: 0,
                  directTemporal: 0,
                  metric: 'jaccard',
                  temporalImplication: 0,
                },
                strategy: 'fanout_v1',
              },
              taskRelevant: [{ id: 1 }, { id: 2 }],
              taskSearchResultCount: 2,
              taskSearchStatus: 'ok',
              x_active_goal: null,
            },
            status: 'ok',
            warnings: [],
          }),
      },
      fixturesRoot: fixtureRoot,
    });

    assert.equal(report.suite, 'orient-fanout-v1');
    assert.equal(report.passed, 1);
    assert.equal(report.failed, 0);
    assert.equal(report.metrics.orientFanoutV1MergedRecallAtK, 1);
    assert.equal(report.metrics.orientFanoutV1FixtureCount, 1);
    validateExperimentReport(report);
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

test('runOrientFanoutV1Suite handles invalid fixture gracefully', async () => {
  const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'ai-memory-orient-fanout-v1-'));
  const suiteDir = resolve(fixtureRoot, 'orient-fanout-v1');
  mkdirSync(suiteDir, { recursive: true });

  writeFileSync(resolve(suiteDir, 'bad-fixture.json'), '{"invalid": true}');

  try {
    const report = await runOrientFanoutV1Suite({ fixturesRoot: fixtureRoot });
    assert.equal(report.suite, 'orient-fanout-v1');
    assert.equal(report.failed, 1);
    validateExperimentReport(report);
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});
