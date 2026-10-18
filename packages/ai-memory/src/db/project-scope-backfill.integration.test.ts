import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, vi } from 'vitest';

import {
  createDurableMemoryKey,
  createFlushSessionDecisionDedupeHash,
  createMemoryDedupeHash,
  stableJsonHash,
} from './hashing.js';
import { getMemoryEntries, searchMemories, storeMemoryWithAuditEvent } from './memory-api.js';
import { getContinuityPack } from './continuity-pack-api.js';
import { getSessionProject } from './session-api.js';
import { assertLocalDatabaseUrl, createPool, type DbPool } from './pool.js';
import {
  applyProjectScopeBackfill,
  createProjectScopeBackfillPlan,
  type BackfillSelectors,
} from './project-scope-backfill.js';
import { runAiMemoryMigrations } from './run-migrations.js';
import { pool as runtimePool } from './runtime.js';
import { flushSession } from '../tools/ingestion/flush-session.js';

// Never inherit the installed database merely to make these fixtures runnable.
const databaseUrl = process.env.AI_MEMORY_PROJECT_IDENTITY_TEST_URL;
const selectors: BackfillSelectors = { legacyProject: 'widget', limit: 200, project: 'demo-workshop/widget' };
const decision = 'Retry this synthetic fixture only after checking its recorded input.';

interface Fixture {
  admin: DbPool;
  pool: DbPool;
  schema: string;
}
async function fixture(run: (value: Fixture) => Promise<void>) {
  assert.ok(databaseUrl);
  assertLocalDatabaseUrl(databaseUrl);
  assert.match(new URL(databaseUrl).pathname, /^\/ai_memory_project_identity_(ci|test)$/u);
  const schema = `scope_${randomUUID().replaceAll('-', '')}`;
  const marker = `criterion4:${schema}`;
  const admin = createPool({ connectionString: databaseUrl });
  const pool = createPool({ connectionString: databaseUrl, pgOptions: { options: `-c search_path=${schema},public` } });
  let created = false;
  let oid: string | undefined;
  try {
    // Fixture setup owns initialization. The maintenance command never calls it.
    await runAiMemoryMigrations(admin);
    await admin.query(`CREATE SCHEMA ${schema}`);
    created = true;
    await admin.query(`COMMENT ON SCHEMA ${schema} IS '${marker}'`);
    oid = (await admin.query<{ oid: string }>('SELECT oid::text FROM pg_namespace WHERE nspname=$1', [schema])).rows[0]
      ?.oid;
    const client = await pool.connect();
    try {
      for (const name of (await readdir(new URL('../../migrations/', import.meta.url)))
        .filter(name => name.endsWith('.sql'))
        .sort())
        // Baseline guards predate schema-isolated fixtures. Scope their catalog
        // existence checks to this fixture so public constraints cannot mask it.
        await client.query(
          (await readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8')).replaceAll(
            'WHERE conname =',
            'WHERE connamespace = current_schema()::regnamespace AND conname =',
          ),
        );
    } finally {
      client.release();
    }
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No provider calls in synthetic scope fixtures.'));
    await run({ admin, pool, schema });
  } finally {
    vi.restoreAllMocks();
    await pool.end();
    try {
      if (created) {
        const owned = (
          await admin.query<{ owned: boolean }>(
            `SELECT oid::text=$2 AND nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
            AND obj_description(oid,'pg_namespace')=$3 AS owned FROM pg_namespace WHERE nspname=$1`,
            [schema, oid, marker],
          )
        ).rows[0]?.owned;
        assert.equal(owned, true, 'fixture schema ownership must still match before teardown');
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        assert.equal((await admin.query('SELECT oid FROM pg_namespace WHERE nspname=$1', [schema])).rowCount, 0);
      }
    } finally {
      await admin.end();
    }
  }
}

