import {
  countContestedMemories,
  getCapabilities,
  getSessionResume,
  recallMemories,
  searchMemories,
  searchTemporalMemories,
} from './db.js';
import { MEMORY_TYPE_VALUES, type MemoryType } from './db/memory-types.js';
import { readOptionalText, readStringArray } from './db/normalization.js';
import { formatError, isRecord } from './db/type-guards.js';
import { type EnvProbeMode, type EnvProbeStatus, type LocalEnvironment, probeEnvironment } from './env-probe.js';
import { formatMemoryPayload as formatProjectedMemoryPayload } from './memory-projection.js';
import { isTimeoutError, resolveTimeoutPolicy, runDbStepWithTimeout } from './timeout-policy.js';

export type MemoryDetail = 'compact' | 'full';

export interface MemoryOrientCapabilities {
  embedding: boolean;
  envProbe: 'full' | 'local' | 'none';
  search: boolean;
  searchAvailable: boolean;
  sessionResume: boolean;
}
export interface MemoryOrientDependencies {
  countContestedMemories: (input: unknown) => Promise<number>;
  getCapabilities: () => { hasEmbeddingColumn: boolean };
  getSessionResume: (input: unknown) => Promise<unknown>;
  probeEnvironment: (mode: EnvProbeMode, options?: { cwd?: string }) => ReturnType<typeof probeEnvironment>;
  recallMemories: (input: unknown) => Promise<unknown[]>;
  searchMemories: (input: unknown) => Promise<unknown[]>;
  searchTemporalMemories?: (input: unknown) => Promise<unknown[]>;
}

export interface MemoryOrientResponse {
  capabilities: MemoryOrientCapabilities;
  orientation: {
    activeGoal: null | string;
    contested: number;
    environment: LocalEnvironment | null;
    environmentStatus: EnvProbeStatus;
    fullContentTopN: number;
    memoryDetail: MemoryDetail;
    memoryPayloadApproxTokens: number;
    memoryPayloadBudgetChars: number;
    memoryPayloadBudgetExceeded: boolean;
    memoryPayloadChars: number;
    priorSession: null | Record<string, unknown>;
    recentMemories: unknown[];
    retrievalDiagnostics?: RetrievalDiagnostics;
    taskRelevant: unknown[];
    taskSearchResultCount: null | number;
    taskSearchStatus: TaskSearchStatus;
    truncatedSections?: OrientTruncatedSection[];
    x_active_goal: null | string;
  };
  status: 'degraded' | 'ok' | 'partial';
  warnings: string[];
}

export type OrientTruncatedSection = 'priorSession' | 'recentMemories' | 'taskRelevant';

export interface RetrievalDiagnostics {
  intents: {
    direct: RetrievalIntentStatus;
    implication: RetrievalIntentStatus;
    temporal: RetrievalIntentStatus;
  };
  merge: {
    candidateCount: number;
    decisions: RetrievalMergeDecision[];
    decisionSampleTruncated: boolean;
    dedupedCount: number;
    selectedCount: number;
  };
  overlap: {
    allThree: number;
    directImplication: number;
    directTemporal: number;
    metric: 'jaccard';
    temporalImplication: number;
  };
  strategy: 'fanout_v1';
}

export type RetrievalIntentName = 'direct' | 'implication' | 'temporal';

export interface RetrievalIntentStatus {
  durationMs: number;
  hitCount: number;
  selectedCount: number;
  status: RetrievalIntentStatusValue;
}

export type RetrievalIntentStatusValue = 'error' | 'ok' | 'timeout';

export interface RetrievalMergeDecision {
  intents: RetrievalIntentName[];
  memoryId: number;
  reason: RetrievalMergeReason;
}

export type RetrievalMergeReason =
  | 'deduped_duplicate'
  | 'direct_baseline'
  | 'implication_coverage'
  | 'temporal_append'
  | 'trimmed_budget';

export type TaskSearchStatus = 'error' | 'ok' | 'skipped';

type ScopeArgs = Record<string, string>;

const DEFAULT_MEMORY_DETAIL: MemoryDetail = 'compact';
const DEFAULT_FULL_CONTENT_TOP_N = 0;
const DEFAULT_ORIENT_PAYLOAD_BUDGET_CHARS = 8_000;
const DEFAULT_RECALL_CONDITIONING_MAX_TOKENS = 16;
const ENV_PROBE_VALUES = ['none', 'local', 'full'] as const;
const MEMORY_DETAIL_VALUES = ['compact', 'full'] as const;
const MAX_FULL_CONTENT_TOP_N = 5;
const ORIENT_PAYLOAD_HEADROOM_MULTIPLIER = 1.05;
const ORIENT_SECTION_BUDGET_CHARS = {
  priorSession: 1_500,
  recentMemories: 2_500,
  taskRelevant: 2_500,
} as const satisfies Record<OrientTruncatedSection, number>;

const FANOUT_V1_DECISION_SAMPLE_LIMIT = 20;
const FANOUT_V1_LANE_LIMIT = 5;
const FANOUT_V1_TASK_RELEVANT_LIMIT = 8;

const DEFAULT_DEPENDENCIES: MemoryOrientDependencies = {
  countContestedMemories,
  getCapabilities,
  getSessionResume,
  probeEnvironment,
  recallMemories,
  searchMemories,
  searchTemporalMemories,
};

