import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import { Client } from 'pg';
import { afterAll, test } from 'vitest';
import { closePool, initializeDatabase, storeMemory } from '@aviaratech/ai-memory/internal';
import { createPool, assertLocalDatabaseUrl } from './pool.js';
import { runAiMemoryMigrations } from './run-migrations.js';
import { loadBriefMemories, buildBrief } from '../tools/brief.js';

const adminUrl = process.env.AI_MEMORY_PROJECT_IDENTITY_TEST_URL;
const databaseUrl = process.env.AI_MEMORY_DATABASE_URL;
afterAll(async () => {
  await closePool();
});

test(
  '011 preserves existing rows and defaults verification to their updated time, including subsequent raw inserts',
  { skip: adminUrl === undefined, timeout: 0 },
  async () => {
    assert.ok(adminUrl);
    assertLocalDatabaseUrl(adminUrl);
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    const name = `brief_migration_${randomUUID().replaceAll('-', '')}`;
    let created = false;
    let database: ReturnType<typeof createPool> | undefined;
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
      created = true;
      const url = new URL(adminUrl);
      url.pathname = `/${name}`;
      database = createPool({ connectionString: url.toString(), max: 1 });
      const client = new Client({ connectionString: url.toString() });
      await client.connect();
      try {
        await runner({
          dbClient: client,
          dir: fileURLToPath(new URL('../../migrations/', import.meta.url)),
          direction: 'up',
          count: 10,
          migrationsTable: 'ai_memory_pgmigrations',
          logger: { info: () => {}, warn: () => {}, error: () => {} },
        });
        const before = (
          await client.query<Record<string, unknown>>(`INSERT INTO ai_memory_entries
          (content, project, category, memory_type, updated_at) VALUES ('Synthetic preserved decision.', 'example/brief', 'decision', 'semantic', '2026-01-01') RETURNING *`)
        ).rows[0]!;

        await runAiMemoryMigrations(database);
        const after = (
          await database.query<Record<string, unknown>>('SELECT * FROM ai_memory_entries WHERE id=$1', [before.id])
        ).rows[0]!;
        const { audience, pinned, last_verified_at: lastVerified, ...original } = after;
        assert.deepEqual(original, before);
        assert.deepEqual(audience, ['all']);
        assert.equal(pinned, false);
        assert.deepEqual(lastVerified, before.updated_at);
        const inserted = (
          await database.query<Record<string, unknown>>(`INSERT INTO ai_memory_entries
          (content, project, category, memory_type, updated_at) VALUES ('Synthetic historical decision.', 'example/brief', 'decision', 'semantic', '2026-02-01') RETURNING *`)
        ).rows[0]!;
        assert.deepEqual(inserted.last_verified_at, inserted.updated_at);
        await runAiMemoryMigrations(database);
        assert.deepEqual(
          (await database.query('SELECT * FROM ai_memory_entries WHERE id=$1', [before.id])).rows[0],
          after,
        );
      } finally {
        await client.end();
      }
    } finally {
      await database?.end();
      if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end();
    }
  },
);

