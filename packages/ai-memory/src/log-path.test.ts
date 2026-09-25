import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'vitest';

import { resolveLogFilePath } from './log-path.js';

function withEnv(overrides: Record<string, string | undefined>, testFn: () => void) {
  const previousLogFile = process.env.AI_MEMORY_LOG_FILE;
  const previousLogDir = process.env.AI_MEMORY_LOG_DIR;

  if (overrides.AI_MEMORY_LOG_FILE === undefined) {
    delete process.env.AI_MEMORY_LOG_FILE;
  } else {
    process.env.AI_MEMORY_LOG_FILE = overrides.AI_MEMORY_LOG_FILE;
  }

  if (overrides.AI_MEMORY_LOG_DIR === undefined) {
    delete process.env.AI_MEMORY_LOG_DIR;
  } else {
    process.env.AI_MEMORY_LOG_DIR = overrides.AI_MEMORY_LOG_DIR;
  }

  try {
    testFn();
  } finally {
    if (previousLogFile === undefined) {
      delete process.env.AI_MEMORY_LOG_FILE;
    } else {
      process.env.AI_MEMORY_LOG_FILE = previousLogFile;
    }

    if (previousLogDir === undefined) {
      delete process.env.AI_MEMORY_LOG_DIR;
    } else {
      process.env.AI_MEMORY_LOG_DIR = previousLogDir;
    }
  }
}

test('resolveLogFilePath prioritizes AI_MEMORY_LOG_FILE over directory override', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'ai-memory-log-path-'));
  const logFile = resolve(tempDir, 'explicit.log');
  const legacyDir = mkdtempSync(join(tmpdir(), 'ai-memory-log-dir-'));

  try {
    withEnv(
      {
        AI_MEMORY_LOG_DIR: legacyDir,
        AI_MEMORY_LOG_FILE: logFile,
      },
      () => {
        const resolved = resolveLogFilePath();
        assert.equal(resolved.path, logFile);
        assert.equal(resolved.source, 'env_override_file');
      },
    );
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
    rmSync(legacyDir, { force: true, recursive: true });
  }
});

test('resolveLogFilePath uses AI_MEMORY_LOG_DIR + ai-memory.log when explicit file is absent', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'ai-memory-log-dir-'));

  try {
    withEnv({ AI_MEMORY_LOG_DIR: tempDir, AI_MEMORY_LOG_FILE: undefined }, () => {
      const resolved = resolveLogFilePath();
      assert.equal(resolved.path, resolve(tempDir, 'ai-memory.log'));
      assert.equal(resolved.source, 'env_override_dir');
    });
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test('resolveLogFilePath uses the current directory when no override is provided', () => {
  withEnv({ AI_MEMORY_LOG_DIR: undefined, AI_MEMORY_LOG_FILE: undefined }, () => {
    const resolved = resolveLogFilePath();
    assert.equal(resolved.path, resolve(process.cwd(), '.logs', 'ai-memory.log'));
    assert.equal(resolved.source, 'repo_root');
  });
});