export async function orientMemory(
  input: unknown,
  dependencies: MemoryOrientDependencies = DEFAULT_DEPENDENCIES,
): Promise<MemoryOrientResponse> {
  const stepTimeoutMs = resolveTimeoutPolicy().orient.stepTimeoutMs;
  const request = isRecord(input) ? input : {};
  const agent = readOptionalText(request.agent);
  const project = readOptionalText(request.project);
  const sessionId = readOptionalText(request.sessionId ?? request.session_id);
  const task = readOptionalText(request.task);
  const memoryType = parseMemoryType(request.memoryType ?? request.memory_type);
  const memoryDetail = parseMemoryDetail(request.memoryDetail ?? request.memory_detail);
  const fullContentTopN = parseFullContentTopN(request.fullContentTopN ?? request.full_content_top_n);
  const envProbe = parseEnvProbe(request.envProbe);
  const requestedActiveGoal = readOptionalText(request.activeGoal);
  const cwd = readOptionalText(request.cwd);
  const memoryScopeArgs = omitUndefined({ agent, memoryType, project });
  const resumeScopeArgs = omitUndefined({ agent, project, sessionId });
  const contestedWarnings: string[] = [];
  const environmentWarnings: string[] = [];
  const recallWarnings: string[] = [];
  const resumeWarnings: string[] = [];
  const searchWarnings: string[] = [];

  const recallPromise = runRecallStep({
    dependencies,
    scopeArgs: memoryScopeArgs,
    stepTimeoutMs,
    warnings: recallWarnings,
  });
  const contestedPromise = runContestedStep({
    dependencies,
    project,
    stepTimeoutMs,
    warnings: contestedWarnings,
  });
  const { priorSession, resumeSucceeded } = await runResumeStep({
    dependencies,
    scopeArgs: resumeScopeArgs,
    stepTimeoutMs,
    warnings: resumeWarnings,
  });
  const snapshotActiveGoal = extractSnapshotActiveGoal(priorSession);
  const activeGoal = requestedActiveGoal ?? snapshotActiveGoal;
  const searchPromise = runSearchStep({
    activeGoal,
    dependencies,
    scopeArgs: memoryScopeArgs,
    stepTimeoutMs,
    task,
    warnings: searchWarnings,
  });
  const [
    { recallSucceeded, recentMemories: unconditionedRecentMemories },
    {
      laneResults,
      laneTimings: searchLaneTimings,
      retrievalDiagnostics,
      searchAvailable,
      searchSucceeded,
      taskRelevant,
      taskSearchResultCount,
      taskSearchStatus,
    },
    { contested, contestedSucceeded },
  ] = await Promise.all([recallPromise, searchPromise, contestedPromise]);
  // Environment probing uses synchronous Git/GitHub subprocesses. Run it only
  // after the memory deadlines settle so it cannot consume their timer budget.
  const { envProbeResult } = await runEnvProbeStep({
    cwd,
    dependencies,
    envProbe,
    stepTimeoutMs,
    warnings: environmentWarnings,
  });
  const recentMemories = applyRecallTaskConditioning({
    activeGoal,
    memories: unconditionedRecentMemories,
    task,
  });

  const allMemorySubstepsSucceeded = recallSucceeded && resumeSucceeded && searchSucceeded && contestedSucceeded;
  const memoryWarnings = [...recallWarnings, ...resumeWarnings, ...searchWarnings, ...contestedWarnings];
  const warnings = [...memoryWarnings, ...environmentWarnings];
  const memoryPayloadBudgetChars = resolveOrientPayloadBudgetChars();
  let formattedPriorSession = priorSession;
  let formattedRecentMemories = formatMemoryPayload({
    fullContentTopN,
    memories: recentMemories,
    memoryDetail,
    query: task,
  });
  let formattedTaskRelevant = formatMemoryPayload({
    fullContentTopN,
    memories: taskRelevant,
    memoryDetail,
    query: task,
  });
  let memoryPayloadChars = estimateOrientMemoryPayloadChars({
    priorSession: formattedPriorSession,
    recentMemories: formattedRecentMemories,
    taskRelevant: formattedTaskRelevant,
  });

  let finalRetrievalDiagnostics = retrievalDiagnostics;
  let finalTaskSearchResultCount = taskSearchResultCount;
  const truncatedSections = new Set<OrientTruncatedSection>();

  if (memoryPayloadChars > memoryPayloadBudgetChars) {
    const prunedRecent = pruneSessionSummaries(recentMemories);
    let prunedTaskRelevant: unknown[];
    if (laneResults !== undefined) {
      const prunedMerge = mergeFanoutLaneResults({
        directResults: pruneSessionSummaries(laneResults.directResults),
        implicationResults: pruneSessionSummaries(laneResults.implicationResults),
        laneTimings: searchLaneTimings ?? {
          direct: { durationMs: 0, status: 'ok' },
          implication: { durationMs: 0, status: 'ok' },
          temporal: { durationMs: 0, status: 'ok' },
        },
        temporalResults: pruneSessionSummaries(laneResults.temporalResults),
      });
      prunedTaskRelevant = prunedMerge.mergedResults;
      finalRetrievalDiagnostics = prunedMerge.retrievalDiagnostics;
      finalTaskSearchResultCount = prunedMerge.mergedResults.length;
    } else {
      prunedTaskRelevant = pruneSessionSummaries(taskRelevant);
      finalTaskSearchResultCount = prunedTaskRelevant.length;
      finalRetrievalDiagnostics = undefined;
    }
    if (prunedRecent.length !== recentMemories.length) {
      truncatedSections.add('recentMemories');
    }
    if (prunedTaskRelevant.length !== taskRelevant.length) {
      truncatedSections.add('taskRelevant');
    }
    formattedRecentMemories = formatMemoryPayload({
      fullContentTopN,
      memories: prunedRecent,
      memoryDetail: 'compact',
      query: task,
    });
    formattedTaskRelevant = formatMemoryPayload({
      fullContentTopN,
      memories: prunedTaskRelevant,
      memoryDetail: 'compact',
      query: task,
    });
    memoryPayloadChars = estimateOrientMemoryPayloadChars({
      priorSession: formattedPriorSession,
      recentMemories: formattedRecentMemories,
      taskRelevant: formattedTaskRelevant,
    });
  }

  if (memoryPayloadChars > memoryPayloadBudgetChars) {
    const budgeted = enforceOrientPayloadBudget({
      memoryPayloadBudgetChars,
      priorSession: formattedPriorSession,
      recentMemories: formattedRecentMemories,
      taskRelevant: formattedTaskRelevant,
    });
    formattedPriorSession = budgeted.priorSession;
    formattedRecentMemories = budgeted.recentMemories;
    formattedTaskRelevant = budgeted.taskRelevant;
    memoryPayloadChars = budgeted.memoryPayloadChars;
    for (const section of budgeted.truncatedSections) {
      truncatedSections.add(section);
    }
    finalTaskSearchResultCount =
      finalTaskSearchResultCount === null ? null : Math.min(finalTaskSearchResultCount, formattedTaskRelevant.length);
    finalRetrievalDiagnostics = pruneRetrievalDiagnosticsForTaskRelevant(
      finalRetrievalDiagnostics,
      formattedTaskRelevant,
    );
  }

  const orientPayloadHardLimitChars = resolveOrientPayloadHardLimitChars(memoryPayloadBudgetChars);
  const memoryPayloadBudgetExceeded = memoryPayloadChars > orientPayloadHardLimitChars;
  const memoryPayloadApproxTokens = estimateTokenCountFromChars(memoryPayloadChars);
  const finalTruncatedSections = [...truncatedSections].sort((left, right) => left.localeCompare(right));

  return {
    capabilities: {
      embedding: safeGetEmbeddingCapability(dependencies),
      envProbe: envProbeResult.capability,
      search: task !== undefined && searchSucceeded,
      searchAvailable,
      sessionResume: resumeSucceeded,
    },
    orientation: {
      activeGoal: activeGoal ?? null,
      contested,
      environment: envProbeResult.environment,
      environmentStatus: envProbeResult.status,
      fullContentTopN,
      memoryDetail,
      memoryPayloadApproxTokens,
      memoryPayloadBudgetChars,
      memoryPayloadBudgetExceeded,
      memoryPayloadChars,
      priorSession: formattedPriorSession,
      recentMemories: formattedRecentMemories,
      ...(finalRetrievalDiagnostics !== undefined ? { retrievalDiagnostics: finalRetrievalDiagnostics } : {}),
      taskRelevant: formattedTaskRelevant,
      taskSearchResultCount: finalTaskSearchResultCount,
      taskSearchStatus,
      ...(finalTruncatedSections.length > 0 ? { truncatedSections: finalTruncatedSections } : {}),
      x_active_goal: snapshotActiveGoal ?? null,
    },
    status: resolveStatus({
      allMemorySubstepsSucceeded,
      memoryWarnings,
      recallSucceeded,
      resumeSucceeded,
    }),
    warnings,
  };
}

