import type {
  ConsolidationMetrics,
  ContinuityAdoptionMetrics,
  DatabaseMetrics,
  FailureByStageMetric,
  FailureSignatureMetric,
  HealthReport,
  McpUsageMetrics,
  OrchestrationMetrics,
  ReflectMetrics,
  RetentionMetrics,
  TaxonomyDistributionMetric,
  TimeoutOperationMetric,
  UsefulnessMetrics,
  WriteCalibrationMetrics,
  WriterParticipationHealth,
} from './types.js';

import { LAUNCH_GATE_CONTESTED_SAMPLE_TARGET, LAUNCH_GATE_THRESHOLDS } from '../launch-gates.js';
import {
  DEFAULT_CALIBRATION_MIN_SIGNALS,
  DEFAULT_DECISION_REVERSAL_WINDOW_DAYS,
  DEFAULT_REPEATED_FIX_WINDOW_DAYS,
  TOP_FAILURE_SIGNATURE_LIMIT,
  TOP_TIMEOUT_OPERATION_LIMIT,
} from './constants.js';
import { formatNumber, formatPercent, percent } from './utils.js';

const CONTINUITY_PAYLOAD_COMPLETENESS_TARGET_PCT = 95;
const CONTINUITY_PACK_BUDGET_PRESSURE_TARGET_PCT = 90;
const CONTINUITY_PACK_READ_LATENCY_TARGET_MS = 500;
const CONTINUITY_PACK_READ_SUCCESS_TARGET_PCT = 99;

export function renderReport(report: HealthReport): string {
  const lines: string[] = [];
  lines.push('AI Memory Health Report');
  lines.push(`Period: ${report.period.start} to ${report.period.end} (${String(report.period.days)}d)`);
  lines.push(`Database: ${report.database.databaseUrl}`);
  lines.push('');

  renderIngestionSection(lines, report.database);
  renderLaunchGateSection(lines, report);
  renderMcpUsageSection(lines, report.mcpUsage);
  renderWriteCalibrationSection(lines, report.database.writeCalibration);
  renderReflectSection(lines, report.database.reflect);
  renderOrchestrationSection(lines, report.orchestration);
  renderRetentionSection(lines, report.retention);
  renderConsolidationSection(lines, report.consolidation);
  renderUsefulnessSection(lines, report.usefulness);
  renderOutcomeSignalsSection(lines, report.database);

  return `${lines.join('\n')}\n`;
}

function renderConsolidationSection(lines: string[], consolidation: ConsolidationMetrics | undefined): void {
  if (consolidation === undefined) {
    return;
  }

  lines.push('Consolidation');
  const totals = consolidation.totals;
  lines.push(
    `- Totals: sessions=${String(totals.sessions)} pairs examined=${String(totals.pairsExamined)} ` +
      `classified=${String(totals.pairsClassified)} dedupes=${String(totals.dedupes)} ` +
      `supersedes=${String(totals.supersedes)} refines=${String(totals.refines)} ` +
      `none=${String(totals.none)} contradictions=${String(totals.contradictionsFlagged)}`,
  );
  lines.push(
    `- Rates: contradiction=${formatPercent(consolidation.contradictionRatePct)} ` +
      `none=${formatPercent(consolidation.noActionRatePct)}`,
  );

  if (consolidation.daily.length === 0) {
    lines.push('- Daily metrics: no consolidation metric events in window');
  } else {
    lines.push('- Daily metrics:');
    for (const day of consolidation.daily) {
      lines.push(
        `  - ${day.date}: sessions=${String(day.sessions)} pairs examined=${String(day.pairsExamined)} ` +
          `classified=${String(day.pairsClassified)} dedupes=${String(day.dedupes)} ` +
          `supersedes=${String(day.supersedes)} refines=${String(day.refines)} ` +
          `none=${String(day.none)} contradictions=${String(day.contradictionsFlagged)} ` +
          `avgLatency=${formatNumber(day.avgLatencyMs, 0)}ms`,
      );
    }
  }

  if (consolidation.topDedupedMemoryKeys.length > 0) {
    const top = consolidation.topDedupedMemoryKeys
      .map(metric => `${metric.memoryKey}=${String(metric.count)}`)
      .join(', ');
    lines.push(`- Top deduped memoryKeys: ${top}`);
  } else {
    lines.push('- Top deduped memoryKeys: none');
  }
  lines.push('');
}

function renderContinuityAdoptionLine(lines: string[], continuity: ContinuityAdoptionMetrics): void {
  if (continuity.snapshots === 0) {
    lines.push('- Snapshot continuity adoption: no session snapshots in window');
    return;
  }

  lines.push(
    `- Snapshot continuity adoption: snapshots=${String(continuity.snapshots)} ` +
      `next_actions=${String(continuity.nextActionsNonEmpty)} ` +
      `(${formatPercent(percent(continuity.nextActionsNonEmpty, continuity.snapshots))}) ` +
      `context_needed=${String(continuity.contextNeededNonEmpty)} ` +
      `(${formatPercent(percent(continuity.contextNeededNonEmpty, continuity.snapshots))}) ` +
      `open_questions=${String(continuity.openQuestionsNonEmpty)} ` +
      `(${formatPercent(percent(continuity.openQuestionsNonEmpty, continuity.snapshots))}) ` +
      `x_state_model=${String(continuity.stateModelPresent)} ` +
      `(${formatPercent(percent(continuity.stateModelPresent, continuity.snapshots))}) ` +
      `x_env_model=${String(continuity.envModelPresent)} ` +
      `(${formatPercent(percent(continuity.envModelPresent, continuity.snapshots))})`,
  );
  renderContinuityChannelLine({ channel: continuity.flush, label: 'flush (explicit memory_flush)', lines });
  renderContinuityChannelLine({ channel: continuity.auto, label: 'auto (derived/carry-forward)', lines });
  if (continuity.unknown.snapshots > 0) {
    renderContinuityChannelLine({ channel: continuity.unknown, label: 'unknown (no source delta)', lines });
  }
}

