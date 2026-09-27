import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('importing the core package root exits without starting operational services', () => {
  const env = { ...process.env };
  delete env.AI_MEMORY_DATABASE_URL;
  delete env.DATABASE_URL;
  const output = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', "import('@aviaratech/ai-memory').then(() => process.stdout.write('ready\\n'))"],
    { cwd: packageRoot, encoding: 'utf8', env, timeout: 5_000 },
  );
  assert.equal(output, 'ready\n');
});

test('ingestion and server subpaths expose the moved entry points', async () => {
  const ingestion = await import('@aviaratech/ai-memory/ingestion');
  const server = await import('@aviaratech/ai-memory/server');
  assert.equal(typeof ingestion.runIngestPipeline, 'function');
  assert.equal(typeof server.server.connect, 'function');
});