function applyRecallTaskConditioning(input: {
  activeGoal: string | undefined;
  memories: unknown[];
  task: string | undefined;
}) {
  const conditioningTokens = buildRecallConditioningTokens({
    activeGoal: input.activeGoal,
    task: input.task,
  });
  if (conditioningTokens.length === 0 || input.memories.length <= 1) {
    return input.memories;
  }

  const scoredMemories = input.memories.map((memory, index) => ({
    index,
    memory,
    score: scoreMemoryForRecallConditioning(memory, conditioningTokens),
  }));
  const hasAnySignal = scoredMemories.some(item => item.score > 0);
  if (!hasAnySignal) {
    return input.memories;
  }

  return [...scoredMemories]
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.index - right.index;
    })
    .map(item => item.memory);
}

function buildEnumValidationError(input: {
  acceptedValues: readonly string[];
  correctionHint: string;
  fieldName: string;
  rawValue: unknown;
}) {
  return (
    `${input.fieldName} must be one of: ${input.acceptedValues.join(', ')}. ` +
    `Received ${formatEnumLikeValue(input.rawValue)}. ${input.correctionHint}`
  );
}

function buildImplicationQuery(task: string | undefined, activeGoal: string | undefined): string {
  const combined = [task ?? '', activeGoal ?? ''].join(' ');
  const tokens = combined
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 2);
  const unique = [...new Set(tokens)].slice(0, 8);
  return unique.length > 0 ? unique.join(' OR ') : (task ?? '');
}

function buildRecallConditioningTokens(input: { activeGoal: string | undefined; task: string | undefined }) {
  const combinedText = [input.task, input.activeGoal].filter((value): value is string => value !== undefined).join(' ');
  const normalized = combinedText.trim().toLowerCase();
  if (normalized.length === 0) {
    return [];
  }

  const deduped = new Set<string>();
  for (const token of normalized.split(/[^a-z0-9]+/u)) {
    if (token.length === 0) {
      continue;
    }
    if (!/^\d+$/u.test(token) && token.length < 2) {
      continue;
    }

    deduped.add(token);
    if (deduped.size >= DEFAULT_RECALL_CONDITIONING_MAX_TOKENS) {
      break;
    }
  }

  return [...deduped];
}

function buildRetrievalDiagnostics(input: {
  directResults: unknown[];
  implicationResults: unknown[];
  laneTimings: Record<RetrievalIntentName, { durationMs: number; status: RetrievalIntentStatusValue }>;
  mergedResults: unknown[];
  temporalResults: unknown[];
}): RetrievalDiagnostics {
  const directIds = new Set(input.directResults.map(getMemoryId).filter((id): id is number => id !== undefined));
  const temporalIds = new Set(input.temporalResults.map(getMemoryId).filter((id): id is number => id !== undefined));
  const implicationIds = new Set(
    input.implicationResults.map(getMemoryId).filter((id): id is number => id !== undefined),
  );

  return {
    intents: {
      direct: {
        ...input.laneTimings.direct,
        hitCount: input.directResults.length,
        selectedCount: input.directResults.length,
      },
      implication: {
        ...input.laneTimings.implication,
        hitCount: input.implicationResults.length,
        selectedCount: 0,
      },
      temporal: {
        ...input.laneTimings.temporal,
        hitCount: input.temporalResults.length,
        selectedCount: 0,
      },
    },
    merge: {
      candidateCount: 0,
      decisions: [],
      decisionSampleTruncated: false,
      dedupedCount: 0,
      selectedCount: 0,
    },
    overlap: {
      allThree: computeAllThreeJaccard([directIds, temporalIds, implicationIds]),
      directImplication: computeJaccard(directIds, implicationIds),
      directTemporal: computeJaccard(directIds, temporalIds),
      metric: 'jaccard',
      temporalImplication: computeJaccard(temporalIds, implicationIds),
    },
    strategy: 'fanout_v1',
  };
}

