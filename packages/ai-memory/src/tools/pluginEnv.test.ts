import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'vitest';

import { loadPluginRuntimeEnv } from './pluginEnv.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture(): { home: string; file: string } {
  const home = mkdtempSync(join(tmpdir(), 'ai-memory-plugin-env-'));
  homes.push(home);
  mkdirSync(join(home, '.config/ai-memory'), { recursive: true, mode: 0o700 });
  return { home, file: join(home, '.config/ai-memory/plugin.env') };
}

describe('protected standalone plugin configuration', () => {
  it('retains explicitly configured classification settings without calling a provider', () => {
    const { home, file } = fixture();
    writeFileSync(
      file,
      'AI_MEMORY_DATABASE_URL=postgresql://runtime:fixture@127.0.0.1/ai_memory\nAI_MEMORY_CLASSIFY_API_KEY=fixture-only\nAI_MEMORY_CLASSIFY_MODEL=fixture-model\n',
      { mode: 0o600 },
    );
    const result = loadPluginRuntimeEnv({ home, env: {} });
    assert.equal(result.env.AI_MEMORY_CLASSIFY_API_KEY, 'fixture-only');
    assert.equal(result.env.AI_MEMORY_CLASSIFY_MODEL, 'fixture-model');
  });
  it('loads only the dedicated protected file through the established runtime parser', () => {
    const { home, file } = fixture();
    writeFileSync(file, "AI_MEMORY_DATABASE_URL='postgresql://runtime:synthetic-secret@127.0.0.1/ai_memory'\n", {
      mode: 0o600,
    });
    const env = { HOME: home };
    const result = loadPluginRuntimeEnv({ home, env });
    assert.equal(result.fileState, 'protected');
    assert.equal(result.runtime.status, 'ok');
    assert.equal(result.runtime.resolvedVia, 'global_plugins_env');
    assert.equal(result.env.AI_MEMORY_DATABASE_URL, 'postgresql://runtime:synthetic-secret@127.0.0.1/ai_memory');
    assert.deepEqual(env, { HOME: home });
  });
  it('preserves a missing file and supplies actionable missing configuration', () => {
    const { home } = fixture();
    const result = loadPluginRuntimeEnv({ home, env: {} });
    assert.equal(result.fileState, 'missing');
    assert.equal(result.runtime.status, 'missing');
  });
  it('refuses an exposed or symlinked file without returning its contents', () => {
    const { home, file } = fixture();
    writeFileSync(file, 'AI_MEMORY_DATABASE_URL=postgresql://user:do-not-print@localhost/ai_memory\n', { mode: 0o644 });
    assert.throws(() => loadPluginRuntimeEnv({ home, env: {} }), /protected.*0600/iu);
    chmodSync(file, 0o600);
    const other = join(home, 'other.env');
    writeFileSync(other, 'AI_MEMORY_DATABASE_URL=private-value', { mode: 0o600 });
    rmSync(file);
    symlinkSync(other, file);
    assert.throws(() => loadPluginRuntimeEnv({ home, env: {} }), /protected/iu);
  });
});
