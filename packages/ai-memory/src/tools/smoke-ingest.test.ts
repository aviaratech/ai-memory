import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, vi } from 'vitest';

import type { DbClient, DbPool } from '@aviaratech/ai-memory/internal';
import type * as InternalModuleNamespace from '@aviaratech/ai-memory/internal';

import type * as SmokeIngestModuleNamespace from './smoke-ingest.js';

const FIXTURE_FILES = ['context_pack.json', 'memory_delta.json'] as const;
type SmokeIngestModule = typeof SmokeIngestModuleNamespace;
let smokeIngestModuleLoadCounter = 0;

const cleanupPool = vi.hoisted(() => ({ value: undefined as DbPool | undefined }));
vi.mock('@aviaratech/ai-memory/internal', async importOriginal => ({
  ...(await importOriginal<typeof InternalModuleNamespace>()),
  createPool: () => {
    assert.ok(cleanupPool.value);
    return cleanupPool.value;
  },
}));

function cleanupFixture(failSql?: string) {
  const ownedSessions = ['fixture-contract', 'fixture-claude', 'fixture-codex'];
  const originalRows = [
    { delta_id: 'original-delta', session_id: 'original-session' },
    { delta_id: 'original-orphan', session_id: null },
    { delta_id: 'fixture-claude-lookalike', session_id: 'fixture-claude-unrelated' },
  ];
  const initialRows = [
    ...originalRows,
    { delta_id: 'registered-delta', session_id: null },
    { delta_id: 'contract-delta', session_id: ownedSessions[0] },
    { delta_id: 'unregistered-claude-delta', session_id: ownedSessions[1] },
    { delta_id: 'unregistered-codex-delta', session_id: ownedSessions[2] },
  ];
  let rows = [...initialRows];
  let sessions = [...ownedSessions, 'original-session', 'fixture-claude-unrelated'];
  let released = false;
  const queries: string[] = [];
  const failure = new Error('synthetic cleanup failure');
  const client: DbClient = {
    query(sql, params = []) {
      queries.push(sql);
      if (sql === failSql) return Promise.reject(failure);
      if (sql === 'ROLLBACK') {
        rows = [...initialRows];
        sessions = [...ownedSessions, 'original-session', 'fixture-claude-unrelated'];
      } else if (sql.startsWith('DELETE FROM ai_memory_deltas')) {
        const ids = params[0] as string[];
        rows = rows.filter(row =>
          sql.includes('WHERE delta_id') ? !ids.includes(row.delta_id) : !ids.includes(row.session_id ?? ''),
        );
      } else if (sql.startsWith('DELETE FROM ai_sessions')) {
        const ids = params[0] as string[];
        sessions = sessions.filter(id => !ids.includes(id));
        rows = rows.map(row => (ids.includes(row.session_id ?? '') ? { ...row, session_id: null } : row));
      }
      return Promise.resolve({ rowCount: 0, rows: [] });
    },
    release() {
      released = true;
    },
  };
  const pool: DbPool = {
    connect: () => Promise.resolve(client),
    end: () => Promise.resolve(),
    getClient: () => Promise.resolve(client),
    query: <T>(sql: string, params?: unknown[]) => client.query<T>(sql, params),
  };
  return {
    failure,
    ids: {
      contextPackIds: new Set<string>(),
      deltaIds: new Set(['contract-delta', 'registered-delta']),
      sessionIds: new Set(ownedSessions),
    },
    initialRows,
    originalRows,
    pool,
    queries,
    state: () => ({ released, rows, sessions }),
  };
}

async function withCleanupPool<T>(pool: DbPool, run: (mod: SmokeIngestModule) => Promise<T>): Promise<T> {
  vi.resetModules();
  cleanupPool.value = pool;
  vi.stubEnv('AI_MEMORY_DATABASE_URL', 'postgresql://fixture@127.0.0.1/ai_memory_test');
  try {
    return await run(await loadSmokeIngestModule());
  } finally {
    cleanupPool.value = undefined;
    vi.unstubAllEnvs();
  }
}

test('cleanup removes unregistered harness deltas without changing unrelated rows or sessions', async () => {
  const fixture = cleanupFixture();
  await withCleanupPool(fixture.pool, async mod => {
    await mod.cleanupSmokeData(fixture.ids);
  });
  assert.deepEqual(fixture.state(), {
    released: true,
    rows: fixture.originalRows,
    sessions: ['original-session', 'fixture-claude-unrelated'],
  });
  assert.equal(fixture.queries.at(-1), 'COMMIT');
});

test('cleanup rolls back fixture deletion and releases the connection when a delete fails', async () => {
  const fixture = cleanupFixture('DELETE FROM ai_sessions WHERE session_id = ANY($1::text[])');
  await withCleanupPool(fixture.pool, async mod => {
    await assert.rejects(mod.cleanupSmokeData(fixture.ids), error => error === fixture.failure);
  });
  assert.deepEqual(fixture.state().rows, fixture.initialRows);
  assert.equal(fixture.state().sessions.length, 5);
  assert.equal(fixture.state().released, true);
  assert.equal(fixture.queries.at(-1), 'ROLLBACK');
});

