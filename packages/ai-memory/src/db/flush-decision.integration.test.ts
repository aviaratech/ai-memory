import type { DbPool } from '@aviaratech/ai-memory/internal';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { recallMemories, storeMemory } from '@aviaratech/ai-memory';
import {
  assertLocalDatabaseUrl,
  getCapabilities,
  ingestMemoryDeltaInTransaction,
  initializeDatabase,
  pool,
  storeMemoryWithAuditEvent,
} from '@aviaratech/ai-memory/internal';
import { Pool } from 'pg';
import { test, vi } from 'vitest';

import { consolidateMemories } from '../consolidation/consolidateMemories.js';
import * as classifier from '../consolidation/llm-classify.js';
import { flushSession } from '../tools/ingestion/flush-session.js';
import * as embeddings from './embeddings.js';
import { pool as candidatePool } from './runtime.js';

const databaseUrl = process.env.AI_MEMORY_DATABASE_URL;
const DAY_MS = 24 * 60 * 60 * 1000;

test(
  'flush decisions isolate sessions, preserve first expiry and durable rows, and recover atomically',
  {
    skip: databaseUrl === undefined,
  },
  async () => {
    assert.ok(databaseUrl);
    assertLocalDatabaseUrl(databaseUrl);
    const verification = new Pool({ connectionString: databaseUrl });
    const suffix = randomUUID();
    const project = `ci/flush-${suffix}`;
    const ordinaryProject = `${project}-ordinary`;
    const projects = [project, ordinaryProject];
    const sessions = new Set<string>();
    const deltas = new Set<string>();
    const decisionText = 'Retry the synthetic fixture only after verifying its recorded input.';
    const vector = Array.from({ length: 1536 }, (_, index) => Number(index === 17));
    let now = new Date(Date.now() - 30 * DAY_MS);
    let releases = 0;
    let generated = 0;
    let ready = false;
    const fetchGuard = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('External provider calls are forbidden in this fixture.'));
    const trackedPool: DbPool = {
      ...pool,
      async connect() {
        const client = await pool.connect();
        return {
          query: <Row>(sql: string, params?: unknown[]) => client.query<Row>(sql, params),
          release(error?: boolean | Error) {
            releases += 1;
            client.release(error);
          },
        };
      },
    };
    const ingest: typeof ingestMemoryDeltaInTransaction = async (client, input) => {
      const result = await ingestMemoryDeltaInTransaction(client, input);
      deltas.add(result.deltaId);
      return result;
    };
    const flush = async (
      sessionId: string | undefined,
      scope = project,
      overrides: NonNullable<Parameters<typeof flushSession>[1]> = {},
    ) => {
      if (sessionId !== undefined) sessions.add(sessionId);
      return flushSession(
        {
          decisions: [decisionText],
          nextActions: ['Verify the synthetic persistence fixture.'],
          project: scope,
          sessionId,
          source: 'codex',
          summary: `Preserve the synthetic checkpoint for ${sessionId ?? 'an omitted host identity'} and verify its persistence before continuing.`,
          task: 'synthetic-shared-task',
        },
        {
          getEmbedding: (_content, options) =>
            Promise.resolve(
              options !== null && typeof options === 'object' && options.category === 'decision' ? vector : null,
            ),
          ingestMemoryDeltaInTransaction: ingest,
          isEmbeddingAvailable: () => false,
          now: () => new Date(now),
          pool: trackedPool,
          refreshContinuityPack: () => Promise.resolve({ reason: 'missing_project', status: 'skipped' }),
          runReflection: () => Promise.resolve({ reflectionResult: undefined, storedMemories: [] }),
          uuid: () => {
            generated += 1;
            const id = `synthetic-unattested-${suffix}-${String(generated)}`;
            sessions.add(id);
            return id;
          },
          ...overrides,
        },
      );
    };
    const rowSnapshot = async (id: number) =>
      (
        await verification.query<{ value: unknown }>(
          'SELECT to_jsonb(m) AS value FROM ai_memory_entries m WHERE id = $1',
          [id],
        )
      ).rows[0]?.value;
    const fragments = async (scope = project) =>
      (
        await verification.query<{
          id: string;
          session_id: string;
          memory_type: string;
          memory_key: null | string;
          expires_at: Date;
          status: string;
        }>(
          "SELECT id, session_id, memory_type, memory_key, expires_at, status FROM ai_memory_entries WHERE project = $1 AND category = 'decision' AND memory_type = 'episodic' ORDER BY session_id",
          [scope],
        )
      ).rows.map(row => ({ ...row, id: Number(row.id) }));
    const assertRolledBack = async (sessionId: string) => {
      for (const table of [
        'ai_memory_entries',
        'ai_sessions',
        'ai_memory_deltas',
        'ai_session_snapshots',
        'ai_session_events',
      ]) {
        const result = await verification.query<{ count: string }>(
          `SELECT count(*) FROM ${table} WHERE session_id = $1`,
          [sessionId],
        );
        assert.equal(result.rows[0]?.count, '0', table);
      }
      assert.equal(
        (
          await verification.query<{ count: string }>(
            "SELECT count(*) FROM ai_memory_events WHERE payload_json->>'session_id' = $1",
            [sessionId],
          )
        ).rows[0]?.count,
        '0',
      );
    };

    try {
      await initializeDatabase();
      ready = true;
      assert.equal(getCapabilities().hasVector, true);
      const keyed = await storeMemory({
        category: 'decision',
        confidence: 0.8,
        content: decisionText,
        memoryKey: `${project}:durable`,
        project,
        source: 'synthetic-fixture',
      });
      await verification.query('UPDATE ai_memory_entries SET embedding = $2::vector WHERE id = $1', [
        keyed.id,
        JSON.stringify(vector),
      ]);
      const controls = [keyed.id];
      for (const hash of [null, `sha256:synthetic-${suffix}`]) {
        const inserted = await verification.query<{ id: string }>(
          `INSERT INTO ai_memory_entries (content, project, category, memory_type, confidence, dedupe_hash, embedding)
         VALUES ($1, $2, 'decision', 'semantic', 0.8, $3, $4::vector) RETURNING id`,
          [decisionText, project, hash, JSON.stringify(vector)],
        );
        assert.ok(inserted.rows[0]);
        controls.push(Number(inserted.rows[0].id));
      }
      const protectedRows = await Promise.all(controls.map(rowSnapshot));
      const sessionA = `synthetic-${suffix}-A`;
      const sessionB = `synthetic-${suffix}-B`;
      const sessionLower = `synthetic-${suffix}-a`;
      const firstExpiry = new Date(now.getTime() + 14 * DAY_MS).toISOString();
      await flush(sessionA);
      await flush(sessionB);
      await flush(sessionLower);
      const initial = await fragments();
      assert.equal(initial.length, 3);
      assert.deepEqual(new Set(initial.map(row => row.session_id)), new Set([sessionA, sessionB, sessionLower]));
      for (const row of initial) {
        assert.equal(row.memory_type, 'episodic');
        assert.equal(row.memory_key, null);
        assert.equal(row.expires_at.toISOString(), firstExpiry);
      }
      const first = initial.find(row => row.session_id === sessionA);
      assert.ok(first);
      const firstSnapshot = await rowSnapshot(first.id);
      now = new Date(now.getTime() + 60 * DAY_MS);
      await Promise.all([flush(sessionA), flush(sessionA)]);
      assert.equal((await fragments()).length, 3);
      assert.deepEqual(await rowSnapshot(first.id), firstSnapshot);
      for (const status of ['expired', 'superseded', 'archived']) {
        await verification.query('UPDATE ai_memory_entries SET status = $2 WHERE id = $1', [first.id, status]);
        const retired = await rowSnapshot(first.id);
        await flush(sessionA);
        assert.deepEqual(await rowSnapshot(first.id), retired);
      }
      const recalled = await recallMemories({ project });
      assert.ok(
        initial.every(row => !recalled.some(memory => memory.id === row.id)),
        'expired fragments must not be active retrieval results',
      );
      assert.deepEqual(await Promise.all(controls.map(rowSnapshot)), protectedRows);

      now = new Date();
      await flush(`synthetic-${suffix}-ordinary`, ordinaryProject);
      const ordinaryFragment = (await fragments(ordinaryProject))[0];
      assert.ok(ordinaryFragment);
      const ordinaryBefore = await rowSnapshot(ordinaryFragment.id);
      const durable = await storeMemory({
        category: 'decision',
        confidence: 0.8,
        content: decisionText,
        project: ordinaryProject,
        source: 'synthetic-fixture',
      });
      assert.notEqual(durable.id, ordinaryFragment.id);
      assert.equal(durable.memoryType, 'semantic');
      assert.equal(durable.expiresAt, null);
      assert.deepEqual(await rowSnapshot(ordinaryFragment.id), ordinaryBefore);
      await verification.query("UPDATE ai_memory_entries SET status = 'superseded' WHERE id = $1", [
        ordinaryFragment.id,
      ]);
      const retiredBeforeExpiry = await rowSnapshot(ordinaryFragment.id);
      await flush(`synthetic-${suffix}-ordinary`, ordinaryProject);
      assert.deepEqual(await rowSnapshot(ordinaryFragment.id), retiredBeforeExpiry);

      const omittedA = await flush(undefined);
      const omittedB = await flush(undefined);
      assert.notEqual(omittedA.sessionId, omittedB.sessionId);
      assert.ok(omittedA.warnings?.some(warning => warning.includes('not an attested host identity')));
      assert.ok(omittedB.warnings?.some(warning => warning.includes('not an attested host identity')));
      assert.equal((await fragments()).length, 5);

      const embeddingStub = vi.spyOn(embeddings, 'getEmbedding').mockResolvedValue(vector);
      const classifyStub = vi.spyOn(classifier, 'classifyMemoryPair').mockResolvedValue({
        confidenceDelta: 0,
        reasoning: 'Synthetic unrelated control.',
        relationship: 'unrelated',
      });
      try {
        const probe = await verification.query<{ id: string }>(
          `INSERT INTO ai_memory_entries (content, project, category, memory_type, confidence, embedding)
         VALUES ($1, $2, 'implementation-note', 'episodic', 0.8, $3::vector) RETURNING id`,
          ['Independent synthetic candidate probe for scoped decision isolation.', project, JSON.stringify(vector)],
        );
        assert.ok(probe.rows[0]);
        const outcome = await consolidateMemories(
          [
            {
              category: 'implementation-note',
              confidence: 0.8,
              content: 'Independent synthetic candidate probe for scoped decision isolation.',
              id: Number(probe.rows[0].id),
              memoryType: 'episodic',
            },
          ],
          sessionB,
        );
        assert.deepEqual(new Set(outcome.outcomes.map(value => value.candidateMemoryId)), new Set(controls));
        assert.equal(classifyStub.mock.calls.length, controls.length);
        assert.ok(embeddingStub.mock.calls.length > 0);
      } finally {
        classifyStub.mockRestore();
        embeddingStub.mockRestore();
      }
      assert.deepEqual(await Promise.all(controls.map(rowSnapshot)), protectedRows);

      for (const stage of ['audit', 'delta']) {
        const failedSession = `synthetic-${suffix}-rollback-${stage}`;
        const releasesBefore = releases;
        const overrides: NonNullable<Parameters<typeof flushSession>[1]> =
          stage === 'audit'
            ? {
                storeMemoryWithAuditEvent: async (client, input, mode) => {
                  const memory = await storeMemoryWithAuditEvent(client, input, mode);
                  if (memory.category === 'decision') {
                    const events = await client.query<{ count: string }>(
                      'SELECT count(*) FROM ai_memory_events WHERE memory_id = $1',
                      [memory.id],
                    );
                    assert.equal(events.rows[0]?.count, '1');
                    throw new Error('synthetic failure after real actionable audit');
                  }
                  return memory;
                },
              }
            : {
                ingestMemoryDeltaInTransaction: async (client, input) => {
                  const result = await ingest(client, input);
                  const written = await client.query<{ count: string }>(
                    'SELECT count(*) FROM ai_memory_deltas WHERE delta_id = $1',
                    [result.deltaId],
                  );
                  assert.equal(written.rows[0]?.count, '1');
                  throw new Error('synthetic failure after real delta');
                },
              };
        await assert.rejects(flush(failedSession, project, overrides), /synthetic failure after real/u);
        assert.equal(releases, releasesBefore + 1);
        await assertRolledBack(failedSession);
        assert.deepEqual(await Promise.all(controls.map(rowSnapshot)), protectedRows);
        await flush(failedSession);
        assert.equal((await fragments()).filter(row => row.session_id === failedSession).length, 1);
      }
      assert.equal(fetchGuard.mock.calls.length, 0);
      console.log(
        'Synthetic scoped flush sessions, concurrent replay, fixed expiry/status, durable compatibility, candidate controls and audited rollback/recovery passed.',
      );
    } finally {
      fetchGuard.mockRestore();
      try {
        if (ready) {
          const ownedRows = await verification.query<{ id: string }>(
            'SELECT id FROM ai_memory_entries WHERE project = ANY($1::text[]) ORDER BY id',
            [projects],
          );
          console.log(
            JSON.stringify({
              fixture: 'flush-decision',
              stage: 'owned-cleanup',
              projects,
              sessionIds: [...sessions],
              deltaIds: [...deltas],
              memoryIds: ownedRows.rows.map(row => row.id),
            }),
          );
          await verification.query('DELETE FROM ai_memory_entries WHERE project = ANY($1::text[])', [projects]);
          await verification.query('DELETE FROM ai_memory_deltas WHERE delta_id = ANY($1::text[])', [[...deltas]]);
          await verification.query('DELETE FROM ai_sessions WHERE session_id = ANY($1::text[])', [[...sessions]]);
          for (const [table, column, values] of [
            ['ai_memory_entries', 'project', projects],
            ['ai_memory_deltas', 'delta_id', [...deltas]],
            ['ai_sessions', 'session_id', [...sessions]],
            ['ai_session_events', 'session_id', [...sessions]],
            ['ai_session_snapshots', 'session_id', [...sessions]],
          ] as const) {
            assert.equal(
              (
                await verification.query<{ count: string }>(
                  `SELECT count(*) FROM ${table} WHERE ${column} = ANY($1::text[])`,
                  [values],
                )
              ).rows[0]?.count,
              '0',
              table,
            );
          }
          console.log(
            'Owned synthetic flush fixture rows, deltas, sessions and cascading artifacts are absent after cleanup.',
          );
        }
      } finally {
        await Promise.all([verification.end(), pool.end(), candidatePool.end()]);
      }
    }
  },
);
