#!/usr/bin/env node

import type { DbConfig, DbPool } from '@aviaratech/ai-memory/internal';

import { createPool } from '@aviaratech/ai-memory/internal';
import { type ResolvedLogPath, resolveLogFilePath } from '@aviaratech/ai-memory/internal';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_DAYS,
  DEFAULT_LOG_FILE,
  DEFAULT_RETROS_DIR,
  DEFAULT_TRANSCRIPTS_DIR,
} from './health-report/constants.js';
import {
  collectDatabaseMetrics,
  collectMcpUsageMetrics,
  collectOrchestrationMetrics,
  collectRetentionMetrics,
  computeConsolidationMetrics,
  computeUsefulnessMetrics,
} from './health-report/data.js';
import { renderReport } from './health-report/render.js';
import { toPositiveInteger } from './health-report/utils.js';
import { computeLaunchGates } from './launch-gates.js';
import {
  type AiMemoryDatabaseTarget,
  type BootstrapAiMemoryCliRuntimeEnvInput,
  formatAiMemoryDatabaseTarget,
  requireAiMemoryCliDatabaseTarget,
} from './runtimeEnv.js';

interface CliArgs {
  days: number;
  json: boolean;
  logFile: string;
  logFileSource: ResolvedLogPath['source'];
  retrosDir: string;
  transcriptsDir: string;
}

const dataRoot = process.cwd();

const HEALTH_REPORT_STATEMENT_TIMEOUT_MS = 300_000;
const HEALTH_REPORT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 300_000;

export function createHealthReportPool(config: DbConfig): DbPool {
  return createPool(resolveHealthReportPoolConfig(config));
}

/**
 * Resolve the `DbConfig` used by the health-report pool. Pure function — exported so the
 * regression test for pool behavior can assert the shape without needing to construct a
 * real pg.Pool or intercept module imports.
 *
 * The health report runs parallel queries. PostgreSQL applies these timeouts at
 * connection startup, before the pool dispatches a query, avoiding a per-client
 * SET query that could race the first report query.
 */
export function resolveHealthReportPoolConfig(config: DbConfig): DbConfig {
  return {
    ...config,
    idleInTransactionTimeoutMs: 0,
    pgOptions: {
      ...config.pgOptions,
      idle_in_transaction_session_timeout: HEALTH_REPORT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      statement_timeout: HEALTH_REPORT_STATEMENT_TIMEOUT_MS,
    },
    statementTimeoutMs: 0,
  };
}

async function main() {
  const defaultLogPath = resolveLogFilePath();
  const args = parseArguments(process.argv.slice(2), defaultLogPath);
  const now = new Date();
  const windowStart = new Date(now.getTime() - args.days * 24 * 60 * 60 * 1000);
  const windowStartIso = windowStart.toISOString();
  const windowEndIso = now.toISOString();

  const databaseTarget = resolveDatabaseTarget();
  const databaseUrl = formatAiMemoryDatabaseTarget(databaseTarget);
  const pool = createHealthReportPool({ connectionString: databaseTarget.databaseUrl });

  try {
    const database = await collectDatabaseMetrics({
      pool,
      windowEndIso,
      windowStartIso,
    });
    const [mcpUsage, usefulness, consolidation] = await Promise.all([
      collectMcpUsageMetrics({
        logFile: args.logFile,
        logFileSource: args.logFileSource,
        pool,
        windowEndIso,
        windowStartMs: windowStart.getTime(),
      }),
      computeUsefulnessMetrics({ pool, windowEndIso, windowStartIso }),
      computeConsolidationMetrics({ pool, windowEndIso, windowStartIso }),
    ]);
    const orchestration = collectOrchestrationMetrics({
      retrosDir: args.retrosDir,
      transcriptsDir: args.transcriptsDir,
      windowStartMs: windowStart.getTime(),
    });
    const retention = await collectRetentionMetrics({
      logFile: args.logFile,
      pool,
    });

    const launchGates = computeLaunchGates({
      continuity: {
        autoSnapshots: database.continuityAdoption.auto.snapshots,
        autoStateModelPresent: database.continuityAdoption.auto.stateModelPresent,
        flushSnapshots: database.continuityAdoption.flush.snapshots,
        flushStateModelPresent: database.continuityAdoption.flush.stateModelPresent,
        nextActionsNonEmpty: database.continuityAdoption.nextActionsNonEmpty,
        openQuestionsNonEmpty: database.continuityAdoption.openQuestionsNonEmpty,
        snapshots: database.continuityAdoption.snapshots,
        stateModelPresent: database.continuityAdoption.stateModelPresent,
      },
      memoryTypeNullRatePct: database.memoryTypeNullRatePct,
      memoryTypeNullSampleCount: database.memoryTypeNullSampleCount,
      orient: mcpUsage.orient,
      tools: mcpUsage.tools,
    });

    const report = {
      consolidation,
      database: {
        ...database,
        databaseUrl,
      },
      generatedAt: now.toISOString(),
      launchGates,
      mcpUsage,
      orchestration,
      period: {
        days: args.days,
        end: windowEndIso,
        start: windowStartIso,
      },
      retention,
      usefulness,
    };

    if (args.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }

    process.stdout.write(renderReport(report));
  } finally {
    await pool.end();
  }
}

