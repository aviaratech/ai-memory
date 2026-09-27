#!/usr/bin/env node

import { closePool, searchMemories, storeMemory } from '@aviaratech/ai-memory';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

// Runs only after restoring to a newly created disposable database.
async function main() {
  const url = process.env.AI_MEMORY_DATABASE_URL;
  let target: URL;
  try {
    target = new URL(url ?? '');
  } catch {
    throw new Error('restore smoke requires a new ai_memory_restore_* database');
  }
  if (
    !['postgres:', 'postgresql:'].includes(target.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
    !/^\/ai_memory_restore_[a-z0-9_]+$/u.test(target.pathname) ||
    [...target.searchParams].some(([key, value]) => key !== 'sslmode' || value !== 'disable')
  ) {
    throw new Error('restore smoke requires a new ai_memory_restore_* database');
  }
  process.env.AI_MEMORY_EMBEDDING_PROVIDER = 'none';
  const marker = `recovery${randomUUID().replaceAll('-', '')}`;
  const project = 'recovery/synthetic';
  let id: number | undefined;
  try {
    const stored = await storeMemory({
      category: 'implementation-note',
      confidence: 0.8,
      content: `Synthetic recovery search marker ${marker}`,
      project,
      source: 'recovery-smoke',
    });
    id = stored.id;
    const results = await searchMemories({ query: marker, project, includeEmbedding: false, limit: 8 });
    if (!results.some(memory => memory.id === id)) throw new Error('restored memory search missed synthetic write');
  } finally {
    await closePool();
    if (id !== undefined) {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        await client.query('DELETE FROM ai_memory_entries WHERE id = $1', [id]);
      } finally {
        await client.end();
      }
    }
  }
}

void main().then(
  () => {
    process.stdout.write('restore smoke passed\n');
  },
  () => {
    process.stderr.write('restore smoke failed\n');
    process.exitCode = 1;
  },
);
