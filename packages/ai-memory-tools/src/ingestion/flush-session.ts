import {
  getSessionProject,
  isRecord,
  normalizeProjectScope,
  readOptionalText,
  readStringArray,
  STRATEGY_CONFIDENCE_VALUES,
  truncateText,
} from '@aviaratech/ai-memory/internal';
import { randomUUID } from 'node:crypto';

import {
  commitCoreFlushWrites,
  type ConsolidationRunMetrics,
  createDefaultFlushSessionCoreDependencies,
  FLUSH_SOURCE,
  type FlushSessionCoreDependencies,
  logContinuityWarnings,
  prepareCoreWrites,
  runConsolidation,
  type StoredMemoryCalibration,
  type StoredMemoryInfo,
} from './flush-session-core.js';
import { type ContinuityPackRefreshResult, refreshContinuityPackFromFlush } from './continuity-pack.js';
import { runReflection } from './reflection.js';

export interface ParsedFlushInput {
  activeGoal: string | undefined;
  agent: string | undefined;
  contextNeeded: string[];
  decisions: string[];
  envModel: Record<string, unknown> | undefined;
  lead: string | undefined;
  nextActions: string[];
  normalizationWarnings: string[];
  openQuestions: string[];
  outcome: string | undefined;
  project: string | undefined;
  repoSlug?: string | undefined;
  rootCauses: string[];
  sessionId: string | undefined;
  source: string | undefined;
  stateModel: Record<string, unknown> | undefined;
  summary: string;
  task: string | undefined;
}

interface FlushCalibrationResult extends Omit<StoredMemoryCalibration, 'category' | 'memoryId'> {
  entries: StoredMemoryCalibration[];
}

interface FlushResult {
  calibration?: FlushCalibrationResult | undefined;
  consolidation?: ConsolidationRunMetrics | undefined;
  continuityPack?: ContinuityPackRefreshResult | undefined;
  flushed: true;
  memoriesStored: number;
  reflections?: {
    count: number;
  };
  sessionId: string;
  warnings?: string[];
}

interface FlushSessionDependencies extends FlushSessionCoreDependencies {
  getSessionProject: typeof getSessionProject;
  refreshContinuityPack: typeof refreshContinuityPackFromFlush;
  runReflection: typeof runReflection;
  uuid: () => string;
}

const MIN_CONTINUITY_SUMMARY_CHARS = 120;

const DEFAULT_DEPENDENCIES: FlushSessionDependencies = {
  ...createDefaultFlushSessionCoreDependencies(),
  getSessionProject,
  refreshContinuityPack: refreshContinuityPackFromFlush,
  runReflection,
  uuid: () => randomUUID(),
};

export function buildFlushSnapshotValue(
  parsed: ParsedFlushInput,
  context: { nowIso: string; sessionId: string },
): Record<string, unknown> {
  const { nowIso, sessionId } = context;
  return {
    anchors: {
      focus_paths: [],
      related_links: [],
    },
    context_needed: parsed.contextNeeded,
    created_at: nowIso,
    goal: truncateText(parsed.summary, 180),
    next_actions: parsed.nextActions,
    open_questions: parsed.openQuestions,
    plan: [],
    progress: {
      blockers: [],
      completed: [],
      in_flight: [],
    },
    snapshot_id: `${FLUSH_SOURCE}-snapshot-${sessionId}-${Date.now().toString()}`,
    ...(parsed.activeGoal !== undefined ? { x_active_goal: parsed.activeGoal } : {}),
    ...(parsed.stateModel !== undefined
      ? { x_state_model: parsed.stateModel, x_state_model_provenance: 'agent-authored' }
      : {}),
    ...(parsed.envModel !== undefined ? { x_env_model: parsed.envModel } : {}),
  };
}

export function collectContinuityQualityWarnings(parsed: ParsedFlushInput): string[] {
  const warnings: string[] = [];

  if (parsed.summary.length < MIN_CONTINUITY_SUMMARY_CHARS) {
    warnings.push(
      `Continuity quality warning: summary is brief (${String(parsed.summary.length)} chars). ` +
        `Target at least ${String(MIN_CONTINUITY_SUMMARY_CHARS)} chars with concrete outcomes, decisions, and handoff context.`,
    );
  }
  if (parsed.nextActions.length === 0) {
    warnings.push(
      'Continuity quality warning: nextActions is missing or empty. ' +
        'Add nextActions to this memory_flush call so the next session knows what to do first.',
    );
  }
  if (parsed.openQuestions.length === 0) {
    warnings.push(
      'Continuity quality warning: openQuestions is missing or empty. ' +
        'Add openQuestions to this memory_flush call to preserve unresolved decisions for the next session.',
    );
  }
  if (parsed.stateModel === undefined) {
    warnings.push(
      'Continuity quality warning: stateModel is missing. ' +
        'Add stateModel with assumptions, uncertainty, constraints, and strategy_confidence to this memory_flush call.',
    );
  }
  if (parsed.envModel === undefined) {
    warnings.push(
      'Continuity quality warning: envModel is missing. ' +
        'Add envModel (branch, workspaceDirty, openPrs, failingChecks) to this memory_flush call for environment continuity.',
    );
  }

  return warnings;
}

