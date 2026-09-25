#!/usr/bin/env node

/**
 * Search relevance evaluation harness for ai-memory.
 *
 * Two usage modes:
 * 1. **Pure functions** (no DB) — `loadEvalCorpus`, `computeQueryResult`, `aggregateResults`
 *    Used by unit tests to validate fixtures and metrics math.
 * 2. **Integration runner** (requires Postgres) — CLI entry point that seeds, queries, and reports.
 *    Run via `npm run test:search-eval`.
 */

import type { DbPool } from '@aviaratech/ai-memory/internal';

import { writeJsonFile } from '../json-file.js';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The full evaluation corpus loaded from fixtures JSON. */
export interface EvalCorpus {
  memories: EvalMemory[];
  queries: EvalQuery[];
  version: string;
}

/** A query test case with expected results. */
export interface EvalQuery {
  /** Memory IDs that MUST NOT appear in results (precision guard). */
  excludedMemoryIds?: string[];
  /** Pairwise ordering guards: `before` must rank ahead of `after` when both are returned. */
  expectedBefore?: { after: string; before: string }[];
  /** Memory IDs that MUST appear in top-K results. */
  expectedMemoryIds: string[];
  /** Stable identifier for this query case. */
  id: string;
  /** The query text to pass to searchMemories. */
  query: string;
  /** Category of this test case for coverage tracking. */
  testCategory: 'architecture' | 'convention' | 'preference' | 'root-cause';
}

/** Aggregated evaluation report. */
export interface EvalReport {
  byCategory: Record<string, CategoryMetrics>;
  evaluatedAt: string;
  k: number;
  meanRecallAtK: number;
  mrr: number;
  orderingViolationCount: number;
  precisionViolationCount: number;
  queryResults: QueryResult[];
  totalQueries: number;
  zeroResultRate: number;
}

/** Per-query evaluation result. */
export interface QueryResult {
  expectedMemoryIds: string[];
  orderingViolations?: string[];
  precisionViolations: string[];
  query: string;
  queryId: string;
  recallAtK: number;
  reciprocalRank: number;
  returnedMemoryIds: string[];
  testCategory: string;
  zeroResults: boolean;
}

/** Category-level metrics breakdown. */
interface CategoryMetrics {
  count: number;
  meanRecallAtK: number;
  mrr: number;
  zeroResultRate: number;
}

/** Baseline thresholds for regression detection. */
interface EvalBaseline {
  capturedAt: string;
  capturedFromCommit: string;
  k: number;
  meanRecallAtK: number;
  mrr: number;
  thresholds: {
    maxZeroResultRate: number;
    minMeanRecallAtK: number;
    minMrr: number;
  };
  zeroResultRate: number;
}

