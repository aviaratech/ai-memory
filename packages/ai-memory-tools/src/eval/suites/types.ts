export interface ExperimentDetail {
  actual: unknown;
  expected: unknown;
  metric?: number;
  name: string;
  status: ExperimentDetailStatus;
}

export type ExperimentDetailStatus = 'fail' | 'pass' | 'skip';

export interface ExperimentReport {
  details: ExperimentDetail[];
  failed: number;
  metrics: Record<string, number>;
  passed: number;
  skipped: number;
  suite: string;
  timestamp: string;
}

export type ExperimentSuiteName = 'all' | 'continuity' | 'environment' | 'orient-fanout-v1' | 'retrieval';

export interface SuiteRunOptions {
  fixturesRoot: string;
}

export function buildExperimentReport(input: {
  details: ExperimentDetail[];
  metrics: Record<string, number>;
  suite: string;
  timestamp?: string;
}): ExperimentReport {
  const passed = input.details.filter(detail => detail.status === 'pass').length;
  const failed = input.details.filter(detail => detail.status === 'fail').length;
  const skipped = input.details.filter(detail => detail.status === 'skip').length;

  return {
    details: input.details,
    failed,
    metrics: input.metrics,
    passed,
    skipped,
    suite: input.suite,
    timestamp: input.timestamp ?? new Date().toISOString(),
  };
}
