import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'vitest';

import { assertLocalDatabaseUrl, closePool, initializeDatabase } from '@aviaratech/ai-memory/internal';
import { Pool } from 'pg';

const databaseUrl = process.env.AI_MEMORY_DATABASE_URL;
const run = promisify(execFile);

test(
  'both actual harness smokes leave table contents unchanged after fixture cleanup',
  {
    skip: databaseUrl === undefined,
    timeout: 0,
  },
  async () => {
    assert.ok(databaseUrl);
    assertLocalDatabaseUrl(databaseUrl);
    const pool = new Pool({ connectionString: databaseUrl });
    const sessionId = `synthetic-original-${randomUUID()}`;
    const deltaId = `synthetic-original-delta-${randomUUID()}`;
    const orphanId = `synthetic-original-orphan-${randomUUID()}`;
    try {
      await initializeDatabase();
      await pool.query('INSERT INTO ai_sessions (session_id, agent) VALUES ($1, $2)', [
        sessionId,
        'synthetic-original',
      ]);
      for (const [id, session] of [
        [deltaId, sessionId],
        [orphanId, null],
      ]) {
        await pool.query(
          `INSERT INTO ai_memory_deltas
          (delta_id, session_id, produced_by_agent, snapshot_mode, snapshot_json, raw_json, created_at)
          VALUES ($1, $2, 'synthetic-original', 'replace', '{}', '{}', '2026-01-01T00:00:00Z')`,
          [id, session],
        );
      }
      const tables = await pool.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'ai_%' ORDER BY tablename",
      );
      const snapshot = async () => {
        const contents: Record<string, unknown> = {};
        for (const { tablename } of tables.rows) {
          assert.match(tablename, /^ai_[a-z_]+$/u);
          const result = await pool.query<{ content: unknown }>(
            `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS content FROM "${tablename}" t`,
          );
          contents[tablename] = result.rows[0]?.content;
        }
        return contents;
      };
      const before = await snapshot();
      const { stdout } = await run(
        process.execPath,
        [fileURLToPath(new URL('../../dist/tools/smoke-ingest.js', import.meta.url))],
        {
          env: { ...process.env, AI_MEMORY_EMBEDDING_PROVIDER: 'none' },
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      const output = JSON.parse(stdout) as {
        claudeHook: { sessionId: string };
        codexWrapper: { sessionId: string };
        status: string;
        verification: Record<string, { memoryDeltas: number }>;
      };
      assert.equal(output.status, 'ok');
      assert.ok((output.verification[output.claudeHook.sessionId]?.memoryDeltas ?? 0) > 0);
      assert.ok((output.verification[output.codexWrapper.sessionId]?.memoryDeltas ?? 0) > 0);
      assert.deepEqual(await snapshot(), before);
    } finally {
      try {
        await pool.query('DELETE FROM ai_memory_deltas WHERE delta_id = ANY($1::text[])', [[deltaId, orphanId]]);
        await pool.query('DELETE FROM ai_sessions WHERE session_id = $1', [sessionId]);
      } finally {
        await pool.end();
        await closePool();
      }
    }
  },
);
