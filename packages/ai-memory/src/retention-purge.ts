#!/usr/bin/env node

import { closePool, getDatabaseUrlForDisplay, initializeDatabase } from './db.js';
import { runRetentionPurge } from './retention/retentionRunner.js';

interface CliOptions {
  batchSize?: number | undefined;
  dataset?: string | undefined;
  dryRun: boolean;
  help: boolean;
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

  const result = await runRetentionPurge({
    batchSize: options.batchSize,
    dataset: options.dataset,
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

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    batchSize: undefined,
    dataset: undefined,
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

    if (arg === '--dataset') {
      const next = argv[index + 1];
      if (next === undefined) {
        throw new Error('Missing value for --dataset.');
      }

      options.dataset = next;
      index += 2;
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
      'Usage: npm run retention:purge -- [options]',
      '',
      'Options:',
      '  --dry-run                Preview candidates without deleting (default).',
      '  --apply                  Physically delete eligible rows.',
      '  --dataset <table>        Restrict purge to a single table.',
      '  --batch-size <number>    Rows per DELETE batch (default: 1000).',
      '  --skip-init              Skip initializeDatabase() preflight.',
      '  --help, -h               Show this help.',
      '',
    ].join('\n'),
  );
}

void (async () => {
  try {
    await main();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[ai-memory] retention purge failed: ${message}\n`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
})();
