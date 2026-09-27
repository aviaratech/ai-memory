/**
 * Launch gate threshold matrix and evaluation logic.
 *
 * Single source of truth for all launch gate metrics: thresholds, status evaluation,
 * and computed gate report. Extracted from health-report.ts to keep that module focused.
 */

export type GateSeverity = 'blocking' | 'informational';

export type GateStatus = 'failing' | 'on-target' | 'warning';

export type GateThreshold = MaxGateThreshold | MinGateThreshold;

export interface LaunchGateEntry {
  metric: string;
  /** Null when no samples are available in the reporting window. */
  observed: null | number;
  /** Denominator for the observed metric. Null when not applicable. */
  sampleCount: null | number;
  /**
   * Whether this gate is contractually blocking or an informational diagnostic.
   * `informational` gates retain their `status` field for visibility but must not be
   * treated as launch blockers by JSON consumers or human readers — see
   * {@link LaunchGatesReport} for the assignments and rationale.
   */
  severity: GateSeverity;
  status: 'no-data' | GateStatus;
  /** The on-target boundary value for display. */
  target: number;
}

export interface LaunchGatesReport {
  /**
   * Auto-channel snapshot coverage of `x_state_model`. State model arrives on the auto
   * channel only via deterministic carry-forward from a prior explicit flush in the
   * same session (no fabrication), so the target is low by design. Marked
   * `severity: 'informational'` — never blocking.
   */
  autoSnapshotStateModelPct: LaunchGateEntry;
  contestedLatencyP95Ms: LaunchGateEntry;
  /**
   * Aggregate next_actions presence across all snapshots (flush + auto carry-forward +
   * unknown). The aggregate denominator is dominated by auto snapshots in production
   * because most sessions never call memory_flush, so this metric primarily measures
   * carry-forward reach rather than agent compliance with the explicit-flush contract.
   * Marked `severity: 'informational'` — the contractual blocking signal for explicit
   * flushes is captured by the agent-writer payload completeness rendered separately
   * (see `renderLaunchGateSection`).
   */
  continuityNextActionsPct: LaunchGateEntry;
  /**
   * Aggregate open_questions presence — same channel-mixing caveats as
   * {@link continuityNextActionsPct}. Marked `severity: 'informational'`.
   */
  continuityOpenQuestionsPct: LaunchGateEntry;
  /**
   * Explicit-flush snapshot coverage of `x_state_model`. The blocking gate for
   * continuity state-model adoption — the auto channel is reported separately under
   * {@link autoSnapshotStateModelPct} so this gate is not dragged below target by the
   * auto channel's structural ceiling.
   */
  continuityStateModelPct: LaunchGateEntry;
  flushSuccessRatePct: LaunchGateEntry;
  memoryTypeNullRatePct: LaunchGateEntry;
  timeoutDegradationRatePct: LaunchGateEntry;
}

interface MaxGateThreshold {
  /** value < onTarget → on-target; value < warning (and >= onTarget) → warning; else failing */
  direction: 'max';
  onTarget: number;
  warning: number;
}

interface MinGateThreshold {
  /** value >= onTarget → on-target; value >= warning (and < onTarget) → warning; else failing */
  direction: 'min';
  onTarget: number;
  warning: number;
}

/**
 * Single typed threshold matrix — one source of truth for all launch gate thresholds.
 * Each entry defines on-target and warning boundaries; failing is implied (outside warning).
 */
export const LAUNCH_GATE_THRESHOLDS = {
  /**
   * Informational floor for the carry-forward channel — most sessions never call
   * memory_flush, so the structural ceiling is much lower than the explicit-flush
   * channel. Reported with `severity: 'informational'` so threshold drift never
   * produces a blocking failure.
   */
  autoSnapshotStateModelPct: { direction: 'min', onTarget: 25, warning: 10 },
  contestedLatencyP95Ms: { direction: 'max', onTarget: 300, warning: 500 },
  /**
   * Informational thresholds for aggregate (flush + auto) snapshot presence. The
   * aggregate denominator mixes channels so this is reported with
   * `severity: 'informational'`. The contractual blocking signal for the explicit
   * channel is the agent-writer payload completeness rendered separately.
   */
  continuityNextActionsPct: { direction: 'min', onTarget: 60, warning: 40 },
  /**
   * Informational thresholds — same channel-mixing caveats as
   * `continuityNextActionsPct`.
   */
  continuityOpenQuestionsPct: { direction: 'min', onTarget: 40, warning: 20 },
  /**
   * Explicit-flush channel only. Agents that call memory_flush with a stateModel pass
   * through this gate; auto-channel snapshots are reported separately under
   * `autoSnapshotStateModelPct`.
   */
  continuityStateModelPct: { direction: 'min', onTarget: 90, warning: 60 },
  flushSuccessRatePct: { direction: 'min', onTarget: 99, warning: 95 },
  /** on-target is < 0.1% (effectively 0.0% when rounded to 1 decimal) */
  memoryTypeNullRatePct: { direction: 'max', onTarget: 0.1, warning: 5 },
  timeoutDegradationRatePct: { direction: 'max', onTarget: 1, warning: 5 },
} as const satisfies Record<keyof LaunchGatesReport, GateThreshold>;

