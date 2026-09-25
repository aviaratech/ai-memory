#!/usr/bin/env node

/**
 * Backfill embeddings for active memories that lack them.
 *
 * Usage: node packages/ai-memory-tools/dist/scripts/backfill-embeddings.js [options]
 *   or:  npm run backfill:embeddings -- [options]
 *
 * This script is idempotent — re-running it skips already-embedded memories.
 * Requires AI_MEMORY_EMBEDDING_PROVIDER=openai and AI_MEMORY_EMBEDDING_API_KEY.
 */

import {
  closePool,
  getDatabaseUrlForDisplay,
  getEmbedding,
  initializeDatabase,
  isEmbeddingAvailable,
  pool,
  SESSION_SUMMARY_CATEGORY,
} from '@aviaratech/ai-memory/internal';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { bootstrapAiMemoryCliRuntimeEnv } from '../runtimeEnv.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BackfillResult {
  batches: number;
  dryRun: boolean;
  embedded: number;
  errors: number;
  skipped: number;
  total: number;
}

interface CliOptions {
  batchSize: number;
  delayMs: number;
  dryRun: boolean;
  help: boolean;
  skipInit: boolean;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

// Exclude session-summary — getEmbedding() always returns null for that category.
// Including them would inflate the pending count without ever making progress.
const PENDING_SQL = `
  SELECT COUNT(*) AS count
  FROM ai_memory_entries
  WHERE embedding IS NULL
    AND status = 'active'
    AND (category IS NULL OR category != $1)
`;

const BATCH_SQL = `
  SELECT id, content, category
  FROM ai_memory_entries
  WHERE embedding IS NULL
    AND status = 'active'
    AND (category IS NULL OR category != $1)
    AND id > $2
  ORDER BY id ASC
  LIMIT $3
`;

const UPDATE_SQL = `
  UPDATE ai_memory_entries
  SET embedding = $1, updated_at = NOW()
  WHERE id = $2
`;

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    batchSize: 100,
    delayMs: 200,
    dryRun: true,
    help: false,
    skipInit: false,
  };

  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === undefined) {
      break;
    }

    if (arg === '--') {
      index += 1;
      continue;
    }

    if (arg === '--dry-run') {
      options.dryRun = true;
      index += 1;
      continue;
    }

    if (arg === '--apply') {
      options.dryRun = false;
      index += 1;
      continue;
    }

    if (arg === '--skip-init') {
      options.skipInit = true;
      index += 1;
      continue;
    }

    if (arg === '--batch-size') {
      const next = argv[index + 1];
      if (next === undefined) {
        throw new Error('Missing value for --batch-size.');
      }
      const parsed = Number(next);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error('--batch-size must be a positive integer.');
      }
      options.batchSize = parsed;
      index += 2;
      continue;
    }

    if (arg === '--delay-ms') {
      const next = argv[index + 1];
      if (next === undefined) {
        throw new Error('Missing value for --delay-ms.');
      }
      const parsed = Number(next);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error('--delay-ms must be a non-negative integer.');
      }
      options.delayMs = parsed;
      index += 2;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

