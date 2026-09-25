import { isRecord, logAiMemoryError, storeMemory } from '@aviaratech/ai-memory/internal';

import {
  type ActualOutcome,
  compareOutcomes,
  type ConfidenceCalibration,
  inferActualOutcome,
  type PredictedConfidence,
  type ReflectionResult,
  toPredictedConfidence,
  toStateModel,
} from './reflection-compare.js';

const MAX_REFLECTIVE_MEMORIES = 3;
const REFLECTIVE_CONFIDENCE = 0.7;
const REFLECTIVE_MEMORY_CATEGORY = 'reflective';
const REFLECTIVE_MEMORY_TAGS = ['reflection', 'auto-generated'];
const ROOT_CAUSE_SNIPPET_MAX_CHARS = 120;

export interface CalibrationSignal {
  actual: ActualOutcome;
  predicted: PredictedConfidence;
}

export interface ReflectionMemoryDraft {
  content: string;
  signal: 'confidence-calibration' | 'validated-assumptions';
}

export interface RunReflectionInput {
  agent: string | undefined;
  decisions: string[];
  project: string | undefined;
  rootCauses: string[];
  sessionId: string | undefined;
  source: string | undefined;
  stateModel: Record<string, unknown> | undefined;
  summary: string;
}

export interface RunReflectionResult {
  reflectionResult: ReflectionResult | undefined;
  storedMemories: StoredReflectionMemory[];
}

export interface StoredReflectionMemory {
  category: string;
  confidence: number;
  content: string;
  id: number;
  memoryType?: null | string;
}

interface ReflectionDependencies {
  storeMemory: (input: unknown) => Promise<{ id: number; memoryType?: null | string }>;
}

const DEFAULT_DEPENDENCIES: ReflectionDependencies = {
  storeMemory,
};

export { compareOutcomes };
export type { ReflectionResult };

export async function runReflection(
  input: RunReflectionInput,
  dependencies: ReflectionDependencies = DEFAULT_DEPENDENCIES,
): Promise<RunReflectionResult> {
  if (!isRecord(input.stateModel)) {
    return { reflectionResult: undefined, storedMemories: [] };
  }

  const stateModel = toStateModel(input.stateModel);
  const reflectionResult = compareOutcomes(stateModel, input.summary, input.decisions, input.rootCauses);
  const calibrationSignal = {
    actual: inferActualOutcome(input.decisions.length, input.rootCauses.length),
    predicted: toPredictedConfidence(stateModel.strategy_confidence),
  };
  const drafts = buildReflectionMemoryDrafts({
    confidenceCalibration: reflectionResult.confidenceCalibration,
    decisionsCount: input.decisions.length,
    rootCauses: input.rootCauses,
    validatedAssumptions: reflectionResult.validatedAssumptions,
  });

  const storedMemories = await storeReflectiveMemories({
    agent: input.agent,
    calibrationSignal,
    drafts,
    project: input.project,
    sessionId: input.sessionId,
    source: input.source,
    storeMemory: dependencies.storeMemory,
  });

  return { reflectionResult, storedMemories };
}

export async function storeReflectiveMemories(input: {
  agent: string | undefined;
  calibrationSignal: CalibrationSignal;
  drafts: ReflectionMemoryDraft[];
  project: string | undefined;
  sessionId: string | undefined;
  source: string | undefined;
  storeMemory: ReflectionDependencies['storeMemory'];
}): Promise<StoredReflectionMemory[]> {
  const stored: StoredReflectionMemory[] = [];
  const draftsToStore = input.drafts.slice(0, MAX_REFLECTIVE_MEMORIES);

  for (const draft of draftsToStore) {
    try {
      const memory = await input.storeMemory({
        ...(input.agent !== undefined ? { agent: input.agent } : {}),
        category: REFLECTIVE_MEMORY_CATEGORY,
        confidence: REFLECTIVE_CONFIDENCE,
        content: draft.content,
        memoryType: REFLECTIVE_MEMORY_CATEGORY,
        metadata: {
          calibration_signal: input.calibrationSignal,
          reflection_signal: draft.signal,
        },
        ...(input.project !== undefined ? { project: input.project } : {}),
        sensitivity: 'internal',
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        ...(input.source !== undefined ? { source: input.source } : {}),
        tags: REFLECTIVE_MEMORY_TAGS,
      });

      stored.push({
        category: REFLECTIVE_MEMORY_CATEGORY,
        confidence: REFLECTIVE_CONFIDENCE,
        content: draft.content,
        id: memory.id,
        memoryType: typeof memory.memoryType === 'string' ? memory.memoryType : null,
      });
    } catch (error) {
      logAiMemoryError('flush_session.reflection_store_failed', {
        message: error instanceof Error ? error.message : String(error),
        signal: draft.signal,
      });
    }
  }

  return stored;
}

function buildReflectionMemoryDrafts(input: {
  confidenceCalibration: ConfidenceCalibration;
  decisionsCount: number;
  rootCauses: string[];
  validatedAssumptions: string[];
}): ReflectionMemoryDraft[] {
  const drafts: ReflectionMemoryDraft[] = [];

  if (input.confidenceCalibration === 'overconfident') {
    const summarizedRootCauses =
      input.rootCauses.length === 0
        ? 'none'
        : input.rootCauses
            .slice(0, 3)
            .map(rootCause => `"${truncate(rootCause, ROOT_CAUSE_SNIPPET_MAX_CHARS)}"`)
            .join(', ');
    drafts.push({
      content:
        `Strategy confidence was 'high' but session encountered ${String(input.rootCauses.length)} root causes: ` +
        `${summarizedRootCauses}. Consider lower initial confidence for similar tasks.`,
      signal: 'confidence-calibration',
    });
  }

  if (input.confidenceCalibration === 'underconfident') {
    drafts.push({
      content:
        "Strategy confidence was 'low' but session completed successfully with " +
        `${String(input.decisionsCount)} decisions and 0 root causes. ` +
        'This type of task may be more tractable than assumed.',
      signal: 'confidence-calibration',
    });
  }

  if (input.validatedAssumptions.length >= 2) {
    drafts.push({
      content: `Validated assumptions in this session: ${input.validatedAssumptions.join('; ')}.`,
      signal: 'validated-assumptions',
    });
  }

  return drafts;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