function renderContinuityChannelLine(input: {
  channel: ContinuityAdoptionMetrics['auto'];
  label: string;
  lines: string[];
}): void {
  const { channel, label, lines } = input;
  if (channel.snapshots === 0) {
    return;
  }
  lines.push(
    `  - ${label}: snapshots=${String(channel.snapshots)} ` +
      `next_actions=${String(channel.nextActionsNonEmpty)} ` +
      `(${formatPercent(percent(channel.nextActionsNonEmpty, channel.snapshots))}) ` +
      `context_needed=${String(channel.contextNeededNonEmpty)} ` +
      `(${formatPercent(percent(channel.contextNeededNonEmpty, channel.snapshots))}) ` +
      `open_questions=${String(channel.openQuestionsNonEmpty)} ` +
      `(${formatPercent(percent(channel.openQuestionsNonEmpty, channel.snapshots))}) ` +
      `x_state_model=${String(channel.stateModelPresent)} ` +
      `(${formatPercent(percent(channel.stateModelPresent, channel.snapshots))}) ` +
      `x_env_model=${String(channel.envModelPresent)} ` +
      `(${formatPercent(percent(channel.envModelPresent, channel.snapshots))})`,
  );
  if (
    channel.nextActionsDerived > 0 ||
    channel.openQuestionsDerived > 0 ||
    channel.contextNeededDerived > 0 ||
    channel.nextActionsCarriedForward > 0 ||
    channel.openQuestionsCarriedForward > 0 ||
    channel.contextNeededCarriedForward > 0
  ) {
    lines.push(
      `    derived next_actions=${String(channel.nextActionsDerived)} ` +
        `open_questions=${String(channel.openQuestionsDerived)} ` +
        `context_needed=${String(channel.contextNeededDerived)}; ` +
        `carry_forward next_actions=${String(channel.nextActionsCarriedForward)} ` +
        `open_questions=${String(channel.openQuestionsCarriedForward)} ` +
        `context_needed=${String(channel.contextNeededCarriedForward)}`,
    );
  }
}

function renderContinuityPackBudgetPressureLine(
  lines: string[],
  continuityPacks: DatabaseMetrics['continuityPacks'],
): void {
  if (continuityPacks.packs === 0) {
    lines.push('- Continuity pack budget pressure: no packs materialized');
    return;
  }

  const status =
    continuityPacks.maxPayloadBudgetPct <= CONTINUITY_PACK_BUDGET_PRESSURE_TARGET_PCT ? 'on-target' : 'high';
  lines.push(
    `- Continuity pack budget pressure: max=${formatPercent(continuityPacks.maxPayloadBudgetPct)} of budget ` +
      `(target <= ${formatPercent(CONTINUITY_PACK_BUDGET_PRESSURE_TARGET_PCT)}, ${status})`,
  );
}

function renderContinuityPackReadLine(lines: string[], mcpUsage: McpUsageMetrics): void {
  const continuityPackTool = mcpUsage.tools.find(tool => tool.toolName === 'memory_continuity_pack');
  if (continuityPackTool === undefined) {
    lines.push('- Continuity pack reads: no telemetry rows in window');
    return;
  }

  lines.push(
    `- Continuity pack reads: calls=${String(continuityPackTool.calls)} ` +
      `success=${formatPercent(continuityPackTool.successRatePct)} ` +
      `errors=${String(continuityPackTool.errors)} ` +
      `avg=${formatNumber(continuityPackTool.avgDurationMs, 1)}ms ` +
      `p95=${formatNumber(continuityPackTool.p95DurationMs, 1)}ms`,
  );
  const statusCounts = continuityPackTool.responseStatusCounts ?? {};
  const missingOrDegraded = (statusCounts.missing ?? 0) + (statusCounts.degraded ?? 0);
  const readSuccessStatus =
    continuityPackTool.successRatePct >= CONTINUITY_PACK_READ_SUCCESS_TARGET_PCT ? 'on-target' : 'below-target';
  const latencyStatus =
    continuityPackTool.p95DurationMs <= CONTINUITY_PACK_READ_LATENCY_TARGET_MS ? 'on-target' : 'above-target';
  lines.push(
    `- Continuity pack read quality: success=${formatPercent(continuityPackTool.successRatePct)} ` +
      `(target >= ${formatPercent(CONTINUITY_PACK_READ_SUCCESS_TARGET_PCT)}, ${readSuccessStatus}), ` +
      `missing/degraded=${String(missingOrDegraded)}/${String(continuityPackTool.calls)} ` +
      `(${formatPercent(percent(missingOrDegraded, continuityPackTool.calls))}), ` +
      `p95=${formatNumber(continuityPackTool.p95DurationMs, 1)}ms ` +
      `(target <= ${String(CONTINUITY_PACK_READ_LATENCY_TARGET_MS)}ms, ${latencyStatus})`,
  );
}

