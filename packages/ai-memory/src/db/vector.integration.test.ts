import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'vitest';

import {
  assertLocalDatabaseUrl,
  closePool,
  getCapabilities,
  initializeDatabase,
  resetEmbeddingProvider,
  searchMemories,
  storeMemory,
} from '@aviaratech/ai-memory/internal';
import { Pool } from 'pg';

const databaseUrl = process.env.AI_MEMORY_DATABASE_URL;
const vector = (index: number) => Array.from({ length: 1536 }, (_, position) => Number(position === index));

test('pgvector memory write and search round trip', { skip: databaseUrl === undefined }, async () => {
  assert.ok(databaseUrl);
  assertLocalDatabaseUrl(databaseUrl);
  const project = `ci/vector-${randomUUID()}`;
  const targetContent = 'Synthetic forest canopy sample';
  const decoyContent = 'Synthetic harbor tide sample';
  const query = 'orbital violet lookup';
  const originalFetch = globalThis.fetch;
  const originalProvider = process.env.AI_MEMORY_EMBEDDING_PROVIDER;
  const originalKey = process.env.AI_MEMORY_EMBEDDING_API_KEY;
  const verificationPool = new Pool({ connectionString: databaseUrl });
  let databaseReady = false;

  try {
    await initializeDatabase();
    databaseReady = true;
    assert.deepEqual(getCapabilities(), {
      hasEmbeddingColumn: true,
      hasTrigram: true,
      hasVector: true,
    });
    console.log('PostgreSQL vector, embedding column, and pg_trgm capabilities available');

    process.env.AI_MEMORY_EMBEDDING_PROVIDER = 'openai';
    process.env.AI_MEMORY_EMBEDDING_API_KEY = 'synthetic-local-fixture';
    resetEmbeddingProvider();
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string };
      assert.ok([targetContent, decoyContent, query].includes(body.input));
      return new Response(JSON.stringify({ data: [{ embedding: vector(body.input === decoyContent ? 1 : 0) }] }), {
        status: 200,
      });
    };

    const target = await storeMemory({
      category: 'implementation-note',
      confidence: 0.8,
      content: targetContent,
      project,
      source: 'integration-test',
    });
    await storeMemory({
      category: 'implementation-note',
      confidence: 0.8,
      content: decoyContent,
      project,
      source: 'integration-test',
    });
    const stored = await verificationPool.query<{ distance: number }>(
      'SELECT embedding <=> $2::vector AS distance FROM ai_memory_entries WHERE id = $1',
      [target.id, JSON.stringify(vector(0))],
    );
    assert.equal(stored.rows[0]?.distance, 0);

    const withoutVector = await searchMemories({ includeEmbedding: false, project, query });
    assert.deepEqual(withoutVector, []);
    const results = await searchMemories({ project, query });
    assert.equal(results[0]?.id, target.id);
    console.log('Synthetic vector write/search round trip returned the nearest memory');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalProvider === undefined) delete process.env.AI_MEMORY_EMBEDDING_PROVIDER;
    else process.env.AI_MEMORY_EMBEDDING_PROVIDER = originalProvider;
    if (originalKey === undefined) delete process.env.AI_MEMORY_EMBEDDING_API_KEY;
    else process.env.AI_MEMORY_EMBEDDING_API_KEY = originalKey;
    resetEmbeddingProvider();
    try {
      if (databaseReady) await verificationPool.query('DELETE FROM ai_memory_entries WHERE project = $1', [project]);
    } finally {
      await verificationPool.end();
      await closePool();
    }
  }
});
