import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import pg from 'pg';
import { afterAll, test } from 'vitest';
import { parseSetupArguments, runLocalPostgresSetup } from './localPostgresSetup.js';

const administrator = process.env.AI_MEMORY_PROJECT_IDENTITY_TEST_URL;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

// Observe without registering error handlers or replacing the emitted error.
const tracePhase = (() => {
  if (process.env.AI_MEMORY_POSTGRES_TRACE !== '1') return (_phase: string) => {};
  const identities = new WeakMap<object, number>();
  let next = 0;
  const identify = (value: object) => {
    if (!identities.has(value)) identities.set(value, ++next);
    return identities.get(value)!;
  };
  const trace = (value: Record<string, string | number>) => {
    try {
      process.stdout.write('AMPG ' + JSON.stringify(value) + '\n');
    } catch {
      process.exitCode = 1;
    }
  };
  const state = (error: unknown): Record<string, string | number> => {
    const code: unknown =
      error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
    return typeof code === 'string' && /^[0-9A-Z]{5}$/u.test(code) ? { code } : {};
  };
  const observe = (prototype: EventEmitter, event: 'client' | 'pool') => {
    const original = Reflect.get(prototype, 'emit');
    prototype.emit = function (this: EventEmitter, type: string | symbol, ...args: unknown[]): boolean {
      if (type === 'connect' || type === 'end' || type === 'error') {
        const pid: unknown = Object.getOwnPropertyDescriptor(this, 'processID')?.value;
        trace({
          event,
          id: identify(this),
          phase: type,
          ...state(args[0]),
          ...(typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 && pid <= 2147483647 ? { pid } : {}),
          ...(event === 'pool' && args[1] && typeof args[1] === 'object' ? { client: identify(args[1]) } : {}),
        });
      }
      return original.call(this, type, ...args);
    };
  };
  observe(pg.Client.prototype, 'client');
  observe(pg.Pool.prototype, 'pool');
  process.on('uncaughtExceptionMonitor', error => {
    trace({ event: 'uncaught', ...state(error) });
  });
  trace({ event: 'phase', phase: 'begin' });
  afterAll(() => {
    trace({ event: 'phase', phase: 'complete' });
  });
  return (phase: string) => {
    trace({ event: 'phase', phase });
  };
})();

// These tests exercise real provisioning/migrations/MCP, independently of the
// host runner's client packages. Client discovery has separate subprocess tests
// and actual-client packed TTY qualification; hosted Ubuntu currently ships 16.
function clientEnvironment(home: string): NodeJS.ProcessEnv {
  const bin = join(home, 'client-fixture');
  mkdirSync(bin, { mode: 0o700 });
  for (const name of ['psql', 'pg_config', 'pg_dump'])
    writeFileSync(join(bin, name), '#!/bin/sh\necho "PostgreSQL 18.6"\n', { mode: 0o700 });
  return { PATH: bin + delimiter + (process.env.PATH ?? '') };
}

for (const configurationCase of ['exposed', 'malformed', 'missing'] as const) {
  test.skipIf(administrator === undefined)(
    `setup reports ${configurationCase} protected configuration conflicts before provisioning`,
    async () => {
      const url = new URL(administrator!),
        suffix = randomUUID().replaceAll('-', '').slice(0, 12);
      const database = `ai_memory_config_${suffix}`,
        owner = `config_owner_${suffix}`,
        runtime = `config_runtime_${suffix}`;
      const home = mkdtempSync(join(tmpdir(), 'memory-config-conflict-')),
        env = clientEnvironment(home);
      mkdirSync(join(home, '.config/ai-memory'), { recursive: true, mode: 0o700 });
      const file = join(home, '.config/ai-memory/plugin.env');
      const invalid = new URL(url);
      invalid.username = runtime;
      invalid.password = '%ZZ';
      invalid.pathname = '/' + database;
      const contents =
        configurationCase === 'malformed'
          ? 'AI_MEMORY_DATABASE_URL=' + invalid.href + '\n'
          : 'UNRELATED_SETTING=preserve\n';
      writeFileSync(file, contents, { mode: configurationCase === 'exposed' ? 0o644 : 0o600 });
      const admin = new pg.Client({
        connectionString: administrator,
        connectionTimeoutMillis: 3000,
        statement_timeout: 5000,
      });
      await admin.connect();
      try {
        const options = parseSetupArguments([
          '--host',
          url.hostname,
          '--port',
          url.port || '5432',
          '--database',
          database,
          '--owner',
          owner,
          '--runtime-user',
          runtime,
          '--admin-user',
          decodeURIComponent(url.username),
        ]);
        const result = await runLocalPostgresSetup(options, {
          home,
          env,
          prompt: async () => decodeURIComponent(url.password),
        });
        assert.equal(result.reason, 'configuration_conflict', JSON.stringify(result));
        assert.equal(result.stage, 2);
        assert.equal('step' in result && result.step, 'protected_configuration');
        assert.match(result.nextAction, /0600/u);
        assert.equal(readFileSync(file, 'utf8'), contents);
        assert.equal(
          (await admin.query('SELECT 1 FROM pg_roles WHERE rolname=ANY($1::text[])', [[owner, runtime]])).rowCount,
          0,
        );
        assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount, 0);
      } finally {
        await admin.end();
        rmSync(home, { recursive: true, force: true });
      }
    },
    0,
  );
}

