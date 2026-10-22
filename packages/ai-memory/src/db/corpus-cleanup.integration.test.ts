import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { test } from 'vitest';

import type { BackupHealth } from '../tools/disaster-recovery.js';

import { CleanupRefusedError, runCleanup } from '../tools/cleanup.js';
import { databaseTargetDigest } from '../tools/disaster-recovery.js';
import { assertLocalDatabaseUrl, createPool } from './pool.js';
import { runAiMemoryMigrations } from './run-migrations.js';

// The disposable project-identity administrator creates and drops this
// fixture's own database, so the cleanup sees only synthetic rows.
const adminUrl = process.env.AI_MEMORY_PROJECT_IDENTITY_TEST_URL;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const HOUR_MS = 60 * 60 * 1000;

// Every expected outcome is written into the fixture rows themselves, so the
// assertions never reuse the cleanup's own predicates.
const SEED_ENTRIES_SQL = `
WITH vec AS (SELECT array_fill(0.01::real, ARRAY[1536])::vector AS v)
INSERT INTO ai_memory_entries
  (content, project, category, memory_type, source, confidence, memory_key, evidence_refs, tags,
   expires_at, metadata_json, status, embedding, created_at)
SELECT * FROM (
  SELECT 'Curated rule ' || g || ' keeps synthetic fixtures reviewable.', 'synthetic/cleanup', 'decision', 'semantic',
    'claude-code', 0.9, 'synthetic/cleanup:rule-' || g, '["docs/operations.md"]'::jsonb, ARRAY['expect-keep'],
    NULL::timestamptz, '{}'::jsonb, CASE WHEN g <= 2 THEN 'superseded' ELSE 'active' END,
    CASE WHEN g % 2 = 0 THEN (SELECT v FROM vec) END, NOW()
  FROM generate_series(1, 32) g
  UNION ALL
  SELECT 'Legacy synthetic decision stored without a key or evidence.', 'synthetic/cleanup', 'decision', 'semantic',
    'codex', 0.8, NULL, '[]'::jsonb, ARRAY['expect-keep'], NULL, '{}'::jsonb, 'active', (SELECT v FROM vec), NOW()
  UNION ALL
  SELECT 'Unexpired synthetic session summary ' || g, 'synthetic/cleanup', 'session-summary', 'episodic',
    'codex', 0.4, NULL, '[]'::jsonb, ARRAY['expect-keep'], NOW() + INTERVAL '7 days', '{}'::jsonb, 'active', NULL, NOW()
  FROM generate_series(1, 3) g
  UNION ALL
  SELECT 'Flush decision fragment ' || g || ' ' || repeat('padding ', 30), 'synthetic/cleanup', 'decision',
    'semantic', 'manual-flush', 0.7, NULL, '[]'::jsonb, ARRAY['memory-flush', 'decision', 'expect-delete'], NULL,
    '{}'::jsonb, 'active', CASE WHEN g % 2 = 0 THEN (SELECT v FROM vec) END, NOW()
  FROM generate_series(1, 2000) g
  UNION ALL
  SELECT 'Flush checkpoint ' || g, 'synthetic/cleanup', 'session-summary', 'episodic', 'manual-flush', 0.45, NULL,
    '[]'::jsonb, ARRAY['memory-flush', 'expect-delete'],
    NOW() + CASE WHEN g % 2 = 0 THEN INTERVAL '5 days' ELSE INTERVAL '-5 days' END, '{}'::jsonb, 'active', NULL, NOW()
  FROM generate_series(1, 500) g
  UNION ALL
  SELECT 'Flush root cause ' || g, 'synthetic/cleanup', 'root-cause', 'episodic', 'manual-flush', 0.7,
    'derived-memory:v1:synthetic-' || g, '[]'::jsonb, ARRAY['memory-flush', 'root-cause', 'expect-delete'], NULL,
    '{}'::jsonb, 'active', NULL, NOW()
  FROM generate_series(1, 100) g
  UNION ALL
  SELECT 'Flush reflection ' || g, 'synthetic/cleanup', 'reflective', 'reflective', 'manual-flush', 0.7, NULL,
    '[]'::jsonb, ARRAY['reflection', 'expect-delete'], NULL, '{}'::jsonb, 'active', NULL, NOW()
  FROM generate_series(1, 100) g
  UNION ALL
  SELECT 'codex-cli session summary ' || g, 'synthetic/cleanup', 'session-summary', 'episodic', 'codex-launchd',
    0.45, 'codex:synthetic-' || g || ':summary:v1', '[{"type":"transcript","path":"synthetic.jsonl"}]'::jsonb,
    ARRAY['auto', 'expect-delete'], NOW() + INTERVAL '3 days',
    '{"source_contract":"memory_delta@0.1"}'::jsonb, 'active', NULL, NOW()
  FROM generate_series(1, 300) g
  UNION ALL
  SELECT 'Expired synthetic session summary ' || g, 'synthetic/cleanup', 'session-summary', 'episodic', 'codex',
    0.4, NULL, '[]'::jsonb, ARRAY['expect-delete'], NOW() - INTERVAL '1 day', '{}'::jsonb, 'active', NULL, NOW()
  FROM generate_series(1, 20) g
  UNION ALL
  SELECT 'Flush fragment written after the backup.', 'synthetic/cleanup', 'decision', 'semantic', 'manual-flush',
    0.7, NULL, '[]'::jsonb, ARRAY['expect-keep'], NULL, '{}'::jsonb, 'active', NULL, NOW() + INTERVAL '3 hours'
) seed`;

