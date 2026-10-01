import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Client } from 'pg';
import { runner } from 'node-pg-migrate';
import { test } from 'vitest';
import { assertLocalDatabaseUrl, createPool } from './pool.js';
import { runAiMemoryMigrations } from './run-migrations.js';
import { SEARCH_VECTOR_SQL } from './runtime.js';

// The already separate disposable opt-in supplies an administrator capable of
// creating/dropping this fixture's unique databases and login, never live data.
const adminUrl = process.env.AI_MEMORY_PROJECT_IDENTITY_TEST_URL;
const coreRoot = process.env.AI_MEMORY_TEST_PACKAGED_CORE_ROOT ?? fileURLToPath(new URL('../../', import.meta.url));
const pluginRoot = process.env.AI_MEMORY_TEST_PACKAGED_PLUGIN_ROOT ?? resolve(coreRoot, '../../plugins/ai-memory');
const exec = promisify(execFile);
const migrations = fileURLToPath(new URL('../../migrations/', import.meta.url));
const expected = readdirSync(migrations)
  .filter(name => name.endsWith('.sql'))
  .sort()
  .map(name => name.slice(0, -4));
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

function runtimeEnv(url: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    AI_MEMORY_DATABASE_URL: url,
    AI_MEMORY_MCP_REQUIRE_POSTGRES: 'true',
    AI_MEMORY_MCP_AUTO_START_POSTGRES: 'false',
    AI_MEMORY_MCP_TRANSPORT: 'stdio',
  };
}

async function initialize(url: string, root = coreRoot) {
  // A stalled startup/connection is bounded, not the integration graph's total runtime.
  return await exec(process.execPath, [resolve(root, 'dist/tools/init-db.js')], {
    env: runtimeEnv(url),
    maxBuffer: 128 * 1024,
    timeout: 30_000,
  });
}

async function waitFor(check: () => Promise<boolean>, reason: string) {
  const deadline = Date.now() + 20_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, reason);
    await delay(20);
  }
}

async function snapshot(client: Client) {
  const catalog = (
    await client.query(`
    SELECT c.relname, c.relkind, c.relowner, c.relacl,
      (SELECT jsonb_agg(jsonb_build_array(a.attname, a.atttypid, a.atttypmod, a.attnotnull,
        pg_get_expr(d.adbin, d.adrelid)) ORDER BY a.attnum)
       FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
       WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,
      (SELECT jsonb_agg(pg_get_constraintdef(p.oid) ORDER BY p.conname)
       FROM pg_constraint p WHERE p.conrelid=c.oid) AS constraints,
      (SELECT jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY i.indexrelid)
       FROM pg_index i WHERE i.indrelid=c.oid) AS indexes
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' ORDER BY c.relname
  `)
  ).rows;
  const exists = (
    await client.query<{ exists: boolean }>("SELECT to_regclass('public.ai_memory_pgmigrations') IS NOT NULL AS exists")
  ).rows[0]?.exists;
  const ledger = exists ? (await client.query('SELECT * FROM public.ai_memory_pgmigrations ORDER BY id')).rows : [];
  const sequences = [];
  for (const row of (
    await client.query<{ relname: string }>(`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='S' ORDER BY c.relname
  `)
  ).rows) {
    sequences.push({
      name: row.relname,
      state: (await client.query(`SELECT last_value, is_called FROM public.${quote(row.relname)}`)).rows,
    });
  }
  return { catalog, ledger, sequences };
}

async function proveMcp(url: string, entry: string) {
  const client = new McpClient({ name: 'nonowner-startup-fixture', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: runtimeEnv(url),
    stderr: 'pipe',
  });
  let diagnostics = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    diagnostics = (diagnostics + chunk.toString()).slice(-128 * 1024);
  });
  try {
    await client.connect(transport, { timeout: 20_000 });
    assert.ok((await client.listTools(undefined, { timeout: 20_000 })).tools.length > 0);
    await waitFor(
      () => Promise.resolve(diagnostics.includes('ai-memory MCP connected')),
      'Packaged MCP did not finish database initialization and connect',
    );
    assert.match(diagnostics, /ai-memory MCP connected \([^\n]+transport=stdio, mode=full\)/u);
    assert.doesNotMatch(diagnostics, /database initialization failed|startup failed/u);
  } finally {
    await client.close();
  }
}

