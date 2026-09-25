import type { Pool } from 'pg';

import assert from 'node:assert/strict';
import { test } from 'vitest';

import type { HealthReport, McpUsageMetrics } from './health-report.js';

import {
  buildReflectMetricsFromRows,
  buildTaxonomyDistribution,
  buildTopTimeoutOperations,
  collectMcpUsageMetrics,
  computeBrierScore,
  computeConsolidationMetrics,
  computeECE,
  computeUsefulnessMetrics,
  evaluateWriterParticipation,
  extractModulePath,
  formatNumber,
  formatPercent,
  parseCalibrationSignal,
  percent,
  renderReport,
  resolveDatabaseUrl,
} from './health-report.js';
import { computeLaunchGates, evaluateLaunchGateStatus, LAUNCH_GATE_THRESHOLDS } from './launch-gates.js';

const LOW_SIGNAL_TIER = 'low-signal' as const;
const SOURCE_CLAUDE_CODE = 'claude-code';
const TEST_DATABASE_URL = 'postgresql://ai_memory:ai_memory@localhost:5432/ai_memory';
const EMPTY_TAXONOMY_DISTRIBUTION = [
  { count: 0, pct: 0, tier: 'actionable' as const },
  { count: 0, pct: 0, tier: 'contextual' as const },
  { count: 0, pct: 0, tier: LOW_SIGNAL_TIER },
];

test('health-report database URL resolution prefers machine-global plugins env over repo .env', () => {
  const databaseUrl = resolveDatabaseUrl({
    env: {},
    globalEnv: {
      AI_MEMORY_DATABASE_URL: 'postgresql://localhost:5432/from-global',
    },
    repoEnv: {
      AI_MEMORY_DATABASE_URL: 'postgresql://localhost:5432/from-repo',
    },
  });

  assert.equal(databaseUrl, 'postgresql://localhost:5432/from-global');
});

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

function createMinimalReport(overrides?: DeepPartial<HealthReport>): HealthReport {
  const emptyChannel = {
    contextNeededCarriedForward: 0,
    contextNeededDerived: 0,
    contextNeededNonEmpty: 0,
    envModelPresent: 0,
    nextActionsCarriedForward: 0,
    nextActionsDerived: 0,
    nextActionsNonEmpty: 0,
    openQuestionsCarriedForward: 0,
    openQuestionsDerived: 0,
    openQuestionsNonEmpty: 0,
    snapshots: 0,
    stateModelPresent: 0,
  };
  const continuityAdoption = {
    agentWriterCompliancePct: 0,
    agentWriterCompliant: 0,
    agentWriterFlushes: 0,
    contextNeededNonEmpty: 0,
    envModelPresent: 0,
    nextActionsNonEmpty: 0,
    openQuestionsNonEmpty: 0,
    snapshots: 0,
    stateModelPresent: 0,
    ...overrides?.database?.continuityAdoption,
    auto: { ...emptyChannel, ...overrides?.database?.continuityAdoption?.auto },
    flush: { ...emptyChannel, ...overrides?.database?.continuityAdoption?.flush },
    unknown: { ...emptyChannel, ...overrides?.database?.continuityAdoption?.unknown },
  };
  const continuityReadiness = {
    actionableFieldCompletenessPct: 0,
    actionableFieldSlots: 0,
    actionableFieldsPopulated: 0,
    packDegradedReads: 0,
    packFoundReads: 0,
    packMissingReads: 0,
    packReadCalls: 0,
    packsWithActionableFields: 0,
    packsWithContextNeeded: 0,
    packsWithDecisions: 0,
    packsWithNextActions: 0,
    packsWithOpenQuestions: 0,
    sessionsWithFlushAfterPack: 0,
    sessionsWithPackRead: 0,
    totalPacksForFieldCompleteness: 0,
    ...overrides?.database?.continuityReadiness,
  };

  const database = {
    actionableFailures: 0,
    calibration: {
      assessment: null,
      brierScore: null,
      ece: null,
      signalCount: 0,
    },
    contextPacksIngested: 0,
    continuityPacks: {
      avgPayloadChars: 0,
      maxPayloadBudgetPct: 0,
      maxPayloadChars: 0,
      packs: 0,
      updatedInWindow: 0,
    },
    databaseUrl: TEST_DATABASE_URL,
    decisionReversalRate: {
      byCategory: [
        { category: 'decision', count: 0, denominator: 0, rate: 0 },
        { category: 'architecture', count: 0, denominator: 0, rate: 0 },
        { category: 'convention', count: 0, denominator: 0, rate: 0 },
      ],
      count: 0,
      denominator: 0,
      rate: 0,
    },
    deltasIngested: 0,
    deltaSourceMix: [],
    durableMemoriesCreated: 0,
    durableMemoriesUpdated: 0,
    durableWriterMix: [],
    failuresBySource: [],
    failuresByStage: [],
    failureWindows: {
      active: {
        end: '2026-01-15T00:00:00.000Z',
        resolved: 0,
        sources: [],
        start: '2026-01-14T00:00:00.000Z',
        total: 0,
        unresolved: 0,
      },
      historical: {
        end: '2026-01-14T00:00:00.000Z',
        resolved: 0,
        sources: [],
        start: '2026-01-08T00:00:00.000Z',
        total: 0,
        unresolved: 0,
      },
    },
    ingestionFailures: 0,
    memoryTypeNullRatePct: 0,
    memoryTypeNullSampleCount: 0,
    mttr: { avgMinutes: 0, resolved: 0, total: 0, unresolved: 0 },
    reflect: {
      cyclesInWindow: 0,
      evaluationsSinceLastCycle: null,
      lastCycleIso: null,
      provisionalMethodologyMemoriesWritten: 0,
      recentCycles: [],
    },
    repeatedFixRate: [],
    resolvedFailures: 0,
    sessionEndConflictRate14d: {
      conflictCount: 0,
      ratePct: 0,
      targetMet: true,
      targetPct: 1,
      windowDays: 14,
      writeCount: 0,
    },
    sessionsStarted: 0,
    taxonomyDistribution: EMPTY_TAXONOMY_DISTRIBUTION,
    topFailureSignatures: [],
    writeCalibration: {
      cells: [],
      topDepleted: [],
    },
    writerParticipationHealth: {
      belowThreshold: [],
      families: [],
      healthy: true,
      minPct: 10,
      totalSources: 0,
      totalWrites: 0,
    },
    ...overrides?.database,
    continuityAdoption,
    continuityReadiness,
    stateModelAdoptionPct: percent(continuityAdoption.stateModelPresent, continuityAdoption.snapshots),
  };

  const mcpUsage = {
    dedupeSuppressed: 0,
    errors: 0,
    invocations: 0,
    logFile: '/dev/null',
    logFileSource: 'repo_root' as const,
    orient: {
      calls: 0,
      degraded: 0,
      errors: 0,
      ok: 0,
      partial: 0,
      payloadBudgetChars: 0,
      payloadBudgetExceeded: 0,
      payloadBudgetExceededRatePct: 0,
      payloadCharsAvg: 0,
      payloadCharsMax: 0,
      payloadCharsP95: 0,
      payloadSamples: 0,
      payloadTokensAvg: 0,
      timeoutRatePct: 0,
      timeouts: 0,
      timeoutTargetPct: 1,
    },
    readInvocations: 0,
    resume: {
      calls: 0,
      errors: 0,
      notFound: 0,
      ok: 0,
      okDirect: 0,
      okFallback: 0,
    },
    successfulInvocations: 0,
    successRatePct: 0,
    telemetrySource: 'db' as const,
    tools: [] as McpUsageMetrics['tools'],
    toolTelemetryCoverage: 'none' as const,
    writeInvocations: 0,
    ...overrides?.mcpUsage,
  };

  // Compute launchGates from overrides so tests that override these fields get correct gate values.
  // Source directly from overrides (type: number | undefined) so ?? 0 is valid and not flagged.
  const launchGates = computeLaunchGates({
    continuity: {
      autoSnapshots: continuityAdoption.auto.snapshots,
      autoStateModelPresent: continuityAdoption.auto.stateModelPresent,
      flushSnapshots: continuityAdoption.flush.snapshots,
      flushStateModelPresent: continuityAdoption.flush.stateModelPresent,
      nextActionsNonEmpty: overrides?.database?.continuityAdoption?.nextActionsNonEmpty ?? 0,
      openQuestionsNonEmpty: overrides?.database?.continuityAdoption?.openQuestionsNonEmpty ?? 0,
      snapshots: overrides?.database?.continuityAdoption?.snapshots ?? 0,
      stateModelPresent: overrides?.database?.continuityAdoption?.stateModelPresent ?? 0,
    },
    memoryTypeNullRatePct: overrides?.database?.memoryTypeNullRatePct ?? 0,
    memoryTypeNullSampleCount: overrides?.database?.memoryTypeNullSampleCount ?? 0,
    orient: {
      calls: overrides?.mcpUsage?.orient?.calls ?? 0,
      degraded: overrides?.mcpUsage?.orient?.degraded ?? 0,
      timeouts: overrides?.mcpUsage?.orient?.timeouts ?? 0,
    },
    tools: overrides?.mcpUsage?.tools ?? [],
  });

  const report = {
    database,
    generatedAt: overrides?.generatedAt ?? '2026-01-15T00:00:00.000Z',
    launchGates,
    mcpUsage,
    orchestration: {
      approvalRatePct: 0,
      approved: 0,
      avgRoundsPerRun: 0,
      error: 0,
      insightFiles: 0,
      issueSeedFiles: 0,
      notApproved: 0,
      retroDirectory: '/dev/null',
      retroMarkdownFiles: 0,
      runs: 0,
      totalTokens: 0,
      transcriptDirectory: '/dev/null',
      ...overrides?.orchestration,
    },
    period: {
      days: 7,
      end: '2026-01-15T00:00:00.000Z',
      start: '2026-01-08T00:00:00.000Z',
      ...overrides?.period,
    },
    retention: {
      backlog: [],
      config: {
        auditDays: 180,
        batchSize: 1000,
        expiredGraceDays: 30,
        failureDays: 30,
        sessionDays: 90,
        supersededDays: 180,
        telemetryDays: 90,
      },
      lastRun: null,
      totalBacklog: 0,
      ...overrides?.retention,
    },
  };
  return report as HealthReport;
}

test('renderReport includes Write Calibration section with depleted author-category cells', () => {
  const report = createMinimalReport({
    database: {
      writeCalibration: {
        cells: [
          {
            author: 'codex-builder',
            avgCalibratedConfidence: 0.41,
            avgDeclaredConfidence: 0.9,
            brierScore: null,
            category: 'architecture',
            memoryCount: 18,
            reversalRate: 0.2778,
          },
        ],
        topDepleted: [
          {
            author: 'codex-builder',
            avgCalibratedConfidence: 0.41,
            avgDeclaredConfidence: 0.9,
            brierScore: null,
            category: 'architecture',
            memoryCount: 18,
            reversalRate: 0.2778,
          },
        ],
      },
    },
  });

  const output = renderReport(report);

  assert.ok(output.includes('Write Calibration'));
  assert.ok(output.includes('codex-builder / architecture'));
  assert.ok(output.includes('declared=0.90'));
  assert.ok(output.includes('calibrated=0.41'));
  assert.ok(output.includes('reversal=27.8%'));
});

// --- percent() ---

test('percent returns 0 when denominator is zero', () => {
  assert.equal(percent(5, 0), 0);
});

test('percent returns correct percentage', () => {
  assert.equal(percent(1, 4), 25);
});

test('percent rounds to one decimal', () => {
  assert.equal(percent(1, 3), 33.3);
});

test('collectMcpUsageMetrics uses DB rows as the sole MCP telemetry source', async () => {
  const observedQueries: unknown[][] = [];
  const mockPool = {
    query: (sql: string, params: unknown[]) => {
      observedQueries.push([sql, ...params]);
      return Promise.resolve({
        rows: [
          {
            durable_memories_deduped: 2,
            duration_ms: 12,
            environment_status: 'local_fallback',
            orient_payload_budget_chars: 64,
            orient_payload_budget_exceeded: 0,
            orient_payload_chars: 8,
            orient_payload_tokens_estimate: 4,
            resolved_via: 'direct',
            response_status: 'ok',
            status: 'ok',
            timeout_warning_count: 0,
            tool_category: 'read',
            tool_name: 'memory_orient',
            warning_count: 0,
            write_disposition: '',
          },
        ],
      });
    },
  } as unknown as Pool;

  const usage = await collectMcpUsageMetrics({
    logFile: 'unused.log',
    logFileSource: 'repo_root',
    pool: mockPool,
    windowEndIso: '2026-01-02T10:00:00.000Z',
    windowStartMs: Date.parse('2026-01-01T00:00:00.000Z'),
  });

  assert.equal(usage.telemetrySource, 'db', 'telemetry source must be DB after sunset');
  assert.equal(usage.invocations, 1, 'should include MCP invocation rows from DB');
  assert.equal(usage.orient.calls, 1, 'should include orient call count');
  assert.equal(usage.orient.ok, 1, 'should include orient success count');
  const orientTool = usage.tools[0];
  assert.ok(orientTool !== undefined, 'should include oriented tool in tool summary');
  assert.equal(orientTool.toolName, 'memory_orient');
  assert.deepEqual(
    orientTool.environmentStatusCounts,
    { local_fallback: 1 },
    'should expose environment fallback separately from the ok memory-orient response',
  );
  assert.equal(observedQueries.length, 1, 'should read MCP telemetry via injected pool');
  const firstQuery = observedQueries[0];
  if (firstQuery === undefined) {
    assert.fail('expected one telemetry query to be captured');
  }
  assert.equal(firstQuery[1], '2026-01-01T00:00:00.000Z', 'should use window start ISO timestamp');
  assert.equal(firstQuery[2], '2026-01-02T10:00:00.000Z', 'should use window end ISO timestamp');
});

test('collectMcpUsageMetrics keeps covered orient lane timeouts out of the launch-gate timeout count', async () => {
  const makeOrientInvocationRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
    durable_memories_deduped: 0,
    duration_ms: 12,
    orient_payload_budget_chars: 64,
    orient_payload_budget_exceeded: 0,
    orient_payload_chars: 8,
    orient_payload_tokens_estimate: 4,
    resolved_via: '',
    response_status: 'ok',
    status: 'ok',
    timeout_warning_count: 0,
    tool_category: 'read',
    tool_name: 'memory_orient',
    warning_count: 0,
    write_disposition: '',
    ...overrides,
  });
  const mockPool = {
    query: () =>
      Promise.resolve({
        rows: [
          makeOrientInvocationRow({ response_status: 'ok', timeout_warning_count: 1 }),
          makeOrientInvocationRow({ response_status: 'partial', timeout_warning_count: 1 }),
          makeOrientInvocationRow({ response_status: 'degraded', timeout_warning_count: 1 }),
          makeOrientInvocationRow({ response_status: 'error', status: 'error', timeout_warning_count: 1 }),
          makeOrientInvocationRow({ response_status: 'ok', timeout_warning_count: 0 }),
        ],
      }),
  } as unknown as Pool;

  const usage = await collectMcpUsageMetrics({
    logFile: 'unused.log',
    logFileSource: 'repo_root',
    pool: mockPool,
    windowEndIso: '2026-01-02T10:00:00.000Z',
    windowStartMs: Date.parse('2026-01-01T00:00:00.000Z'),
  });

  assert.equal(usage.orient.calls, 5, 'should count all orient calls');
  assert.equal(usage.orient.ok, 2, 'covered lane timeout should still be an ok orient call');
  assert.equal(usage.orient.partial, 1, 'partial timeout-warning orient calls still count by status');
  assert.equal(usage.orient.degraded, 1, 'degraded timeout-warning orient calls still count by status');
  assert.equal(usage.orient.errors, 1, 'failed timeout-warning orient calls still count by status');
  assert.equal(usage.orient.timeouts, 3, 'only non-ok timeout-warning outcomes count against the launch gate');
  assert.equal(usage.orient.timeoutRatePct, 60, 'timeout rate should use the launch-gate timeout count');
});

test('collectMcpUsageMetrics marks MCP telemetry as unavailable on DB query failure', async () => {
  const mockPool = {
    query: () => {
      throw new Error('telemetry query failed');
    },
  } as unknown as Pool;

  const usage = await collectMcpUsageMetrics({
    logFile: 'unused.log',
    logFileSource: 'repo_root',
    pool: mockPool,
    windowEndIso: '2026-01-02T10:00:00.000Z',
    windowStartMs: Date.parse('2026-01-01T00:00:00.000Z'),
  });

  assert.equal(usage.telemetrySource, 'unavailable', 'telemetry should be marked unavailable on DB errors');
  assert.equal(usage.telemetryError, 'telemetry query failed', 'telemetry error should be surfaced');
  assert.equal(usage.invocations, 0, 'should emit empty MCP metrics when DB telemetry is unavailable');
});

// --- formatPercent() ---

test('formatPercent formats value with one decimal and percent sign', () => {
  assert.equal(formatPercent(33.3), '33.3%');
});

test('formatPercent formats zero', () => {
  assert.equal(formatPercent(0), '0.0%');
});

// --- formatNumber() ---

test('formatNumber formats finite number', () => {
  assert.equal(formatNumber(42.567, 1), '42.6');
});

test('formatNumber returns 0 for non-finite input', () => {
  assert.equal(formatNumber(NaN, 1), '0');
  assert.equal(formatNumber(Infinity, 1), '0');
  assert.equal(formatNumber(undefined, 1), '0');
});

// --- calibration metrics ---

test('computeBrierScore returns 0.0 for perfect predictions', () => {
  const signals = Array.from({ length: 10 }, () => ({
    actual: 'success' as const,
    actualOutcome: 1,
    predicted: 'high' as const,
    predictedProbability: 1,
  }));

  const score = computeBrierScore(signals);

  assert.equal(score, 0);
});

test('computeBrierScore returns high score for worst-case predictions', () => {
  const signals = Array.from({ length: 10 }, () => ({
    actual: 'failure' as const,
    actualOutcome: 0,
    predicted: 'high' as const,
    predictedProbability: 1,
  }));

  const score = computeBrierScore(signals);

  assert.ok(score !== null, 'score should be computed with enough signals');
  assert.ok(score > 0.8, 'worst-case predictions should produce a high Brier score');
});

test('computeBrierScore returns null when fewer than 10 signals', () => {
  const signals = Array.from({ length: 9 }, () => ({
    actual: 'success' as const,
    actualOutcome: 1,
    predicted: 'high' as const,
    predictedProbability: 0.85,
  }));

  const score = computeBrierScore(signals);

  assert.equal(score, null);
});

test('computeECE returns high ECE for systematically overconfident predictions', () => {
  const signals = Array.from({ length: 10 }, () => ({
    actual: 'failure' as const,
    actualOutcome: 0,
    predicted: 'high' as const,
    predictedProbability: 0.85,
  }));

  const result = computeECE(signals);

  assert.ok(result !== null, 'ECE should be computed with enough signals');
  assert.ok(result.ece > 0.8, 'systematic overconfidence should produce high ECE');
  const highBin = result.bins.find(bin => bin.range === '[0.7, 1.0]');
  assert.ok(highBin !== undefined, 'should include high-confidence bin');
  assert.ok(
    highBin.error >= result.ece,
    'high-confidence bin error should dominate when all predictions are high and wrong',
  );
});

test('computeECE returns low ECE for well-calibrated predictions', () => {
  const signals = [
    ...Array.from({ length: 4 }, () => ({
      actual: 'failure' as const,
      actualOutcome: 0.2,
      predicted: 'low' as const,
      predictedProbability: 0.2,
    })),
    ...Array.from({ length: 3 }, () => ({
      actual: 'partial' as const,
      actualOutcome: 0.5,
      predicted: 'medium' as const,
      predictedProbability: 0.5,
    })),
    ...Array.from({ length: 3 }, () => ({
      actual: 'success' as const,
      actualOutcome: 0.9,
      predicted: 'high' as const,
      predictedProbability: 0.9,
    })),
  ];

  const result = computeECE(signals);

  assert.ok(result !== null, 'ECE should be computed with enough signals');
  assert.ok(result.ece < 0.05, 'well-calibrated predictions should produce low ECE');
});

test('computeECE returns null when fewer than 10 signals', () => {
  const signals = Array.from({ length: 9 }, () => ({
    actual: 'success' as const,
    actualOutcome: 1,
    predicted: 'high' as const,
    predictedProbability: 0.85,
  }));

  const result = computeECE(signals);

  assert.equal(result, null);
});

test('parseCalibrationSignal maps metadata payload to calibration signal values', () => {
  const parsed = parseCalibrationSignal({
    actual: 'success',
    predicted: 'high',
  });

  assert.ok(parsed !== null, 'expected calibration signal to parse');
  assert.equal(parsed.actual, 'success');
  assert.equal(parsed.predicted, 'high');
  assert.equal(parsed.actualOutcome, 1);
  assert.equal(parsed.predictedProbability, 0.85);
});