function compactPriorSessionForBudget(priorSession: null | Record<string, unknown>): null | Record<string, unknown> {
  if (priorSession === null) {
    return null;
  }

  const compacted: Record<string, unknown> = { truncated: true };
  const sessionId = readOptionalText(priorSession.sessionId);
  const status = readOptionalText(priorSession.status);
  const resolvedVia = readOptionalText(priorSession.resolvedVia);
  if (sessionId !== undefined) compacted.sessionId = sessionId;
  if (status !== undefined) compacted.status = status;
  if (resolvedVia !== undefined) compacted.resolvedVia = resolvedVia;

  const session = isRecord(priorSession.session) ? priorSession.session : undefined;
  if (session !== undefined) {
    compacted.session = omitUndefinedUnknown({
      agent: readOptionalText(session.agent),
      startedAt: readOptionalText(session.startedAt),
      status: readOptionalText(session.status),
      taskTitle: readOptionalText(session.taskTitle),
      tool: readOptionalText(session.tool),
    });
  }

  const snapshot = isRecord(priorSession.snapshot) ? priorSession.snapshot : undefined;
  if (snapshot !== undefined) {
    const snapshotJson = isRecord(snapshot.snapshotJson) ? snapshot.snapshotJson : undefined;
    compacted.snapshot = omitUndefinedUnknown({
      createdAt: readOptionalText(snapshot.createdAt),
      snapshotId: readOptionalText(snapshot.snapshotId),
      snapshotJson:
        snapshotJson === undefined
          ? undefined
          : omitUndefinedUnknown({
              goal: truncateBudgetText(readOptionalText(snapshotJson.goal), 180),
              next_actions: readStringArray(snapshotJson.next_actions).slice(0, 3),
              open_questions: readStringArray(snapshotJson.open_questions).slice(0, 3),
              x_active_goal: truncateBudgetText(readOptionalText(snapshotJson.x_active_goal), 180),
            }),
    });
  }

  return compacted;
}

function computeAllThreeJaccard(sets: [Set<number>, Set<number>, Set<number>]): number {
  const [a, b, c] = sets;
  const union = new Set([...a, ...b, ...c]);
  if (union.size === 0) return 0;
  let intersection = 0;
  for (const id of union) {
    if (a.has(id) && b.has(id) && c.has(id)) intersection += 1;
  }
  return intersection / union.size;
}