test.skipIf(administrator === undefined)(
  'setup resumes compatible stages without resetting roles and rejects incompatible history without rewriting it',
  async () => {
    const url = new URL(administrator!);
    const admin = new pg.Client({
      connectionString: administrator,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
    });
    await admin.connect();
    let uninterrupted: unknown;
    try {
      for (const interruption of [0, 4, 6]) {
        const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
        const database = `ai_memory_resume_${suffix}`,
          owner = `resume_owner_${suffix}`,
          runtime = `resume_runtime_${suffix}`;
        const home = mkdtempSync(join(tmpdir(), 'memory-resume-')),
          password = randomUUID();
        const env = clientEnvironment(home);
        const options = parseSetupArguments([
          '--host',
          url.hostname,
          '--port',
          url.port || '5432',
          '--database',
          database,
          '--owner',
          owner,
          '--runtime-user',
          runtime,
          '--admin-user',
          decodeURIComponent(url.username),
        ]);
        const prompt = async (label: string) =>
          /administrator password/iu.test(label)
            ? decodeURIComponent(url.password)
            : /confirm changes/iu.test(label)
              ? `setup ${database} on ${url.hostname}:${url.port || '5432'}`
              : password;
        const targetUrl = new URL(url);
        targetUrl.pathname = `/${database}`;
        let check: pg.Client | undefined;
        try {
          tracePhase('setup');
          const first = await runLocalPostgresSetup(options, {
            home,
            env,
            prompt,
            progress: stage => {
              if (stage === interruption) throw new Error('synthetic lost output channel');
            },
          });
          const roleIds = (
            await admin.query('SELECT oid,rolname FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname', [
              [owner, runtime],
            ])
          ).rows;
          if (interruption) {
            assert.equal(first.ok, false);
            assert.equal(first.stage, interruption);
            assert.equal(first.configurationSaved, interruption === 6);
            if (interruption === 6) {
              assert.equal(first.database, 'ready');
              assert.equal(first.mcp, 'not_checked');
              assert.match(first.nextAction, /configuration was saved and is preserved/iu);
            }
            const resumed = await runLocalPostgresSetup(options, { home, env, prompt });
            assert.equal(resumed.ok, true, JSON.stringify(resumed));
            assert.deepEqual(
              (
                await admin.query('SELECT oid,rolname FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname', [
                  [owner, runtime],
                ])
              ).rows,
              roleIds,
            );
          } else assert.equal(first.ok, true, JSON.stringify(first));
          tracePhase('check');
          check = new pg.Client({
            connectionString: targetUrl.href,
            connectionTimeoutMillis: 3000,
            statement_timeout: 5000,
          });
          await check.connect();
          const signature = {
            columns: (
              await check.query(
                "SELECT table_name,column_name,data_type,udt_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position",
              )
            ).rows,
            migrations: (await check.query('SELECT name FROM public.ai_memory_pgmigrations ORDER BY id')).rows,
          };
          if (!interruption) uninterrupted = signature;
          else assert.deepEqual(signature, uninterrupted);
          const config = readFileSync(join(home, '.config/ai-memory/plugin.env'), 'utf8');
          await check.query(
            "UPDATE public.ai_memory_pgmigrations SET name='incompatible_history' WHERE id=(SELECT min(id) FROM public.ai_memory_pgmigrations)",
          );
          const before = (await check.query('SELECT * FROM public.ai_memory_pgmigrations ORDER BY id')).rows;
          const incompatible = await runLocalPostgresSetup(options, { home, env, prompt });
          assert.equal(incompatible.reason, 'schema_conflict', JSON.stringify(incompatible));
          assert.deepEqual((await check.query('SELECT * FROM public.ai_memory_pgmigrations ORDER BY id')).rows, before);
          assert.equal(readFileSync(join(home, '.config/ai-memory/plugin.env'), 'utf8'), config);
        } finally {
          tracePhase('close');
          await check?.end();
          tracePhase('drop');
          await admin.query(`DROP DATABASE IF EXISTS ${quote(database)} WITH (FORCE)`);
          await admin.query(`DROP ROLE IF EXISTS ${quote(runtime)}`);
          await admin.query(`DROP ROLE IF EXISTS ${quote(owner)}`);
          rmSync(home, { recursive: true, force: true });
        }
      }
    } finally {
      await admin.end();
    }
  },
  0,
);