/** Minimum calls before the contested latency gate is considered statistically meaningful. */
export const LAUNCH_GATE_CONTESTED_SAMPLE_TARGET = 1_000;

/**
 * Single source of truth for which gates are contractually blocking versus
 * informational. Informational gates never act as launch blockers regardless of their
 * computed `status`; they retain `status` purely for visibility.
 *
 * - `autoSnapshotStateModelPct`: auto channel is carry-forward-only and structurally
 *   bounded by the fraction of sessions that previously called memory_flush.
 * - `continuityNextActionsPct` / `continuityOpenQuestionsPct`: aggregate denominators
 *   mix channels — the contractual blocking signal for explicit flushes lives in the
 *   agent-writer payload completeness rendered separately and in `continuityStateModelPct`.
 */
const INFORMATIONAL_GATES = new Set<keyof LaunchGatesReport>([
  'autoSnapshotStateModelPct',
  'continuityNextActionsPct',
  'continuityOpenQuestionsPct',
]);

export interface LaunchGatesInput {
  continuity: ContinuityInput;
  /** Percentage of newly created entries in the window with NULL memory_type (0–100). */
  memoryTypeNullRatePct: number;
  /** Total new entries in the window used as the NULL rate denominator. */
  memoryTypeNullSampleCount: number;
  orient: OrientInput;
  tools: ToolInput[];
}

/** Minimal input shape for continuity adoption metrics. */
interface ContinuityInput {
  /** Auto channel snapshot coverage — informational only. */
  autoSnapshots: number;
  autoStateModelPresent: number;
  /** Explicit-flush channel snapshot coverage — primary gate denominator for state-model. */
  flushSnapshots: number;
  flushStateModelPresent: number;
  nextActionsNonEmpty: number;
  openQuestionsNonEmpty: number;
  snapshots: number;
  stateModelPresent: number;
}

/** Minimal input shape for orient metrics. */
interface OrientInput {
  calls: number;
  degraded: number;
  timeouts: number;
}

/** Minimal input shape for tools — avoids importing from health-report.ts. */
interface ToolInput {
  calls: number;
  p95DurationMs: number;
  successRatePct: number;
  toolName: string;
}

