import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'vitest';

import { diagnosePluginRuntime } from './pluginDoctor.js';
import type { PluginResult } from './pluginInstallation.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture(configured: boolean) {
  const home = mkdtempSync(join(tmpdir(), 'ai-memory-plugin-doctor-'));
  homes.push(home);
  mkdirSync(join(home, '.config/ai-memory'), { recursive: true, mode: 0o700 });
  if (configured)
    writeFileSync(
      join(home, '.config/ai-memory/plugin.env'),
      'AI_MEMORY_DATABASE_URL=postgresql://admin:do-not-print@127.0.0.1/ai_memory\nAI_MEMORY_EMBEDDING_API_KEY=never-use\nAI_MEMORY_CLASSIFY_API_KEY=never-use\n',
      { mode: 0o600 },
    );
  const diagnostic: PluginResult = {
    ok: false,
    state: 'configuration_required',
    message: '',
    actions: [],
    host: 'codex',
    scope: 'user',
    plugin: { state: 'discovered', version: '0.2.2' },
    hooks: { state: 'requires_native_trust_or_restart' },
    mcp: { state: 'not_checked' },
    database: { state: 'not_checked' },
  };
  return {
    home,
    diagnostic,
    input: { home, env: { HOME: home }, launcher: join(home, 'plugin/dist/mcp-launcher.js'), version: '0.2.2' },
  };
}
describe('read-only native plugin doctor', () => {
  it('does not connect or start MCP without usable protected configuration', async () => {
    const f = fixture(false);
    let called = false;
    const result = await diagnosePluginRuntime(f.diagnostic, f.input, {
      databaseProbe: async () => {
        called = true;
        return 'ready';
      },
      mcpProbe: async () => {
        called = true;
        return true;
      },
    });
    assert.equal(called, false);
    assert.equal(result.database.state, 'not_checked');
    assert.equal(result.mcp.state, 'not_checked');
    assert.equal(result.state, 'configuration_required');
  });
  it('probes the selected plugin migrations read-only and strips provider configuration', async () => {
    const f = fixture(true);
    let observed = false;
    const result = await diagnosePluginRuntime(f.diagnostic, f.input, {
      databaseProbe: async (env, migrations) => {
        observed = true;
        assert.ok(env.AI_MEMORY_DATABASE_URL?.includes('default_transaction_read_only'));
        assert.equal(migrations, join(f.home, 'plugin/migrations'));
        assert.equal(env.AI_MEMORY_EMBEDDING_API_KEY, undefined);
        assert.equal(env.AI_MEMORY_CLASSIFY_API_KEY, undefined);
        return 'ready';
      },
      mcpProbe: async env => {
        assert.equal(env.AI_MEMORY_MCP_AUTO_START_POSTGRES, 'false');
        assert.equal(env.AI_MEMORY_MCP_REQUIRE_POSTGRES, 'true');
        assert.equal(env.AI_MEMORY_PLUGIN_DOCTOR, '1');
        return true;
      },
    });
    assert.equal(observed, true);
    assert.equal(result.database.state, 'ready');
    assert.equal(result.mcp.state, 'connected');
    assert.equal(result.hooks.state, 'requires_native_trust_or_restart');
    assert.ok(!JSON.stringify(result).includes('do-not-print'));
    assert.ok(!JSON.stringify(result).includes('never-use'));
  });
  it('never starts MCP when a matching complete schema is not verified', async () => {
    const f = fixture(true);
    let called = false;
    const result = await diagnosePluginRuntime(f.diagnostic, f.input, {
      databaseProbe: async () => 'administrator_required',
      mcpProbe: async () => {
        called = true;
        return true;
      },
    });
    assert.equal(result.database.state, 'administrator_required');
    assert.equal(result.mcp.state, 'not_checked');
    assert.equal(called, false);
  });
});