export async function flushSession(
  input: unknown,
  dependencyOverrides: Partial<FlushSessionDependencies> = {},
): Promise<FlushResult> {
  const dependencies: FlushSessionDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...dependencyOverrides,
  };
  const parsed = parseFlushInput(input);
  if (parsed.sessionId !== undefined && parsed.repoSlug === undefined && !parsed.project?.includes('/')) {
    parsed.project = normalizeProjectScope({
      project: parsed.project,
      repoId: await dependencies.getSessionProject(parsed.sessionId),
    });
  }
  const resolvedSessionId = parsed.sessionId ?? dependencies.uuid();
  const continuityWarnings = [...parsed.normalizationWarnings, ...collectContinuityQualityWarnings(parsed)];
  if (parsed.sessionId === undefined) {
    continuityWarnings.push(
      'Host session identity was not supplied. This flush generated a sessionId for provenance; it is not an attested host identity. ' +
        'Pass the host sessionId on subsequent flushes, and keep task stable across sessions. Recover task-scoped context with memory_continuity_pack.',
    );
  }

  logContinuityWarnings({
    dependencies,
    sessionId: resolvedSessionId,
    warnings: continuityWarnings,
  });

  const preparedCoreWrites = await prepareCoreWrites({
    dependencies,
    parsed,
    sessionId: resolvedSessionId,
  });
  const coreWrites = await commitCoreFlushWrites({
    buildFlushSnapshotValue,
    dependencies,
    parsed,
    preparedCoreWrites,
    sessionId: resolvedSessionId,
  });

  const coreStored = [...coreWrites.actionableMemories];
  let memoriesStored = coreWrites.totalStored;
  const postCommit = await runPostCommitStages({
    coreStored,
    dependencies,
    parsed,
    sessionId: resolvedSessionId,
  });
  const responseWarnings = [...continuityWarnings, ...postCommit.warnings];

  memoriesStored += postCommit.reflection.storedMemories.length;

  return {
    ...(coreWrites.calibrations.length > 0
      ? { calibration: buildFlushCalibrationResult(coreWrites.calibrations) }
      : {}),
    ...(postCommit.consolidation !== undefined ? { consolidation: postCommit.consolidation } : {}),
    continuityPack: postCommit.continuityPack,
    ...(postCommit.reflection.storedMemories.length > 0
      ? { reflections: { count: postCommit.reflection.storedMemories.length } }
      : {}),
    flushed: true,
    memoriesStored,
    sessionId: resolvedSessionId,
    ...(responseWarnings.length > 0 ? { warnings: responseWarnings } : {}),
  };
}

function buildFlushCalibrationResult(entries: StoredMemoryCalibration[]): FlushCalibrationResult {
  const representative = [...entries].sort((left, right) => right.priorMemoryCount - left.priorMemoryCount)[0];
  if (representative === undefined) {
    throw new Error('Cannot build memory_flush calibration result without entries.');
  }

  return {
    calibratedConfidence: representative.calibratedConfidence,
    declaredConfidence: representative.declaredConfidence,
    entries,
    meanDeclaredConfidence: representative.meanDeclaredConfidence,
    priorMemoryCount: representative.priorMemoryCount,
    reversalRate: representative.reversalRate,
    scope: representative.scope,
    window: representative.window,
  };
}

const VALID_CONFIDENCE_VALUES = new Set<string>(STRATEGY_CONFIDENCE_VALUES);

export function parseFlushInput(input: unknown): ParsedFlushInput {
  if (!isRecord(input)) {
    throw new Error('memory_flush requires an object input with a summary field.');
  }

  const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
  if (summary.length === 0) {
    throw new Error('memory_flush requires a non-empty summary.');
  }

  const normalizationWarnings: string[] = [];
  let stateModel: Record<string, unknown> | undefined;
  if (isRecord(input.stateModel)) {
    const normalized = normalizeStateModelConfidence(input.stateModel);
    stateModel = normalized.model;
    normalizationWarnings.push(...normalized.warnings);
  }

  return {
    activeGoal: readOptionalText(input.activeGoal),
    agent: readOptionalText(input.agent),
    contextNeeded: readStringArray(input.contextNeeded),
    decisions: readStringArray(input.decisions),
    envModel: isRecord(input.envModel) ? input.envModel : undefined,
    lead: readOptionalText(input.lead),
    nextActions: readStringArray(input.nextActions),
    normalizationWarnings,
    openQuestions: readStringArray(input.openQuestions),
    outcome: readOptionalText(input.outcome),
    project: normalizeProjectScope(input),
    ...(readOptionalText(input.repoSlug) === undefined ? {} : { repoSlug: readOptionalText(input.repoSlug) }),
    rootCauses: readStringArray(input.rootCauses),
    sessionId: readOptionalText(input.sessionId),
    source: readOptionalText(input.source),
    stateModel,
    summary,
    task: readOptionalText(input.task),
  };
}