const isDirectRun = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[ai-memory:health] ${message}\n`);
    process.exit(1);
  });
}

function parseArguments(argv: string[], defaultLogPath: ResolvedLogPath): CliArgs {
  const args: CliArgs = {
    days: DEFAULT_DAYS,
    json: false,
    logFile: defaultLogPath.path,
    logFileSource: defaultLogPath.source,
    retrosDir: resolve(dataRoot, DEFAULT_RETROS_DIR),
    transcriptsDir: resolve(dataRoot, DEFAULT_TRANSCRIPTS_DIR),
  };

  const queue = [...argv];
  while (queue.length > 0) {
    const value = queue.shift();
    if (value === undefined) {
      break;
    }
    if (value === '--json') {
      args.json = true;
      continue;
    }
    if (value === '--days') {
      args.days = toPositiveInteger(requireNextArgument(queue, value), value);
      continue;
    }
    if (value === '--log-file') {
      args.logFile = resolve(dataRoot, requireNextArgument(queue, value));
      args.logFileSource = 'repo_root';
      continue;
    }
    if (value === '--transcripts-dir') {
      args.transcriptsDir = resolve(dataRoot, requireNextArgument(queue, value));
      continue;
    }
    if (value === '--retros-dir') {
      args.retrosDir = resolve(dataRoot, requireNextArgument(queue, value));
      continue;
    }
    if (value === '--help' || value === '-h') {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${value}`);
  }

  return args;
}

function printHelp() {
  process.stdout.write(
    [
      'Usage: npm run health -- [options]',
      '',
      'Options:',
      `  --days <n>               Report window in days (default: ${String(DEFAULT_DAYS)})`,
      '  --json                   Output JSON',
      `  --log-file <path>        Log file path (default: ${DEFAULT_LOG_FILE})`,
      `  --transcripts-dir <path> Transcript directory (default: ${DEFAULT_TRANSCRIPTS_DIR})`,
      `  --retros-dir <path>      Retro directory (default: ${DEFAULT_RETROS_DIR})`,
      '  --help, -h               Show this help',
      '',
    ].join('\n'),
  );
}

function requireNextArgument(queue: string[], optionName: string): string {
  const value = queue.shift();
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

function resolveDatabaseTarget(input: BootstrapAiMemoryCliRuntimeEnvInput = {}): AiMemoryDatabaseTarget {
  return requireAiMemoryCliDatabaseTarget(input);
}

function resolveDatabaseUrl(input: BootstrapAiMemoryCliRuntimeEnvInput = {}): string {
  return formatAiMemoryDatabaseTarget(resolveDatabaseTarget(input));
}

export {
  buildReflectMetricsFromRows,
  buildTaxonomyDistribution,
  buildTopTimeoutOperations,
  buildWriteCalibrationMetricsFromRows,
  collectMcpUsageMetrics,
  computeBrierScore,
  computeConsolidationMetrics,
  computeDecisionReversalRate,
  computeECE,
  computeRepeatedFixRate,
  computeUsefulnessMetrics,
  evaluateCalibrationAssessment,
  evaluateWriterParticipation,
  extractModulePath,
  parseCalibrationSignal,
} from './health-report/data.js';

export { resolveDatabaseUrl };

export { renderReport } from './health-report/render.js';

export type { ConsolidationMetrics, HealthReport, McpUsageMetrics, UsefulnessMetrics } from './health-report/types.js';
export { formatNumber, formatPercent, percent } from './health-report/utils.js';
