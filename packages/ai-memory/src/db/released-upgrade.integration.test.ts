import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client } from 'pg';
import { test } from 'vitest';

const execute = promisify(execFile);
const expected = `001_baseline 002_continuity_packs 003_searchable_provenance
004_reference_search_terms 005_verified_project_identity 006_host_qualified_project_identity
007_stored_search_vector 008_memory_last_accessed_at 009_workflow_telemetry
010_index_first_search 011_pinned_brief`.split(/\s+/);
const artifacts = [
  {
    name: '@aviaratech/ai-memory',
    version: '0.2.2',
    url: 'https://registry.npmjs.org/@aviaratech/ai-memory/-/ai-memory-0.2.2.tgz',
    sha256: '2831005be1c006efa5714aeb078cbac1724aa17df4204abbe80df276b7b9f87f',
  },
  {
    name: '@aviaratech/ai-memory',
    version: '0.3.1',
    url: 'https://registry.npmjs.org/@aviaratech/ai-memory/-/ai-memory-0.3.1.tgz',
    sha256: '6dc620ae9b77a1817df2c83adf414ef8d0195a58389def0de601f328c529f0be',
  },
  {
    name: '@aviaratech/ai-memory-plugin',
    version: '0.3.1',
    url: 'https://github.com/aviaratech/ai-memory/releases/download/v0.3.1/aviaratech-ai-memory-plugin-0.3.1.tgz',
    sha256: 'b2990fe8b77ddcd74a17635e1ec470a0b7bf65ea0d9e834a671734515299bf92',
  },
];
test(
  'published 0.2.2 seven-entry populated upgrade preserves records and starts released 0.3.1',
  { skip: process.env.GITHUB_ACTIONS !== 'true', timeout: 180_000 },
  async () => {
    const supplied = process.env.AI_MEMORY_PROJECT_IDENTITY_TEST_URL;
    assert.ok(supplied, 'Supply the existing disposable CI administrator database.');
    const target = new URL(supplied);
    assert.equal(target.hostname, '127.0.0.1');
    assert.equal(target.pathname, '/ai_memory_project_identity_ci');
    const database = `released_upgrade_${randomUUID().replaceAll('-', '')}`;
    const fixture = new URL(target);
    fixture.pathname = `/${database}`;
    const sandbox = mkdtempSync(join(tmpdir(), 'ai-memory-released-upgrade-'));
    const home = join(sandbox, 'home');
    const previous = join(sandbox, 'previous');
    const current = join(sandbox, 'current');
    const admin = new Client({ connectionString: supplied });
    const db = new Client({ connectionString: fixture.href });
    let created = false;
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: home,
      TMPDIR: sandbox,
      LANG: 'C.UTF-8',
      npm_config_userconfig: join(sandbox, 'user.npmrc'),
      npm_config_globalconfig: join(sandbox, 'global.npmrc'),
      npm_config_cache: join(sandbox, 'npm-cache'),
      npm_config_registry: 'https://registry.npmjs.org/',
      npm_config_fetch_retries: '0',
      npm_config_fetch_timeout: '30000',
      AI_MEMORY_DATABASE_URL: fixture.href,
      AI_MEMORY_MCP_REQUIRE_POSTGRES: 'true',
      AI_MEMORY_MCP_AUTO_START_POSTGRES: 'false',
      AI_MEMORY_MCP_TRANSPORT: 'stdio',
    };
    const run = async (file: string, args: string[]) => {
      try {
        return await execute(file, args, { cwd: sandbox, env, timeout: 60_000, maxBuffer: 1024 * 1024 });
      } catch {
        throw new Error('Released upgrade subprocess failed; rerun the disposable CI qualification.');
      }
    };
    const ledger = async () =>
      (await db.query<{ name: string }>('SELECT name FROM public.ai_memory_pgmigrations ORDER BY run_on,id')).rows.map(
        row => row.name,
      );
    const records = async () => {
      const result = await db.query<{ record: unknown }>(`SELECT to_jsonb(entries)
      - ARRAY['last_accessed_at','audience','pinned','last_verified_at'] AS record
      FROM ai_memory_entries AS entries ORDER BY id`);
      return result.rows;
    };
    try {
      for (const dir of [home, previous, current]) mkdirSync(dir, { mode: 0o700 });
      for (const file of ['user.npmrc', 'global.npmrc']) writeFileSync(join(sandbox, file), '', { mode: 0o600 });
      for (const [index, artifact] of artifacts.entries()) {
        const response = await fetch(artifact.url, { signal: AbortSignal.timeout(30_000) });
        assert.equal(response.ok, true, `Public artifact unavailable: ${artifact.name}@${artifact.version}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
        writeFileSync(join(sandbox, `${index}.tgz`), bytes, { mode: 0o600 });
      }
      const flags = ['--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'];
      const currentArchives = ['1.tgz', '2.tgz'].map(file => join(sandbox, file));
      await run('npm', ['install', '--prefix', previous, ...flags, join(sandbox, '0.tgz')]);
      await run('npm', ['install', '--prefix', current, ...flags, ...currentArchives]);
      const oldCore = join(previous, 'node_modules/@aviaratech/ai-memory');
      const core = join(current, 'node_modules/@aviaratech/ai-memory');
      const plugin = join(current, 'node_modules/@aviaratech/ai-memory-plugin');
      for (const [index, root] of [oldCore, core, plugin].entries()) {
        const artifact = artifacts[index];
        assert.ok(artifact);
        const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
          name: string;
          version: string;
        };
        assert.deepEqual([manifest.name, manifest.version], [artifact.name, artifact.version]);
        assert.deepEqual(
          readdirSync(join(root, 'migrations'))
            .filter(name => name.endsWith('.sql'))
            .sort(),
          expected.slice(0, index === 0 ? 7 : 11).map(name => `${name}.sql`),
        );
      }
      await admin.connect();
      await admin.query(`CREATE DATABASE "${database}"`);
      created = true;
      await run(process.execPath, [join(oldCore, 'dist/tools/init-db.js')]);
      await db.connect();
      const before = await ledger();
      assert.deepEqual(before, expected.slice(0, 7));
      await db.query(`INSERT INTO ai_memory_entries(content,project,category,memory_type,source,memory_key,
        confidence,importance,created_at,updated_at)
        SELECT 'Synthetic released migration preservation fixture '||item, 'fixture/released-upgrade',
        'convention','semantic','released-upgrade-fixture','fixture-'||item,0.8,0.6,
        '2026-01-01'::timestamptz,'2026-01-02'::timestamptz FROM generate_series(1,3) AS item`);
      const prior = await records();
      assert.equal(prior.length, 3);
      await run(process.execPath, [join(core, 'dist/tools/init-db.js')]);
      const after = await ledger();
      assert.deepEqual(after, expected);
      assert.deepEqual(await records(), prior);
      const defaults = await db.query<{ invalid: number }>(`SELECT count(*)::int AS invalid FROM ai_memory_entries
        WHERE audience<>ARRAY['all']::text[] OR pinned OR last_verified_at<>updated_at
          OR last_accessed_at IS NOT NULL`);
      assert.equal(defaults.rows[0]?.invalid, 0);
      const shape = await db.query<{ shape: string }>(
        `SELECT attname||':'||attnotnull AS shape FROM pg_attribute
        WHERE attrelid='ai_memory_entries'::regclass AND attname=ANY($1) ORDER BY attname`,
        [['audience', 'last_accessed_at', 'last_verified_at', 'pinned']],
      );
      assert.deepEqual(
        shape.rows.map(row => row.shape),
        ['audience:true', 'last_accessed_at:false', 'last_verified_at:true', 'pinned:true'],
      );
      for (const relation of [
        'ai_workflow_events',
        'ai_memory_entries_search_vector_idx',
        'ai_memory_entries_brief_project_idx',
      ])
        assert.ok(
          (await db.query<{ relation: string | null }>('SELECT to_regclass($1) AS relation', [`public.${relation}`]))
            .rows[0]?.relation,
        );
      const config = join(home, '.config/ai-memory');
      mkdirSync(config, { recursive: true, mode: 0o700 });
      writeFileSync(join(config, 'plugin.env'), `AI_MEMORY_DATABASE_URL=${JSON.stringify(fixture.href)}\n`, {
        mode: 0o600,
      });
      const inventories: number[] = [];
      for (const entry of [join(core, 'dist/tools/server.js'), join(plugin, 'dist/mcp-launcher.js')]) {
        const client = new McpClient({ name: 'released-upgrade-fixture', version: '1' });
        const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env, stderr: 'pipe' });
        transport.stderr?.on('data', () => {});
        try {
          await client.connect(transport, { timeout: 20_000 });
          const tools = (await client.listTools(undefined, { timeout: 20_000 })).tools;
          assert.ok(tools.some(tool => tool.name === 'memory_flush'));
          const fetched = CallToolResultSchema.parse(
            await client.callTool(
              {
                name: 'memory_get',
                arguments: { project: 'fixture/released-upgrade', key: 'fixture-1' },
              },
              undefined,
              { timeout: 20_000 },
            ),
          );
          assert.notEqual(fetched.isError, true);
          const text = fetched.content.find(block => block.type === 'text');
          assert.ok(text?.type === 'text');
          const readback = JSON.parse(text.text) as { memories: { content: string }[] };
          assert.equal(readback.memories[0]?.content, 'Synthetic released migration preservation fixture 1');
          inventories.push(tools.length);
        } finally {
          await client.close();
        }
      }
      assert.deepEqual(await records(), prior);
      console.info(
        'released-022-to-031',
        JSON.stringify({ artifacts, before, after, rows: prior.length, tools: inventories }),
      );
    } finally {
      try {
        await db.end();
        if (created) {
          await admin.query(`DROP DATABASE "${database}"`);
        }
      } finally {
        try {
          await admin.end();
        } finally {
          rmSync(sandbox, { recursive: true, force: true });
        }
      }
      assert.equal(existsSync(sandbox), false);
      console.info(JSON.stringify({ qualification: 'released-022-to-031', ownedCleanup: 'complete' }));
    }
  },
);
