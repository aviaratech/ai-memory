import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'vitest';

import { loadPluginRuntimeEnv } from './pluginEnv.js';
import * as configuration from './pluginEnv.js';

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
  it('refuses symlinked configuration directories before reading a protected file', () => {
    const { home } = fixture();
    rmSync(join(home, '.config/ai-memory'), { recursive: true });
    const other = join(home, 'other');
    mkdirSync(other, { mode: 0o700 });
    writeFileSync(
      join(other, 'plugin.env'),
      'AI_MEMORY_DATABASE_URL=postgresql://runtime:fixture@127.0.0.1/ai_memory\n',
      { mode: 0o600 },
    );
    symlinkSync(other, join(home, '.config/ai-memory'));
    assert.throws(() => loadPluginRuntimeEnv({ home, env: {} }), /protected|configuration_conflict/iu);
  });
  it('refuses a replaced parent directory rather than publishing into a changed preimage', () => {
    const { home } = fixture();
    const publication = configuration.preparePluginDatabaseConfig({
      home,
      databaseUrl: 'postgresql://runtime:fixture@127.0.0.1/ai_memory',
    });
    renameSync(join(home, '.config/ai-memory'), join(home, '.config/previous'));
    mkdirSync(join(home, '.config/ai-memory'), { mode: 0o700 });
    assert.throws(() => {
      publication.commit();
    }, /configuration_conflict/u);
    assert.deepEqual(readdirSync(join(home, '.config/ai-memory')), []);
  });
  it('publishes a new private configuration atomically and leaves a matching existing file byte-for-byte intact', () => {
    const { home, file } = fixture();
    const url = 'postgresql://runtime:fixture@127.0.0.1/ai_memory';
    configuration.preparePluginDatabaseConfig({ home, databaseUrl: url }).commit();
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(loadPluginRuntimeEnv({ home, env: {} }).runtime.databaseUrl, url);
    const text = `# keep this comment\nAI_MEMORY_DATABASE_URL=${url}\nUNRELATED_SETTING=keep-me\n`;
    writeFileSync(file, text, { mode: 0o600 });
    configuration.preparePluginDatabaseConfig({ home, databaseUrl: url }).commit();
    assert.equal(readFileSync(file, 'utf8'), text);
    assert.deepEqual(readdirSync(join(home, '.config/ai-memory')), ['plugin.env']);
  });
  it('refuses changed preimages, incompatible existing configuration and symlinked ancestors without overwrite', () => {
    const { home, file } = fixture();
    const url = 'postgresql://runtime:fixture@127.0.0.1/ai_memory';
    const publication = configuration.preparePluginDatabaseConfig({ home, databaseUrl: url });
    writeFileSync(file, 'UNRELATED_SETTING=keep-me\n', { mode: 0o600 });
    assert.throws(() => {
      publication.commit();
    }, /configuration_conflict/u);
    assert.equal(readFileSync(file, 'utf8'), 'UNRELATED_SETTING=keep-me\n');
    assert.throws(
      () => configuration.preparePluginDatabaseConfig({ home, databaseUrl: url }),
      /configuration_conflict/u,
    );
    rmSync(join(home, '.config/ai-memory'), { recursive: true });
    const elsewhere = join(home, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, join(home, '.config/ai-memory'));
    assert.throws(
      () => configuration.preparePluginDatabaseConfig({ home, databaseUrl: url }),
      /configuration_conflict/u,
    );
    assert.deepEqual(readdirSync(elsewhere), []);
  });
  it('checks the existing file preimage again even when its initial database URL matched', () => {
    const { home, file } = fixture();
    const url = 'postgresql://runtime:fixture@127.0.0.1/ai_memory';
    writeFileSync(file, `AI_MEMORY_DATABASE_URL=${url}\n`, { mode: 0o600 });
    const publication = configuration.preparePluginDatabaseConfig({ home, databaseUrl: url });
    writeFileSync(file, 'UNRELATED_SETTING=newer\n');
    assert.throws(() => {
      publication.commit();
    }, /configuration_conflict/u);
    assert.equal(readFileSync(file, 'utf8'), 'UNRELATED_SETTING=newer\n');
  });
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