test('buildReflectMetricsFromRows summarizes cycles, skips, and provisional writes', () => {
  const metrics = buildReflectMetricsFromRows(
    [
      {
        created_at: '2026-04-25T12:00:00.000Z',
        memory_key: 'example/catalog:methodology:reflect:cycle-2026-04-25T12:00:00.000Z',
        metadata_json: {
          cycleId: 'cycle-a',
          evaluationCountAtReflection: 411,
          evaluationsSinceLastCycle: 50,
          provisionalMethodologyMemoriesWritten: 1,
          skippedTargets: ['skip:reference-fetch-failed:3a'],
          triggeredBy: 'count-threshold',
        },
      },
      {
        created_at: '2026-04-26T12:00:00.000Z',
        memory_key: 'example/catalog:methodology:reflect:cycle-2026-04-26T12:00:00.000Z',
        metadata_json: {
          completedAt: '2026-04-26T12:00:00.000Z',
          cycleId: 'cycle-b',
          evaluationCountAtReflection: 461,
          evaluationsSinceLastCycle: 50,
          skippedTargets: [],
          triggeredBy: 'weekly-fallback',
        },
      },
    ],
    3,
  );

  assert.equal(metrics.cyclesInWindow, 2);
  assert.equal(metrics.lastCycleIso, '2026-04-26T12:00:00.000Z');
  assert.equal(metrics.evaluationsSinceLastCycle, 50);
  assert.equal(metrics.provisionalMethodologyMemoriesWritten, 3);
  assert.equal(metrics.recentCycles[0]?.cycleId, 'cycle-b');
  assert.deepEqual(metrics.recentCycles[1]?.skippedTargets, ['skip:reference-fetch-failed:3a']);
});

// --- extractModulePath() ---

test('extractModulePath resolves module from file path string', () => {
  const result = extractModulePath('packages/ai-memory/src/db/memory-api.ts');
  assert.equal(result, 'packages/ai-memory');
});

test('extractModulePath resolves module from GitHub blob URL', () => {
  const result = extractModulePath(
    'https://github.com/example/catalog/blob/main/packages/ai-memory/src/db/memory-api.ts',
  );
  assert.equal(result, 'packages/ai-memory');
});

test('extractModulePath returns null for malformed URL', () => {
  const result = extractModulePath('https://github.com/example/catalog/blob/%zz/not-valid');
  assert.equal(result, null);
});

test('extractModulePath resolves object refs with path field', () => {
  const result = extractModulePath({
    path: 'packages/example/src/services/engine.ts',
  });
  assert.equal(result, 'packages/example');
});

test('extractModulePath returns null for null/number/empty string', () => {
  assert.equal(extractModulePath(null), null);
  assert.equal(extractModulePath(42), null);
  assert.equal(extractModulePath(''), null);
});

// --- renderReport writer-mix ---

test('renderReport includes writer-mix line when entries exist', () => {
  const report = createMinimalReport({
    database: {
      contextPacksIngested: 0,
      databaseUrl: TEST_DATABASE_URL,
      deltasIngested: 0,
      deltaSourceMix: [],
      durableMemoriesCreated: 10,
      durableMemoriesUpdated: 0,
      durableWriterMix: [
        { count: 6, pct: 60, source: SOURCE_CLAUDE_CODE },
        { count: 4, pct: 40, source: 'codex' },
      ],
      failuresBySource: [],
      ingestionFailures: 0,
      mttr: { avgMinutes: 0, resolved: 0, total: 0, unresolved: 0 },
      sessionEndConflictRate14d: {
        conflictCount: 0,
        ratePct: 0,
        targetMet: true,
        targetPct: 1,
        windowDays: 14,
        writeCount: 0,
      },
      sessionsStarted: 0,
      taxonomyDistribution: EMPTY_TAXONOMY_DISTRIBUTION,
      writerParticipationHealth: {
        belowThreshold: [],
        families: [
          { family: 'claude', pct: 60, sources: [SOURCE_CLAUDE_CODE], writes: 6 },
          { family: 'codex', pct: 40, sources: ['codex'], writes: 4 },
        ],
        healthy: true,
        minPct: 10,
        totalSources: 2,
        totalWrites: 10,
      },
    },
  });

  const output = renderReport(report);

  assert.ok(output.includes('Deliberate durable writer mix:'), 'should contain writer-mix header');
  assert.ok(output.includes('claude-code=6 (60.0%)'), 'should contain claude-code entry');
  assert.ok(output.includes('codex=4 (40.0%)'), 'should contain codex entry');
});

test('renderReport omits writer-mix line when no entries', () => {
  const report = createMinimalReport();

  const output = renderReport(report);

  assert.ok(!output.includes('Deliberate durable writer mix:'), 'should not contain writer-mix line');
});

test('renderReport renders single source at 100%', () => {
  const report = createMinimalReport({
    database: {
      contextPacksIngested: 0,
      databaseUrl: TEST_DATABASE_URL,
      deltasIngested: 0,
      deltaSourceMix: [],
      durableMemoriesCreated: 5,
      durableMemoriesUpdated: 0,
      durableWriterMix: [{ count: 5, pct: 100, source: SOURCE_CLAUDE_CODE }],
      failuresBySource: [],
      ingestionFailures: 0,
      mttr: { avgMinutes: 0, resolved: 0, total: 0, unresolved: 0 },
      sessionEndConflictRate14d: {
        conflictCount: 0,
        ratePct: 0,
        targetMet: true,
        targetPct: 1,
        windowDays: 14,
        writeCount: 0,
      },
      sessionsStarted: 0,
      taxonomyDistribution: EMPTY_TAXONOMY_DISTRIBUTION,
      writerParticipationHealth: {
        belowThreshold: [],
        families: [{ family: 'claude', pct: 100, sources: [SOURCE_CLAUDE_CODE], writes: 5 }],
        healthy: true,
        minPct: 10,
        totalSources: 1,
        totalWrites: 5,
      },
    },
  });

  const output = renderReport(report);

  assert.ok(output.includes('claude-code=5 (100.0%)'), 'should show single source at 100%');
  assert.ok(!output.includes('codex'), 'should not mention absent source');
});

// --- renderReport delta-source-mix ---

test('renderReport includes delta-source-mix line when entries exist', () => {
  const report = createMinimalReport({
    database: {
      contextPacksIngested: 0,
      databaseUrl: TEST_DATABASE_URL,
      deltasIngested: 12,
      deltaSourceMix: [
        { count: 8, pct: 66.7, source: 'codex-wrapper' },
        { count: 4, pct: 33.3, source: 'codex-launchd' },
      ],
      durableMemoriesCreated: 0,
      durableMemoriesUpdated: 0,
      durableWriterMix: [],
      failuresBySource: [],
      ingestionFailures: 0,
      mttr: { avgMinutes: 0, resolved: 0, total: 0, unresolved: 0 },
      sessionEndConflictRate14d: {
        conflictCount: 0,
        ratePct: 0,
        targetMet: true,
        targetPct: 1,
        windowDays: 14,
        writeCount: 0,
      },
      sessionsStarted: 0,
      taxonomyDistribution: EMPTY_TAXONOMY_DISTRIBUTION,
      writerParticipationHealth: {
        belowThreshold: [],
        families: [],
        healthy: true,
        minPct: 10,
        totalSources: 0,
        totalWrites: 0,
      },
    },
  });

  const output = renderReport(report);

  assert.ok(output.includes('Delta source mix (workflow.system/source):'), 'should contain channel-mix header');
  assert.ok(output.includes('codex-wrapper=8 (66.7%)'), 'should contain codex-wrapper entry');
  assert.ok(output.includes('codex-launchd=4 (33.3%)'), 'should contain codex-launchd entry');
});

test('renderReport omits delta-source-mix line when no entries', () => {
  const report = createMinimalReport();

  const output = renderReport(report);

  assert.ok(!output.includes('Delta source mix (workflow.system/source):'), 'should not contain channel-mix line');
});

test('renderReport includes failure-stage line when stage data exists', () => {
  const report = createMinimalReport({
    database: {
      failuresBySource: [{ count: 4, source: 'mcp-tool' }],
      failuresByStage: [
        { count: 2, stage: 'memory_flush' },
        { count: 1, stage: 'memory_search' },
        { count: 1, stage: 'memory_orient' },
      ],
      ingestionFailures: 4,
      mttr: { avgMinutes: 10, resolved: 3, total: 4, unresolved: 1 },
    },
  });

  const output = renderReport(report);

  assert.ok(output.includes('Failure stages:'), 'should contain failure-stage header');
  assert.ok(output.includes('memory_flush=2'), 'should include memory_flush stage count');
  assert.ok(output.includes('memory_search=1'), 'should include memory_search stage count');
  assert.ok(output.includes('memory_orient=1'), 'should include memory_orient stage count');
});

test('renderReport labels active and historical failure windows with explicit ranges', () => {
  const report = createMinimalReport({
    database: {
      failureWindows: {
        active: {
          end: '2026-01-15T00:00:00.000Z',
          resolved: 1,
          sources: [{ count: 3, source: 'mcp-tool' }],
          start: '2026-01-14T00:00:00.000Z',
          total: 3,
          unresolved: 2,
        },
        historical: {
          end: '2026-01-14T00:00:00.000Z',
          resolved: 4,
          sources: [{ count: 5, source: 'codex-wrapper' }],
          start: '2026-01-08T00:00:00.000Z',
          total: 5,
          unresolved: 1,
        },
      },
    },
  });

  const output = renderReport(report);

  assert.ok(
    output.includes(
      'Active failures (2026-01-14T00:00:00.000Z to 2026-01-15T00:00:00.000Z): Unresolved=2, Resolved=1 (active incidents)',
    ),
    'should show active failure window with explicit unresolved/resolved split + incident-status suffix',
  );
  assert.ok(output.includes('Active sources: mcp-tool=3'), 'should show active source breakdown');
  assert.ok(
    output.includes(
      'Historical failures (2026-01-08T00:00:00.000Z to 2026-01-14T00:00:00.000Z): Unresolved debt=1, Resolved=4 (historical cleanup debt',
    ),
    'should show historical failure window with explicit unresolved-debt vs resolved split + debt-status suffix',
  );
  assert.ok(output.includes('Historical sources: codex-wrapper=5'), 'should show historical source breakdown');
});

test('renderReport reports no historical debt when historical resolved > 0 but historical unresolved == 0', () => {
  // The reviewer-flagged F1 case: historical rows exist but are all resolved, so the
  // renderer must NOT show "historical cleanup debt". The resolved count is still
  // surfaced for visibility.
  const report = createMinimalReport({
    database: {
      failureWindows: {
        active: {
          end: '2026-05-12T00:00:00.000Z',
          resolved: 0,
          sources: [],
          start: '2026-05-11T00:00:00.000Z',
          total: 0,
          unresolved: 0,
        },
        historical: {
          end: '2026-05-11T00:00:00.000Z',
          resolved: 73,
          sources: [{ count: 73, source: 'codex-wrapper' }],
          start: '2026-05-05T00:00:00.000Z',
          total: 73,
          unresolved: 0,
        },
      },
    },
  });

  const output = renderReport(report);

  assert.ok(
    output.includes(
      'Historical failures (2026-05-05T00:00:00.000Z to 2026-05-11T00:00:00.000Z): Unresolved debt=0, Resolved=73 (no historical debt)',
    ),
    'all-resolved historical rows must be labeled "no historical debt", not "cleanup debt"',
  );
  assert.ok(
    !output.includes('historical cleanup debt'),
    'must not announce cleanup debt when every historical row is resolved',
  );
});

test('renderReport includes repeated failure signatures with source breakdown', () => {
  const report = createMinimalReport({
    database: {
      topFailureSignatures: [
        {
          count: 4,
          signature: 'memory_flush: durable memories outside session-summary must use confidence >= <n>.',
          sources: [
            { count: 3, source: 'mcp-tool' },
            { count: 1, source: 'codex-wrapper' },
          ],
        },
      ],
    },
  });

  const output = renderReport(report);

  assert.ok(output.includes('Top repeated failure signatures (top 5):'), 'should show signature heading');
  assert.ok(
    output.includes(
      'memory_flush: durable memories outside session-summary must use confidence >= <n>. => 4 (sources: mcp-tool=3, codex-wrapper=1)',
    ),
    'should render signature count and source breakdown',
  );
});

test('renderReport includes continuity adoption summary when snapshots exist', () => {
  const report = createMinimalReport({
    database: {
      continuityAdoption: {
        contextNeededNonEmpty: 3,
        envModelPresent: 2,
        nextActionsNonEmpty: 7,
        openQuestionsNonEmpty: 4,
        snapshots: 10,
        stateModelPresent: 6,
      },
    },
  });

  const output = renderReport(report);

  assert.ok(output.includes('Snapshot continuity adoption: snapshots=10'), 'should show snapshot count');
  assert.ok(output.includes('next_actions=7 (70.0%)'), 'should show next_actions adoption');
  assert.ok(output.includes('context_needed=3 (30.0%)'), 'should show context_needed adoption');
  assert.ok(output.includes('open_questions=4 (40.0%)'), 'should show open_questions adoption');
  assert.ok(output.includes('x_state_model=6 (60.0%)'), 'should show state-model adoption');
  assert.ok(output.includes('x_env_model=2 (20.0%)'), 'should show env-model adoption');
});

test('renderReport breaks down continuity adoption by channel (flush vs auto)', () => {
  // Mirrors a low-adoption shape: a healthy explicit-flush channel and a
  // structurally low auto channel should both be visible side-by-side rather than
  // mixed into one aggregate that hides the flush channel's success.
  const report = createMinimalReport({
    database: {
      continuityAdoption: {
        auto: {
          contextNeededDerived: 150,
          contextNeededNonEmpty: 180,
          envModelPresent: 870,
          nextActionsCarriedForward: 20,
          nextActionsDerived: 210,
          nextActionsNonEmpty: 250,
          openQuestionsCarriedForward: 15,
          openQuestionsDerived: 190,
          openQuestionsNonEmpty: 220,
          snapshots: 972,
          stateModelPresent: 0,
        },
        contextNeededNonEmpty: 470,
        envModelPresent: 1142,
        flush: {
          contextNeededNonEmpty: 290,
          envModelPresent: 270,
          nextActionsNonEmpty: 290,
          openQuestionsNonEmpty: 280,
          snapshots: 292,
          stateModelPresent: 292,
        },
        nextActionsNonEmpty: 540,
        openQuestionsNonEmpty: 500,
        snapshots: 1264,
        stateModelPresent: 292,
      },
    },
  });

  const output = renderReport(report);

  assert.ok(
    output.includes('Snapshot continuity adoption: snapshots=1264'),
    'should still show aggregate snapshot count for backward continuity',
  );
  assert.ok(output.includes('flush (explicit memory_flush): snapshots=292'), 'should split the flush channel line out');
  assert.ok(
    output.includes('auto (derived/carry-forward): snapshots=972'),
    'should split the auto-ingest channel line out',
  );
  assert.ok(output.includes('context_needed=470 (37.2%)'), 'aggregate should include context-needed coverage');
  assert.ok(
    output.includes('derived next_actions=210 open_questions=190 context_needed=150'),
    'auto channel should show derived continuity separately from declared flush continuity',
  );
  assert.ok(
    output.includes('carry_forward next_actions=20 open_questions=15 context_needed=0'),
    'auto channel should show carry-forward continuity separately from derived continuity',
  );
  assert.ok(output.includes('x_state_model=292 (100.0%)'), 'flush channel state-model should be 100%');
  assert.ok(output.includes('x_state_model=0 (0.0%)'), 'auto channel state-model should be 0%');
});

test('renderReport surfaces continuity-pack read telemetry even when not a top tool', () => {
  const report = createMinimalReport({
    mcpUsage: {
      invocations: 10,
      readInvocations: 10,
      successfulInvocations: 9,
      successRatePct: 90,
      tools: [
        {
          avgDurationMs: 12,
          calls: 2,
          errors: 1,
          p95DurationMs: 20,
          responseStatusCounts: { found: 1, missing: 1 },
          successes: 1,
          successRatePct: 50,
          toolCategory: 'read',
          toolName: 'memory_continuity_pack',
        },
      ],
    },
  });

  const output = renderReport(report);

  assert.ok(
    output.includes('Continuity pack reads: calls=2 success=50.0% errors=1 avg=12.0ms p95=20.0ms'),
    'continuity-pack read telemetry should have a dedicated health line',
  );
  assert.ok(
    output.includes(
      'Continuity pack read quality: success=50.0% (target >= 99.0%, below-target), missing/degraded=1/2 (50.0%), p95=20.0ms (target <= 500ms, on-target)',
    ),
    'continuity-pack read quality should call out success, missing/degraded, and p95 status',
  );
});

test('renderReport surfaces memory-orient environment status without recasting it as memory failure', () => {
  const report = createMinimalReport({
    mcpUsage: {
      invocations: 1,
      orient: {
        calls: 1,
        degraded: 0,
        errors: 0,
        ok: 1,
        partial: 0,
        payloadBudgetChars: 0,
        payloadBudgetExceeded: 0,
        payloadBudgetExceededRatePct: 0,
        payloadCharsAvg: 0,
        payloadCharsMax: 0,
        payloadCharsP95: 0,
        payloadSamples: 0,
        payloadTokensAvg: 0,
        timeoutRatePct: 0,
        timeouts: 0,
        timeoutTargetPct: 1,
      },
      readInvocations: 1,
      successfulInvocations: 1,
      successRatePct: 100,
      tools: [
        {
          avgDurationMs: 12,
          calls: 1,
          environmentStatusCounts: { local_fallback: 1 },
          errors: 0,
          p95DurationMs: 12,
          responseStatusCounts: { ok: 1 },
          successes: 1,
          successRatePct: 100,
          toolCategory: 'read',
          toolName: 'memory_orient',
        },
      ],
    },
  });

  const output = renderReport(report);

  assert.ok(output.includes('Memory orient environment probes: local_fallback=1'), 'should render fallback separately');
  assert.ok(
    output.includes('Orient calls: 1 (ok: 1, partial: 0, degraded: 0, errors: 0'),
    'the fallback should preserve the successful memory call',
  );
});

test('renderReport surfaces continuity budget pressure and source quality', () => {
  const report = createMinimalReport({
    database: {
      continuityAdoption: {
        agentWriterCompliancePct: 90,
        agentWriterCompliant: 9,
        agentWriterFlushes: 10,
        auto: {
          contextNeededCarriedForward: 1,
          contextNeededDerived: 3,
          contextNeededNonEmpty: 4,
          nextActionsCarriedForward: 2,
          nextActionsDerived: 4,
          nextActionsNonEmpty: 6,
          openQuestionsCarriedForward: 1,
          openQuestionsDerived: 3,
          openQuestionsNonEmpty: 4,
          snapshots: 8,
        },
        contextNeededNonEmpty: 6,
        flush: {
          contextNeededNonEmpty: 2,
          nextActionsNonEmpty: 2,
          openQuestionsNonEmpty: 2,
          snapshots: 2,
          stateModelPresent: 2,
        },
        nextActionsNonEmpty: 8,
        openQuestionsNonEmpty: 6,
        snapshots: 10,
        stateModelPresent: 2,
      },
      continuityPacks: {
        avgPayloadChars: 4200,
        maxPayloadBudgetPct: 92,
        maxPayloadChars: 5520,
        packs: 2,
        updatedInWindow: 1,
      },
    },
  });

  const output = renderReport(report);

  assert.ok(
    output.includes('Continuity pack budget pressure: max=92.0% of budget (target <= 90.0%, high)'),
    'budget pressure should be visible before packs approach the context budget',
  );
  assert.ok(
    output.includes(
      'Continuity source quality: explicit_flush_snapshots=2/10 (20.0%), auto_hint_snapshots=8/10 (80.0%), derived_or_carry_forward_fields=14/14 (100.0%, informational)',
    ),
    'source quality should make explicit flush vs derived/carry-forward reliance visible',
  );
});

test('renderReport surfaces continuity adoption-readiness supply metrics', () => {
  const output = renderReport(
    createMinimalReport({
      database: {
        continuityReadiness: {
          actionableFieldCompletenessPct: 62.5,
          actionableFieldSlots: 8,
          actionableFieldsPopulated: 5,
          packDegradedReads: 1,
          packFoundReads: 8,
          packMissingReads: 2,
          packReadCalls: 11,
          packsWithActionableFields: 2,
          packsWithContextNeeded: 0,
          packsWithDecisions: 1,
          packsWithNextActions: 2,
          packsWithOpenQuestions: 2,
          sessionsWithFlushAfterPack: 6,
          sessionsWithPackRead: 8,
          totalPacksForFieldCompleteness: 2,
        },
      },
    }),
  );

  assert.ok(
    output.includes('Continuity adoption readiness: pack_reads=11 found=8 missing=2 degraded=1 found_rate=72.7%'),
    'readiness line should separate found, missing, and degraded continuity-pack reads',
  );
  assert.ok(
    output.includes(
      'Continuity actionable-field completeness: populated_fields=5/8 (62.5%), packs_with_any_actionable=2/2 (100.0%)',
    ),
    'field completeness line should label deterministic supply completeness, not consumption proof',
  );
  assert.ok(
    output.includes('Continuity flush-after-pack: sessions=8 flush_after_pack=6 (75.0%, readiness signal)'),
    'flush-after-pack line should show a session-boundary readiness rate',
  );
});

