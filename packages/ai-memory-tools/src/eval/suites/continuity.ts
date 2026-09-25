import {
  countContestedMemories,
  type EnvProbeMode,
  formatError,
  getCapabilities,
  getContinuityPack,
  getSessionResume,
  ingestMemoryDelta,
  isRecord,
  type MemoryOrientDependencies,
  orientMemory,
  probeEnvironment,
  recallMemories,
  searchMemories,
} from '@aviaratech/ai-memory/internal';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { buildFlushDeltaPayload } from '../../ingestion/flush-session-core-builders.js';
import { refreshContinuityPackFromFlush } from '../../ingestion/continuity-pack.js';
import { buildFlushSnapshotValue, parseFlushInput } from '../../ingestion/flush-session.js';
import { roundTo } from '../metrics.js';
import {
  buildSessionId,
  computeMean,
  type ContinuityFixture,
  evaluateContinuityFixture,
  normalizeSessionId,
  parseContinuityFixture,
  readFixtureFiles,
} from './continuity-utils.js';
import { buildExperimentReport, type ExperimentDetail, type ExperimentReport, type SuiteRunOptions } from './types.js';

interface ContinuitySuiteDependencies {
  cleanupSessionArtifacts: (sessionId: string) => Promise<void>;
  countContestedMemories: (input: unknown) => Promise<number>;
  getCapabilities: typeof getCapabilities;
  getContinuityPack: typeof getContinuityPack;
  getSessionResume: typeof getSessionResume;
  ingestMemoryDelta: (input: unknown) => Promise<unknown>;
  orientMemory: typeof orientMemory;
  probeEnvironment: typeof probeEnvironment;
  recallMemories: typeof recallMemories;
  refreshContinuityPack: typeof refreshContinuityPackFromFlush;
  searchMemories: typeof searchMemories;
}

interface ContinuitySuiteOptions extends SuiteRunOptions {
  dependencies?: Partial<ContinuitySuiteDependencies>;
}

const DEFAULT_DEPENDENCIES: ContinuitySuiteDependencies = {
  cleanupSessionArtifacts,
  countContestedMemories,
  getCapabilities,
  getContinuityPack,
  getSessionResume,
  ingestMemoryDelta,
  orientMemory,
  probeEnvironment,
  recallMemories,
  refreshContinuityPack: refreshContinuityPackFromFlush,
  searchMemories,
};

export async function runContinuitySuite(options: ContinuitySuiteOptions): Promise<ExperimentReport> {
  const dependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...options.dependencies,
  };
  const fixtureDirectory = resolve(options.fixturesRoot, 'continuity');
  const fixtureFiles = readFixtureFiles(fixtureDirectory);

  if (fixtureFiles.length === 0) {
    return buildMissingFixtureReport(fixtureDirectory);
  }

  const fixtureRun = await runContinuityFixtures({
    dependencies,
    fixtureFiles,
  });

  return buildExperimentReport({
    details: fixtureRun.details,
    metrics: {
      continuityAverageScorePct:
        fixtureRun.fixtureScores.length > 0 ? roundTo(computeMean(fixtureRun.fixtureScores), 2) : 0,
      continuityFixtureCount: fixtureFiles.length,
    },
    suite: 'continuity',
  });
}

function buildMissingFixtureReport(fixtureDirectory: string): ExperimentReport {
  return buildExperimentReport({
    details: [
      {
        actual: { fixtureDirectory, fixtureFiles: 0 },
        expected: { minimumFixtures: 1 },
        name: 'continuity:fixtures',
        status: 'skip',
      },
    ],
    metrics: {},
    suite: 'continuity',
  });
}

async function cleanupSessionArtifacts(sessionId: string): Promise<void> {
  const { pool } = await import('@aviaratech/ai-memory/internal');
  await pool.query(`DELETE FROM ai_continuity_packs WHERE session_id = $1`, [sessionId]);
  await pool.query(`DELETE FROM ai_memory_deltas WHERE session_id = $1`, [sessionId]);
  await pool.query(`DELETE FROM ai_context_packs WHERE session_id = $1`, [sessionId]);
  await pool.query(`DELETE FROM ai_session_events WHERE session_id = $1`, [sessionId]);
  await pool.query(`DELETE FROM ai_session_snapshots WHERE session_id = $1`, [sessionId]);
  await pool.query(`DELETE FROM ai_memory_entries WHERE session_id = $1`, [sessionId]);
  await pool.query(`DELETE FROM ai_sessions WHERE session_id = $1`, [sessionId]);
}

function createOrientDependencies(input: {
  dependencies: ContinuitySuiteDependencies;
  parsed: ReturnType<typeof parseFlushInput>;
  sessionId: string;
}): MemoryOrientDependencies {
  const { dependencies, sessionId } = input;

  return {
    countContestedMemories: dependencies.countContestedMemories,
    getCapabilities: dependencies.getCapabilities,
    getSessionResume: () =>
      dependencies.getSessionResume({
        agent: input.parsed.agent,
        eventLimit: 25,
        project: input.parsed.project,
        sessionId,
      }),
    probeEnvironment: (mode: EnvProbeMode) => dependencies.probeEnvironment(mode),
    recallMemories: dependencies.recallMemories,
    searchMemories: dependencies.searchMemories,
  };
}

function orientFixtureSession(input: {
  dependencies: ContinuitySuiteDependencies;
  parsed: ReturnType<typeof parseFlushInput>;
  sessionId: string;
}): ReturnType<ContinuitySuiteDependencies['orientMemory']> {
  const orientDependencies = createOrientDependencies({
    dependencies: input.dependencies,
    parsed: input.parsed,
    sessionId: input.sessionId,
  });

  return input.dependencies.orientMemory({ envProbe: 'none' }, orientDependencies);
}

