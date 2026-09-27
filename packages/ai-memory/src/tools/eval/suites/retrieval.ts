import { formatError, resetEmbeddingProvider, searchMemories, storeMemory } from '@aviaratech/ai-memory/internal';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { computeMean, computePrecisionAtK, computeRecallAtK, computeReciprocalRank, roundTo } from '../metrics.js';
import {
  buildProjectScope,
  parseRetrievalFixture,
  readFixtureFiles,
  resolveFixtureProjectScope,
  type RetrievalFixture,
  type RetrievalFixtureQuery,
  toMemoryKeys,
} from './retrieval-utils.js';
import { buildExperimentReport, type ExperimentDetail, type ExperimentReport, type SuiteRunOptions } from './types.js';

interface RetrievalRunState {
  coreResultByteValues: number[];
  details: ExperimentDetail[];
  latencyValues: number[];
  precisionValues: number[];
  recallValues: number[];
  reciprocalRankValues: number[];
  returnedSizeValues: number[];
  searchCalls: number;
  sourceCorrectValues: number[];
}

interface RetrievalSuiteDependencies {
  cleanupProjectEntries: (project: string) => Promise<void>;
  searchMemories: (input: unknown) => Promise<unknown[]>;
  storeMemory: (input: unknown) => Promise<unknown>;
}

interface RetrievalSuiteOptions extends SuiteRunOptions {
  dependencies?: Partial<RetrievalSuiteDependencies>;
}

const DEFAULT_DEPENDENCIES: RetrievalSuiteDependencies = {
  cleanupProjectEntries,
  searchMemories,
  storeMemory,
};

interface RetrievalQueryResult {
  coreResultBytes: number;
  latencyMs: number;
  precisionAtK: number;
  recallAtK: number;
  reciprocalRank: number;
  returnedEvidenceRefs: string[];
  returnedSources: string[];
  returnedTopK: string[];
  sourceCorrect: boolean | undefined;
}

export async function runRetrievalSuite(options: RetrievalSuiteOptions): Promise<ExperimentReport> {
  const dependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...options.dependencies,
  };
  const fixtureDirectory = resolve(options.fixturesRoot, 'retrieval');
  const fixtureFiles = readFixtureFiles(fixtureDirectory);

  if (fixtureFiles.length === 0) {
    return buildMissingFixtureReport(fixtureDirectory);
  }

  const runState = createRunState();
  await runWithEmbeddingsDisabled(async () => {
    await runRetrievalFixtures({ dependencies, fixtureFiles, runState });
  });

  return buildExperimentReport({
    details: runState.details,
    metrics: {
      retrievalEmbeddingDisabled: 1,
      retrievalMeanCoreResultBytes: roundTo(computeMean(runState.coreResultByteValues), 2),
      retrievalMeanLatencyMs: roundTo(computeMean(runState.latencyValues), 2),
      retrievalMeanPrecisionAtK: roundTo(computeMean(runState.precisionValues), 4),
      retrievalMeanRecallAtK: roundTo(computeMean(runState.recallValues), 4),
      retrievalMeanReturnedSize: roundTo(computeMean(runState.returnedSizeValues), 2),
      retrievalMrr: roundTo(computeMean(runState.reciprocalRankValues), 4),
      retrievalQueryCount: runState.precisionValues.length,
      retrievalSearchCallCount: runState.searchCalls,
      retrievalSourceCorrectnessPct: roundTo(computeMean(runState.sourceCorrectValues) * 100, 2),
    },
    suite: 'retrieval',
  });
}

function buildMissingFixtureReport(fixtureDirectory: string): ExperimentReport {
  return buildExperimentReport({
    details: [
      {
        actual: { fixtureDirectory, fixtureFiles: 0 },
        expected: { minimumFixtures: 1 },
        name: 'retrieval:fixtures',
        status: 'skip',
      },
    ],
    metrics: {},
    suite: 'retrieval',
  });
}