test(
  'memory_store round-trips metadata and SQL selects only matching pinned memories and role state',
  { skip: databaseUrl === undefined, timeout: 0 },
  async () => {
    assert.ok(databaseUrl);
    assertLocalDatabaseUrl(databaseUrl);
    const verification = createPool({ connectionString: databaseUrl, max: 1 });
    const project = `synthetic/brief-${randomUUID()}`;
    const otherProject = `${project}-other`;
    const home = await mkdtemp(join(tmpdir(), 'brief-packaged-'));
    try {
      await initializeDatabase();
      const base = {
        project,
        category: 'convention',
        confidence: 0.8,
        content: 'Synthetic standing rule for shared project work.',
        evidenceRefs: ['docs/synthetic.md'],
      };
      const stored = await storeMemory({
        ...base,
        memoryKey: `${project}:rule`,
        audience: ['lead'],
        pinned: true,
        lastVerifiedAt: '2026-10-01T00:00:00.000Z',
      });
      assert.deepEqual(stored.audience, ['lead']);
      assert.equal(stored.pinned, true);
      assert.equal(stored.lastVerifiedAt, '2026-10-01T00:00:00.000Z');
      await storeMemory({ ...base, memoryKey: `${project}:worker`, audience: ['worker'], pinned: true });
      const defaults = await storeMemory({ ...base, memoryKey: `${project}:default` });
      assert.deepEqual(defaults.audience, ['all']);
      assert.equal(defaults.pinned, false);
      assert.equal(defaults.lastVerifiedAt, defaults.updatedAt);
      const scope = { project, host: 'claude-code', role: 'lead' };
      assert.deepEqual(
        (await loadBriefMemories(scope, verification)).map(row => row.id),
        [stored.id],
      );
      assert.match(buildBrief(scope, await loadBriefMemories(scope, verification)), /docs\/synthetic.md/u);
      assert.deepEqual(await loadBriefMemories({ ...scope, project: 'other/brief' }, verification), []);
      const state = await storeMemory({
        ...base,
        category: 'state',
        memoryKey: `${project}:state/lead`,
        content: 'Synthetic current state for project alpha.',
        audience: ['lead'],
      });
      const otherState = await storeMemory({
        ...base,
        project: otherProject,
        category: 'state',
        memoryKey: `${otherProject}:state/lead`,
        content: 'Synthetic current state for project beta.',
        audience: ['lead'],
      });
      assert.notEqual(state.id, otherState.id);
      const alpha = buildBrief(scope, await loadBriefMemories(scope, verification));
      const beta = buildBrief(
        { ...scope, project: otherProject },
        await loadBriefMemories({ ...scope, project: otherProject }, verification),
      );
      assert.match(alpha.split('\n')[1]!, /project alpha/u);
      assert.doesNotMatch(alpha, /project beta/u);
      assert.match(beta, /project beta/u);
      assert.doesNotMatch(beta, /project alpha/u);

      const configuration = join(home, '.config/ai-memory');
      const cache = join(home, 'brief-cache');
      await mkdir(configuration, { recursive: true, mode: 0o700 });
      const configFile = join(configuration, 'plugin.env');
      const configText = (url: string) =>
        `AI_MEMORY_DATABASE_URL=${url}\nAI_MEMORY_ROLE=lead\nAI_MEMORY_BRIEF_CACHE_DIR=${cache}\n`;
      await writeFile(configFile, configText(databaseUrl), { mode: 0o600 });
      const env = { HOME: home, PATH: process.env.PATH };
      const cli = fileURLToPath(new URL('../../dist/tools/pluginCli.js', import.meta.url));
      const args = ['brief', '--project', project, '--host', 'claude-code', '--role', 'lead'];
      const printed = spawnSync(process.execPath, [cli, ...args], {
        env,
        encoding: 'utf8',
        timeout: 20000,
        maxBuffer: 128000,
      });
      assert.equal(printed.status, 0, printed.stderr);
      assert.equal(printed.stdout, `${alpha}\n`);
      const out = join(home, 'brief.md');
      const written = spawnSync(process.execPath, [cli, ...args, '--out', out], {
        env,
        encoding: 'utf8',
        timeout: 20000,
        maxBuffer: 128000,
      });
      assert.equal(written.status, 0, written.stderr);
      assert.equal(await readFile(out, 'utf8'), printed.stdout);

      const launcher = fileURLToPath(new URL('../../../../plugins/ai-memory/dist/mcp-launcher.js', import.meta.url));
      const payload = JSON.stringify({
        source: 'startup',
        hook_event_name: 'SessionStart',
        repository: project,
        session_id: `synthetic-${randomUUID()}`,
        cwd: home,
      });
      const runHook = () =>
        spawnSync(process.execPath, [launcher, 'hook:session-start'], {
          env: { ...env, CODEX: '1' },
          input: payload,
          encoding: 'utf8',
          timeout: 20000,
          maxBuffer: 128000,
        });
      const hooked = runHook();
      assert.equal(hooked.status, 0, hooked.stderr);
      const context = (JSON.parse(hooked.stdout) as { hookSpecificOutput: { additionalContext: string } })
        .hookSpecificOutput.additionalContext;
      assert.match(context, /codex, role lead/u);
      assert.match(context, /project alpha/u);
      assert.doesNotMatch(context, /project beta/u);
      assert.ok(context.length <= 8000);
      const unavailable = new URL(databaseUrl);
      unavailable.port = '1';
      await writeFile(configFile, configText(unavailable.toString()), { mode: 0o600 });
      const fallback = runHook();
      assert.equal(fallback.status, 0, fallback.stderr);
      assert.match(fallback.stdout, /Cached brief \(generated at/u);
      assert.match(fallback.stdout, /project alpha/u);
    } finally {
      await verification.query('DELETE FROM ai_memory_entries WHERE project=ANY($1::text[])', [
        [project, otherProject],
      ]);
      await verification.end();
      await rm(home, { recursive: true, force: true });
    }
  },
);
