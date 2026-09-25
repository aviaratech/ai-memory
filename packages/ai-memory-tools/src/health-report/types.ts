import type { ResolvedLogPath, StrategyConfidence, TaxonomyTier } from '@aviaratech/ai-memory/internal';

import type { LaunchGatesReport } from '../launch-gates.js';

export type CalibrationActualOutcome = 'failure' | 'partial' | 'success';

export interface CalibrationBin {
  avgActual: number;
  avgPredicted: number;
  count: number;
  error: number;
  range: string;
}

export interface CalibrationMetrics {
  assessment: null | string;
  brierScore: null | number;
  ece: ECEResult | null;
  signalCount: number;
}

export interface CalibrationSignal {
  actual: CalibrationActualOutcome;
  actualOutcome: number;
  predicted: StrategyConfidence;
  predictedProbability: number;
}

export interface CategoryCountMetric {
  category: string;
  count: number;
}

export interface ConsolidationDailyMetric {
  avgLatencyMs: number;
  contradictionsFlagged: number;
  date: string;
  dedupes: number;
  none: number;
  pairsClassified: number;
  pairsExamined: number;
  refines: number;
  sessions: number;
  supersedes: number;
}

export interface ConsolidationMetrics {
  contradictionRatePct: number;
  daily: ConsolidationDailyMetric[];
  noActionRatePct: number;
  topDedupedMemoryKeys: ConsolidationTopMemoryKeyMetric[];
  totals: ConsolidationTotalsMetric;
}

export interface ConsolidationTopMemoryKeyMetric {
  count: number;
  memoryKey: string;
}

export interface ConsolidationTotalsMetric {
  contradictionsFlagged: number;
  dedupes: number;
  none: number;
  pairsClassified: number;
  pairsExamined: number;
  refines: number;
  sessions: number;
  supersedes: number;
}

export interface ContinuityAdoptionMetrics {
  agentWriterCompliancePct: number;
  agentWriterCompliant: number;
  agentWriterFlushes: number;
  /**
   * Snapshot counts produced through the automatic ingestion channels (codex-hook,
   * claude-session-end, codex-launchd, codex-wrapper). State-model coverage on this
   * channel is bounded by carry-forward from a prior explicit flush in the same
   * session.
   */
  auto: ContinuityChannelMetrics;
  contextNeededNonEmpty: number;
  envModelPresent: number;
  /** Snapshot counts produced through explicit `memory_flush` calls. */
  flush: ContinuityChannelMetrics;
  nextActionsNonEmpty: number;
  openQuestionsNonEmpty: number;
  snapshots: number;
  stateModelPresent: number;
  /** Snapshots whose source delta could not be classified. */
  unknown: ContinuityChannelMetrics;
}

export interface ContinuityChannelMetrics {
  contextNeededCarriedForward: number;
  contextNeededDerived: number;
  contextNeededNonEmpty: number;
  envModelPresent: number;
  nextActionsCarriedForward: number;
  nextActionsDerived: number;
  nextActionsNonEmpty: number;
  openQuestionsCarriedForward: number;
  openQuestionsDerived: number;
  openQuestionsNonEmpty: number;
  snapshots: number;
  stateModelPresent: number;
}

export interface ContinuityPackMetrics {
  avgPayloadChars: number;
  maxPayloadBudgetPct: number;
  maxPayloadChars: number;
  packs: number;
  updatedInWindow: number;
}

export interface ContinuityReadinessMetrics {
  actionableFieldCompletenessPct: number;
  actionableFieldSlots: number;
  actionableFieldsPopulated: number;
  packDegradedReads: number;
  packFoundReads: number;
  packMissingReads: number;
  packReadCalls: number;
  packsWithActionableFields: number;
  packsWithContextNeeded: number;
  packsWithDecisions: number;
  packsWithNextActions: number;
  packsWithOpenQuestions: number;
  sessionsWithFlushAfterPack: number;
  sessionsWithPackRead: number;
  totalPacksForFieldCompleteness: number;
}

export interface DatabaseMetrics {
  actionableFailures: number;
  calibration: CalibrationMetrics;
  contextPacksIngested: number;
  continuityAdoption: ContinuityAdoptionMetrics;
  continuityPacks: ContinuityPackMetrics;
  continuityReadiness: ContinuityReadinessMetrics;
  decisionReversalRate: DecisionReversalMetric;
  deltasIngested: number;
  deltaSourceMix: DeltaSourceMixMetric[];
  durableMemoriesCreated: number;
  durableMemoriesUpdated: number;
  durableWriterMix: DurableWriterMixMetric[];
  failuresBySource: FailureBySourceMetric[];
  failuresByStage: FailureByStageMetric[];
  failureWindows: FailureWindowsMetric;
  ingestionFailures: number;
  memoryTypeNullRatePct: number;
  memoryTypeNullSampleCount: number;
  mttr: MttrMetrics;
  reflect: ReflectMetrics;
  repeatedFixRate: RepeatedFixMetric[];
  resolvedFailures: number;
  sessionEndConflictRate14d: SessionEndConflictRateMetric;
  sessionsStarted: number;
  stateModelAdoptionPct: number;
  taxonomyDistribution: TaxonomyDistributionMetric[];
  topFailureSignatures: FailureSignatureMetric[];
  topTimeoutOperations: TimeoutOperationMetric[];
  writeCalibration: WriteCalibrationMetrics;
  writerParticipationHealth: WriterParticipationHealth;
}

