import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, it } from 'vitest';

import type { PluginOptions } from './pluginCli.js';
import { runPluginOperation } from './pluginInstallation.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture(host: PluginOptions['host'] = 'codex') {
  const home = mkdtempSync(join(tmpdir(), 'ai-memory-installer-'));
  homes.push(home);
  const pluginRoot = join(home, 'released-plugin');
  for (const dir of ['.claude-plugin', 'dist', 'hooks', 'skills/memory-lifecycle', 'skills/memory-ops', 'migrations']) {
    mkdirSync(join(pluginRoot, dir), { recursive: true });
  }
  function version(value: string) {
    for (const name of ['plugin.json', '.claude-plugin/plugin.json'])
      writeFileSync(join(pluginRoot, name), JSON.stringify({ name: 'ai-memory', version: value }));
    writeFileSync(join(pluginRoot, 'dist/mcp-launcher.js'), `// actual launcher ${value}\n`);
  }
  version('0.2.2');
  for (const name of [
    'dist/mcp-server.bundle.js',
    'hooks/hooks.json',
    'skills/memory-lifecycle/SKILL.md',
    'skills/memory-ops/SKILL.md',
    'migrations/001_baseline.sql',
  ]) {
    writeFileSync(join(pluginRoot, name), `canonical ${name}\n`);
  }
  const calls: string[][] = [];
  let marketplace = '';
  let id = '';
  let installed: { version: string; path: string } | undefined;
  let failInstall = false;
  const env = { HOME: home, CODEX_HOME: join(home, 'codex'), CLAUDE_CONFIG_DIR: join(home, 'claude') };
  const nativeRun = async (_host: PluginOptions['host'], args: string[]): Promise<string> => {
    calls.push(args);
    if (args.includes('--help'))
      return 'marketplace add remove list install update uninstall --scope user project local --json --keep-data';
    if (args[1] === 'marketplace' && args[2] === 'add') {
      marketplace = args[3] ?? '';
      return '{}';
    }
    if (args[1] === 'marketplace' && args[2] === 'remove') {
      marketplace = '';
      return '{}';
    }
    if (['add', 'install', 'update'].includes(args[1] ?? '')) {
      if (failInstall) {
        failInstall = false;
        throw new Error('synthetic native interruption');
      }
      const manifest = JSON.parse(
        readFileSync(
          join(marketplace, host === 'codex' ? '.agents/plugins/marketplace.json' : '.claude-plugin/marketplace.json'),
          'utf8',
        ),
      ) as { plugins: Array<{ source: string | { path: string } }> };
      const entry = manifest.plugins[0];
      assert.ok(entry);
      const source = typeof entry.source === 'string' ? entry.source : entry.source.path;
      const actual = resolve(marketplace, source);
      const ver = (JSON.parse(readFileSync(join(actual, 'plugin.json'), 'utf8')) as { version: string }).version;
      const path = join(home, 'native-cache', ver);
      mkdirSync(dirname(path), { recursive: true });
      cpSync(actual, path, { recursive: true });
      id = args[2] ?? '';
      installed = { version: ver, path };
      return JSON.stringify({ pluginId: id, version: ver, installedPath: path });
    }
    if (['remove', 'uninstall'].includes(args[1] ?? '')) {
      installed = undefined;
      return '{}';
    }
    if (args[1] === 'list') {
      const entries = installed
        ? [
            host === 'codex'
              ? { pluginId: id, name: 'ai-memory', version: installed.version, installed: true, enabled: true }
              : { id, version: installed.version, scope: 'user', enabled: true, installPath: installed.path },
          ]
        : [];
      return JSON.stringify(host === 'codex' ? { installed: entries, available: [] } : entries);
    }
    throw new Error('unexpected native operation');
  };
  return {
    home,
    pluginRoot,
    calls,
    version,
    interrupt: () => {
      failInstall = true;
    },
    context: { home, cwd: home, env, pluginRoot, runtimeVersion: '0.2.2', nativeRun },
    options: (operation: PluginOptions['operation'], extra: Partial<PluginOptions> = {}): PluginOptions => ({
      operation,
      host,
      scope: 'user',
      dryRun: false,
      json: true,
      ...(operation === 'install' || operation === 'update' ? { version: '0.2.2' } : {}),
      ...extra,
    }),
  };
}