function buildRetrievalDetail(input: {
  fixtureName: string;
  queryCase: RetrievalFixtureQuery;
  queryIndex: number;
  queryResult: RetrievalQueryResult;
}): ExperimentDetail {
  const metric = computeMean([
    input.queryResult.precisionAtK,
    input.queryResult.recallAtK,
    input.queryResult.reciprocalRank,
  ]);

  return {
    actual: {
      coreResultBytes: input.queryResult.coreResultBytes,
      latencyMs: roundTo(input.queryResult.latencyMs, 2),
      measurementBoundary: 'serialized core result; MCP envelope and agent tokens measured by replay separately',
      precisionAtK: roundTo(input.queryResult.precisionAtK, 4),
      recallAtK: roundTo(input.queryResult.recallAtK, 4),
      reciprocalRank: roundTo(input.queryResult.reciprocalRank, 4),
      returnedEvidenceRefs: input.queryResult.returnedEvidenceRefs,
      returnedSources: input.queryResult.returnedSources,
      returnedTopK: input.queryResult.returnedTopK,
      searchCalls: 1,
      sourceCorrect: input.queryResult.sourceCorrect,
    },
    expected: {
      ...(input.queryCase.expectedEvidenceRefs !== undefined
        ? { expectedEvidenceRefs: input.queryCase.expectedEvidenceRefs }
        : {}),
      ...(input.queryCase.expectedSource !== undefined ? { expectedSource: input.queryCase.expectedSource } : {}),
      expectedTopK: input.queryCase.expectedTopK,
      query: input.queryCase.query,
      queryIndex: input.queryIndex,
    },
    metric: roundTo(metric * 100, 2),
    name: `retrieval:${input.fixtureName}:query-${String(input.queryIndex + 1)}`,
    status: resolveQueryStatus({
      expectedTopK: input.queryCase.expectedTopK,
      k: input.queryCase.k,
      returnedTopK: input.queryResult.returnedTopK,
      sourceCorrect: input.queryResult.sourceCorrect,
    }),
  };
}

async function cleanupProjectEntries(project: string): Promise<void> {
  const { pool } = await import('@aviaratech/ai-memory/internal');
  await pool.query(`DELETE FROM ai_memory_entries WHERE project = $1`, [project]);
}

function createRunState(): RetrievalRunState {
  return {
    coreResultByteValues: [],
    details: [],
    latencyValues: [],
    precisionValues: [],
    recallValues: [],
    reciprocalRankValues: [],
    returnedSizeValues: [],
    searchCalls: 0,
    sourceCorrectValues: [],
  };
}

async function evaluateRetrievalQueries(input: {
  fixture: RetrievalFixture;
  fixtureName: string;
  projectScope: string;
  runState: RetrievalRunState;
  searchMemoriesFn: RetrievalSuiteDependencies['searchMemories'];
}): Promise<void> {
  for (const [queryIndex, queryCase] of input.fixture.queries.entries()) {
    input.runState.searchCalls += 1;
    const queryResult = await runRetrievalQuery({
      projectScope: input.projectScope,
      queryCase,
      searchMemoriesFn: input.searchMemoriesFn,
    });

    input.runState.precisionValues.push(queryResult.precisionAtK);
    input.runState.recallValues.push(queryResult.recallAtK);
    input.runState.reciprocalRankValues.push(queryResult.reciprocalRank);
    input.runState.latencyValues.push(queryResult.latencyMs);
    input.runState.returnedSizeValues.push(queryResult.returnedTopK.length);
    input.runState.coreResultByteValues.push(queryResult.coreResultBytes);
    if (queryResult.sourceCorrect !== undefined) {
      input.runState.sourceCorrectValues.push(queryResult.sourceCorrect ? 1 : 0);
    }
    input.runState.details.push(
      buildRetrievalDetail({
        fixtureName: input.fixtureName,
        queryCase,
        queryIndex,
        queryResult,
      }),
    );
  }
}

function getFixtureProjectScopes(fixture: RetrievalFixture, projectScope: string): string[] {
  return [...new Set(fixture.memories.map(memory => resolveFixtureProjectScope(memory, projectScope)))];
}

