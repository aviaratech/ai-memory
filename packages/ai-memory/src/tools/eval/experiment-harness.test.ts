import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';

import { experimentReportExitCode, runExperimentHarness, validateExperimentReport } from './experiment-harness.js';
import { buildExperimentReport } from './suites/types.js';

const fixturesRoot = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

test('CLI report status cannot report success for failed, skipped, or empty evaluation', () => {
  for (const status of ['fail', 'skip'] as const) {
    const report = buildExperimentReport({
      details: [{ actual: {}, expected: {}, name: 'case', status }],
      metrics: {},
      suite: 'retrieval',
    });
    assert.equal(experimentReportExitCode(report), 1);
  }
  assert.equal(experimentReportExitCode(buildExperimentReport({ details: [], metrics: {}, suite: 'retrieval' })), 1);
  assert.equal(
    experimentReportExitCode(
      buildExperimentReport({
        details: [{ actual: {}, expected: {}, name: 'case', status: 'pass' }],
        metrics: {},
        suite: 'retrieval',
      }),
    ),
    0,
  );
});

const stubOrientFanoutV1Suite = () =>
  Promise.resolve(
    buildExperimentReport({
      details: [],
      metrics: {},
      suite: 'orient-fanout-v1',
    }),
  );

test('runExperimentHarness executes only the requested suite', async () => {
  let continuityRuns = 0;
  let retrievalRuns = 0;
  let environmentRuns = 0;
  const report = await runExperimentHarness(
    {
      fixturesRoot,
      suite: 'retrieval',
    },
    {
      runContinuitySuite: () => {
        continuityRuns += 1;
        return Promise.resolve(
          buildExperimentReport({
            details: [],
            metrics: {},
            suite: 'continuity',
          }),
        );
      },
      runEnvironmentSuite: () => {
        environmentRuns += 1;
        return Promise.resolve(
          buildExperimentReport({
            details: [],
            metrics: {},
            suite: 'environment',
          }),
        );
      },
      runOrientFanoutV1Suite: stubOrientFanoutV1Suite,
      runRetrievalSuite: () => {
        retrievalRuns += 1;
        return Promise.resolve(
          buildExperimentReport({
            details: [
              {
                actual: { returnedTopK: ['m1'] },
                expected: { expectedTopK: ['m1'] },
                name: 'retrieval:test-query',
                status: 'pass',
              },
            ],
            metrics: { retrievalMeanRecallAtK: 1 },
            suite: 'retrieval',
          }),
        );
      },
    },
  );

  assert.equal(continuityRuns, 0);
  assert.equal(retrievalRuns, 1);
  assert.equal(environmentRuns, 0);
  assert.equal(report.suite, 'retrieval');
  validateExperimentReport(report);
});

test('runExperimentHarness merges all suite reports for suite=all', async () => {
  const report = await runExperimentHarness(
    {
      fixturesRoot,
      suite: 'all',
    },
    {
      runContinuitySuite: () =>
        Promise.resolve(
          buildExperimentReport({
            details: [
              {
                actual: { score: 100 },
                expected: { score: 100 },
                name: 'continuity:fixture-a',
                status: 'pass',
              },
            ],
            metrics: { continuityAverageScorePct: 100 },
            suite: 'continuity',
          }),
        ),
      runEnvironmentSuite: () =>
        Promise.resolve(
          buildExperimentReport({
            details: [
              {
                actual: { score: 100 },
                expected: { score: 100 },
                name: 'environment:fixture-a',
                status: 'pass',
              },
            ],
            metrics: { environmentAverageScorePct: 100 },
            suite: 'environment',
          }),
        ),
      runOrientFanoutV1Suite: () =>
        Promise.resolve(
          buildExperimentReport({
            details: [
              {
                actual: { mergedRecall: 1 },
                expected: { minimumRecall: 0.5 },
                name: 'orient-fanout-v1:fixture-a',
                status: 'pass',
              },
            ],
            metrics: { orientFanoutV1MergedRecallAtK: 1 },
            suite: 'orient-fanout-v1',
          }),
        ),
      runRetrievalSuite: () =>
        Promise.resolve(
          buildExperimentReport({
            details: [
              {
                actual: { score: 100 },
                expected: { score: 100 },
                name: 'retrieval:fixture-a',
                status: 'pass',
              },
            ],
            metrics: { retrievalMrr: 1 },
            suite: 'retrieval',
          }),
        ),
    },
  );

  assert.equal(report.suite, 'all');
  assert.equal(report.passed, 4);
  assert.equal(report.failed, 0);
  assert.equal(report.skipped, 0);
  assert.equal(report.metrics['continuity.continuityAverageScorePct'], 100);
  assert.equal(report.metrics['retrieval.retrievalMrr'], 1);
  assert.equal(report.metrics['environment.environmentAverageScorePct'], 100);
  assert.equal(report.metrics['orient-fanout-v1.orientFanoutV1MergedRecallAtK'], 1);
  validateExperimentReport(report);
});

test('validateExperimentReport rejects malformed report payloads', () => {
  assert.throws(() => {
    validateExperimentReport({
      details: [],
      failed: 0,
      metrics: { sample: Number.NaN },
      passed: 0,
      skipped: 0,
      suite: 'test',
      timestamp: '2026-02-22T00:00:00.000Z',
    });
  }, /metrics values must be numbers/i);
});