function inventory(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .flatMap(entry =>
      entry.isDirectory() ? inventory(join(root, entry.name)).map(name => `${entry.name}/${name}`) : [entry.name],
    )
    .sort();
}

describe('owned standalone plugin installation lifecycle', () => {
  it('recovers a valid dead-owner lock and preserves a live owner lock', async () => {
    const f = fixture();
    await runPluginOperation(f.options('install'), f.context);
    const statePath = inventory(f.home).find(path => path.endsWith('/state.json'));
    assert.ok(statePath);
    const state = JSON.parse(readFileSync(join(f.home, statePath), 'utf8')) as { binding: string };
    const path = join(dirname(join(f.home, statePath)), 'operation.lock');
    const deadPid = 2147483647;
    writeFileSync(
      path,
      JSON.stringify({ schema: 1, binding: state.binding, token: 'stale', pid: deadPid, groups: [] }),
      { mode: 0o600 },
    );
    f.version('0.2.3');
    f.context.runtimeVersion = '0.2.3';
    const recovered = await runPluginOperation(f.options('update', { version: '0.2.3' }), f.context);
    assert.equal(recovered.state, 'installed');
    assert.equal(existsSync(path), false);
    writeFileSync(
      path,
      JSON.stringify({ schema: 1, binding: state.binding, token: 'live', pid: process.pid, groups: [] }),
      { mode: 0o600 },
    );
    const blocked = await runPluginOperation(f.options('remove'), f.context);
    assert.equal(blocked.state, 'conflict');
    assert.equal((JSON.parse(readFileSync(path, 'utf8')) as { token: string }).token, 'live');
  });
  it('rejects different launcher bytes presented under the same version', async () => {
    const f = fixture();
    await runPluginOperation(f.options('install'), f.context);
    writeFileSync(join(f.pluginRoot, 'dist/mcp-launcher.js'), 'different candidate bytes');
    const result = await runPluginOperation(f.options('install'), f.context);
    assert.equal(result.state, 'conflict');
  });
  it('recovers an interrupted first installation without requiring a previous version', async () => {
    const f = fixture();
    f.interrupt();
    const interrupted = await runPluginOperation(f.options('install'), f.context);
    assert.equal(interrupted.state, 'pending_recovery');
    const recovered = await runPluginOperation(f.options('rollback'), f.context);
    assert.equal(recovered.state, 'removed');
    const retry = await runPluginOperation(f.options('install'), f.context);
    assert.equal(retry.state, 'installed');
  });
  it('preserves a manual MCP registration and unrelated native configuration', async () => {
    const f = fixture();
    mkdirSync(join(f.home, 'codex'), { recursive: true });
    const path = join(f.home, 'codex/config.toml');
    const original =
      '[mcp_servers.ai-memory]\ncommand = "node"\nargs = ["/existing/launcher.js"]\n[unrelated]\nanswer = 42\n';
    writeFileSync(path, original);
    const before = inventory(f.home);
    const result = await runPluginOperation(f.options('install'), f.context);
    assert.equal(result.state, 'conflict');
    assert.deepEqual(f.calls, []);
    assert.equal(readFileSync(path, 'utf8'), original);
    assert.deepEqual(inventory(f.home), before);
  });
  it('rejects corrupt retained bytes without reusing or replacing them', async () => {
    const f = fixture();
    await runPluginOperation(f.options('install'), f.context);
    const statePath = inventory(f.home).find(path => path.endsWith('/state.json'));
    assert.ok(statePath);
    const state = JSON.parse(readFileSync(join(f.home, statePath), 'utf8')) as { current: { root: string } };
    const changed = join(state.current.root, 'dist/mcp-launcher.js');
    writeFileSync(changed, 'corrupt bytes');
    const before = f.calls.length;
    const result = await runPluginOperation(f.options('install'), f.context);
    assert.equal(result.state, 'conflict');
    assert.equal(f.calls.length, before);
    assert.equal(readFileSync(changed, 'utf8'), 'corrupt bytes');
  });
  it('dry-run and unsupported Codex scope never call the native manager or write state', async () => {
    const f = fixture();
    const before = inventory(f.home);
    const plan = await runPluginOperation(f.options('install', { dryRun: true }), f.context);
    assert.equal(plan.state, 'planned');
    assert.deepEqual(f.calls, []);
    assert.deepEqual(inventory(f.home), before);
    const unsupported = await runPluginOperation(f.options('install', { scope: 'project' }), f.context);
    assert.equal(unsupported.state, 'unsupported');
    assert.deepEqual(f.calls, []);
    assert.deepEqual(inventory(f.home), before);
  });
  it('rejects a different requested runtime version before writing or registering anything', async () => {
    const f = fixture();
    const before = inventory(f.home);
    const result = await runPluginOperation(f.options('install', { version: '0.2.3' }), f.context);
    assert.equal(result.state, 'conflict');
    assert.deepEqual(f.calls, []);
    assert.deepEqual(inventory(f.home), before);
  });
  for (const host of ['codex', 'claude-code'] as const) {
    it(`${host} verifies native registration and launcher bytes; repeated installation is idempotent`, async () => {
      const f = fixture(host);
      const first = await runPluginOperation(f.options('install'), f.context);
      assert.equal(first.state, 'installed');
      assert.equal(first.plugin.version, '0.2.2');
      const mutations = f.calls.filter(args => args[1] !== 'list' && !args.includes('--help')).length;
      const second = await runPluginOperation(f.options('install'), f.context);
      assert.equal(second.state, 'installed');
      assert.equal(f.calls.filter(args => args[1] !== 'list' && !args.includes('--help')).length, mutations);
      assert.equal(second.mcp.state, 'not_checked');
      assert.equal(second.database.state, 'not_checked');
    });
  }
  it('updates and rolls back exact retained bytes, then removes only owned native registrations', async () => {
    const f = fixture();
    await runPluginOperation(f.options('install'), f.context);
    f.version('0.2.3');
    f.context.runtimeVersion = '0.2.3';
    const updated = await runPluginOperation(f.options('update', { version: '0.2.3' }), f.context);
    assert.equal(updated.plugin.version, '0.2.3');
    const rolled = await runPluginOperation(f.options('rollback'), f.context);
    assert.equal(rolled.plugin.version, '0.2.2');
    const removed = await runPluginOperation(f.options('remove'), f.context);
    assert.equal(removed.state, 'removed');
    assert.ok(f.calls.every(args => !args.some(arg => /unrelated|--all/u.test(arg))));
  });
  it('retains recovery state when replacement is interrupted and rollback recovers completed bytes', async () => {
    const f = fixture();
    await runPluginOperation(f.options('install'), f.context);
    f.version('0.2.3');
    f.context.runtimeVersion = '0.2.3';
    f.interrupt();
    const interrupted = await runPluginOperation(f.options('update', { version: '0.2.3' }), f.context);
    assert.equal(interrupted.state, 'pending_recovery');
    const rolled = await runPluginOperation(f.options('rollback'), f.context);
    assert.equal(rolled.state, 'installed');
    assert.equal(rolled.plugin.version, '0.2.2');
  });
  it('doctor with missing configuration is read-only and separates plugin/MCP/schema facts', async () => {
    const f = fixture();
    const before = inventory(f.home);
    const result = await runPluginOperation(f.options('doctor'), f.context);
    assert.equal(result.plugin.state, 'not_installed');
    assert.equal(result.mcp.state, 'not_checked');
    assert.equal(result.database.state, 'not_checked');
    assert.deepEqual(inventory(f.home), before);
  });
});