// Lineage: a curated row supersedes F1, which supersedes F0, so both flush rows
// stay. F3 supersedes F2 and both are removable. In the other direction, flush
// row FR refined (superseded) curated row CR and FRR later replaced FR, so both
// stay as CR's replacements. FC is contested and stays for its pair. KF carries
// the flush source with a real key, so it is not a flush row.
const SEED_LINEAGE_SQL = `
WITH cr AS (
  INSERT INTO ai_memory_entries (content, category, memory_type, source, tags, memory_key, evidence_refs, status)
  VALUES ('Curated rule that a flush fragment refined.', 'decision', 'semantic', 'claude-code', ARRAY['expect-keep'],
    'synthetic/cleanup:refined', '["docs/operations.md"]'::jsonb, 'superseded')
  RETURNING id
), fr AS (
  INSERT INTO ai_memory_entries (content, category, memory_type, source, tags, supersedes_id, status)
  SELECT 'Flush refinement FR of the curated rule.', 'decision', 'semantic', 'manual-flush', ARRAY['expect-keep'], id,
    'superseded' FROM cr
  RETURNING id
), frr AS (
  INSERT INTO ai_memory_entries (content, category, memory_type, source, tags, supersedes_id)
  SELECT 'Flush refinement FRR that replaced FR.', 'decision', 'semantic', 'manual-flush', ARRAY['expect-keep'], id FROM fr
  RETURNING id
), fc AS (
  INSERT INTO ai_memory_entries (content, category, memory_type, source, tags, status)
  VALUES ('Contested flush fragment FC.', 'decision', 'semantic', 'manual-flush', ARRAY['expect-keep'], 'contested')
  RETURNING id
), kf AS (
  INSERT INTO ai_memory_entries (content, category, memory_type, source, tags, memory_key)
  VALUES ('Keyed row KF that carries the flush source.', 'decision', 'semantic', 'manual-flush', ARRAY['expect-keep'],
    'synthetic/cleanup:keyed-flush-source')
  RETURNING id
), f0 AS (
  INSERT INTO ai_memory_entries (content, category, memory_type, source, tags)
  VALUES ('Lineage flush root F0.', 'decision', 'semantic', 'manual-flush', ARRAY['expect-keep']) RETURNING id
), f1 AS (
  INSERT INTO ai_memory_entries (content, category, memory_type, source, tags, supersedes_id, status)
  SELECT 'Lineage flush F1.', 'decision', 'semantic', 'manual-flush', ARRAY['expect-keep'], id, 'superseded' FROM f0
  RETURNING id
), c1 AS (
  INSERT INTO ai_memory_entries (content, category, memory_type, source, tags, supersedes_id, memory_key, evidence_refs)
  SELECT 'Curated lineage fact that replaced a flush fragment.', 'decision', 'semantic', 'claude-code',
    ARRAY['expect-keep'], id, 'synthetic/cleanup:lineage', '["docs/operations.md"]'::jsonb FROM f1
  RETURNING id
), f2 AS (
  INSERT INTO ai_memory_entries (content, category, memory_type, source, tags)
  VALUES ('Lineage flush F2.', 'decision', 'semantic', 'manual-flush', ARRAY['expect-delete']) RETURNING id
)
INSERT INTO ai_memory_entries (content, category, memory_type, source, tags, supersedes_id)
SELECT 'Lineage flush F3.', 'decision', 'semantic', 'manual-flush', ARRAY['expect-delete'], id FROM f2`;