test('renderReport surfaces channel-split state-model launch gates as text lines', () => {
  // Renders the new launch gates side-by-side: the explicit-flush state-model gate
  // and the informational auto-channel gate must both appear in the human-readable
  // section, not only in the JSON payload. This is the rendered-text regression
  // guard for the low-adoption contract.
  const report = createMinimalReport({
    database: {
      continuityAdoption: {
        auto: {
          envModelPresent: 870,
          nextActionsNonEmpty: 250,
          openQuestionsNonEmpty: 220,
          snapshots: 972,
          stateModelPresent: 0,
        },
        envModelPresent: 1142,
        flush: {
          envModelPresent: 270,
          nextActionsNonEmpty: 290,
          openQuestionsNonEmpty: 280,
          snapshots: 292,
          stateModelPresent: 292,
        },
        nextActionsNonEmpty: 540,
        openQuestionsNonEmpty: 500,
        snapshots: 1264,
        stateModelPresent: 292,
      },
    },
  });

  const output = renderReport(report);

  assert.ok(
    output.includes(
      'Explicit-flush x_state_model coverage: 100.0% over 292 explicit-flush snapshots (target: >= 90.0%, on-target).',
    ),
    'should render explicit-flush state-model coverage with on-target status when flush coverage is high',
  );
  assert.ok(
    output.includes(
      'Auto-channel x_state_model coverage (carry-forward only, informational): 0.0% over 972 auto snapshots (reference floor: >= 25.0%, informational).',
    ),
    'auto-channel line must render as informational and must never emit a blocking gate-status word (failing/warning/on-target)',
  );
  assert.ok(
    !/Auto-channel.*(target:|failing|warning|on-target)\)\./.test(output),
    'auto-channel rendered line must not surface blocking-gate verbiage (target:, failing, warning, on-target)',
  );
});

test('renderReport labels blocking vs informational continuity signals consistently', () => {
  // Same shape as a mixed-channel scenario: explicit channel healthy,
  // auto channel at 0%. The blocking continuity gates must surface a gate-status word
  // (on-target/warning/failing) while the informational auto-channel gate must surface
  // "informational" — operators reading the report should not have to know the gate
  // taxonomy to spot which signals are launch blockers.
  const report = createMinimalReport({
    database: {
      continuityAdoption: {
        agentWriterCompliancePct: 100,
        agentWriterCompliant: 78,
        agentWriterFlushes: 78,
        auto: {
          envModelPresent: 200,
          nextActionsNonEmpty: 0,
          openQuestionsNonEmpty: 0,
          snapshots: 202,
          stateModelPresent: 0,
        },
        envModelPresent: 200,
        flush: {
          envModelPresent: 78,
          nextActionsNonEmpty: 78,
          openQuestionsNonEmpty: 65,
          snapshots: 78,
          stateModelPresent: 78,
        },
        nextActionsNonEmpty: 78,
        openQuestionsNonEmpty: 65,
        snapshots: 280,
        stateModelPresent: 78,
      },
    },
  });

  const output = renderReport(report);

  // Blocking continuity lines carry a gate-status word.
  assert.ok(
    output.includes(
      'Continuity payload completeness: 100.0% over 78 agent-writer memory_flush calls (target: >= 95.0%, on-target)',
    ),
    'blocking continuity payload completeness line must carry on-target/warning/failing status',
  );
  assert.ok(
    output.includes(
      'Explicit-flush x_state_model coverage: 100.0% over 78 explicit-flush snapshots (target: >= 90.0%, on-target)',
    ),
    'blocking explicit-flush x_state_model coverage line must carry on-target/warning/failing status',
  );

  // Informational continuity line replaces the gate-status word with `informational`
  // and uses "reference floor" instead of "target", so operators cannot mistake it for
  // a launch blocker.
  assert.ok(
    output.includes(
      'Auto-channel x_state_model coverage (carry-forward only, informational): 0.0% over 202 auto snapshots (reference floor: >= 25.0%, informational).',
    ),
    'informational auto-channel line must render as informational with reference-floor wording',
  );
});

test('renderReport summarizes agent-writer continuity payload completeness', () => {
  const report = createMinimalReport({
    database: {
      continuityAdoption: {
        agentWriterCompliancePct: 95,
        agentWriterCompliant: 19,
        agentWriterFlushes: 20,
        envModelPresent: 2,
        nextActionsNonEmpty: 7,
        openQuestionsNonEmpty: 4,
        snapshots: 10,
        stateModelPresent: 6,
      },
    },
  });

  const output = renderReport(report);

  assert.ok(
    output.includes(
      'Continuity payload completeness: 95.0% over 20 agent-writer memory_flush calls (target: >= 95.0%, on-target)',
    ),
    'should show the new agent-writer continuity completeness line',
  );
  assert.ok(!output.includes('Session continuity next_actions:'), 'old per-field launch gates should not render');
  assert.ok(!output.includes('Session continuity open_questions:'), 'old per-field launch gates should not render');
  assert.ok(!output.includes('Session continuity x_state_model:'), 'old per-field launch gates should not render');
});

test('renderReport includes Reflect section with cycle and skip metrics', () => {
  const report = createMinimalReport({
    database: {
      reflect: {
        cyclesInWindow: 1,
        evaluationsSinceLastCycle: 50,
        lastCycleIso: '2026-04-26T12:00:00.000Z',
        provisionalMethodologyMemoriesWritten: 2,
        recentCycles: [
          {
            completedAt: '2026-04-26T12:00:00.000Z',
            cycleId: 'cycle-b',
            evaluationCountAtReflection: 461,
            provisionalMethodologyMemoriesWritten: 1,
            skippedTargets: ['skip:reference-fetch-failed:3a'],
            triggeredBy: 'count-threshold',
          },
        ],
      },
    },
  });

  const output = renderReport(report);

  assert.ok(output.includes('Reflect'), 'should contain Reflect header');
  assert.ok(output.includes('Cycles in window: 1'), 'should show cycle count');
  assert.ok(output.includes('Last cycle: 2026-04-26T12:00:00.000Z'), 'should show last cycle');
  assert.ok(output.includes('Evaluations since last cycle: 50'), 'should show evaluations since last cycle');
  assert.ok(output.includes('Provisional methodology memories written: 2'), 'should show provisional count');
  assert.ok(output.includes('skips=skip:reference-fetch-failed:3a'), 'should show skipped targets');
});

// --- renderReport resume resolution ---

test('renderReport includes resume resolution breakdown', () => {
  const report = createMinimalReport({
    mcpUsage: {
      dedupeSuppressed: 0,
      errors: 0,
      invocations: 5,
      logFile: '/dev/null',
      orient: {
        calls: 0,
        degraded: 0,
        errors: 0,
        ok: 0,
        partial: 0,
        timeoutRatePct: 0,
        timeouts: 0,
        timeoutTargetPct: 1,
      },
      readInvocations: 5,
      resume: {
        calls: 10,
        errors: 1,
        notFound: 3,
        ok: 6,
        okDirect: 4,
        okFallback: 2,
      },
      successfulInvocations: 5,
      successRatePct: 100,
      tools: [],
      toolTelemetryCoverage: 'full',
      writeInvocations: 0,
    },
  });

  const output = renderReport(report);

  assert.ok(output.includes('Session resume calls: 10'), 'should contain total resume calls');
  assert.ok(output.includes('ok: 6'), 'should contain ok count');
  assert.ok(output.includes('direct: 4'), 'should contain direct count');
  assert.ok(output.includes('fallback: 2'), 'should contain fallback count');
  assert.ok(output.includes('not_found: 3'), 'should contain not_found count');
  assert.ok(output.includes('errors: 1'), 'should contain errors count');
});

test('renderReport includes orient status breakdown', () => {
  const report = createMinimalReport({
    mcpUsage: {
      dedupeSuppressed: 0,
      errors: 1,
      invocations: 8,
      logFile: '/dev/null',
      orient: {
        calls: 5,
        degraded: 1,
        errors: 1,
        ok: 2,
        partial: 1,
        payloadBudgetChars: 8000,
        payloadBudgetExceeded: 1,
        payloadBudgetExceededRatePct: 20,
        payloadCharsAvg: 6000,
        payloadCharsMax: 8300,
        payloadCharsP95: 8100,
        payloadSamples: 5,
        payloadTokensAvg: 1500,
        timeoutRatePct: 20,
        timeouts: 1,
        timeoutTargetPct: 1,
      },
      readInvocations: 6,
      resume: {
        calls: 1,
        errors: 0,
        notFound: 0,
        ok: 1,
        okDirect: 1,
        okFallback: 0,
      },
      successfulInvocations: 7,
      successRatePct: 87.5,
      tools: [],
      toolTelemetryCoverage: 'full',
      writeInvocations: 2,
    },
  });

  const output = renderReport(report);

  assert.ok(output.includes('Orient calls: 5'), 'should contain orient call count');
  assert.ok(output.includes('ok: 2'), 'should contain orient ok count');
  assert.ok(output.includes('partial: 1'), 'should contain orient partial count');
  assert.ok(output.includes('degraded: 1'), 'should contain orient degraded count');
  assert.ok(output.includes('errors: 1'), 'should contain orient error count');
  assert.ok(output.includes('timeouts: 1'), 'should contain orient timeout count');
  assert.ok(output.includes('timeout rate: 20.0%'), 'should contain orient timeout rate');
  assert.ok(output.includes('target <1.0%'), 'should contain orient timeout target');
  assert.ok(output.includes('budgetExceededRate=20.0%'), 'should contain orient budget exceeded rate');
  assert.ok(output.includes('p95PayloadChars=8100.0'), 'should contain orient p95 payload chars');
  assert.ok(output.includes('maxPayloadChars=8300.0'), 'should contain orient max payload chars');
});

test('renderReport includes MCP log source', () => {
  const report = createMinimalReport({
    mcpUsage: {
      logFileSource: 'repo_root',
    },
  });

  const output = renderReport(report);

  assert.ok(output.includes('Log file source: repo_root'), 'should expose log file source');
});

// --- renderReport retention ---

test('renderReport includes retention config summary', () => {
  const report = createMinimalReport();

  const output = renderReport(report);

  assert.ok(output.includes('Retention'), 'should contain Retention header');
  assert.ok(output.includes('Active config:'), 'should contain config line');
  assert.ok(output.includes('sessions=90d'), 'should contain session days');
  assert.ok(output.includes('failures=30d'), 'should contain failure days');
  assert.ok(output.includes('batch=1000'), 'should contain batch size');
});

test('renderReport shows zero backlog when no purge-eligible rows', () => {
  const report = createMinimalReport();

  const output = renderReport(report);

  assert.ok(output.includes('Total purge-eligible backlog: 0 rows'), 'should show zero backlog');
});

test('renderReport lists non-zero backlog entries with date ranges', () => {
  const report = createMinimalReport({
    retention: {
      backlog: [
        {
          candidates: 15,
          dataset: 'ai_ingestion_failures',
          newestCreatedAt: '2025-12-15T00:00:00Z',
          oldestCreatedAt: '2025-10-01T00:00:00Z',
        },
        { candidates: 0, dataset: 'ai_sessions' },
        {
          candidates: 7,
          dataset: 'ai_memory_entries (expired session-summaries)',
          newestCreatedAt: '2025-12-28T00:00:00Z',
          oldestCreatedAt: '2025-12-01T00:00:00Z',
        },
      ],
      config: {
        auditDays: 180,
        batchSize: 1000,
        expiredGraceDays: 30,
        failureDays: 30,
        sessionDays: 90,
        supersededDays: 180,
      },
      lastRun: null,
      totalBacklog: 22,
    },
  });

  const output = renderReport(report);

  assert.ok(output.includes('Total purge-eligible backlog: 22 rows'), 'should show total backlog');
  assert.ok(
    output.includes('ai_ingestion_failures: 15 rows (2025-10-01T00:00:00Z to 2025-12-15T00:00:00Z)'),
    'should show failures with date range',
  );
  assert.ok(!output.includes('ai_sessions: 0'), 'should omit zero-candidate entries');
  assert.ok(
    output.includes('ai_memory_entries (expired session-summaries): 7 rows'),
    'should show expired session-summaries',
  );
});

test('renderReport shows last retention run when present', () => {
  const report = createMinimalReport({
    retention: {
      backlog: [],
      config: {
        auditDays: 180,
        batchSize: 1000,
        expiredGraceDays: 30,
        failureDays: 30,
        sessionDays: 90,
        supersededDays: 180,
      },
      lastRun: {
        dryRun: true,
        durationMs: 1234,
        errorCount: 0,
        status: 'ok',
        timestamp: '2026-01-14T10:00:00.000Z',
        totalCandidates: 42,
        totalDeleted: 0,
      },
      totalBacklog: 0,
    },
  });

  const output = renderReport(report);

  assert.ok(output.includes('Last retention run: 2026-01-14T10:00:00.000Z'), 'should show timestamp');
  assert.ok(output.includes('status=ok'), 'should show status');
  assert.ok(output.includes('dryRun=true'), 'should show dryRun');
  assert.ok(output.includes('candidates=42'), 'should show candidates');
  assert.ok(output.includes('deleted=0'), 'should show deleted');
  assert.ok(output.includes('duration=1234ms'), 'should show duration');
});

test('renderReport shows no-run message when lastRun is null', () => {
  const report = createMinimalReport();

  const output = renderReport(report);

  assert.ok(output.includes('Last retention run: (none recorded)'), 'should show none recorded');
});

// --- renderReport legacy pattern mining ---

test('renderReport ignores legacy Pattern Mining data', () => {
  const report = {
    ...createMinimalReport(),
    ['pattern' + 'Mining']: {
      beliefsPromoted: 2,
      clustersFound: 5,
      lastRunTimestamp: '2026-02-22T18:00:00.000Z',
      trendsExtracted: 4,
    },
  };

  const output = renderReport(report);

  assert.ok(!output.includes('Pattern Mining'), 'should not include section heading');
  assert.ok(!output.includes('Clusters found: 5'), 'should not include cluster count');
  assert.ok(!output.includes('Trends extracted: 4'), 'should not include trend count');
  assert.ok(!output.includes('Beliefs promoted: 2'), 'should not include promotion count');
  assert.ok(!output.includes('Last run: 2026-02-22T18:00:00.000Z'), 'should not include timestamp');
});

test('renderReport omits Pattern Mining section when no run exists', () => {
  const report = createMinimalReport();

  const output = renderReport(report);

  assert.ok(!output.includes('Pattern Mining'), 'should not include section heading');
});

// --- evaluateWriterParticipation ---

test('evaluateWriterParticipation returns healthy when single source', () => {
  const result = evaluateWriterParticipation([{ count: 10, pct: 100, source: SOURCE_CLAUDE_CODE }], 10);
  assert.equal(result.healthy, true);
  assert.equal(result.belowThreshold.length, 0);
  assert.equal(result.totalSources, 1);
  assert.equal(result.families.length, 1);
  assert.equal(result.families[0]?.family, 'claude');
});

test('evaluateWriterParticipation groups multi-source mixes into families and stays healthy', () => {
  const result = evaluateWriterParticipation(
    [
      { count: 6, pct: 60, source: SOURCE_CLAUDE_CODE },
      { count: 4, pct: 40, source: 'codex' },
    ],
    10,
  );
  assert.equal(result.healthy, true);
  assert.equal(result.belowThreshold.length, 0);
  assert.equal(result.totalSources, 2);
  assert.equal(result.totalWrites, 10);
  const familyNames = result.families.map(f => f.family).sort((a, b) => a.localeCompare(b));
  assert.deepEqual(familyNames, ['claude', 'codex']);
});

test('evaluateWriterParticipation aggregates many raw sources from the same family', () => {
  // Real-world shape: codex has 4 distinct raw labels (codex-wrapper, codex-launchd, codex-hook,
  // codex). At a per-source 20% min they would all be flagged LOW even with healthy total
  // participation; at the per-family 10% min the codex family alone clears the bar.
  const result = evaluateWriterParticipation(
    [
      { count: 600, pct: 60, source: SOURCE_CLAUDE_CODE },
      { count: 100, pct: 10, source: 'codex-wrapper' },
      { count: 100, pct: 10, source: 'codex-launchd' },
      { count: 100, pct: 10, source: 'codex-hook' },
      { count: 100, pct: 10, source: 'codex' },
    ],
    1000,
  );
  assert.equal(result.healthy, true, 'codex family clears feasible 10% per-family threshold');
  assert.equal(result.belowThreshold.length, 0);
  assert.equal(result.totalSources, 5);
  const codexFamily = result.families.find(f => f.family === 'codex');
  assert.ok(codexFamily !== undefined, 'codex family must be present');
  assert.equal(codexFamily.writes, 400);
  assert.equal(codexFamily.pct, 40);
  assert.deepEqual(codexFamily.sources, ['codex', 'codex-hook', 'codex-launchd', 'codex-wrapper']);
});

test('evaluateWriterParticipation flags a family below the per-family threshold', () => {
  // Two families: claude dominates, system family gets a single trickle write.
  const result = evaluateWriterParticipation(
    [
      { count: 95, pct: 95, source: SOURCE_CLAUDE_CODE },
      { count: 5, pct: 5, source: 'background-worker' },
    ],
    100,
  );
  assert.equal(result.healthy, false);
  assert.equal(result.belowThreshold.length, 1);
  const flag = result.belowThreshold[0];
  assert.ok(flag !== undefined, 'should have a flag');
  assert.equal(flag.family, 'system');
  assert.equal(flag.actualPct, 5);
  assert.equal(flag.writes, 5);
});

test('evaluateWriterParticipation returns healthy for zero writes', () => {
  const result = evaluateWriterParticipation([], 0);
  assert.equal(result.healthy, true);
  assert.equal(result.totalWrites, 0);
  assert.equal(result.families.length, 0);
});

test('evaluateWriterParticipation maps unknown sources to the other family', () => {
  const result = evaluateWriterParticipation(
    [
      { count: 50, pct: 50, source: SOURCE_CLAUDE_CODE },
      { count: 50, pct: 50, source: 'someone-elses-tool-2026' },
    ],
    100,
  );
  assert.equal(result.families.find(f => f.family === 'other')?.writes, 50);
});

test('evaluateWriterParticipation produces feasible threshold at 15-source cardinality', () => {
  // Regression: the previous flat 20% per-source threshold is mathematically infeasible
  // at 15 sources (max possible average share = 6.67%). The per-family threshold groups
  // these into ≤ 5 stable buckets so the gate has a feasible denominator. Real-world
  // shape sampled from a recent report: even when one family (manual) is below 10%, only
  // that single family is flagged — the old gate flagged 14 of 15 raw sources.
  const writerMix = [
    { count: 320, pct: 0, source: 'claude-code' },
    { count: 210, pct: 0, source: 'claude-session-end' },
    { count: 180, pct: 0, source: 'codex' },
    { count: 160, pct: 0, source: 'codex-wrapper' },
    { count: 120, pct: 0, source: 'codex-launchd' },
    { count: 90, pct: 0, source: 'codex-hook' },
    { count: 80, pct: 0, source: 'codex-retro' },
    { count: 70, pct: 0, source: 'background-worker' },
    { count: 60, pct: 0, source: 'retro' },
    { count: 50, pct: 0, source: 'retention' },
    { count: 40, pct: 0, source: 'manual' },
    { count: 30, pct: 0, source: 'manual-flush' },
    { count: 25, pct: 0, source: 'memory-flush' },
    { count: 20, pct: 0, source: 'sample-job-builder' },
    { count: 12, pct: 0, source: 'agent' },
  ];
  const total = writerMix.reduce((sum, e) => sum + e.count, 0);

  const result = evaluateWriterParticipation(writerMix, total);

  assert.equal(result.totalSources, 15);
  assert.ok(result.families.length <= 5, 'families must collapse to ≤ 5 stable buckets');

  // The old gate would have flagged 14 raw sources as LOW (every source whose share is
  // below 20%). The new gate flags at most one — the single starved family — and never
  // produces an impossible-by-arithmetic LOW set.
  assert.ok(
    result.belowThreshold.length <= 1,
    `family gate must not flag more than one family in this shape, got ${String(result.belowThreshold.length)}`,
  );

  // Every flagged item is a family (not a raw source), and its share is genuinely below
  // the per-family floor.
  for (const flag of result.belowThreshold) {
    assert.ok(flag.actualPct < result.minPct, 'flagged families must actually be below threshold');
    assert.ok(
      ['claude', 'codex', 'manual', 'other', 'system'].includes(flag.family),
      `flag must reference a stable family name, got ${flag.family}`,
    );
  }
});

// --- renderReport writer participation health ---

test('renderReport shows writer participation health when multiple sources', () => {
  const report = createMinimalReport({
    database: {
      contextPacksIngested: 0,
      databaseUrl: TEST_DATABASE_URL,
      deltasIngested: 0,
      deltaSourceMix: [],
      durableMemoriesCreated: 10,
      durableMemoriesUpdated: 0,
      durableWriterMix: [
        { count: 6, pct: 60, source: SOURCE_CLAUDE_CODE },
        { count: 4, pct: 40, source: 'codex' },
      ],
      failuresBySource: [],
      ingestionFailures: 0,
      mttr: { avgMinutes: 0, resolved: 0, total: 0, unresolved: 0 },
      sessionEndConflictRate14d: {
        conflictCount: 0,
        ratePct: 0,
        targetMet: true,
        targetPct: 1,
        windowDays: 14,
        writeCount: 0,
      },
      sessionsStarted: 0,
      taxonomyDistribution: EMPTY_TAXONOMY_DISTRIBUTION,
      writerParticipationHealth: {
        belowThreshold: [],
        families: [
          { family: 'claude', pct: 60, sources: [SOURCE_CLAUDE_CODE], writes: 6 },
          { family: 'codex', pct: 40, sources: ['codex'], writes: 4 },
        ],
        healthy: true,
        minPct: 10,
        totalSources: 2,
        totalWrites: 10,
      },
    },
  });

  const output = renderReport(report);

  assert.ok(output.includes('Writer participation: healthy'), 'should show healthy status');
  assert.ok(output.includes('2 sources'), 'should show source count');
  assert.ok(output.includes('10 writes'), 'should show write count');
});