const NEAR_MISS_SEPARATOR = /[-_\s]+/;

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeConfidenceValue(
  value: unknown,
):
  | { error: string; status: 'invalid' }
  | { normalized: string; status: 'normalized'; warning: string }
  | { normalized: string; status: 'valid' } {
  if (typeof value === 'string' && VALID_CONFIDENCE_VALUES.has(value)) {
    return { normalized: value, status: 'valid' };
  }

  // Check for separator-delimited near-miss tokens (e.g. "medium-high", "low_medium")
  if (typeof value === 'string') {
    const tokens = value.toLowerCase().split(NEAR_MISS_SEPARATOR);
    for (const token of tokens) {
      if (VALID_CONFIDENCE_VALUES.has(token)) {
        return {
          normalized: token,
          status: 'normalized',
          warning: `confidence value "${value}" normalized to "${token}".`,
        };
      }
    }
  }

  return {
    error:
      `confidence value ${JSON.stringify(value)} is not valid. ` +
      `Accepted values: ${STRATEGY_CONFIDENCE_VALUES.join(', ')}.`,
    status: 'invalid',
  };
}

function normalizeStateModelConfidence(raw: Record<string, unknown>): {
  model: Record<string, unknown>;
  warnings: string[];
} {
  const warnings: string[] = [];
  let model = raw;

  // Normalize top-level strategy_confidence
  const { strategy_confidence } = raw;
  const scValid = typeof strategy_confidence === 'string' && VALID_CONFIDENCE_VALUES.has(strategy_confidence);
  if (!scValid) {
    const scWarning =
      strategy_confidence === undefined
        ? 'stateModel.strategy_confidence was missing; normalized to "medium".'
        : `stateModel.strategy_confidence had invalid value "${String(strategy_confidence)}"; normalized to "medium".`;
    warnings.push(scWarning);
    model = { ...model, strategy_confidence: 'medium' };
  }

  // Normalize confidence_history entries
  if (Array.isArray(raw.confidence_history)) {
    const errors: string[] = [];
    const historyWarnings: string[] = [];
    const normalizedHistory = raw.confidence_history.map((entry: unknown, index: number) => {
      if (!isRecord(entry)) return entry;
      const result = normalizeConfidenceValue(entry.value);
      if (result.status === 'invalid') {
        errors.push(`stateModel.confidence_history[${String(index)}]: ${result.error}`);
        return entry;
      }
      if (result.status === 'normalized') {
        historyWarnings.push(`stateModel.confidence_history[${String(index)}].${result.warning}`);
        return { ...entry, value: result.normalized };
      }
      return entry;
    });
    if (errors.length > 0) {
      throw new Error(errors.join(' '));
    }
    if (historyWarnings.length > 0) {
      warnings.push(...historyWarnings);
      model = { ...model, confidence_history: normalizedHistory };
    }
  }

  return { model, warnings };
}

async function refreshContinuityPackAfterCommit(input: {
  dependencies: FlushSessionDependencies;
  parsed: ParsedFlushInput;
  reflectionCount: number;
  sessionId: string;
}): Promise<ContinuityPackRefreshResult> {
  try {
    return await input.dependencies.refreshContinuityPack({
      parsed: input.parsed,
      reflectionCount: input.reflectionCount,
      sessionId: input.sessionId,
    });
  } catch (error: unknown) {
    const message = formatUnknownError(error);
    input.dependencies.logWarn('flush_session.continuity_pack_refresh_failed', {
      message: `Continuity pack refresh failed after core memory_flush commit: ${message}`,
      sessionId: input.sessionId,
    });
    return {
      message,
      reason: 'refresh_failed',
      status: 'error',
    };
  }
}

async function runPostCommitStages(input: {
  coreStored: StoredMemoryInfo[];
  dependencies: FlushSessionDependencies;
  parsed: ParsedFlushInput;
  sessionId: string;
}) {
  const reflection = await input.dependencies.runReflection({
    agent: input.parsed.agent,
    decisions: input.parsed.decisions,
    project: input.parsed.project,
    rootCauses: input.parsed.rootCauses,
    sessionId: input.sessionId,
    source: input.parsed.source,
    stateModel: input.parsed.stateModel,
    summary: input.parsed.summary,
  });

  const continuityPack = await refreshContinuityPackAfterCommit({
    dependencies: input.dependencies,
    parsed: input.parsed,
    reflectionCount: reflection.storedMemories.length,
    sessionId: input.sessionId,
  });
  const warnings =
    continuityPack.status === 'error' ? [`Continuity pack refresh warning: ${continuityPack.message}`] : [];

  input.coreStored.push(...reflection.storedMemories);
  const consolidation = await runConsolidation({
    dependencies: input.dependencies,
    memories: input.coreStored,
    sessionId: input.sessionId,
  });

  return { consolidation, continuityPack, reflection, warnings };
}