async function seed(pool: DbPool, sessionId = 'Host-Session') {
  await pool.query(
    `INSERT INTO ai_sessions (session_id,repo_id,repo_slug,agent,task_id,metadata_json)
    VALUES ($1,'widget','demo-workshop/widget','codex','logical:task','{"fixture":true}')`,
    [sessionId],
  );
  const keyedInput = {
    category: 'architecture',
    content: 'Keep this generated synthetic fact and its original key.',
    project: 'widget',
    repoSlug: selectors.project,
    sensitivity: 'internal',
    tags: ['fixture'],
  };
  const generatedKey = createDurableMemoryKey(keyedInput);
  const ordinaryInput = {
    category: 'decision',
    content: 'Keep a reproducible ordinary synthetic identity.',
    project: 'widget',
    sensitivity: 'internal',
    tags: ['fixture'],
  };
  const privateHash = createFlushSessionDecisionDedupeHash(
    createMemoryDedupeHash({
      category: 'decision',
      content: decision,
      project: 'widget',
      sensitivity: 'internal',
      tags: ['memory-flush', 'decision'],
    }),
    sessionId,
  );
  await pool.query(
    `INSERT INTO ai_memory_entries
    (content,project,category,memory_key,dedupe_hash,session_id,repo_slug,tags,source,memory_type,status,expires_at,metadata_json)
    VALUES ($1,'widget','architecture',$2,NULL,$3,$4,ARRAY['fixture'],'codex','semantic','active',NULL,'{"fixture":true}'),
    ('Preserve the explicit synthetic key.','widget','architecture','fact:explicit',NULL,$3,$4,ARRAY['fixture'],'codex','semantic','active',NULL,'{}'),
    ($5,'widget','decision',NULL,$6,$3,NULL,ARRAY['fixture'],'codex','semantic','active',NULL,'{}'),
    ($7,'widget','decision',NULL,$8,$3,NULL,ARRAY['memory-flush','decision'],'codex','episodic','expired','2026-01-15T00:00:00Z','{"native":true}'),
    ('Unknown scope remains isolated.','widget','architecture','fact:unknown',NULL,NULL,NULL,ARRAY[]::text[],'claude','semantic','active',NULL,'{}'),
    ('Foreign scope remains isolated.','widget','architecture','fact:foreign',NULL,NULL,'another/widget',ARRAY[]::text[],'grok','semantic','active',NULL,'{}')`,
    [
      keyedInput.content,
      generatedKey,
      sessionId,
      selectors.project,
      ordinaryInput.content,
      createMemoryDedupeHash(ordinaryInput),
      decision,
      privateHash,
    ],
  );
  await pool.query(
    `INSERT INTO ai_memory_entries(content,project,category,memory_key,session_id,source,memory_type)
    VALUES ('Preserve a historical NULL unkeyed identity.','widget','architecture',NULL,$1,'codex','semantic'),
    ('Retain the existing canonical scope fact.','demo-workshop/widget','architecture','fact:canonical',NULL,'grok','semantic')`,
    [sessionId],
  );
  await pool.query(`INSERT INTO ai_continuity_packs(scope_key,project,source,pack_json)
    VALUES ('task:demo-workshop/widget:prior:task','demo-workshop/widget','grok','{"summary":"Original canonical checkpoint."}')`);
  for (const [type, id] of [
    ['project', undefined],
    ['task', 'logical:task'],
    ['lead', 'lead:id'],
    ['outcome', 'outcome:id'],
  ] as const) {
    const scope = id === undefined ? { type } : { id, type };
    const key = id === undefined ? 'project:widget' : `${type}:widget:${id}`;
    await pool.query(
      `INSERT INTO ai_continuity_packs (scope_key,project,session_id,source,pack_json)
      VALUES ($1,'widget',$2,'codex',$3)`,
      [
        key,
        sessionId,
        JSON.stringify({
          provenance: { scope, sessionId, source: 'codex' },
          summary: 'Synthetic preserved checkpoint.',
        }),
      ],
    );
  }
  await pool.query(
    `UPDATE ai_memory_entries SET supersedes_id=(SELECT id FROM ai_memory_entries WHERE memory_key=$1),
    evidence_refs='["synthetic://original-fact"]'::jsonb WHERE memory_key='fact:explicit'`,
    [generatedKey],
  );
  await pool.query(
    `INSERT INTO ai_context_packs(pack_id,session_id,produced_by_agent,tenancy_json,task_json,raw_json,created_at)
    VALUES ('synthetic-context',$1,'codex','{"repo_id":"widget"}','{"task_id":"logical:task"}','{"project":"widget","original":true}','2026-01-01T00:00:00Z')`,
    [sessionId],
  );
  await pool.query(
    `INSERT INTO ai_memory_deltas(delta_id,session_id,produced_by_agent,snapshot_mode,snapshot_json,tenancy_json,raw_json,created_at)
    VALUES ('synthetic-delta',$1,'codex','replace','{}','{"repo_id":"widget"}','{"project":"widget","original":true}','2026-01-01T00:00:00Z')`,
    [sessionId],
  );
  await pool.query(
    `INSERT INTO ai_session_snapshots(snapshot_id,session_id,snapshot_json,source_delta_id)
    VALUES ('synthetic-snapshot',$1,'{"project":"widget","original":true}','synthetic-delta')`,
    [sessionId],
  );
  return { generatedKey, keyedInput };
}

