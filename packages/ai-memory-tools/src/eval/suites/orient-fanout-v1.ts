import { isRecord, type MemoryOrientDependencies, type MemoryOrientResponse } from '@aviaratech/ai-memory/internal';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { computeMean, roundTo } from '../metrics.js';
import {
  formatError,
  type OrientFanoutV1Fixture,
  parseOrientFanoutV1Fixture,
  readFixtureFiles,
} from './orient-fanout-v1-utils.js';
import { buildExperimentReport, type ExperimentDetail, type ExperimentReport, type SuiteRunOptions } from './types.js';

interface OrientFanoutV1SuiteDependencies {
  orientMemory: (input: unknown, dependencies?: MemoryOrientDependencies) => Promise<MemoryOrientResponse>;
}

interface OrientFanoutV1SuiteOptions extends SuiteRunOptions {
  dependencies?: Partial<OrientFanoutV1SuiteDependencies>;
}

interface RunState {
  details: ExperimentDetail[];
  directRecallValues: number[];
  implicationContributions: number[];
  mergedRecallValues: number[];
  temporalContributions: number[];
  zeroDirectRecoveries: number;
}

export async function runOrientFanoutV1Suite(options: OrientFanoutV1SuiteOptions): Promise<ExperimentReport> {
  const fixtureDirectory = resolve(options.fixturesRoot, 'orient-fanout-v1');
  const fixtureFiles = readFixtureFiles(fixtureDirectory);

  if (fixtureFiles.length === 0) {
    return buildMissingFixtureReport(fixtureDirectory);
  }

  const orientMemory = options.dependencies?.orientMemory ?? (await loadDefaultOrientMemory());

  const runState: RunState = {
    details: [],
    directRecallValues: [],
    implicationContributions: [],
    mergedRecallValues: [],
    temporalContributions: [],
    zeroDirectRecoveries: 0,
  };

  for (const fixturePath of fixtureFiles) {
    const fixtureName = basename(fixturePath, '.json');
    try {
      const fixture = parseOrientFanoutV1Fixture(readFileSync(fixturePath, 'utf8'));
      await evaluateFixture({ fixture, fixtureName, orientMemory, runState });
    } catch (error: unknown) {
      runState.details.push({
        actual: { error: formatError(error), fixturePath },
        expected: { runnableFixture: true },
        name: `orient-fanout-v1:${fixtureName}`,
        status: 'fail',
      });
    }
  }

  return buildExperimentReport({
    details: runState.details,
    metrics: {
      orientFanoutV1DirectRecallAtK: roundTo(computeMean(runState.directRecallValues), 4),
      orientFanoutV1FixtureCount: fixtureFiles.length,
      orientFanoutV1ImplicationContributionRate: roundTo(computeMean(runState.implicationContributions), 4),
      orientFanoutV1MergedRecallAtK: roundTo(computeMean(runState.mergedRecallValues), 4),
      orientFanoutV1TemporalContributionRate: roundTo(computeMean(runState.temporalContributions), 4),
      orientFanoutV1ZeroDirectRecoveryCount: runState.zeroDirectRecoveries,
    },
    suite: 'orient-fanout-v1',
  });
}

function buildFixtureDependencies(fixture: OrientFanoutV1Fixture): MemoryOrientDependencies {
  const allMemories = fixture.memories.map(m => ({
    category: m.category ?? 'general',
    confidence: m.confidence ?? 0.8,
    content: m.content,
    id: m.id,
    memoryKey: m.memoryKey,
    status: m.status ?? 'active',
    supersedesId: m.supersedesId,
    tags: m.tags ?? [],
  }));

  // Separate memories by temporal signal so lanes return genuinely different results
  const temporalIds = new Set<number>();
  const contested = allMemories.filter(m => m.status === 'contested');
  const superseding = allMemories.filter(m => m.supersedesId !== undefined);
  for (const m of [...contested, ...superseding]) temporalIds.add(m.id);

  const dedupedTemporal = [...new Map([...contested, ...superseding].map(m => [m.id, m])).values()];
  const nonTemporalMemories = allMemories.filter(m => !temporalIds.has(m.id));

  return {
    countContestedMemories: () => Promise.resolve(contested.length),
    getCapabilities: () => ({ hasEmbeddingColumn: false }),
    getSessionResume: () => Promise.resolve({ events: [], sessionId: 'eval', status: 'ok' }),
    probeEnvironment: () => ({
      capability: 'none' as const,
      environment: null,
      status: 'disabled' as const,
      warnings: [],
    }),
    recallMemories: () => Promise.resolve(allMemories.slice(0, 5)),
    searchMemories: (input: unknown) => {
      const req = isRecord(input) ? input : {};
      const query = typeof req.query === 'string' ? req.query : '';
      // Implication lane uses OR-joined query; direct lane uses raw task string
      if (query.includes(' OR ')) {
        return Promise.resolve(allMemories.slice(0, 5));
      }
      // Direct lane: return only non-temporal memories to simulate distinct retrieval
      return Promise.resolve(nonTemporalMemories.slice(0, 5));
    },
    searchTemporalMemories: () => Promise.resolve(dedupedTemporal.slice(0, 5)),
  };
}

