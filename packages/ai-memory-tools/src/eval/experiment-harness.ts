#!/usr/bin/env node

import { isRecord } from '@aviaratech/ai-memory/internal';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runContinuitySuite } from './suites/continuity.js';
import { runEnvironmentSuite } from './suites/environment.js';
import { runOrientFanoutV1Suite } from './suites/orient-fanout-v1.js';
import { runRetrievalSuite } from './suites/retrieval.js';
import {
  buildExperimentReport,
  type ExperimentReport,
  type ExperimentSuiteName,
  type SuiteRunOptions,
} from './suites/types.js';

interface HarnessCliArgs {
  fixturesRoot: string;
  json: boolean;
  suite: ExperimentSuiteName;
}

interface HarnessDependencies {
  runContinuitySuite: (options: SuiteRunOptions) => Promise<ExperimentReport>;
  runEnvironmentSuite: (options: SuiteRunOptions) => Promise<ExperimentReport>;
  runOrientFanoutV1Suite: (options: SuiteRunOptions) => Promise<ExperimentReport>;
  runRetrievalSuite: (options: SuiteRunOptions) => Promise<ExperimentReport>;
}

interface HarnessRunOptions {
  fixturesRoot: string;
  suite: ExperimentSuiteName;
}

const DEFAULT_DEPENDENCIES: HarnessDependencies = {
  runContinuitySuite,
  runEnvironmentSuite,
  runOrientFanoutV1Suite,
  runRetrievalSuite,
};

export function experimentReportExitCode(report: ExperimentReport): number {
  return report.failed === 0 && report.skipped === 0 && report.passed > 0 ? 0 : 1;
}