async function backfillEmbeddings(options: {
  batchSize: number;
  delayMs: number;
  dryRun: boolean;
}): Promise<BackfillResult> {
  const { batchSize, delayMs, dryRun } = options;

  const total = await countPendingMemories();

  if (dryRun) {
    process.stderr.write(`[backfill] Dry-run: ${String(total)} active memories pending embedding.\n`);
    return { batches: 0, dryRun, embedded: 0, errors: 0, skipped: 0, total };
  }

  let embedded = 0;
  let errors = 0;
  let skipped = 0;
  let batches = 0;
  let lastId = 0;

  for (;;) {
    // Fetch next batch using a stable ID cursor so we always advance,
    // even when some rows fail or are skipped in this run.
    const batchResult = await pool.query<{
      category: null | string;
      content: string;
      id: number;
    }>(BATCH_SQL, [SESSION_SUMMARY_CATEGORY, lastId, batchSize]);

    if (batchResult.rows.length === 0) {
      break;
    }

    batches += 1;
    const processed = embedded + errors + skipped;
    process.stderr.write(
      `[backfill] Batch ${String(batches)}: ${String(batchResult.rows.length)} memories (${String(processed)}/${String(total)} done)\n`,
    );

    for (const row of batchResult.rows) {
      const outcome = await embedAndUpdateRow(row);
      if (outcome === 'embedded') {
        embedded += 1;
      } else if (outcome === 'skipped') {
        skipped += 1;
      } else {
        errors += 1;
      }
      // Advance cursor per row; rows are ordered ASC so each id >= lastId.
      // On re-run, items that errored will be retried from id=0.
      lastId = row.id;
    }

    if (batchResult.rows.length < batchSize) {
      break;
    }

    if (delayMs > 0) {
      await new Promise<void>(resolve => {
        setTimeout(resolve, delayMs);
      });
    }
  }

  const processed = embedded + errors + skipped;
  process.stderr.write(
    `[backfill] Complete: ${String(embedded)} embedded, ${String(errors)} errors, ${String(skipped)} skipped (${String(processed)} of ${String(total)})\n`,
  );

  return { batches, dryRun, embedded, errors, skipped, total };
}

async function countPendingMemories(): Promise<number> {
  const result = await pool.query<{ count: string }>(PENDING_SQL, [SESSION_SUMMARY_CATEGORY]);
  return Number(result.rows[0]?.count ?? 0);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function embedAndUpdateRow(row: {
  category: null | string;
  content: string;
  id: number;
}): Promise<'embedded' | 'error' | 'skipped'> {
  const embedding = await getEmbedding(row.content, {
    category: row.category,
    operation: 'backfill_embeddings',
  });

  if (embedding === null) {
    process.stderr.write(`[backfill] Memory ${String(row.id)}: embedding unavailable, skipping\n`);
    return 'skipped';
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(UPDATE_SQL, [JSON.stringify(embedding), row.id]);
    await client.query('COMMIT');
    return 'embedded';
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[backfill] Memory ${String(row.id)}: update failed: ${message}\n`);
    return 'error';
  } finally {
    client.release();
  }
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) return false;
  if (import.meta.url === pathToFileURL(entrypoint).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entrypoint)).href;
  } catch {
    return false;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  bootstrapAiMemoryCliRuntimeEnv();

  if (!isEmbeddingAvailable()) {
    process.stderr.write(
      '[backfill] Embedding provider not configured. ' +
        'Set AI_MEMORY_EMBEDDING_PROVIDER=openai and AI_MEMORY_EMBEDDING_API_KEY.\n',
    );
    process.exitCode = 1;
    return;
  }

  if (!options.skipInit) {
    await initializeDatabase();
  }

  const result = await backfillEmbeddings({
    batchSize: options.batchSize,
    delayMs: options.delayMs,
    dryRun: options.dryRun,
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        database: getDatabaseUrlForDisplay(),
        ...result,
      },
      null,
      2,
    )}\n`,
  );
}

function printHelp() {
  process.stdout.write(
    [
      'Usage: npm run backfill:embeddings -- [options]',
      '   or: node packages/ai-memory-tools/dist/scripts/backfill-embeddings.js [options]',
      '',
      'Backfill embeddings for active memories that lack them.',
      'Requires AI_MEMORY_EMBEDDING_PROVIDER=openai and AI_MEMORY_EMBEDDING_API_KEY.',
      '',
      'Options:',
      '  --dry-run            Show pending count without updating (default).',
      '  --apply              Persist embeddings to the database.',
      '  --batch-size <N>     Memories per batch (default: 100).',
      '  --delay-ms <N>       Milliseconds between batches for rate limiting (default: 200).',
      '  --skip-init          Skip initializeDatabase() preflight.',
      '  --help, -h           Show this help.',
      '',
    ].join('\n'),
  );
}

if (isMainModule()) {
  void (async () => {
    try {
      await main();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[ai-memory] backfill-embeddings failed: ${message}\n`);
      process.exitCode = 1;
    } finally {
      await closePool();
    }
  })();
}