/** A synthetic memory entry for evaluation. */
interface EvalMemory {
  category: string;
  confidence?: number;
  content: string;
  id: string;
  project?: string;
  source?: string;
  status?: string;
  tags?: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EVAL_PROJECT_SCOPE = '__search-eval__';
const DEFAULT_K = 5;
const TEST_CATEGORIES = ['architecture', 'convention', 'preference', 'root-cause'] as const;

const moduleDir = dirname(fileURLToPath(import.meta.url));
const FIXTURES_PATH = resolve(moduleDir, 'search-eval-fixtures.json');
const BASELINE_PATH = resolve(moduleDir, 'search-eval-baseline.json');

// ---------------------------------------------------------------------------
// Pure functions (no DB required)
// ---------------------------------------------------------------------------

interface CliArgs {
  json: boolean;
  k: number;
  updateBaseline: boolean;
}

/** Aggregate per-query results into a summary report. */
export function aggregateResults(params: { k: number; queryResults: QueryResult[] }): EvalReport {
  const { k, queryResults } = params;
  const total = queryResults.length;

  if (total === 0) {
    return {
      byCategory: {},
      evaluatedAt: new Date().toISOString(),
      k,
      meanRecallAtK: 0,
      mrr: 0,
      orderingViolationCount: 0,
      precisionViolationCount: 0,
      queryResults,
      totalQueries: 0,
      zeroResultRate: 0,
    };
  }

  const sumRecall = queryResults.reduce((sum, r) => sum + r.recallAtK, 0);
  const sumRR = queryResults.reduce((sum, r) => sum + r.reciprocalRank, 0);
  const zeroCount = queryResults.filter(r => r.zeroResults).length;
  const precisionViolationCount = queryResults.reduce((sum, r) => sum + r.precisionViolations.length, 0);
  const orderingViolationCount = queryResults.reduce((sum, r) => sum + (r.orderingViolations?.length ?? 0), 0);

  // Per-category breakdown
  const byCategory: Record<string, CategoryMetrics> = {};
  for (const cat of TEST_CATEGORIES) {
    const catResults = queryResults.filter(r => r.testCategory === cat);
    if (catResults.length === 0) {
      continue;
    }
    const catRecall = catResults.reduce((sum, r) => sum + r.recallAtK, 0);
    const catRR = catResults.reduce((sum, r) => sum + r.reciprocalRank, 0);
    const catZero = catResults.filter(r => r.zeroResults).length;

    byCategory[cat] = {
      count: catResults.length,
      meanRecallAtK: roundTo(catRecall / catResults.length, 4),
      mrr: roundTo(catRR / catResults.length, 4),
      zeroResultRate: roundTo(catZero / catResults.length, 4),
    };
  }

  return {
    byCategory,
    evaluatedAt: new Date().toISOString(),
    k,
    meanRecallAtK: roundTo(sumRecall / total, 4),
    mrr: roundTo(sumRR / total, 4),
    orderingViolationCount,
    precisionViolationCount,
    queryResults,
    totalQueries: total,
    zeroResultRate: roundTo(zeroCount / total, 4),
  };
}

/** Compare a report against baseline thresholds at a matching K. */
export function compareReportToBaseline(params: {
  baseline: Pick<EvalBaseline, 'k' | 'thresholds'>;
  report: Pick<EvalReport, 'k' | 'meanRecallAtK' | 'mrr' | 'zeroResultRate'>;
}): string[] {
  const { baseline, report } = params;

  if (baseline.k !== report.k) {
    throw new Error(
      `Baseline K mismatch: baseline captured at k=${String(baseline.k)}, ` +
        `current run uses k=${String(report.k)}. Re-run with --k ${String(baseline.k)} ` +
        'or refresh the baseline with --update-baseline.',
    );
  }

  const regressions: string[] = [];
  if (report.meanRecallAtK < baseline.thresholds.minMeanRecallAtK) {
    regressions.push(
      `Recall@${String(report.k)} regressed: ` +
        `${formatPercent(report.meanRecallAtK)} < threshold ${formatPercent(baseline.thresholds.minMeanRecallAtK)}`,
    );
  }
  if (report.mrr < baseline.thresholds.minMrr) {
    regressions.push(
      `MRR regressed: ${formatPercent(report.mrr)} < threshold ${formatPercent(baseline.thresholds.minMrr)}`,
    );
  }
  if (report.zeroResultRate > baseline.thresholds.maxZeroResultRate) {
    regressions.push(
      `Zero-result rate regressed: ` +
        `${formatPercent(report.zeroResultRate)} > threshold ${formatPercent(baseline.thresholds.maxZeroResultRate)}`,
    );
  }

  return regressions;
}

/** Compute evaluation metrics for a single query. */
export function computeQueryResult(params: { k: number; query: EvalQuery; returnedMemoryIds: string[] }): QueryResult {
  const { k, query, returnedMemoryIds } = params;
  const topK = returnedMemoryIds.slice(0, k);
  const topKSet = new Set(topK);

  // Recall@K: fraction of expected results found in top K
  const expectedFound = query.expectedMemoryIds.filter(id => topKSet.has(id)).length;
  const recallAtK = query.expectedMemoryIds.length > 0 ? expectedFound / query.expectedMemoryIds.length : 1;

  // Reciprocal Rank: 1 / position of first expected result (1-indexed), or 0 if none found
  let reciprocalRank = 0;
  for (let i = 0; i < topK.length; i++) {
    if (query.expectedMemoryIds.includes(topK[i] ?? '')) {
      reciprocalRank = 1 / (i + 1);
      break;
    }
  }

  // Precision violations: excluded IDs that appeared in results
  const precisionViolations = query.excludedMemoryIds?.filter(id => topKSet.has(id)) ?? [];
  const orderingViolations = computeOrderingViolations({
    expectedBefore: query.expectedBefore ?? [],
    returnedMemoryIds: topK,
  });

  return {
    expectedMemoryIds: query.expectedMemoryIds,
    orderingViolations,
    precisionViolations,
    query: query.query,
    queryId: query.id,
    recallAtK,
    reciprocalRank,
    returnedMemoryIds: topK,
    testCategory: query.testCategory,
    zeroResults: returnedMemoryIds.length === 0,
  };
}

/** Load and validate the evaluation corpus from the fixtures JSON file. */
export function loadEvalCorpus(): EvalCorpus {
  const raw = readFileSync(FIXTURES_PATH, 'utf8');
  const parsed: unknown = JSON.parse(raw);

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Eval corpus must be a JSON object.');
  }