async function replayFixtureFlush(input: {
  dependencies: ContinuitySuiteDependencies;
  fixture: ContinuityFixture;
  sessionId: string;
}): Promise<string> {
  const parsed = parseFlushInput({
    ...input.fixture.flush,
    sessionId: normalizeSessionId(input.fixture.flush.sessionId, input.sessionId),
  });
  const sessionId = parsed.sessionId ?? randomUUID();
  await input.dependencies.ingestMemoryDelta(
    buildFlushDeltaPayload({
      buildFlushSnapshotValue,
      nowIso: new Date().toISOString(),
      parsed,
      sessionId,
    }),
  );
  await input.dependencies.refreshContinuityPack({ parsed, reflectionCount: 0, sessionId });
  return sessionId;
}

async function runContinuityFixture(input: {
  dependencies: ContinuitySuiteDependencies;
  fixturePath: string;
  index: number;
}): Promise<{ detail: ExperimentDetail; scorePct: null | number }> {
  const fixtureName = basename(input.fixturePath, '.json');
  let sessionId = buildSessionId(fixtureName, input.index);

  try {
    const fixture = parseContinuityFixture(readFileSync(input.fixturePath, 'utf8'));
    const parsed = parseFlushInput(fixture.flush);
    sessionId = normalizeSessionId(parsed.sessionId, sessionId);
    sessionId = await replayFixtureFlush({
      dependencies: input.dependencies,
      fixture,
      sessionId,
    });
    const orientResult = await orientFixtureSession({
      dependencies: input.dependencies,
      parsed,
      sessionId,
    });

    await verifyFixtureIdentity({ dependencies: input.dependencies, fixture, orientResult, parsed, sessionId });

    const evaluation = evaluateContinuityFixture({
      fixture,
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
        name: `continuity:${fixtureName}`,
        status: 'fail',
      },
      scorePct: null,
    };
  } finally {
    try {
      await input.dependencies.cleanupSessionArtifacts(sessionId);
    } catch {
      // Cleanup failures should not mask fixture assertions.
    }
  }
}

async function runContinuityFixtures(input: {
  dependencies: ContinuitySuiteDependencies;
  fixtureFiles: string[];
}): Promise<{ details: ExperimentDetail[]; fixtureScores: number[] }> {
  const details: ExperimentDetail[] = [];
  const fixtureScores: number[] = [];

  for (const [index, fixturePath] of input.fixtureFiles.entries()) {
    const result = await runContinuityFixture({
      dependencies: input.dependencies,
      fixturePath,
      index,
    });
    details.push(result.detail);
    if (result.scorePct !== null) {
      fixtureScores.push(result.scorePct);
    }
  }

  return { details, fixtureScores };
}

async function verifyFixtureIdentity(input: {
  dependencies: ContinuitySuiteDependencies;
  fixture: ContinuityFixture;
  orientResult: Awaited<ReturnType<ContinuitySuiteDependencies['orientMemory']>>;
  parsed: ReturnType<typeof parseFlushInput>;
  sessionId: string;
}): Promise<void> {
  const { dependencies, parsed, sessionId } = input;
  const resumed = input.orientResult.orientation.priorSession;
  if (!isRecord(resumed) || resumed.status !== 'ok' || resumed.sessionId !== sessionId) {
    throw new Error('Continuity fixture did not recover its exact producing session.');
  }
  const session = isRecord(resumed.session) ? resumed.session : {};
  if (
    (parsed.project !== undefined && session.repoId !== parsed.project) ||
    (parsed.agent !== undefined && session.agent !== parsed.agent)
  ) {
    throw new Error('Continuity fixture lost its stored project or producer identity.');
  }
  if (parsed.project !== undefined) {
    const foreign = await dependencies.getSessionResume({
      agent: parsed.agent,
      project: `${parsed.project}:foreign`,
      sessionId,
    });
    if (foreign.status !== 'not_found') throw new Error('Foreign-project exact session lookup did not reject scope.');
  }
  if (parsed.agent !== undefined) {
    const foreign = await dependencies.getSessionResume({
      agent: `${parsed.agent}:foreign`,
      project: parsed.project,
      sessionId,
    });
    if (foreign.status !== 'not_found') throw new Error('Foreign-agent exact session lookup did not reject scope.');
  }
  if (parsed.project === undefined || parsed.task === undefined) return;

  const workerSessionId = buildSessionId('other-task', 0);
  try {
    await replayFixtureFlush({
      dependencies,
      fixture: {
        ...input.fixture,
        flush: {
          ...input.fixture.flush,
          nextActions: ['Review unrelated documentation.'],
          sessionId: workerSessionId,
          summary: 'Other task updated background project context.',
          task: `${parsed.task}:other`,
        },
      },
      sessionId: workerSessionId,
    });
    const task = await dependencies.getContinuityPack({ project: parsed.project, task: parsed.task });
    const project = await dependencies.getContinuityPack({ project: parsed.project });
    const foreign = await dependencies.getContinuityPack({ project: `${parsed.project}:foreign`, task: parsed.task });
    if (
      task.status !== 'found' ||
      task.pack.sessionId !== sessionId ||
      task.pack.pack.summary !== parsed.summary ||
      !isRecord(task.pack.pack.provenance) ||
      task.pack.pack.provenance.agent !== parsed.agent ||
      project.status !== 'found' ||
      project.pack.sessionId !== workerSessionId ||
      foreign.status !== 'missing'
    ) {
      throw new Error('Task checkpoint or provenance changed after another task replaced project background.');
    }
  } finally {
    await dependencies.cleanupSessionArtifacts(workerSessionId);
  }
}