export interface DecisionReversalByCategoryMetric {
  category: TrackedDecisionCategory;
  count: number;
  denominator: number;
  rate: number;
}

export interface DecisionReversalMetric {
  byCategory: DecisionReversalByCategoryMetric[];
  count: number;
  denominator: number;
  rate: number;
}

export interface DeltaSourceMixMetric {
  count: number;
  pct: number;
  source: string;
}

export interface DurableWriterMixMetric {
  count: number;
  pct: number;
  source: string;
}

export interface ECEResult {
  bins: CalibrationBin[];
  ece: number;
}

export interface FailureBySourceMetric {
  count: number;
  source: string;
}

export interface FailureByStageMetric {
  count: number;
  stage: string;
}

export interface FailureSignatureMetric {
  count: number;
  signature: string;
  sources: FailureSignatureSourceMetric[];
}

export interface FailureSignatureSourceMetric {
  count: number;
  source: string;
}

export interface FailureWindowMetric {
  end: string;
  /**
   * Rows created in this window whose `resolved_at IS NOT NULL`. For the historical
   * window these are debt rows that have since been closed (no longer cleanup debt).
   */
  resolved: number;
  sources: FailureBySourceMetric[];
  start: string;
  total: number;
  /**
   * Rows created in this window whose `resolved_at IS NULL`. For the active window
   * these are current incidents needing operator action. For the historical window
   * these are unresolved historical cleanup debt.
   */
  unresolved: number;
}

export interface FailureWindowsMetric {
  active: FailureWindowMetric;
  historical: FailureWindowMetric;
}

export interface HealthReport {
  consolidation?: ConsolidationMetrics | undefined;
  database: ReportDatabaseMetrics;
  generatedAt: string;
  launchGates: LaunchGatesReport;
  mcpUsage: McpUsageMetrics;
  orchestration: OrchestrationMetrics;
  period: {
    days: number;
    end: string;
    start: string;
  };
  retention: RetentionMetrics;
  usefulness?: undefined | UsefulnessMetrics;
}

export type JsonRecord = Record<string, unknown>;

export interface McpUsageMetrics {
  dedupeSuppressed: number;
  errors: number;
  invocations: number;
  logFile: string;
  logFileSource: ResolvedLogPath['source'];
  orient: OrientMetrics;
  readInvocations: number;
  resume: ResumeMetrics;
  successfulInvocations: number;
  successRatePct: number;
  telemetryError?: string;
  telemetrySource: 'db' | 'unavailable';
  tools: ToolUsageSummary[];
  toolTelemetryCoverage: 'full' | 'none';
  writeInvocations: number;
}

export interface MttrMetrics {
  avgMinutes: number;
  resolved: number;
  total: number;
  unresolved: number;
}

export interface OrchestrationMetrics {
  approvalRatePct: number;
  approved: number;
  avgRoundsPerRun: number;
  error: number;
  insightFiles: number;
  issueSeedFiles: number;
  notApproved: number;
  retroDirectory: string;
  retroMarkdownFiles: number;
  runs: number;
  totalTokens: number;
  transcriptDirectory: string;
}

export interface OrientMetrics {
  calls: number;
  degraded: number;
  errors: number;
  ok: number;
  partial: number;
  payloadBudgetChars: number;
  payloadBudgetExceeded: number;
  payloadBudgetExceededRatePct: number;
  payloadCharsAvg: number;
  payloadCharsMax: number;
  payloadCharsP95: number;
  payloadSamples: number;
  payloadTokensAvg: number;
  timeoutRatePct: number;
  timeouts: number;
  timeoutTargetPct: number;
}

export interface ReflectCycleMetric {
  completedAt: null | string;
  cycleId: null | string;
  evaluationCountAtReflection: null | number;
  provisionalMethodologyMemoriesWritten: number;
  skippedTargets: string[];
  triggeredBy: null | string;
}

export interface ReflectMetrics {
  cyclesInWindow: number;
  evaluationsSinceLastCycle: null | number;
  lastCycleIso: null | string;
  provisionalMethodologyMemoriesWritten: number;
  recentCycles: ReflectCycleMetric[];
}

export interface RepeatedFixMetric {
  count: number;
  memoryIds: number[];
  module: string;
}

export interface ReportDatabaseMetrics extends DatabaseMetrics {
  databaseUrl: string;
}

export interface ResumeMetrics {
  calls: number;
  errors: number;
  notFound: number;
  ok: number;
  okDirect: number;
  okFallback: number;
}

export interface RetentionBacklogEntry {
  candidates: number;
  dataset: string;
  newestCreatedAt?: string | undefined;
  oldestCreatedAt?: string | undefined;
}