async function snapshot(pool: DbPool) {
  const result: Record<string, unknown> = {};
  for (const [table, key] of [
    ['ai_memory_entries', 'id'],
    ['ai_sessions', 'session_id'],
    ['ai_continuity_packs', 'scope_key'],
    ['ai_memory_events', 'id'],
    ['ai_session_events', 'event_id'],
    ['ai_ingestion_failures', 'id'],
    ['ai_context_packs', 'pack_id'],
    ['ai_memory_deltas', 'delta_id'],
    ['ai_session_snapshots', 'snapshot_id'],
  ] as const)
    result[table] = (await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY ${key}`)).rows;
  const sequences = (
    await pool.query<{ sequencename: string }>(
      'SELECT sequencename FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename',
    )
  ).rows;
  for (const row of sequences)
    result[row.sequencename] = (await pool.query(`SELECT last_value::text,is_called FROM ${row.sequencename}`)).rows;
  return result;
}

test(
  'generalized scope backfill preserves keys, native provenance and first-expiry flush replay',
  { skip: databaseUrl === undefined, timeout: 0 },
  async () => {
    await fixture(async ({ pool }) => {
      const { generatedKey, keyedInput } = await seed(pool);
      const before = await pool.query<{ row: Record<string, unknown> }>(
        'SELECT to_jsonb(m) AS row FROM ai_memory_entries m ORDER BY id',
      );
      const beforePacks = await pool.query<{ pack_json: unknown }>(
        'SELECT pack_json FROM ai_continuity_packs ORDER BY scope_key',
      );
      const unchanged = await snapshot(pool);
      const plan = await createProjectScopeBackfillPlan({ pool, selectors });
      assert.equal(plan.status, 'ready');
      assert.deepEqual(await snapshot(pool), unchanged, 'default plan has no table or sequence effects');
      assert.equal(plan.counts.unknown, 1);
      assert.equal(plan.counts.foreign, 1);
      assert.equal(JSON.stringify(plan).includes(keyedInput.content), false);
      assert.equal((await applyProjectScopeBackfill({ pool, plan, expectedDigest: plan.digest })).status, 'applied');
      const after = await pool.query<{ row: Record<string, unknown> }>(
        'SELECT to_jsonb(m) AS row FROM ai_memory_entries m ORDER BY id',
      );
      const afterSnapshot = await snapshot(pool);
      for (const table of ['ai_context_packs', 'ai_memory_deltas', 'ai_session_snapshots'])
        assert.deepEqual(
          afterSnapshot[table],
          unchanged[table],
          'historical native payloads remain byte-equivalent JSON',
        );
      assert.equal(after.rowCount, before.rowCount);
      for (let index = 0; index < before.rows.length; index++) {
        const old = before.rows[index]!.row;
        const current = after.rows[index]!.row;
        const eligible = old.session_id === 'Host-Session';
        assert.equal(current.project, eligible || old.project === selectors.project ? selectors.project : 'widget');
        const { project: _oldProject, dedupe_hash: _oldHash, search_vector: _oldVector, ...oldStable } = old;
        const { project: _newProject, dedupe_hash: _newHash, search_vector: _newVector, ...newStable } = current;
        assert.deepEqual(newStable, oldStable);
        if (old.memory_key != null || old.dedupe_hash == null) assert.equal(current.dedupe_hash, old.dedupe_hash);
      }
      assert.deepEqual(
        (await pool.query<{ pack_json: unknown }>('SELECT pack_json FROM ai_continuity_packs')).rows
          .map(row => JSON.stringify(row.pack_json))
          .sort(),
        beforePacks.rows.map(row => JSON.stringify(row.pack_json)).sort(),
      );
      assert.equal(
        (await pool.query<{ task_id: string; repo_id: string }>('SELECT task_id,repo_id FROM ai_sessions')).rows[0]
          ?.task_id,
        'logical:task',
      );
      assert.equal(
        (
          await pool.query<{ count: string }>('SELECT count(*) FROM ai_continuity_packs WHERE scope_key=$1', [
            'task:demo-workshop/widget:logical:task',
          ])
        ).rows[0]?.count,
        '1',
      );
      const futureKey = createDurableMemoryKey({ ...keyedInput, project: selectors.project });
      assert.notEqual(futureKey, generatedKey, 'historical generated-key limitation must be visible');
      assert.ok(plan.changes.some(change => change.prospectiveKey === futureKey));
      const unit = (
        await pool.query<{ payload_json: { changes: { id: string; table: string; to: { scope_key?: string } }[] } }>(
          `SELECT payload_json FROM ai_session_events WHERE event_type='project-scope-backfill-unit:v1'`,
        )
      ).rows[0]?.payload_json;
      assert.ok(
        unit?.changes.some(
          change =>
            change.table === 'continuity' &&
            change.id === 'task:widget:logical:task' &&
            change.to.scope_key === 'task:demo-workshop/widget:logical:task',
        ),
      );
      assert.equal(
        (await pool.query('SELECT id FROM ai_memory_entries WHERE memory_key=$1', [generatedKey])).rowCount,
        1,
      );
      const keyedId = before.rows.find(({ row }) => row.memory_key === generatedKey)?.row.id;
      assert.ok(keyedId);
      const explicitClient = await pool.connect();
      try {
        await explicitClient.query('BEGIN');
        const retained = await storeMemoryWithAuditEvent(explicitClient, {
          ...keyedInput,
          memoryKey: generatedKey,
          project: selectors.project,
          sessionId: 'Host-Session',
          evidenceRefs: ['synthetic://original-fact'],
          source: 'codex',
        });
        assert.equal(retained.id, Number(keyedId));
        assert.equal(retained.memoryKey, generatedKey);
        assert.equal(retained.memoryType, 'semantic');
        await explicitClient.query('COMMIT');
      } catch (error) {
        await explicitClient.query('ROLLBACK');
        throw error;
      } finally {
        explicitClient.release();
      }
      const privateBeforeReplay = (
        await pool.query<{ row: unknown }>(
          `SELECT to_jsonb(m) AS row FROM ai_memory_entries m WHERE dedupe_hash LIKE 'flush-session-decision:v1:%'`,
        )
      ).rows;
      vi.spyOn(runtimePool, 'connect').mockImplementation(() => pool.connect());
      vi.spyOn(runtimePool, 'query').mockImplementation((sql, params) => pool.query(sql, params));
      await flushSession(
        {
          decisions: [decision],
          nextActions: ['Verify the synthetic checkpoint.'],
          project: 'widget',
          sessionId: 'Host-Session',
          source: 'codex',
          summary:
            'Preserve the synthetic checkpoint, including its original identifiers, native source and first expiry, before continuing verification.',
          task: 'logical:task',
        },
        {
          getEmbedding: () => Promise.resolve(null),
          getSessionProject,
          isEmbeddingAvailable: () => false,
          pool,
          now: () => new Date('2026-10-18T00:00:00Z'),
          refreshContinuityPack: () => Promise.resolve({ reason: 'missing_project', status: 'skipped' }),
          runReflection: () => Promise.resolve({ reflectionResult: undefined, storedMemories: [] }),
        },
      );
      assert.deepEqual(
        (
          await pool.query(
            `SELECT to_jsonb(m) AS row FROM ai_memory_entries m WHERE dedupe_hash LIKE 'flush-session-decision:v1:%'`,
          )
        ).rows,
        privateBeforeReplay,
      );
      const found = await searchMemories({
        project: selectors.project,
        query: 'generated synthetic fact',
        includeEmbedding: false,
        limit: 20,
      });
      assert.ok(found.some(row => row.memoryKey === generatedKey));
      assert.ok(found.every(row => row.project === selectors.project));
      const legacyEntries = await getMemoryEntries({
        ids: before.rows.map(({ row }) => Number(row.id)),
        project: 'widget',
      });
      assert.deepEqual(
        legacyEntries.map(row => row.id),
        before.rows
          .filter(({ row }) => row.project === 'widget' && row.session_id !== 'Host-Session')
          .map(({ row }) => Number(row.id)),
      );
      assert.ok(legacyEntries.every(row => row.sessionId !== 'Host-Session'));
      const checkpoint = await getContinuityPack({ project: selectors.project, task: 'logical:task' });
      assert.equal(checkpoint.status, 'found');
      if (checkpoint.status === 'found') assert.equal(checkpoint.pack.sessionId, 'Host-Session');
      // Flush appends ordinary native session events, so verify unit replay before
      // deliberately exercising post-migration runtime writes in a separate case.
    });
  },
);

test(
  'keyed historical hashes never expand an exact-session unit into another session',
  { skip: databaseUrl === undefined, timeout: 0 },
  async () => {
    await fixture(async ({ pool }) => {
      await pool.query(`INSERT INTO ai_sessions(session_id,repo_id,repo_slug,agent)
        VALUES ('Session-A','widget','demo-workshop/widget','codex'),
        ('Session-B','widget','demo-workshop/widget','grok')`);
      const input = {
        category: 'architecture',
        content: 'Synthetic shared historical identity.',
        project: 'widget',
        repoSlug: selectors.project,
        tags: [],
        sensitivity: 'internal',
      };
      const historicalHash = createMemoryDedupeHash(input);
      const canonicalHash = createMemoryDedupeHash({ ...input, project: selectors.project });
      await pool.query(
        `INSERT INTO ai_memory_entries(content,category,project,repo_slug,memory_key,dedupe_hash,session_id,memory_type)
        VALUES ($1,'architecture','widget',$2,'fact:A',$3,'Session-A','semantic'),
        ($1,'architecture','widget',$2,NULL,$3,'Session-B','semantic'),
        ($1,'architecture',$2,$2,NULL,$4,NULL,'semantic')`,
        [input.content, selectors.project, historicalHash, canonicalHash],
      );
      const untouched = (
        await pool.query(`SELECT to_jsonb(t) AS row FROM ai_memory_entries t
        WHERE memory_key IS NULL ORDER BY id`)
      ).rows;
      const a = await createProjectScopeBackfillPlan({ pool, selectors: { ...selectors, sessionId: 'Session-A' } });
      assert.equal(a.status, 'ready');
      assert.equal(a.changes.filter(change => change.table === 'memory').length, 1);
      await applyProjectScopeBackfill({ pool, plan: a, expectedDigest: a.digest });
      assert.deepEqual(
        (
          await pool.query(`SELECT to_jsonb(t) AS row FROM ai_memory_entries t
        WHERE memory_key IS NULL ORDER BY id`)
        ).rows,
        untouched,
      );
      const before = await snapshot(pool);
      const b = await createProjectScopeBackfillPlan({ pool, selectors: { ...selectors, sessionId: 'Session-B' } });
      assert.equal(b.status, 'refused');
      assert.ok(b.refusals.some(reason => reason.code === 'dedupe_collision'));
      assert.deepEqual(await snapshot(pool), before);
    });
  },
);

test.each(['continuity', 'key', 'dedupe', 'mixed', 'pack-project', 'unknown-hash', 'malformed-private', 'bound'])(
  'backfill refuses %s conflict without row, audit or sequence changes',
  { skip: databaseUrl === undefined, timeout: 0 },
  async kind => {
    await fixture(async ({ pool }) => {
      const seeded = await seed(pool);
      if (kind === 'continuity')
        await pool.query(`INSERT INTO ai_continuity_packs(scope_key,project,session_id,source,pack_json)
        VALUES ('task:demo-workshop/widget:logical:task','demo-workshop/widget','Host-Session','codex','{"different":true}')`);
      if (kind === 'key')
        await pool.query(
          `INSERT INTO ai_memory_entries(content,category,project,memory_key,memory_type)
        VALUES ('A synthetic canonical key is already occupied.','architecture','other/widget',$1,'semantic')`,
          [createDurableMemoryKey({ ...seeded.keyedInput, project: selectors.project })],
        );
      if (kind === 'dedupe')
        await pool.query(
          `INSERT INTO ai_memory_entries(content,category,project,dedupe_hash,tags,sensitivity,memory_type)
        VALUES ('Keep a reproducible ordinary synthetic identity.','decision',$1,$2,ARRAY['fixture'],'internal','semantic')`,
          [
            selectors.project,
            createMemoryDedupeHash({
              category: 'decision',
              content: 'Keep a reproducible ordinary synthetic identity.',
              project: selectors.project,
              sensitivity: 'internal',
              tags: ['fixture'],
            }),
          ],
        );
      if (kind === 'mixed')
        await pool.query(
          `UPDATE ai_memory_entries SET repo_slug=$1,repo_id='foreign.example/other/widget' WHERE memory_key='fact:unknown'`,
          [selectors.project],
        );
      if (kind === 'pack-project')
        await pool.query(
          `UPDATE ai_continuity_packs SET project='other/widget',scope_key='task:other/widget:logical:task' WHERE scope_key='task:widget:logical:task'`,
        );
      if (kind === 'unknown-hash')
        await pool.query(
          `UPDATE ai_memory_entries SET dedupe_hash='unknown:v9' WHERE memory_key IS NULL AND memory_type='semantic'`,
        );
      if (kind === 'malformed-private')
        await pool.query(`UPDATE ai_memory_entries SET expires_at=NULL WHERE memory_type='episodic'`);
      const before = await snapshot(pool);
      const plan = await createProjectScopeBackfillPlan({
        pool,
        selectors: kind === 'bound' ? { ...selectors, limit: 2 } : selectors,
      });
      assert.equal(plan.status, 'refused');
      await assert.rejects(
        () => applyProjectScopeBackfill({ pool, plan, expectedDigest: plan.digest }),
        /unapproved_plan/u,
      );
      assert.deepEqual(await snapshot(pool), before);
    });
  },
);

test.each(['index', 'index-shape', 'generated-column', 'generated-expression', 'type', 'constraint'])(
  'preexisting required schema damage refuses a dry-run: %s',
  { skip: databaseUrl === undefined, timeout: 0 },
  async damage => {
    await fixture(async ({ pool }) => {
      await seed(pool);
      if (damage === 'index' || damage === 'index-shape')
        await pool.query('DROP INDEX ai_memory_entries_memory_key_uidx');
      if (damage === 'index-shape')
        await pool.query('CREATE UNIQUE INDEX ai_memory_entries_memory_key_uidx ON ai_memory_entries(content)');
      if (damage === 'generated-column' || damage === 'generated-expression')
        await pool.query('ALTER TABLE ai_memory_entries DROP COLUMN search_vector');
      if (damage === 'generated-expression')
        await pool.query(
          "ALTER TABLE ai_memory_entries ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple',content)) STORED",
        );
      if (damage === 'type') await pool.query('ALTER TABLE ai_sessions ALTER COLUMN repo_id TYPE varchar');
      if (damage === 'constraint')
        await pool.query('ALTER TABLE ai_memory_entries DROP CONSTRAINT ai_memory_entries_sensitivity_check');
      const before = await snapshot(pool);
      await assert.rejects(() => createProjectScopeBackfillPlan({ pool, selectors }), /incompatible_schema/u);
      assert.deepEqual(await snapshot(pool), before);
    });
  },
);

test.each([
  "CREATE OR REPLACE FUNCTION ai_memory_tags_to_search_text(tags text[]) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$ SELECT 'incompatible'::text $$",
  "CREATE OR REPLACE FUNCTION ai_memory_reference_search_terms(memory_content text,memory_key text,memory_evidence jsonb,memory_tags text[]) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 'incompatible'::text $$",
  'CREATE OR REPLACE FUNCTION prevent_event_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$',
])(
  'preexisting or changed stored helper refuses planning and apply: %s',
  { skip: databaseUrl === undefined, timeout: 0 },
  async replacement => {
    await fixture(async ({ pool }) => {
      await seed(pool);
      const plan = await createProjectScopeBackfillPlan({ pool, selectors });
      await pool.query(replacement);
      const before = await snapshot(pool);
      await assert.rejects(() => createProjectScopeBackfillPlan({ pool, selectors }), /incompatible_schema/u);
      await assert.rejects(
        () => applyProjectScopeBackfill({ pool, plan, expectedDigest: plan.digest }),
        /incompatible_schema/u,
      );
      assert.deepEqual(await snapshot(pool), before);
    });
  },
);

test(
  'native JSONB precision changes refuse stale apply and committed replay before writing',
  { skip: databaseUrl === undefined, timeout: 0 },
  async () => {
    await fixture(async ({ pool }) => {
      await seed(pool);
      for (const completed of [false, true]) {
        await pool.query(
          `UPDATE ai_sessions SET metadata_json='{"counter":9007199254740992}' WHERE session_id='Host-Session'`,
        );
        const plan = await createProjectScopeBackfillPlan({ pool, selectors });
        if (completed) await applyProjectScopeBackfill({ pool, plan, expectedDigest: plan.digest });
        await pool.query(
          `UPDATE ai_sessions SET metadata_json='{"counter":9007199254740993}' WHERE session_id='Host-Session'`,
        );
        const before = await snapshot(pool);
        await assert.rejects(
          () => applyProjectScopeBackfill({ pool, plan, expectedDigest: plan.digest }),
          /native_numeric_precision/u,
        );
        await assert.rejects(() => createProjectScopeBackfillPlan({ pool, selectors }), /native_numeric_precision/u);
        assert.deepEqual(await snapshot(pool), before);
        assert.match(
          (
            await pool.query<{ value: string }>(
              "SELECT metadata_json::text AS value FROM ai_sessions WHERE session_id='Host-Session'",
            )
          ).rows[0]!.value,
          /9007199254740993/u,
        );
      }
    });
  },
);

test(
  'committed replay refuses oversized observed native rows before transferring their JSON',
  { skip: databaseUrl === undefined, timeout: 0 },
  async () => {
    await fixture(async ({ pool }) => {
      await seed(pool);
      const plan = await createProjectScopeBackfillPlan({ pool, selectors });
      await applyProjectScopeBackfill({ pool, plan, expectedDigest: plan.digest });
      await pool.query(
        `UPDATE ai_sessions SET metadata_json=jsonb_build_object('large',repeat('x',33*1024*1024)) WHERE session_id='Host-Session'`,
      );
      const compactState = async () =>
        (
          await pool.query(`SELECT md5(metadata_json::text) AS fingerprint,
        (SELECT count(*)::text FROM ai_memory_events) AS memory_events,
        (SELECT count(*)::text FROM ai_session_events) AS session_events
        FROM ai_sessions WHERE session_id='Host-Session'`)
        ).rows;
      const before = await compactState();
      let boundedRefusal = false;
      const inspected: DbPool = {
        ...pool,
        async connect() {
          const client = await pool.connect();
          return {
            async query<T>(sql: string, params?: unknown[]) {
              const result = await client.query<T>(sql, params);
              if (sql.includes('FROM ai_sessions t') && sql.includes('WITH selected')) {
                const rows = result.rows as { row: string | null }[];
                boundedRefusal = rows.some(row => row.row === null);
                assert.ok(rows.every(row => row.row === null));
              }
              return result;
            },
            release: (error?: boolean | Error) => {
              client.release(error);
            },
          };
        },
      };
      await assert.rejects(
        () => applyProjectScopeBackfill({ pool: inspected, plan, expectedDigest: plan.digest }),
        /oversized_input_unit/u,
      );
      assert.equal(boundedRefusal, true);
      assert.deepEqual(await compactState(), before);
    });
  },
);

test(
  'exact committed plans replay without duplicate audit and incompatible identity or timestamps refuse',
  { skip: databaseUrl === undefined, timeout: 0 },
  async () => {
    await fixture(async ({ pool }) => {
      await seed(pool);
      const plan = await createProjectScopeBackfillPlan({ pool, selectors });
      await applyProjectScopeBackfill({ pool, plan, expectedDigest: plan.digest });
      const completed = await snapshot(pool);
      assert.equal((await applyProjectScopeBackfill({ pool, plan, expectedDigest: plan.digest })).status, 'skipped');
      assert.deepEqual(await snapshot(pool), completed);
      const { digest: _old, ...changed } = { ...plan, identity: { ...plan.identity, code: 'f'.repeat(64) } };
      const differentCode = { ...changed, digest: stableJsonHash(changed) };
      await assert.rejects(
        () => applyProjectScopeBackfill({ pool, plan: differentCode, expectedDigest: differentCode.digest }),
        /incompatible_plan_identity/u,
      );
      assert.deepEqual(await snapshot(pool), completed);
      await pool.query(
        `UPDATE ai_sessions SET updated_at=updated_at+interval '1 second' WHERE session_id='Host-Session'`,
      );
      const edited = await snapshot(pool);
      await assert.rejects(
        () => applyProjectScopeBackfill({ pool, plan, expectedDigest: plan.digest }),
        /incompatible_post_state/u,
      );
      assert.deepEqual(await snapshot(pool), edited);
      await pool.query('ALTER TABLE ai_sessions ADD COLUMN synthetic_schema_stamp text');
      const changedSchema = await snapshot(pool);
      await assert.rejects(
        () => applyProjectScopeBackfill({ pool, plan, expectedDigest: plan.digest }),
        /incompatible_plan_identity/u,
      );
      assert.deepEqual(await snapshot(pool), changedSchema);
    });
  },
);

test(
  'stale timestamp, busy lock and globally occupied completion identity refuse before writes',
  { skip: databaseUrl === undefined, timeout: 0 },
  async () => {
    await fixture(async ({ pool }) => {
      await seed(pool);
      let plan = await createProjectScopeBackfillPlan({ pool, selectors });
      await pool.query(
        `UPDATE ai_memory_entries SET updated_at=updated_at+interval '1 second' WHERE memory_key='fact:explicit'`,
      );
      let before = await snapshot(pool);
      await assert.rejects(() => applyProjectScopeBackfill({ pool, plan, expectedDigest: plan.digest }), /stale_plan/u);
      assert.deepEqual(await snapshot(pool), before);
      plan = await createProjectScopeBackfillPlan({ pool, selectors });
      const lock = await pool.connect();
      try {
        await lock.query('BEGIN');
        await lock.query('LOCK TABLE ai_memory_entries IN ROW EXCLUSIVE MODE');
        before = await snapshot(pool);
        await assert.rejects(
          () => applyProjectScopeBackfill({ pool, plan, expectedDigest: plan.digest }),
          error => typeof error === 'object' && error !== null && 'code' in error && error.code === '55P03',
        );
        assert.deepEqual(await snapshot(pool), before);
      } finally {
        await lock.query('ROLLBACK');
        lock.release();
      }
      await pool.query(
        `INSERT INTO ai_sessions(session_id,repo_id,agent) VALUES ('Other-Session','other/widget','grok')`,
      );
      await pool.query(
        `INSERT INTO ai_session_events(event_id,session_id,event_type,summary,payload_json)
      VALUES ($1,'Other-Session','project-scope-backfill-unit:v1','Conflicting synthetic unit.','{}')`,
        [`project-scope-backfill:v1:${plan.digest}`],
      );
      before = await snapshot(pool);
      await assert.rejects(
        () => applyProjectScopeBackfill({ pool, plan, expectedDigest: plan.digest }),
        /conflicting_completion/u,
      );
      assert.deepEqual(await snapshot(pool), before);
      // Existing events are append-only; do not update one to manufacture another case.
    });
  },
);

test(
  'audited store refuses contradictory raw claims before insertion and preserves compatible enrichment',
  { skip: databaseUrl === undefined, timeout: 0 },
  async () => {
    await fixture(async ({ pool }) => {
      await pool.query(
        `INSERT INTO ai_sessions(session_id,repo_id,repo_slug,agent) VALUES ('Host-Session','demo-workshop/widget','demo-workshop/widget','codex')`,
      );
      for (const claims of [
        { repoId: 'foreign.example/other/widget' },
        { repoSlug: 'foreign.example/other/widget' },
        { repoId: 'opaque', repoSlug: 'foreign.example/other/widget' },
      ]) {
        const before = await snapshot(pool);
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await assert.rejects(
            () =>
              storeMemoryWithAuditEvent(client, {
                ...claims,
                category: 'decision',
                content: 'Keep this synthetic native foreign assertion isolated.',
                memoryKey: 'fact:mixed',
                project: 'widget',
                sessionId: 'Host-Session',
              }),
            /Conflicting repository/u,
          );
          await client.query('ROLLBACK');
        } finally {
          client.release();
        }
        assert.deepEqual(await snapshot(pool), before);
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const enriched = await storeMemoryWithAuditEvent(client, {
          category: 'decision',
          content: 'Enrich only this compatible synthetic bare repository scope.',
          memoryKey: 'fact:compatible',
          project: 'widget',
          sessionId: 'Host-Session',
          threadId: 'logical:task',
          source: 'codex',
        });
        assert.equal(enriched.project, selectors.project);
        assert.equal(enriched.sessionId, 'Host-Session');
        assert.equal(enriched.threadId, 'logical:task');
        const custom = await storeMemoryWithAuditEvent(client, {
          category: 'decision',
          content: 'Preserve this explicit synthetic custom project.',
          memoryKey: 'fact:custom',
          project: 'custom-project',
          repoId: 'foreign.example/other/widget',
          sessionId: 'Host-Session',
        });
        assert.equal(custom.project, 'custom-project');
        assert.equal(custom.repoId, 'foreign.example/other/widget');
        assert.equal(custom.memoryType, 'semantic');
        for (const source of ['codex', 'claude-session-end', 'grok-session-end']) {
          const qualified = await storeMemoryWithAuditEvent(client, {
            category: 'decision',
            content: `Keep the verified synthetic host-qualified ${source} assertion.`,
            memoryKey: `fact:qualified:${source}`,
            project: 'widget',
            repoId: 'github.com/demo-workshop/widget',
            sessionId: 'Host-Session',
            threadId: 'logical:task',
            source,
          });
          assert.equal(qualified.project, selectors.project);
          assert.equal(qualified.repoId, 'github.com/demo-workshop/widget');
          assert.equal(qualified.sessionId, 'Host-Session');
          assert.equal(qualified.threadId, 'logical:task');
          assert.equal(qualified.source, source);
        }
        const unknown = await storeMemoryWithAuditEvent(client, {
          category: 'decision',
          content: 'Keep this unattested synthetic bare scope unqualified.',
          memoryKey: 'fact:unattested',
          project: 'widget',
        });
        assert.equal(unknown.project, 'widget');
        const foreign = await storeMemoryWithAuditEvent(client, {
          category: 'decision',
          content: 'Keep this foreign synthetic same-basename scope isolated.',
          memoryKey: 'fact:other-owner',
          project: 'widget',
          repoSlug: 'another/widget',
          sessionId: 'Host-Session',
        });
        assert.equal(foreign.project, 'another/widget');
        assert.equal(foreign.repoSlug, 'another/widget');
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    });
  },
);

test(
  'a SELECT-only fixture role produces a real read-only proposal without initialization or sequence allocation',
  { skip: databaseUrl === undefined, timeout: 0 },
  async () => {
    await fixture(async ({ admin, pool, schema }) => {
      await seed(pool);
      const role = `scope_reader_${randomUUID().replaceAll('-', '')}`;
      const marker = `criterion4:${schema}:${role}`;
      const password = randomUUID();
      const url = new URL(databaseUrl!);
      url.username = role;
      url.password = password;
      const reader = createPool({
        connectionString: url.toString(),
        pgOptions: { options: `-c search_path=${schema},public` },
      });
      let created = false;
      try {
        await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
        created = true;
        await admin.query(`COMMENT ON ROLE ${role} IS '${marker}'`);
        await admin.query(`GRANT USAGE ON SCHEMA ${schema},public TO ${role}`);
        await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
        await admin.query(`GRANT SELECT ON public.ai_memory_pgmigrations TO ${role}`);
        const before = await snapshot(pool);
        assert.equal((await createProjectScopeBackfillPlan({ pool: reader, selectors })).status, 'ready');
        assert.deepEqual(await snapshot(pool), before);
        await admin.query(`REVOKE SELECT ON ${schema}.ai_continuity_packs FROM ${role}`);
        await assert.rejects(() => createProjectScopeBackfillPlan({ pool: reader, selectors }), /incompatible_schema/u);
        assert.deepEqual(await snapshot(pool), before);
        await admin.query(`GRANT SELECT ON ${schema}.ai_continuity_packs TO ${role}`);
        await assert.rejects(() =>
          reader.query("INSERT INTO ai_memory_events(memory_id,event_type) VALUES (1,'forbidden')"),
        );
        assert.deepEqual(await snapshot(pool), before);
        await pool.query('ALTER TABLE ai_sessions ADD COLUMN synthetic_reader_schema_stamp text');
        const changed = await snapshot(pool);
        await createProjectScopeBackfillPlan({ pool: reader, selectors });
        assert.deepEqual(await snapshot(pool), changed);
      } finally {
        await reader.end();
        if (created) {
          const owned = (
            await admin.query<{ owned: boolean }>(
              `SELECT shobj_description(oid,'pg_authid')=$2 AS owned FROM pg_roles WHERE rolname=$1`,
              [role, marker],
            )
          ).rows[0]?.owned;
          assert.equal(owned, true, 'reader role marker must match before teardown');
          assert.equal((await admin.query('SELECT pid FROM pg_stat_activity WHERE usename=$1', [role])).rowCount, 0);
          await admin.query(`DROP OWNED BY ${role}`);
          await admin.query(`DROP ROLE ${role}`);
          assert.equal((await admin.query('SELECT oid FROM pg_roles WHERE rolname=$1', [role])).rowCount, 0);
        }
      }
    });
  },
);

test(
  'built maintenance CLI defaults to read-only, safely publishes plans and applies only reviewed bytes',
  { skip: databaseUrl === undefined, timeout: 0 },
  async () => {
    await fixture(async ({ pool, schema }) => {
      await seed(pool);
      const directory = await mkdtemp(join(tmpdir(), 'scope-command-'));
      const url = new URL(databaseUrl!);
      url.searchParams.set('options', `-c search_path=${schema},public`);
      const env = { AI_MEMORY_DATABASE_URL: url.toString(), PATH: process.env.PATH ?? '' };
      const execute = promisify(execFile);
      const command = fileURLToPath(new URL('../../dist/tools/backfill-project-scope.js', import.meta.url));
      const run = (args: string[]) =>
        execute(process.execPath, [command, ...args], { env, maxBuffer: 32 * 1024 * 1024 });
      try {
        assert.match(
          (await execute(process.execPath, [command, '--help'], { env: { PATH: process.env.PATH ?? '' } })).stdout,
          /read-only dry-run/u,
        );
        const before = await snapshot(pool);
        const args = ['--project', selectors.project, '--legacy-project', selectors.legacyProject];
        const first = join(directory, 'first.json');
        const second = join(directory, 'second.json');
        await run([...args, '--out', first]);
        await run([...args, '--dry-run', '--out', second]);
        assert.equal(await readFile(first, 'utf8'), await readFile(second, 'utf8'));
        assert.deepEqual(await snapshot(pool), before);
        const plan = JSON.parse(await readFile(first, 'utf8')) as {
          digest: string;
          identity: { namespace: string };
          status: string;
        };
        assert.equal(plan.status, 'ready');
        assert.ok(plan.identity.namespace.includes(schema));
        await assert.rejects(() => run([...args, '--out', first]));
        assert.deepEqual(await snapshot(pool), before);
        const altered = join(directory, 'altered.json');
        await writeFile(altered, (await readFile(first, 'utf8')).replace('"version":1', '"version":2'));
        await assert.rejects(() => run(['--apply', '--plan-file', altered, '--expect-plan', `sha256:${plan.digest}`]));
        assert.deepEqual(await snapshot(pool), before);
        const lock = await pool.connect();
        try {
          await lock.query('BEGIN');
          await lock.query('LOCK TABLE ai_memory_entries IN ROW EXCLUSIVE MODE');
          await assert.rejects(
            () => run(['--apply', '--plan-file', first, '--expect-plan', `sha256:${plan.digest}`]),
            error => {
              assert.ok(typeof error === 'object' && error !== null && 'stderr' in error);
              assert.deepEqual(JSON.parse(String(error.stderr)), {
                reason: 'maintenance_lock_busy',
                retryable: true,
                status: 'error',
              });
              return true;
            },
          );
          assert.deepEqual(await snapshot(pool), before);
        } finally {
          await lock.query('ROLLBACK');
          lock.release();
        }
        assert.equal(
          (
            JSON.parse(
              (await run(['--apply', '--plan-file', first, '--expect-plan', `sha256:${plan.digest}`])).stdout,
            ) as { status: string }
          ).status,
          'applied',
        );
        const applied = await snapshot(pool);
        assert.equal(
          (
            JSON.parse(
              (await run(['--apply', '--plan-file', first, '--expect-plan', `sha256:${plan.digest}`])).stdout,
            ) as { status: string }
          ).status,
          'skipped',
        );
        assert.deepEqual(await snapshot(pool), applied);
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    });
  },
);

test(
  'first-update failure rolls back and interruption resumes compatible units to the uninterrupted result',
  { skip: databaseUrl === undefined, timeout: 0 },
  async () => {
    const results: unknown[] = [];
    for (const interrupted of [true, false])
      await fixture(async ({ admin, pool, schema }) => {
        await seed(pool, 'Session-A');
        await pool.query(
          `INSERT INTO ai_sessions(session_id,repo_id,repo_slug,task_id,agent) VALUES ('Session-B','widget','demo-workshop/widget','logical:B','grok')`,
        );
        await pool.query(`INSERT INTO ai_memory_entries(content,category,project,memory_key,session_id,source,memory_type)
      VALUES ('Preserve independently resumable synthetic unit B.','architecture','widget','fact:B','Session-B','grok','semantic')`);
        const a = await createProjectScopeBackfillPlan({ pool, selectors: { ...selectors, sessionId: 'Session-A' } });
        const b = await createProjectScopeBackfillPlan({ pool, selectors: { ...selectors, sessionId: 'Session-B' } });
        await applyProjectScopeBackfill({ pool, plan: a, expectedDigest: a.digest });
        if (interrupted) {
          let releases = 0;
          const before = await snapshot(pool);
          const failing: DbPool = {
            ...pool,
            async connect() {
              const client = await pool.connect();
              return {
                async query<T>(sql: string, params?: unknown[]) {
                  const result = await client.query<T>(sql, params);
                  if (sql.startsWith('UPDATE ')) throw new Error('synthetic_first_update_failure');
                  return result;
                },
                release(error?: boolean | Error) {
                  releases++;
                  client.release(error);
                },
              };
            },
          };
          await assert.rejects(
            () => applyProjectScopeBackfill({ pool: failing, plan: b, expectedDigest: b.digest }),
            /synthetic_first_update_failure/u,
          );
          assert.deepEqual(await snapshot(pool), before);
          assert.equal(releases, 1);
          let native: { birth: string; database: string; pid: number } | undefined;
          let interruptedClientDiscarded = false;
          const marker = `${schema}:interrupted`;
          const terminated: DbPool = {
            ...pool,
            async connect() {
              const client = await pool.connect();
              let discarded = false;
              await client.query(`SET application_name TO '${marker}'`);
              native = (
                await client.query<{ birth: string; database: string; pid: number }>(
                  `SELECT pid,backend_start::text AS birth,datname AS database FROM pg_stat_activity WHERE pid=pg_backend_pid()`,
                )
              ).rows[0];
              return {
                async query<T>(sql: string, params?: unknown[]) {
                  if (sql === 'COMMIT') {
                    assert.ok(native);
                    const fresh = await admin.query(
                      `SELECT pid FROM pg_stat_activity
              WHERE pid=$1 AND backend_start::text=$2 AND datname=$3 AND application_name=$4 AND state='idle in transaction'`,
                      [native.pid, native.birth, native.database, marker],
                    );
                    assert.equal(fresh.rowCount, 1, 'only the freshly verified owned backend may be interrupted');
                    console.info(
                      JSON.stringify({
                        kind: 'owned-synthetic-interruption',
                        ...native,
                        applicationName: marker,
                        stage: 'after_updates_audit_before_commit',
                      }),
                    );
                    try {
                      await client.query(
                        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
              WHERE pid=pg_backend_pid() AND pid=$1 AND backend_start::text=$2 AND datname=$3 AND application_name=$4`,
                        [native.pid, native.birth, native.database, marker],
                      );
                    } catch (error) {
                      // Retire the deliberately killed connection before the
                      // runner attempts rollback and its ordinary release.
                      discarded = true;
                      interruptedClientDiscarded = true;
                      client.release(true);
                      throw error;
                    }
                    throw new Error('synthetic_backend_was_not_terminated');
                  }
                  return client.query<T>(sql, params);
                },
                release(error?: boolean | Error) {
                  releases++;
                  if (!discarded) client.release(error);
                },
              };
            },
          };
          await assert.rejects(
            () => applyProjectScopeBackfill({ pool: terminated, plan: b, expectedDigest: b.digest }),
            error => typeof error === 'object' && error !== null && 'code' in error && error.code === '57P01',
          );
          assert.equal(interruptedClientDiscarded, true);
          assert.equal(releases, 2, 'both failed attempts release their owned client exactly once');
          assert.ok(native);
          assert.equal(
            (
              await admin.query('SELECT pid FROM pg_stat_activity WHERE pid=$1 AND backend_start::text=$2', [
                native.pid,
                native.birth,
              ])
            ).rowCount,
            0,
          );
          // Failed inserts may consume sequence values. Compare committed rows, and
          // preserve the resulting gaps instead of resetting shared sequences.
          const rows = (value: Record<string, unknown>) =>
            Object.fromEntries(Object.entries(value).filter(([key]) => !key.endsWith('_seq')));
          assert.deepEqual(rows(await snapshot(pool)), rows(before));
          const completedRows = rows(await snapshot(pool));
          assert.equal(
            (await applyProjectScopeBackfill({ pool, plan: a, expectedDigest: a.digest })).status,
            'skipped',
          );
          assert.deepEqual(rows(await snapshot(pool)), completedRows);
        }
        await applyProjectScopeBackfill({ pool, plan: b, expectedDigest: b.digest });
        results.push({
          memories: (
            await pool.query(
              `SELECT id::text,content,project,memory_key,dedupe_hash,session_id,source,status,expires_at,tags,metadata_json,supersedes_id::text,evidence_refs FROM ai_memory_entries ORDER BY id`,
            )
          ).rows,
          sessions: (
            await pool.query(
              'SELECT session_id,repo_id,repo_slug,task_id,metadata_json FROM ai_sessions ORDER BY session_id',
            )
          ).rows,
          packs: (
            await pool.query(
              'SELECT scope_key,project,session_id,source,pack_json FROM ai_continuity_packs ORDER BY scope_key',
            )
          ).rows,
          lineage: (
            await pool.query(`SELECT event_type,memory_id::text,actor,payload_json->'from' AS before,payload_json->'to' AS after,payload_json->>'evidence' AS evidence
        FROM ai_memory_events ORDER BY memory_id,event_type`)
          ).rows,
        });
      });
    assert.deepEqual(results[0], results[1]);
  },
);
