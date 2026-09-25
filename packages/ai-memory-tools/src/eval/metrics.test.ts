import assert from 'node:assert/strict';
import { test } from 'vitest';

import { computePrecisionAtK, computeRecallAtK, computeReciprocalRank } from './metrics.js';

test('computePrecisionAtK counts expected hits within top-k', () => {
  const precision = computePrecisionAtK({
    expected: ['m1', 'm2'],
    k: 3,
    returned: ['m1', 'noise', 'm2'],
  });

  assert.equal(precision, 2 / 3);
});

test('computeRecallAtK uses expected set size as denominator', () => {
  const recall = computeRecallAtK({
    expected: ['m1', 'm2', 'm3'],
    k: 2,
    returned: ['m1', 'm2', 'noise'],
  });

  assert.equal(recall, 2 / 3);
});

test('computeReciprocalRank returns inverse rank of first expected hit', () => {
  const reciprocalRank = computeReciprocalRank({
    expected: ['m2'],
    k: 5,
    returned: ['noise', 'm2', 'm3'],
  });

  assert.equal(reciprocalRank, 1 / 2);
});

test('metric helpers return neutral values for negative-query fixtures', () => {
  const precision = computePrecisionAtK({
    expected: [],
    k: 3,
    returned: [],
  });
  const recall = computeRecallAtK({
    expected: [],
    k: 3,
    returned: [],
  });
  const reciprocalRank = computeReciprocalRank({
    expected: [],
    k: 3,
    returned: [],
  });

  assert.equal(precision, 1);
  assert.equal(recall, 1);
  assert.equal(reciprocalRank, 1);
});
