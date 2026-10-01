import type { DbClient, DbPool } from './pool.js';
import type { ClientBase } from 'pg';

import { runner as runNodePgMigrate } from 'node-pg-migrate';
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface CountRow {
  migration_count: number;
}

interface ExistsRow {
  exists: boolean;
}

interface LedgerState {
  can_migrate: boolean;
  compatible: boolean;
  ledger_exists: boolean;
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
  // Canonical assets are numbered SQL files. The library's published discovery
  // subpath has unresolved imports in 8.0.4; keep its executor as the sole owner
  // of applying migrations and inspect only the shipped filename inventory here.
  const files = readdirSync(migrationsDir, { withFileTypes: true }).filter(file => !file.name.startsWith('.'));
  if (files.some(file => !file.isFile() || !/^\d{3}_.+\.sql$/u.test(file.name))) {
    throw new Error('ai-memory migration assets are incompatible. Restore the canonical numbered SQL files.');
  }
  const migrationNames = files.map(file => file.name.slice(0, -4)).sort();
  if (migrationNames.length === 0 || new Set(migrationNames).size !== migrationNames.length) {
    throw new Error('ai-memory migration assets are empty or contain duplicate names. Restore the canonical package.');
  }

  const client = await pool.connect();
  let discardClient = false;
  try {
    // A completed ledger is a startup prerequisite, not a reason to invoke a
    // runner that ensures its own table with CREATE/ALTER on every invocation.
    await client.query('BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ');
    const state = (
      await client.query<LedgerState>(`
      WITH ledger AS (SELECT to_regclass('public.ai_memory_pgmigrations') AS oid)
      SELECT ledger.oid IS NOT NULL AS ledger_exists,
        has_schema_privilege('public', 'CREATE') AND
          (ledger.oid IS NULL OR pg_has_role(c.relowner, 'USAGE')) AS can_migrate,
        c.relkind = 'r' AND
          (SELECT COUNT(*) = 3 FROM pg_attribute a
           WHERE a.attrelid = c.oid AND NOT a.attisdropped AND a.attnotnull AND
             ((a.attname = 'id' AND a.atttypid = 'int4'::regtype) OR
              (a.attname = 'name' AND a.atttypid = 'varchar'::regtype AND a.atttypmod = 259) OR
              (a.attname = 'run_on' AND a.atttypid = 'timestamp'::regtype))) AND
          EXISTS (SELECT 1 FROM pg_constraint p JOIN pg_attribute a
                  ON a.attrelid = p.conrelid AND a.attname = 'id'
                  WHERE p.conrelid = c.oid AND p.contype = 'p' AND p.convalidated
                    AND p.conkey = ARRAY[a.attnum]) AS compatible
      FROM ledger LEFT JOIN pg_class c ON c.oid = ledger.oid
    `)
    ).rows[0];
    if (state === undefined) throw new Error('ai-memory migration ledger state is unavailable.');
    if (state.ledger_exists) {
      if (!state.compatible) requireAdministrator('incompatible migration ledger');
      const applied = (
        await client.query<{ name: string }>(`SELECT name FROM "public"."ai_memory_pgmigrations" ORDER BY run_on, id`)
      ).rows.map(row => row.name);
      if (applied.length > migrationNames.length || applied.some((name, index) => name !== migrationNames[index])) {
        requireAdministrator('incompatible migration history');
      }
      if (applied.length === migrationNames.length) {
        await client.query('COMMIT');
        return;
      }
    }
    if (!state.can_migrate)
      requireAdministrator(state.ledger_exists ? 'pending migrations' : 'missing migration ledger');
    await client.query('COMMIT');
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
  } catch (error) {
    // The external-client runner can leave an aborted per-migration transaction
    // and a session advisory lock after cancellation. Never return it to callers.
    discardClient = true;
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    if (discardClient) client.release(true);
    else client.release();
  }
}

function requireAdministrator(reason: string): never {
  throw new Error(
    `ai-memory startup cannot proceed: ${reason}. An administrator must apply the canonical migrations using the matching package before runtime startup.`,
  );
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