for (const ledger of ['missing', 'empty'])
  test.skipIf(administrator === undefined)(
    `setup refuses an untracked populated database with ${ledger} ledger before initialization can remove data`,
    async () => {
      const url = new URL(administrator!),
        suffix = randomUUID().replaceAll('-', '').slice(0, 12);
      const database = `ai_memory_untracked_${suffix}`,
        owner = `untracked_owner_${suffix}`,
        runtime = `untracked_runtime_${suffix}`;
      const home = mkdtempSync(join(tmpdir(), 'memory-untracked-'));
      const env = clientEnvironment(home);
      const password = randomUUID();
      const admin = new pg.Client({ connectionString: administrator });
      await admin.connect();
      let target: pg.Client | undefined;
      try {
        await admin.query(`CREATE ROLE ${quote(owner)} NOLOGIN NOINHERIT`);
        await admin.query(`CREATE DATABASE ${quote(database)} OWNER ${quote(owner)}`);
        const targetUrl = new URL(url);
        targetUrl.pathname = `/${database}`;
        target = new pg.Client({ connectionString: targetUrl.href });
        await target.connect();
        await target.query(`SET ROLE ${quote(owner)}`);
        await target.query(
          'CREATE TABLE ai_goals (value text, goal_id uuid, project text, status text, parent_goal_id uuid)',
        );
        await target.query("INSERT INTO ai_goals VALUES ('preserve-existing-data')");
        if (ledger === 'empty')
          await target.query(
            'CREATE TABLE ai_memory_pgmigrations (id serial PRIMARY KEY, name varchar(255) NOT NULL, run_on timestamp NOT NULL)',
          );
        const options = parseSetupArguments([
          '--host',
          url.hostname,
          '--port',
          url.port || '5432',
          '--database',
          database,
          '--owner',
          owner,
          '--runtime-user',
          runtime,
          '--admin-user',
          decodeURIComponent(url.username),
        ]);
        const result = await runLocalPostgresSetup(options, {
          home,
          env,
          prompt: async label =>
            /administrator password/iu.test(label)
              ? decodeURIComponent(url.password)
              : /confirm changes/iu.test(label)
                ? `setup ${database} on ${url.hostname}:${url.port || '5432'}`
                : password,
        });
        assert.equal(result.reason, 'schema_conflict', JSON.stringify(result));
        assert.equal(result.stage, 3);
        assert.deepEqual((await target.query('SELECT value FROM ai_goals')).rows, [
          { value: 'preserve-existing-data' },
        ]);
        assert.equal((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [runtime])).rowCount, 0);
      } finally {
        await target?.end();
        await admin.query(`DROP DATABASE IF EXISTS ${quote(database)} WITH (FORCE)`);
        await admin.query(`DROP ROLE IF EXISTS ${quote(runtime)}`);
        await admin.query(`DROP ROLE IF EXISTS ${quote(owner)}`);
        await admin.end();
        rmSync(home, { recursive: true, force: true });
      }
    },
    0,
  );

