import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, '..', '..', '..');
const AI_MEMORY_PLUGIN_MANIFEST_PATH = resolve(REPO_ROOT, 'plugins', 'ai-memory', '.claude-plugin', 'plugin.json');
const REQUIRED_AI_MEMORY_RUNTIME_ENV_KEYS = [
  'AI_MEMORY_DATABASE_URL',
  'AI_MEMORY_EMBEDDING_API_KEY',
  'AI_MEMORY_EMBEDDING_MODEL',
  'AI_MEMORY_EMBEDDING_PROVIDER',
  'AI_MEMORY_EMBEDDING_TIMEOUT_MS',
] as const;

interface PluginManifest {
  envKeys?: { key?: unknown }[];
}

test('ai-memory plugin manifest declares embedding env keys for installed MCP runtime forwarding', () => {
  const manifest = JSON.parse(readFileSync(AI_MEMORY_PLUGIN_MANIFEST_PATH, 'utf8')) as PluginManifest;
  const envKeys = new Set(
    manifest.envKeys?.map(entry => entry.key).filter((key): key is string => typeof key === 'string') ?? [],
  );

  for (const key of REQUIRED_AI_MEMORY_RUNTIME_ENV_KEYS) {
    assert.equal(envKeys.has(key), true, `${key} must be declared in ai-memory plugin envKeys`);
  }
  assert.equal(envKeys.has('AWS_REGION'), false);
  assert.equal(envKeys.has('DB_HOST'), false);
});
