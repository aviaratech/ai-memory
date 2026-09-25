import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';

const serverJs = join(fileURLToPath(import.meta.url), '../../dist/server.js');

test('ai-memory-mcp --help works through a symlink (pnpm bin shim regression)', () => {
  const tmpDir = mkdtempSync(join(fileURLToPath(import.meta.url), '../../../.tmp-bin-test-'));
  const symlink = join(tmpDir, 'ai-memory-mcp');
  try {
    symlinkSync(serverJs, symlink);
    const stdout = execFileSync(process.execPath, [symlink, '--help'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        AI_MEMORY_DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      },
      timeout: 10_000,
    });
    assert.match(stdout, /hook:session-start/, 'expected --help to print usage including hook:session-start');
    assert.match(stdout, /hook:session-end/, 'expected --help to print usage including hook:session-end');
  } finally {
    try {
      unlinkSync(symlink);
    } catch {
      /* cleanup best-effort */
    }
    try {
      rmdirSync(tmpDir);
    } catch {
      /* cleanup best-effort */
    }
  }
});

test('ai-memory-mcp diagnose-env prints a sanitized runtime report', () => {
  const stdout = execFileSync(process.execPath, [serverJs, 'diagnose-env'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AI_MEMORY_DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    },
    timeout: 10_000,
  });

  const diagnostics: unknown = JSON.parse(stdout);
  assert.deepStrictEqual(diagnostics, {
    authMode: 'url',
    databaseHost: 'localhost',
    databaseName: 'test',
    databaseUrlHost: 'localhost',
    databaseUrlPresent: true,
    resolvedKey: 'AI_MEMORY_DATABASE_URL',
    resolvedSource: 'canonical',
    resolvedVia: 'process_env',
    status: 'ok',
  });
});
