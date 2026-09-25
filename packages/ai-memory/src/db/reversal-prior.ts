import { type ReversalPriorScope, roundMetric } from './write-calibration.js';

export const MIN_REVERSAL_PRIOR_MEMORY_COUNT = 10;
export const REVERSAL_PENALTY_CAP = 0.5;

export interface ComputedReversalPrior {
  priorMemoryCount: number;
  reversalPenalty: number;
  reversalRate: number;
  scope: ReversalPriorScope;
  window: '30d';
}

export function computeReversalPrior(input: {
  priorMemoryCount: number;
  reversalCount: number;
  scope: ReversalPriorScope;
}): ComputedReversalPrior | null {
  if (input.priorMemoryCount < MIN_REVERSAL_PRIOR_MEMORY_COUNT) {
    return null;
  }

  const reversalRate = input.priorMemoryCount === 0 ? 0 : roundMetric(input.reversalCount / input.priorMemoryCount);
  const reversalPenalty = roundMetric(1 - Math.min(REVERSAL_PENALTY_CAP, Math.max(0, reversalRate)));

  return {
    priorMemoryCount: input.priorMemoryCount,
    reversalPenalty,
    reversalRate,
    scope: input.scope,
    window: '30d',
  };
}