const SEED_SESSIONS_SQL = `
INSERT INTO ai_sessions (session_id, agent)
SELECT 'sess-a-' || s, 'codex-cli' FROM generate_series(1, 300) s
UNION ALL SELECT unnest(ARRAY['sess-b', 'sess-c', 'sess-d', 'sess-e', 'sess-f', 'sess-g']), 'synthetic';

-- 300 hook sessions with five old deltas each: only the latest delta and snapshot stay.
INSERT INTO ai_memory_deltas (delta_id, session_id, produced_by_agent, snapshot_mode, snapshot_json, raw_json, created_at)
SELECT 'a-' || s || '-' || k, 'sess-a-' || s, 'codex-cli', 'replace', jsonb_build_object('goal', repeat('g', 800)),
  jsonb_build_object('workflow', jsonb_build_object('system', 'codex-hook'), 'pad', repeat('x', 3000)),
  NOW() - INTERVAL '60 days' + k * INTERVAL '1 hour'
FROM generate_series(1, 300) s, generate_series(1, 5) k;

INSERT INTO ai_memory_deltas (delta_id, session_id, produced_by_agent, snapshot_mode, snapshot_json, raw_json, created_at)
VALUES
  ('b-1', 'sess-b', 'synthetic', 'replace', '{}', '{"workflow":{"system":"memory-flush"}}', NOW() - INTERVAL '60 days'),
  ('b-2', 'sess-b', 'synthetic', 'replace', '{}', '{"workflow":{"system":"memory-flush"}}', NOW() - INTERVAL '59 days'),
  ('b-3', 'sess-b', 'synthetic', 'replace', '{}', '{"workflow":{"system":"codex-hook"}}', NOW() - INTERVAL '58 days'),
  ('b-4', 'sess-b', 'synthetic', 'replace', '{}', '{"workflow":{"system":"codex-hook"}}', NOW() - INTERVAL '57 days'),
  ('c-1', 'sess-c', 'synthetic', 'replace', '{}', '{"workflow":{"system":"codex-hook"}}', NOW() - INTERVAL '5 days'),
  ('c-2', 'sess-c', 'synthetic', 'replace', '{}', '{"workflow":{"system":"codex-hook"}}', NOW() - INTERVAL '4 days'),
  ('c-3', 'sess-c', 'synthetic', 'replace', '{}', '{"workflow":{"system":"codex-hook"}}', NOW() - INTERVAL '3 days'),
  ('d-1', 'sess-d', 'synthetic', 'replace', '{}', '{}', NOW() - INTERVAL '60 days'),
  ('d-2', 'sess-d', 'synthetic', 'patch', '{"ops":[]}', '{}', NOW() - INTERVAL '59 days'),
  ('d-3', 'sess-d', 'synthetic', 'replace', '{}', '{}', NOW() - INTERVAL '58 days'),
  ('e-1', 'sess-e', 'synthetic', 'replace', '{}', '{}', NOW() - INTERVAL '60 days'),
  ('e-2', 'sess-e', 'synthetic', 'replace', '{}', '{}', NOW() - INTERVAL '40 days'),
  ('e-3', 'sess-e', 'synthetic', 'replace', '{}', '{}', NOW() - INTERVAL '2 days'),
  ('f-1', 'sess-f', 'synthetic', 'replace', '{}', '{}', NOW() - INTERVAL '60 days'),
  ('f-2', 'sess-f', 'synthetic', 'replace', '{}', '{}', NOW() - INTERVAL '59 days'),
  ('g-0', 'sess-g', 'synthetic', 'replace', '{"context_needed":["Read the synthetic fixture notes."]}',
    '{"workflow":{"system":"memory-flush"}}', NOW() - INTERVAL '61 days'),
  ('g-1', 'sess-g', 'synthetic', 'replace', '{"next_actions":["Resume the synthetic fixture."]}',
    '{"workflow":{"system":"memory-flush"}}', NOW() - INTERVAL '60 days'),
  ('g-2', 'sess-g', 'synthetic', 'replace', '{"next_actions":[]}', '{"workflow":{"system":"memory-flush"}}',
    NOW() - INTERVAL '59 days'),
  ('g-3', 'sess-g', 'synthetic', 'replace', '{}', '{"workflow":{"system":"codex-hook"}}', NOW() - INTERVAL '58 days');

-- A delta without a session is never removed.
INSERT INTO ai_memory_deltas (delta_id, session_id, produced_by_agent, snapshot_mode, snapshot_json, raw_json, created_at)
VALUES ('orphan-1', NULL, 'synthetic', 'replace', '{}', '{}', NOW() - INTERVAL '90 days');

-- One snapshot per delta except session F and the session-less delta.
INSERT INTO ai_session_snapshots (snapshot_id, session_id, snapshot_json, source_delta_id, created_at)
SELECT 'snap-' || delta_id, session_id, snapshot_json, delta_id, created_at
FROM ai_memory_deltas WHERE session_id <> 'sess-f';

INSERT INTO ai_session_events (event_id, session_id, event_type, summary, created_at)
SELECT 'evt-' || s || '-' || e, 'sess-a-' || s,
  CASE WHEN e = 1 THEN 'checkpoint' ELSE 'consolidation_metrics' END, 'Synthetic event', NOW() - INTERVAL '60 days'
FROM generate_series(1, 300) s, generate_series(1, 3) e;

INSERT INTO ai_memory_events (memory_id, event_type)
SELECT id, 'stored_via_memory_store' FROM ai_memory_entries;`;