export interface RetentionConfigSummary {
  auditDays: number;
  batchSize: number;
  expiredGraceDays: number;
  failureDays: number;
  sessionDays: number;
  supersededDays: number;
  telemetryDays: number;
}

export interface RetentionLastRun {
  dryRun: boolean;
  durationMs: number;
  errorCount: number;
  status: string;
  timestamp: string;
  totalCandidates: number;
  totalDeleted: number;
}

export interface RetentionMetrics {
  backlog: RetentionBacklogEntry[];
  config: RetentionConfigSummary;
  lastRun: null | RetentionLastRun;
  totalBacklog: number;
}

export interface ReworkAfterResumeMetric {
  minBucketSize: number;
  provisional: boolean;
  richMedianResumeMs: null | number;
  richRepeatedFixes: number;
  richSessions: number;
  sparseMedianResumeMs: null | number;
  sparseRepeatedFixes: number;
  sparseSessions: number;
}

export interface SessionEndConflictRateMetric {
  conflictCount: number;
  ratePct: number;
  targetMet: boolean;
  targetPct: number;
  windowDays: number;
  writeCount: number;
}

export interface SqlQuery {
  params?: unknown[];
  sql: string;
}

export interface TaxonomyDistributionMetric {
  count: number;
  pct: number;
  tier: TaxonomyTier;
}

export interface TimeoutOperationMetric {
  /** Number of timeout-shaped failures attributed to this phase in the window. */
  count: number;
  /**
   * Phase name extracted from the leading `<phase> timed out after <n>ms` token of the failure
   * message. Conventional shapes: `db.read.<op>`, `db.write.<op>`, `memory_orient.<step>`.
   */
  phase: string;
}

export interface ToolAggregate {
  _durations: number[];
  calls: number;
  environmentStatusCounts: Record<string, number>;
  errors: number;
  responseStatusCounts: Record<string, number>;
  successes: number;
  toolCategory: string;
  toolName: string;
}

export interface ToolInvocation {
  durableMemoriesDeduped: number;
  durationMs: null | number;
  environmentStatus: string;
  orientPayloadBudgetChars: number;
  orientPayloadBudgetExceeded: number;
  orientPayloadChars: number;
  orientPayloadTokensEstimate: number;
  resolvedVia: string;
  responseStatus: string;
  status: string;
  timeoutWarningCount: number;
  toolCategory: string;
  toolName: string;
  warningCount: number;
  writeDisposition: string;
}

export interface ToolUsageSummary {
  avgDurationMs: number;
  calls: number;
  environmentStatusCounts?: Record<string, number> | undefined;
  errors: number;
  p95DurationMs: number;
  responseStatusCounts?: Record<string, number> | undefined;
  successes: number;
  successRatePct: number;
  toolCategory: string;
  toolName: string;
}

export type TrackedDecisionCategory = 'architecture' | 'convention' | 'decision';

export interface UsefulnessContinuityScore {
  qualifyingSessions: number;
  qualifyingSessions7d: number;
  qualifyingSessions30d: number;
  richSessions: number;
  sparseSessions: number;
}

export interface UsefulnessMetrics {
  continuityScore: UsefulnessContinuityScore;
  resumeToFirstWriteMs: null | number;
  resumeToFirstWriteP95Ms: null | number;
  reworkAfterResume: ReworkAfterResumeMetric;
  windowMinutes: number;
}

export interface WriteCalibrationCell {
  author: string;
  avgCalibratedConfidence: number;
  avgDeclaredConfidence: number;
  brierScore: null | number;
  category: string;
  memoryCount: number;
  reversalRate: number;
}

export interface WriteCalibrationMetrics {
  cells: WriteCalibrationCell[];
  topDepleted: WriteCalibrationCell[];
}

/**
 * Stable buckets for writer participation. The raw `source` label space is high cardinality
 * (codex-wrapper, codex-launchd, codex-hook, claude-code, claude-session-end, manual,
 * background workers, retro, etc.) and grows organically. A per-source minimum-share gate is
 * infeasible at this cardinality (15 sources × 20% = 300% required), so the gate operates
 * on families instead. New raw labels fall through to `other`.
 */
export type WriterParticipationFamily = 'claude' | 'codex' | 'manual' | 'other' | 'system';

export interface WriterParticipationFamilyMetric {
  family: WriterParticipationFamily;
  pct: number;
  sources: string[];
  writes: number;
}

export interface WriterParticipationFlag {
  actualPct: number;
  family: WriterParticipationFamily;
  writes: number;
}

export interface WriterParticipationHealth {
  belowThreshold: WriterParticipationFlag[];
  /**
   * Per-family writer participation. Raw sources (~15+ distinct labels in real reports)
   * are grouped into stable families so the participation gate has a mathematically
   * feasible denominator. Raw per-source counts remain available via `durableWriterMix`.
   */
  families: WriterParticipationFamilyMetric[];
  healthy: boolean;
  /** Minimum share each family must hold to be considered healthy (per-family, not per-source). */
  minPct: number;
  totalSources: number;
  totalWrites: number;
}
