import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'vitest';

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
        await closePool();
      }
    }
  },
);
