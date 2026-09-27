import { formatError, isRecord } from '@aviaratech/ai-memory/internal';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { roundTo } from '../metrics.js';
import { type ExperimentDetail } from './types.js';

export { formatError };

export interface ContinuityFixture {
  expectedOrient: Record<string, unknown>;
  flush: Record<string, unknown>;
}

interface MatchMismatch {
  actual: unknown;
  expected: unknown;
  path: string;
}

interface MatchStats {
  matched: number;
  mismatches: MatchMismatch[];
  total: number;
}

interface SnapshotCheck {
  actual: unknown;
  expected: unknown;
  path: string;
}

export function buildSessionId(fixtureName: string, index: number): string {
  return `experiment-harness-${fixtureName}-${String(index)}-${Date.now().toString()}`;
}

export function computeMean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function evaluateContinuityFixture(input: {
  fixture: ContinuityFixture;
  fixtureName: string;
  orientResult: unknown;
}): { detail: ExperimentDetail; scorePct: number } {
  const partialMatch = comparePartial({
    actual: input.orientResult,
    expected: input.fixture.expectedOrient,
  });
  const snapshotChecks = evaluateSnapshotChecks({
    flush: input.fixture.flush,
    snapshot: readSnapshotJson(input.orientResult),
  });
  const matchedChecks = partialMatch.matched + snapshotChecks.matched;
  const totalChecks = partialMatch.total + snapshotChecks.total;
  const mismatches = [...partialMatch.mismatches, ...snapshotChecks.mismatches];
  const scorePct = totalChecks === 0 ? 100 : roundTo((matchedChecks / totalChecks) * 100, 2);

  return {
    detail: {
      actual: { matchedChecks, mismatches, totalChecks },
      expected: { expectedOrient: input.fixture.expectedOrient, totalChecks },
      metric: scorePct,
      name: `continuity:${input.fixtureName}`,
      status: matchedChecks === totalChecks ? 'pass' : 'fail',
    },
    scorePct,
  };
}

export function normalizeSessionId(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

export function parseContinuityFixture(rawFixture: string): ContinuityFixture {
  const parsed: unknown = JSON.parse(rawFixture);
  if (!isRecord(parsed)) {
    throw new Error('continuity fixture must be a JSON object');
  }
  if (!isRecord(parsed.flush)) {
    throw new Error('continuity fixture must include a "flush" object');
  }
  if (!isRecord(parsed.expectedOrient)) {
    throw new Error('continuity fixture must include an "expectedOrient" object');
  }

  return {
    expectedOrient: parsed.expectedOrient,
    flush: parsed.flush,
  };
}

export function readFixtureFiles(fixtureDirectory: string): string[] {
  if (!existsSync(fixtureDirectory)) {
    return [];
  }
  return readdirSync(fixtureDirectory)
    .filter(fileName => fileName.endsWith('.json'))
    .map(fileName => resolve(fixtureDirectory, fileName))
    .sort((left, right) => left.localeCompare(right));
}

function addOptionalSnapshotCheck(
  checks: SnapshotCheck[],
  input: {
    expected: unknown;
    path: string;
    snapshotValue: unknown;
  },
): void {
  if (input.expected === undefined) {
    return;
  }
  checks.push({
    actual: input.snapshotValue,
    expected: input.expected,
    path: input.path,
  });
}

function comparePartial(input: { actual: unknown; expected: unknown; path?: string }): MatchStats {
  const { actual, expected, path = '' } = input;
  if (isRecord(expected)) {
    const nestedMatches = Object.entries(expected).map(([key, expectedValue]) => {
      const nextPath = path.length > 0 ? `${path}.${key}` : key;
      const actualValue = isRecord(actual) ? actual[key] : undefined;
      return comparePartial({
        actual: actualValue,
        expected: expectedValue,
        path: nextPath,
      });
    });

    return {
      matched: nestedMatches.reduce((total, value) => total + value.matched, 0),
      mismatches: nestedMatches.flatMap(value => value.mismatches),
      total: nestedMatches.reduce((total, value) => total + value.total, 0),
    };
  }

  const passed = isDeepStrictEqual(expected, actual);
  return {
    matched: passed ? 1 : 0,
    mismatches: passed ? [] : [{ actual, expected, path }],
    total: 1,
  };
}

function evaluateSnapshotChecks(input: {
  flush: Record<string, unknown>;
  snapshot: Record<string, unknown>;
}): MatchStats {
  const checks: SnapshotCheck[] = [];
  addOptionalSnapshotCheck(checks, {
    expected: normalizeStringArray(input.flush.nextActions),
    path: 'orientation.priorSession.snapshot.snapshotJson.next_actions',
    snapshotValue: normalizeStringArray(input.snapshot.next_actions) ?? [],
  });
  addOptionalSnapshotCheck(checks, {
    expected: normalizeStringArray(input.flush.openQuestions),
    path: 'orientation.priorSession.snapshot.snapshotJson.open_questions',
    snapshotValue: normalizeStringArray(input.snapshot.open_questions) ?? [],
  });
  addOptionalSnapshotCheck(checks, {
    expected: isRecord(input.flush.stateModel) ? input.flush.stateModel : undefined,
    path: 'orientation.priorSession.snapshot.snapshotJson.x_state_model',
    snapshotValue: isRecord(input.snapshot.x_state_model) ? input.snapshot.x_state_model : {},
  });
  addOptionalSnapshotCheck(checks, {
    expected: normalizeOptionalText(input.flush.activeGoal),
    path: 'orientation.priorSession.snapshot.snapshotJson.x_active_goal',
    snapshotValue: normalizeOptionalText(input.snapshot.x_active_goal) ?? '',
  });

  return {
    matched: checks.filter(check => isDeepStrictEqual(check.actual, check.expected)).length,
    mismatches: checks
      .filter(check => !isDeepStrictEqual(check.actual, check.expected))
      .map(check => ({
        actual: check.actual,
        expected: check.expected,
        path: check.path,
      })),
    total: checks.length,
  };
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim().length > 0) {
      normalized.push(item.trim());
    }
  }
  return normalized;
}

function readSnapshotJson(orientResult: unknown): Record<string, unknown> {
  const root = isRecord(orientResult) ? orientResult : {};
  const orientation = isRecord(root.orientation) ? root.orientation : {};
  const priorSession = isRecord(orientation.priorSession) ? orientation.priorSession : {};
  const snapshot = isRecord(priorSession.snapshot) ? priorSession.snapshot : {};
  return isRecord(snapshot.snapshotJson) ? snapshot.snapshotJson : {};
}
