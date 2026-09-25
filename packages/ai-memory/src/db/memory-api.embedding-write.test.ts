import type { DbClient, DbResult } from './pool.js';

import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { afterEach, beforeEach, test } from 'vitest';

import { probeCapabilities, resetCapabilitiesForTests } from './capabilities.js';
import { resetEmbeddingProvider } from './embeddings.js';
import { storeMemory } from './memory-api.js';
import { pool } from './runtime.js';

const EMBEDDING_VECTOR = [0.11, 0.22, 0.33];
const ENV_KEYS = [
  'AI_MEMORY_EMBEDDING_API_KEY',
  'AI_MEMORY_EMBEDDING_MODEL',
  'AI_MEMORY_EMBEDDING_PROVIDER',
  'AI_MEMORY_LOG_STDERR',
] as const;

type EnvKey = (typeof ENV_KEYS)[number];
type EnvSnapshot = Record<EnvKey, string | undefined>;
type PoolConnect = typeof pool.connect;

interface QueryCall {
  params: readonly unknown[];
  sql: string;
}

const MEMORY_ROW = {
  agent: 'codex-builder',
  calibrated_confidence: 0.8,
  category: 'implementation-note',
  confidence: 0.8,
  content: 'MCP plugin write path should store a non-null embedding vector.',
  created_at: new Date('2026-04-30T00:00:00.000Z'),
  declared_confidence: 0.8,
  dedupe_hash: 'sha256:test-memory-embedding',
  embedding: EMBEDDING_VECTOR,
  evidence_refs: [],
  expires_at: null,
  id: 914,
  importance: 0.47,
  memory_key: null,
  memory_type: 'episodic',
  metadata_json: {},
  model: null,
  org_id: null,
  project: null,
  repo_id: null,
  repo_slug: null,
  sensitivity: 'internal',
  session_id: null,
  source: 'codex',
  status: 'active',
  supersedes_id: null,
  tags: [],
  thread_id: null,
  tool: 'memory_store',
  updated_at: new Date('2026-04-30T00:00:00.000Z'),
  updated_by: null,
  user_id: null,
};

let savedEnv: EnvSnapshot;
let savedFetch: typeof globalThis.fetch;
let savedConnect: PoolConnect;

beforeEach(() => {
  savedEnv = snapshotEnv();
  savedFetch = globalThis.fetch;
  savedConnect = pool.connect.bind(pool);
  resetCapabilitiesForTests();
  resetEmbeddingProvider();
});

afterEach(() => {
  restoreEnv(savedEnv);
  globalThis.fetch = savedFetch;
  pool.connect = savedConnect;
  resetCapabilitiesForTests();
  resetEmbeddingProvider();
  mock.restoreAll();
});

test('memory_store write path inserts a non-null embedding when plugin env contains valid embedding keys', async () => {
  setEnv({
    AI_MEMORY_EMBEDDING_API_KEY: 'sk-test',
    AI_MEMORY_EMBEDDING_MODEL: 'text-embedding-3-small',
    AI_MEMORY_EMBEDDING_PROVIDER: 'openai',
    AI_MEMORY_LOG_STDERR: '0',
  });
  globalThis.fetch = mock.fn(() =>
    Promise.resolve(new Response(JSON.stringify({ data: [{ embedding: EMBEDDING_VECTOR }] }), { status: 200 })),
  );

  await probeCapabilities({
    query(sql: string) {
      if (sql.includes('information_schema.columns')) {
        return Promise.resolve({ rows: [{ exists: true }] });
      }
      if (sql.includes('pg_extension')) {
        return Promise.resolve({ rows: [{ extname: 'vector' }, { extname: 'pg_trgm' }] });
      }
      return Promise.resolve({ rows: [] });
    },
  });

  const client = createMemoryStoreClient();
  pool.connect = () => Promise.resolve(client);

  const memory = await storeMemory({
    agent: 'codex-builder',
    category: 'implementation-note',
    confidence: 0.8,
    content: 'MCP plugin write path should store a non-null embedding vector.',
    source: 'codex',
    tool: 'memory_store',
  });

  const insertCall = client.calls.find(call => call.sql.includes('INSERT INTO ai_memory_entries'));
  assert.ok(insertCall !== undefined, 'expected ai_memory_entries insert');
  assert.equal(insertCall.params[28], JSON.stringify(EMBEDDING_VECTOR));
  assert.deepEqual(memory.embedding, EMBEDDING_VECTOR);
});

interface MockDbClient extends DbClient {
  calls: QueryCall[];
}

function createMemoryStoreClient(): MockDbClient {
  const calls: QueryCall[] = [];
  return {
    calls,
    query<T>(sql: string, params: unknown[] = []): Promise<DbResult<T>> {
      calls.push({ params, sql });

      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.startsWith('SET LOCAL statement_timeout')) {
        return resolveRows<T>([]);
      }

      if (sql.includes('write_calibration')) {
        return resolveRows<T>([]);
      }

      if (sql.includes('pg_advisory_xact_lock')) {
        return resolveRows<T>([]);
      }

      if (sql.includes('SELECT id, content') && sql.includes("status = 'active'")) {
        return resolveRows<T>([]);
      }

      if (sql.includes('SELECT id') && sql.includes('dedupe_hash')) {
        return resolveRows<T>([]);
      }

      if (sql.includes('INSERT INTO ai_memory_events')) {
        return resolveRows<T>([]);
      }

      if (sql.includes('INSERT INTO ai_memory_entries')) {
        return resolveRows<T>([MEMORY_ROW]);
      }

      throw new Error(`Unexpected query in memory_store embedding test: ${sql}`);
    },
    release() {},
  };
}

function resolveRows<T>(rows: unknown[]): Promise<DbResult<T>> {
  return Promise.resolve({ rowCount: rows.length, rows: rows as T[] });
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
}

function setEnv(overrides: Partial<EnvSnapshot>): void {
  for (const [key, value] of Object.entries(overrides) as [EnvKey, string | undefined][]) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
}

function snapshotEnv(): EnvSnapshot {
  return {
    AI_MEMORY_EMBEDDING_API_KEY: process.env.AI_MEMORY_EMBEDDING_API_KEY,
    AI_MEMORY_EMBEDDING_MODEL: process.env.AI_MEMORY_EMBEDDING_MODEL,
    AI_MEMORY_EMBEDDING_PROVIDER: process.env.AI_MEMORY_EMBEDDING_PROVIDER,
    AI_MEMORY_LOG_STDERR: process.env.AI_MEMORY_LOG_STDERR,
  };
}
