import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
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
  assert.equal(typeof ingestion.ingestTelemetryEvent, 'function');
  assert.equal(typeof server.server.connect, 'function');
});

test('importing ingestion stays inert without an explicit database target', () => {
  const env = { ...process.env };
  delete env.AI_MEMORY_DATABASE_URL;
  delete env.DATABASE_URL;
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import('@aviaratech/ai-memory/ingestion').then(() => process.stdout.write('ready\\n'))",
    ],
    { cwd: packageRoot, encoding: 'utf8', env, timeout: 5000 },
  );
  assert.equal(output, 'ready\n');
});

test('health workflow CLI executes through a symlinked package path', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-memory-health-alias-'));
  try {
    const alias = join(root, 'health.mjs');
    symlinkSync(join(packageRoot, 'dist/tools/health-report.js'), alias);
    let error: unknown;
    try {
      execFileSync(process.execPath, [alias, '--workflow', '--project', 'invalid', '--task', 'task-1', '--json'], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH },
        stdio: 'pipe',
        timeout: 5000,
      });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error && typeof error === 'object' && 'status' in error && 'stderr' in error);
    assert.equal(error.status, 1);
    assert.equal(String(error.stderr), 'invalid_workflow_scope\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