test(
  'administrator migrations and real nonowner packaged startup preserve a complete read-only ledger',
  { skip: adminUrl === undefined, timeout: 0 },
  async () => {
    assert.ok(adminUrl);
    assertLocalDatabaseUrl(adminUrl);
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    const suffix = randomUUID().replaceAll('-', '');
    const role = `startup_runtime_${suffix}`;
    const databases: string[] = [];
    let roleCreated = false;
    const connections: Client[] = [];
    const base = new URL(adminUrl);
    const createDatabase = async (label: string) => {
      const name = `startup_${label}_${suffix}`;
      await admin.query(`CREATE DATABASE ${quote(name)}`);
      databases.push(name);
      const url = new URL(base);
      url.pathname = `/${name}`;
      const client = new Client({ connectionString: url.toString() });
      await client.connect();
      connections.push(client);
      return { client, url: url.toString() };
    };
    const migrate = async (url: string) => {
      const pool = createPool({ connectionString: url });
      try {
        await runAiMemoryMigrations(pool);
      } finally {
        await pool.end();
      }
    };
    try {
      const authority = (
        await admin.query<{ allowed: boolean }>(
          'SELECT rolsuper OR (rolcreatedb AND rolcreaterole) AS allowed FROM pg_roles WHERE rolname=current_user',
        )
      ).rows[0]?.allowed;
      assert.ok(
        authority,
        'Disposable project-identity test administrator needs CREATEDB and CREATEROLE for isolated nonowner proof.',
      );
      await admin.query(
        `CREATE ROLE ${quote(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${suffix}'`,
      );
      roleCreated = true;
      await admin.query(`ALTER ROLE ${quote(role)} SET default_transaction_read_only=on`);
      const fresh = await createDatabase('complete');
      await migrate(fresh.url);
      assert.deepEqual(
        (
          await fresh.client.query<{ name: string }>('SELECT name FROM public.ai_memory_pgmigrations ORDER BY id')
        ).rows.map(row => row.name),
        expected,
      );
      await fresh.client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
      await fresh.client.query(`GRANT USAGE ON SCHEMA public TO ${quote(role)}`);
      await fresh.client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${quote(role)}`);
      const url = new URL(fresh.url);
      url.username = role;
      url.password = suffix;
      const runtime = new Client({ connectionString: url.toString() });
      await runtime.connect();
      connections.push(runtime);
      const rights = (
        await runtime.query<{ ddl: boolean; writes: boolean; owner: boolean }>(`SELECT
        has_schema_privilege('public','CREATE') AS ddl,
        has_table_privilege('public.ai_memory_pgmigrations','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS writes,
        pg_has_role((SELECT relowner FROM pg_class WHERE oid='public.ai_memory_pgmigrations'::regclass),'MEMBER') AS owner
      `)
      ).rows[0];
      assert.deepEqual(rights, { ddl: false, writes: false, owner: false });
      const invisiblePk = (
        await runtime.query<{ count: string }>(`SELECT count(*) FROM information_schema.table_constraints
        WHERE table_schema='public' AND table_name='ai_memory_pgmigrations' AND constraint_type='PRIMARY KEY'`)
      ).rows[0]?.count;
      assert.equal(invisiblePk, '0', 'SELECT-only role cannot use the library primary-key introspection');
      const baseline = process.env.AI_MEMORY_TEST_RELEASED_CORE_ROOT;
      if (baseline !== undefined) {
        const before = await snapshot(fresh.client);
        // Isolate the released CREATE permission failure from read-only mode.
        await fresh.client.query(`ALTER ROLE ${quote(role)} SET default_transaction_read_only=off`);
        try {
          await assert.rejects(
            exec(
              process.execPath,
              [
                '--input-type=module',
                '-e',
                "import('@aviaratech/ai-memory/internal').then(async m => { try { await m.initializeDatabase(); } finally { await m.closePool(); } })",
              ],
              { cwd: baseline, env: runtimeEnv(url.toString()), maxBuffer: 128 * 1024, timeout: 30_000 },
            ),
            /permission denied for schema public/u,
          );
        } finally {
          await fresh.client.query(`ALTER ROLE ${quote(role)} SET default_transaction_read_only=on`);
        }
        assert.deepEqual(await snapshot(fresh.client), before);
        console.log('Immutable released initializer reproduces CREATE permission denial with unchanged database state');
      }
      await runtime.query('SET default_transaction_read_only=off');
      await assert.rejects(
        runner({
          dbClient: runtime,
          dir: migrations,
          direction: 'up',
          migrationsTable: 'ai_memory_pgmigrations',
          logger: { info: () => {}, warn: () => {}, error: () => {} },
        }),
        /must be owner/u,
      );
      await runtime.query('SET default_transaction_read_only=on');
      console.log('Unchanged migration library reproduces ALTER ownership denial with SELECT-only ledger');
      const before = await snapshot(fresh.client);
      assert.match((await initialize(url.toString())).stdout, /schema is ready/u);
      await proveMcp(url.toString(), resolve(coreRoot, 'dist/tools/server.js'));
      await proveMcp(url.toString(), resolve(pluginRoot, 'dist/mcp-server.bundle.js'));
      assert.deepEqual(await snapshot(fresh.client), before);
      console.log(
        'Packaged init, core MCP and plugin MCP start under read-only nonowner without catalog/ledger/sequence changes',
      );
      await runtime.query('SET default_transaction_read_only=off');
      for (const sql of [
        'CREATE TABLE public.runtime_ddl_probe(id integer)',
        'ALTER TABLE public.ai_memory_pgmigrations ADD COLUMN runtime_probe integer',
        "INSERT INTO public.ai_memory_pgmigrations(name,run_on) VALUES ('999_probe',now())",
        "UPDATE public.ai_memory_pgmigrations SET name='999_probe' WHERE id=1",
        'DELETE FROM public.ai_memory_pgmigrations WHERE id=1',
        'TRUNCATE public.ai_memory_pgmigrations',
        "SELECT nextval('public.ai_memory_pgmigrations_id_seq')",
        "SELECT setval('public.ai_memory_pgmigrations_id_seq',1)",
        'SET ROLE pg_database_owner',
      ])
        await assert.rejects(runtime.query(sql), /permission denied|must be owner|cannot set role/u);
      assert.deepEqual(await snapshot(fresh.client), before);

      const original = (
        await fresh.client.query<{ id: number; name: string; run_on: Date }>(
          'SELECT * FROM public.ai_memory_pgmigrations ORDER BY id',
        )
      ).rows;
      const last = original.at(-1);
      assert.ok(last);
      for (const state of ['pending', 'unknown', 'duplicate', 'reordered', 'incompatible', 'missing']) {
        if (state === 'pending')
          await fresh.client.query('DELETE FROM public.ai_memory_pgmigrations WHERE id=$1', [last.id]);
        else if (state === 'unknown' || state === 'duplicate')
          await fresh.client.query('INSERT INTO public.ai_memory_pgmigrations(id,name,run_on) VALUES (999,$1,now())', [
            state === 'unknown' ? '999_unknown' : expected[0],
          ]);
        else if (state === 'reordered')
          await fresh.client.query(
            "UPDATE public.ai_memory_pgmigrations SET run_on=run_on+interval '1 day' WHERE id=1",
          );
        else if (state === 'incompatible')
          await fresh.client.query(
            'ALTER TABLE public.ai_memory_pgmigrations DROP CONSTRAINT ai_memory_pgmigrations_pkey',
          );
        else await fresh.client.query('ALTER TABLE public.ai_memory_pgmigrations RENAME TO held_pgmigrations');
        const invalid = await snapshot(fresh.client);
        await assert.rejects(initialize(url.toString()), /administrator.*canonical migrations/iu);
        assert.deepEqual(await snapshot(fresh.client), invalid, `${state} startup is read-only`);
        if (state === 'missing')
          await fresh.client.query('ALTER TABLE public.held_pgmigrations RENAME TO ai_memory_pgmigrations');
        if (state === 'incompatible')
          await fresh.client.query('ALTER TABLE public.ai_memory_pgmigrations ADD PRIMARY KEY(id)');
        await fresh.client.query('DELETE FROM public.ai_memory_pgmigrations');
        for (const row of original)
          await fresh.client.query('INSERT INTO public.ai_memory_pgmigrations(id,name,run_on) VALUES ($1,$2,$3)', [
            row.id,
            row.name,
            row.run_on,
          ]);
      }
      const uninterrupted = await snapshot(fresh.client);
      await fresh.client.query('BEGIN');
      await fresh.client.query('LOCK TABLE public.ai_memory_pgmigrations IN ACCESS EXCLUSIVE MODE');
      const child = spawn(process.execPath, [resolve(coreRoot, 'dist/tools/init-db.js')], {
        env: runtimeEnv(url.toString()),
        stdio: 'ignore',
      });
      const closed = once(child, 'close');
      try {
        await waitFor(
          async () =>
            (
              await admin.query<{ waiting: boolean }>(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock') AS waiting",
                [role],
              )
            ).rows[0]?.waiting === true,
          'runtime startup did not reach the blocked ledger read',
        );
        child.kill('SIGTERM');
        await closed;
      } finally {
        child.kill('SIGKILL');
        await closed;
        await fresh.client.query('ROLLBACK');
      }
      assert.match((await initialize(url.toString())).stdout, /schema is ready/u);
      assert.deepEqual(
        await snapshot(fresh.client),
        uninterrupted,
        'interrupted startup resumes without writes and matches uninterrupted state',
      );

      const upgrade = await createDatabase('upgrade');
      await runner({
        dbClient: upgrade.client,
        dir: migrations,
        direction: 'up',
        count: 3,
        migrationsTable: 'ai_memory_pgmigrations',
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      });
      await migrate(upgrade.url);
      assert.deepEqual(
        (
          await upgrade.client.query<{ name: string }>('SELECT name FROM public.ai_memory_pgmigrations ORDER BY id')
        ).rows.map(row => row.name),
        expected,
      );
      const recovery = await createDatabase('backfill');
      await runner({
        dbClient: recovery.client,
        dir: migrations,
        direction: 'up',
        count: expected.length - 1,
        migrationsTable: 'ai_memory_pgmigrations',
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      });
      const seed = `INSERT INTO ai_memory_entries(content,project,category,memory_type,source,confidence,importance,created_at,updated_at)
        SELECT repeat('Synthetic supporting reference ledger evidence context discussion source memory details. ',24) || item::text,
          'synthetic/backfill','convention','semantic','migration-recovery-fixture',0.8,0.6,'2026-01-01'::timestamptz,'2026-01-01'::timestamptz
        FROM generate_series(1,4096) AS records(item)`;
      await recovery.client.query(seed);
      const fingerprint = async (client: Client) =>
        (
          await client.query<{ count: string; digest: string }>(`SELECT count(*)::text AS count,
        md5(string_agg(md5((to_jsonb(entries)-'search_vector')::text),'' ORDER BY id)) AS digest FROM ai_memory_entries AS entries`)
        ).rows;
      const priorRows = await fingerprint(recovery.client);
      const priorSchema = await snapshot(recovery.client);
      const relation = (
        await recovery.client.query<{ relation: number; database: number }>(
          "SELECT 'ai_memory_entries'::regclass::oid AS relation, (SELECT oid FROM pg_database WHERE datname=current_database()) AS database",
        )
      ).rows[0];
      assert.ok(relation);
      const application = `backfill_${suffix}`;
      const recoveryPool = createPool({
        connectionString: recovery.url,
        max: 1,
        pgOptions: { application_name: application },
      });
      try {
        const failed = runAiMemoryMigrations(recoveryPool).then(
          () => undefined,
          (error: unknown) => error,
        );
        let backend: { pid: number; birth: string } | undefined;
        await waitFor(async () => {
          backend = (
            await admin.query<{ pid: number; birth: string }>(
              `SELECT pid,backend_start::text AS birth FROM pg_stat_activity AS activity
            WHERE application_name=$1 AND datname=$2 AND state='active' AND wait_event_type IS DISTINCT FROM 'Lock'
              AND query LIKE '%ADD COLUMN search_vector%' AND query_start < clock_timestamp()-interval '50 milliseconds'
              AND EXISTS (SELECT 1 FROM pg_locks WHERE pid=activity.pid AND relation=$3 AND database=$4 AND mode='AccessExclusiveLock' AND granted)`,
              [application, new URL(recovery.url).pathname.slice(1), relation.relation, relation.database],
            )
          ).rows[0];
          return backend !== undefined;
        }, '007 did not reach active generated-column backfill');
        assert.ok(backend);
        const cancelled = (
          await admin.query<{ cancelled: boolean }>(
            `SELECT pg_cancel_backend(pid) AS cancelled FROM pg_stat_activity
          WHERE pid=$1 AND backend_start=$2::timestamptz AND application_name=$3 AND datname=$4 AND state='active'
            AND query LIKE '%ADD COLUMN search_vector%'`,
            [backend.pid, backend.birth, application, new URL(recovery.url).pathname.slice(1)],
          )
        ).rows[0]?.cancelled;
        assert.equal(cancelled, true);
        assert.ok((await failed) instanceof Error, 'backfill cancellation must reject the migration');
        assert.deepEqual(
          await snapshot(recovery.client),
          priorSchema,
          'cancelled backfill must not advance schema, ledger or sequences',
        );
        assert.deepEqual(
          await fingerprint(recovery.client),
          priorRows,
          'cancelled backfill must preserve every stored field',
        );
        assert.equal(
          (await recoveryPool.query<{ value: number }>('SELECT 1 AS value')).rows[0]?.value,
          1,
          'the same pool must recover an aborted migration session',
        );
        await runAiMemoryMigrations(recoveryPool);
        assert.equal(
          (
            await recovery.client.query<{ count: number }>(
              `SELECT count(*)::int AS count FROM ai_memory_entries WHERE search_vector::text <> (${SEARCH_VECTOR_SQL})::text`,
            )
          ).rows[0]?.count,
          0,
        );
        assert.deepEqual(await fingerprint(recovery.client), priorRows);
        assert.equal(
          (
            await admin.query<{ count: number }>(
              `SELECT count(*)::int AS count FROM pg_locks WHERE pid=$1 AND locktype='advisory'`,
              [backend.pid],
            )
          ).rows[0]?.count,
          0,
        );
        await migrate(recovery.url);
        assert.match((await initialize(recovery.url)).stdout, /schema is ready/u);
      } finally {
        await recoveryPool.end();
      }
      const uninterruptedUpgrade = await createDatabase('backfill_uninterruptedUpgrade');
      await runner({
        dbClient: uninterruptedUpgrade.client,
        dir: migrations,
        direction: 'up',
        count: expected.length - 1,
        migrationsTable: 'ai_memory_pgmigrations',
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      });
      await uninterruptedUpgrade.client.query(seed);
      assert.match((await initialize(uninterruptedUpgrade.url)).stdout, /schema is ready/u);
      assert.deepEqual(
        await fingerprint(uninterruptedUpgrade.client),
        priorRows,
        'retry and uninterruptedUpgrade populated upgrade must preserve identical records',
      );
      assert.equal(
        (
          await uninterruptedUpgrade.client.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM ai_memory_entries WHERE search_vector::text <> (${SEARCH_VECTOR_SQL})::text`,
          )
        ).rows[0]?.count,
        0,
      );
      console.log(
        '007 active backfill cancellation rolls back, same-pool retry and actual-default populated startup preserve exact records',
      );
      const legacy = await createDatabase('legacy');
      await legacy.client.query(readFileSync(resolve(migrations, '001_baseline.sql'), 'utf8'));
      await legacy.client.query('CREATE TABLE ai_memory_migrations(id text PRIMARY KEY)');
      await legacy.client.query(
        "INSERT INTO ai_memory_migrations VALUES ('2026_02_26_019_write_calibration_confidence')",
      );
      await migrate(legacy.url);
      assert.deepEqual(
        (
          await legacy.client.query<{ name: string }>('SELECT name FROM public.ai_memory_pgmigrations ORDER BY id')
        ).rows.map(row => row.name),
        expected,
      );
    } finally {
      try {
        await Promise.all(connections.map(client => client.end()));
        for (const database of databases) await admin.query(`DROP DATABASE ${quote(database)} WITH (FORCE)`);
        if (roleCreated) await admin.query(`DROP ROLE ${quote(role)}`);
        assert.equal(
          (await admin.query('SELECT 1 FROM pg_database WHERE datname=ANY($1::text[])', [databases])).rowCount,
          0,
        );
        assert.equal((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount, 0);
      } finally {
        await admin.end();
      }
    }
  },
);