function computeJaccard(leftIds: Set<number>, rightIds: Set<number>): number {
  if (leftIds.size === 0 && rightIds.size === 0) return 0;
  let intersection = 0;
  for (const id of leftIds) {
    if (rightIds.has(id)) intersection += 1;
  }
  const union = leftIds.size + rightIds.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function enforceOrientPayloadBudget(input: {
  memoryPayloadBudgetChars: number;
  priorSession: null | Record<string, unknown>;
  recentMemories: unknown[];
  taskRelevant: unknown[];
}): {
  memoryPayloadChars: number;
  priorSession: null | Record<string, unknown>;
  recentMemories: unknown[];
  taskRelevant: unknown[];
  truncatedSections: OrientTruncatedSection[];
} {
  const truncatedSections = new Set<OrientTruncatedSection>();
  const hardLimitChars = resolveOrientPayloadHardLimitChars(input.memoryPayloadBudgetChars);
  let priorSession = input.priorSession;
  let recentMemories = input.recentMemories;
  let taskRelevant = input.taskRelevant;

  const compactedPriorSession = compactPriorSessionForBudget(priorSession);
  if (priorSession !== compactedPriorSession) {
    priorSession = compactedPriorSession;
    truncatedSections.add('priorSession');
  }

  const sectionTrimmedTaskRelevant = trimArrayToSectionBudget({
    items: taskRelevant,
    priority: getMemoryBudgetPriority,
    section: 'taskRelevant',
  });
  taskRelevant = sectionTrimmedTaskRelevant.items;
  if (sectionTrimmedTaskRelevant.truncated) {
    truncatedSections.add('taskRelevant');
  }

  const sectionTrimmedRecentMemories = trimArrayToSectionBudget({
    items: recentMemories,
    priority: getMemoryBudgetPriority,
    section: 'recentMemories',
  });
  recentMemories = sectionTrimmedRecentMemories.items;
  if (sectionTrimmedRecentMemories.truncated) {
    truncatedSections.add('recentMemories');
  }

  let memoryPayloadChars = estimateOrientMemoryPayloadChars({
    priorSession,
    recentMemories,
    taskRelevant,
  });

  while (memoryPayloadChars > hardLimitChars) {
    if (priorSession !== null) {
      priorSession = null;
      truncatedSections.add('priorSession');
    } else if (recentMemories.length > 0) {
      recentMemories = recentMemories.slice(0, -1);
      truncatedSections.add('recentMemories');
    } else if (taskRelevant.length > 0) {
      taskRelevant = taskRelevant.slice(0, -1);
      truncatedSections.add('taskRelevant');
    } else {
      break;
    }

    memoryPayloadChars = estimateOrientMemoryPayloadChars({
      priorSession,
      recentMemories,
      taskRelevant,
    });
  }

  return {
    memoryPayloadChars,
    priorSession,
    recentMemories,
    taskRelevant,
    truncatedSections: [...truncatedSections],
  };
}

function estimateJsonChars(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function estimateOrientMemoryPayloadChars(input: {
  priorSession: null | Record<string, unknown>;
  recentMemories: unknown[];
  taskRelevant: unknown[];
}): number {
  try {
    return JSON.stringify({
      priorSession: input.priorSession,
      recentMemories: input.recentMemories,
      taskRelevant: input.taskRelevant,
    }).length;
  } catch {
    return 0;
  }
}

function estimateTokenCountFromChars(charCount: number): number {
  if (!Number.isFinite(charCount) || charCount <= 0) {
    return 0;
  }
  return Math.ceil(charCount / 4);
}

function extractLaneResults(
  input: { lane: RetrievalIntentName; settled: PromiseSettledResult<unknown> },
  warnings: string[],
): unknown[] {
  if (input.settled.status === 'fulfilled') {
    return Array.isArray(input.settled.value) ? input.settled.value : [];
  }
  warnings.push(`search ${input.lane} failed: ${formatError(input.settled.reason)}`);
  return [];
}

function extractSnapshotActiveGoal(priorSession: null | Record<string, unknown>): string | undefined {
  if (priorSession === null) {
    return undefined;
  }

  const snapshot = priorSession.snapshot;
  if (!isRecord(snapshot)) {
    return undefined;
  }

  const snapshotJson = snapshot.snapshotJson;
  if (!isRecord(snapshotJson)) {
    return undefined;
  }

  const activeGoal = readOptionalText(snapshotJson.x_active_goal);
  return activeGoal;
}

function formatEnumLikeValue(value: unknown) {
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return 'undefined';
  }
  if (typeof value === 'string') {
    return `'${value}'`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatMemoryPayload(input: {
  fullContentTopN: number;
  memories: unknown[];
  memoryDetail: MemoryDetail;
  query?: string | undefined;
}) {
  return formatProjectedMemoryPayload(input);
}

function getFanoutPenaltyAdjustedScore(memory: unknown): number {
  if (!isRecord(memory)) {
    return 0;
  }
  const relevance = readOptionalNumber(memory.relevance) ?? readOptionalNumber(memory.decayedImportance) ?? 0;
  const signals = isRecord(memory.signals) ? memory.signals : undefined;
  const penalty = readOptionalNumber(memory.reversalPenalty) ?? readOptionalNumber(signals?.reversalPenalty) ?? 1;
  return relevance * Math.max(0.5, Math.min(1, penalty));
}

function getMemoryBudgetPriority(memory: unknown): number {
  if (!isRecord(memory)) {
    return 0;
  }

  const category = readOptionalText(memory.category);
  let score = 0;
  if (category === 'methodology') {
    score += 1_000;
  } else if (category === 'architecture') {
    score += 900;
  } else if (category === 'root-cause') {
    score += 600;
  } else if (category === 'decision' || category === 'convention') {
    score += 500;
  } else if (category === 'session-summary') {
    score -= 500;
  }

  const importance = readOptionalNumber(memory.importance) ?? readOptionalNumber(memory.decayedImportance);
  if (importance !== undefined) {
    score += Math.round(importance * 100);
  }

  return score;
}

function getMemoryCategory(memory: unknown): string | undefined {
  if (!isRecord(memory)) return undefined;
  return readOptionalText(memory.category);
}

function getMemoryId(memory: unknown): number | undefined {
  if (!isRecord(memory)) return undefined;
  const id = memory.id;
  return typeof id === 'number' ? id : undefined;
}

function isEnvProbeMode(value: string): value is EnvProbeMode {
  return ENV_PROBE_VALUES.includes(value as EnvProbeMode);
}

function isMemoryDetail(value: string): value is MemoryDetail {
  return MEMORY_DETAIL_VALUES.includes(value as MemoryDetail);
}

function isMemoryType(value: string): value is MemoryType {
  return MEMORY_TYPE_VALUES.includes(value as MemoryType);
}

function mergeFanoutLaneResults(input: {
  directResults: unknown[];
  implicationResults: unknown[];
  laneTimings: Record<RetrievalIntentName, { durationMs: number; status: RetrievalIntentStatusValue }>;
  temporalResults: unknown[];
}): { mergedResults: unknown[]; retrievalDiagnostics: RetrievalDiagnostics } {
  const directResults = rankFanoutLane(input.directResults);
  const temporalResults = rankFanoutLane(input.temporalResults);
  const implicationResults = rankFanoutLane(input.implicationResults);
  const merged: unknown[] = [];
  const mergedIds = new Set<number>();
  const decisions: RetrievalMergeDecision[] = [];

  // Phase 1: direct results in original order (canonical)
  for (const memory of directResults) {
    const id = getMemoryId(memory);
    if (id !== undefined) mergedIds.add(id);
    merged.push(memory);
    if (id !== undefined) {
      const intents: RetrievalIntentName[] = ['direct'];
      if (temporalResults.some(m => getMemoryId(m) === id)) intents.push('temporal');
      if (implicationResults.some(m => getMemoryId(m) === id)) intents.push('implication');
      decisions.push({ intents, memoryId: id, reason: 'direct_baseline' });
    }
  }

  // Phase 2: unique temporal results appended after direct
  for (const memory of temporalResults) {
    if (merged.length >= FANOUT_V1_TASK_RELEVANT_LIMIT) break;
    const id = getMemoryId(memory);
    if (id !== undefined && mergedIds.has(id)) {
      decisions.push({
        intents: [
          'temporal',
          ...(implicationResults.some(m => getMemoryId(m) === id) ? (['implication'] as const) : []),
        ],
        memoryId: id,
        reason: 'deduped_duplicate',
      });
      continue;
    }
    if (id !== undefined) mergedIds.add(id);
    merged.push(memory);
    if (id !== undefined) {
      decisions.push({
        intents: [
          'temporal',
          ...(implicationResults.some(m => getMemoryId(m) === id) ? (['implication'] as const) : []),
        ],
        memoryId: id,
        reason: 'temporal_append',
      });
    }
  }

  // Phase 3: unique implication results fill remaining budget
  for (const memory of implicationResults) {
    if (merged.length >= FANOUT_V1_TASK_RELEVANT_LIMIT) {
      const id = getMemoryId(memory);
      if (id !== undefined && !mergedIds.has(id)) {
        decisions.push({ intents: ['implication'], memoryId: id, reason: 'trimmed_budget' });
      }
      continue;
    }
    const id = getMemoryId(memory);
    if (id !== undefined && mergedIds.has(id)) {
      if (!decisions.some(d => d.memoryId === id)) {
        decisions.push({ intents: ['implication'], memoryId: id, reason: 'deduped_duplicate' });
      }
      continue;
    }
    if (id !== undefined) mergedIds.add(id);
    merged.push(memory);
    if (id !== undefined) {
      decisions.push({ intents: ['implication'], memoryId: id, reason: 'implication_coverage' });
    }
  }

  const diagnostics = buildRetrievalDiagnostics({
    directResults,
    implicationResults,
    laneTimings: input.laneTimings,
    mergedResults: merged,
    temporalResults,
  });
  diagnostics.merge.decisions = decisions.slice(0, FANOUT_V1_DECISION_SAMPLE_LIMIT);
  diagnostics.merge.decisionSampleTruncated = decisions.length > FANOUT_V1_DECISION_SAMPLE_LIMIT;
  diagnostics.merge.candidateCount = directResults.length + temporalResults.length + implicationResults.length;
  diagnostics.merge.dedupedCount = diagnostics.merge.candidateCount - merged.length;
  diagnostics.merge.selectedCount = merged.length;

  // Update per-lane selectedCount from decisions
  diagnostics.intents.temporal.selectedCount = decisions.filter(d => d.reason === 'temporal_append').length;
  diagnostics.intents.implication.selectedCount = decisions.filter(d => d.reason === 'implication_coverage').length;

  return { mergedResults: merged, retrievalDiagnostics: diagnostics };
}

function normalizeEnumLikeInput(input: { acceptedValues: readonly string[]; fieldName: string; fieldValue: unknown }) {
  const { acceptedValues, fieldName, fieldValue } = input;
  if (typeof fieldValue !== 'string') {
    throw new Error(
      buildEnumValidationError({
        acceptedValues,
        correctionHint: `Use a string value for ${fieldName}.`,
        fieldName,
        rawValue: fieldValue,
      }),
    );
  }

  const normalized = fieldValue.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new Error(
      buildEnumValidationError({
        acceptedValues,
        correctionHint: `Provide a non-empty ${fieldName} value.`,
        fieldName,
        rawValue: fieldValue,
      }),
    );
  }

  return normalized;
}

function omitUndefined(record: Record<string, string | undefined>): ScopeArgs {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as ScopeArgs;
}

function omitUndefinedUnknown(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function parseEnvProbe(value: unknown): EnvProbeMode {
  if (value === undefined || value === null) {
    return 'local';
  }
  const normalized = normalizeEnumLikeInput({
    acceptedValues: ENV_PROBE_VALUES,
    fieldName: 'envProbe',
    fieldValue: value,
  });
  if (isEnvProbeMode(normalized)) {
    return normalized;
  }
  throw new Error(
    buildEnumValidationError({
      acceptedValues: ENV_PROBE_VALUES,
      correctionHint: "Set envProbe to one of those values, or omit envProbe to use 'local'.",
      fieldName: 'envProbe',
      rawValue: value,
    }),
  );
}

function parseFullContentTopN(value: unknown): number {
  if (value === undefined || value === null) {
    return DEFAULT_FULL_CONTENT_TOP_N;
  }

  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue) || !Number.isInteger(parsedValue)) {
    throw new Error('fullContentTopN must be an integer between 0 and 5.');
  }
  if (parsedValue < 0 || parsedValue > MAX_FULL_CONTENT_TOP_N) {
    throw new Error('fullContentTopN must be an integer between 0 and 5.');
  }

  return parsedValue;
}

function parseMemoryDetail(value: unknown): MemoryDetail {
  if (value === undefined || value === null) {
    return DEFAULT_MEMORY_DETAIL;
  }

  const normalized = normalizeEnumLikeInput({
    acceptedValues: MEMORY_DETAIL_VALUES,
    fieldName: 'memoryDetail',
    fieldValue: value,
  });

  if (isMemoryDetail(normalized)) {
    return normalized;
  }

  throw new Error(
    buildEnumValidationError({
      acceptedValues: MEMORY_DETAIL_VALUES,
      correctionHint: "Set memoryDetail to one of those values, or omit memoryDetail to use 'compact'.",
      fieldName: 'memoryDetail',
      rawValue: value,
    }),
  );
}

function parseMemoryType(value: unknown): MemoryType | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const normalized = normalizeEnumLikeInput({
    acceptedValues: MEMORY_TYPE_VALUES,
    fieldName: 'memoryType',
    fieldValue: value,
  });
  if (isMemoryType(normalized)) {
    return normalized;
  }
  throw new Error(
    buildEnumValidationError({
      acceptedValues: MEMORY_TYPE_VALUES,
      correctionHint: 'Set memoryType to one of those values, or omit memoryType to include all memory types.',
      fieldName: 'memoryType',
      rawValue: value,
    }),
  );
}