function buildMissingFixtureReport(fixtureDirectory: string): ExperimentReport {
  return buildExperimentReport({
    details: [
      {
        actual: { fixtureDirectory },
        expected: { fixturesPresent: true },
        name: 'orient-fanout-v1:missing-fixtures',
        status: 'skip',
      },
    ],
    metrics: {
      orientFanoutV1DirectRecallAtK: 0,
      orientFanoutV1FixtureCount: 0,
      orientFanoutV1ImplicationContributionRate: 0,
      orientFanoutV1MergedRecallAtK: 0,
      orientFanoutV1TemporalContributionRate: 0,
      orientFanoutV1ZeroDirectRecoveryCount: 0,
    },
    suite: 'orient-fanout-v1',
  });
}

async function evaluateFixture(input: {
  fixture: OrientFanoutV1Fixture;
  fixtureName: string;
  orientMemory: (input: unknown, dependencies?: MemoryOrientDependencies) => Promise<MemoryOrientResponse>;
  runState: RunState;
}): Promise<void> {
  const { fixture, fixtureName, runState } = input;

  const dependencies = buildFixtureDependencies(fixture);
  const result = await input.orientMemory({ envProbe: 'none', task: fixture.task }, dependencies);

  const returnedIds = result.orientation.taskRelevant
    .map(m => (isRecord(m) ? (m.id as number) : undefined))
    .filter((id): id is number => id !== undefined);

  const expectedIds = new Set(fixture.expectedTaskRelevantIds);
  const hits = returnedIds.filter(id => expectedIds.has(id));
  const mergedRecall = expectedIds.size > 0 ? hits.length / expectedIds.size : 1;

  const diag = result.orientation.retrievalDiagnostics;
  const directIds = (diag?.merge.decisions ?? []).filter(d => d.reason === 'direct_baseline').map(d => d.memoryId);
  const directHits = directIds.filter(id => expectedIds.has(id));
  const directRecall = expectedIds.size > 0 ? directHits.length / expectedIds.size : 1;
  const directHitCount = diag?.intents.direct.hitCount ?? 0;
  const totalSelected = diag?.merge.selectedCount ?? returnedIds.length;
  const temporalSelected = diag?.intents.temporal.selectedCount ?? 0;
  const implicationSelected = diag?.intents.implication.selectedCount ?? 0;
  const temporalRate = totalSelected > 0 ? temporalSelected / totalSelected : 0;
  const implicationRate = totalSelected > 0 ? implicationSelected / totalSelected : 0;

  runState.mergedRecallValues.push(mergedRecall);
  runState.directRecallValues.push(directRecall);
  runState.temporalContributions.push(temporalRate);
  runState.implicationContributions.push(implicationRate);

  if (directHitCount === 0 && returnedIds.length > 0) {
    runState.zeroDirectRecoveries += 1;
  }

  const status = mergedRecall >= 0.5 ? 'pass' : 'fail';
  runState.details.push({
    actual: { directRecall, mergedRecall, returnedIds },
    expected: { expectedIds: fixture.expectedTaskRelevantIds, minimumRecall: 0.5 },
    metric: mergedRecall,
    name: `orient-fanout-v1:${fixtureName}`,
    status,
  });
}

async function loadDefaultOrientMemory() {
  const { orientMemory } = await import('@aviaratech/ai-memory/internal');
  return orientMemory;
}