function renderContinuityReadinessLines(lines: string[], readiness: DatabaseMetrics['continuityReadiness']): void {
  if (readiness.packReadCalls === 0) {
    lines.push('- Continuity adoption readiness: no continuity-pack read telemetry in window');
  } else {
    lines.push(
      `- Continuity adoption readiness: pack_reads=${String(readiness.packReadCalls)} ` +
        `found=${String(readiness.packFoundReads)} ` +
        `missing=${String(readiness.packMissingReads)} ` +
        `degraded=${String(readiness.packDegradedReads)} ` +
        `found_rate=${formatPercent(percent(readiness.packFoundReads, readiness.packReadCalls))}`,
    );
  }

  if (readiness.totalPacksForFieldCompleteness === 0) {
    lines.push('- Continuity actionable-field completeness: no continuity packs available for field completeness');
  } else {
    lines.push(
      `- Continuity actionable-field completeness: ` +
        `populated_fields=${String(readiness.actionableFieldsPopulated)}/` +
        `${String(readiness.actionableFieldSlots)} ` +
        `(${formatPercent(readiness.actionableFieldCompletenessPct)}), ` +
        `packs_with_any_actionable=${String(readiness.packsWithActionableFields)}/` +
        `${String(readiness.totalPacksForFieldCompleteness)} ` +
        `(${formatPercent(percent(readiness.packsWithActionableFields, readiness.totalPacksForFieldCompleteness))})`,
    );
    lines.push(
      `  fields next_actions=${String(readiness.packsWithNextActions)} ` +
        `open_questions=${String(readiness.packsWithOpenQuestions)} ` +
        `decisions=${String(readiness.packsWithDecisions)} ` +
        `context_needed=${String(readiness.packsWithContextNeeded)}`,
    );
  }

  if (readiness.sessionsWithPackRead === 0) {
    lines.push('- Continuity flush-after-pack: no session-scoped continuity-pack reads in window');
  } else {
    lines.push(
      `- Continuity flush-after-pack: sessions=${String(readiness.sessionsWithPackRead)} ` +
        `flush_after_pack=${String(readiness.sessionsWithFlushAfterPack)} ` +
        `(${formatPercent(percent(readiness.sessionsWithFlushAfterPack, readiness.sessionsWithPackRead))}, ` +
        `readiness signal)`,
    );
  }
}

function renderContinuitySourceQualityLine(lines: string[], continuity: ContinuityAdoptionMetrics): void {
  if (continuity.snapshots === 0) {
    return;
  }

  const autoPopulatedFields =
    continuity.auto.nextActionsNonEmpty + continuity.auto.contextNeededNonEmpty + continuity.auto.openQuestionsNonEmpty;
  const derivedOrCarriedForwardFields =
    continuity.auto.nextActionsDerived +
    continuity.auto.contextNeededDerived +
    continuity.auto.openQuestionsDerived +
    continuity.auto.nextActionsCarriedForward +
    continuity.auto.contextNeededCarriedForward +
    continuity.auto.openQuestionsCarriedForward;
  const derivedCoverage =
    autoPopulatedFields === 0 ? 'n/a' : formatPercent(percent(derivedOrCarriedForwardFields, autoPopulatedFields));

  lines.push(
    `- Continuity source quality: explicit_flush_snapshots=${String(continuity.flush.snapshots)}/` +
      `${String(continuity.snapshots)} (${formatPercent(percent(continuity.flush.snapshots, continuity.snapshots))}), ` +
      `auto_hint_snapshots=${String(continuity.auto.snapshots)}/${String(continuity.snapshots)} ` +
      `(${formatPercent(percent(continuity.auto.snapshots, continuity.snapshots))}), ` +
      `derived_or_carry_forward_fields=${String(derivedOrCarriedForwardFields)}/${String(autoPopulatedFields)} ` +
      `(${derivedCoverage}, informational)`,
  );
}