  const corpus = parsed as EvalCorpus;

  if (corpus.version !== '1.0') {
    throw new Error(`Unsupported corpus version: ${corpus.version}`);
  }

  if (!Array.isArray(corpus.memories) || !Array.isArray(corpus.queries)) {
    throw new Error('Corpus must contain "memories" and "queries" arrays.');
  }

  validateCorpusIntegrity(corpus);
  return corpus;
}

// ---------------------------------------------------------------------------
// Integration functions (require Postgres)
// ---------------------------------------------------------------------------

export function mapSearchResultsToFixtureIds(params: {
  dbIdToFixtureId: Map<number, string>;
  query: Pick<EvalQuery, 'id' | 'query'>;
  results: { id: number }[];
}): string[] {
  const { dbIdToFixtureId, query, results } = params;
  const missingDbIds: number[] = [];
  const returnedFixtureIds: string[] = [];

  for (const result of results) {
    const fixtureId = dbIdToFixtureId.get(result.id);
    if (fixtureId === undefined) {
      missingDbIds.push(result.id);
      continue;
    }
    returnedFixtureIds.push(fixtureId);
  }

  if (missingDbIds.length > 0) {
    throw new Error(
      `Search eval contamination detected for query "${query.id}" (${query.query}): ` +
        `unmapped memory IDs returned from DB [${missingDbIds.join(', ')}].`,
    );
  }

  return returnedFixtureIds;
}

/** Delete all evaluation memories from the database. */
async function cleanupEvalMemories(pool: DbPool): Promise<number> {
  const result = await pool.query(`DELETE FROM ai_memory_entries WHERE project = $1`, [EVAL_PROJECT_SCOPE]);
  return result.rowCount;
}

