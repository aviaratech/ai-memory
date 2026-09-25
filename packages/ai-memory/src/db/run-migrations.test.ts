import type { DbClient, DbPool } from './pool.js';

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { describe, it, vi } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rowCount: number; rows: Record<string, unknown>[] }>;
type RunnerFn = (options: Record<string, unknown>) => Promise<unknown[]>;

const runnerMock = mock.fn<RunnerFn>(() => Promise.resolve([]));
const mockQuery = mock.fn<QueryFn>();
const mockRelease = mock.fn(() => undefined);
const mockClient = { query: mockQuery, release: mockRelease } as unknown as DbClient;
const mockConnect = mock.fn(() => Promise.resolve(mockClient));

vi.doMock('node-pg-migrate', () => ({
  runner: runnerMock,
}));

const { resolveAiMemoryMigrationsDir, runAiMemoryMigrations } = await import('./run-migrations.js');
const compiledMigrationModulePath = fileURLToPath(new URL('../../dist/db/run-migrations.js', import.meta.url));

function createMockPool(): DbPool {
  return {
    connect: mockConnect,
    end: mock.fn(() => Promise.resolve()),
    getClient: mockConnect,
    query: mockQuery as DbPool['query'],
  };
}

function insertedPgmigrationNames(): string[] {
  return mockQuery.mock.calls
    .filter(call => call.arguments[0].includes('INSERT INTO "public"."ai_memory_pgmigrations"'))
    .map(call => call.arguments[1]?.[0])
    .filter((name): name is string => typeof name === 'string');
}

function installQueryHandler(input: {
  legacyFinalMigrationApplied: boolean;
  legacyMigrationTableExists?: boolean;
  newTrackingCount: number;
}): void {
  const legacyMigrationTableExists = input.legacyMigrationTableExists ?? true;

  mockQuery.mock.mockImplementation((sql: string, params?: unknown[]) => {
    const compactSql = sql.replace(/\s+/gu, ' ').trim();

    if (compactSql.includes('CREATE TABLE IF NOT EXISTS "public"."ai_memory_pgmigrations"')) {
      return Promise.resolve({ rowCount: 0, rows: [] });
    }
    if (
      compactSql.includes('COUNT(*)::int AS migration_count') &&
      compactSql.includes('"public"."ai_memory_pgmigrations"')
    ) {
      return Promise.resolve({ rowCount: 1, rows: [{ migration_count: input.newTrackingCount }] });
    }
    if (compactSql.includes("to_regclass('ai_memory_migrations')")) {
      return Promise.resolve({ rowCount: 1, rows: [{ exists: legacyMigrationTableExists }] });
    }
    if (
      compactSql.includes('FROM ai_memory_migrations') &&
      compactSql.includes("id = '2026_02_26_019_write_calibration_confidence'")
    ) {
      if (!legacyMigrationTableExists) {
        throw new Error('relation "ai_memory_migrations" does not exist');
      }
      return Promise.resolve({ rowCount: 1, rows: [{ exists: input.legacyFinalMigrationApplied }] });
    }
    if (compactSql.includes('INSERT INTO "public"."ai_memory_pgmigrations"')) {
      assert.equal(typeof params?.[0], 'string');
      return Promise.resolve({ rowCount: 1, rows: [] });
    }

    return Promise.resolve({ rowCount: 0, rows: [] });
  });
}

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

function mkdir(pathname: string): string {
  mkdirSync(pathname, { recursive: true });
  return pathname;
}

function resetMocks(): void {
  runnerMock.mock.resetCalls();
  mockQuery.mock.resetCalls();
  mockRelease.mock.resetCalls();
  mockConnect.mock.resetCalls();
}

function toFileUrl(pathname: string): string {
  return pathToFileURL(pathname).href;
}