function readReturnedEvidenceRefs(results: unknown[]): string[] {
  const values: string[] = [];
  for (const result of results) {
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      continue;
    }
    const evidenceRefs = (result as Record<string, unknown>).evidenceRefs;
    if (!Array.isArray(evidenceRefs)) {
      continue;
    }
    for (const evidenceRef of evidenceRefs) {
      if (typeof evidenceRef === 'string') {
        values.push(evidenceRef);
      } else if (evidenceRef !== null && typeof evidenceRef === 'object' && !Array.isArray(evidenceRef)) {
        for (const key of ['path', 'url'] as const) {
          const value = (evidenceRef as Record<string, unknown>)[key];
          if (typeof value === 'string') {
            values.push(value);
          }
        }
      }
    }
  }
  return [...new Set(values)];
}

function readReturnedSources(results: unknown[]): string[] {
  const sources = results.flatMap(result => {
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      return [];
    }
    const source = (result as Record<string, unknown>).source;
    return typeof source === 'string' ? [source] : [];
  });
  return [...new Set(sources)];
}

function resolveQueryStatus(input: {
  expectedTopK: string[];
  k: number;
  returnedTopK: string[];
  sourceCorrect: boolean | undefined;
}): ExperimentDetail['status'] {
  const returnedTopK = input.returnedTopK.slice(0, input.k);

  if (input.expectedTopK.length === 0) {
    return returnedTopK.length === 0 ? 'pass' : 'fail';
  }

  const hasAllExpected = input.expectedTopK.every(value => returnedTopK.includes(value));
  return hasAllExpected && input.sourceCorrect !== false ? 'pass' : 'fail';
}

async function runRetrievalFixture(input: {
  dependencies: RetrievalSuiteDependencies;
  fixtureIndex: number;
  fixturePath: string;
  runState: RetrievalRunState;
}): Promise<void> {
  const fixtureName = basename(input.fixturePath, '.json');
  const projectScope = buildProjectScope(fixtureName, input.fixtureIndex);
  let cleanupProjectScopes = [projectScope];

  try {
    const fixture = parseRetrievalFixture(readFileSync(input.fixturePath, 'utf8'));
    cleanupProjectScopes = getFixtureProjectScopes(fixture, projectScope);
    await seedFixtureMemories({
      fixture,
      projectScope,
      storeMemoryFn: input.dependencies.storeMemory,
    });
    await evaluateRetrievalQueries({
      fixture,
      fixtureName,
      projectScope,
      runState: input.runState,
      searchMemoriesFn: input.dependencies.searchMemories,
    });
  } catch (error: unknown) {
    input.runState.details.push({
      actual: { error: formatError(error), fixturePath: input.fixturePath },
      expected: { runnableFixture: true },
      name: `retrieval:${fixtureName}`,
      status: 'fail',
    });
  } finally {
    for (const cleanupProjectScope of cleanupProjectScopes) {
      try {
        await input.dependencies.cleanupProjectEntries(cleanupProjectScope);
      } catch {
        // Cleanup failures should not mask retrieval assertions.
      }
    }
  }
}

async function runRetrievalFixtures(input: {
  dependencies: RetrievalSuiteDependencies;
  fixtureFiles: string[];
  runState: RetrievalRunState;
}): Promise<void> {
  for (const [index, fixturePath] of input.fixtureFiles.entries()) {
    await runRetrievalFixture({
      dependencies: input.dependencies,
      fixtureIndex: index,
      fixturePath,
      runState: input.runState,
    });
  }
}