function pruneRetrievalDiagnosticsForTaskRelevant(
  diagnostics: RetrievalDiagnostics | undefined,
  taskRelevant: unknown[],
): RetrievalDiagnostics | undefined {
  if (diagnostics === undefined) {
    return undefined;
  }

  const finalIds = new Set(taskRelevant.map(getMemoryId).filter((id): id is number => id !== undefined));
  const decisions = diagnostics.merge.decisions.filter(decision => finalIds.has(decision.memoryId));
  return {
    ...diagnostics,
    merge: {
      ...diagnostics.merge,
      decisions,
      decisionSampleTruncated:
        diagnostics.merge.decisionSampleTruncated || decisions.length < diagnostics.merge.decisions.length,
      dedupedCount: Math.max(0, diagnostics.merge.candidateCount - taskRelevant.length),
      selectedCount: taskRelevant.length,
    },
  };
}

function pruneSessionSummaries(memories: unknown[]): unknown[] {
  return memories.filter(memory => getMemoryCategory(memory) !== 'session-summary');
}

function rankFanoutLane(memories: unknown[]) {
  return memories
    .map((memory, index) => ({ index, memory, score: getFanoutPenaltyAdjustedScore(memory) }))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.index - right.index;
    })
    .map(item => item.memory);
}

function readOptionalNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function resolveOrientPayloadBudgetChars(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AI_MEMORY_ORIENT_PAYLOAD_BUDGET_CHARS;
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_ORIENT_PAYLOAD_BUDGET_CHARS;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_ORIENT_PAYLOAD_BUDGET_CHARS;
  }

  return parsed;
}

