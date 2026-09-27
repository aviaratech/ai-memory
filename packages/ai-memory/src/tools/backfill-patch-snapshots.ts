#!/usr/bin/env node

import {
  backfillPatchSnapshots,
  closePool,
  getDatabaseUrlForDisplay,
  initializeDatabase,
} from '@aviaratech/ai-memory/internal';

interface CliOptions {
  dryRun: boolean;
  help: boolean;
  limit?: number | undefined;
  sessionId?: string | undefined;
  skipInit: boolean;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (!options.skipInit) {
    await initializeDatabase();
  }

  const result = await backfillPatchSnapshots({
    dryRun: options.dryRun,
    limit: options.limit,
    sessionId: options.sessionId,
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

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    dryRun: false,
    help: false,
    limit: undefined,
    sessionId: undefined,
    skipInit: false,
  };

  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === undefined) {
      break;
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

    if (arg === '--limit') {
      const next = argv[index + 1];
      if (next === undefined) {
        throw new Error('Missing value for --limit.');
      }

      const parsed = Number(next);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error('--limit must be a positive integer.');
      }

      options.limit = parsed;
      index += 1;
      index += 1;
      continue;
    }

    if (arg === '--session-id') {
      const next = argv[index + 1];
      if (typeof next !== 'string' || next.trim().length === 0) {
        throw new Error('Missing value for --session-id.');
      }

      options.sessionId = next.trim();
      index += 1;
      index += 1;
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

function printHelp() {
  process.stdout.write(
    [
      'Usage: npm run backfill:patch-snapshots -- [options]',
      '',
      'Options:',
      '  --dry-run            Execute in a transaction rollback mode.',
      '  --apply              Persist results (default behavior).',
      '  --limit <number>     Maximum sessions to process (default: 200).',
      '  --session-id <id>    Backfill a specific session only.',
      '  --skip-init          Skip initializeDatabase() preflight.',
      '  --help, -h           Show this help.',
      '',
    ].join('\n'),
  );
}

void (async () => {
  try {
    await main();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[ai-memory] backfill failed: ${message}\n`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
})();