async function runRetrievalQuery(input: {
  projectScope: string;
  queryCase: RetrievalFixtureQuery;
  searchMemoriesFn: RetrievalSuiteDependencies['searchMemories'];
}): Promise<RetrievalQueryResult> {
  const startedAt = Date.now();
  const searchResults = await input.searchMemoriesFn({
    ...(input.queryCase.category !== undefined ? { category: input.queryCase.category } : {}),
    includeInactive: false,
    limit: input.queryCase.k,
    project: input.projectScope,
    query: input.queryCase.query,
  });
  const returnedTopK = toMemoryKeys(searchResults).slice(0, input.queryCase.k);
  const returnedResults = Array.isArray(searchResults) ? searchResults.slice(0, input.queryCase.k) : [];
  const returnedEvidenceRefs = readReturnedEvidenceRefs(returnedResults);
  const returnedSources = readReturnedSources(returnedResults);
  const expectedResults = returnedResults.filter(result => {
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      return false;
    }
    const memoryKey = (result as Record<string, unknown>).memoryKey;
    return typeof memoryKey === 'string' && input.queryCase.expectedTopK.includes(memoryKey);
  });
  const expectedEvidenceRefs = readReturnedEvidenceRefs(expectedResults);
  const expectedSources = readReturnedSources(expectedResults);
  const sourceCorrect =
    input.queryCase.expectedSource === undefined && input.queryCase.expectedEvidenceRefs === undefined
      ? undefined
      : (input.queryCase.expectedSource === undefined || expectedSources.includes(input.queryCase.expectedSource)) &&
        (input.queryCase.expectedEvidenceRefs === undefined ||
          input.queryCase.expectedEvidenceRefs.every(expected => expectedEvidenceRefs.includes(expected)));

  return {
    coreResultBytes: Buffer.byteLength(JSON.stringify(searchResults), 'utf8'),
    latencyMs: Date.now() - startedAt,
    precisionAtK: computePrecisionAtK({
      expected: input.queryCase.expectedTopK,
      k: input.queryCase.k,
      returned: returnedTopK,
    }),
    recallAtK: computeRecallAtK({
      expected: input.queryCase.expectedTopK,
      k: input.queryCase.k,
      returned: returnedTopK,
    }),
    reciprocalRank: computeReciprocalRank({
      expected: input.queryCase.expectedTopK,
      k: input.queryCase.k,
      returned: returnedTopK,
    }),
    returnedEvidenceRefs,
    returnedSources,
    returnedTopK,
    sourceCorrect,
  };
}

async function runWithEmbeddingsDisabled<T>(run: () => Promise<T>): Promise<T> {
  const previousProvider = process.env.AI_MEMORY_EMBEDDING_PROVIDER;
  process.env.AI_MEMORY_EMBEDDING_PROVIDER = 'none';
  resetEmbeddingProvider();

  try {
    return await run();
  } finally {
    if (previousProvider === undefined) {
      delete process.env.AI_MEMORY_EMBEDDING_PROVIDER;
    } else {
      process.env.AI_MEMORY_EMBEDDING_PROVIDER = previousProvider;
    }
    resetEmbeddingProvider();
  }
}

async function seedFixtureMemories(input: {
  fixture: RetrievalFixture;
  projectScope: string;
  storeMemoryFn: RetrievalSuiteDependencies['storeMemory'];
}): Promise<void> {
  for (const memory of input.fixture.memories) {
    const memoryInput = Object.fromEntries(Object.entries(memory).filter(([key]) => key !== 'fixtureProjectScope'));
    const content = typeof memory.content === 'string' ? memory.content.trim() : '';
    const category = typeof memory.category === 'string' ? memory.category.trim() : '';
    const memoryKey = typeof memory.memoryKey === 'string' ? memory.memoryKey.trim() : '';
    if (content.length === 0 || category.length === 0 || memoryKey.length === 0) {
      throw new Error('retrieval memories require non-empty "content", "category", and "memoryKey" values');
    }

    await input.storeMemoryFn({
      ...memoryInput,
      confidence: typeof memory.confidence === 'number' ? memory.confidence : 0.8,
      project: resolveFixtureProjectScope(memory, input.projectScope),
      sensitivity: 'internal',
      source: typeof memory.source === 'string' && memory.source.trim().length > 0 ? memory.source : 'eval-harness',
    });
  }
}