function resolveOrientPayloadHardLimitChars(memoryPayloadBudgetChars: number): number {
  return Math.floor(memoryPayloadBudgetChars * ORIENT_PAYLOAD_HEADROOM_MULTIPLIER);
}

function resolveStatus(input: {
  allMemorySubstepsSucceeded: boolean;
  memoryWarnings: string[];
  recallSucceeded: boolean;
  resumeSucceeded: boolean;
}): MemoryOrientResponse['status'] {
  if (input.memoryWarnings.length === 0 && input.allMemorySubstepsSucceeded) {
    return 'ok';
  }
  if (input.recallSucceeded || input.resumeSucceeded) {
    return 'partial';
  }
  return 'degraded';
}

async function runContestedStep(input: {
  dependencies: MemoryOrientDependencies;
  project: string | undefined;
  stepTimeoutMs: number;
  warnings: string[];
}): Promise<{ contested: number; contestedSucceeded: boolean }> {
  if (input.project === undefined) {
    return { contested: 0, contestedSucceeded: true };
  }

  try {
    const contested = await runStepWithTimeout({
      operation: 'contested_count',
      stepTimeoutMs: input.stepTimeoutMs,
      task: () => input.dependencies.countContestedMemories({ project: input.project }),
    });
    return { contested, contestedSucceeded: true };
  } catch (error: unknown) {
    input.warnings.push(`contested count failed: ${formatError(error)}`);
    return { contested: 0, contestedSucceeded: false };
  }
}

async function runEnvProbeStep(input: {
  cwd: string | undefined;
  dependencies: MemoryOrientDependencies;
  envProbe: EnvProbeMode;
  stepTimeoutMs: number;
  warnings: string[];
}): Promise<{
  envProbeResult: ReturnType<typeof probeEnvironment>;
}> {
  try {
    const envProbeResult = await runStepWithTimeout({
      operation: 'environment_probe',
      stepTimeoutMs: input.stepTimeoutMs,
      task: () =>
        Promise.resolve(
          input.dependencies.probeEnvironment(input.envProbe, input.cwd === undefined ? undefined : { cwd: input.cwd }),
        ),
    });
    input.warnings.push(...envProbeResult.warnings);
    return { envProbeResult };
  } catch (error: unknown) {
    input.warnings.push(`environment probe failed: ${formatError(error)}`);
    return {
      envProbeResult: {
        capability: input.envProbe === 'none' ? 'none' : 'local',
        environment: null,
        status: input.envProbe === 'none' ? 'disabled' : 'unavailable',
        warnings: [],
      },
    };
  }
}

async function runRecallStep(input: {
  dependencies: MemoryOrientDependencies;
  scopeArgs: ScopeArgs;
  stepTimeoutMs: number;
  warnings: string[];
}): Promise<{ recallSucceeded: boolean; recentMemories: unknown[] }> {
  try {
    const memories = await runStepWithTimeout({
      operation: 'recall',
      stepTimeoutMs: input.stepTimeoutMs,
      task: () => input.dependencies.recallMemories({ ...input.scopeArgs, limit: 5 }),
    });
    return {
      recallSucceeded: true,
      recentMemories: Array.isArray(memories) ? memories : [],
    };
  } catch (error: unknown) {
    input.warnings.push(`recall failed: ${formatError(error)}`);
    return { recallSucceeded: false, recentMemories: [] };
  }
}

async function runResumeStep(input: {
  dependencies: MemoryOrientDependencies;
  scopeArgs: ScopeArgs;
  stepTimeoutMs: number;
  warnings: string[];
}): Promise<{
  priorSession: null | Record<string, unknown>;
  resumeSucceeded: boolean;
}> {
  try {
    const resume = await runStepWithTimeout({
      operation: 'session_resume',
      stepTimeoutMs: input.stepTimeoutMs,
      task: () =>
        input.dependencies.getSessionResume({
          ...input.scopeArgs,
          eventLimit: 5,
        }),
    });
    if (!isRecord(resume)) {
      input.warnings.push('resume failed: invalid response shape');
      return { priorSession: null, resumeSucceeded: false };
    }
    return { priorSession: resume, resumeSucceeded: true };
  } catch (error: unknown) {
    input.warnings.push(`resume failed: ${formatError(error)}`);
    return { priorSession: null, resumeSucceeded: false };
  }
}

