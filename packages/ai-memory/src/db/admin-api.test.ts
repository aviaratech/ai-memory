import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { test, vi } from 'vitest';

type QueryFn = (sql: string, params?: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
type RunMigrationsFn = (pool: unknown) => Promise<void>;

const originalAiMemoryDatabaseUrl = process.env.AI_MEMORY_DATABASE_URL;
const mockQuery = mock.fn<QueryFn>((sql: string) => {
  if (sql.includes('ai_memory_entries_embedding_hnsw_idx')) {
    return Promise.resolve({ rows: [{ exists: true }] });
  }
  return Promise.resolve({ rows: [] });
});
const mockRelease = mock.fn(() => undefined);
const mockClient = { query: mockQuery, release: mockRelease };
const mockPool = {
  connect: mock.fn(() => Promise.resolve(mockClient)),
  end: mock.fn(() => Promise.resolve()),
};
const runAiMemoryMigrationsMock = mock.fn<RunMigrationsFn>(() => Promise.resolve());

process.env.AI_MEMORY_DATABASE_URL = 'postgres://user:pass@localhost:5432/ai_memory_test';

vi.doMock('./pool.js', () => ({
  assertLocalDatabaseUrl: (value: string) => value,
  createPool: mock.fn(() => mockPool),
  redactDatabaseUrl: (value: unknown) => String(value),
}));

vi.doMock('./capabilities.js', () => ({
  probeCapabilities: mock.fn(() =>
    Promise.resolve({
      hasEmbeddingColumn: true,
      hasTrigram: true,
      hasVector: true,
    }),
  ),
}));

vi.doMock('./run-migrations.js', () => ({
  runAiMemoryMigrations: runAiMemoryMigrationsMock,
}));

const { initializeDatabase } = await import('./admin-api.js');

test('initializeDatabase delegates schema changes to node-pg-migrate runner before capability probes', async () => {
  try {
    await initializeDatabase();
  } finally {
    if (originalAiMemoryDatabaseUrl === undefined) {
      delete process.env.AI_MEMORY_DATABASE_URL;
    } else {
      process.env.AI_MEMORY_DATABASE_URL = originalAiMemoryDatabaseUrl;
    }
  }

  assert.equal(runAiMemoryMigrationsMock.mock.callCount(), 1);
  const migrationPool = runAiMemoryMigrationsMock.mock.calls[0]?.arguments[0] as
    | undefined
    | { connect?: unknown; end?: unknown; query?: unknown };
  assert.equal(typeof migrationPool?.connect, 'function');
  assert.equal(typeof migrationPool?.end, 'function');
  assert.equal(typeof migrationPool?.query, 'function');
  assert.equal(mockPool.connect.mock.callCount(), 1);
  assert.equal(mockRelease.mock.callCount(), 1);
  assert.ok(
    mockQuery.mock.calls.every(call => !call.arguments[0].includes('ai_memory_migrations')),
    'initializeDatabase must not run the legacy custom migration loop',
  );
});
