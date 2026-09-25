#!/usr/bin/env node

/**
 * CLI: failures:resolve-known
 *
 * Resolves known historical ingestion failures by fix signature.
 * Default mode is dry-run (safe). Use --apply to perform DB updates.
 *
 * Usage:
 *   npm run failures:resolve-known            # dry-run (default)
 *   npm run failures:resolve-known --dry-run  # explicit dry-run
 *   npm run failures:resolve-known --apply    # perform updates
 *
 * Rollback: update rows WHERE resolution_batch_id = '<batch_id>' to NULL values.
 * See ROLLBACK_QUERY_TEMPLATE in db/failure-resolver.ts for the exact query.
 */

import { createPool } from '@aviaratech/ai-memory/internal';
import { resolveKnownFailures, ROLLBACK_QUERY_TEMPLATE } from '@aviaratech/ai-memory/internal';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type AiMemoryDatabaseTarget,
  formatAiMemoryDatabaseTarget,
  requireAiMemoryCliDatabaseTarget,
} from './runtimeEnv.js';

interface CliOptions {
  apply: boolean;
  dryRun: boolean;
  help: boolean;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  const databaseTarget = resolveDatabaseTarget();
  const pool = createPool({ connectionString: databaseTarget.databaseUrl });

  try {
    const outcome = await resolveKnownFailures(pool, { dryRun: options.dryRun });

    const output = {
      database: formatAiMemoryDatabaseTarget(databaseTarget),
      mode: outcome.dryRun ? 'dry-run' : 'apply',
      ...outcome.result,
      ...(outcome.dryRun ? {} : { rollbackTemplate: ROLLBACK_QUERY_TEMPLATE }),
    };

    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    apply: false,
    dryRun: true,
    help: false,
  };

  for (const arg of argv) {
    if (arg === '--apply') {
      options.apply = true;
      options.dryRun = false;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
      options.apply = false;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    }
  }

  return options;
}

function printHelp() {
  process.stdout.write(`
failures:resolve-known — Resolve known historical ingestion failures by fix signature

Usage:
  npm run failures:resolve-known [--dry-run | --apply]

Options:
  --dry-run   Report matching candidates without writing to DB (default)
  --apply     Perform resolution updates; emits resolution_batch_id for rollback
  --help, -h  Show this help

Rollback a previous apply run:
  UPDATE ai_ingestion_failures
    SET resolved_at = NULL, resolved_by = NULL, resolved_reason = NULL, resolution_batch_id = NULL
    WHERE resolution_batch_id = '<batch_id_from_apply_output>';
`);
}

function resolveDatabaseTarget(): AiMemoryDatabaseTarget {
  return requireAiMemoryCliDatabaseTarget();
}

const isDirectRun = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`failures:resolve-known error: ${message}\n`);
    process.exitCode = 1;
  });
}

export { resolveDatabaseTarget };
