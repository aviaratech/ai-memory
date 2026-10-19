import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, vi } from 'vitest';
import { Pool } from 'pg';
import { assertLocalDatabaseUrl } from './pool.js';
import { initializeDatabase } from './admin-api.js';
import { armPromptRetrieval, consumePromptRetrieval } from './tool-invocations.js';
import { getContinuityPack, upsertContinuityPack, writeAutomaticSessionCheckpoint } from './continuity-pack-api.js';

const databaseUrl = process.env.AI_MEMORY_DATABASE_URL;

test(
  'real PostgreSQL arbitrates prompt races and preserves newer explicit checkpoints',
  { skip: databaseUrl === undefined, timeout: 0 },
  async () => {
    assert.ok(databaseUrl);
    assertLocalDatabaseUrl(databaseUrl);
    const client = new Pool({ connectionString: databaseUrl });
    const project = `fixture/hooks-${randomUUID()}`;
    const identity = { host: 'codex' as const, project, sessionId: `session-${randomUUID()}` };
    const provider = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('External providers forbidden in synthetic hook integration.'));
    try {
      await initializeDatabase();
      await armPromptRetrieval(identity);
      assert.equal(
        (await Promise.all(Array.from({ length: 8 }, () => consumePromptRetrieval(identity)))).filter(Boolean).length,
        1,
      );
      await armPromptRetrieval(identity);
      assert.equal(await consumePromptRetrieval(identity), false, 'startup replay must not reset consumed state');
      await client.query('DELETE FROM ai_tool_invocations WHERE project=$1 AND session_id=$2', [
        project,
        identity.sessionId,
      ]);
      assert.equal(await consumePromptRetrieval(identity), false, 'expired markers never recreate eligibility');
      const late = { ...identity, sessionId: `late-${randomUUID()}` };
      assert.equal(await consumePromptRetrieval(late), false);
      await armPromptRetrieval(late);
      assert.equal(await consumePromptRetrieval(late), false, 'late startup cannot arm a later prompt');

      const checkpoint = {
        project,
        sessionId: identity.sessionId,
        source: 'pre-compact',
        scope: { type: 'task' as const, id: identity.sessionId },
        budgetChars: 6000,
        payloadText: 'Derived summary',
        pack: { summary: 'Derived summary', provenance: { agent: 'codex' } },
        updatedAt: '2026-10-19T00:00:00.000Z',
      };
      const missing = await getContinuityPack({ project, task: identity.sessionId }, { includeRevisionToken: true });
      assert.equal(missing.status, 'missing');
      assert.equal(
        (
          await Promise.all(
            Array.from({ length: 4 }, () => writeAutomaticSessionCheckpoint({ checkpoint, expected: missing })),
          )
        ).filter(Boolean).length,
        1,
      );
      const createdSession = await client.query('SELECT repo_id, agent, task_id FROM ai_sessions WHERE session_id=$1', [
        identity.sessionId,
      ]);
      assert.deepEqual(createdSession.rows, [{ repo_id: project, agent: 'codex', task_id: identity.sessionId }]);
      const observed = await getContinuityPack({ project, task: identity.sessionId }, { includeRevisionToken: true });
      assert.equal(observed.status, 'found');
      assert.equal(
        await writeAutomaticSessionCheckpoint({
          checkpoint: { ...checkpoint, pack: { summary: 'Foreign host', provenance: { agent: 'claude-code' } } },
          expected: observed,
        }),
        false,
        'a different host cannot replace an automatic checkpoint with the same session ID',
      );
      const explicit = {
        ...checkpoint,
        source: 'manual-flush',
        pack: { summary: 'NEWER_EXPLICIT_FLUSH' },
        payloadText: 'NEWER_EXPLICIT_FLUSH',
      };
      await upsertContinuityPack(explicit);
      assert.equal(
        await writeAutomaticSessionCheckpoint({ checkpoint, expected: observed }),
        false,
        'same-millisecond changes still invalidate the observed row token',
      );
      const preserved = await getContinuityPack({ project, task: identity.sessionId }, { includeRevisionToken: true });
      assert.equal(preserved.status, 'found');
      assert.equal(preserved.pack.pack.summary, 'NEWER_EXPLICIT_FLUSH');
      assert.equal(
        await writeAutomaticSessionCheckpoint({ checkpoint, expected: missing }),
        false,
        'a competing insert invalidates an absent-row observation',
      );

      const conflictingSession = `conflict-${randomUUID()}`;
      await client.query('INSERT INTO ai_sessions(session_id,repo_id,repo_slug,agent) VALUES($1,$2,$2,$3)', [
        conflictingSession,
        project,
        'claude-code',
      ]);
      assert.equal(
        await writeAutomaticSessionCheckpoint({
          checkpoint: { ...checkpoint, sessionId: conflictingSession, scope: { type: 'task', id: conflictingSession } },
          expected: { status: 'missing', project, scopeKey: `task:${project}:${conflictingSession}` },
        }),
        false,
      );
      const unchanged = await client.query<{ agent: string }>('SELECT agent FROM ai_sessions WHERE session_id=$1', [
        conflictingSession,
      ]);
      assert.deepEqual(unchanged.rows, [{ agent: 'claude-code' }]);
      const foreignProject = `${project}-foreign`;
      await client.query('UPDATE ai_sessions SET repo_id=$2,repo_slug=$2,agent=$3 WHERE session_id=$1', [
        conflictingSession,
        foreignProject,
        'codex',
      ]);
      assert.equal(
        await writeAutomaticSessionCheckpoint({
          checkpoint: { ...checkpoint, sessionId: conflictingSession, scope: { type: 'task', id: conflictingSession } },
          expected: { status: 'missing', project, scopeKey: `task:${project}:${conflictingSession}` },
        }),
        false,
      );
      const preservedIdentity = await client.query('SELECT repo_id,agent FROM ai_sessions WHERE session_id=$1', [
        conflictingSession,
      ]);
      assert.deepEqual(preservedIdentity.rows, [{ repo_id: foreignProject, agent: 'codex' }]);
      await client.query('DELETE FROM ai_sessions WHERE session_id=$1', [conflictingSession]);
      const rollbackSession = `rollback-${randomUUID()}`;
      await assert.rejects(
        writeAutomaticSessionCheckpoint({
          checkpoint: {
            ...checkpoint,
            budgetChars: -1,
            sessionId: rollbackSession,
            scope: { type: 'task', id: rollbackSession },
          },
          expected: { status: 'missing', project, scopeKey: `task:${project}:${rollbackSession}` },
        }),
        /budget_chars_check/u,
      );
      const rolledBack = await client.query('SELECT session_id FROM ai_sessions WHERE session_id=$1', [
        rollbackSession,
      ]);
      assert.equal(rolledBack.rowCount, 0, 'failed checkpoint rolls back its new session registration');
      const fresh = await getContinuityPack({ project, task: identity.sessionId }, { includeRevisionToken: true });
      assert.equal(await writeAutomaticSessionCheckpoint({ checkpoint, expected: fresh }), true);
      await upsertContinuityPack(explicit);
      const after = await getContinuityPack({ project, task: identity.sessionId }, { includeRevisionToken: true });
      assert.equal(after.status, 'found');
      assert.equal(
        after.pack.pack.summary,
        'NEWER_EXPLICIT_FLUSH',
        'explicit writer remains authoritative when it commits last',
      );
      assert.equal(provider.mock.calls.length, 0);
    } finally {
      provider.mockRestore();
      await client.query('DELETE FROM ai_continuity_packs WHERE project=$1', [project]);
      await client.query('DELETE FROM ai_tool_invocations WHERE project=$1', [project]);
      await client.query('DELETE FROM ai_sessions WHERE repo_id=$1 OR repo_id=$2', [project, `${project}-foreign`]);
      await client.end();
    }
  },
);
