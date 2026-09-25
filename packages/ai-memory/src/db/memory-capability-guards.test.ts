import type { QueryResult, QueryResultRow } from 'pg';

import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { afterEach, beforeEach, describe, it } from 'vitest';

import { probeCapabilities, resetCapabilitiesForTests } from './capabilities.js';
import { resetEmbeddingProvider } from './embeddings.js';
import { searchMemories } from './memory-api.js';
import { storeMemoryWithClient } from './memory-store.js';
import { pool } from './runtime.js';

const ENV_KEYS = ['AI_MEMORY_EMBEDDING_PROVIDER', 'AI_MEMORY_EMBEDDING_API_KEY', 'AI_MEMORY_EMBEDDING_MODEL'] as const;

type EnvKey = (typeof ENV_KEYS)[number];
type EnvSnapshot = Record<EnvKey, string | undefined>;

function createStoredRow(overrides: Record<string, unknown> = {}) {
  return {
    category: 'decision',
    confidence: 0.85,
    content: 'Capability-guarded memory write row',
    created_at: new Date('2026-02-22T00:00:00.000Z'),
    dedupe_hash: 'sha256:test',
    evidence_refs: [],
    id: 11,
    memory_key: 'test:memory',
    metadata_json: {},
    project: 'example/catalog',
    source: 'codex-test',
    status: 'active',
    tags: [],
    updated_at: new Date('2026-02-22T00:00:00.000Z'),
    ...overrides,
  };
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      process.env[key] = '';
    } else {
      process.env[key] = value;
    }
  }
}

async function setCapabilitiesWithEmbeddingColumn() {
  await probeCapabilities({
    query(sql: string) {
      if (sql.includes('information_schema.columns')) {
        return Promise.resolve({ rows: [{ exists: true }] });
      }
      if (sql.includes('FROM pg_extension')) {
        return Promise.resolve({
          rows: [{ extname: 'vector' }, { extname: 'pg_trgm' }],
        });
      }
      return Promise.reject(new Error(`Unexpected SQL: ${sql}`));
    },
  });
}

async function setCapabilitiesWithoutEmbeddingColumn() {
  await probeCapabilities({
    query(sql: string) {
      if (sql.includes('information_schema.columns')) {
        return Promise.resolve({ rows: [{ exists: false }] });
      }
      if (sql.includes('FROM pg_extension')) {
        return Promise.resolve({
          rows: [{ extname: 'vector' }, { extname: 'pg_trgm' }],
        });
      }
      return Promise.reject(new Error(`Unexpected SQL: ${sql}`));
    },
  });
}

function setEnv(values: Partial<EnvSnapshot>): void {
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value ?? '';
  }
}

function snapshotEnv(): EnvSnapshot {
  return {
    AI_MEMORY_EMBEDDING_API_KEY: process.env.AI_MEMORY_EMBEDDING_API_KEY,
    AI_MEMORY_EMBEDDING_MODEL: process.env.AI_MEMORY_EMBEDDING_MODEL,
    AI_MEMORY_EMBEDDING_PROVIDER: process.env.AI_MEMORY_EMBEDDING_PROVIDER,
  };
}

