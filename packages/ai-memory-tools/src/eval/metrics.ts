interface RetrievalMetricInput {
  expected: string[];
  k: number;
  returned: string[];
}

export function computeMean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function computePrecisionAtK(input: RetrievalMetricInput): number {
  const { expected, k, returned } = input;
  const topK = sliceTopK(returned, k);
  if (topK.length === 0) {
    return expected.length === 0 ? 1 : 0;
  }

  const expectedSet = new Set(expected);
  const hitCount = topK.filter(value => expectedSet.has(value)).length;
  return hitCount / topK.length;
}

export function computeRecallAtK(input: RetrievalMetricInput): number {
  const { expected, k, returned } = input;
  if (expected.length === 0) {
    return 1;
  }

  const topKSet = new Set(sliceTopK(returned, k));
  const matchedExpected = expected.filter(value => topKSet.has(value)).length;
  return matchedExpected / expected.length;
}

export function computeReciprocalRank(input: RetrievalMetricInput): number {
  const { expected, k, returned } = input;
  if (expected.length === 0) {
    return 1;
  }

  const expectedSet = new Set(expected);
  const topK = sliceTopK(returned, k);
  for (const [index, value] of topK.entries()) {
    if (expectedSet.has(value)) {
      return 1 / (index + 1);
    }
  }

  return 0;
}

export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function sliceTopK(values: string[], k: number): string[] {
  if (k <= 0) {
    return [];
  }
  return values.slice(0, k);
}
