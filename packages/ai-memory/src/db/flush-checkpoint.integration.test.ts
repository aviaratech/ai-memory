import type { DbPool } from '@aviaratech/ai-memory/internal';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ingestMemoryDelta, storeMemory } from '@aviaratech/ai-memory';
import {
  assertLocalDatabaseUrl,
  ingestMemoryDeltaInTransaction,
  initializeDatabase,
  pool,
} from '@aviaratech/ai-memory/internal';
import { Pool } from 'pg';
import { test, vi } from 'vitest';

import { flushSession } from '../tools/ingestion/flush-session.js';
import { pool as candidatePool } from './runtime.js';

const databaseUrl = process.env.AI_MEMORY_DATABASE_URL;

test(
  'flush writes only session state, memory_store gates durable writes, and deltas cannot promote memories',
  {
    skip: databaseUrl === undefined,
    timeout: 0,
  },
  async () => {
    assert.ok(databaseUrl);
    assertLocalDatabaseUrl(databaseUrl);
    const verification = new Pool({ connectionString: databaseUrl });
    const suffix = randomUUID();
    const project = `ci/flush-${suffix}`;
    const sessions = new Set<string>();
    const deltas = new Set<string>();
    let releases = 0;
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
    const flush = (sessionId: string, overrides: NonNullable<Parameters<typeof flushSession>[1]> = {}) => {
      sessions.add(sessionId);
      return flushSession(
        {
          decisions: ['Retry the synthetic fixture only after verifying its recorded input.'],
          nextActions: ['Verify the synthetic persistence fixture.'],
          project,
          rootCauses: ['The synthetic fixture failed because its input file was missing.'],
          sessionId,
          source: 'codex',
          stateModel: { assumptions: ['The fixture input is synthetic.'], strategy_confidence: 'high' },
          summary: `Preserve the synthetic checkpoint for ${sessionId} and verify its persistence before continuing.`,
        },
        {
          ingestMemoryDeltaInTransaction: ingest,
          pool: trackedPool,
          refreshContinuityPack: () => Promise.resolve({ reason: 'missing_project', status: 'skipped' }),
          ...overrides,
        },
      );
    };
    const countBySession = async (table: string, sessionId: string) =>
      Number(
        (
          await verification.query<{ count: string }>(`SELECT count(*) FROM ${table} WHERE session_id = $1`, [
            sessionId,
          ])
        ).rows[0]?.count,
      );

    try {
      await initializeDatabase();
      ready = true;

      const sessionId = `synthetic-${suffix}-flush`;
      const result = await flush(sessionId);
      assert.equal(result.flushed, true);
      assert.equal('memoriesStored' in result, false);
      assert.ok(result.warnings?.some(warning => warning.includes('saved with this session checkpoint only')));
      assert.equal(await countBySession('ai_memory_entries', sessionId), 0, 'flush must not write durable memories');
      assert.equal(await countBySession('ai_sessions', sessionId), 1);
      assert.equal(await countBySession('ai_memory_deltas', sessionId), 1);
      assert.equal(await countBySession('ai_session_events', sessionId), 1);
      const snapshot = (
        await verification.query<{ snapshot_json: Record<string, unknown> }>(
          'SELECT snapshot_json FROM ai_session_snapshots WHERE session_id = $1',
          [sessionId],
        )
      ).rows[0]?.snapshot_json;
      assert.ok(snapshot);
      assert.deepEqual(snapshot.x_decisions, ['Retry the synthetic fixture only after verifying its recorded input.']);
      assert.deepEqual(snapshot.x_root_causes, ['The synthetic fixture failed because its input file was missing.']);
      assert.deepEqual(snapshot.next_actions, ['Verify the synthetic persistence fixture.']);

      const failedSession = `synthetic-${suffix}-rollback`;
      const releasesBefore = releases;
      await assert.rejects(
        flush(failedSession, {
          ingestMemoryDeltaInTransaction: async (client, input) => {
            await ingest(client, input);
            throw new Error('synthetic failure after real delta');
          },
        }),
        /synthetic failure after real delta/u,
      );
      assert.equal(releases, releasesBefore + 1);
      for (const table of ['ai_sessions', 'ai_memory_deltas', 'ai_session_snapshots', 'ai_session_events']) {
        assert.equal(await countBySession(table, failedSession), 0, table);
      }
      await flush(failedSession);
      assert.equal(await countBySession('ai_session_snapshots', failedSession), 1);

      const durable = await storeMemory({
        category: 'decision',
        confidence: 0.8,
        content: 'Synthetic fixtures are verified against their recorded input before a retry.',
        evidenceRefs: ['docs/operations.md'],
        memoryKey: `${project}:retry-rule`,
        project,
        source: 'synthetic-fixture',
      });
      assert.equal(durable.memoryKey, `${project}:retry-rule`);
      assert.equal(durable.expiresAt, null);
      const rejected = [
        { memoryKey: undefined, reason: /memoryKey is required/u },
        { evidenceRefs: [], reason: /evidenceRefs needs at least one/u },
        { content: 'Ask the synthetic owner at owner@example.com before retrying.', reason: /email address/u },
        { evidenceRefs: ['/Users/synthetic/fixture.txt'], reason: /home-folder path/u },
        { category: 'session-summary', reason: /memory_flush/u },
      ];
      for (const { reason, ...override } of rejected) {
        await assert.rejects(
          storeMemory({
            category: 'decision',
            confidence: 0.8,
            content: 'Synthetic fixtures are verified against their recorded input before a retry.',
            evidenceRefs: ['docs/operations.md'],
            memoryKey: `${project}:rejected`,
            project,
            source: 'synthetic-fixture',
            ...override,
          }),
          reason,
        );
      }
      assert.equal(
        Number(
          (
            await verification.query<{ count: string }>('SELECT count(*) FROM ai_memory_entries WHERE project = $1', [
              project,
            ])
          ).rows[0]?.count,
        ),
        1,
        'only the gated durable write is stored',
      );

      const deltaSession = `synthetic-${suffix}-delta`;
      sessions.add(deltaSession);
      const deltaId = `synthetic-${suffix}-delta`;
      await assert.rejects(
        ingestMemoryDelta({
          memoryDelta: {
            append_events: [],
            artifacts: [],
            created_at: new Date().toISOString(),
            delta_id: deltaId,
            produced_by: { agent: 'synthetic-fixture' },
            schema_version: 'memory_delta@0.1',
            session_id: deltaSession,
            snapshot: {
              mode: 'replace',
              value: {
                anchors: { focus_paths: [], related_links: [] },
                context_needed: [],
                created_at: new Date().toISOString(),
                goal: 'Synthetic delta with a durable proposal.',
                next_actions: [],
                open_questions: [],
                plan: [],
                progress: { blockers: [], completed: [], in_flight: [] },
                snapshot_id: `synthetic-${suffix}-snapshot`,
              },
            },
            tenancy: { repo_id: project },
            x_durable_memories: [{ category: 'decision', confidence: 0.9, content: 'A promoted fragment.' }],
          },
        }),
        /x_durable_memories is no longer accepted/u,
      );
      assert.equal(await countBySession('ai_memory_deltas', deltaSession), 0);
      assert.equal(fetchGuard.mock.calls.length, 0);
    } finally {
      fetchGuard.mockRestore();
      try {
        if (ready) {
          await verification.query('DELETE FROM ai_memory_entries WHERE project = $1', [project]);
          await verification.query('DELETE FROM ai_memory_deltas WHERE delta_id = ANY($1::text[])', [[...deltas]]);
          await verification.query('DELETE FROM ai_sessions WHERE session_id = ANY($1::text[])', [[...sessions]]);
          for (const table of ['ai_memory_deltas', 'ai_session_events', 'ai_session_snapshots', 'ai_sessions']) {
            assert.equal(
              (
                await verification.query<{ count: string }>(
                  `SELECT count(*) FROM ${table} WHERE session_id = ANY($1::text[])`,
                  [[...sessions]],
                )
              ).rows[0]?.count,
              '0',
              table,
            );
          }
        }
      } finally {
        await Promise.all([verification.end(), pool.end(), candidatePool.end()]);
      }
    }
  },
);