test('renderReport shows LOW flags for below-threshold sources', () => {
  const report = createMinimalReport({
    database: {
      contextPacksIngested: 0,
      databaseUrl: TEST_DATABASE_URL,
      deltasIngested: 0,
      deltaSourceMix: [],
      durableMemoriesCreated: 10,
      durableMemoriesUpdated: 0,
      durableWriterMix: [
        { count: 9, pct: 90, source: SOURCE_CLAUDE_CODE },
        { count: 1, pct: 10, source: 'codex' },
      ],
      failuresBySource: [],
      ingestionFailures: 0,
      mttr: { avgMinutes: 0, resolved: 0, total: 0, unresolved: 0 },
      sessionEndConflictRate14d: {
        conflictCount: 0,
        ratePct: 0,
        targetMet: true,
        targetPct: 1,
        windowDays: 14,
        writeCount: 0,
      },
      sessionsStarted: 0,
      taxonomyDistribution: EMPTY_TAXONOMY_DISTRIBUTION,
      writerParticipationHealth: {
        belowThreshold: [{ actualPct: 5, family: 'codex', writes: 5 }],
        families: [
          { family: 'claude', pct: 95, sources: [SOURCE_CLAUDE_CODE], writes: 95 },
          { family: 'codex', pct: 5, sources: ['codex'], writes: 5 },
        ],
        healthy: false,
        minPct: 10,
        totalSources: 2,
        totalWrites: 100,
      },
    },
  });

  const output = renderReport(report);

  assert.ok(output.includes('Writer participation: imbalanced'), 'should show imbalanced status');
  assert.ok(output.includes('LOW: family codex at 5.0%'), 'should flag codex family as below-threshold');
  assert.ok(output.includes('per-family min 10%'), 'should announce per-family threshold');
  assert.ok(output.includes('2 families across 2 sources'), 'should report both families and sources');
});

test('renderReport omits writer participation section for single source', () => {
  const report = createMinimalReport({
    database: {
      contextPacksIngested: 0,
      databaseUrl: TEST_DATABASE_URL,
      deltasIngested: 0,
      deltaSourceMix: [],
      durableMemoriesCreated: 5,
      durableMemoriesUpdated: 0,
      durableWriterMix: [{ count: 5, pct: 100, source: SOURCE_CLAUDE_CODE }],
      failuresBySource: [],
      ingestionFailures: 0,
      mttr: { avgMinutes: 0, resolved: 0, total: 0, unresolved: 0 },
      sessionEndConflictRate14d: {
        conflictCount: 0,
        ratePct: 0,
        targetMet: true,
        targetPct: 1,
        windowDays: 14,
        writeCount: 0,
      },
      sessionsStarted: 0,
      taxonomyDistribution: EMPTY_TAXONOMY_DISTRIBUTION,
      writerParticipationHealth: {
        belowThreshold: [],
        families: [{ family: 'claude', pct: 100, sources: [SOURCE_CLAUDE_CODE], writes: 5 }],
        healthy: true,
        minPct: 10,
        totalSources: 1,
        totalWrites: 5,
      },
    },
  });

  const output = renderReport(report);

  assert.ok(!output.includes('Writer participation:'), 'should not show participation section for single source');
});

// --- buildTaxonomyDistribution ---

test('buildTaxonomyDistribution groups categories into tiers', () => {
  const result = buildTaxonomyDistribution([
    { category: 'convention', count: 5 },
    { category: 'architecture', count: 3 },
    { category: 'session-summary', count: 10 },
    { category: 'implementation-note', count: 2 },
    { category: 'decision', count: 1 },
  ]);

  const actionable = result.find(r => r.tier === 'actionable');
  const contextual = result.find(r => r.tier === 'contextual');
  const lowSignal = result.find(r => r.tier === LOW_SIGNAL_TIER);

  assert.ok(actionable !== undefined);
  assert.ok(contextual !== undefined);
  assert.ok(lowSignal !== undefined);
  assert.equal(actionable.count, 9, 'actionable = convention(5) + architecture(3) + decision(1)');
  assert.equal(contextual.count, 2, 'contextual = implementation-note(2)');
  assert.equal(lowSignal.count, 10, 'low-signal = session-summary(10)');
});

test('buildTaxonomyDistribution defaults unknown categories to contextual', () => {
  const result = buildTaxonomyDistribution([
    { category: 'unknown-type', count: 3 },
    { category: '(uncategorized)', count: 2 },
  ]);

  const contextual = result.find(r => r.tier === 'contextual');
  assert.ok(contextual !== undefined);
  assert.equal(contextual.count, 5, 'unknown categories default to contextual');
});

test('buildTaxonomyDistribution returns all three tiers even when empty', () => {
  const result = buildTaxonomyDistribution([]);
  assert.equal(result.length, 3);
  assert.ok(result.every(r => r.count === 0));
});

test('buildTaxonomyDistribution computes correct percentages', () => {
  const result = buildTaxonomyDistribution([
    { category: 'convention', count: 50 },
    { category: 'session-summary', count: 50 },
  ]);

  const actionable = result.find(r => r.tier === 'actionable');
  const lowSignal = result.find(r => r.tier === LOW_SIGNAL_TIER);
  assert.ok(actionable !== undefined);
  assert.ok(lowSignal !== undefined);
  assert.equal(actionable.pct, 50);
  assert.equal(lowSignal.pct, 50);
});

// --- renderReport taxonomy distribution ---

test('renderReport includes taxonomy distribution section', () => {
  const report = createMinimalReport({
    database: {
      contextPacksIngested: 0,
      databaseUrl: TEST_DATABASE_URL,
      deltasIngested: 0,
      deltaSourceMix: [],
      durableMemoriesCreated: 0,
      durableMemoriesUpdated: 0,
      durableWriterMix: [],
      failuresBySource: [],
      ingestionFailures: 0,
      mttr: { avgMinutes: 0, resolved: 0, total: 0, unresolved: 0 },
      sessionEndConflictRate14d: {
        conflictCount: 0,
        ratePct: 0,
        targetMet: true,
        targetPct: 1,
        windowDays: 14,
        writeCount: 0,
      },
      sessionsStarted: 0,
      taxonomyDistribution: [
        { count: 15, pct: 50, tier: 'actionable' },
        { count: 5, pct: 16.7, tier: 'contextual' },
        { count: 10, pct: 33.3, tier: LOW_SIGNAL_TIER },
      ],
      writerParticipationHealth: {
        belowThreshold: [],
        families: [],
        healthy: true,
        minPct: 10,
        totalSources: 0,
        totalWrites: 0,
      },
    },
  });

  const output = renderReport(report);

  assert.ok(output.includes('Taxonomy distribution (30 active memories):'), 'should show taxonomy header with total');
  assert.ok(output.includes('actionable: 15 (50.0%)'), 'should show actionable tier');
  assert.ok(output.includes('contextual: 5 (16.7%)'), 'should show contextual tier');
  assert.ok(output.includes('low-signal: 10 (33.3%)'), 'should show low-signal tier');
});

// --- renderReport outcome signals ---

test('renderReport includes repeated-fix table when repeated-fix data exists', () => {
  const report = createMinimalReport({
    database: {
      repeatedFixRate: [
        {
          count: 4,
          memoryIds: [101, 102, 103, 104],
          module: 'packages/ai-memory',
        },
        { count: 3, memoryIds: [201, 202, 203], module: 'apps/mobile' },
      ],
    },
  });

  const output = renderReport(report);

  assert.ok(output.includes('Repeated-fix hotspots (30d, threshold >=3):'), 'should show repeated-fix heading');
  assert.ok(
    output.includes('packages/ai-memory: 4 memories (ids: 101, 102, 103, 104)'),
    'should render first repeated-fix row',
  );
  assert.ok(output.includes('apps/mobile: 3 memories (ids: 201, 202, 203)'), 'should render second repeated-fix row');
});

test('renderReport shows no repeated-fix signals when repeated-fix data is empty', () => {
  const report = createMinimalReport({
    database: {
      repeatedFixRate: [],
    },
  });

  const output = renderReport(report);

  assert.ok(output.includes('No repeated-fix signals'), 'should render empty repeated-fix message');
});

test('renderReport includes decision-reversal rate and per-category breakdown', () => {
  const report = createMinimalReport({
    database: {
      decisionReversalRate: {
        byCategory: [
          { category: 'decision', count: 2, denominator: 10, rate: 0.2 },
          { category: 'architecture', count: 1, denominator: 5, rate: 0.2 },
          { category: 'convention', count: 0, denominator: 8, rate: 0 },
        ],
        count: 3,
        denominator: 23,
        rate: 0.1304,
      },
    },
  });

  const output = renderReport(report);

  assert.ok(output.includes('Decision-reversal rate (14d): 3/23'), 'should render decision-reversal summary');
  assert.ok(output.includes('Decision-reversal breakdown:'), 'should render breakdown heading');
  assert.ok(output.includes('decision: 2/10 (ratio=0.2000, pct=20.0%)'), 'should render decision row');
  assert.ok(output.includes('architecture: 1/5 (ratio=0.2000, pct=20.0%)'), 'should render architecture row');
  assert.ok(output.includes('convention: 0/8 (ratio=0.0000, pct=0.0%)'), 'should render convention row');
});

test('renderReport includes calibration metrics when sufficient calibration data exists', () => {
  const report = createMinimalReport({
    database: {
      calibration: {
        assessment: 'well-calibrated',
        brierScore: 0.12,
        ece: {
          bins: [
            {
              avgActual: 0.2,
              avgPredicted: 0.25,
              count: 4,
              error: 0.0167,
              range: '[0, 0.4)',
            },
            {
              avgActual: 0.5,
              avgPredicted: 0.55,
              count: 3,
              error: 0.0125,
              range: '[0.4, 0.7)',
            },
            {
              avgActual: 0.9,
              avgPredicted: 0.85,
              count: 5,
              error: 0.0208,
              range: '[0.7, 1.0]',
            },
          ],
          ece: 0.05,
        },
        signalCount: 12,
      },
    },
  });

  const output = renderReport(report);

  assert.ok(output.includes('Calibration signals: 12'), 'should render calibration signal count');
  assert.ok(output.includes('Calibration Brier score: 0.1200'), 'should render Brier score');
  assert.ok(output.includes('Calibration ECE: 0.0500'), 'should render ECE');
  assert.ok(output.includes('Calibration assessment: well-calibrated'), 'should render assessment');
  assert.ok(output.includes('Calibration bins:'), 'should render calibration bins heading');
  assert.ok(
    output.includes('[0.7, 1.0]: count=5 avgPredicted=0.8500 avgActual=0.9000 error=0.0208'),
    'should render high-confidence bin metrics',
  );
});

test('renderReport shows insufficient calibration data message when fewer than 10 signals exist', () => {
  const report = createMinimalReport({
    database: {
      calibration: {
        assessment: null,
        brierScore: null,
        ece: null,
        signalCount: 5,
      },
    },
  });

  const output = renderReport(report);

  assert.ok(output.includes('Calibration signals: 5'), 'should render calibration signal count');
  assert.ok(output.includes('Insufficient calibration data (5 signals, need 10+)'), 'should render threshold message');
});

test('renderReport omits calibration subsection when no calibration signals exist', () => {
  const report = createMinimalReport({
    database: {
      calibration: {
        assessment: null,
        brierScore: null,
        ece: null,
        signalCount: 0,
      },
    },
  });

  const output = renderReport(report);

  assert.ok(!output.includes('Calibration signals:'), 'should omit calibration subsection when no signals exist');
});

test('renderReport snapshot includes Outcome Signals heading', () => {
  const report = createMinimalReport();

  const output = renderReport(report);

  assert.ok(output.includes('Outcome Signals'), 'snapshot should include Outcome Signals heading');
});

test('renderReport includes post-A0 launch gate baseline wording with no-data observed lines', () => {
  const report = createMinimalReport();

  const output = renderReport(report);

  assert.ok(output.includes('Launch Gates (Post-A0 Baseline)'), 'should include launch gate heading');
  assert.ok(output.includes('measured after A0 merge'), 'should mention post-A0 baseline');
  assert.ok(
    output.includes('memory_flush reliability: no flush calls in window (target: >= 99.0%).'),
    'should include flush no-data line',
  );
  assert.ok(
    output.includes('Timeout/degradation rate: no orient calls in window (target: < 1.0%).'),
    'should include timeout/degradation no-data line',
  );
  assert.ok(
    output.includes('memory_type NULL rate: no new entries in window (target: = 0.0%).'),
    'should include NULL rate no-data line',
  );
  assert.ok(
    output.includes('Contested resolution latency: no samples in window (target: p95 < 300ms).'),
    'should include contested latency no-data line',
  );
  assert.ok(
    output.includes(
      'Continuity payload completeness: no agent-writer memory_flush calls in window (target: >= 95.0%).',
    ),
    'should include continuity payload no-data line',
  );
  assert.ok(
    output.includes('Explicit-flush x_state_model coverage: no explicit-flush snapshots in window (target: >= 90.0%).'),
    'should render the explicit-flush x_state_model launch gate even in no-data state',
  );
  assert.ok(
    output.includes(
      'Auto-channel x_state_model coverage (carry-forward only, informational): no auto snapshots in window (reference floor: >= 25.0%).',
    ),
    'should render the auto-channel x_state_model launch gate even in no-data state, labeled as a reference floor (no gate-status word)',
  );
});

test('renderReport surfaces contested latency observed value, sample gate, and status from tool telemetry', () => {
  const report = createMinimalReport({
    mcpUsage: {
      tools: [
        {
          avgDurationMs: 31.2,
          calls: 1200,
          errors: 0,
          p95DurationMs: 180.3,
          successes: 1200,
          successRatePct: 100,
          toolCategory: 'write',
          toolName: 'memory_resolve_contested',
        },
      ],
    },
  });

  const output = renderReport(report);

  assert.ok(
    output.includes(
      'Contested resolution latency: p95=180.3ms over 1200 calls (sample gate met: 1000+, target: p95 < 300ms, on-target).',
    ),
    'should include full contested line with observed p95, sample gate, target, and status',
  );
});

// --- evaluateLaunchGateStatus boundary tests ---

test('evaluateLaunchGateStatus min direction: at onTarget boundary → on-target', () => {
  const threshold = LAUNCH_GATE_THRESHOLDS.flushSuccessRatePct; // min, onTarget=99, warning=95
  assert.equal(evaluateLaunchGateStatus(99, threshold), 'on-target');
});

test('evaluateLaunchGateStatus min direction: above onTarget → on-target', () => {
  const threshold = LAUNCH_GATE_THRESHOLDS.flushSuccessRatePct;
  assert.equal(evaluateLaunchGateStatus(100, threshold), 'on-target');
});

test('evaluateLaunchGateStatus min direction: just below onTarget → warning', () => {
  const threshold = LAUNCH_GATE_THRESHOLDS.flushSuccessRatePct;
  assert.equal(evaluateLaunchGateStatus(98.9, threshold), 'warning');
});

test('evaluateLaunchGateStatus min direction: at warning boundary → warning', () => {
  const threshold = LAUNCH_GATE_THRESHOLDS.flushSuccessRatePct;
  assert.equal(evaluateLaunchGateStatus(95, threshold), 'warning');
});

test('evaluateLaunchGateStatus min direction: just below warning → failing', () => {
  const threshold = LAUNCH_GATE_THRESHOLDS.flushSuccessRatePct;
  assert.equal(evaluateLaunchGateStatus(94.9, threshold), 'failing');
});

test('evaluateLaunchGateStatus max direction: just below onTarget → on-target', () => {
  const threshold = LAUNCH_GATE_THRESHOLDS.timeoutDegradationRatePct; // max, onTarget=1, warning=5
  assert.equal(evaluateLaunchGateStatus(0.9, threshold), 'on-target');
});

test('evaluateLaunchGateStatus max direction: at onTarget boundary → warning', () => {
  const threshold = LAUNCH_GATE_THRESHOLDS.timeoutDegradationRatePct;
  assert.equal(evaluateLaunchGateStatus(1, threshold), 'warning');
});

test('evaluateLaunchGateStatus max direction: just below warning boundary → warning', () => {
  const threshold = LAUNCH_GATE_THRESHOLDS.timeoutDegradationRatePct;
  assert.equal(evaluateLaunchGateStatus(4.9, threshold), 'warning');
});

test('evaluateLaunchGateStatus max direction: at warning boundary → failing', () => {
  const threshold = LAUNCH_GATE_THRESHOLDS.timeoutDegradationRatePct;
  assert.equal(evaluateLaunchGateStatus(5, threshold), 'failing');
});

// --- computeLaunchGates unit tests ---

const ZERO_CONTINUITY = {
  autoSnapshots: 0,
  autoStateModelPresent: 0,
  flushSnapshots: 0,
  flushStateModelPresent: 0,
  nextActionsNonEmpty: 0,
  openQuestionsNonEmpty: 0,
  snapshots: 0,
  stateModelPresent: 0,
};

test('computeLaunchGates returns no-data for flush when no memory_flush tool present', () => {
  const result = computeLaunchGates({
    continuity: ZERO_CONTINUITY,
    memoryTypeNullRatePct: 0,
    memoryTypeNullSampleCount: 0,
    orient: { calls: 0, degraded: 0, timeouts: 0 },
    tools: [],
  });
  assert.equal(result.flushSuccessRatePct.status, 'no-data');
  assert.equal(result.flushSuccessRatePct.observed, null);
});

test('computeLaunchGates computes flush status from memory_flush tool', () => {
  const result = computeLaunchGates({
    continuity: ZERO_CONTINUITY,
    memoryTypeNullRatePct: 0,
    memoryTypeNullSampleCount: 0,
    orient: { calls: 0, degraded: 0, timeouts: 0 },
    tools: [
      {
        calls: 100,
        p95DurationMs: 50,
        successRatePct: 99.5,
        toolName: 'memory_flush',
      },
    ],
  });
  assert.equal(result.flushSuccessRatePct.status, 'on-target');
  assert.equal(result.flushSuccessRatePct.observed, 99.5);
  assert.equal(result.flushSuccessRatePct.sampleCount, 100);
  assert.equal(result.flushSuccessRatePct.target, 99);
});

test('computeLaunchGates flush is warning when success rate is between 95 and 99', () => {
  const result = computeLaunchGates({
    continuity: ZERO_CONTINUITY,
    memoryTypeNullRatePct: 0,
    memoryTypeNullSampleCount: 0,
    orient: { calls: 0, degraded: 0, timeouts: 0 },
    tools: [
      {
        calls: 50,
        p95DurationMs: 50,
        successRatePct: 97,
        toolName: 'memory_flush',
      },
    ],
  });
  assert.equal(result.flushSuccessRatePct.status, 'warning');
});

test('computeLaunchGates returns no-data for timeout/degradation when orient.calls is 0', () => {
  const result = computeLaunchGates({
    continuity: ZERO_CONTINUITY,
    memoryTypeNullRatePct: 0,
    memoryTypeNullSampleCount: 0,
    orient: { calls: 0, degraded: 0, timeouts: 0 },
    tools: [],
  });
  assert.equal(result.timeoutDegradationRatePct.status, 'no-data');
  assert.equal(result.timeoutDegradationRatePct.observed, null);
});

test('computeLaunchGates computes timeout/degradation rate from orient metrics', () => {
  const result = computeLaunchGates({
    continuity: ZERO_CONTINUITY,
    memoryTypeNullRatePct: 0,
    memoryTypeNullSampleCount: 0,
    orient: { calls: 200, degraded: 1, timeouts: 0 },
    tools: [],
  });
  assert.equal(result.timeoutDegradationRatePct.status, 'on-target');
  assert.equal(result.timeoutDegradationRatePct.observed, 0.5);
  assert.equal(result.timeoutDegradationRatePct.sampleCount, 200);
});

test('computeLaunchGates returns no-data for memory_type NULL rate when sampleCount is 0', () => {
  const result = computeLaunchGates({
    continuity: ZERO_CONTINUITY,
    memoryTypeNullRatePct: 0,
    memoryTypeNullSampleCount: 0,
    orient: { calls: 0, degraded: 0, timeouts: 0 },
    tools: [],
  });
  assert.equal(result.memoryTypeNullRatePct.status, 'no-data');
  assert.equal(result.memoryTypeNullRatePct.observed, null);
});

test('computeLaunchGates computes memory_type NULL rate from DB metrics', () => {
  const result = computeLaunchGates({
    continuity: ZERO_CONTINUITY,
    memoryTypeNullRatePct: 0,
    memoryTypeNullSampleCount: 500,
    orient: { calls: 0, degraded: 0, timeouts: 0 },
    tools: [],
  });
  assert.equal(result.memoryTypeNullRatePct.status, 'on-target');
  assert.equal(result.memoryTypeNullRatePct.observed, 0);
  assert.equal(result.memoryTypeNullRatePct.sampleCount, 500);
  assert.equal(result.memoryTypeNullRatePct.target, 0.1);
});

test('computeLaunchGates returns no-data for continuity when snapshots is 0', () => {
  const result = computeLaunchGates({
    continuity: ZERO_CONTINUITY,
    memoryTypeNullRatePct: 0,
    memoryTypeNullSampleCount: 0,
    orient: { calls: 0, degraded: 0, timeouts: 0 },
    tools: [],
  });
  assert.equal(result.continuityNextActionsPct.status, 'no-data');
  assert.equal(result.continuityOpenQuestionsPct.status, 'no-data');
  assert.equal(result.continuityStateModelPct.status, 'no-data');
  assert.equal(result.continuityStateModelPct.observed, null);
  assert.equal(result.continuityStateModelPct.target, 90);
  assert.equal(result.autoSnapshotStateModelPct.status, 'no-data');
  assert.equal(result.autoSnapshotStateModelPct.observed, null);
  assert.equal(result.autoSnapshotStateModelPct.target, 25);
});