describe('runAiMemoryMigrations', () => {
  it('resolves an explicit ai-memory migrations dir override', () => {
    const root = makeTempDir('ai-memory-migrations-env');
    const overrideDir = mkdir(join(root, 'custom-migrations'));
    const modulePath = join(root, 'release', 'plugins', 'ai-memory', 'dist', 'mcp-server.bundle.js');

    assert.equal(
      resolveAiMemoryMigrationsDir({
        env: { AI_MEMORY_MIGRATIONS_DIR: overrideDir },
        moduleUrl: toFileUrl(modulePath),
      }),
      overrideDir,
    );
  });

  it('resolves the package-owned migrations dir from compiled package layout', () => {
    const root = makeTempDir('ai-memory-migrations-package');
    const migrationsDir = mkdir(join(root, 'packages', 'ai-memory', 'migrations'));
    const modulePath = join(root, 'packages', 'ai-memory', 'dist', 'db', 'run-migrations.js');

    assert.equal(resolveAiMemoryMigrationsDir({ env: {}, moduleUrl: toFileUrl(modulePath) }), migrationsDir);
  });

  it('resolves the namespaced plugin migrations dir from bundled plugin layout', () => {
    const root = makeTempDir('ai-memory-migrations-bundle');
    const migrationsDir = mkdir(join(root, 'release', 'plugins', 'ai-memory', 'migrations'));
    const modulePath = join(root, 'release', 'plugins', 'ai-memory', 'dist', 'mcp-server.bundle.js');

    assert.equal(resolveAiMemoryMigrationsDir({ env: {}, moduleUrl: toFileUrl(modulePath) }), migrationsDir);
  });

  it('prefers namespaced plugin layout before shared plugin arithmetic in bundled runtime', () => {
    const root = makeTempDir('ai-memory-migrations-bundle-order');
    const migrationsDir = mkdir(join(root, 'release', 'plugins', 'ai-memory', 'migrations'));
    mkdir(join(root, 'release', 'plugins', 'migrations'));
    const modulePath = join(root, 'release', 'plugins', 'ai-memory', 'dist', 'mcp-server.bundle.js');

    assert.equal(resolveAiMemoryMigrationsDir({ env: {}, moduleUrl: toFileUrl(modulePath) }), migrationsDir);
  });

  it('prefers package layout before bundled layout when both candidates exist', () => {
    const root = makeTempDir('ai-memory-migrations-order');
    const packageMigrationsDir = mkdir(join(root, 'package-root', 'migrations'));
    mkdir(join(root, 'package-root', 'dist', 'migrations'));
    const modulePath = join(root, 'package-root', 'dist', 'db', 'run-migrations.js');

    assert.equal(resolveAiMemoryMigrationsDir({ env: {}, moduleUrl: toFileUrl(modulePath) }), packageMigrationsDir);
  });

  it('throws a migration-specific error when no candidate directory exists', () => {
    const root = makeTempDir('ai-memory-migrations-missing');
    const modulePath = join(root, 'release', 'plugins', 'ai-memory', 'dist', 'mcp-server.bundle.js');

    assert.throws(
      () => resolveAiMemoryMigrationsDir({ env: {}, moduleUrl: toFileUrl(modulePath) }),
      error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /ai-memory migrations directory not found/u);
        assert.match(error.message, /plugins\/migrations/u);
        assert.match(error.message, /plugins\/ai-memory\/migrations/u);
        return true;
      },
    );
  });

  it('delegates to node-pg-migrate with the shared pool client and ai-memory migration directory', async () => {
    resetMocks();
    installQueryHandler({ legacyFinalMigrationApplied: false, newTrackingCount: 0 });

    await runAiMemoryMigrations(createMockPool());

    assert.equal(mockConnect.mock.callCount(), 1);
    assert.equal(mockRelease.mock.callCount(), 1);
    assert.equal(runnerMock.mock.callCount(), 1);

    const options = runnerMock.mock.calls[0]?.arguments[0];
    assert.ok(options);
    assert.strictEqual(options.dbClient, mockClient);
    assert.equal(options.migrationsTable, 'ai_memory_pgmigrations');
    assert.equal(options.direction, 'up');
    assert.equal(options.singleTransaction, false);
    assert.equal(options.checkOrder, true);
    assert.match(String(options.dir), /packages\/ai-memory\/migrations$/u);
  });

  it('keeps the node-pg-migrate import visible to plugin bundling', () => {
    const compiledSource = readFileSync(compiledMigrationModulePath, 'utf8');

    assert.doesNotMatch(compiledSource, /import\(\s*NODE_PG_MIGRATE_MODULE\s*\)/u);
    assert.match(compiledSource, /(?:from|import\()\s*['"]node-pg-migrate['"]/u);
  });

  it('marks the baseline as applied when legacy ai_memory_migrations already reached the final custom migration', async () => {
    resetMocks();
    installQueryHandler({ legacyFinalMigrationApplied: true, newTrackingCount: 0 });

    await runAiMemoryMigrations(createMockPool());

    assert.deepEqual(insertedPgmigrationNames(), ['001_baseline']);
    assert.equal(runnerMock.mock.callCount(), 1, 'runner still executes so future pending migrations are detected');
  });

  it('does not seed the baseline on fresh or partially migrated databases', async () => {
    resetMocks();
    installQueryHandler({ legacyFinalMigrationApplied: false, newTrackingCount: 0 });

    await runAiMemoryMigrations(createMockPool());

    assert.deepEqual(insertedPgmigrationNames(), []);
    assert.equal(runnerMock.mock.callCount(), 1);
  });

  it('treats a missing legacy ai_memory_migrations table as a fresh database', async () => {
    resetMocks();
    installQueryHandler({ legacyFinalMigrationApplied: false, legacyMigrationTableExists: false, newTrackingCount: 0 });

    await runAiMemoryMigrations(createMockPool());

    assert.deepEqual(insertedPgmigrationNames(), []);
    assert.equal(runnerMock.mock.callCount(), 1);
  });

  it('does not seed migration tracking when node-pg-migrate already has run records', async () => {
    resetMocks();
    installQueryHandler({ legacyFinalMigrationApplied: true, newTrackingCount: 1 });

    await runAiMemoryMigrations(createMockPool());

    assert.deepEqual(insertedPgmigrationNames(), []);
    assert.equal(runnerMock.mock.callCount(), 1);
  });

  it('writes migration log lines to stderr, never stdout, so MCP stdio JSON-RPC framing is not corrupted', async () => {
    resetMocks();
    installQueryHandler({ legacyFinalMigrationApplied: false, newTrackingCount: 0 });

    await runAiMemoryMigrations(createMockPool());

    const options = runnerMock.mock.calls[0]?.arguments[0];
    assert.ok(options);
    const logger = options.logger as {
      debug: (message: unknown) => void;
      error: (message: unknown) => void;
      info: (message: unknown) => void;
      warn: (message: unknown) => void;
    };
    assert.ok(logger);

    const stdoutWrite = mock.method(process.stdout, 'write', () => true);
    const stderrWrite = mock.method(process.stderr, 'write', () => true);
    try {
      logger.debug("Can't determine timestamp for 001");
      logger.info('No migrations to run!');
      logger.warn('example warning');
      logger.error('example error');
    } finally {
      stdoutWrite.mock.restore();
      stderrWrite.mock.restore();
    }

    assert.equal(stdoutWrite.mock.callCount(), 0, 'migration logger must never write to stdout');
    assert.equal(stderrWrite.mock.callCount(), 4);
  });
});