function renderIngestionSection(lines: string[], database: DatabaseMetrics): void {
  lines.push('Ingestion');
  lines.push(`- Sessions started: ${String(database.sessionsStarted)}`);
  lines.push(`- Memory deltas ingested: ${String(database.deltasIngested)}`);
  lines.push(`- Context packs ingested: ${String(database.contextPacksIngested)}`);
  lines.push(
    `- Continuity packs materialized: packs=${String(database.continuityPacks.packs)} ` +
      `updated_in_window=${String(database.continuityPacks.updatedInWindow)} ` +
      `avg_payload=${formatNumber(database.continuityPacks.avgPayloadChars, 1)} chars ` +
      `max_payload=${formatNumber(database.continuityPacks.maxPayloadChars, 0)} chars`,
  );
  renderContinuityPackBudgetPressureLine(lines, database.continuityPacks);
  lines.push(`- Durable memories created: ${String(database.durableMemoriesCreated)}`);
  lines.push(`- Durable memories updated: ${String(database.durableMemoriesUpdated)}`);
  // Active vs. historical separation: `actionableFailures` is the in-window count of
  // failure rows whose `resolved_at IS NULL`. That denominator spans the full report
  // window (default 7d), so it includes historical cleanup debt — labeling it
  // "Actionable" on the top line read as "current incidents needing operator action"
  // when active incidents were actually zero. Operators get a clean active/historical
  // split below; this line stays as a window-total summary, not an incident status.
  lines.push(
    `- Ingestion failures in window: Total=${String(database.ingestionFailures)} | ` +
      `Unresolved (any age)=${String(database.actionableFailures)} | ` +
      `Resolved=${String(database.resolvedFailures)} ` +
      `(avg MTTR: ${formatNumber(database.mttr.avgMinutes, 1)} min)`,
  );
  lines.push(
    `- Session-end conflict mismatch rate (14d): ${formatPercent(database.sessionEndConflictRate14d.ratePct)} ` +
      `(${String(database.sessionEndConflictRate14d.conflictCount)}/${String(database.sessionEndConflictRate14d.writeCount)} writes, ` +
      `target < ${formatPercent(database.sessionEndConflictRate14d.targetPct)}, ` +
      `${database.sessionEndConflictRate14d.targetMet ? 'on-target' : 'above-target'})`,
  );
  // Active window: only `unresolved` rows are current incidents. Rows that arrived in the
  // active window but were already closed (resolved_at IS NOT NULL) are shown as resolved
  // so operators see both signals without conflation.
  const activeWindow = database.failureWindows.active;
  const activeIncidentStatus = activeWindow.unresolved === 0 ? 'no active incidents' : 'active incidents';
  lines.push(
    `- Active failures (${activeWindow.start} to ${activeWindow.end}): ` +
      `Unresolved=${String(activeWindow.unresolved)}, Resolved=${String(activeWindow.resolved)} ` +
      `(${activeIncidentStatus})`,
  );
  renderOptionalBreakdownLine({
    entries: activeWindow.sources,
    label: 'Active sources',
    lines,
  });

  // Historical window: only `unresolved` rows are cleanup debt. Rows from the historical
  // window that have since been resolved are shown alongside but explicitly labeled so the
  // top-line "cleanup debt" signal is no longer triggered by resolved historical rows.
  const historicalWindow = database.failureWindows.historical;
  const historicalDebtStatus =
    historicalWindow.unresolved === 0
      ? 'no historical debt'
      : `historical cleanup debt — see ingestion failure runbook`;
  lines.push(
    `- Historical failures (${historicalWindow.start} to ${historicalWindow.end}): ` +
      `Unresolved debt=${String(historicalWindow.unresolved)}, Resolved=${String(historicalWindow.resolved)} ` +
      `(${historicalDebtStatus})`,
  );
  renderOptionalBreakdownLine({
    entries: historicalWindow.sources,
    label: 'Historical sources',
    lines,
  });
  renderOptionalBreakdownLine({
    entries: database.durableWriterMix,
    includePercent: true,
    label: 'Deliberate durable writer mix',
    lines,
  });
  renderOptionalBreakdownLine({
    entries: database.deltaSourceMix,
    includePercent: true,
    label: 'Delta source mix (workflow.system/source)',
    lines,
  });
  renderOptionalBreakdownLine({
    entries: database.failuresBySource,
    label: 'Failure sources',
    lines,
  });
  renderOptionalFailureStageLine(lines, database.failuresByStage);
  renderTopFailureSignatures(lines, database.topFailureSignatures);
  renderTopTimeoutOperations(lines, database.topTimeoutOperations);
  renderContinuityAdoptionLine(lines, database.continuityAdoption);
  renderContinuitySourceQualityLine(lines, database.continuityAdoption);
  renderContinuityReadinessLines(lines, database.continuityReadiness);
  renderWriterParticipation(lines, database.writerParticipationHealth);
  renderTaxonomyDistribution(lines, database.taxonomyDistribution);
  lines.push('');
}