export function renderExperimentReport(report: ExperimentReport): string {
  const lines: string[] = [];
  lines.push('AI Memory Experiment Harness Report');
  lines.push(`Suite: ${report.suite}`);
  lines.push(`Timestamp: ${report.timestamp}`);
  lines.push(`Passed: ${String(report.passed)}  Failed: ${String(report.failed)}  Skipped: ${String(report.skipped)}`);
  lines.push('');

  const metricEntries = Object.entries(report.metrics).sort(([left], [right]) => left.localeCompare(right));
  if (metricEntries.length > 0) {
    lines.push('Metrics');
    for (const [metricName, metricValue] of metricEntries) {
      lines.push(`  ${metricName}: ${String(metricValue)}`);
    }
    lines.push('');
  }

  const failingDetails = report.details.filter(detail => detail.status === 'fail');
  if (failingDetails.length > 0) {
    lines.push(`Failing Details (${String(failingDetails.length)})`);
    for (const detail of failingDetails) {
      lines.push(`  - ${detail.name}`);
    }
    lines.push('');
  }

  const skippedDetails = report.details.filter(detail => detail.status === 'skip');
  if (skippedDetails.length > 0) {
    lines.push(`Skipped Details (${String(skippedDetails.length)})`);
    for (const detail of skippedDetails) {
      lines.push(`  - ${detail.name}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export async function runExperimentHarness(
  options: HarnessRunOptions,
  dependencies: HarnessDependencies = DEFAULT_DEPENDENCIES,
): Promise<ExperimentReport> {
  if (options.suite === 'all') {
    const continuity = await dependencies.runContinuitySuite({
      fixturesRoot: options.fixturesRoot,
    });
    const retrieval = await dependencies.runRetrievalSuite({
      fixturesRoot: options.fixturesRoot,
    });
    const environment = await dependencies.runEnvironmentSuite({
      fixturesRoot: options.fixturesRoot,
    });
    const orientFanoutV1 = await dependencies.runOrientFanoutV1Suite({
      fixturesRoot: options.fixturesRoot,
    });

    const details = [...continuity.details, ...retrieval.details, ...environment.details, ...orientFanoutV1.details];
    const metrics: Record<string, number> = {};
    mergeSuiteMetrics(metrics, continuity);
    mergeSuiteMetrics(metrics, retrieval);
    mergeSuiteMetrics(metrics, environment);
    mergeSuiteMetrics(metrics, orientFanoutV1);

    const report = buildExperimentReport({
      details,
      metrics,
      suite: 'all',
    });
    validateExperimentReport(report);
    return report;
  }

  const runner = resolveSuiteRunner(options.suite, dependencies);
  const report = await runner({ fixturesRoot: options.fixturesRoot });
  validateExperimentReport(report);
  return report;
}

export function validateExperimentReport(report: unknown): asserts report is ExperimentReport {
  assertValidTopLevelReport(report);
  assertValidMetrics(report.metrics);
  assertValidDetails(report.details);
}

function assertValidDetails(details: unknown[]): void {
  for (const detail of details) {
    if (!isRecord(detail)) {
      throw new Error('ExperimentReport.details entries must be objects');
    }
    if (typeof detail.name !== 'string' || detail.name.trim().length === 0) {
      throw new Error('ExperimentDetail.name must be a non-empty string');
    }
    if (detail.status !== 'pass' && detail.status !== 'fail' && detail.status !== 'skip') {
      throw new Error('ExperimentDetail.status must be pass, fail, or skip');
    }
    if (!('expected' in detail) || !('actual' in detail)) {
      throw new Error('ExperimentDetail must include expected and actual fields');
    }
    if (
      'metric' in detail &&
      detail.metric !== undefined &&
      (typeof detail.metric !== 'number' || Number.isNaN(detail.metric))
    ) {
      throw new Error('ExperimentDetail.metric must be a number when present');
    }
  }
}

function assertValidMetrics(metrics: Record<string, unknown>): void {
  for (const value of Object.values(metrics)) {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new Error('ExperimentReport.metrics values must be numbers');
    }
  }
}

function assertValidTopLevelReport(report: unknown): asserts report is ExperimentReport {
  if (!isRecord(report)) {
    throw new Error('ExperimentReport must be an object');
  }
  if (typeof report.suite !== 'string' || report.suite.trim().length === 0) {
    throw new Error('ExperimentReport.suite must be a non-empty string');
  }
  if (typeof report.timestamp !== 'string' || report.timestamp.trim().length === 0) {
    throw new Error('ExperimentReport.timestamp must be a non-empty string');
  }
  if (!isNonNegativeInteger(report.passed)) {
    throw new Error('ExperimentReport.passed must be a non-negative integer');
  }
  if (!isNonNegativeInteger(report.failed)) {
    throw new Error('ExperimentReport.failed must be a non-negative integer');
  }
  if (!isNonNegativeInteger(report.skipped)) {
    throw new Error('ExperimentReport.skipped must be a non-negative integer');
  }
  if (!isRecord(report.metrics)) {
    throw new Error('ExperimentReport.metrics must be an object');
  }
  if (!Array.isArray(report.details)) {
    throw new Error('ExperimentReport.details must be an array');
  }
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

async function main(): Promise<void> {
  if (process.argv[2] === '--recovery-replay') {
    const path = process.argv[3];
    if (path === undefined || process.argv.length !== 4)
      throw new Error('--recovery-replay requires exactly one configuration file.');
    const { parseRecoveryConfiguration, runRecoveryReplay } = await import('./recovery-replay.js');
    const report = await runRecoveryReplay(parseRecoveryConfiguration(JSON.parse(readFileSync(path, 'utf8'))));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.status === 'needs-review' ? 2 : 1;
    return;
  }
  const args = parseCliArgs(process.argv.slice(2));
  const report = await runExperimentHarness({
    fixturesRoot: args.fixturesRoot,
    suite: args.suite,
  });
  process.exitCode = experimentReportExitCode(report);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${renderExperimentReport(report)}\n`);
}

function mergeSuiteMetrics(target: Record<string, number>, report: ExperimentReport): void {
  for (const [metricName, metricValue] of Object.entries(report.metrics)) {
    target[`${report.suite}.${metricName}`] = metricValue;
  }
}

function parseCliArgs(argv: string[]): HarnessCliArgs {
  const args: HarnessCliArgs = {
    fixturesRoot: resolveDefaultFixturesRoot(),
    json: false,
    suite: 'all',
  };

  let index = 0;
  while (index < argv.length) {
    const argument = argv[index];
    index += 1;
    if (argument === undefined) {
      continue;
    }

    if (argument === '--json') {
      args.json = true;
      continue;
    }
    if (argument === '--suite') {
      const suiteValue = argv[index];
      index += 1;
      if (
        suiteValue !== 'all' &&
        suiteValue !== 'continuity' &&
        suiteValue !== 'environment' &&
        suiteValue !== 'orient-fanout-v1' &&
        suiteValue !== 'retrieval'
      ) {
        throw new Error('--suite must be one of: continuity, retrieval, environment, orient-fanout-v1, all');
      }
      args.suite = suiteValue;
      continue;
    }
    if (argument === '--fixtures') {
      const fixturesValue = argv[index];
      index += 1;
      if (typeof fixturesValue !== 'string' || fixturesValue.trim().length === 0) {
        throw new Error('--fixtures requires a directory path');
      }
      args.fixturesRoot = resolve(fixturesValue);
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return args;
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage: node dist/eval/experiment-harness.js [options]',
      '',
      'Options:',
      '  --suite <name>     continuity | retrieval | environment | orient-fanout-v1 | all (default: all)',
      '  --fixtures <dir>   Fixture root directory (default: src/eval/fixtures)',
      '  --json             Output raw ExperimentReport JSON',
      '  --help, -h         Show this help',
      '',
    ].join('\n'),
  );
}

function resolveDefaultFixturesRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return resolve(moduleDir, 'fixtures');
}

function resolveSuiteRunner(suite: ExperimentSuiteName, dependencies: HarnessDependencies) {
  if (suite === 'continuity') {
    return dependencies.runContinuitySuite;
  }
  if (suite === 'retrieval') {
    return dependencies.runRetrievalSuite;
  }
  if (suite === 'environment') {
    return dependencies.runEnvironmentSuite;
  }
  if (suite === 'orient-fanout-v1') {
    return dependencies.runOrientFanoutV1Suite;
  }
  throw new Error(`Unsupported suite: ${suite}`);
}

const scriptArg = process.argv[1] ?? '';
const isDirectRun =
  scriptArg.length > 0 && resolve(scriptArg).includes('experiment-harness') && !resolve(scriptArg).includes('.test.');

if (isDirectRun) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[experiment-harness] ${message}\n`);
    process.exit(1);
  });
}