function computeOrderingViolations(params: {
  expectedBefore: { after: string; before: string }[];
  returnedMemoryIds: string[];
}): string[] {
  const violations: string[] = [];
  for (const pair of params.expectedBefore) {
    const beforeIndex = params.returnedMemoryIds.indexOf(pair.before);
    const afterIndex = params.returnedMemoryIds.indexOf(pair.after);
    if (afterIndex === -1) {
      continue;
    }
    if (beforeIndex === -1 || beforeIndex > afterIndex) {
      violations.push(`${pair.before} before ${pair.after}`);
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

async function getGitCommit(): Promise<string> {
  try {
    const { execSync } = await import('node:child_process');
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));

  // Dynamic imports for Postgres-dependent modules — keeps the pure functions importable without DB
  const { pool, searchMemories, storeMemory } = await import('@aviaratech/ai-memory/internal');

  const corpus = loadEvalCorpus();

  try {
    const staleDeleted = await cleanupEvalMemories(pool);
    if (staleDeleted > 0) {
      process.stdout.write(`Removed ${String(staleDeleted)} stale eval memories before seeding.\n`);
    }

    process.stdout.write(`Seeding ${String(corpus.memories.length)} memories...\n`);
    const fixtureIdToDbId = await seedEvalMemories({
      corpus,
      storeMemoryFn: storeMemory,
    });

    // Build reverse map: DB ID → fixture ID
    const dbIdToFixtureId = new Map<number, string>();
    for (const [fixtureId, dbId] of fixtureIdToDbId) {
      dbIdToFixtureId.set(dbId, fixtureId);
    }

    process.stdout.write(`Running ${String(corpus.queries.length)} queries (k=${String(args.k)})...\n`);
    const report = await runSearchEval({
      corpus,
      dbIdToFixtureId,
      k: args.k,
      searchMemoriesFn: searchMemories,
    });

    // Output
    if (args.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(renderReport(report));
    }

    // Baseline handling
    if (args.updateBaseline) {
      const baseline: EvalBaseline = {
        capturedAt: report.evaluatedAt,
        capturedFromCommit: await getGitCommit(),
        k: report.k,
        meanRecallAtK: report.meanRecallAtK,
        mrr: report.mrr,
        thresholds: {
          maxZeroResultRate: Math.min(1, report.zeroResultRate + 0.05),
          minMeanRecallAtK: Math.max(0, report.meanRecallAtK - 0.05),
          minMrr: Math.max(0, report.mrr - 0.05),
        },
        zeroResultRate: report.zeroResultRate,
      };

      const baselineTmpPath = `${BASELINE_PATH}.tmp.json`;
      writeJsonFile(baselineTmpPath, baseline);
      renameSync(baselineTmpPath, BASELINE_PATH);
      process.stdout.write(`Baseline updated at ${BASELINE_PATH}\n`);
    } else if (existsSync(BASELINE_PATH)) {
      const baselineRaw = readFileSync(BASELINE_PATH, 'utf8');
      const baseline = JSON.parse(baselineRaw) as EvalBaseline;
      const regressions = compareReportToBaseline({ baseline, report });
      const hardFailures = [
        ...(report.precisionViolationCount > 0
          ? [`Precision violations detected: ${String(report.precisionViolationCount)}`]
          : []),
        ...(report.orderingViolationCount > 0
          ? [`Ordering violations detected: ${String(report.orderingViolationCount)}`]
          : []),
      ];

      if (regressions.length > 0 || hardFailures.length > 0) {
        throw new Error(`REGRESSION DETECTED:\n${[...regressions, ...hardFailures].join('\n')}`);
      }

      process.stdout.write('No regressions detected vs baseline.\n');
    }
  } finally {
    const deleted = await cleanupEvalMemories(pool);
    process.stdout.write(`Cleaned up ${String(deleted)} eval memories.\n`);
    await pool.end();
  }
}

function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    json: false,
    k: DEFAULT_K,
    updateBaseline: false,
  };

  let i = 0;
  while (i < argv.length) {
    const value = argv[i];
    i += 1;
    if (value === undefined) {
      continue;
    }
    if (value === '--json') {
      args.json = true;
    } else if (value === '--update-baseline') {
      args.updateBaseline = true;
    } else if (value === '--k') {
      if (i >= argv.length) {
        throw new Error('--k requires a value');
      }
      const next = argv[i];
      i += 1;
      const parsed = Number(next);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error('--k must be a positive integer');
      }
      args.k = parsed;
    } else if (value === '--help' || value === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }

  return args;
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage: tsx src/eval/search-eval.ts [options]',
      '',
      'Options:',
      `  --k <number>         Top-K for Recall@K (default: ${String(DEFAULT_K)})`,
      '  --json               Output JSON report',
      '  --update-baseline    Capture current metrics as new baseline',
      '  --help, -h           Show this help',
      '',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push('AI Memory Search Eval Report');
  lines.push(`Evaluated at: ${report.evaluatedAt}`);
  lines.push(`Queries: ${String(report.totalQueries)} | K: ${String(report.k)}`);
  lines.push('');
  lines.push('Aggregate Metrics');
  lines.push(`  Recall@${String(report.k)}: ${formatPercent(report.meanRecallAtK)}`);
  lines.push(`  MRR:        ${formatPercent(report.mrr)}`);
  lines.push(`  Zero-result rate: ${formatPercent(report.zeroResultRate)}`);
  lines.push(`  Precision violations: ${String(report.precisionViolationCount)}`);
  lines.push(`  Ordering violations: ${String(report.orderingViolationCount)}`);
  lines.push('');

  lines.push('By Category');
  for (const [cat, metrics] of Object.entries(report.byCategory)) {
    lines.push(
      `  ${cat}: n=${String(metrics.count)} ` +
        `recall=${formatPercent(metrics.meanRecallAtK)} ` +
        `mrr=${formatPercent(metrics.mrr)} ` +
        `zero=${formatPercent(metrics.zeroResultRate)}`,
    );
  }
  lines.push('');

  const failures = report.queryResults.filter(r => r.zeroResults || r.recallAtK < 1);
  if (failures.length > 0) {
    lines.push(`Queries with degraded results (${String(failures.length)})`);
    for (const f of failures) {
      const status = f.zeroResults ? 'ZERO' : `recall=${formatPercent(f.recallAtK)}`;
      lines.push(`  [${f.testCategory}] "${f.query}" → ${status}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Run all eval queries against the live search function. */
async function runSearchEval(params: {
  corpus: EvalCorpus;
  dbIdToFixtureId: Map<number, string>;
  k?: number;
  searchMemoriesFn: (input: unknown) => Promise<{ id: number }[]>;
}): Promise<EvalReport> {
  const { corpus, dbIdToFixtureId, k = DEFAULT_K, searchMemoriesFn } = params;
  const queryResults: QueryResult[] = [];

  for (const query of corpus.queries) {
    const results = await searchMemoriesFn({
      limit: k,
      project: EVAL_PROJECT_SCOPE,
      query: query.query,
    });

    const returnedFixtureIds = mapSearchResultsToFixtureIds({
      dbIdToFixtureId,
      query,
      results,
    });

    const result = computeQueryResult({
      k,
      query,
      returnedMemoryIds: returnedFixtureIds,
    });

    queryResults.push(result);
  }

  return aggregateResults({ k, queryResults });
}

/** Seed evaluation memories into the database. Returns a map of fixture ID → database ID. */
async function seedEvalMemories(params: {
  corpus: EvalCorpus;
  storeMemoryFn: (input: unknown) => Promise<{ id: number }>;
}): Promise<Map<string, number>> {
  const { corpus, storeMemoryFn } = params;
  const idMap = new Map<string, number>();

  const strictCategories = new Set(['architecture', 'convention', 'preference', 'root-cause']);
  for (const memory of corpus.memories) {
    const isStrict = strictCategories.has(memory.category);
    const stored = await storeMemoryFn({
      category: memory.category,
      confidence: memory.confidence ?? 0.8,
      content: memory.content,
      ...(isStrict
        ? {
            evidenceRefs: ['search-eval-fixture'],
            memoryKey: `${EVAL_PROJECT_SCOPE}:${memory.id}`,
          }
        : {}),
      project: EVAL_PROJECT_SCOPE,
      source: memory.source ?? 'search-eval',
      status: memory.status,
      tags: memory.tags ?? [],
    });

    idMap.set(memory.id, stored.id);
  }

  return idMap;
}

/** Validate referential integrity: no duplicate IDs, all expected IDs reference real memories. */
function validateCorpusIntegrity(corpus: EvalCorpus): void {
  const memoryIds = new Set<string>();
  for (const memory of corpus.memories) {
    if (memoryIds.has(memory.id)) {
      throw new Error(`Duplicate memory ID: "${memory.id}"`);
    }
    memoryIds.add(memory.id);
  }

  const queryIds = new Set<string>();
  for (const query of corpus.queries) {
    if (queryIds.has(query.id)) {
      throw new Error(`Duplicate query ID: "${query.id}"`);
    }
    queryIds.add(query.id);

    for (const expectedId of query.expectedMemoryIds) {
      if (!memoryIds.has(expectedId)) {
        throw new Error(`Query "${query.id}" references nonexistent memory "${expectedId}"`);
      }
    }

    if (query.excludedMemoryIds !== undefined) {
      for (const excludedId of query.excludedMemoryIds) {
        if (!memoryIds.has(excludedId)) {
          throw new Error(`Query "${query.id}" excludes nonexistent memory "${excludedId}"`);
        }
      }
    }

    if (query.expectedBefore !== undefined) {
      for (const pair of query.expectedBefore) {
        if (!memoryIds.has(pair.before)) {
          throw new Error(`Query "${query.id}" orders nonexistent memory "${pair.before}"`);
        }
        if (!memoryIds.has(pair.after)) {
          throw new Error(`Query "${query.id}" orders nonexistent memory "${pair.after}"`);
        }
      }
    }
  }
}

// Run CLI when executed directly (exclude test files that import this module)
const scriptArg = process.argv[1] ?? '';
const isDirectRun =
  scriptArg.length > 0 && resolve(scriptArg).includes('search-eval') && !resolve(scriptArg).includes('.test.');

if (isDirectRun) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[search-eval] ${message}\n`);
    process.exit(1);
  });
}
