import {
  type AgentStateModel,
  STRATEGY_CONFIDENCE_VALUES,
  type StrategyConfidence,
} from '@aviaratech/ai-memory/internal';

const MIN_KEYWORD_LENGTH = 4;

const STOP_WORDS = new Set([
  'about',
  'after',
  'also',
  'among',
  'because',
  'been',
  'before',
  'being',
  'between',
  'could',
  'from',
  'into',
  'must',
  'should',
  'that',
  'their',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'under',
  'until',
  'when',
  'where',
  'which',
  'while',
  'with',
  'would',
]);

export type ActualOutcome = 'failure' | 'partial' | 'success';
export type ConfidenceCalibration = 'overconfident' | 'underconfident' | 'well-calibrated';
export type PredictedConfidence = StrategyConfidence;

export interface ReflectionResult {
  confidenceCalibration: ConfidenceCalibration;
  reflections: string[];
  resolvedUncertainties: string[];
  unresolvedAssumptions: string[];
  validatedAssumptions: string[];
}

export function compareOutcomes(
  stateModel: AgentStateModel,
  ...args: [summary: string, decisions: string[], rootCauses: string[]]
): ReflectionResult {
  const [, decisions, rootCauses] = args;
  const assumptions = normalizeStringArray(stateModel.assumptions);
  const uncertainties = normalizeStringArray(stateModel.uncertainty);
  const normalizedDecisions = decisions.map(normalizeMatchText);
  const normalizedRootCauses = rootCauses.map(normalizeMatchText);
  const predictedConfidence = toPredictedConfidence(stateModel.strategy_confidence);

  const validatedAssumptions = assumptions.filter(assumption => hasTopicMatch(assumption, normalizedDecisions));
  const unresolvedAssumptions = assumptions.filter(
    assumption => !hasTopicMatch(assumption, normalizedDecisions) && !hasTopicMatch(assumption, normalizedRootCauses),
  );
  const resolvedUncertainties = uncertainties.filter(uncertainty => hasTopicMatch(uncertainty, normalizedRootCauses));
  const confidenceCalibration = getConfidenceCalibration({
    decisionsCount: decisions.length,
    predictedConfidence,
    rootCausesCount: rootCauses.length,
  });

  return {
    confidenceCalibration,
    reflections: buildReflections({
      confidenceCalibration,
      resolvedUncertainties,
      unresolvedAssumptions,
      validatedAssumptions,
    }),
    resolvedUncertainties,
    unresolvedAssumptions,
    validatedAssumptions,
  };
}

export function inferActualOutcome(decisionsCount: number, rootCausesCount: number): ActualOutcome {
  if (rootCausesCount === 0 && decisionsCount >= 1) {
    return 'success';
  }

  if (decisionsCount === 0) {
    return 'failure';
  }

  if (rootCausesCount > 0) {
    return 'partial';
  }

  return 'failure';
}

export function toPredictedConfidence(value: unknown): PredictedConfidence {
  if (typeof value === 'string' && (STRATEGY_CONFIDENCE_VALUES as readonly string[]).includes(value)) {
    return value as PredictedConfidence;
  }
  return 'medium';
}

export function toStateModel(stateModel: Record<string, unknown>): AgentStateModel {
  const nextDecision = typeof stateModel.next_decision === 'string' ? stateModel.next_decision : undefined;

  return {
    assumptions: normalizeStringArray(stateModel.assumptions),
    constraints: normalizeStringArray(stateModel.constraints),
    ...(nextDecision !== undefined ? { next_decision: nextDecision } : {}),
    strategy_confidence: toPredictedConfidence(stateModel.strategy_confidence),
    uncertainty: normalizeStringArray(stateModel.uncertainty),
  };
}

function buildReflections(input: {
  confidenceCalibration: ConfidenceCalibration;
  resolvedUncertainties: string[];
  unresolvedAssumptions: string[];
  validatedAssumptions: string[];
}): string[] {
  const reflections: string[] = [];

  if (input.confidenceCalibration === 'overconfident') {
    reflections.push('Calibration signal: overconfident outcome detected.');
  } else if (input.confidenceCalibration === 'underconfident') {
    reflections.push('Calibration signal: underconfident outcome detected.');
  } else {
    reflections.push('Calibration signal: strategy confidence was well-calibrated.');
  }

  if (input.validatedAssumptions.length > 0) {
    reflections.push(`Validated assumptions: ${input.validatedAssumptions.join('; ')}.`);
  }
  if (input.unresolvedAssumptions.length > 0) {
    reflections.push(`Unresolved assumptions: ${input.unresolvedAssumptions.join('; ')}.`);
  }
  if (input.resolvedUncertainties.length > 0) {
    reflections.push(`Resolved uncertainties: ${input.resolvedUncertainties.join('; ')}.`);
  }

  return reflections;
}

function extractKeywords(topic: string): string[] {
  const uniqueKeywords = new Set<string>();
  for (const token of topic.split(' ')) {
    if (token.length < MIN_KEYWORD_LENGTH || STOP_WORDS.has(token)) {
      continue;
    }
    uniqueKeywords.add(token);
  }

  if (uniqueKeywords.size === 0 && topic.length > 0) {
    uniqueKeywords.add(topic);
  }

  return [...uniqueKeywords];
}

function getConfidenceCalibration(input: {
  decisionsCount: number;
  predictedConfidence: PredictedConfidence;
  rootCausesCount: number;
}): ConfidenceCalibration {
  if (input.rootCausesCount >= 2 && input.predictedConfidence === 'high') {
    return 'overconfident';
  }

  if (input.rootCausesCount === 0 && input.decisionsCount >= 1 && input.predictedConfidence === 'low') {
    return 'underconfident';
  }

  return 'well-calibrated';
}

function hasTopicMatch(topic: string, normalizedTexts: string[]): boolean {
  const normalizedTopic = normalizeMatchText(topic);
  if (normalizedTopic.length === 0) {
    return false;
  }

  const keywords = extractKeywords(normalizedTopic);
  for (const normalizedText of normalizedTexts) {
    if (normalizedText.includes(normalizedTopic)) {
      return true;
    }
    if (keywords.some(keyword => normalizedText.includes(keyword))) {
      return true;
    }
  }

  return false;
}

function normalizeMatchText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
    const trimmed = item.trim();
    if (trimmed.length > 0) {
      normalized.push(trimmed);
    }
  }

  return normalized;
}
