import assert from 'node:assert/strict';
import { test } from 'vitest';

import { computeReversalPrior, MIN_REVERSAL_PRIOR_MEMORY_COUNT } from './reversal-prior.js';

test('computeReversalPrior returns no penalty when the prior cell is too thin', () => {
  const prior = computeReversalPrior({
    priorMemoryCount: MIN_REVERSAL_PRIOR_MEMORY_COUNT - 1,
    reversalCount: MIN_REVERSAL_PRIOR_MEMORY_COUNT - 1,
    scope: 'author x category',
  });

  assert.equal(prior, null);
});

test('computeReversalPrior applies penalties at the minimum prior boundary', () => {
  const prior = computeReversalPrior({
    priorMemoryCount: MIN_REVERSAL_PRIOR_MEMORY_COUNT,
    reversalCount: 2,
    scope: 'author x category',
  });

  assert.deepEqual(prior, {
    priorMemoryCount: MIN_REVERSAL_PRIOR_MEMORY_COUNT,
    reversalPenalty: 0.8,
    reversalRate: 0.2,
    scope: 'author x category',
    window: '30d',
  });
});

test('computeReversalPrior caps worst-case reversal penalty at half weight', () => {
  const prior = computeReversalPrior({
    priorMemoryCount: 12,
    reversalCount: 12,
    scope: 'author x category',
  });

  assert.deepEqual(prior, {
    priorMemoryCount: 12,
    reversalPenalty: 0.5,
    reversalRate: 1,
    scope: 'author x category',
    window: '30d',
  });
});

test('computeReversalPrior rounds reversal rate and penalty for diagnostic stability', () => {
  const prior = computeReversalPrior({
    priorMemoryCount: 18,
    reversalCount: 5,
    scope: 'author x category x tag',
  });

  assert.deepEqual(prior, {
    priorMemoryCount: 18,
    reversalPenalty: 0.7222,
    reversalRate: 0.2778,
    scope: 'author x category x tag',
    window: '30d',
  });
});
