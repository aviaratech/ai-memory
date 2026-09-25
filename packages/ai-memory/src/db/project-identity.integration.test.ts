import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mock } from 'node:test';
import { test } from 'vitest';
import { Client } from 'pg';

import fixture from '../fixtures/project-identity-migration.json' with { type: 'json' };
import { getContinuityPack } from './continuity-pack-api.js';
import { getMemoryEntries, searchMemories } from './memory-api.js';
import { assertLocalDatabaseUrl } from './pool.js';
import { resolveSessionId } from './session-api.js';
import { mockPoolConnect } from './test-pool-mock.js';

// Explicit disposable-local opt-in: this migration test must never target the
// installed database merely because a normal plugin DATABASE_URL is present.
const databaseUrl = process.env.AI_MEMORY_PROJECT_IDENTITY_TEST_URL;

test(
  'verified legacy records and exact task checkpoints survive migration and reconnect',
  {
    skip: databaseUrl === undefined,
  },
  async () => {
    assert.ok(databaseUrl);
    assertLocalDatabaseUrl(databaseUrl);
    const schema = `identity_${randomUUID().replaceAll('-', '')}`;
    let client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      for (const file of [
        '001_baseline.sql',
        '002_continuity_packs.sql',
        '003_searchable_provenance.sql',
        '004_reference_search_terms.sql',
      ]) {
        await client.query(await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'));
      }
      for (const row of fixture.memories) {
        await client.query("INSERT INTO ai_sessions (session_id, repo_id, agent) VALUES ($1, $2, 'codex')", [
          row.sessionId,
          row.project,
        ]);
        await client.query(
          `INSERT INTO ai_memory_entries
        (id, project, repo_slug, session_id, content, memory_key, source, category, status, memory_type)
        VALUES ($1, $2, $3, $4, $5, $6, 'codex', 'decision', 'active', 'semantic')`,
          [row.id, row.project, row.repoSlug, row.sessionId, row.content, row.memoryKey],
        );
      }
      for (const row of fixture.historicalRepositoryEvidence) {
        await client.query(
          "INSERT INTO ai_sessions (session_id, repo_id, agent) VALUES ($1, 'catalog', 'codex') ON CONFLICT DO NOTHING",
          [row.sessionId],
        );
        await client.query(
          `INSERT INTO ai_memory_entries
          (id, project, repo_id, repo_slug, session_id, content, source, category, memory_type)
          VALUES ($1, $2, $3, $4, $5, $6, 'codex', 'decision', 'semantic')`,
          [row.id, row.project, row.repoId, row.repoSlug, row.sessionId, row.content],
        );
      }
      await client.query(`INSERT INTO ai_continuity_packs (scope_key, project, session_id, source) VALUES
        ('task:catalog:foreign-host-task', 'catalog', 'conflicting-host-session', 'codex')`);
      await client.query(`INSERT INTO ai_sessions (session_id, repo_id, repo_slug, agent) VALUES
        ('repo-id-evidence-session', 'catalog', NULL, 'codex'),
        ('null-repo-id-session', NULL, 'example/catalog', 'codex')`);
      await client.query(`INSERT INTO ai_memory_entries
        (id, project, repo_id, session_id, content, memory_key, source, category, status, memory_type)
        VALUES (1005, 'catalog', 'example/catalog', 'repo-id-evidence-session', 'Qualified repo ID evidence.',
        'fixture:repo-id-evidence', 'codex', 'decision', 'active', 'semantic')`);
      await client.query(`INSERT INTO ai_continuity_packs (scope_key, project, session_id, source) VALUES
        ('task:catalog:repo-id-evidence-task', 'catalog', 'repo-id-evidence-session', 'codex'),
        ('task:catalog:null-repo-id-task', 'catalog', 'null-repo-id-session', 'codex')`);
      const payload = {
        nextActions: ['Deliver source first.'],
        provenance: {
          scope: { id: 'logical-lead-task', type: 'task' },
          sessionId: 'lead-host-session',
          source: 'codex',
        },
        summary: 'Preserve the current operator decision.',
      };
      await client.query(
        `INSERT INTO ai_continuity_packs
      (scope_key, project, session_id, source, payload_chars, budget_chars, pack_json, updated_at)
      VALUES ('task:catalog:logical-lead-task', 'catalog', 'lead-host-session', 'codex', 240, 6000, $1, '2026-09-16T20:19:33Z'),
      ('task:example/catalog:logical-lead-task', 'example/catalog', 'lead-host-session', 'codex', 100, 6000, '{"summary":"Historical decision"}', '2026-09-16T02:30:49Z')`,
        [payload],
      );
      mockPoolConnect((sql, params) => client.query(sql, params === undefined ? [] : [...params]));
      assert.deepEqual(
        (await getMemoryEntries({ ids: [1001, 1002], project: 'example/catalog' })).map(row => row.id),
        [1001],
      );
      const previousMigration = await readFile(
        new URL('../../migrations/005_verified_project_identity.sql', import.meta.url),
        'utf8',
      );
      await client.query('BEGIN');
      await client.query(previousMigration);
      await client.query('COMMIT');
      const stale = await getContinuityPack({ project: 'example/catalog', task: 'logical-lead-task' });
      assert.equal(stale.status, 'found');
      assert.deepEqual(stale.pack.pack, { summary: 'Historical decision' });
      const migration = await readFile(
        new URL('../../migrations/006_host_qualified_project_identity.sql', import.meta.url),
        'utf8',
      );
      await client.query('BEGIN');
      await client.query(migration);
      await client.query('COMMIT');
      await client.end();
      client = new Client({ connectionString: databaseUrl });
      await client.connect();
      await client.query(`SET search_path TO ${schema}, public`);
      const records = await getMemoryEntries({ ids: fixture.memories.map(row => row.id), project: 'example/catalog' });
      assert.deepEqual(
        records.map(row => row.id),
        [1001, 1002],
      );
      const decision = records[1];
      assert.ok(decision);
      assert.equal(decision.memoryKey, fixture.memories[1]?.memoryKey);
      assert.equal(decision.source, 'codex');
      assert.equal(decision.sessionId, 'lead-host-session');
      const found = await searchMemories({
        includeEmbedding: false,
        project: 'example/catalog',
        query: 'document import',
      });
      assert.ok(found.some(row => row.id === 1002));
      assert.ok(found.every(row => row.project === 'example/catalog'));
      assert.ok(found.every(row => row.id !== 1003 && row.id !== 1004));
      const pack = await getContinuityPack({ project: 'example/catalog', task: 'logical-lead-task' });
      assert.equal(pack.status, 'found');
      assert.deepEqual(pack.pack.pack, payload);
      assert.equal(pack.pack.sessionId, 'lead-host-session');
      assert.equal(pack.pack.budgetChars, 6000);
      assert.equal(
        (await getContinuityPack({ project: 'other/catalog', task: 'logical-lead-task' })).status,
        'missing',
      );
      for (const [sessionId, task] of [
        ['repo-id-evidence-session', 'repo-id-evidence-task'],
        ['null-repo-id-session', 'null-repo-id-task'],
      ] as const) {
        const resumed = await resolveSessionId(
          {
            query: async (sql, params) => {
              const result = await client.query<Record<string, unknown>>(sql, params);
              return { rowCount: result.rowCount ?? 0, rows: result.rows };
            },
          },
          { agent: undefined, project: 'example/catalog', repoId: undefined, sessionId },
        );
        assert.equal(resumed?.sessionId, sessionId);
        assert.equal((await getContinuityPack({ project: 'example/catalog', task })).status, 'found');
      }
      assert.deepEqual(
        (await getMemoryEntries({ id: 1005, project: 'example/catalog' })).map(row => row.id),
        [1005],
      );
      assert.equal(
        (await getContinuityPack({ project: 'example/catalog', task: 'foreign-host-task' })).status,
        'missing',
      );
      assert.equal((await getContinuityPack({ project: 'catalog', task: 'foreign-host-task' })).status, 'found');
      for (const row of fixture.historicalRepositoryEvidence) {
        const retained = await client.query<{ project: string; repo_id: string; repo_slug: string }>(
          'SELECT project, repo_id, repo_slug FROM ai_memory_entries WHERE id=$1',
          [row.id],
        );
        assert.deepEqual(retained.rows[0], { project: row.project, repo_id: row.repoId, repo_slug: row.repoSlug });
      }
      const historical = await getContinuityPack({ project: 'catalog', task: 'logical-lead-task' });
      assert.equal(historical.status, 'found');
      assert.deepEqual(historical.pack.pack, { summary: 'Historical decision' });
      await client.query('BEGIN');
      await client.query(migration);
      await client.query('COMMIT');
      assert.equal(
        (await getContinuityPack({ project: 'example/catalog', task: 'logical-lead-task' })).status,
        'found',
      );
      const untouched = await getMemoryEntries({ ids: [1003, 1004], project: 'catalog' });
      assert.deepEqual(
        untouched.map(row => row.id),
        [1003, 1004],
      );
      await client.query(
        `UPDATE ai_continuity_packs SET updated_at = '2026-09-16T20:19:33Z' WHERE project = 'catalog'`,
      );
      await client.query('BEGIN');
      await assert.rejects(client.query(migration), /checkpoint collision/u);
      await client.query('ROLLBACK');
      assert.equal(
        (await client.query<{ count: number }>('SELECT count(*)::int AS count FROM ai_continuity_packs')).rows[0]
          ?.count,
        5,
      );
      await client.query(
        `UPDATE ai_continuity_packs SET updated_at = '2026-09-16T02:30:49Z' WHERE project = 'catalog'`,
      );
      await client.query(`INSERT INTO ai_continuity_packs (scope_key, project, session_id, source) VALUES
        ('task:catalog:foreign-collision', 'catalog', 'lead-host-session', 'codex'),
        ('task:example/catalog:foreign-collision', 'example/catalog', 'other-host-session', 'codex')`);
      await client.query('BEGIN');
      await assert.rejects(client.query(migration), /checkpoint collision/u);
      await client.query('ROLLBACK');
      const foreign = await client.query<{ session_id: string }>(
        "SELECT session_id FROM ai_continuity_packs WHERE scope_key = 'task:example/catalog:foreign-collision'",
      );
      assert.equal(foreign.rows[0]?.session_id, 'other-host-session');
    } finally {
      // Drain any asynchronous importance update before closing the test connection.
      await client.query('SELECT 1');
      mock.restoreAll();
      await client.query(`DROP SCHEMA ${schema} CASCADE`);
      await client.end();
    }
  },
);