test('computeLaunchGates continuityStateModelPct measures the explicit-flush channel only', () => {
  // 92/100 flush snapshots have x_state_model → 92% → on-target (threshold: >= 90%)
  // 5/100 auto snapshots have x_state_model → reported separately
  const result = computeLaunchGates({
    continuity: {
      autoSnapshots: 100,
      autoStateModelPresent: 5,
      flushSnapshots: 100,
      flushStateModelPresent: 92,
      nextActionsNonEmpty: 0,
      openQuestionsNonEmpty: 0,
      snapshots: 200,
      stateModelPresent: 97,
    },
    memoryTypeNullRatePct: 0,
    memoryTypeNullSampleCount: 0,
    orient: { calls: 0, degraded: 0, timeouts: 0 },
    tools: [],
  });
  assert.equal(result.continuityStateModelPct.status, 'on-target');
  assert.equal(result.continuityStateModelPct.observed, 92);
  assert.equal(result.continuityStateModelPct.sampleCount, 100, 'denominator is flush snapshots, not all snapshots');
  assert.equal(result.continuityStateModelPct.target, 90);
});

test('computeLaunchGates continuityStateModelPct returns warning when flush coverage in 60-90 band', () => {
  const result = computeLaunchGates({
    continuity: {
      autoSnapshots: 0,
      autoStateModelPresent: 0,
      flushSnapshots: 100,
      flushStateModelPresent: 75,
      nextActionsNonEmpty: 0,
      openQuestionsNonEmpty: 0,
      snapshots: 100,
      stateModelPresent: 75,
    },
    memoryTypeNullRatePct: 0,
    memoryTypeNullSampleCount: 0,
    orient: { calls: 0, degraded: 0, timeouts: 0 },
    tools: [],
  });
  assert.equal(result.continuityStateModelPct.status, 'warning');
  assert.equal(result.continuityStateModelPct.observed, 75);
});

test('computeLaunchGates continuityStateModelPct is failing when flush coverage below warning floor', () => {
  const result = computeLaunchGates({
    continuity: {
      autoSnapshots: 0,
      autoStateModelPresent: 0,
      flushSnapshots: 100,
      flushStateModelPresent: 50,
      nextActionsNonEmpty: 0,
      openQuestionsNonEmpty: 0,
      snapshots: 100,
      stateModelPresent: 50,
    },
    memoryTypeNullRatePct: 0,
    memoryTypeNullSampleCount: 0,
    orient: { calls: 0, degraded: 0, timeouts: 0 },
    tools: [],
  });
  assert.equal(result.continuityStateModelPct.status, 'failing');
  assert.equal(result.continuityStateModelPct.observed, 50);
});

test('computeLaunchGates autoSnapshotStateModelPct reports auto-channel coverage independently', () => {
  // Mirrors a low-adoption shape: high flush coverage, low auto coverage
  // because most sessions never call memory_flush and so carry-forward never fires.
  const result = computeLaunchGates({
    continuity: {
      autoSnapshots: 972,
      autoStateModelPresent: 0,
      flushSnapshots: 292,
      flushStateModelPresent: 292,
      nextActionsNonEmpty: 521,
      openQuestionsNonEmpty: 521,
      snapshots: 1264,
      stateModelPresent: 292,
    },
    memoryTypeNullRatePct: 0,
    memoryTypeNullSampleCount: 0,
    orient: { calls: 0, degraded: 0, timeouts: 0 },
    tools: [],
  });
  // Explicit-flush channel is healthy on its own.
  assert.equal(result.continuityStateModelPct.status, 'on-target');
  assert.equal(result.continuityStateModelPct.observed, 100);
  assert.equal(result.continuityStateModelPct.sampleCount, 292);
  assert.equal(
    result.continuityStateModelPct.severity,
    'blocking',
    'explicit-flush x_state_model coverage is the contractual blocking gate',
  );
  // Auto channel is reported separately. The observed value falls below the reference
  // floor (failing under the gate-threshold formula) but `severity: 'informational'`
  // means it must never act as a launch blocker — the field is preserved for visibility.
  assert.equal(result.autoSnapshotStateModelPct.status, 'failing');
  assert.equal(result.autoSnapshotStateModelPct.observed, 0);
  assert.equal(result.autoSnapshotStateModelPct.sampleCount, 972);
  assert.equal(
    result.autoSnapshotStateModelPct.severity,
    'informational',
    'auto-channel coverage must be informational so the carry-forward floor never blocks launch',
  );
});

test('computeLaunchGates tags severity per gate so JSON consumers can distinguish blocking from informational', () => {
  // Mirrors a mixed-channel scenario: explicit channel on
  // target, auto channel at 0% — the launch-gates object should report:
  //   - flushSuccessRatePct, timeoutDegradationRatePct, memoryTypeNullRatePct,
  //     contestedLatencyP95Ms, continuityStateModelPct → severity: 'blocking'
  //   - autoSnapshotStateModelPct, continuityNextActionsPct, continuityOpenQuestionsPct
  //     → severity: 'informational'
  const result = computeLaunchGates({
    continuity: {
      autoSnapshots: 972,
      autoStateModelPresent: 0,
      flushSnapshots: 292,
      flushStateModelPresent: 292,
      nextActionsNonEmpty: 521,
      openQuestionsNonEmpty: 521,
      snapshots: 1264,
      stateModelPresent: 292,
    },
    memoryTypeNullRatePct: 0,
    memoryTypeNullSampleCount: 100,
    orient: { calls: 100, degraded: 0, timeouts: 0 },
    tools: [
      {
        calls: 100,
        p95DurationMs: 100,
        successRatePct: 100,
        toolName: 'memory_flush',
      },
    ],
  });

  assert.equal(result.flushSuccessRatePct.severity, 'blocking');
  assert.equal(result.timeoutDegradationRatePct.severity, 'blocking');
  assert.equal(result.memoryTypeNullRatePct.severity, 'blocking');
  assert.equal(result.contestedLatencyP95Ms.severity, 'blocking');
  assert.equal(result.continuityStateModelPct.severity, 'blocking');

  assert.equal(result.autoSnapshotStateModelPct.severity, 'informational');
  assert.equal(result.continuityNextActionsPct.severity, 'informational');
  assert.equal(result.continuityOpenQuestionsPct.severity, 'informational');
});

test('computeLaunchGates no-data continuity entries still emit severity tags', () => {
  const result = computeLaunchGates({
    continuity: ZERO_CONTINUITY,
    memoryTypeNullRatePct: 0,
    memoryTypeNullSampleCount: 0,
    orient: { calls: 0, degraded: 0, timeouts: 0 },
    tools: [],
  });

  // Severity is a structural property of the gate, not its observation. It must be
  // present even when there are no samples to compute against.
  assert.equal(result.continuityNextActionsPct.severity, 'informational');
  assert.equal(result.continuityOpenQuestionsPct.severity, 'informational');
  assert.equal(result.continuityStateModelPct.severity, 'blocking');
  assert.equal(result.autoSnapshotStateModelPct.severity, 'informational');
});

test('computeLaunchGates low-adoption scenario: explicit channel on target, auto channel 0%, no blocking continuity failure', () => {
  // Verified shape from `pnpm --filter @aviaratech/ai-memory-tools health --days 1` on
  // Explicit-flush coverage is 100% while auto coverage is 0%.
  // requires that the auto-channel denominator does not produce a blocking failure
  // when the explicit channel is healthy.
  const result = computeLaunchGates({
    continuity: {
      autoSnapshots: 202,
      autoStateModelPresent: 0,
      flushSnapshots: 78,
      flushStateModelPresent: 78,
      nextActionsNonEmpty: 78, // 27.9% of 280 — formerly a blocking failure
      openQuestionsNonEmpty: 65, // 23.2% of 280 — formerly a blocking warning
      snapshots: 280,
      stateModelPresent: 78,
    },
    memoryTypeNullRatePct: 0,
    memoryTypeNullSampleCount: 0,
    orient: { calls: 0, degraded: 0, timeouts: 0 },
    tools: [],
  });

  // Blocking gate: explicit-flush coverage is on target.
  assert.equal(result.continuityStateModelPct.status, 'on-target');
  assert.equal(result.continuityStateModelPct.observed, 100);
  assert.equal(result.continuityStateModelPct.severity, 'blocking');

  // Informational gate: auto channel sits below its reference floor, but severity is
  // informational so it cannot block launch.
  assert.equal(result.autoSnapshotStateModelPct.severity, 'informational');

  // The aggregate next_actions/open_questions percentages were the second source of
  // false-blocking signal — they still compute and still report their status, but
  // severity is informational so JSON consumers won't treat them as blockers.
  assert.equal(result.continuityNextActionsPct.severity, 'informational');
  assert.equal(result.continuityOpenQuestionsPct.severity, 'informational');

  // Sanity-check the entire blocking surface — none of the blocking gates should be
  // failing under this low-adoption shape. Iterate over the typed LaunchGatesReport via
  // its keys rather than Object.values, which TypeScript widens to `any[]`.
  const blockingFailures = (Object.keys(result) as (keyof typeof result)[])
    .map(key => result[key])
    .filter(gate => gate.severity === 'blocking' && gate.status === 'failing');
  assert.deepEqual(blockingFailures, [], 'no blocking gate should be failing under the low-adoption scenario');
});

test('computeLaunchGates computes continuity percentages from snapshot data', () => {
  const result = computeLaunchGates({
    continuity: {
      autoSnapshots: 0,
      autoStateModelPresent: 0,
      flushSnapshots: 0,
      flushStateModelPresent: 0,
      nextActionsNonEmpty: 70,
      openQuestionsNonEmpty: 45,
      snapshots: 100,
      stateModelPresent: 0,
    },
    memoryTypeNullRatePct: 0,
    memoryTypeNullSampleCount: 0,
    orient: { calls: 0, degraded: 0, timeouts: 0 },
    tools: [],
  });
  assert.equal(result.continuityNextActionsPct.status, 'on-target');
  assert.equal(result.continuityNextActionsPct.observed, 70);
  assert.equal(result.continuityOpenQuestionsPct.status, 'on-target');
  assert.equal(result.continuityOpenQuestionsPct.observed, 45);
});

// --- renderReport launch gate observed-value rendering ---

test('renderReport renders flush reliability with observed value and status when data present', () => {
  const report = createMinimalReport({
    mcpUsage: {
      tools: [
        {
          avgDurationMs: 20,
          calls: 245,
          errors: 0,
          p95DurationMs: 60,
          successes: 244,
          successRatePct: 99.6,
          toolCategory: 'write',
          toolName: 'memory_flush',
        },
      ],
    },
  });

  const output = renderReport(report);

  assert.ok(
    output.includes('memory_flush reliability: 99.6% success over 245 calls (target: >= 99.0%, on-target).'),
    'should include flush line with observed value, call count, target, and status',
  );
});

test('renderReport renders timeout/degradation rate with observed value when orient calls present', () => {
  const report = createMinimalReport({
    mcpUsage: {
      orient: {
        calls: 200,
        degraded: 1,
        errors: 0,
        ok: 199,
        partial: 0,
        timeoutRatePct: 0,
        timeouts: 0,
        timeoutTargetPct: 1,
      },
    },
  });

  const output = renderReport(report);

  assert.ok(
    output.includes('Timeout/degradation rate: 0.5% over 200 calls (target: < 1.0%, on-target).'),
    'should include timeout/degradation line with observed rate, call count, target, and status',
  );
});

test('renderReport renders memory_type NULL rate with observed value when entries present', () => {
  const report = createMinimalReport({
    database: {
      memoryTypeNullRatePct: 0,
      memoryTypeNullSampleCount: 500,
    },
  });

  const output = renderReport(report);

  assert.ok(
    output.includes('memory_type NULL rate: 0.0% over 500 entries (target: = 0.0%, on-target).'),
    'should include NULL rate line with observed value, entry count, target, and status',
  );
});

test('renderReport renders continuity payload completeness when agent-writer flushes are present', () => {
  const report = createMinimalReport({
    database: {
      continuityAdoption: {
        agentWriterCompliancePct: 96,
        agentWriterCompliant: 96,
        agentWriterFlushes: 100,
      },
    },
  });

  const output = renderReport(report);

  assert.ok(
    output.includes(
      'Continuity payload completeness: 96.0% over 100 agent-writer memory_flush calls (target: >= 95.0%, on-target).',
    ),
    'should include agent-writer payload completeness observed line',
  );
  assert.ok(!output.includes('Session continuity next_actions:'), 'old next_actions launch gate should not render');
  assert.ok(!output.includes('Session continuity open_questions:'), 'old open_questions launch gate should not render');
});

test('database.stateModelAdoptionPct is computed as stateModelPresent / snapshots * 100', () => {
  const report = createMinimalReport({
    database: {
      continuityAdoption: {
        envModelPresent: 0,
        nextActionsNonEmpty: 0,
        openQuestionsNonEmpty: 0,
        snapshots: 200,
        stateModelPresent: 80,
      },
    },
  });
  assert.equal(report.database.stateModelAdoptionPct, 40, 'stateModelAdoptionPct should be 80/200*100 = 40');
});

test('database.stateModelAdoptionPct is 0 when there are no snapshots', () => {
  const report = createMinimalReport();
  assert.equal(report.database.stateModelAdoptionPct, 0, 'stateModelAdoptionPct should be 0 when snapshots is 0');
});

test('computeLaunchGates returns warning status when continuity adoption is in the warning band', () => {
  // nextActions: 50 is below onTarget (60) but above warning floor (40) → 'warning'
  // openQuestions: 30 is below onTarget (40) but above warning floor (20) → 'warning'
  const result = computeLaunchGates({
    continuity: {
      ...ZERO_CONTINUITY,
      nextActionsNonEmpty: 50,
      openQuestionsNonEmpty: 30,
      snapshots: 100,
    },
    memoryTypeNullRatePct: 0,
    memoryTypeNullSampleCount: 0,
    orient: { calls: 0, degraded: 0, timeouts: 0 },
    tools: [],
  });

  assert.equal(result.continuityNextActionsPct.status, 'warning');
  assert.equal(result.continuityNextActionsPct.observed, 50);
  assert.equal(result.continuityOpenQuestionsPct.status, 'warning');
  assert.equal(result.continuityOpenQuestionsPct.observed, 30);
});

test('computeLaunchGates returns failing status when continuity adoption is below the warning floor', () => {
  // nextActions: 30 is below warning floor (40) → 'failing'
  // openQuestions: 15 is below warning floor (20) → 'failing'
  const result = computeLaunchGates({
    continuity: {
      ...ZERO_CONTINUITY,
      nextActionsNonEmpty: 30,
      openQuestionsNonEmpty: 15,
      snapshots: 100,
    },
    memoryTypeNullRatePct: 0,
    memoryTypeNullSampleCount: 0,
    orient: { calls: 0, degraded: 0, timeouts: 0 },
    tools: [],
  });

  assert.equal(result.continuityNextActionsPct.status, 'failing');
  assert.equal(result.continuityNextActionsPct.observed, 30);
  assert.equal(result.continuityOpenQuestionsPct.status, 'failing');
  assert.equal(result.continuityOpenQuestionsPct.observed, 15);
});

test('renderReport renders below-target continuity payload status in launch gate lines', () => {
  const report = createMinimalReport({
    database: {
      continuityAdoption: {
        agentWriterCompliancePct: 90,
        agentWriterCompliant: 90,
        agentWriterFlushes: 100,
      },
    },
  });

  const output = renderReport(report);

  assert.ok(
    output.includes(
      'Continuity payload completeness: 90.0% over 100 agent-writer memory_flush calls (target: >= 95.0%, below-target).',
    ),
    'should include below-target agent-writer payload completeness line',
  );
});

// --- JSON output contract tests ---
// HealthReport.launchGates is serialized as-is by the --json CLI flag; these tests
// verify the contract by round-tripping through JSON.stringify/JSON.parse.

test('HealthReport JSON includes launchGates with metric, observed, sampleCount, status, target for all gates', () => {
  const report = createMinimalReport();

  // Simulate JSON serialization as the CLI does: JSON.stringify(report, null, 2)
  const parsed = JSON.parse(JSON.stringify(report)) as {
    launchGates?: unknown;
  };
  assert.ok(parsed.launchGates !== null && typeof parsed.launchGates === 'object', 'JSON should include launchGates');

  const gates = parsed.launchGates as Record<string, unknown>;
  const expectedKeys = [
    'contestedLatencyP95Ms',
    'continuityNextActionsPct',
    'continuityOpenQuestionsPct',
    'flushSuccessRatePct',
    'memoryTypeNullRatePct',
    'timeoutDegradationRatePct',
  ];
  for (const key of expectedKeys) {
    assert.ok(key in gates, `launchGates should include ${key}`);
    const entry = gates[key] as Record<string, unknown>;
    assert.ok('metric' in entry, `${key} should have metric field`);
    assert.ok('observed' in entry, `${key} should have observed field`);
    assert.ok('sampleCount' in entry, `${key} should have sampleCount field`);
    assert.ok('severity' in entry, `${key} should have severity field`);
    assert.ok('status' in entry, `${key} should have status field`);
    assert.ok('target' in entry, `${key} should have target field`);
  }
});

test('HealthReport JSON launchGates includes observed values and status when flush data is present', () => {
  const report = createMinimalReport({
    mcpUsage: {
      tools: [
        {
          avgDurationMs: 20,
          calls: 100,
          errors: 0,
          p95DurationMs: 50,
          successes: 100,
          successRatePct: 100,
          toolCategory: 'write',
          toolName: 'memory_flush',
        },
      ],
    },
  });

  const parsed = JSON.parse(JSON.stringify(report)) as {
    launchGates?: Record<string, Record<string, unknown>>;
  };
  const flush = parsed.launchGates?.flushSuccessRatePct;
  assert.ok(flush !== undefined, 'flushSuccessRatePct should be present');
  assert.equal(flush.observed, 100, 'flush observed should be the successRatePct value');
  assert.equal(flush.sampleCount, 100, 'flush sampleCount should be call count');
  assert.equal(flush.status, 'on-target', 'flush status should be on-target at 100%');
  assert.equal(flush.target, 99, 'flush target should be 99');
});

// --- Text/JSON parity fixtures ---