async function runSearchStep(input: {
  activeGoal: string | undefined;
  dependencies: MemoryOrientDependencies;
  scopeArgs: ScopeArgs;
  stepTimeoutMs: number;
  task: string | undefined;
  warnings: string[];
}): Promise<{
  laneResults?: { directResults: unknown[]; implicationResults: unknown[]; temporalResults: unknown[] };
  laneTimings?: Record<RetrievalIntentName, { durationMs: number; status: RetrievalIntentStatusValue }>;
  retrievalDiagnostics?: RetrievalDiagnostics;
  searchAvailable: boolean;
  searchSucceeded: boolean;
  taskRelevant: unknown[];
  taskSearchResultCount: null | number;
  taskSearchStatus: TaskSearchStatus;
}> {
  if (input.task === undefined) {
    return {
      searchAvailable: true,
      searchSucceeded: true,
      taskRelevant: [],
      taskSearchResultCount: null,
      taskSearchStatus: 'skipped',
    };
  }

  const activeGoalArg = input.activeGoal !== undefined ? { activeGoal: input.activeGoal } : {};

  const laneTimings: Record<RetrievalIntentName, { durationMs: number; status: RetrievalIntentStatusValue }> = {
    direct: { durationMs: 0, status: 'ok' },
    implication: { durationMs: 0, status: 'ok' },
    temporal: { durationMs: 0, status: 'ok' },
  };

  async function runLane<T>(lane: {
    name: RetrievalIntentName;
    task: () => Promise<T>;
    timeoutMs?: number;
  }): Promise<T> {
    const { name, task, timeoutMs = input.stepTimeoutMs } = lane;
    const start = Date.now();
    try {
      const result = await runStepWithTimeout<T>({
        operation: `search.${name}`,
        stepTimeoutMs: timeoutMs,
        task,
      });
      laneTimings[name] = { durationMs: Date.now() - start, status: 'ok' };
      return result;
    } catch (error: unknown) {
      const elapsed = Date.now() - start;
      laneTimings[name] = { durationMs: elapsed, status: isTimeoutError(error) ? 'timeout' : 'error' };
      throw error;
    }
  }

  const temporalFn = input.dependencies.searchTemporalMemories;
  // Direct search may first spend the bounded embedding-provider budget and then
  // execute the independently bounded database search. Giving the enclosing lane
  // only the database-step budget races the provider's graceful null fallback and
  // turns a usable text search into a direct-lane timeout.
  const directSearchTimeoutMs = input.stepTimeoutMs + resolveTimeoutPolicy().embedding.timeoutMs;

  const [directSettled, temporalSettled, implicationSettled] = await Promise.allSettled([
    runLane({
      name: 'direct',
      task: () =>
        input.dependencies.searchMemories({
          ...activeGoalArg,
          ...input.scopeArgs,
          includeEmbedding: true,
          limit: FANOUT_V1_LANE_LIMIT,
          query: input.task,
        }),
      timeoutMs: directSearchTimeoutMs,
    }),
    temporalFn !== undefined
      ? runLane({
          name: 'temporal',
          task: () =>
            temporalFn({
              ...activeGoalArg,
              ...input.scopeArgs,
              limit: FANOUT_V1_LANE_LIMIT,
              query: input.task,
            }),
        })
      : Promise.resolve([] as unknown[]),
    runLane({
      name: 'implication',
      task: () =>
        input.dependencies.searchMemories({
          ...activeGoalArg,
          ...input.scopeArgs,
          includeEmbedding: false,
          limit: FANOUT_V1_LANE_LIMIT,
          query: buildImplicationQuery(input.task, input.activeGoal),
        }),
    }),
  ]);

  const directResults = extractLaneResults({ lane: 'direct', settled: directSettled }, input.warnings);
  const temporalResults = extractLaneResults({ lane: 'temporal', settled: temporalSettled }, input.warnings);
  const implicationResults = extractLaneResults({ lane: 'implication', settled: implicationSettled }, input.warnings);

  // Only count lanes that actually attempted work for success determination
  const anySucceeded =
    directSettled.status === 'fulfilled' ||
    (temporalFn !== undefined && temporalSettled.status === 'fulfilled') ||
    implicationSettled.status === 'fulfilled';

  if (!anySucceeded) {
    return {
      retrievalDiagnostics: buildRetrievalDiagnostics({
        directResults: [],
        implicationResults: [],
        laneTimings,
        mergedResults: [],
        temporalResults: [],
      }),
      searchAvailable: false,
      searchSucceeded: false,
      taskRelevant: [],
      taskSearchResultCount: null,
      taskSearchStatus: 'error',
    };
  }

  const { mergedResults, retrievalDiagnostics } = mergeFanoutLaneResults({
    directResults,
    implicationResults,
    laneTimings,
    temporalResults,
  });

  return {
    laneResults: { directResults, implicationResults, temporalResults },
    laneTimings,
    retrievalDiagnostics,
    searchAvailable: true,
    searchSucceeded: true,
    taskRelevant: mergedResults,
    taskSearchResultCount: mergedResults.length,
    taskSearchStatus: 'ok',
  };
}

function runStepWithTimeout<T>(input: {
  operation: string;
  stepTimeoutMs: number;
  task: () => Promise<T>;
}): Promise<T> {
  return runDbStepWithTimeout({
    operation: `memory_orient.${input.operation}`,
    stepTimeoutMs: input.stepTimeoutMs,
    task: input.task,
  });
}

function safeGetEmbeddingCapability(dependencies: MemoryOrientDependencies): boolean {
  try {
    return dependencies.getCapabilities().hasEmbeddingColumn;
  } catch {
    return false;
  }
}

function scoreMemoryForRecallConditioning(memory: unknown, tokens: string[]) {
  if (!isRecord(memory)) {
    return 0;
  }

  const tags = readStringArray(memory.tags).join(' ');
  const searchableParts = [
    readOptionalText(memory.category),
    readOptionalText(memory.content),
    readOptionalText(memory.memoryType ?? memory.memory_type),
    readOptionalText(memory.memoryKey ?? memory.memory_key),
    readOptionalText(memory.project),
    readOptionalText(memory.source),
    tags.length > 0 ? tags : undefined,
  ].filter((value): value is string => value !== undefined);

  if (searchableParts.length === 0) {
    return 0;
  }

  const searchableText = searchableParts.join(' ').toLowerCase();
  let matchedTokens = 0;
  for (const token of tokens) {
    if (searchableText.includes(token)) {
      matchedTokens += 1;
    }
  }

  return matchedTokens / tokens.length;
}

function trimArrayToSectionBudget<T>(input: {
  items: T[];
  priority: (item: T) => number;
  section: OrientTruncatedSection;
}): { items: T[]; truncated: boolean } {
  const sectionBudget = ORIENT_SECTION_BUDGET_CHARS[input.section];
  if (estimateJsonChars(input.items) <= sectionBudget) {
    return { items: input.items, truncated: false };
  }

  const prioritized = input.items
    .map((item, index) => ({ index, item, priority: input.priority(item) }))
    .sort((left, right) => {
      if (right.priority !== left.priority) {
        return right.priority - left.priority;
      }
      return left.index - right.index;
    });

  const selected: { index: number; item: T }[] = [];
  for (const candidate of prioritized) {
    const next = [...selected.map(item => item.item), candidate.item];
    if (estimateJsonChars(next) <= sectionBudget || selected.length === 0) {
      selected.push({ index: candidate.index, item: candidate.item });
    }
  }

  selected.sort((left, right) => left.index - right.index);

  return {
    items: selected.map(item => item.item),
    truncated: selected.length < input.items.length,
  };
}

function truncateBudgetText(value: string | undefined, maxChars: number): string | undefined {
  if (value === undefined || value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
