import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { Pool } from 'pg';

import { assertLocalDatabaseUrl, closePool, initializeDatabase } from '@aviaratech/ai-memory/internal';

const databaseUrl = process.env.AI_MEMORY_DATABASE_URL;

test(
  'five changing Claude Stops and SessionEnd preserve one correctly attributed session',
  {
    skip: databaseUrl === undefined,
    timeout: 0,
  },
  async () => {
    assert.ok(databaseUrl);
    assertLocalDatabaseUrl(databaseUrl);
    const client = new Pool({ connectionString: databaseUrl });
    const sessionId = `synthetic-claude-${randomUUID()}`;
    const fixture = mkdtempSync(join(tmpdir(), 'memory-session-end-'));
    const transcriptPath = join(fixture, 'claude.jsonl');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CLAUDECODE: '1',
      AI_MEMORY_EMBEDDING_PROVIDER: 'none',
      AI_MEMORY_LOG_STDERR: '0',
    };
    for (const key of ['CODEX', 'PLUGIN_ROOT', 'AI_AGENT_IDENTITY', 'GROK_HOOK_EVENT']) delete env[key];
    const hook = fileURLToPath(
      new URL('../../../dist/tools/ingestion/ingest-claude-session-end-hook.js', import.meta.url),
    );
    try {
      await initializeDatabase();
      for (let index = 0; index < 6; index += 1) {
        const finalText = `Synthetic Claude response ${String(index)}: catalog verification completed.`;
        writeFileSync(
          transcriptPath,
          `${JSON.stringify({
            type: 'assistant',
            sessionId,
            message: { role: 'assistant', content: [{ type: 'text', text: finalText }] },
          })}\n`,
        );
        const run = spawnSync(process.execPath, [hook], {
          env,
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
          input: JSON.stringify({
            hook_event_name: index < 5 ? 'Stop' : 'SessionEnd',
            session_id: sessionId,
            transcript_path: transcriptPath,
            cwd: fixture,
            repo_id: 'example/catalog',
            created_at: `2026-10-20T00:00:0${String(index)}.000Z`,
          }),
        });
        assert.ifError(run.error);
        assert.equal(run.status, 0, run.stderr);
        assert.deepEqual(JSON.parse(run.stdout), { continue: true, suppressOutput: true });
        const sessions = await client.query('SELECT session_id,agent FROM ai_sessions WHERE session_id=$1', [
          sessionId,
        ]);
        assert.deepEqual(sessions.rows, [{ session_id: sessionId, agent: 'claude-code' }]);
        const deltas = await client.query<{
          produced_by_agent: string;
          source: string;
          content: string;
        }>(
          `SELECT produced_by_agent, raw_json->'workflow'->>'system' AS source,
          raw_json->'artifacts'->0->>'content_markdown' AS content
        FROM ai_memory_deltas WHERE session_id=$1 ORDER BY created_at`,
          [sessionId],
        );
        assert.equal(deltas.rows.length, index + 1, 'changing transcripts must each reach ingestion');
        for (const delta of deltas.rows) {
          assert.equal(delta.produced_by_agent, 'claude-code');
          assert.equal(delta.source, 'claude-session-end');
        }
        assert.ok(deltas.rows.at(-1)?.content.includes(finalText));
      }
    } finally {
      try {
        await client.query('DELETE FROM ai_ingestion_failures WHERE session_id=$1', [sessionId]);
        await client.query('DELETE FROM ai_memory_deltas WHERE session_id=$1', [sessionId]);
        await client.query('DELETE FROM ai_sessions WHERE session_id=$1', [sessionId]);
      } finally {
        await client.end();
        await closePool();
        rmSync(fixture, { recursive: true, force: true });
      }
    }
  },
);
