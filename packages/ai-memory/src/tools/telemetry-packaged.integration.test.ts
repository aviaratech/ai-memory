import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'vitest';
import { assertLocalDatabaseUrl, createPool } from '../db/pool.js';
import { runAiMemoryMigrations } from '../db/run-migrations.js';
import { projectIdForTelemetry } from '../telemetry/event.js';

const execute = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const databaseUrl = process.env.AI_MEMORY_DATABASE_URL;
interface PackInventory {
  name: string;
  version: string;
  filename: string;
  files: { path: string; mode: number; size: number }[];
}
const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
function jsonFile(file: string, value: unknown) {
  writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

test(
  'actual core/plugin archives install an inert, content-free telemetry consumer and embedded hook',
  { skip: databaseUrl === undefined, timeout: 0 },
  async () => {
    assert.ok(databaseUrl);
    assertLocalDatabaseUrl(databaseUrl);
    assert.ok(['/ai_memory_test', '/ai_memory_ci'].includes(new URL(databaseUrl).pathname));
    const sandbox = mkdtempSync(join(tmpdir(), 'ai-memory-telemetry-consumer-'));
    const consumer = join(sandbox, 'consumer');
    const home = join(sandbox, 'home');
    const bin = join(sandbox, 'bin');
    const externalProof = process.env.AI_MEMORY_TELEMETRY_PROOF_DIR;
    const proof = externalProof ?? join(sandbox, 'proof');
    mkdirSync(proof, { recursive: true, mode: 0o700 });
    const ownershipFile = join(proof, 'consumer-ownership.json');
    const marker = randomUUID();
    writeFileSync(join(sandbox, '.telemetry-owner'), marker, { mode: 0o600 });
    const identity = {
      root: sandbox,
      inode: statSync(sandbox).ino,
      uid: statSync(sandbox).uid,
      marker,
      cleanup: 'pending',
    };
    jsonFile(ownershipFile, identity);
    const producer = `fixture-${randomUUID()}`;
    const sessionId = `session-${randomUUID()}`;
    const canonicalProject = `fixture/packaged-${randomUUID()}`;
    const projectId = projectIdForTelemetry(canonicalProject);
    const taskId = 'packaged-task';
    const db = createPool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 1000 });
    const missingName = `telemetry_missing_${randomUUID().replaceAll('-', '')}`;
    const missingUrl = new URL(databaseUrl);
    missingUrl.pathname = `/${missingName}`;
    let missingCreated = false;
    let evidence: Record<string, unknown> | undefined;
    try {
      await runAiMemoryMigrations(db);
      for (const directory of [consumer, home, bin, join(home, '.config/ai-memory')])
        mkdirSync(directory, { recursive: true, mode: 0o700 });
      const userConfig = join(sandbox, 'empty.npmrc');
      const globalConfig = join(sandbox, 'empty-global.npmrc');
      writeFileSync(userConfig, '', { mode: 0o600 });
      writeFileSync(globalConfig, '', { mode: 0o600 });
      for (const host of ['codex', 'claude'])
        writeFileSync(
          join(bin, host),
          `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(join(sandbox, 'unexpected-native-call'))},'unexpected');process.exit(77);\n`,
          { mode: 0o700 },
        );
      const env: NodeJS.ProcessEnv = {
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: home,
        TMPDIR: tmpdir(),
        LANG: 'en_US.UTF-8',
        npm_config_userconfig: userConfig,
        npm_config_globalconfig: globalConfig,
        npm_config_cache: join(sandbox, 'npm-cache'),
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        npm_config_fetch_retries: '0',
        npm_config_fetch_timeout: '30000',
        AI_MEMORY_DATABASE_URL: databaseUrl,
      };
      const run = async (file: string, args: string[], cwd = consumer, input?: string, childEnv = env) => {
        // CLI lifecycle waits detect leaked pools; npm/corpus work has no elapsed cap.
        if (input === undefined) return execute(file, args, { cwd, env: childEnv, maxBuffer: 32 * 1024 * 1024 });
        return new Promise<{ stdout: string; stderr: string }>((resolveRun, rejectRun) => {
          const child = execFile(
            file,
            args,
            { cwd, env: childEnv, maxBuffer: 32 * 1024 * 1024, timeout: 10000 },
            (error, stdout, stderr) => {
              if (error) rejectRun(error instanceof Error ? error : new Error('consumer_cli_failed'));
              else resolveRun({ stdout, stderr });
            },
          );
          child.stdin?.end(input);
        });
      };
      const inventories: Record<string, PackInventory> = {};
      const archives: Record<string, string> = {};
      for (const [label, workspace] of [
        ['core', '@aviaratech/ai-memory'],
        ['plugin', '@aviaratech/ai-memory-plugin'],
      ] as const) {
        console.info(JSON.stringify({ phase: 'telemetry-packaged', stage: 'pack', unit: label }));
        const dry = JSON.parse(
          (await run('npm', ['pack', '--workspace', workspace, '--dry-run', '--json'], repo)).stdout,
        ) as PackInventory[];
        const packed = JSON.parse(
          (await run('npm', ['pack', '--workspace', workspace, '--pack-destination', proof, '--json'], repo)).stdout,
        ) as PackInventory[];
        assert.equal(dry.length, 1);
        assert.equal(packed.length, 1);
        const actual = packed[0];
        assert.ok(actual);
        assert.equal(actual.name, workspace);
        assert.equal(dry[0]?.name, actual.name);
        assert.deepEqual(dry[0]?.files.map(f => f.path).sort(), actual.files.map(f => f.path).sort());
        inventories[label] = actual;
        archives[label] = join(proof, actual.filename);
        jsonFile(join(proof, `${label}-dry-run.json`), dry);
        jsonFile(join(proof, `${label}-pack.json`), packed);
      }
      const coreArchive = archives.core;
      const pluginArchive = archives.plugin;
      assert.ok(coreArchive);
      assert.ok(pluginArchive);
      const archiveHashes = { core: hash(coreArchive), plugin: hash(pluginArchive) };
      writeFileSync(
        join(consumer, 'package.json'),
        JSON.stringify({ name: 'synthetic-telemetry-consumer', private: true, type: 'module' }),
      );
      console.info(JSON.stringify({ phase: 'telemetry-packaged', stage: 'install', completedPackages: 2 }));
      await run('npm', [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--package-lock=false',
        coreArchive,
        pluginArchive,
      ]);
      console.info(JSON.stringify({ phase: 'telemetry-packaged', stage: 'installed-probes' }));
      const core = join(consumer, 'node_modules/@aviaratech/ai-memory');
      const plugin = join(consumer, 'node_modules/@aviaratech/ai-memory-plugin');
      const embedded = join(core, 'plugins/ai-memory');
      const installed = JSON.parse(readFileSync(join(core, 'package.json'), 'utf8')) as { version: string };
      assert.equal(installed.version, inventories.core?.version);
      assert.equal(
        (JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf8')) as { version: string }).version,
        inventories.plugin?.version,
      );
      for (const file of [
        'hooks/telemetry',
        'hooks/hooks.json',
        'migrations/009_workflow_telemetry.sql',
        'dist/mcp-server.bundle.js',
      ])
        assert.equal(hash(join(plugin, file)), hash(join(embedded, file)));
      assert.equal(
        hash(join(core, 'migrations/009_workflow_telemetry.sql')),
        hash(join(plugin, 'migrations/009_workflow_telemetry.sql')),
      );
      assert.ok((statSync(join(plugin, 'hooks/telemetry')).mode & 0o111) !== 0);
      const noDatabase = { ...env };
      delete noDatabase.AI_MEMORY_DATABASE_URL;
      const inert = await run(
        process.execPath,
        ['--input-type=module', '-e', "await import('@aviaratech/ai-memory/ingestion');process.stdout.write('inert');"],
        consumer,
        '',
        noDatabase,
      );
      assert.equal(inert.stdout, 'inert');
      const event = {
        schemaVersion: 1,
        kind: 'usage',
        source: 'openai-responses',
        producer,
        eventId: 'response-1',
        responseId: `response-${randomUUID()}`,
        projectId,
        taskId,
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 80, cache_write_tokens: 10 },
          output_tokens: 20,
          output_tokens_details: { reasoning_tokens: 5 },
        },
      };
      const api =
        "import{readFileSync}from'node:fs';import{ingestTelemetryEvent}from'@aviaratech/ai-memory/ingestion';process.stdout.write(JSON.stringify(await ingestTelemetryEvent(JSON.parse(readFileSync(0,'utf8')))));";
      const invoke = async (payload: unknown, childEnv = env) =>
        JSON.parse(
          (await run(process.execPath, ['--input-type=module', '-e', api], consumer, JSON.stringify(payload), childEnv))
            .stdout,
        ) as { status: string; code?: string };
      assert.deepEqual(await invoke(event), { status: 'stored' });
      assert.deepEqual(await invoke(event), { status: 'duplicate' });
      assert.deepEqual(await invoke({ ...event, model: 'changed-model' }), { status: 'conflict' });
      assert.deepEqual(await invoke({ ...event, prompt: 'PRIVATE_SENTINEL' }), {
        status: 'rejected',
        code: 'invalid_event',
      });
      assert.deepEqual(await invoke(event, noDatabase), { status: 'unavailable', code: 'storage_unavailable' });
      const cli = join(core, 'dist/tools/server.js');
      assert.deepEqual(
        JSON.parse((await run(process.execPath, [cli, 'telemetry:ingest'], consumer, JSON.stringify(event))).stdout),
        { status: 'duplicate' },
      );
      const args = ['--project', projectId, '--task', taskId, '--json'];
      const report = JSON.parse(
        (await run(process.execPath, [cli, 'telemetry:report', ...args], consumer, '')).stdout,
      ) as { totals: Record<string, { total: string | null }>; coverage: { usageObservations: string } };
      assert.equal(report.totals.inputTokens?.total, '100');
      assert.equal(report.totals.nonReadInputTokens?.total, '20');
      assert.equal(report.totals.ordinaryInputTokens?.total, '10');
      assert.equal(report.coverage.usageObservations, '1');
      const health = JSON.parse(
        (await run(process.execPath, [join(core, 'dist/tools/health-report.js'), '--workflow', ...args], consumer, ''))
          .stdout,
      ) as { totals: unknown };
      assert.deepEqual(health.totals, report.totals);
      const pluginEnv = join(home, '.config/ai-memory/plugin.env');
      writeFileSync(pluginEnv, `AI_MEMORY_DATABASE_URL=${databaseUrl}\n`, { mode: 0o600 });
      const bait = join(sandbox, 'synthetic-transcript');
      writeFileSync(bait, 'PRIVATE_SENTINEL', { mode: 0o600 });
      const hostPayload = {
        hook_event_name: 'Stop',
        session_id: sessionId,
        turn_id: 'turn-1',
        transcript_path: bait,
        cwd: sandbox,
        last_assistant_message: 'PRIVATE_SENTINEL',
      };
      const hookEnv = { ...env, CODEX: '1', PLUGIN_ROOT: plugin };
      for (let repeat = 0; repeat < 2; repeat++) {
        const hook = await run(join(plugin, 'hooks/telemetry'), [], consumer, JSON.stringify(hostPayload), hookEnv);
        assert.deepEqual(JSON.parse(hook.stdout), { continue: true });
        assert.equal(hook.stderr, '');
      }
      const observed = await db.query<{
        source: string;
        usage_accounting: string | null;
        project_id: string | null;
        task_id: string | null;
        dedup_coverage: string;
      }>(
        "SELECT source,usage_accounting,project_id,task_id,dedup_coverage FROM ai_workflow_events WHERE producer='ai-memory-hook' AND session_id=$1",
        [sessionId],
      );
      assert.deepEqual(observed.rows, [
        { source: 'codex-hook', usage_accounting: null, project_id: null, task_id: null, dedup_coverage: 'host-turn' },
      ]);
      assert.equal((await db.query('SELECT session_id FROM ai_sessions WHERE session_id=$1', [sessionId])).rowCount, 0);
      assert.equal(existsSync(join(sandbox, 'unexpected-native-call')), false);
      await db.query(`CREATE DATABASE "${missingName}"`);
      missingCreated = true;
      const absentEnv = { ...env, AI_MEMORY_DATABASE_URL: missingUrl.href };
      assert.deepEqual(await invoke(event, absentEnv), { status: 'unavailable', code: 'storage_unavailable' });
      writeFileSync(pluginEnv, `AI_MEMORY_DATABASE_URL=${missingUrl.href}\n`, { mode: 0o600 });
      const advisory = await run(join(plugin, 'hooks/telemetry'), [], consumer, JSON.stringify(hostPayload), hookEnv);
      assert.deepEqual(JSON.parse(advisory.stdout), { continue: true });
      assert.equal(advisory.stderr, '');
      const missing = createPool({ connectionString: missingUrl.href, max: 1, connectionTimeoutMillis: 1000 });
      try {
        assert.deepEqual(
          (
            await missing.query(
              "SELECT to_regclass('public.ai_workflow_events') AS events, to_regclass('public.ai_memory_pgmigrations') AS ledger",
            )
          ).rows,
          [{ events: null, ledger: null }],
        );
      } finally {
        await missing.end();
      }
      assert.deepEqual({ core: hash(coreArchive), plugin: hash(pluginArchive) }, archiveHashes);
      evidence = {
        status: 'passed',
        node: process.version,
        npm: (await run('npm', ['--version'])).stdout.trim(),
        sourceHead: (await run('git', ['rev-parse', 'HEAD'], repo)).stdout.trim(),
        sourceTree: (await run('git', ['rev-parse', 'HEAD^{tree}'], repo)).stdout.trim(),
        lockSha256: hash(join(repo, 'package-lock.json')),
        archives: {
          core: { file: coreArchive, sha256: archiveHashes.core, version: inventories.core?.version },
          plugin: { file: pluginArchive, sha256: archiveHashes.plugin, version: inventories.plugin?.version },
        },
        consumerRoot: sandbox,
        fixtureDatabase: missingName,
        checks: [
          'dry/actual inventories',
          'actual install',
          'embedded parity',
          'inert import',
          'API/CLI replay and fixed failures',
          'shared health report',
          'actual embedded hook',
          'missing migration no DDL',
          'no native host commands',
        ],
      };
    } finally {
      try {
        await db.query('DELETE FROM ai_workflow_events WHERE producer=$1 OR (producer=$2 AND session_id=$3)', [
          producer,
          'ai-memory-hook',
          sessionId,
        ]);
        assert.equal(
          (
            await db.query('SELECT id FROM ai_workflow_events WHERE producer=$1 OR (producer=$2 AND session_id=$3)', [
              producer,
              'ai-memory-hook',
              sessionId,
            ])
          ).rowCount,
          0,
        );
        if (missingCreated) {
          await db.query(`DROP DATABASE "${missingName}"`);
          assert.equal((await db.query('SELECT datname FROM pg_database WHERE datname=$1', [missingName])).rowCount, 0);
        }
      } finally {
        await db.end();
        rmSync(sandbox, { recursive: true, force: true });
        assert.equal(existsSync(sandbox), false);
        if (externalProof !== undefined) jsonFile(ownershipFile, { ...identity, cleanup: 'absent' });
      }
    }
    if (externalProof !== undefined)
      jsonFile(join(proof, 'packaged-proof.json'), {
        ...evidence,
        cleanup: { consumer: 'absent', fixtureDatabase: 'absent', ownedRows: 'deleted' },
      });
  },
);
