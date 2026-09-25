import { type EnvProbeMode, formatError, orientMemory, probeEnvironment } from '@aviaratech/ai-memory/internal';
import { readFileSync, rmSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { roundTo } from '../metrics.js';
import {
  createTempRepoDirectory,
  type EnvironmentFixture,
  parseEnvironmentFixture,
  readEnvironmentObservation,
  readFixtureFiles,
  setupFixtureRepository,
} from './environment-utils.js';
import { buildExperimentReport, type ExperimentDetail, type ExperimentReport, type SuiteRunOptions } from './types.js';

interface EnvironmentSuiteDependencies {
  orientMemory: typeof orientMemory;
  probeEnvironment: typeof probeEnvironment;
}

interface EnvironmentSuiteOptions extends SuiteRunOptions {
  dependencies?: Partial<EnvironmentSuiteDependencies>;
}

const DEFAULT_DEPENDENCIES: EnvironmentSuiteDependencies = {
  orientMemory,
  probeEnvironment,
};

export async function runEnvironmentSuite(options: EnvironmentSuiteOptions): Promise<ExperimentReport> {
  const dependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...options.dependencies,
  };
  const fixtureDirectory = resolve(options.fixturesRoot, 'environment');
  const fixtureFiles = readFixtureFiles(fixtureDirectory);

  if (fixtureFiles.length === 0) {
    return buildMissingFixtureReport(fixtureDirectory);
  }

  const runState = await runEnvironmentFixtures({ dependencies, fixtureFiles });
  return buildExperimentReport({
    details: runState.details,
    metrics: {
      environmentAverageScorePct:
        runState.scenarioScores.length > 0 ? roundTo(computeMean(runState.scenarioScores), 2) : 0,
      environmentScenarioCount: fixtureFiles.length,
    },
    suite: 'environment',
  });
}

function buildMissingFixtureReport(fixtureDirectory: string): ExperimentReport {
  return buildExperimentReport({
    details: [
      {
        actual: { fixtureDirectory, fixtureFiles: 0 },
        expected: { minimumFixtures: 1 },
        name: 'environment:fixtures',
        status: 'skip',
      },
    ],
    metrics: {},
    suite: 'environment',
  });
}

function computeMean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function createOrientDependencies(input: { probeEnvironmentFn: typeof probeEnvironment; repoDirectory: string }) {
  return {
    countContestedMemories: () => Promise.resolve(0),
    getCapabilities: () => ({ hasEmbeddingColumn: false }),
    getSessionResume: () => Promise.resolve({ events: [], sessionId: '', status: 'not_found' }),
    probeEnvironment: (mode: EnvProbeMode) => input.probeEnvironmentFn(mode, { cwd: input.repoDirectory }),
    recallMemories: () => Promise.resolve([]),
    searchMemories: () => Promise.resolve([]),
  };
}

function evaluateEnvironmentFixture(input: {
  expected: EnvironmentFixture['expected'];
  fixtureName: string;
  orientResult: unknown;
}): { detail: ExperimentDetail; scorePct: number } {
  const actual = readEnvironmentObservation(input.orientResult);
  const checks = [
    actual.branch === input.expected.branch,
    actual.workspaceDirty === input.expected.workspaceDirty,
    actual.uncommittedFiles === input.expected.uncommittedFiles,
    actual.recentCommitsLength === input.expected.recentCommitsLength,
  ];
  const matchedChecks = checks.filter(Boolean).length;
  const totalChecks = checks.length;
  const scorePct = roundTo((matchedChecks / totalChecks) * 100, 2);

  return {
    detail: {
      actual,
      expected: input.expected,
      metric: scorePct,
      name: `environment:${input.fixtureName}`,
      status: matchedChecks === totalChecks ? 'pass' : 'fail',
    },
    scorePct,
  };
}

async function runEnvironmentFixture(input: {
  dependencies: EnvironmentSuiteDependencies;
  fixturePath: string;
}): Promise<{ detail: ExperimentDetail; scorePct: null | number }> {
  const fixtureName = basename(input.fixturePath, '.json');
  const repoDirectory = createTempRepoDirectory();

  try {
    const fixture = parseEnvironmentFixture(readFileSync(input.fixturePath, 'utf8'));
    setupFixtureRepository({ fixture, repoDirectory });
    const orientResult = await input.dependencies.orientMemory(
      { envProbe: 'local' },
      createOrientDependencies({
        probeEnvironmentFn: input.dependencies.probeEnvironment,
        repoDirectory,
      }),
    );

    const evaluation = evaluateEnvironmentFixture({
      expected: fixture.expected,
      fixtureName,
      orientResult,
    });
    return {
      detail: evaluation.detail,
      scorePct: evaluation.scorePct,
    };
  } catch (error: unknown) {
    return {
      detail: {
        actual: { error: formatError(error), fixturePath: input.fixturePath },
        expected: { runnableFixture: true },
        name: `environment:${fixtureName}`,
        status: 'fail',
      },
      scorePct: null,
    };
  } finally {
    rmSync(repoDirectory, { force: true, recursive: true });
  }
}

async function runEnvironmentFixtures(input: {
  dependencies: EnvironmentSuiteDependencies;
  fixtureFiles: string[];
}): Promise<{ details: ExperimentDetail[]; scenarioScores: number[] }> {
  const details: ExperimentDetail[] = [];
  const scenarioScores: number[] = [];

  for (const fixturePath of input.fixtureFiles) {
    const result = await runEnvironmentFixture({
      dependencies: input.dependencies,
      fixturePath,
    });
    details.push(result.detail);
    if (result.scorePct !== null) {
      scenarioScores.push(result.scorePct);
    }
  }

  return { details, scenarioScores };
}