test('cleanup with no owned IDs does not acquire a connection', async () => {
  const fixture = cleanupFixture();
  await withCleanupPool(fixture.pool, async mod => {
    await mod.cleanupSmokeData({ contextPackIds: new Set(), deltaIds: new Set(), sessionIds: new Set() });
  });
  assert.deepEqual(fixture.queries, []);
  assert.equal(fixture.state().released, false);
});

function createFixtureDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-fixture-'));
  for (const fixtureFile of FIXTURE_FILES) {
    writeFileSync(join(dir, fixtureFile), '{}', 'utf8');
  }

  return dir;
}

async function loadSmokeIngestModule(): Promise<SmokeIngestModule> {
  const moduleUrl = new URL(
    `./smoke-ingest.js?cacheBust=${String(Date.now())}-${String(++smokeIngestModuleLoadCounter)}`,
    import.meta.url,
  ).href;
  return (await import(moduleUrl)) as SmokeIngestModule;
}

async function withDbEnvUnset<T>(run: () => Promise<T>): Promise<T> {
  const previous = {
    AI_MEMORY_DATABASE_URL: process.env.AI_MEMORY_DATABASE_URL,
    AVIARA_MEMORY_DATABASE_URL: process.env.AVIARA_MEMORY_DATABASE_URL,
    DATABASE_URL: process.env.DATABASE_URL,
  };

  delete process.env.AI_MEMORY_DATABASE_URL;
  delete process.env.AVIARA_MEMORY_DATABASE_URL;
  delete process.env.DATABASE_URL;

  try {
    return await run();
  } finally {
    if (previous.AI_MEMORY_DATABASE_URL === undefined) {
      delete process.env.AI_MEMORY_DATABASE_URL;
    } else {
      process.env.AI_MEMORY_DATABASE_URL = previous.AI_MEMORY_DATABASE_URL;
    }

    if (previous.AVIARA_MEMORY_DATABASE_URL === undefined) {
      delete process.env.AVIARA_MEMORY_DATABASE_URL;
    } else {
      process.env.AVIARA_MEMORY_DATABASE_URL = previous.AVIARA_MEMORY_DATABASE_URL;
    }

    if (previous.DATABASE_URL === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previous.DATABASE_URL;
    }
  }
}

async function withFixtureEnv<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env.AI_MEMORY_SMOKE_FIXTURE_PATH;

  if (value === undefined) {
    delete process.env.AI_MEMORY_SMOKE_FIXTURE_PATH;
  } else {
    process.env.AI_MEMORY_SMOKE_FIXTURE_PATH = value;
  }

  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.AI_MEMORY_SMOKE_FIXTURE_PATH;
    } else {
      process.env.AI_MEMORY_SMOKE_FIXTURE_PATH = previous;
    }
  }
}

test('smoke-ingest helper module imports without DB env when not executing CLI main', async () => {
  await withDbEnvUnset(async () => {
    const mod = await loadSmokeIngestModule();
    assert.equal(typeof mod.getSmokeContractFixturePath, 'function');
  });
});

test('getSmokeContractFixturePath resolves the repo-local default path when no override is provided', async () => {
  await withFixtureEnv(undefined, async () => {
    const { DEFAULT_SMOKE_FIXTURE_PATH, getSmokeContractFixturePath } = await loadSmokeIngestModule();
    assert.equal(getSmokeContractFixturePath(['node', '/repo/smoke-ingest.ts']), resolve(DEFAULT_SMOKE_FIXTURE_PATH));
  });
});

test('getSmokeContractFixturePath honors --fixture-path command-line argument', async () => {
  const fixturePath = createFixtureDirectory();
  try {
    const { getSmokeContractFixturePath } = await loadSmokeIngestModule();
    assert.equal(
      getSmokeContractFixturePath(['node', 'smoke-ingest.ts', '--fixture-path', fixturePath]),
      resolve(fixturePath),
    );
  } finally {
    rmSync(fixturePath, { force: true, recursive: true });
  }
});

test('getSmokeContractFixturePath uses AI_MEMORY_SMOKE_FIXTURE_PATH when CLI argument is not provided', async () => {
  const fixturePath = createFixtureDirectory();
  try {
    await withFixtureEnv(fixturePath, async () => {
      const { getSmokeContractFixturePath } = await loadSmokeIngestModule();
      assert.equal(getSmokeContractFixturePath(['node', 'smoke-ingest.ts']), resolve(fixturePath));
    });
  } finally {
    rmSync(fixturePath, { force: true, recursive: true });
  }
});

test('getSmokeContractFixturePath validates required fixture files', async () => {
  const fixturePath = createFixtureDirectory();
  rmSync(join(fixturePath, 'memory_delta.json'), { force: true });

  try {
    const { getSmokeContractFixturePath } = await loadSmokeIngestModule();
    assert.throws(() => {
      getSmokeContractFixturePath(['node', 'smoke-ingest.ts', '--fixture-path', fixturePath]);
    }, /fixture file missing/);
  } finally {
    rmSync(fixturePath, { force: true, recursive: true });
  }
});