function renderLaunchGateSection(lines: string[], report: HealthReport): void {
  const { launchGates } = report;
  lines.push('Launch Gates (Post-A0 Baseline)');
  lines.push('- Baseline: evaluate thresholds on rolling windows measured after A0 merge.');

  const flush = launchGates.flushSuccessRatePct;
  if (flush.status === 'no-data') {
    lines.push(`- memory_flush reliability: no flush calls in window (target: >= ${formatPercent(flush.target)}).`);
  } else {
    lines.push(
      `- memory_flush reliability: ${formatPercent(flush.observed ?? 0)} success over ${String(flush.sampleCount)} calls ` +
        `(target: >= ${formatPercent(flush.target)}, ${flush.status}).`,
    );
  }

  const td = launchGates.timeoutDegradationRatePct;
  if (td.status === 'no-data') {
    lines.push(`- Timeout/degradation rate: no orient calls in window (target: < ${formatPercent(td.target)}).`);
  } else {
    lines.push(
      `- Timeout/degradation rate: ${formatPercent(td.observed ?? 0)} over ${String(td.sampleCount)} calls ` +
        `(target: < ${formatPercent(td.target)}, ${td.status}).`,
    );
  }

  const nullRate = launchGates.memoryTypeNullRatePct;
  if (nullRate.status === 'no-data') {
    lines.push('- memory_type NULL rate: no new entries in window (target: = 0.0%).');
  } else {
    lines.push(
      `- memory_type NULL rate: ${formatPercent(nullRate.observed ?? 0)} over ${String(nullRate.sampleCount)} entries ` +
        `(target: = 0.0%, ${nullRate.status}).`,
    );
  }

  const contested = launchGates.contestedLatencyP95Ms;
  if (contested.status === 'no-data') {
    lines.push(
      `- Contested resolution latency: no samples in window (target: p95 < ${String(LAUNCH_GATE_THRESHOLDS.contestedLatencyP95Ms.onTarget)}ms).`,
    );
  } else {
    const sampleGateMet = (contested.sampleCount ?? 0) >= LAUNCH_GATE_CONTESTED_SAMPLE_TARGET;
    lines.push(
      `- Contested resolution latency: p95=${formatNumber(contested.observed ?? 0, 1)}ms over ${String(contested.sampleCount)} calls ` +
        `(sample gate ${sampleGateMet ? 'met' : 'unmet'}: ${String(LAUNCH_GATE_CONTESTED_SAMPLE_TARGET)}+, ` +
        `target: p95 < ${String(LAUNCH_GATE_THRESHOLDS.contestedLatencyP95Ms.onTarget)}ms, ${contested.status}).`,
    );
  }

  const continuity = report.database.continuityAdoption;
  if (continuity.agentWriterFlushes === 0) {
    lines.push(
      `- Continuity payload completeness: no agent-writer memory_flush calls in window ` +
        `(target: >= ${formatPercent(CONTINUITY_PAYLOAD_COMPLETENESS_TARGET_PCT)}).`,
    );
  } else {
    const status =
      continuity.agentWriterCompliancePct >= CONTINUITY_PAYLOAD_COMPLETENESS_TARGET_PCT ? 'on-target' : 'below-target';
    lines.push(
      `- Continuity payload completeness: ${formatPercent(continuity.agentWriterCompliancePct)} over ` +
        `${String(continuity.agentWriterFlushes)} agent-writer memory_flush calls ` +
        `(target: >= ${formatPercent(CONTINUITY_PAYLOAD_COMPLETENESS_TARGET_PCT)}, ${status}).`,
    );
  }

  const flushStateModel = launchGates.continuityStateModelPct;
  if (flushStateModel.status === 'no-data') {
    lines.push(
      `- Explicit-flush x_state_model coverage: no explicit-flush snapshots in window ` +
        `(target: >= ${formatPercent(flushStateModel.target)}).`,
    );
  } else {
    lines.push(
      `- Explicit-flush x_state_model coverage: ${formatPercent(flushStateModel.observed ?? 0)} over ` +
        `${String(flushStateModel.sampleCount)} explicit-flush snapshots ` +
        `(target: >= ${formatPercent(flushStateModel.target)}, ${flushStateModel.status}).`,
    );
  }

  // Informational diagnostics sit below the blocking gates. The auto-channel coverage
  // is `severity: 'informational'` (see launch-gates.ts INFORMATIONAL_GATES) — never a
  // launch blocker — so the trailing reading is rendered as "informational" rather than
  // a `failing`/`warning`/`on-target` gate-status word that operators would read as a
  // SLO violation.
  const autoStateModel = launchGates.autoSnapshotStateModelPct;
  if (autoStateModel.status === 'no-data') {
    lines.push(
      `- Auto-channel x_state_model coverage (carry-forward only, informational): no auto snapshots in window ` +
        `(reference floor: >= ${formatPercent(autoStateModel.target)}).`,
    );
  } else {
    lines.push(
      `- Auto-channel x_state_model coverage (carry-forward only, informational): ` +
        `${formatPercent(autoStateModel.observed ?? 0)} over ${String(autoStateModel.sampleCount)} auto snapshots ` +
        `(reference floor: >= ${formatPercent(autoStateModel.target)}, informational).`,
    );
  }

  lines.push('');
}

function renderMcpUsageSection(lines: string[], mcpUsage: McpUsageMetrics): void {
  lines.push('MCP Usage');
  lines.push(`- Telemetry source: ${mcpUsage.telemetrySource}`);
  if (mcpUsage.telemetrySource === 'unavailable' && mcpUsage.telemetryError !== undefined) {
    lines.push(`- Telemetry error: ${mcpUsage.telemetryError}`);
  }
  lines.push(`- Log file: ${mcpUsage.logFile}`);
  lines.push(`- Log file source: ${mcpUsage.logFileSource}`);
  lines.push(
    `- Tool invocations: ${String(mcpUsage.invocations)} ` +
      `(success: ${String(mcpUsage.successfulInvocations)}, errors: ${String(mcpUsage.errors)}, ` +
      `success rate: ${formatPercent(mcpUsage.successRatePct)})`,
  );
  lines.push(`- Read/write mix: read=${String(mcpUsage.readInvocations)} write=${String(mcpUsage.writeInvocations)}`);
  renderContinuityPackReadLine(lines, mcpUsage);
  renderMemoryOrientEnvironmentLine(lines, mcpUsage);
  lines.push(`- Dedupe suppressions (memory_store): ${String(mcpUsage.dedupeSuppressed)}`);
  lines.push(
    `- Session resume calls: ${String(mcpUsage.resume.calls)} ` +
      `(ok: ${String(mcpUsage.resume.ok)} [direct: ${String(mcpUsage.resume.okDirect)}, fallback: ${String(mcpUsage.resume.okFallback)}], ` +
      `not_found: ${String(mcpUsage.resume.notFound)}, ` +
      `errors: ${String(mcpUsage.resume.errors)})`,
  );
  lines.push(
    `- Orient calls: ${String(mcpUsage.orient.calls)} ` +
      `(ok: ${String(mcpUsage.orient.ok)}, partial: ${String(mcpUsage.orient.partial)}, ` +
      `degraded: ${String(mcpUsage.orient.degraded)}, errors: ${String(mcpUsage.orient.errors)}, ` +
      `timeouts: ${String(mcpUsage.orient.timeouts)}, ` +
      `timeout rate: ${formatPercent(mcpUsage.orient.timeoutRatePct)} ` +
      `(target <${formatPercent(mcpUsage.orient.timeoutTargetPct)}))`,
  );
  if (mcpUsage.orient.calls > 0) {
    const budgetText = mcpUsage.orient.payloadBudgetChars > 0 ? String(mcpUsage.orient.payloadBudgetChars) : 'n/a';
    lines.push(
      `- Orient payload budget: exceeded=${String(mcpUsage.orient.payloadBudgetExceeded)} ` +
        `(budgetExceededRate=${formatPercent(mcpUsage.orient.payloadBudgetExceededRatePct)}, budget: ${budgetText} chars)`,
    );
    lines.push(
      `- Orient payload size: samples=${String(mcpUsage.orient.payloadSamples)} ` +
        `avg=${formatNumber(mcpUsage.orient.payloadCharsAvg, 1)} chars ` +
        `p95PayloadChars=${formatNumber(mcpUsage.orient.payloadCharsP95, 1)} ` +
        `maxPayloadChars=${formatNumber(mcpUsage.orient.payloadCharsMax, 1)} ` +
        `avg_tokens≈${formatNumber(mcpUsage.orient.payloadTokensAvg, 1)}`,
    );
  }

  if (mcpUsage.tools.length > 0) {
    lines.push('- Top tools by calls:');
    for (const tool of mcpUsage.tools.slice(0, 8)) {
      lines.push(
        `  - ${tool.toolName}: calls=${String(tool.calls)} success=${formatPercent(tool.successRatePct)} ` +
          `avg=${formatNumber(tool.avgDurationMs, 1)}ms p95=${formatNumber(tool.p95DurationMs, 1)}ms`,
      );
    }
  } else {
    lines.push('- Top tools by calls: (none in this window)');
  }
  lines.push('');
}