test('health-report parity fixture: baseline no-data text + JSON launch-gates', () => {
  const report = createMinimalReport();

  const expectedText = `AI Memory Health Report
Period: 2026-01-08T00:00:00.000Z to 2026-01-15T00:00:00.000Z (7d)
Database: postgresql://ai_memory:ai_memory@localhost:5432/ai_memory

Ingestion
- Sessions started: 0
- Memory deltas ingested: 0
- Context packs ingested: 0
- Continuity packs materialized: packs=0 updated_in_window=0 avg_payload=0.0 chars max_payload=0 chars
- Continuity pack budget pressure: no packs materialized
- Durable memories created: 0
- Durable memories updated: 0
- Ingestion failures in window: Total=0 | Unresolved (any age)=0 | Resolved=0 (avg MTTR: 0.0 min)
- Session-end conflict mismatch rate (14d): 0.0% (0/0 writes, target < 1.0%, on-target)
- Active failures (2026-01-14T00:00:00.000Z to 2026-01-15T00:00:00.000Z): Unresolved=0, Resolved=0 (no active incidents)
- Historical failures (2026-01-08T00:00:00.000Z to 2026-01-14T00:00:00.000Z): Unresolved debt=0, Resolved=0 (no historical debt)
- Top repeated failure signatures: (none)
- Top timeout operations: (none)
- Snapshot continuity adoption: no session snapshots in window
- Continuity adoption readiness: no continuity-pack read telemetry in window
- Continuity actionable-field completeness: no continuity packs available for field completeness
- Continuity flush-after-pack: no session-scoped continuity-pack reads in window
- Taxonomy distribution (0 active memories):
  - actionable: 0 (0.0%)
  - contextual: 0 (0.0%)
  - low-signal: 0 (0.0%)

Launch Gates (Post-A0 Baseline)
- Baseline: evaluate thresholds on rolling windows measured after A0 merge.
- memory_flush reliability: no flush calls in window (target: >= 99.0%).
- Timeout/degradation rate: no orient calls in window (target: < 1.0%).
- memory_type NULL rate: no new entries in window (target: = 0.0%).
- Contested resolution latency: no samples in window (target: p95 < 300ms).
- Continuity payload completeness: no agent-writer memory_flush calls in window (target: >= 95.0%).
- Explicit-flush x_state_model coverage: no explicit-flush snapshots in window (target: >= 90.0%).
- Auto-channel x_state_model coverage (carry-forward only, informational): no auto snapshots in window (reference floor: >= 25.0%).

MCP Usage
- Telemetry source: db
- Log file: /dev/null
- Log file source: repo_root
- Tool invocations: 0 (success: 0, errors: 0, success rate: 0.0%)
- Read/write mix: read=0 write=0
- Continuity pack reads: no telemetry rows in window
- Dedupe suppressions (memory_store): 0
- Session resume calls: 0 (ok: 0 [direct: 0, fallback: 0], not_found: 0, errors: 0)
- Orient calls: 0 (ok: 0, partial: 0, degraded: 0, errors: 0, timeouts: 0, timeout rate: 0.0% (target <1.0%))
- Top tools by calls: (none in this window)

Write Calibration
- No calibrated writes in window.

Reflect
- Cycles in window: 0
- Last cycle: none
- Evaluations since last cycle: n/a
- Provisional methodology memories written: 0
- Recent cycles: none

Orchestration
- Transcript directory: /dev/null
- Runs: 0 (approval rate: 0.0%)
- Outcomes: approved=0 not_approved=0 error=0
- Avg rounds per run: 0.00
- Total tokens across runs: 0
- Retro markdown files: 0
- Retro insight files: 0
- Retro issue-seed files: 0

Retention
- Active config: sessions=90d failures=30d expired-grace=30d superseded=180d audit=180d batch=1000
- Total purge-eligible backlog: 0 rows
- Last retention run: (none recorded)

Outcome Signals
- No repeated-fix signals
- No decision reversals

`;

  assert.equal(renderReport(report), expectedText, 'text output should match baseline fixture exactly');

  const parsed = JSON.parse(JSON.stringify(report)) as {
    launchGates: Record<
      string,
      {
        observed: null | number;
        sampleCount: null | number;
        severity: string;
        status: string;
        target: number;
      }
    >;
  };
  assert.deepEqual(parsed.launchGates, {
    autoSnapshotStateModelPct: {
      metric: 'autoSnapshotStateModelPct',
      observed: null,
      sampleCount: 0,
      severity: 'informational',
      status: 'no-data',
      target: 25,
    },
    contestedLatencyP95Ms: {
      metric: 'contestedLatencyP95Ms',
      observed: null,
      sampleCount: null,
      severity: 'blocking',
      status: 'no-data',
      target: 300,
    },
    continuityNextActionsPct: {
      metric: 'continuityNextActionsPct',
      observed: null,
      sampleCount: 0,
      severity: 'informational',
      status: 'no-data',
      target: 60,
    },
    continuityOpenQuestionsPct: {
      metric: 'continuityOpenQuestionsPct',
      observed: null,
      sampleCount: 0,
      severity: 'informational',
      status: 'no-data',
      target: 40,
    },
    continuityStateModelPct: {
      metric: 'continuityStateModelPct',
      observed: null,
      sampleCount: 0,
      severity: 'blocking',
      status: 'no-data',
      target: 90,
    },
    flushSuccessRatePct: {
      metric: 'flushSuccessRatePct',
      observed: null,
      sampleCount: null,
      severity: 'blocking',
      status: 'no-data',
      target: 99,
    },
    memoryTypeNullRatePct: {
      metric: 'memoryTypeNullRatePct',
      observed: null,
      sampleCount: 0,
      severity: 'blocking',
      status: 'no-data',
      target: 0.1,
    },
    timeoutDegradationRatePct: {
      metric: 'timeoutDegradationRatePct',
      observed: null,
      sampleCount: 0,
      severity: 'blocking',
      status: 'no-data',
      target: 1,
    },
  });
});

test('health-report parity fixture: observed launch-gate text + JSON launch-gates', () => {
  const report = createMinimalReport({
    database: {
      continuityAdoption: {
        agentWriterCompliancePct: 95,
        agentWriterCompliant: 19,
        agentWriterFlushes: 20,
        envModelPresent: 5,
        flush: {
          envModelPresent: 5,
          nextActionsNonEmpty: 7,
          openQuestionsNonEmpty: 4,
          snapshots: 10,
          stateModelPresent: 8,
        },
        nextActionsNonEmpty: 7,
        openQuestionsNonEmpty: 4,
        snapshots: 10,
        stateModelPresent: 8,
      },
      memoryTypeNullRatePct: 0,
      memoryTypeNullSampleCount: 500,
    },
    mcpUsage: {
      orient: {
        calls: 0,
        degraded: 0,
        errors: 0,
        ok: 0,
        partial: 0,
        timeoutRatePct: 0,
        timeouts: 0,
        timeoutTargetPct: 1,
      },
      tools: [
        {
          avgDurationMs: 20,
          calls: 100,
          errors: 0,
          p95DurationMs: 50,
          successes: 100,
          successRatePct: 100,
          toolCategory: 'write',
          toolName: 'memory_flush',
        },
      ],
    },
  });

  const expectedText = `AI Memory Health Report
Period: 2026-01-08T00:00:00.000Z to 2026-01-15T00:00:00.000Z (7d)
Database: postgresql://ai_memory:ai_memory@localhost:5432/ai_memory

Ingestion
- Sessions started: 0
- Memory deltas ingested: 0
- Context packs ingested: 0
- Continuity packs materialized: packs=0 updated_in_window=0 avg_payload=0.0 chars max_payload=0 chars
- Continuity pack budget pressure: no packs materialized
- Durable memories created: 0
- Durable memories updated: 0
- Ingestion failures in window: Total=0 | Unresolved (any age)=0 | Resolved=0 (avg MTTR: 0.0 min)
- Session-end conflict mismatch rate (14d): 0.0% (0/0 writes, target < 1.0%, on-target)
- Active failures (2026-01-14T00:00:00.000Z to 2026-01-15T00:00:00.000Z): Unresolved=0, Resolved=0 (no active incidents)
- Historical failures (2026-01-08T00:00:00.000Z to 2026-01-14T00:00:00.000Z): Unresolved debt=0, Resolved=0 (no historical debt)
- Top repeated failure signatures: (none)
- Top timeout operations: (none)
- Snapshot continuity adoption: snapshots=10 next_actions=7 (70.0%) context_needed=0 (0.0%) open_questions=4 (40.0%) x_state_model=8 (80.0%) x_env_model=5 (50.0%)
  - flush (explicit memory_flush): snapshots=10 next_actions=7 (70.0%) context_needed=0 (0.0%) open_questions=4 (40.0%) x_state_model=8 (80.0%) x_env_model=5 (50.0%)
- Continuity source quality: explicit_flush_snapshots=10/10 (100.0%), auto_hint_snapshots=0/10 (0.0%), derived_or_carry_forward_fields=0/0 (n/a, informational)
- Continuity adoption readiness: no continuity-pack read telemetry in window
- Continuity actionable-field completeness: no continuity packs available for field completeness
- Continuity flush-after-pack: no session-scoped continuity-pack reads in window
- Taxonomy distribution (0 active memories):
  - actionable: 0 (0.0%)
  - contextual: 0 (0.0%)
  - low-signal: 0 (0.0%)

Launch Gates (Post-A0 Baseline)
- Baseline: evaluate thresholds on rolling windows measured after A0 merge.
- memory_flush reliability: 100.0% success over 100 calls (target: >= 99.0%, on-target).
- Timeout/degradation rate: no orient calls in window (target: < 1.0%).
- memory_type NULL rate: 0.0% over 500 entries (target: = 0.0%, on-target).
- Contested resolution latency: no samples in window (target: p95 < 300ms).
- Continuity payload completeness: 95.0% over 20 agent-writer memory_flush calls (target: >= 95.0%, on-target).
- Explicit-flush x_state_model coverage: 80.0% over 10 explicit-flush snapshots (target: >= 90.0%, warning).
- Auto-channel x_state_model coverage (carry-forward only, informational): no auto snapshots in window (reference floor: >= 25.0%).

MCP Usage
- Telemetry source: db
- Log file: /dev/null
- Log file source: repo_root
- Tool invocations: 0 (success: 0, errors: 0, success rate: 0.0%)
- Read/write mix: read=0 write=0
- Continuity pack reads: no telemetry rows in window
- Dedupe suppressions (memory_store): 0
- Session resume calls: 0 (ok: 0 [direct: 0, fallback: 0], not_found: 0, errors: 0)
- Orient calls: 0 (ok: 0, partial: 0, degraded: 0, errors: 0, timeouts: 0, timeout rate: 0.0% (target <1.0%))
- Top tools by calls:
  - memory_flush: calls=100 success=100.0% avg=20.0ms p95=50.0ms

Write Calibration
- No calibrated writes in window.

Reflect
- Cycles in window: 0
- Last cycle: none
- Evaluations since last cycle: n/a
- Provisional methodology memories written: 0
- Recent cycles: none

Orchestration
- Transcript directory: /dev/null
- Runs: 0 (approval rate: 0.0%)
- Outcomes: approved=0 not_approved=0 error=0
- Avg rounds per run: 0.00
- Total tokens across runs: 0
- Retro markdown files: 0
- Retro insight files: 0
- Retro issue-seed files: 0

Retention
- Active config: sessions=90d failures=30d expired-grace=30d superseded=180d audit=180d batch=1000
- Total purge-eligible backlog: 0 rows
- Last retention run: (none recorded)

Outcome Signals
- No repeated-fix signals
- No decision reversals

`;

  assert.equal(renderReport(report), expectedText, 'text output should match observed fixture exactly');

  const parsed = JSON.parse(JSON.stringify(report)) as {
    launchGates: Record<
      string,
      {
        observed: null | number;
        sampleCount: null | number;
        severity: string;
        status: string;
        target: number;
      }
    >;
  };
  assert.deepEqual(parsed.launchGates, {
    autoSnapshotStateModelPct: {
      metric: 'autoSnapshotStateModelPct',
      observed: null,
      sampleCount: 0,
      severity: 'informational',
      status: 'no-data',
      target: 25,
    },
    contestedLatencyP95Ms: {
      metric: 'contestedLatencyP95Ms',
      observed: null,
      sampleCount: null,
      severity: 'blocking',
      status: 'no-data',
      target: 300,
    },
    continuityNextActionsPct: {
      metric: 'continuityNextActionsPct',
      observed: 70,
      sampleCount: 10,
      severity: 'informational',
      status: 'on-target',
      target: 60,
    },
    continuityOpenQuestionsPct: {
      metric: 'continuityOpenQuestionsPct',
      observed: 40,
      sampleCount: 10,
      severity: 'informational',
      status: 'on-target',
      target: 40,
    },
    continuityStateModelPct: {
      metric: 'continuityStateModelPct',
      observed: 80,
      sampleCount: 10,
      severity: 'blocking',
      status: 'warning',
      target: 90,
    },
    flushSuccessRatePct: {
      metric: 'flushSuccessRatePct',
      observed: 100,
      sampleCount: 100,
      severity: 'blocking',
      status: 'on-target',
      target: 99,
    },
    memoryTypeNullRatePct: {
      metric: 'memoryTypeNullRatePct',
      observed: 0,
      sampleCount: 500,
      severity: 'blocking',
      status: 'on-target',
      target: 0.1,
    },
    timeoutDegradationRatePct: {
      metric: 'timeoutDegradationRatePct',
      observed: null,
      sampleCount: 0,
      severity: 'blocking',
      status: 'no-data',
      target: 1,
    },
  });
});

// --- computeUsefulnessMetrics() ---

interface UsefulnessToolRowOverrides {
  created_at: string;
  memory_category?: string;
  project: null | string;
  session_id: null | string;
  status?: string;
  tool_category?: string;
  tool_name: string;
}

function makeUsefulnessToolRow(overrides: UsefulnessToolRowOverrides) {
  return {
    durable_memories_deduped: 0,
    duration_ms: null,
    memory_category: '',
    orient_payload_budget_chars: 0,
    orient_payload_budget_exceeded: 0,
    orient_payload_chars: 0,
    orient_payload_tokens_estimate: 0,
    resolved_via: '',
    response_status: 'ok',
    status: 'ok',
    timeout_warning_count: 0,
    tool_category: 'read',
    warning_count: 0,
    write_disposition: '',
    ...overrides,
  };
}

test('computeUsefulnessMetrics returns null resumeToFirstWriteMs when no sessions', async () => {
  const mockPool = {
    query: () => Promise.resolve({ rows: [] }),
  } as unknown as Pool;

  const result = await computeUsefulnessMetrics({
    pool: mockPool,
    windowEndIso: '2026-01-02T10:00:00.000Z',
    windowStartIso: '2026-01-01T00:00:00.000Z',
  });

  assert.equal(result.resumeToFirstWriteMs, null);
  assert.equal(result.continuityScore.qualifyingSessions, 0);
  assert.equal(result.reworkAfterResume.sparseSessions, 0);
  assert.equal(result.reworkAfterResume.richSessions, 0);
  assert.equal(result.windowMinutes, 15);
});

test('computeUsefulnessMetrics reports 7d/30d counts, p95 latency, and provisional buckets', async () => {
  const BASE = Date.parse('2026-04-29T12:00:00.000Z');
  const ts = (offset: number) => new Date(BASE + offset).toISOString();
  const day = 24 * 60 * 60 * 1_000;

  const toolRows = [
    makeUsefulnessToolRow({
      created_at: ts(-20 * day),
      project: 'proj-old',
      session_id: 'sess-old',
      tool_name: 'memory_session_resume',
    }),
    makeUsefulnessToolRow({
      created_at: ts(-2 * day),
      project: 'proj-a',
      session_id: 'sess-a',
      tool_name: 'memory_session_resume',
    }),
    makeUsefulnessToolRow({
      created_at: ts(-2 * day + 100),
      project: 'proj-a',
      session_id: null,
      tool_category: 'write',
      tool_name: 'memory_store',
    }),
    makeUsefulnessToolRow({
      created_at: ts(-day),
      project: 'proj-b',
      session_id: 'sess-b',
      tool_name: 'memory_session_resume',
    }),
    makeUsefulnessToolRow({
      created_at: ts(-day + 400),
      memory_category: 'root-cause',
      project: 'proj-b',
      session_id: null,
      tool_category: 'write',
      tool_name: 'memory_store',
    }),
    makeUsefulnessToolRow({
      created_at: ts(-1_000),
      project: 'proj-c',
      session_id: 'sess-c',
      tool_name: 'memory_session_resume',
    }),
    makeUsefulnessToolRow({
      created_at: ts(-100),
      project: 'proj-c',
      session_id: null,
      tool_category: 'write',
      tool_name: 'memory_flush',
    }),
  ];

  const snapshotRows = [
    { created_at: ts(-20 * day - 1_000), session_id: 'sess-old', snapshot_json: JSON.stringify({}) },
    { created_at: ts(-2 * day - 1_000), session_id: 'sess-a', snapshot_json: JSON.stringify({}) },
    {
      created_at: ts(-day - 1_000),
      session_id: 'sess-b',
      snapshot_json: JSON.stringify({ next_actions: ['fix repeated bug'] }),
    },
    {
      created_at: ts(-2_000),
      session_id: 'sess-c',
      snapshot_json: JSON.stringify({
        next_actions: ['ship'],
        open_questions: ['none'],
        x_env_model: {},
        x_state_model: {},
      }),
    },
  ];

  const mockPool = {
    query: (sql: string) => {
      const rows = sql.includes('ai_session_snapshots') ? snapshotRows : toolRows;
      return Promise.resolve({ rows });
    },
  } as unknown as Pool;

  const result = await computeUsefulnessMetrics({
    pool: mockPool,
    windowEndIso: new Date(BASE).toISOString(),
    windowStartIso: new Date(BASE - 7 * day).toISOString(),
  });

  assert.equal(result.continuityScore.qualifyingSessions, 3, 'primary 7d window has three qualifying sessions');
  assert.equal(result.continuityScore.qualifyingSessions7d, 3, '7d counter excludes the older session');
  assert.equal(result.continuityScore.qualifyingSessions30d, 4, '30d counter includes the older session');
  assert.equal(result.resumeToFirstWriteMs, 400, 'median of 100ms, 400ms, and 900ms latencies');
  assert.equal(result.resumeToFirstWriteP95Ms, 900, 'p95 uses the slowest sample in this small window');
  assert.equal(result.reworkAfterResume.sparseSessions, 2);
  assert.equal(result.reworkAfterResume.richSessions, 1);
  assert.equal(result.reworkAfterResume.provisional, true, 'n_sparse and n_rich are below the n>=30 bar');
  assert.equal(result.reworkAfterResume.minBucketSize, 30);
});

test('computeUsefulnessMetrics computes sparse vs rich latency and rework', async () => {
  // Snapshot lookup is keyed by resumed session_id (F2 fix).
  // Write attribution uses project+time window (F1/F3 fix) so write rows can have
  // null or different session_ids from the resume row.
  const BASE = 1_700_000_000_000;
  const ts = (offset: number) => new Date(BASE + offset).toISOString();

  const toolRows = [
    // Resume row: session_id is the RESUMED (prior) session id, keyed against snapshots
    makeUsefulnessToolRow({
      created_at: ts(0),
      project: 'proj-sparse',
      session_id: 'sess-sparse-prior',
      tool_name: 'memory_session_resume',
    }),
    // Write rows use null session_id (F3: proves null-session writes are included via project+time)
    makeUsefulnessToolRow({
      created_at: ts(100),
      project: 'proj-sparse',
      session_id: null,
      tool_category: 'write',
      tool_name: 'memory_store',
    }),
    makeUsefulnessToolRow({
      created_at: ts(200),
      memory_category: 'root-cause',
      project: 'proj-sparse',
      session_id: null,
      tool_category: 'write',
      tool_name: 'memory_store',
    }),
    // Rich session resume at +500ms, write has a DIFFERENT session_id (F1: proves project+time attribution)
    makeUsefulnessToolRow({
      created_at: ts(500),
      project: 'proj-rich',
      session_id: 'sess-rich-prior',
      tool_name: 'memory_session_resume',
    }),
    makeUsefulnessToolRow({
      created_at: ts(700),
      project: 'proj-rich',
      session_id: 'sess-rich-current',
      tool_category: 'write',
      tool_name: 'memory_store',
    }),
  ];

  const snapshotRows = [
    // Snapshots keyed by the RESUMED session id (F2 fix)
    {
      created_at: ts(-1_000),
      session_id: 'sess-sparse-prior',
      snapshot_json: JSON.stringify({ next_actions: ['do something'] }),
    },
    {
      created_at: ts(-1_000),
      session_id: 'sess-rich-prior',
      snapshot_json: JSON.stringify({
        next_actions: ['do something'],
        open_questions: ['q1'],
        x_state_model: { assumptions: [] },
      }),
    },
  ];

  const mockPool = {
    query: (sql: string) => {
      const rows = sql.includes('ai_session_snapshots') ? snapshotRows : toolRows;
      return Promise.resolve({ rows });
    },
  } as unknown as Pool;

  const result = await computeUsefulnessMetrics({
    pool: mockPool,
    windowEndIso: new Date(BASE + 10_000).toISOString(),
    windowStartIso: new Date(BASE - 10_000).toISOString(),
  });

  assert.equal(
    result.continuityScore.qualifyingSessions,
    2,
    'both resumes find a prior snapshot keyed by resumed session_id',
  );
  assert.equal(result.continuityScore.sparseSessions, 1, 'sparse session has score=1 prior');
  assert.equal(result.continuityScore.richSessions, 1, 'rich session has score=3 prior');
  assert.equal(
    result.resumeToFirstWriteMs,
    150,
    'overall median of [100ms, 200ms] is 150ms via project+time attribution',
  );
  assert.equal(result.reworkAfterResume.sparseRepeatedFixes, 1, 'one root-cause store in post-resume window');
  assert.equal(result.reworkAfterResume.sparseMedianResumeMs, 100, 'sparse first-write latency');
  assert.equal(result.reworkAfterResume.richRepeatedFixes, 0, 'no root-cause stores in rich post-resume window');
  assert.equal(result.reworkAfterResume.richMedianResumeMs, 200, 'rich first-write latency');
});

// --- computeConsolidationMetrics() ---

test('computeConsolidationMetrics aggregates per-day consolidation actions and top deduped memory keys', async () => {
  const eventRows = [
    {
      created_at: '2026-04-29T10:00:00.000Z',
      payload_json: {
        actions: { dedupe: 1, none: 1, refine: 0, supersede: 0 },
        contradictions_flagged: 1,
        latency_ms: 120,
        outcomes: [
          { action_taken: 'dedupe', candidate_memory_key: 'example/catalog:decision:dup-a' },
          { action_taken: 'none', candidate_memory_key: 'example/catalog:decision:unrelated' },
        ],
        pairs_classified: 2,
        pairs_examined: 3,
      },
    },
    {
      created_at: '2026-04-29T11:00:00.000Z',
      payload_json: {
        actions: { dedupe: 1, none: 0, refine: 1, supersede: 1 },
        contradictions_flagged: 0,
        latency_ms: 80,
        outcomes: [
          { action_taken: 'dedupe', new_memory_key: 'example/catalog:decision:dup-a' },
          { action_taken: 'supersede', candidate_memory_key: 'example/catalog:decision:old-b' },
          { action_taken: 'refine', candidate_memory_key: 'example/catalog:decision:old-c' },
        ],
        pairs_classified: 3,
        pairs_examined: 3,
      },
    },
  ];

  const mockPool = {
    query: () => Promise.resolve({ rows: eventRows }),
  } as unknown as Pool;

  const result = await computeConsolidationMetrics({
    pool: mockPool,
    windowEndIso: '2026-04-30T00:00:00.000Z',
    windowStartIso: '2026-04-29T00:00:00.000Z',
  });

  assert.equal(result.totals.pairsExamined, 6);
  assert.equal(result.totals.pairsClassified, 5);
  assert.equal(result.totals.dedupes, 2);
  assert.equal(result.totals.supersedes, 1);
  assert.equal(result.totals.refines, 1);
  assert.equal(result.totals.none, 1);
  assert.equal(result.totals.contradictionsFlagged, 1);
  assert.equal(result.contradictionRatePct, 20);
  assert.equal(result.daily[0]?.date, '2026-04-29');
  assert.equal(result.daily[0].avgLatencyMs, 100);
  assert.deepEqual(result.topDedupedMemoryKeys[0], {
    count: 2,
    memoryKey: 'example/catalog:decision:dup-a',
  });
});

