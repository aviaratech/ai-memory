import type { DbClient, DbPool } from './pool.js';
import type { ClientBase } from 'pg';

import { runner as runNodePgMigrate } from 'node-pg-migrate';
import { existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface CountRow {
  migration_count: number;
}

interface ExistsRow {
  exists: boolean;
}

const MIGRATIONS_TABLE = 'ai_memory_pgmigrations';
const MIGRATIONS_TABLE_SCHEMA = 'public';
const LEGACY_FINAL_MIGRATION_ID = '2026_02_26_019_write_calibration_confidence';
const BASELINE_MIGRATION_NAME = '001_baseline';
const BENIGN_TIMESTAMP_DIAGNOSTIC_PATTERN = /^Can't determine timestamp for \d{3}$/u;
const MIGRATIONS_DIR_ENV_KEY = 'AI_MEMORY_MIGRATIONS_DIR';

type MigrationLogLevel = 'debug' | 'error' | 'info' | 'warn';
type MigrationRunner = typeof runNodePgMigrate;

interface ResolveAiMemoryMigrationsDirOptions {
  env?: NodeJS.ProcessEnv;
  exists?: (pathname: string) => boolean;
  moduleUrl?: string;
}

export function resolveAiMemoryMigrationsDir(options: ResolveAiMemoryMigrationsDirOptions = {}): string {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const moduleDir = dirname(fileURLToPath(options.moduleUrl ?? import.meta.url));
  const packageLayoutDir = resolve(moduleDir, '..', '..', 'migrations');
  const bundledPluginLayoutDir = resolve(moduleDir, '..', 'migrations');
  const layoutCandidates =
    basename(moduleDir) === 'dist'
      ? [bundledPluginLayoutDir, packageLayoutDir]
      : [packageLayoutDir, bundledPluginLayoutDir];
  const candidates = [normalizeOptionalPath(env[MIGRATIONS_DIR_ENV_KEY]), ...layoutCandidates].filter(
    (candidate): candidate is string => candidate !== undefined,
  );

  for (const candidate of candidates) {
    if (exists(candidate)) {
      return candidate;
    }
  }

  throw new Error(`ai-memory migrations directory not found. Checked: ${candidates.join(', ')}`);
}

function emitMigrationLog(level: MigrationLogLevel, message: unknown): void {
  const resolvedLevel = resolveMigrationLogLevel(level, message);
  const payload =
    typeof message === 'string'
      ? { context: { source: 'node-pg-migrate' }, level: resolvedLevel, message: `[ai-memory] ${message}` }
      : {
          context: { payload: message, source: 'node-pg-migrate' },
          level: resolvedLevel,
          message: '[ai-memory] migration log',
        };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
}

function normalizeOptionalPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : resolve(trimmed);
}

function resolveMigrationLogLevel(level: MigrationLogLevel, message: unknown): MigrationLogLevel {
  if (level === 'error' && typeof message === 'string' && BENIGN_TIMESTAMP_DIAGNOSTIC_PATTERN.test(message)) {
    return 'debug';
  }
  return level;
}

const migrationLogger = {
  debug(message: unknown): void {
    emitMigrationLog('debug', message);
  },
  error(message: unknown): void {
    emitMigrationLog('error', message);
  },
  info(message: unknown): void {
    emitMigrationLog('info', message);
  },
  warn(message: unknown): void {
    emitMigrationLog('warn', message);
  },
};

export async function runAiMemoryMigrations(pool: DbPool): Promise<void> {
  const migrationsDir = resolveAiMemoryMigrationsDir();

  const client = await pool.connect();
  try {
    await seedExistingSchemaTracking(client);

    const runner = loadMigrationRunner();
    await runner({
      checkOrder: true,
      dbClient: client as unknown as ClientBase,
      dir: migrationsDir,
      direction: 'up',
      logger: migrationLogger,
      migrationsTable: MIGRATIONS_TABLE,
      singleTransaction: false,
    });
  } finally {
    client.release();
  }
}

function loadMigrationRunner(): MigrationRunner {
  return runNodePgMigrate;
}

async function seedExistingSchemaTracking(client: DbClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${MIGRATIONS_TABLE_SCHEMA}"."${MIGRATIONS_TABLE}" (
      id SERIAL PRIMARY KEY,
      name varchar(255) NOT NULL,
      run_on timestamp NOT NULL
    )
  `);

  const trackingCount = await client.query<CountRow>(
    `SELECT COUNT(*)::int AS migration_count FROM "${MIGRATIONS_TABLE_SCHEMA}"."${MIGRATIONS_TABLE}"`,
  );
  if ((trackingCount.rows[0]?.migration_count ?? 0) > 0) return;

  const legacyTableExists = await client.query<ExistsRow>(
    `SELECT to_regclass('ai_memory_migrations') IS NOT NULL AS exists`,
  );
  if (legacyTableExists.rows[0]?.exists !== true) return;

  const legacyBaselineApplied = await client.query<ExistsRow>(
    `SELECT EXISTS (
      SELECT 1
      FROM ai_memory_migrations
      WHERE id = '${LEGACY_FINAL_MIGRATION_ID}'
    )`,
  );
  if (legacyBaselineApplied.rows[0]?.exists !== true) return;

  await client.query(
    `INSERT INTO "${MIGRATIONS_TABLE_SCHEMA}"."${MIGRATIONS_TABLE}" (name, run_on)
     SELECT $1::text, NOW()
     WHERE NOT EXISTS (
       SELECT 1 FROM "${MIGRATIONS_TABLE_SCHEMA}"."${MIGRATIONS_TABLE}"
       WHERE name = $1::text
     )`,
    [BASELINE_MIGRATION_NAME],
  );
}