function renderMemoryOrientEnvironmentLine(lines: string[], mcpUsage: McpUsageMetrics): void {
  const orientTool = mcpUsage.tools.find(tool => tool.toolName === 'memory_orient');
  const environmentStatusCounts = orientTool?.environmentStatusCounts;
  if (environmentStatusCounts === undefined || Object.keys(environmentStatusCounts).length === 0) {
    return;
  }

  const statuses = Object.entries(environmentStatusCounts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}=${String(count)}`)
    .join(', ');
  lines.push(`- Memory orient environment probes: ${statuses}`);
}

function renderOptionalBreakdownLine(input: {
  entries: { count: number; pct?: number; source: string }[];
  includePercent?: boolean;
  label: string;
  lines: string[];
}): void {
  if (input.entries.length === 0) {
    return;
  }

  const formatted = input.entries
    .map(entry =>
      input.includePercent === true
        ? `${entry.source}=${String(entry.count)} (${formatPercent(entry.pct ?? 0)})`
        : `${entry.source}=${String(entry.count)}`,
    )
    .join(', ');
  input.lines.push(`- ${input.label}: ${formatted}`);
}

function renderOptionalFailureStageLine(lines: string[], stages: FailureByStageMetric[]): void {
  if (stages.length === 0) {
    return;
  }

  const stageBreakdown = stages.map(stage => `${stage.stage}=${String(stage.count)}`).join(', ');
  lines.push(`- Failure stages: ${stageBreakdown}`);
}

function renderOrchestrationSection(lines: string[], orchestration: OrchestrationMetrics): void {
  lines.push('Orchestration');
  lines.push(`- Transcript directory: ${orchestration.transcriptDirectory}`);
  lines.push(`- Runs: ${String(orchestration.runs)} (approval rate: ${formatPercent(orchestration.approvalRatePct)})`);
  lines.push(
    `- Outcomes: approved=${String(orchestration.approved)} ` +
      `not_approved=${String(orchestration.notApproved)} error=${String(orchestration.error)}`,
  );
  lines.push(`- Avg rounds per run: ${formatNumber(orchestration.avgRoundsPerRun, 2)}`);
  lines.push(`- Total tokens across runs: ${String(orchestration.totalTokens)}`);
  lines.push(`- Retro markdown files: ${String(orchestration.retroMarkdownFiles)}`);
  lines.push(`- Retro insight files: ${String(orchestration.insightFiles)}`);
  lines.push(`- Retro issue-seed files: ${String(orchestration.issueSeedFiles)}`);
  lines.push('');
}

function renderOutcomeSignalsSection(lines: string[], database: DatabaseMetrics): void {
  lines.push('Outcome Signals');

  if (database.repeatedFixRate.length === 0) {
    lines.push('- No repeated-fix signals');
  } else {
    lines.push(`- Repeated-fix hotspots (${String(DEFAULT_REPEATED_FIX_WINDOW_DAYS)}d, threshold >=3):`);
    for (const metric of database.repeatedFixRate) {
      lines.push(
        `  - ${metric.module}: ${String(metric.count)} memories ` +
          `(ids: ${metric.memoryIds.map(id => String(id)).join(', ')})`,
      );
    }
  }

  const reversal = database.decisionReversalRate;
  if (reversal.count === 0) {
    lines.push('- No decision reversals');
  } else {
    lines.push(
      `- Decision-reversal rate (${String(DEFAULT_DECISION_REVERSAL_WINDOW_DAYS)}d): ` +
        `${String(reversal.count)}/${String(reversal.denominator)} ` +
        `(ratio=${formatNumber(reversal.rate, 4)}, pct=${formatPercent(reversal.rate * 100)})`,
    );
    lines.push('- Decision-reversal breakdown:');
    for (const category of reversal.byCategory) {
      lines.push(
        `  - ${category.category}: ${String(category.count)}/${String(category.denominator)} ` +
          `(ratio=${formatNumber(category.rate, 4)}, pct=${formatPercent(category.rate * 100)})`,
      );
    }
  }

  if (database.calibration.signalCount > 0) {
    lines.push(`- Calibration signals: ${String(database.calibration.signalCount)}`);
    if (database.calibration.brierScore === null || database.calibration.ece === null) {
      lines.push(
        `- Insufficient calibration data (${String(database.calibration.signalCount)} signals, need ${String(DEFAULT_CALIBRATION_MIN_SIGNALS)}+)`,
      );
    } else {
      lines.push(`- Calibration Brier score: ${formatNumber(database.calibration.brierScore, 4)}`);
      lines.push(`- Calibration ECE: ${formatNumber(database.calibration.ece.ece, 4)}`);
      lines.push(`- Calibration assessment: ${database.calibration.assessment ?? 'n/a'}`);
      lines.push('- Calibration bins:');
      for (const bin of database.calibration.ece.bins) {
        lines.push(
          `  - ${bin.range}: count=${String(bin.count)} ` +
            `avgPredicted=${formatNumber(bin.avgPredicted, 4)} ` +
            `avgActual=${formatNumber(bin.avgActual, 4)} ` +
            `error=${formatNumber(bin.error, 4)}`,
        );
      }
    }
  }

  lines.push('');
}

function renderReflectSection(lines: string[], reflect: ReflectMetrics): void {
  lines.push('Reflect');
  lines.push(`- Cycles in window: ${String(reflect.cyclesInWindow)}`);
  lines.push(`- Last cycle: ${reflect.lastCycleIso ?? 'none'}`);
  lines.push(
    `- Evaluations since last cycle: ${
      reflect.evaluationsSinceLastCycle === null ? 'n/a' : String(reflect.evaluationsSinceLastCycle)
    }`,
  );
  lines.push(`- Provisional methodology memories written: ${String(reflect.provisionalMethodologyMemoriesWritten)}`);
  if (reflect.recentCycles.length === 0) {
    lines.push('- Recent cycles: none');
    lines.push('');
    return;
  }

  lines.push('- Recent cycles:');
  for (const cycle of reflect.recentCycles) {
    const skippedTargets = cycle.skippedTargets.length > 0 ? cycle.skippedTargets.join(',') : 'none';
    lines.push(
      `  - ${cycle.completedAt ?? cycle.cycleId ?? 'unknown'} ` +
        `triggeredBy=${cycle.triggeredBy ?? 'unknown'} ` +
        `evaluations=${cycle.evaluationCountAtReflection === null ? 'n/a' : String(cycle.evaluationCountAtReflection)} ` +
        `skips=${skippedTargets} ` +
        `provisional=${String(cycle.provisionalMethodologyMemoriesWritten)}`,
    );
  }
  lines.push('');
}

function renderRetentionSection(lines: string[], retention: RetentionMetrics): void {
  lines.push('Retention');
  lines.push(
    `- Active config: sessions=${String(retention.config.sessionDays)}d ` +
      `failures=${String(retention.config.failureDays)}d ` +
      `expired-grace=${String(retention.config.expiredGraceDays)}d ` +
      `superseded=${String(retention.config.supersededDays)}d ` +
      `audit=${String(retention.config.auditDays)}d ` +
      `batch=${String(retention.config.batchSize)}`,
  );
  lines.push(`- Total purge-eligible backlog: ${String(retention.totalBacklog)} rows`);
  if (retention.backlog.length > 0) {
    for (const entry of retention.backlog) {
      if (entry.candidates > 0) {
        const range =
          entry.oldestCreatedAt !== undefined && entry.newestCreatedAt !== undefined
            ? ` (${entry.oldestCreatedAt} to ${entry.newestCreatedAt})`
            : '';
        lines.push(`  - ${entry.dataset}: ${String(entry.candidates)} rows${range}`);
      }
    }
  }
  if (retention.lastRun !== null) {
    const run = retention.lastRun;
    lines.push(
      `- Last retention run: ${run.timestamp} ` +
        `status=${run.status} dryRun=${String(run.dryRun)} ` +
        `candidates=${String(run.totalCandidates)} deleted=${String(run.totalDeleted)} ` +
        `errors=${String(run.errorCount)} duration=${String(run.durationMs)}ms`,
    );
  } else {
    lines.push('- Last retention run: (none recorded)');
  }
  lines.push('');
}

function renderTaxonomyDistribution(lines: string[], distribution: TaxonomyDistributionMetric[]): void {
  if (distribution.length === 0) {
    return;
  }

  const total = distribution.reduce((sum, entry) => sum + entry.count, 0);
  lines.push(`- Taxonomy distribution (${String(total)} active memories):`);
  for (const entry of distribution) {
    lines.push(`  - ${entry.tier}: ${String(entry.count)} (${formatPercent(entry.pct)})`);
  }
}

function renderTopFailureSignatures(lines: string[], signatures: FailureSignatureMetric[]): void {
  if (signatures.length === 0) {
    lines.push('- Top repeated failure signatures: (none)');
    return;
  }

  lines.push(`- Top repeated failure signatures (top ${String(TOP_FAILURE_SIGNATURE_LIMIT)}):`);
  for (const metric of signatures) {
    const sourceBreakdown = metric.sources.map(source => `${source.source}=${String(source.count)}`).join(', ');
    lines.push(`  - ${metric.signature} => ${String(metric.count)} (sources: ${sourceBreakdown})`);
  }
}

function renderTopTimeoutOperations(lines: string[], operations: TimeoutOperationMetric[] | undefined): void {
  if (operations === undefined || operations.length === 0) {
    lines.push('- Top timeout operations: (none)');
    return;
  }
  lines.push(`- Top timeout operations (top ${String(TOP_TIMEOUT_OPERATION_LIMIT)}, by phase):`);
  for (const metric of operations) {
    lines.push(`  - ${metric.phase} => ${String(metric.count)}`);
  }
}

function renderUsefulnessSection(lines: string[], usefulness: undefined | UsefulnessMetrics): void {
  if (usefulness === undefined) {
    return;
  }

  lines.push('Usefulness');

  const cs = usefulness.continuityScore;
  if (cs.qualifyingSessions === 0) {
    lines.push('- Resume usefulness: no qualifying sessions (no prior snapshot found)');
  } else {
    lines.push(
      `- Resume sessions with prior snapshot: ${String(cs.qualifyingSessions)} ` +
        `(sparse score 0-1: ${String(cs.sparseSessions)}, rich score 3-4: ${String(cs.richSessions)})`,
    );
  }
  lines.push(
    `- Qualifying resume sessions: 7d=${String(cs.qualifyingSessions7d)} 30d=${String(cs.qualifyingSessions30d)}`,
  );

  const latencyText =
    usefulness.resumeToFirstWriteMs !== null
      ? `${formatNumber(usefulness.resumeToFirstWriteMs, 0)}ms`
      : 'n/a (no qualifying writes)';
  const p95Text =
    usefulness.resumeToFirstWriteP95Ms !== null ? `${formatNumber(usefulness.resumeToFirstWriteP95Ms, 0)}ms` : 'n/a';
  lines.push(
    `- Resume-to-first-write latency (median, ${String(usefulness.windowMinutes)}min window): ${latencyText}; ` +
      `p95: ${p95Text}`,
  );

  const rework = usefulness.reworkAfterResume;
  if (rework.sparseSessions === 0 && rework.richSessions === 0) {
    lines.push('- Rework after resume: insufficient data (need sessions in both sparse and rich groups)');
  } else {
    lines.push(
      `- Rich-vs-sparse comparison: ${rework.provisional ? 'provisional' : 'qualified'} ` +
        `(n_sparse=${String(rework.sparseSessions)} n_rich=${String(rework.richSessions)}, ` +
        `threshold=${String(rework.minBucketSize)} each)`,
    );
    lines.push('- Rework after resume (root-cause stores per group):');
    if (rework.sparseSessions > 0) {
      const sparseLatency =
        rework.sparseMedianResumeMs !== null ? `${formatNumber(rework.sparseMedianResumeMs, 0)}ms` : 'n/a';
      lines.push(
        `  - Sparse (score 0-1): ${String(rework.sparseSessions)} sessions, ` +
          `${String(rework.sparseRepeatedFixes)} root-cause stores, ` +
          `median resume latency: ${sparseLatency}`,
      );
    }
    if (rework.richSessions > 0) {
      const richLatency =
        rework.richMedianResumeMs !== null ? `${formatNumber(rework.richMedianResumeMs, 0)}ms` : 'n/a';
      lines.push(
        `  - Rich (score 3-4): ${String(rework.richSessions)} sessions, ` +
          `${String(rework.richRepeatedFixes)} root-cause stores, ` +
          `median resume latency: ${richLatency}`,
      );
    }
  }

  lines.push('');
}

function renderWriteCalibrationSection(lines: string[], writeCalibration: WriteCalibrationMetrics): void {
  lines.push('Write Calibration');
  if (writeCalibration.cells.length === 0) {
    lines.push('- No calibrated writes in window.');
    lines.push('');
    return;
  }

  lines.push(`- Author/category cells: ${String(writeCalibration.cells.length)}`);
  if (writeCalibration.topDepleted.length === 0) {
    lines.push('- Top depleted cells: none');
  } else {
    lines.push('- Top depleted cells:');
    for (const cell of writeCalibration.topDepleted) {
      const brier = cell.brierScore === null ? 'n/a' : formatNumber(cell.brierScore, 3);
      lines.push(
        `  - ${cell.author} / ${cell.category}: n=${String(cell.memoryCount)} ` +
          `declared=${formatNumber(cell.avgDeclaredConfidence, 2)} ` +
          `calibrated=${formatNumber(cell.avgCalibratedConfidence, 2)} ` +
          `reversal=${formatPercent(cell.reversalRate * 100)} brier=${brier}`,
      );
    }
  }
  lines.push('');
}

function renderWriterParticipation(lines: string[], writerParticipation: WriterParticipationHealth): void {
  if (writerParticipation.totalSources <= 1) {
    return;
  }

  const status = writerParticipation.healthy ? 'healthy' : 'imbalanced';
  const familyCount = writerParticipation.families.length;
  lines.push(
    `- Writer participation: ${status} (${String(familyCount)} families across ${String(writerParticipation.totalSources)} sources, ` +
      `${String(writerParticipation.totalWrites)} writes, per-family min ${String(writerParticipation.minPct)}%)`,
  );
  for (const family of writerParticipation.families) {
    const sourcesLabel = family.sources.length === 0 ? '(none)' : family.sources.join(', ');
    lines.push(
      `  - ${family.family}: ${String(family.writes)} writes (${formatPercent(family.pct)}) [sources: ${sourcesLabel}]`,
    );
  }
  for (const flag of writerParticipation.belowThreshold) {
    lines.push(
      `  - LOW: family ${flag.family} at ${formatPercent(flag.actualPct)} (${String(flag.writes)} writes, below ${String(writerParticipation.minPct)}% target)`,
    );
  }
}
