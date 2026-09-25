import type { QueryResult, QueryResultRow } from 'pg';

import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { afterEach, beforeEach, describe, it } from 'vitest';

import { resetCapabilitiesForTests } from './capabilities.js';
import { resetEmbeddingProvider } from './embeddings.js';
import { buildTokenFallbackQuery, recallMemories, searchMemories } from './memory-api.js';
import { mockPoolConnect } from './test-pool-mock.js';

const ENV_KEYS = [
  'AI_MEMORY_DB_READ_TIMEOUT_MS',
  'AI_MEMORY_EMBEDDING_API_KEY',
  'AI_MEMORY_EMBEDDING_MODEL',
  'AI_MEMORY_EMBEDDING_PROVIDER',
] as const;
const MEMORY_TYPE_FILTER_SQL_SNIPPET = 'memory_type = $';

type EnvKey = (typeof ENV_KEYS)[number];
type EnvSnapshot = Record<EnvKey, string | undefined>;

function createMemoryRow(overrides: Record<string, unknown> = {}) {
  return {
    category: 'decision',
    confidence: 0.8,
    content: 'Memory row for memory_type filter tests.',
    created_at: new Date('2026-02-22T00:00:00.000Z'),
    dedupe_hash: 'sha256:test',
    evidence_refs: [],
    id: 1,
    keyword_hint: 1,
    memory_key: null,
    memory_type: 'episodic',
    metadata_json: {},
    or_semantic_relevance: 0.4,
    project: 'example/catalog',
    semantic_relevance: 0.4,
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

function snapshotEnv(): EnvSnapshot {
  return {
    AI_MEMORY_DB_READ_TIMEOUT_MS: process.env.AI_MEMORY_DB_READ_TIMEOUT_MS,
    AI_MEMORY_EMBEDDING_API_KEY: process.env.AI_MEMORY_EMBEDDING_API_KEY,
    AI_MEMORY_EMBEDDING_MODEL: process.env.AI_MEMORY_EMBEDDING_MODEL,
    AI_MEMORY_EMBEDDING_PROVIDER: process.env.AI_MEMORY_EMBEDDING_PROVIDER,
  };
}

describe('memory_type retrieval filters', () => {
  let savedEnv: EnvSnapshot;

  beforeEach(() => {
    savedEnv = snapshotEnv();
    process.env.AI_MEMORY_EMBEDDING_PROVIDER = 'none';
    process.env.AI_MEMORY_EMBEDDING_API_KEY = '';
    process.env.AI_MEMORY_EMBEDDING_MODEL = '';
    resetCapabilitiesForTests();
    resetEmbeddingProvider();
  });

  afterEach(() => {
    restoreEnv(savedEnv);
    resetCapabilitiesForTests();
    resetEmbeddingProvider();
    mock.restoreAll();
  });

  it('recallMemories applies memoryType filter and returns memory_type fields', async () => {
    const capturedQueries: { params: readonly unknown[]; sql: string }[] = [];
    mockPoolConnect((sql: string, params?: readonly unknown[]) => {
      capturedQueries.push({ params: params ?? [], sql });
      const result: QueryResult<QueryResultRow> = {
        command: 'SELECT',
        fields: [],
        oid: 0,
        rowCount: 1,
        rows: [createMemoryRow({ memory_type: 'episodic' })],
      };
      return Promise.resolve(result);
    });

    const memories = await recallMemories({ limit: 5, memoryType: 'episodic' });
    const recallQuery = capturedQueries[0];

    assert.ok(recallQuery !== undefined, 'expected recall query to be captured');
    assert.ok(
      recallQuery.sql.includes(MEMORY_TYPE_FILTER_SQL_SNIPPET),
      'expected recall SQL to include memory_type filter',
    );
    assert.ok(recallQuery.params.includes('episodic'));
    assert.equal(memories.length, 1);
    const firstMemory = memories[0];
    assert.ok(firstMemory !== undefined);
    assert.equal(firstMemory.memoryType, 'episodic');
    assert.equal(firstMemory.memory_type, 'episodic');
  });

  it('recallMemories does not force a memoryType filter when omitted', async () => {
    const capturedQueries: string[] = [];
    mockPoolConnect((sql: string) => {
      capturedQueries.push(sql);
      const result: QueryResult<QueryResultRow> = {
        command: 'SELECT',
        fields: [],
        oid: 0,
        rowCount: 1,
        rows: [createMemoryRow()],
      };
      return Promise.resolve(result);
    });

    const memories = await recallMemories({ limit: 5 });
    const recallQuery = capturedQueries[0] ?? '';

    assert.ok(
      !recallQuery.includes(MEMORY_TYPE_FILTER_SQL_SNIPPET),
      'recall SQL should not filter memory_type by default',
    );
    assert.equal(memories.length, 1);
    const firstMemory = memories[0];
    assert.ok(firstMemory !== undefined);
    assert.equal(firstMemory.memoryType, 'episodic');
    assert.equal(firstMemory.memory_type, 'episodic');
  });

  it('searchMemories applies memoryType filter when provided', async () => {
    const capturedQueries: { params: readonly unknown[]; sql: string }[] = [];
    mockPoolConnect((sql: string, params?: readonly unknown[]) => {
      capturedQueries.push({ params: params ?? [], sql });
      const result: QueryResult<QueryResultRow> = {
        command: 'SELECT',
        fields: [],
        oid: 0,
        rowCount: 1,
        rows: [createMemoryRow({ memory_type: 'semantic' })],
      };
      return Promise.resolve(result);
    });

    const memories = await searchMemories({
      limit: 5,
      memoryType: 'semantic',
      query: 'type filter query',
    });
    const searchQuery = capturedQueries[0];

    assert.ok(searchQuery !== undefined, 'expected search query to be captured');
    assert.ok(
      searchQuery.sql.includes(MEMORY_TYPE_FILTER_SQL_SNIPPET),
      'expected search SQL to include memory_type filter',
    );
    assert.ok(searchQuery.params.includes('semantic'));
    assert.equal(memories.length, 1);
    assert.equal(memories[0]?.memoryType, 'semantic');
  });

  it('searchMemories applies an exact sessionId filter for lead-scoped recovery', async () => {
    const capturedQueries: { params: readonly unknown[]; sql: string }[] = [];
    mockPoolConnect((sql: string, params?: readonly unknown[]) => {
      capturedQueries.push({ params: params ?? [], sql });
      const result: QueryResult<QueryResultRow> = {
        command: 'SELECT',
        fields: [],
        oid: 0,
        rowCount: 1,
        rows: [createMemoryRow({ session_id: 'lead-session-2930' })],
      };
      return Promise.resolve(result);
    });

    await searchMemories({
      limit: 5,
      project: 'example/catalog',
      query: 'current lead checkpoint',
      sessionId: 'lead-session-2930',
    });

    const searchQuery = capturedQueries[0];
    assert.ok(searchQuery !== undefined, 'expected search query to be captured');
    assert.ok(searchQuery.sql.includes('session_id = $'), 'expected search SQL to filter the exact session id');
    assert.ok(searchQuery.params.includes('lead-session-2930'));
  });

  it('buildTokenFallbackQuery includes memoryType condition when provided', () => {
    const { params, sql } = buildTokenFallbackQuery({
      category: undefined,
      includeInactive: false,
      limit: 5,
      memoryType: 'procedural',
      project: 'example/catalog',
      tokens: ['workflow'],
    });

    assert.ok(sql.includes(MEMORY_TYPE_FILTER_SQL_SNIPPET), 'fallback SQL should include memory_type condition');
    assert.ok(params.includes('procedural'));
  });

  it('recallMemories surfaces a phase-attributed TimeoutError when the server cancels the read', async () => {
    process.env.AI_MEMORY_DB_READ_TIMEOUT_MS = '20';
    mockPoolConnect(() => {
      const err = new Error('canceling statement due to statement timeout') as Error & { code: string };
      err.code = '57014';
      return Promise.reject(err);
    });

    await assert.rejects(recallMemories({ limit: 5 }), /db\.read\.recall_memories timed out after 20ms/u);
  });
});