test('computeUsefulnessMetrics classifies score=4 snapshot as rich session', async () => {
  const BASE = 1_700_000_000_000;
  const ts = (offset: number) => new Date(BASE + offset).toISOString();

  const toolRows = [
    {
      created_at: ts(0),
      durable_memories_deduped: 0,
      duration_ms: null,
      memory_category: '',
      orient_payload_budget_chars: 0,
      orient_payload_budget_exceeded: 0,
      orient_payload_chars: 0,
      orient_payload_tokens_estimate: 0,
      project: 'proj-a',
      resolved_via: '',
      response_status: 'ok',
      session_id: 'sess-a-prior',
      status: 'ok',
      timeout_warning_count: 0,
      tool_category: 'read',
      tool_name: 'memory_session_resume',
      warning_count: 0,
      write_disposition: '',
    },
  ];

  // Snapshot keyed by the resumed session_id; score=4 (all four continuity fields)
  const snapshotRows = [
    {
      created_at: ts(-1_000),
      session_id: 'sess-a-prior',
      snapshot_json: JSON.stringify({
        next_actions: ['action'],
        open_questions: ['q'],
        x_env_model: { branch: 'main' },
        x_state_model: { assumptions: [] },
      }),
    },
  ];

  const mockPool = {
    query: (sql: string) => {
      const rows = sql.includes('ai_session_snapshots') ? snapshotRows : toolRows;
      return Promise.resolve({ rows });
    },
  } as unknown as Pool;

  const result = await computeUsefulnessMetrics({
    pool: mockPool,
    windowEndIso: new Date(BASE + 5_000).toISOString(),
    windowStartIso: new Date(BASE - 5_000).toISOString(),
  });

  assert.equal(result.continuityScore.qualifyingSessions, 1);
  assert.equal(result.continuityScore.richSessions, 1, 'score=4 should be classified as rich (≥3)');
  assert.equal(result.continuityScore.sparseSessions, 0);
});

test('computeUsefulnessMetrics excludes writes outside 15-minute window', async () => {
  const BASE = 1_700_000_000_000;
  const ts = (offset: number) => new Date(BASE + offset).toISOString();
  const SIXTEEN_MINUTES_MS = 16 * 60 * 1_000;

  const toolRows = [
    {
      created_at: ts(0),
      durable_memories_deduped: 0,
      duration_ms: null,
      memory_category: '',
      orient_payload_budget_chars: 0,
      orient_payload_budget_exceeded: 0,
      orient_payload_chars: 0,
      orient_payload_tokens_estimate: 0,
      project: 'proj-b',
      resolved_via: '',
      response_status: 'ok',
      session_id: 'sess-b-prior',
      status: 'ok',
      timeout_warning_count: 0,
      tool_category: 'read',
      tool_name: 'memory_session_resume',
      warning_count: 0,
      write_disposition: '',
    },
    // write at +16 minutes — outside the 15-minute window; uses a different session_id to
    // also verify that project+time attribution handles mismatched ids correctly
    {
      created_at: ts(SIXTEEN_MINUTES_MS),
      durable_memories_deduped: 0,
      duration_ms: null,
      memory_category: '',
      orient_payload_budget_chars: 0,
      orient_payload_budget_exceeded: 0,
      orient_payload_chars: 0,
      orient_payload_tokens_estimate: 0,
      project: 'proj-b',
      resolved_via: '',
      response_status: 'ok',
      session_id: 'sess-b-current',
      status: 'ok',
      timeout_warning_count: 0,
      tool_category: 'write',
      tool_name: 'memory_store',
      warning_count: 0,
      write_disposition: '',
    },
  ];

  const snapshotRows = [
    {
      created_at: ts(-1_000),
      session_id: 'sess-b-prior',
      snapshot_json: JSON.stringify({ next_actions: ['x'] }),
    },
  ];

  const mockPool = {
    query: (sql: string) => {
      const rows = sql.includes('ai_session_snapshots') ? snapshotRows : toolRows;
      return Promise.resolve({ rows });
    },
  } as unknown as Pool;

  const result = await computeUsefulnessMetrics({
    pool: mockPool,
    windowEndIso: new Date(BASE + SIXTEEN_MINUTES_MS + 60_000).toISOString(),
    windowStartIso: new Date(BASE - 60_000).toISOString(),
  });

  assert.equal(result.resumeToFirstWriteMs, null, 'write outside 15-min window should not count toward latency');
  assert.equal(result.continuityScore.qualifyingSessions, 1, 'session still qualifies (it has a prior snapshot)');
});

test('computeUsefulnessMetrics attributes writes by project+time when resume and write session_ids differ', async () => {
  // Regression test for F1: resume.session_id is the OLD resumed session id; the current
  // agent's writes arrive under a different session_id. Project+time attribution must
  // still find and count those writes.
  const BASE = 1_700_000_000_000;
  const ts = (offset: number) => new Date(BASE + offset).toISOString();

  const toolRows = [
    // Resume records the OLD session id (that is what memory_session_resume returns)
    {
      created_at: ts(0),
      durable_memories_deduped: 0,
      duration_ms: null,
      memory_category: '',
      orient_payload_budget_chars: 0,
      orient_payload_budget_exceeded: 0,
      orient_payload_chars: 0,
      orient_payload_tokens_estimate: 0,
      project: 'proj-x',
      resolved_via: '',
      response_status: 'ok',
      session_id: 'old-session',
      status: 'ok',
      timeout_warning_count: 0,
      tool_category: 'read',
      tool_name: 'memory_session_resume',
      warning_count: 0,
      write_disposition: '',
    },
    // Write arrives under a DIFFERENT session_id (the current session) — not 'old-session'
    {
      created_at: ts(300),
      durable_memories_deduped: 0,
      duration_ms: null,
      memory_category: 'root-cause',
      orient_payload_budget_chars: 0,
      orient_payload_budget_exceeded: 0,
      orient_payload_chars: 0,
      orient_payload_tokens_estimate: 0,
      project: 'proj-x',
      resolved_via: '',
      response_status: 'ok',
      session_id: 'new-session',
      status: 'ok',
      timeout_warning_count: 0,
      tool_category: 'write',
      tool_name: 'memory_store',
      warning_count: 0,
      write_disposition: '',
    },
  ];

  // Snapshot keyed by the OLD session id (the one that was resumed)
  const snapshotRows = [
    {
      created_at: ts(-500),
      session_id: 'old-session',
      snapshot_json: JSON.stringify({ next_actions: ['continue work'] }),
    },
  ];

  const mockPool = {
    query: (sql: string) => {
      const rows = sql.includes('ai_session_snapshots') ? snapshotRows : toolRows;
      return Promise.resolve({ rows });
    },
  } as unknown as Pool;

  const result = await computeUsefulnessMetrics({
    pool: mockPool,
    windowEndIso: new Date(BASE + 10_000).toISOString(),
    windowStartIso: new Date(BASE - 10_000).toISOString(),
  });

  assert.equal(result.continuityScore.qualifyingSessions, 1, 'resume with mismatched write session_id still qualifies');
  assert.equal(
    result.resumeToFirstWriteMs,
    300,
    'project+time attribution finds the write even with different session_id',
  );
  assert.equal(
    result.reworkAfterResume.sparseRepeatedFixes,
    1,
    'root-cause store in window is counted even with different session_id',
  );
});

test('computeUsefulnessMetrics excludes resume rows missing a project (F1: telemetry requirement)', async () => {
  // A resume row with no project should not qualify — project is required for attribution.
  const BASE = 1_700_000_100_000;
  const ts = (offset: number) => new Date(BASE + offset).toISOString();

  const makeRow = (overrides: {
    created_at: string;
    memory_category?: string;
    project?: null | string;
    session_id: null | string;
    status?: string;
    tool_category?: string;
    tool_name: string;
  }) => ({
    durable_memories_deduped: 0,
    duration_ms: null,
    memory_category: '',
    orient_payload_budget_chars: 0,
    orient_payload_budget_exceeded: 0,
    orient_payload_chars: 0,
    orient_payload_tokens_estimate: 0,
    project: null,
    resolved_via: '',
    response_status: 'ok',
    status: 'ok',
    timeout_warning_count: 0,
    tool_category: 'read',
    warning_count: 0,
    write_disposition: '',
    ...overrides,
  });

  const snapshotRows = [
    {
      created_at: ts(-100),
      session_id: 'sess-no-project',
      snapshot_json: JSON.stringify({
        next_actions: ['a'],
        open_questions: ['q'],
      }),
    },
  ];

  const toolRows = [
    // Resume row has no project — must be excluded by design
    makeRow({
      created_at: ts(0),
      project: null,
      session_id: 'sess-no-project',
      tool_name: 'memory_session_resume',
    }),
    makeRow({
      created_at: ts(100),
      project: null,
      session_id: null,
      tool_category: 'write',
      tool_name: 'memory_store',
    }),
  ];

  const mockPool = {
    query: (sql: string) => {
      const rows = sql.includes('ai_session_snapshots') ? snapshotRows : toolRows;
      return Promise.resolve({ rows });
    },
  } as unknown as Pool;

  const result = await computeUsefulnessMetrics({
    pool: mockPool,
    windowEndIso: new Date(BASE + 10_000).toISOString(),
    windowStartIso: new Date(BASE - 10_000).toISOString(),
  });

  assert.equal(result.continuityScore.qualifyingSessions, 0, 'resume without project is excluded by design');
  assert.equal(result.resumeToFirstWriteMs, null, 'no latency when no qualifying sessions');
});

test('computeUsefulnessMetrics closer-resume guard: later qualifying resume blocks earlier resume from claiming a write', async () => {
  // Timeline: Resume A (t=0, qualifying/rich) → Resume B (t=200, qualifying/sparse) → Write (t=300).
  // The write is after BOTH resumes. The closer-resume guard must fire for Resume A:
  // Resume B at t=200 is between A and the write at t=300, so only B claims the write.
  const BASE = 1_700_000_200_000;
  const ts = (offset: number) => new Date(BASE + offset).toISOString();

  const makeRow = (overrides: {
    created_at: string;
    memory_category?: string;
    project?: null | string;
    session_id: null | string;
    status?: string;
    tool_category?: string;
    tool_name: string;
  }) => ({
    durable_memories_deduped: 0,
    duration_ms: null,
    memory_category: '',
    orient_payload_budget_chars: 0,
    orient_payload_budget_exceeded: 0,
    orient_payload_chars: 0,
    orient_payload_tokens_estimate: 0,
    project: 'proj-overlap',
    resolved_via: '',
    response_status: 'ok',
    status: 'ok',
    timeout_warning_count: 0,
    tool_category: 'read',
    warning_count: 0,
    write_disposition: '',
    ...overrides,
  });

  const snapshotRows = [
    // sess-A-prior snapshot predates Resume A (t=0): qualifying, score 4 (rich)
    {
      created_at: ts(-50),
      session_id: 'sess-A-prior',
      snapshot_json: JSON.stringify({
        next_actions: ['a'],
        open_questions: ['q'],
        x_env_model: {},
        x_state_model: {},
      }),
    },
    // sess-B-prior snapshot predates Resume B (t=200): qualifying, score 0 (sparse)
    {
      created_at: ts(150),
      session_id: 'sess-B-prior',
      snapshot_json: JSON.stringify({}),
    },
  ];

  const toolRows = [
    makeRow({
      created_at: ts(0),
      session_id: 'sess-A-prior',
      tool_name: 'memory_session_resume',
    }),
    makeRow({
      created_at: ts(200),
      session_id: 'sess-B-prior',
      tool_name: 'memory_session_resume',
    }),
    // Write is after BOTH resumes — guard must fire for Resume A (B is closer to the write)
    makeRow({
      created_at: ts(300),
      session_id: null,
      tool_category: 'write',
      tool_name: 'memory_store',
    }),
  ];

  const mockPool = {
    query: (sql: string) => {
      const rows = sql.includes('ai_session_snapshots') ? snapshotRows : toolRows;
      return Promise.resolve({ rows });
    },
  } as unknown as Pool;

  const result = await computeUsefulnessMetrics({
    pool: mockPool,
    windowEndIso: new Date(BASE + 10_000).toISOString(),
    windowStartIso: new Date(BASE - 10_000).toISOString(),
  });

  assert.equal(result.continuityScore.qualifyingSessions, 2, 'both resumes qualify (both have prior snapshots)');
  assert.equal(result.continuityScore.richSessions, 1, 'resume A is rich (score 4)');
  assert.equal(result.continuityScore.sparseSessions, 1, 'resume B is sparse (score 0)');
  // Resume B (t=200) is between Resume A (t=0) and the write (t=300) — closer-resume guard fires.
  // Only Resume B claims the write (latency = 300 - 200 = 100ms). Resume A is blocked.
  assert.equal(result.resumeToFirstWriteMs, 100, 'overall median latency = 100 (only resume B claims the write)');
  assert.equal(
    result.reworkAfterResume.richMedianResumeMs,
    null,
    'rich (A) has no write — closer-resume guard blocks it',
  );
  assert.equal(result.reworkAfterResume.sparseMedianResumeMs, 100, 'sparse (B) latency is 100ms');
});

test('computeUsefulnessMetrics closer-resume guard: unqualified later resume does NOT block earlier qualifying resume', async () => {
  // Timeline: Resume A (t=0, qualifying/rich) → Resume B (t=200, unqualified/no snapshot) → Write (t=300).
  // Resume B has no prior snapshot so it is excluded from the exclusivity index.
  // The closer-resume guard must NOT fire for Resume A — A should retain the write.
  const BASE = 1_700_000_300_000;
  const ts = (offset: number) => new Date(BASE + offset).toISOString();

  const makeRow = (overrides: {
    created_at: string;
    memory_category?: string;
    project?: null | string;
    session_id: null | string;
    status?: string;
    tool_category?: string;
    tool_name: string;
  }) => ({
    durable_memories_deduped: 0,
    duration_ms: null,
    memory_category: '',
    orient_payload_budget_chars: 0,
    orient_payload_budget_exceeded: 0,
    orient_payload_chars: 0,
    orient_payload_tokens_estimate: 0,
    project: 'proj-unqualified-b',
    resolved_via: '',
    response_status: 'ok',
    status: 'ok',
    timeout_warning_count: 0,
    tool_category: 'read',
    warning_count: 0,
    write_disposition: '',
    ...overrides,
  });

  const snapshotRows = [
    // Only sess-A-prior has a snapshot — Resume A qualifies, Resume B does not
    {
      created_at: ts(-50),
      session_id: 'sess-A-prior',
      snapshot_json: JSON.stringify({
        next_actions: ['a'],
        open_questions: ['q'],
        x_env_model: {},
        x_state_model: {},
      }),
    },
  ];

  const toolRows = [
    makeRow({
      created_at: ts(0),
      session_id: 'sess-A-prior',
      tool_name: 'memory_session_resume',
    }),
    // Resume B references sess-B-prior which has no snapshot — unqualified
    makeRow({
      created_at: ts(200),
      session_id: 'sess-B-prior',
      tool_name: 'memory_session_resume',
    }),
    // Write is after both resumes — guard must NOT fire for A since B is unqualified
    makeRow({
      created_at: ts(300),
      session_id: null,
      tool_category: 'write',
      tool_name: 'memory_store',
    }),
  ];

  const mockPool = {
    query: (sql: string) => {
      const rows = sql.includes('ai_session_snapshots') ? snapshotRows : toolRows;
      return Promise.resolve({ rows });
    },
  } as unknown as Pool;

  const result = await computeUsefulnessMetrics({
    pool: mockPool,
    windowEndIso: new Date(BASE + 10_000).toISOString(),
    windowStartIso: new Date(BASE - 10_000).toISOString(),
  });

  assert.equal(result.continuityScore.qualifyingSessions, 1, 'only resume A qualifies (B has no prior snapshot)');
  assert.equal(result.continuityScore.richSessions, 1, 'resume A is rich');
  assert.equal(result.continuityScore.sparseSessions, 0, 'resume B is excluded (unqualified)');
  // Resume B is unqualified and absent from the exclusivity index — A retains the write.
  assert.equal(result.resumeToFirstWriteMs, 300, 'resume A latency = 300ms (unqualified B does not block it)');
  assert.equal(result.reworkAfterResume.richMedianResumeMs, 300, 'rich (A) latency is 300ms');
});

test('renderReport includes Usefulness section when usefulness metrics are present', () => {
  const report: HealthReport = {
    ...createMinimalReport(),
    usefulness: {
      continuityScore: {
        qualifyingSessions: 2,
        qualifyingSessions7d: 2,
        qualifyingSessions30d: 2,
        richSessions: 1,
        sparseSessions: 1,
      },
      resumeToFirstWriteMs: 150,
      resumeToFirstWriteP95Ms: 200,
      reworkAfterResume: {
        minBucketSize: 30,
        provisional: true,
        richMedianResumeMs: 200,
        richRepeatedFixes: 0,
        richSessions: 1,
        sparseMedianResumeMs: 100,
        sparseRepeatedFixes: 1,
        sparseSessions: 1,
      },
      windowMinutes: 15,
    },
  };

  const output = renderReport(report);
  assert.ok(output.includes('Usefulness'), 'report should contain Usefulness section header');
  assert.ok(output.includes('Resume-to-first-write latency'), 'report should contain latency line');
});

test('renderReport includes Usefulness 7d/30d counts, p95, and provisional rich-vs-sparse labels', () => {
  const report: HealthReport = {
    ...createMinimalReport(),
    usefulness: {
      continuityScore: {
        qualifyingSessions: 8,
        qualifyingSessions7d: 8,
        qualifyingSessions30d: 24,
        richSessions: 3,
        sparseSessions: 5,
      },
      resumeToFirstWriteMs: 420,
      resumeToFirstWriteP95Ms: 1_200,
      reworkAfterResume: {
        minBucketSize: 30,
        provisional: true,
        richMedianResumeMs: 500,
        richRepeatedFixes: 1,
        richSessions: 3,
        sparseMedianResumeMs: 300,
        sparseRepeatedFixes: 4,
        sparseSessions: 5,
      },
      windowMinutes: 15,
    },
  };

  const output = renderReport(report);

  assert.ok(output.includes('Qualifying resume sessions: 7d=8 30d=24'), 'should show 7d and 30d counts');
  assert.ok(output.includes('p95: 1200ms'), 'should show p95 latency');
  assert.ok(output.includes('Rich-vs-sparse comparison: provisional'), 'should mark small buckets provisional');
  assert.ok(output.includes('n_sparse=5 n_rich=3'), 'should show bucket sample counts');
});

test('renderReport includes Consolidation section when consolidation metrics are present', () => {
  const report: HealthReport = {
    ...createMinimalReport(),
    consolidation: {
      contradictionRatePct: 20,
      daily: [
        {
          avgLatencyMs: 100,
          contradictionsFlagged: 1,
          date: '2026-04-29',
          dedupes: 2,
          none: 1,
          pairsClassified: 5,
          pairsExamined: 6,
          refines: 1,
          sessions: 2,
          supersedes: 1,
        },
      ],
      noActionRatePct: 20,
      topDedupedMemoryKeys: [{ count: 2, memoryKey: 'example/catalog:decision:dup-a' }],
      totals: {
        contradictionsFlagged: 1,
        dedupes: 2,
        none: 1,
        pairsClassified: 5,
        pairsExamined: 6,
        refines: 1,
        sessions: 2,
        supersedes: 1,
      },
    },
  };

  const output = renderReport(report);

  assert.ok(output.includes('Consolidation'), 'report should contain Consolidation section header');
  assert.ok(output.includes('pairs examined=6 classified=5'), 'report should show aggregate pair counts');
  assert.ok(
    output.includes('2026-04-29: sessions=2 pairs examined=6 classified=5'),
    'report should show daily metrics',
  );
  assert.ok(output.includes('example/catalog:decision:dup-a=2'), 'report should show top deduped memory keys');
});

test('renderReport omits Usefulness section when usefulness is absent', () => {
  const report = createMinimalReport();
  const output = renderReport(report);
  assert.ok(!output.includes('Usefulness'), 'report should not contain Usefulness section when absent');
});