for (const credential of ['plain', 'percent'])
  test.skipIf(administrator === undefined)(
    `guided setup proves fresh and repeated least-privilege schema/MCP readiness with ${credential} credentials`,
    async () => {
      const url = new URL(administrator!);
      const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
      const database = `ai_memory_setup_${suffix}`,
        owner = `setup_owner_${suffix}`,
        runtime = `setup_runtime_${suffix}`;
      const home = mkdtempSync(join(tmpdir(), 'memory-setup-integration-'));
      const env = clientEnvironment(home);
      const password = randomUUID() + (credential === 'percent' ? '%41%password' : '');
      const setupAdministrator = `setup_admin_${suffix}`;
      const administratorPassword =
        credential === 'percent' ? 'synthetic%41%admin-fixture' : decodeURIComponent(url.password);
      const admin = new pg.Client({ connectionString: administrator });
      await admin.connect();
      const flags = [
        '--host',
        url.hostname,
        '--port',
        url.port || '5432',
        '--database',
        database,
        '--owner',
        owner,
        '--runtime-user',
        runtime,
        '--admin-user',
        credential === 'percent' ? setupAdministrator : decodeURIComponent(url.username),
      ];
      const options = parseSetupArguments(flags);
      const prompts: string[] = [],
        stages: number[] = [];
      const prompt = async (label: string) => {
        prompts.push(label);
        if (/administrator password/iu.test(label)) return administratorPassword;
        if (/confirm changes/iu.test(label)) return `setup ${database} on ${url.hostname}:${url.port || '5432'}`;
        return password;
      };
      try {
        if (credential === 'percent')
          await admin.query(
            `CREATE ROLE ${quote(setupAdministrator)} LOGIN SUPERUSER PASSWORD 'synthetic%41%admin-fixture'`,
          );
        await admin.query('CREATE TABLE IF NOT EXISTS public.setup_unrelated_sentinel (value text)');
        await admin.query("INSERT INTO public.setup_unrelated_sentinel VALUES ('preserve')");
        const before = await admin.query('SELECT * FROM public.setup_unrelated_sentinel');
        const result = await runLocalPostgresSetup(options, {
          home,
          env,
          prompt,
          progress: stage => stages.push(stage),
        });
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.database, 'ready');
        assert.equal(result.mcp, 'connected');
        assert.deepEqual([...new Set(stages)], [1, 2, 3, 4, 5, 6]);
        assert.ok(prompts.some(label => /new memory database credential/iu.test(label)));
        const config = readFileSync(join(home, '.config/ai-memory/plugin.env'), 'utf8');
        const roleState = await admin.query<{
          oid: number;
          rolname: string;
          rolsuper: boolean;
          rolcreatedb: boolean;
          rolcreaterole: boolean;
          rolcanlogin: boolean;
        }>('SELECT oid,rolname,rolsuper,rolcreatedb,rolcreaterole,rolcanlogin FROM pg_roles WHERE rolname=ANY($1)', [
          [owner, runtime],
        ]);
        assert.equal(roleState.rows.length, 2);
        for (const role of roleState.rows) {
          assert.equal(role.rolsuper, false);
          assert.equal(role.rolcreatedb, false);
          assert.equal(role.rolcreaterole, false);
          assert.equal(role.rolcanlogin, role.rolname === runtime);
        }
        const target = new URL(administrator!);
        target.pathname = `/${database}`;
        const check = new pg.Client({ connectionString: target.href });
        await check.connect();
        try {
          const privileges = (
            await check.query<Record<string, boolean>>(
              `SELECT has_schema_privilege($1,'public','CREATE') AS schema_create, has_table_privilege($1,'public.ai_memory_pgmigrations','SELECT') AS ledger_read, has_table_privilege($1,'public.ai_memory_pgmigrations','INSERT,UPDATE,DELETE') AS ledger_write, has_sequence_privilege($1,'public.ai_memory_pgmigrations_id_seq','USAGE,SELECT,UPDATE') AS ledger_sequence, has_table_privilege($1,'public.ai_memory_entries','INSERT') AS application_write`,
              [runtime],
            )
          ).rows[0];
          assert.deepEqual(privileges, {
            schema_create: false,
            ledger_read: true,
            ledger_write: false,
            ledger_sequence: false,
            application_write: true,
          });
        } finally {
          await check.end();
        }
        prompts.length = 0;
        const repeat = await runLocalPostgresSetup(options, { home, env, prompt });
        assert.equal(repeat.ok, true, JSON.stringify(repeat));
        assert.equal(readFileSync(join(home, '.config/ai-memory/plugin.env'), 'utf8'), config);
        assert.ok(!prompts.some(label => /new memory database credential/iu.test(label)));
        assert.deepEqual(
          (
            await admin.query(
              'SELECT oid,rolname,rolsuper,rolcreatedb,rolcreaterole,rolcanlogin FROM pg_roles WHERE rolname=ANY($1)',
              [[owner, runtime]],
            )
          ).rows,
          roleState.rows,
        );
        assert.deepEqual((await admin.query('SELECT * FROM public.setup_unrelated_sentinel')).rows, before.rows);
        assert.doesNotMatch(JSON.stringify(result), new RegExp(password, 'u'));
        const corrupt = new pg.Client({ connectionString: target.href });
        await corrupt.connect();
        try {
          await corrupt.query('DROP TABLE public.ai_continuity_packs');
          const missingTable = await runLocalPostgresSetup(options, { home, env, prompt });
          assert.equal(missingTable.reason, 'schema_conflict', JSON.stringify(missingTable));
          assert.equal(
            (
              await corrupt.query<{ relation: string | null }>(
                "SELECT to_regclass('public.ai_continuity_packs') AS relation",
              )
            ).rows[0]?.relation,
            null,
          );
          assert.equal(readFileSync(join(home, '.config/ai-memory/plugin.env'), 'utf8'), config);
        } finally {
          await corrupt.end();
        }
      } finally {
        await admin.query(`DROP DATABASE IF EXISTS ${quote(database)} WITH (FORCE)`);
        await admin.query(`DROP ROLE IF EXISTS ${quote(runtime)}`);
        await admin.query(`DROP ROLE IF EXISTS ${quote(owner)}`);
        if (credential === 'percent') await admin.query(`DROP ROLE IF EXISTS ${quote(setupAdministrator)}`);
        await admin.query('DROP TABLE IF EXISTS public.setup_unrelated_sentinel');
        await admin.end();
        rmSync(home, { recursive: true, force: true });
      }
    },
    0,
  );