describe('memory capability guards', () => {
  let savedEnv: EnvSnapshot;
  let savedFetch: typeof globalThis.fetch;

  beforeEach(() => {
    savedEnv = snapshotEnv();
    savedFetch = globalThis.fetch;
    resetCapabilitiesForTests();
    resetEmbeddingProvider();
  });

  afterEach(() => {
    restoreEnv(savedEnv);
    globalThis.fetch = savedFetch;
    resetCapabilitiesForTests();
    resetEmbeddingProvider();
    mock.restoreAll();
  });

  it('searchMemories skips embedding lookup and vector CTE when embedding column is absent', async () => {
    setEnv({
      AI_MEMORY_EMBEDDING_API_KEY: 'sk-test',
      AI_MEMORY_EMBEDDING_PROVIDER: 'openai',
    });

    const fetchMock = mock.fn((input: Request | string | URL, init?: RequestInit) => {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ embedding: [0.1, 0.2] }],
            meta: { hasInit: init !== undefined, requestUrl: String(input) },
          }),
          { status: 200 },
        ),
      );
    });
    globalThis.fetch = fetchMock;

    await setCapabilitiesWithoutEmbeddingColumn();

    const capturedSql: string[] = [];
    mock.method(pool, 'connect', () =>
      Promise.resolve({
        query: (sql: string) => {
          capturedSql.push(sql);
          const result: QueryResult<QueryResultRow> = {
            command: 'SELECT',
            fields: [],
            oid: 0,
            rowCount: 1,
            rows: [createStoredRow()],
          };
          return Promise.resolve(result);
        },
        release: () => undefined,
      }),
    );

    const result = await searchMemories({
      limit: 5,
      query: 'capability guard query',
    });

    assert.equal(result.length, 1);
    const searchSql = capturedSql.find((sql: string) => sql.includes('WITH filtered_candidates'));
    assert.ok(searchSql !== undefined, 'expected memory_search SQL');
    assert.ok(!searchSql.includes('vector_candidates'));
    assert.ok(!searchSql.includes('embedding <=>'));
    assert.equal(fetchMock.mock.calls.length, 0);
  });

  it('searchMemories uses vector CTE when embedding provider and column are available', async () => {
    setEnv({
      AI_MEMORY_EMBEDDING_API_KEY: 'sk-test',
      AI_MEMORY_EMBEDDING_PROVIDER: 'openai',
    });

    const fetchMock = mock.fn(() => {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ embedding: [0.1, 0.2] }],
          }),
          { status: 200 },
        ),
      );
    });
    globalThis.fetch = fetchMock;

    await setCapabilitiesWithEmbeddingColumn();

    const capturedSql: string[] = [];
    mock.method(pool, 'connect', () =>
      Promise.resolve({
        query: (sql: string) => {
          capturedSql.push(sql);
          const result: QueryResult<QueryResultRow> = {
            command: 'SELECT',
            fields: [],
            oid: 0,
            rowCount: 1,
            rows: [createStoredRow()],
          };
          return Promise.resolve(result);
        },
        release: () => undefined,
      }),
    );

    const result = await searchMemories({
      limit: 5,
      query: 'capability guard query',
    });

    assert.equal(result.length, 1);
    const searchSql = capturedSql.find((sql: string) => sql.includes('WITH filtered_candidates'));
    assert.ok(searchSql !== undefined, 'expected memory_search SQL');
    assert.ok(searchSql.includes('vector_candidates'));
    assert.ok(searchSql.includes('embedding <=>'));
    assert.equal(fetchMock.mock.calls.length, 1);
  });

  it('searchMemories skips embedding and vector work when the caller disables embedding', async () => {
    setEnv({
      AI_MEMORY_EMBEDDING_API_KEY: 'sk-test',
      AI_MEMORY_EMBEDDING_PROVIDER: 'openai',
    });

    const fetchMock = mock.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ embedding: [0.1, 0.2] }],
          }),
          { status: 200 },
        ),
      ),
    );
    globalThis.fetch = fetchMock;

    await setCapabilitiesWithEmbeddingColumn();

    const capturedSql: string[] = [];
    mock.method(pool, 'connect', () =>
      Promise.resolve({
        query: (sql: string) => {
          capturedSql.push(sql);
          const result: QueryResult<QueryResultRow> = {
            command: 'SELECT',
            fields: [],
            oid: 0,
            rowCount: 1,
            rows: [createStoredRow()],
          };
          return Promise.resolve(result);
        },
        release: () => undefined,
      }),
    );

    const result = await searchMemories({
      includeEmbedding: false,
      limit: 5,
      query: 'lexical implication query',
    });

    assert.equal(result.length, 1);
    const searchSql = capturedSql.find((sql: string) => sql.includes('WITH filtered_candidates'));
    assert.ok(searchSql !== undefined, 'expected memory_search SQL');
    assert.ok(!searchSql.includes('vector_candidates'));
    assert.ok(!searchSql.includes('embedding <=>'));
    assert.equal(fetchMock.mock.calls.length, 0);
  });

  it('storeMemoryWithClient succeeds without embedding column and drops embedding param', async () => {
    await setCapabilitiesWithoutEmbeddingColumn();

    const capturedCalls: {
      params: readonly unknown[] | undefined;
      sql: string;
    }[] = [];
    const client: Parameters<typeof storeMemoryWithClient>[0] = {
      query<Row extends QueryResultRow = QueryResultRow>(sql: string, params?: readonly unknown[]) {
        capturedCalls.push({ params, sql });
        const result: QueryResult<Row> = {
          command: 'INSERT',
          fields: [],
          oid: 0,
          rowCount: 0,
          rows: [],
        };
        return Promise.resolve(result);
      },
    };

    const memory = await storeMemoryWithClient(client, {
      category: 'decision',
      content: 'Store path should not reference embedding when column is absent.',
      embedding: [0.33, 0.44],
      memoryKey: 'test:capability-guard',
      source: 'codex-test',
    });

    assert.equal(memory.writeDisposition, 'keyed_upsert');
    assert.equal(capturedCalls.length, 2);

    const writeCall = capturedCalls.find(call => call.sql.includes('ON CONFLICT (memory_key)'));
    assert.ok(writeCall !== undefined);
    assert.ok(writeCall.sql.includes('ON CONFLICT (memory_key)'));
    assert.ok(!writeCall.sql.includes('embedding'));
    assert.equal(writeCall.params?.length, 28);
  });
});