/** Compute the full launch gates report from collected metrics. */
export function computeLaunchGates(input: LaunchGatesInput): LaunchGatesReport {
  const { continuity, memoryTypeNullRatePct, memoryTypeNullSampleCount, orient, tools } = input;

  // Flush reliability — sourced from memory_flush tool telemetry
  const flushTool = tools.find(t => t.toolName === 'memory_flush');
  const flushSuccessRatePct: LaunchGateEntry =
    flushTool === undefined
      ? {
          metric: 'flushSuccessRatePct',
          observed: null,
          sampleCount: null,
          severity: gateSeverity('flushSuccessRatePct'),
          status: 'no-data',
          target: LAUNCH_GATE_THRESHOLDS.flushSuccessRatePct.onTarget,
        }
      : {
          metric: 'flushSuccessRatePct',
          observed: flushTool.successRatePct,
          sampleCount: flushTool.calls,
          severity: gateSeverity('flushSuccessRatePct'),
          status: evaluateLaunchGateStatus(flushTool.successRatePct, LAUNCH_GATE_THRESHOLDS.flushSuccessRatePct),
          target: LAUNCH_GATE_THRESHOLDS.flushSuccessRatePct.onTarget,
        };

  // Timeout/degradation rate — sourced from orient call metrics
  const orientCalls = orient.calls;
  const timeoutDegradationRatePct: LaunchGateEntry =
    orientCalls === 0
      ? {
          metric: 'timeoutDegradationRatePct',
          observed: null,
          sampleCount: 0,
          severity: gateSeverity('timeoutDegradationRatePct'),
          status: 'no-data',
          target: LAUNCH_GATE_THRESHOLDS.timeoutDegradationRatePct.onTarget,
        }
      : (() => {
          const observed = Number((((orient.timeouts + orient.degraded) / orientCalls) * 100).toFixed(1));
          return {
            metric: 'timeoutDegradationRatePct',
            observed,
            sampleCount: orientCalls,
            severity: gateSeverity('timeoutDegradationRatePct'),
            status: evaluateLaunchGateStatus(observed, LAUNCH_GATE_THRESHOLDS.timeoutDegradationRatePct),
            target: LAUNCH_GATE_THRESHOLDS.timeoutDegradationRatePct.onTarget,
          };
        })();

  // memory_type NULL rate — sourced from DB query on new entries in window
  const memoryTypeNullRatePctEntry: LaunchGateEntry =
    memoryTypeNullSampleCount === 0
      ? {
          metric: 'memoryTypeNullRatePct',
          observed: null,
          sampleCount: 0,
          severity: gateSeverity('memoryTypeNullRatePct'),
          status: 'no-data',
          target: LAUNCH_GATE_THRESHOLDS.memoryTypeNullRatePct.onTarget,
        }
      : {
          metric: 'memoryTypeNullRatePct',
          observed: memoryTypeNullRatePct,
          sampleCount: memoryTypeNullSampleCount,
          severity: gateSeverity('memoryTypeNullRatePct'),
          status: evaluateLaunchGateStatus(memoryTypeNullRatePct, LAUNCH_GATE_THRESHOLDS.memoryTypeNullRatePct),
          target: LAUNCH_GATE_THRESHOLDS.memoryTypeNullRatePct.onTarget,
        };

  // Contested resolution latency — sourced from memory_resolve_contested tool telemetry
  const contestedTool = tools.find(t => t.toolName === 'memory_resolve_contested');
  const contestedLatencyP95Ms: LaunchGateEntry =
    contestedTool === undefined
      ? {
          metric: 'contestedLatencyP95Ms',
          observed: null,
          sampleCount: null,
          severity: gateSeverity('contestedLatencyP95Ms'),
          status: 'no-data',
          target: LAUNCH_GATE_THRESHOLDS.contestedLatencyP95Ms.onTarget,
        }
      : {
          metric: 'contestedLatencyP95Ms',
          observed: contestedTool.p95DurationMs,
          sampleCount: contestedTool.calls,
          severity: gateSeverity('contestedLatencyP95Ms'),
          status: evaluateLaunchGateStatus(contestedTool.p95DurationMs, LAUNCH_GATE_THRESHOLDS.contestedLatencyP95Ms),
          target: LAUNCH_GATE_THRESHOLDS.contestedLatencyP95Ms.onTarget,
        };

  // Session continuity — sourced from session snapshot DB metrics. Aggregate
  // denominators below mix flush + auto + unknown channels, so the entries are tagged
  // `severity: 'informational'` via INFORMATIONAL_GATES — `status` remains visible but
  // never blocks. The contractual blocking signal lives in continuityStateModelPct
  // (explicit-flush channel) and the agent-writer payload completeness rendered
  // outside this object.
  const snapshots = continuity.snapshots;
  const continuityNextActionsPct: LaunchGateEntry =
    snapshots === 0
      ? {
          metric: 'continuityNextActionsPct',
          observed: null,
          sampleCount: 0,
          severity: gateSeverity('continuityNextActionsPct'),
          status: 'no-data',
          target: LAUNCH_GATE_THRESHOLDS.continuityNextActionsPct.onTarget,
        }
      : (() => {
          const observed = Number(((continuity.nextActionsNonEmpty / snapshots) * 100).toFixed(1));
          return {
            metric: 'continuityNextActionsPct',
            observed,
            sampleCount: snapshots,
            severity: gateSeverity('continuityNextActionsPct'),
            status: evaluateLaunchGateStatus(observed, LAUNCH_GATE_THRESHOLDS.continuityNextActionsPct),
            target: LAUNCH_GATE_THRESHOLDS.continuityNextActionsPct.onTarget,
          };
        })();

  const continuityOpenQuestionsPct: LaunchGateEntry =
    snapshots === 0
      ? {
          metric: 'continuityOpenQuestionsPct',
          observed: null,
          sampleCount: 0,
          severity: gateSeverity('continuityOpenQuestionsPct'),
          status: 'no-data',
          target: LAUNCH_GATE_THRESHOLDS.continuityOpenQuestionsPct.onTarget,
        }
      : (() => {
          const observed = Number(((continuity.openQuestionsNonEmpty / snapshots) * 100).toFixed(1));
          return {
            metric: 'continuityOpenQuestionsPct',
            observed,
            sampleCount: snapshots,
            severity: gateSeverity('continuityOpenQuestionsPct'),
            status: evaluateLaunchGateStatus(observed, LAUNCH_GATE_THRESHOLDS.continuityOpenQuestionsPct),
            target: LAUNCH_GATE_THRESHOLDS.continuityOpenQuestionsPct.onTarget,
          };
        })();

  // x_state_model adoption on explicit-flush snapshots only — the contractual blocking
  // gate for continuity state-model adoption. Auto-channel snapshots are reported
  // separately below so this gate stops being dragged below target by a structurally
  // bounded carry-forward channel.
  const flushSnapshots = continuity.flushSnapshots;
  const continuityStateModelPct: LaunchGateEntry =
    flushSnapshots === 0
      ? {
          metric: 'continuityStateModelPct',
          observed: null,
          sampleCount: 0,
          severity: gateSeverity('continuityStateModelPct'),
          status: 'no-data',
          target: LAUNCH_GATE_THRESHOLDS.continuityStateModelPct.onTarget,
        }
      : (() => {
          const observed = Number(((continuity.flushStateModelPresent / flushSnapshots) * 100).toFixed(1));
          return {
            metric: 'continuityStateModelPct',
            observed,
            sampleCount: flushSnapshots,
            severity: gateSeverity('continuityStateModelPct'),
            status: evaluateLaunchGateStatus(observed, LAUNCH_GATE_THRESHOLDS.continuityStateModelPct),
            target: LAUNCH_GATE_THRESHOLDS.continuityStateModelPct.onTarget,
          };
        })();

  // Informational gate: state-model coverage on auto-channel snapshots. Reflects how
  // often a prior explicit flush existed in the same session and was carried forward.
  // Tagged `severity: 'informational'` so the carry-forward floor never produces a
  // blocking launch-gate failure.
  const autoSnapshots = continuity.autoSnapshots;
  const autoSnapshotStateModelPct: LaunchGateEntry =
    autoSnapshots === 0
      ? {
          metric: 'autoSnapshotStateModelPct',
          observed: null,
          sampleCount: 0,
          severity: gateSeverity('autoSnapshotStateModelPct'),
          status: 'no-data',
          target: LAUNCH_GATE_THRESHOLDS.autoSnapshotStateModelPct.onTarget,
        }
      : (() => {
          const observed = Number(((continuity.autoStateModelPresent / autoSnapshots) * 100).toFixed(1));
          return {
            metric: 'autoSnapshotStateModelPct',
            observed,
            sampleCount: autoSnapshots,
            severity: gateSeverity('autoSnapshotStateModelPct'),
            status: evaluateLaunchGateStatus(observed, LAUNCH_GATE_THRESHOLDS.autoSnapshotStateModelPct),
            target: LAUNCH_GATE_THRESHOLDS.autoSnapshotStateModelPct.onTarget,
          };
        })();

  return {
    autoSnapshotStateModelPct,
    contestedLatencyP95Ms,
    continuityNextActionsPct,
    continuityOpenQuestionsPct,
    continuityStateModelPct,
    flushSuccessRatePct,
    memoryTypeNullRatePct: memoryTypeNullRatePctEntry,
    timeoutDegradationRatePct,
  };
}

/**
 * Deterministic pure function: evaluates a measured value against a gate threshold.
 * No side effects, no I/O.
 */
export function evaluateLaunchGateStatus(value: number, threshold: GateThreshold): GateStatus {
  if (threshold.direction === 'min') {
    if (value >= threshold.onTarget) return 'on-target';
    if (value >= threshold.warning) return 'warning';
    return 'failing';
  }
  if (value < threshold.onTarget) return 'on-target';
  if (value < threshold.warning) return 'warning';
  return 'failing';
}

function gateSeverity(metric: keyof LaunchGatesReport): GateSeverity {
  return INFORMATIONAL_GATES.has(metric) ? 'informational' : 'blocking';
}