test('collectDatabaseMetrics computes continuity adoption-readiness aggregates', async () => {
  const { collectDatabaseMetrics } = (await import('./health-report/data.js')) as {
    collectDatabaseMetrics: (input: {
      pool: Pool;
      windowEndIso: string;
      windowStartIso: string;
    }) => Promise<{ continuityReadiness: HealthReport['database']['continuityReadiness'] }>;
  };

  const mockPool = {
    query: (sql: string) => {
      if (sql.includes('WITH pack_field_flags AS')) {
        return Promise.resolve({
          rows: [
            {
              packs_with_actionable_fields: 2,
              packs_with_context_needed: 0,
              packs_with_decisions: 1,
              packs_with_next_actions: 2,
              packs_with_open_questions: 2,
              total_packs_for_field_completeness: 2,
            },
          ],
        });
      }
      if (sql.includes('WITH raw_pack_reads AS')) {
        assert.ok(
          sql.includes('WHERE session_id IS NOT NULL'),
          'flush-after-pack readiness should only count session-scoped continuity-pack reads',
        );
        assert.ok(
          sql.includes('flush_invocation.session_id = session_pack_reads.session_id'),
          'flush-after-pack readiness should correlate pack reads and flushes by session id',
        );
        assert.ok(
          sql.includes("flush_invocation.tool_name = 'memory_flush'"),
          'flush-after-pack readiness should only count memory_flush calls after pack reads',
        );
        assert.ok(
          sql.includes('flush_invocation.created_at > session_pack_reads.first_pack_read_at'),
          'flush-after-pack readiness should require the flush to happen after the pack read',
        );
        return Promise.resolve({
          rows: [
            {
              pack_degraded_reads: 1,
              pack_found_reads: 1,
              pack_missing_reads: 2,
              pack_read_calls: 4,
              sessions_with_flush_after_pack: 1,
              sessions_with_pack_read: 1,
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    },
  } as unknown as Pool;

  const metrics = await collectDatabaseMetrics({
    pool: mockPool,
    windowEndIso: '2026-06-30T00:00:00.000Z',
    windowStartIso: '2026-06-23T00:00:00.000Z',
  });

  assert.deepEqual(metrics.continuityReadiness, {
    actionableFieldCompletenessPct: 62.5,
    actionableFieldSlots: 8,
    actionableFieldsPopulated: 5,
    packDegradedReads: 1,
    packFoundReads: 1,
    packMissingReads: 2,
    packReadCalls: 4,
    packsWithActionableFields: 2,
    packsWithContextNeeded: 0,
    packsWithDecisions: 1,
    packsWithNextActions: 2,
    packsWithOpenQuestions: 2,
    sessionsWithFlushAfterPack: 1,
    sessionsWithPackRead: 1,
    totalPacksForFieldCompleteness: 2,
  });
});

// ---------------------------------------------------------------------------
// Regression: resolved historical failures must drop out of actionable counts
// ---------------------------------------------------------------------------

test('collectDatabaseMetrics excludes resolved_at IS NOT NULL rows from actionable counts', async () => {
  const { collectDatabaseMetrics } = (await import('./health-report/data.js')) as {
    collectDatabaseMetrics: (input: {
      pool: Pool;
      windowEndIso: string;
      windowStartIso: string;
    }) => Promise<{ actionableFailures: number; ingestionFailures: number; resolvedFailures: number }>;
  };

  // Router-based mock pool: SQL pattern → canned rows.
  // Inputs simulate: 5 historical rows in window, 3 of them resolved (via known-failure
  // resolver), 2 still actionable. A new post-fix unresolved row also stays actionable.
  const resolutionCountsSql = 'COUNT(*) FILTER (WHERE resolved_at IS NULL)::int AS actionable';
  const totalFailuresSqlMarker = 'COUNT(*)::int AS value\n        FROM ai_ingestion_failures';
  const mockPool = {
    query: (sql: string) => {
      if (sql.includes(resolutionCountsSql)) {
        return Promise.resolve({ rows: [{ actionable: 3, resolved_count: 3 }] });
      }
      if (sql.includes(totalFailuresSqlMarker)) {
        return Promise.resolve({ rows: [{ value: 6 }] });
      }
      return Promise.resolve({ rows: [] });
    },
  } as unknown as Pool;

  const metrics = await collectDatabaseMetrics({
    pool: mockPool,
    windowEndIso: '2026-05-12T00:00:00.000Z',
    windowStartIso: '2026-04-12T00:00:00.000Z',
  });

  assert.equal(metrics.resolvedFailures, 3, 'resolved historical rows must appear in resolved counter');
  assert.equal(
    metrics.actionableFailures,
    3,
    'actionable counter must exclude resolved rows (3 resolved out of 6 total → 3 actionable, including post-fix regression)',
  );
});

test('collectDatabaseMetrics: registry-fix-then-regression scenario keeps post-fix row actionable', async () => {
  // Pins the AC contract: when known-failure resolver marks N historical rows resolved,
  // and a brand-new post-fix row with the same signature appears unresolved, the new row
  // remains in the actionable counter (resolved_at IS NULL filter does the right thing).
  const { collectDatabaseMetrics } = (await import('./health-report/data.js')) as {
    collectDatabaseMetrics: (input: {
      pool: Pool;
      windowEndIso: string;
      windowStartIso: string;
    }) => Promise<{ actionableFailures: number; resolvedFailures: number }>;
  };

  const mockPool = {
    query: (sql: string) => {
      if (sql.includes('COUNT(*) FILTER (WHERE resolved_at IS NULL)::int AS actionable')) {
        // 10 rows total in window: 9 historical (all resolved by registry apply) +
        // 1 fresh post-fix regression with same signature (still NULL resolved_at).
        return Promise.resolve({ rows: [{ actionable: 1, resolved_count: 9 }] });
      }
      return Promise.resolve({ rows: [] });
    },
  } as unknown as Pool;

  const metrics = await collectDatabaseMetrics({
    pool: mockPool,
    windowEndIso: '2026-05-12T00:00:00.000Z',
    windowStartIso: '2026-04-12T00:00:00.000Z',
  });

  assert.equal(metrics.actionableFailures, 1, 'post-fix unresolved regression must remain actionable');
  assert.equal(metrics.resolvedFailures, 9, 'previously-resolved historical rows do not regress into actionable');
});

test('buildTopTimeoutOperations aggregates timeout-shaped failure messages by phase', () => {
  const failureSignatureRows = [
    { error_message: 'db.read.search_memories timed out after 5000ms' },
    { error_message: 'db.read.search_memories timed out after 5000ms' },
    { error_message: 'db.read.search_memories.reversal_penalty timed out after 5000ms' },
    { error_message: 'db.write.store_memory timed out after 15000ms' },
    { error_message: 'unrelated failure: connection reset' },
    { error_message: 'memory_orient.search.direct timed out after 5000ms' },
  ];

  const result = buildTopTimeoutOperations({ failureSignatureRows });

  assert.deepEqual(result, [
    { count: 2, phase: 'db.read.search_memories' },
    { count: 1, phase: 'db.read.search_memories.reversal_penalty' },
    { count: 1, phase: 'db.write.store_memory' },
    { count: 1, phase: 'memory_orient.search.direct' },
  ]);
});

test('buildTopTimeoutOperations sorts by descending count then ascending phase', () => {
  const failureSignatureRows = [
    { error_message: 'db.read.alpha timed out after 5000ms' },
    { error_message: 'db.read.beta timed out after 5000ms' },
    { error_message: 'db.read.beta timed out after 5000ms' },
    { error_message: 'db.read.alpha timed out after 5000ms' },
  ];

  const result = buildTopTimeoutOperations({ failureSignatureRows });

  assert.deepEqual(result, [
    { count: 2, phase: 'db.read.alpha' },
    { count: 2, phase: 'db.read.beta' },
  ]);
});

test('buildTopTimeoutOperations skips rows without timeout-shaped messages', () => {
  const failureSignatureRows = [
    { error_message: 'permission denied' },
    { error_message: '' },
    { error_message: null },
    { error_message: undefined },
  ];

  const result = buildTopTimeoutOperations({ failureSignatureRows });

  assert.deepEqual(result, []);
});

test('buildTopTimeoutOperations caps the result at TOP_TIMEOUT_OPERATION_LIMIT', () => {
  const failureSignatureRows = Array.from({ length: 10 }, (_, index) => ({
    error_message: `db.read.phase_${String(index)} timed out after 5000ms`,
  }));

  const result = buildTopTimeoutOperations({ failureSignatureRows });

  assert.equal(result.length, 5, 'top-operation list is bounded to TOP_TIMEOUT_OPERATION_LIMIT');
});

test('buildTopTimeoutOperations merges warning-only timed_out_steps from ai_tool_invocations', () => {
  // Failure signatures: hard failures from MCP tool aborts (TimeoutError).
  const failureSignatureRows = [{ error_message: 'db.read.search_memories timed out after 5000ms' }];
  // Warning-only degradation: tool returned a payload but a sub-step timed out.
  // These rows remain diagnostic even when a successful call's timeout warning
  // is soft enough to stay out of the launch-gate timeout count.
  const toolInvocationTimedOutStepsRows = [
    { timed_out_steps: 'memory_orient.search.direct' },
    { timed_out_steps: 'memory_orient.search.direct,memory_orient.search.temporal' },
    { timed_out_steps: 'embedding.search_memories' },
    { timed_out_steps: '' },
    { timed_out_steps: null },
  ];

  const result = buildTopTimeoutOperations({ failureSignatureRows, toolInvocationTimedOutStepsRows });

  assert.deepEqual(result, [
    { count: 2, phase: 'memory_orient.search.direct' },
    { count: 1, phase: 'db.read.search_memories' },
    { count: 1, phase: 'embedding.search_memories' },
    { count: 1, phase: 'memory_orient.search.temporal' },
  ]);
});

test('buildTopTimeoutOperations treats missing toolInvocationTimedOutStepsRows as empty', () => {
  const failureSignatureRows = [{ error_message: 'db.read.alpha timed out after 5000ms' }];

  const result = buildTopTimeoutOperations({ failureSignatureRows });

  assert.deepEqual(result, [{ count: 1, phase: 'db.read.alpha' }]);
});

// ---------------------------------------------------------------------------
// The health-report pool must not trigger the pg client-query deprecation warning:
// register an on('connect') handler that issues `SET statement_timeout` after
// pg.Client opens, because pg dispatches the first queued query against the
// same client at the same time, tripping the `Calling client.query() when the
// client is already executing a query is deprecated and will be removed in
// pg@9.0` warning. Instead, deliver timeouts via pg startup parameters
// (statement_timeout, idle_in_transaction_session_timeout) — pg/lib/client.js
// `getStartupConf` lines 525-532 wire these into the protocol startup message
// directly, no SET needed.
// ---------------------------------------------------------------------------

test('resolveHealthReportPoolConfig disables on-connect SET and delivers timeouts as startup params', async () => {
  const { resolveHealthReportPoolConfig } = (await import('./health-report.js')) as {
    resolveHealthReportPoolConfig: (config: { connectionString?: string; pgOptions?: Record<string, unknown> }) => {
      idleInTransactionTimeoutMs?: number;
      pgOptions?: Record<string, unknown>;
      statementTimeoutMs?: number;
    };
  };

  const resolved = resolveHealthReportPoolConfig({ connectionString: 'postgresql://localhost:5432/test' });

  // Explicit startup parameters avoid a separate SET query on each client.
  assert.equal(resolved.statementTimeoutMs, 0, 'statementTimeoutMs: 0 avoids an extra session initialization query');
  assert.equal(
    resolved.idleInTransactionTimeoutMs,
    0,
    'idleInTransactionTimeoutMs: 0 avoids an extra session initialization query',
  );

  // pg.Client.getStartupConf (pg/lib/client.js:525-532) wires these directly into the
  // Postgres startup-message packet, so the server applies them before any application
  // query runs — no client.query() needed, no concurrent queue, no warning.
  const pgOptions = resolved.pgOptions ?? {};
  assert.ok(
    typeof pgOptions.statement_timeout === 'number' && pgOptions.statement_timeout > 0,
    'pgOptions.statement_timeout must be set to apply timeout via startup parameter',
  );
  assert.ok(
    typeof pgOptions.idle_in_transaction_session_timeout === 'number' &&
      pgOptions.idle_in_transaction_session_timeout > 0,
    'pgOptions.idle_in_transaction_session_timeout must be set to apply timeout via startup parameter',
  );
});

test('resolveHealthReportPoolConfig preserves caller pgOptions while still zeroing session defaults', async () => {
  const { resolveHealthReportPoolConfig } = (await import('./health-report.js')) as {
    resolveHealthReportPoolConfig: (config: { connectionString?: string; pgOptions?: Record<string, unknown> }) => {
      pgOptions?: Record<string, unknown>;
    };
  };

  const resolved = resolveHealthReportPoolConfig({
    connectionString: 'postgresql://localhost:5432/test',
    pgOptions: { application_name: 'health-report-test' },
  });

  assert.equal(resolved.pgOptions?.application_name, 'health-report-test', 'caller-provided pgOptions must survive');
  const pgOptions = resolved.pgOptions ?? {};
  assert.ok(
    typeof pgOptions.statement_timeout === 'number' && pgOptions.statement_timeout > 0,
    'startup-parameter timeouts still applied alongside caller pgOptions',
  );
});

// NOTE: the behavioral regression test for pg@9 client.query deprecation under
// concurrent metric load lives in `health-report-pool.test.ts`. That test installs a
// top-level `vi.doMock('pg', ...)` so it can intercept pool construction and
// observe per-client query interleaving — the precondition for the warning — directly.
// Keeping it in a separate file is necessary because module mocks only affect modules
// imported after the mock is registered, and this file statically imports `health-report.js`.

test('collectDatabaseMetrics produces the timeout evidence shape and surfaces it through renderReport', async () => {
  // Regression guard: the prior version of this test manually constructed a
  // post-collection HealthReport, so a SQL-layer regression that misclassified resolved
  // historical rows as cleanup debt would still pass. This rewrite exercises
  // `collectDatabaseMetrics` end-to-end with a routing mock pool so the new
  // unresolved/resolved-per-window split, the writer-participation family grouping, and
  // the renderer's labels are all tied to the data-layer output.
  //
  // Scenario from the issue body:
  //   - active window:        0 unresolved, 0 resolved, 0 total → "no active incidents"
  //   - historical window:    100 unresolved debt, 25 resolved → distinct labels
  //   - writer mix:           15 raw sources spanning all four families
  //   - no pg client.query() deprecation warning may be emitted while collecting
  type CollectedDatabaseMetrics = Omit<HealthReport['database'], 'databaseUrl'>;
  const { collectDatabaseMetrics } = (await import('./health-report/data.js')) as {
    collectDatabaseMetrics: (input: {
      pool: Pool;
      windowEndIso: string;
      windowStartIso: string;
    }) => Promise<CollectedDatabaseMetrics>;
  };

  // 15 raw durable-writer sources spanning every family bucket. The family classifier
  // groups these into claude / codex / manual / system, with no `other` fall-through.
  const durableWriterMixRows = [
    { count: 320, source: 'claude-code' },
    { count: 210, source: 'claude-session-end' },
    { count: 180, source: 'codex' },
    { count: 160, source: 'codex-wrapper' },
    { count: 120, source: 'codex-launchd' },
    { count: 90, source: 'codex-hook' },
    { count: 80, source: 'codex-retro' },
    { count: 70, source: 'background-worker' },
    { count: 60, source: 'retro' },
    { count: 50, source: 'retention' },
    { count: 40, source: 'manual' },
    { count: 30, source: 'manual-flush' },
    { count: 25, source: 'memory-flush' },
    { count: 20, source: 'sample-job-builder' },
    { count: 12, source: 'agent' },
  ];

  // Process-warning observer covering the entire collection pass. The pg@9 deprecation
  // condition lives behind the on-connect SET path and is mode-agnostic; tying the
  // assertion to a real concurrent metric call makes this the strongest signal possible
  // from a non-mock-pg test (a fully behavioral pg mock lives in health-report-pool.test.ts).
  const observedWarnings: string[] = [];
  const warningListener = (warning: Error): void => {
    observedWarnings.push(warning.message);
  };
  process.on('warning', warningListener);

  const ACTIVE_WINDOW_END_MARKER = 'created_at <= $2::timestamptz';
  const HISTORICAL_WINDOW_END_MARKER = 'created_at < $2::timestamptz';
  const RESOLVED_SPLIT_MARKER = 'COUNT(*) FILTER (WHERE resolved_at IS NULL)::int AS unresolved';

  const mockPool = {
    query: (sql: string) => {
      // Active-window counts: zero everywhere (no active incidents).
      if (sql.includes(RESOLVED_SPLIT_MARKER) && sql.includes(ACTIVE_WINDOW_END_MARKER)) {
        return Promise.resolve({ rows: [{ resolved: 0, total: 0, unresolved: 0 }] });
      }
      // Historical-window counts: 100 unresolved debt + 25 resolved historical rows.
      // The renderer must distinguish these, not collapse them under "cleanup debt".
      if (sql.includes(RESOLVED_SPLIT_MARKER) && sql.includes(HISTORICAL_WINDOW_END_MARKER)) {
        return Promise.resolve({ rows: [{ resolved: 25, total: 125, unresolved: 100 }] });
      }
      // Active failure sources: none, because there are no active failures.
      if (
        sql.includes('SELECT source, COUNT(*)::int AS count') &&
        sql.includes('FROM ai_ingestion_failures') &&
        sql.includes(ACTIVE_WINDOW_END_MARKER)
      ) {
        return Promise.resolve({ rows: [] });
      }
      // Historical failure sources: concentrated on codex-wrapper (matches PR evidence).
      if (
        sql.includes('SELECT source, COUNT(*)::int AS count') &&
        sql.includes('FROM ai_ingestion_failures') &&
        sql.includes(HISTORICAL_WINDOW_END_MARKER)
      ) {
        return Promise.resolve({ rows: [{ count: 100, source: 'codex-wrapper' }] });
      }
      // Durable writer mix: the 15-source fan-out the family gate is built to handle.
      if (sql.includes('SELECT source, COUNT(*)::int AS count') && sql.includes('FROM ai_memory_entries')) {
        return Promise.resolve({ rows: durableWriterMixRows });
      }
      // resolutionCounts (full-window): 100 unresolved + 25 resolved = 125 total.
      if (sql.includes('COUNT(*) FILTER (WHERE resolved_at IS NULL)::int AS actionable')) {
        return Promise.resolve({ rows: [{ actionable: 100, resolved_count: 25 }] });
      }
      // Total ingestion failures in the report window.
      if (
        sql.includes('SELECT COUNT(*)::int AS value') &&
        sql.includes('FROM ai_ingestion_failures WHERE created_at >= $1')
      ) {
        return Promise.resolve({ rows: [{ value: 125 }] });
      }
      // All other count/row queries default to empty so collection completes without
      // throwing. The assertions below cover only the fields this test pins.
      return Promise.resolve({ rows: [] });
    },
  } as unknown as Pool;

  let metrics: CollectedDatabaseMetrics;
  try {
    metrics = await collectDatabaseMetrics({
      pool: mockPool,
      windowEndIso: '2026-05-12T00:00:00.000Z',
      windowStartIso: '2026-05-05T00:00:00.000Z',
    });
  } finally {
    process.off('warning', warningListener);
  }

  // -------- Collection-layer assertions: failureWindows split --------

  assert.equal(metrics.failureWindows.active.unresolved, 0, 'active window must report zero unresolved');
  assert.equal(metrics.failureWindows.active.resolved, 0, 'active window must report zero resolved');
  assert.equal(metrics.failureWindows.active.total, 0, 'active window total must be zero');

  assert.equal(
    metrics.failureWindows.historical.unresolved,
    100,
    'historical unresolved debt must be carried forward to the metric',
  );
  assert.equal(
    metrics.failureWindows.historical.resolved,
    25,
    'historical resolved rows must NOT be folded into the debt counter',
  );
  assert.equal(
    metrics.failureWindows.historical.total,
    125,
    'historical total must include both unresolved and resolved',
  );

  // -------- Collection-layer assertions: writer participation family grouping --------

  assert.equal(metrics.writerParticipationHealth.totalSources, 15, 'all 15 raw sources must be counted');
  const families = metrics.writerParticipationHealth.families.map(f => f.family).sort((a, b) => a.localeCompare(b));
  assert.deepEqual(
    families,
    ['claude', 'codex', 'manual', 'system'],
    'writer mix must group into four stable families with no other fall-through',
  );

  // -------- Render-layer assertions: labels reflect the collection-layer split --------

  const renderInput = createMinimalReport({
    database: {
      actionableFailures: metrics.actionableFailures,
      durableWriterMix: metrics.durableWriterMix,
      failureWindows: metrics.failureWindows,
      ingestionFailures: metrics.ingestionFailures,
      mttr: metrics.mttr,
      resolvedFailures: metrics.resolvedFailures,
      writerParticipationHealth: metrics.writerParticipationHealth,
    },
  });
  const output = renderReport(renderInput);

  assert.ok(output.includes('Active failures'), 'render must surface the active-window header');
  assert.ok(
    output.includes('Unresolved=0, Resolved=0 (no active incidents)'),
    'active-window 0/0 must read as "no active incidents", not "active incidents"',
  );
  assert.ok(output.includes('Historical failures'), 'render must surface the historical-window header');
  assert.ok(
    output.includes('Unresolved debt=100, Resolved=25 (historical cleanup debt'),
    'historical render must split unresolved debt from resolved historical rows',
  );

  // Writer participation rendering still uses family-level grouping.
  assert.ok(output.includes('Writer participation:'), 'render must include writer participation header for ≥2 sources');
  assert.ok(output.includes('4 families across 15 sources'), 'family + source counts must both render');
  assert.ok(output.includes('per-family min 10%'), 'family threshold must be announced');
  assert.ok(
    !/LOW: claude-code|LOW: codex-wrapper/.test(output),
    'no raw per-source LOW flags may appear — gating must be family-level',
  );

  // Raw per-source counts remain accessible via the durable-writer-mix line.
  assert.ok(output.includes('claude-code=320'), 'raw per-source counts must remain visible for debugging');
  assert.ok(output.includes('codex-wrapper=160'), 'raw per-source counts must remain visible for debugging');

  // -------- No pg@9 deprecation warning may surface during collection --------

  const offendingWarning = observedWarnings.find(message =>
    message.includes('Calling client.query() when the client is already executing a query'),
  );
  assert.equal(
    offendingWarning,
    undefined,
    'no pg@9 client.query deprecation warning may fire during the healthy collection path',
  );
});