const EXPECTED_DELETES = {
  // 2,000 decisions + F2/F3, 500 checkpoints, 100 root causes, 100 reflections,
  // 300 auto summaries and 20 expired summaries.
  ai_memory_entries: 3022,
  ai_memory_events: 3022,
  // Hook sessions lose four each; B loses b-1 and b-3; E loses e-1 and e-2.
  ai_session_snapshots: 1204,
  // The same, plus f-1 (F has no snapshots).
  ai_memory_deltas: 1205,
  ai_session_events: 600,
};

test(
  'cleanup removes exactly the dry-run rows, keeps every curated memory and its lineage, and needs a healthy backup',
  { skip: adminUrl === undefined, timeout: 0 },
  async () => {
    assert.ok(adminUrl);
    assertLocalDatabaseUrl(adminUrl);
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    const name = `cleanup_${randomUUID().replaceAll('-', '')}`;
    let created = false;
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    const pool = createPool({ connectionString: url.toString(), max: 2 });
    const backupAt = new Date(Date.now() + 2 * HOUR_MS).toISOString();
    const backupId = randomUUID();
    const databaseTarget = databaseTargetDigest(url.toString());
    const dependencies = (readBackupHealth: () => Promise<BackupHealth>) => ({
      databaseTarget,
      pool,
      readBackupHealth,
    });
    const healthy = (): Promise<BackupHealth> =>
      Promise.resolve({
        ageHours: 0,
        backupId,
        createdAt: backupAt,
        databaseTarget,
        lastAttempt: 'success',
        maxHours: 36,
        mode: 'local',
        state: 'healthy',
      });
    const missing = (): Promise<BackupHealth> =>
      Promise.resolve({
        ageHours: null,
        backupId: null,
        createdAt: null,
        databaseTarget: null,
        lastAttempt: 'missing',
        maxHours: 36,
        mode: null,
        state: 'missing',
      });
    try {
      await admin.query(`CREATE DATABASE ${quote(name)}`);
      created = true;
      await runAiMemoryMigrations(pool);
      await pool.query(SEED_ENTRIES_SQL);
      await pool.query(SEED_LINEAGE_SQL);
      await pool.query(SEED_SESSIONS_SQL);

      const keptBefore = await pool.query<{ id: string; row: unknown }>(
        "SELECT id, to_jsonb(m) AS row FROM ai_memory_entries m WHERE 'expect-keep' = ANY(tags) ORDER BY id",
      );
      assert.equal(keptBefore.rows.length, 45);
      const counts = async () => {
        const result = await pool.query<{ table_name: string; rows: string }>(
          `SELECT 'ai_memory_entries' AS table_name, count(*) AS rows FROM ai_memory_entries
           UNION ALL SELECT 'ai_memory_events', count(*) FROM ai_memory_events
           UNION ALL SELECT 'ai_session_snapshots', count(*) FROM ai_session_snapshots
           UNION ALL SELECT 'ai_memory_deltas', count(*) FROM ai_memory_deltas
           UNION ALL SELECT 'ai_session_events', count(*) FROM ai_session_events`,
        );
        return Object.fromEntries(result.rows.map(row => [row.table_name, Number(row.rows)]));
      };
      const before = await counts();

      const dryRun = await runCleanup({ apply: false, historyDays: 30, vacuumFull: false }, dependencies(healthy));
      assert.equal(dryRun.mode, 'dry-run');
      assert.deepEqual(dryRun.report.totals, EXPECTED_DELETES);
      assert.equal(dryRun.report.kept.entries, 45);
      assert.equal(dryRun.report.kept.lineageProtected, 5);
      // Active curated rows without a vector: 15 odd-numbered rules and the curated lineage fact.
      assert.equal(dryRun.report.kept.activeMissingEmbedding, 16);
      assert.deepEqual(
        dryRun.report.rows
          .filter(row => row.table === 'ai_memory_entries')
          .map(row => [row.reason, row.source, row.category, row.rows]),
        [
          ['flush_memory', 'manual-flush', 'decision', 2002],
          ['flush_memory', 'manual-flush', 'session-summary', 500],
          ['auto_session_summary', 'codex-launchd', 'session-summary', 300],
          ['flush_memory', 'manual-flush', 'reflective', 100],
          ['flush_memory', 'manual-flush', 'root-cause', 100],
          ['expired_session_summary', 'codex', 'session-summary', 20],
        ],
      );
      assert.deepEqual(await counts(), before, 'a dry run deletes nothing');

      await assert.rejects(
        runCleanup({ apply: true, backupId, historyDays: 30, vacuumFull: false }, dependencies(missing)),
        (error: unknown) => error instanceof CleanupRefusedError && /healthy backup/u.test(error.message),
      );
      assert.deepEqual(await counts(), before, 'a refused apply deletes nothing');

      await assert.rejects(
        runCleanup({ apply: true, backupId: randomUUID(), historyDays: 30, vacuumFull: false }, dependencies(healthy)),
        (error: unknown) => error instanceof CleanupRefusedError && /--backup-id does not match/u.test(error.message),
      );
      assert.deepEqual(await counts(), before, 'an apply for another backup deletes nothing');

      const applied = await runCleanup(
        { apply: true, backupId, historyDays: 30, vacuumFull: true },
        dependencies(healthy),
      );
      assert.equal(applied.mode, 'apply');
      assert.deepEqual(applied.report.rows, dryRun.report.rows, 'apply removes exactly the dry-run rows');
      const after = await counts();
      for (const [table, deleted] of Object.entries(EXPECTED_DELETES)) {
        assert.equal(before[table]! - after[table]!, deleted, table);
      }

      const keptAfter = await pool.query<{ id: string; row: unknown }>(
        "SELECT id, to_jsonb(m) AS row FROM ai_memory_entries m WHERE 'expect-keep' = ANY(tags) ORDER BY id",
      );
      assert.deepEqual(keptAfter.rows, keptBefore.rows, 'every kept memory is unchanged, lineage included');
      const leftover = await pool.query("SELECT id FROM ai_memory_entries WHERE 'expect-delete' = ANY(tags)");
      assert.equal(leftover.rows.length, 0);
      const resumeState = await pool.query<{ session_id: string; snapshots: string; deltas: string }>(
        `SELECT s.session_id,
           (SELECT count(*) FROM ai_session_snapshots x WHERE x.session_id = s.session_id) AS snapshots,
           (SELECT count(*) FROM ai_memory_deltas d WHERE d.session_id = s.session_id) AS deltas
         FROM ai_sessions s
         WHERE s.session_id IN ('sess-a-1', 'sess-b', 'sess-c', 'sess-d', 'sess-e', 'sess-f', 'sess-g')
         ORDER BY s.session_id`,
      );
      assert.deepEqual(
        resumeState.rows.map(row => [row.session_id, Number(row.snapshots), Number(row.deltas)]),
        [
          ['sess-a-1', 1, 1],
          ['sess-b', 2, 2],
          ['sess-c', 3, 3],
          ['sess-d', 3, 3],
          ['sess-e', 1, 1],
          ['sess-f', 0, 1],
          // g-0 and g-1 stay: carry-forward still reads their fields behind the empty g-2.
          ['sess-g', 4, 4],
        ],
      );
      const sessB = await pool.query<{ snapshot_id: string }>(
        "SELECT snapshot_id FROM ai_session_snapshots WHERE session_id = 'sess-b' ORDER BY snapshot_id",
      );
      assert.deepEqual(
        sessB.rows.map(row => row.snapshot_id),
        ['snap-b-2', 'snap-b-4'],
        'the latest snapshot and the latest flush snapshot stay',
      );

      const again = await runCleanup({ apply: false, historyDays: 30, vacuumFull: false }, dependencies(healthy));
      assert.deepEqual(Object.values(again.report.totals), [0, 0, 0, 0, 0], 'a second run finds nothing to delete');

      assert.ok(applied.sizesAfter !== undefined);
      for (const table of ['ai_memory_entries', 'ai_memory_deltas', 'ai_session_snapshots']) {
        assert.ok(applied.sizesAfter[table]! < applied.sizesBefore[table]!, `${table} shrinks after VACUUM FULL`);
      }
      console.log(
        JSON.stringify({
          fixture: 'corpus-cleanup',
          rowsBefore: before,
          rowsAfter: after,
          bytesBefore: applied.sizesBefore,
          bytesAfter: applied.sizesAfter,
        }),
      );
    } finally {
      await pool.end().catch(() => undefined);
      try {
        if (created) await admin.query(`DROP DATABASE ${quote(name)} WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
  },
);
