import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, test } from 'vitest';

import {
  assertLocalDatabaseUrl,
  closePool,
  initializeDatabase,
  recallMemories,
  searchMemories,
  storeMemory,
} from '@aviaratech/ai-memory/internal';
import { Pool } from 'pg';

const databaseUrl = process.env.AI_MEMORY_DATABASE_URL;
const EDITED_AT = '2026-01-02T03:04:05.000Z';

afterAll(async () => {
  await closePool();
});

test(
  'knowledge search excludes unkeyed session noise but preserves keyed facts and exact-session history',
  { skip: databaseUrl === undefined },
  async () => {
    assert.ok(databaseUrl);
    assertLocalDatabaseUrl(databaseUrl);
    const verificationPool = new Pool({ connectionString: databaseUrl });
    const project = `ci/knowledge-${randomUUID()}`;
    const session = `session-${randomUUID()}`;
    const ids: number[] = [];
    const expectedKnowledge: number[] = [];
    const fixtures = [
      { category: 'decision', key: null, source: 'manual-flush', tags: [] },
      { category: 'root-cause', key: null, source: 'custom-source', tags: ['memory-flush'] },
      { category: 'session-summary', key: null, source: 'custom-source', tags: [] },
      { category: 'checkpoint', key: null, source: '', tags: [] },
      { category: 'convention', key: `shared:${randomUUID()}`, source: 'manual-flush', tags: ['memory-flush'] },
      { category: 'root-cause', key: null, source: 'durable-fixture', tags: [] },
    ];
    try {
      await initializeDatabase();
      for (const [index, fixture] of fixtures.entries()) {
        const inserted = await verificationPool.query<{ id: string }>(
          `INSERT INTO ai_memory_entries
            (content, project, category, source, tags, memory_key, memory_type, session_id, status)
           VALUES ($1,$2,$3,$4,$5,$6,'episodic',$7,'active') RETURNING id::text`,
          [
            `Synthetic scopeproof fixture ${String(index)}. Keep the keyed fact; do not claim deleted rows.`,
            project,
            fixture.category,
            fixture.source,
            fixture.tags,
            fixture.key,
            session,
          ],
        );
        const id = Number(inserted.rows[0]!.id);
        ids.push(id);
        if (index >= 4) expectedKnowledge.push(id);
      }
      const preserved = await verificationPool.query(
        'SELECT id::text,content,memory_key,status,expires_at,tags FROM ai_memory_entries WHERE id=ANY($1::bigint[]) ORDER BY id',
        [ids],
      );
      const recalled = await recallMemories({ limit: 25, project });
      assert.deepEqual(
        recalled.map(row => row.id).sort((a, b) => a - b),
        expectedKnowledge,
      );
      for (const query of ['scopeproof', 'copeproo']) {
        const knowledge = await searchMemories({ includeEmbedding: false, limit: 25, project, query });
        assert.deepEqual(
          knowledge.map(row => row.id).sort((a, b) => a - b),
          expectedKnowledge,
        );
        const history = await searchMemories({
          includeEmbedding: false,
          limit: 25,
          project,
          query,
          sessionId: session,
        });
        assert.deepEqual(
          history.map(row => row.id).sort((a, b) => a - b),
          ids,
        );
        assert.ok(
          history.every(
            row =>
              typeof row.content === 'string' &&
              row.content.includes('Keep the keyed fact; do not claim deleted rows.'),
          ),
        );
      }
      const after = await verificationPool.query(
        'SELECT id::text,content,memory_key,status,expires_at,tags FROM ai_memory_entries WHERE id=ANY($1::bigint[]) ORDER BY id',
        [ids],
      );
      assert.deepEqual(after.rows, preserved.rows, 'search changes no source bytes, keys, status or expiry');
    } finally {
      try {
        if (ids.length)
          await verificationPool.query('DELETE FROM ai_memory_entries WHERE project=$1 AND id=ANY($2::bigint[])', [
            project,
            ids,
          ]);
      } finally {
        await verificationPool.end();
      }
    }
  },
);

test(
  'search and recall record access time without changing the edit timestamp',
  { skip: databaseUrl === undefined },
  async () => {
    assert.ok(databaseUrl);
    assertLocalDatabaseUrl(databaseUrl);
    const verificationPool = new Pool({ connectionString: databaseUrl });
    const project = `ci/access-${randomUUID()}`;
    const ids: number[] = [];
    const readAccess = async () => {
      const result = await verificationPool.query<{ accessed: Date | null; id: string; updated: Date }>(
        'SELECT id, updated_at AS updated, last_accessed_at AS accessed FROM ai_memory_entries WHERE id = ANY($1::bigint[]) ORDER BY id',
        [ids],
      );
      return result.rows;
    };
    try {
      await initializeDatabase();
      for (const token of ['searched', 'recalled']) {
        const stored = await storeMemory({
          category: 'convention',
          confidence: 0.8,
          content: `Synthetic ${token} lantern harbor convention`,
          project,
          source: 'integration-test',
        });
        ids.push(stored.id);
      }
      await verificationPool.query('UPDATE ai_memory_entries SET updated_at = $2 WHERE id = ANY($1::bigint[])', [
        ids,
        EDITED_AT,
      ]);

      const searched = await searchMemories({ includeEmbedding: false, project, query: 'searched lantern' });
      assert.ok(searched.some(memory => memory.id === ids[0]));
      const recalled = await recallMemories({ limit: 10, project, sinceDays: 30 });
      assert.ok(recalled.some(memory => memory.id === ids[1]));

      // Access is recorded asynchronously after the read returns.
      let rows = await readAccess();
      for (let attempt = 0; attempt < 50 && rows.some(row => row.accessed === null); attempt += 1) {
        await delay(100);
        rows = await readAccess();
      }
      assert.equal(rows.length, 2);
      for (const row of rows) {
        assert.ok(row.accessed !== null, `memory ${row.id} should record its access time`);
        assert.equal(row.updated.toISOString(), EDITED_AT, `memory ${row.id} must keep its edit timestamp`);
      }
    } finally {
      try {
        if (ids.length > 0)
          await verificationPool.query('DELETE FROM ai_memory_entries WHERE id = ANY($1::bigint[])', [ids]);
      } finally {
        await verificationPool.end();
      }
    }
  },
);
