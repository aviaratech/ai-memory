import assert from 'node:assert/strict';
import { test } from 'vitest';

import { loadAiMemoryInternalLogging, MISSING_AI_MEMORY_BUILD_WARNING } from './aiMemoryInternalLogging.js';

test('falls back cleanly when ai-memory build artifacts are unavailable', async () => {
  const warningMessages: string[] = [];
  const originalStderrSetting = process.env.AI_MEMORY_LOG_STDERR;

  try {
    process.env.AI_MEMORY_LOG_STDERR = '0';

    const moduleLoadError = Object.assign(
      new Error(
        "Cannot find module '/tmp/worktree/packages/ai-memory/dist/internal.js' imported from /tmp/worktree/packages/ai-memory-tools/src/ensure-postgres.ts",
      ),
      {
        code: 'ERR_MODULE_NOT_FOUND',
      },
    );

    const logging = await loadAiMemoryInternalLogging({
      loadInternal: () => Promise.reject(moduleLoadError),
      warn(message) {
        warningMessages.push(message);
      },
    });

    assert.equal(logging.usingFallback, true);
    assert.equal(logging.formatError(moduleLoadError), moduleLoadError.message);
    logging.logAiMemoryWarn('postgres.not_running', {
      message: 'Postgres unavailable',
    });

    assert.equal(warningMessages.length, 1);
    assert.match(
      warningMessages[0] ?? '',
      new RegExp(MISSING_AI_MEMORY_BUILD_WARNING.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')),
    );
  } finally {
    if (originalStderrSetting === undefined) {
      delete process.env.AI_MEMORY_LOG_STDERR;
    } else {
      process.env.AI_MEMORY_LOG_STDERR = originalStderrSetting;
    }
  }
});

test('falls back when Node reports the missing ai-memory internal specifier directly', async () => {
  const moduleLoadError = Object.assign(
    new Error(
      "Cannot find package '@aviaratech/ai-memory/internal' imported from /tmp/worktree/packages/ai-memory-tools/src/ensure-postgres.ts",
    ),
    {
      code: 'ERR_MODULE_NOT_FOUND',
      specifier: '@aviaratech/ai-memory/internal',
    },
  );

  const logging = await loadAiMemoryInternalLogging({
    loadInternal: () => Promise.reject(moduleLoadError),
    warn() {},
  });

  assert.equal(logging.usingFallback, true);
});

test('rethrows transitive module-not-found errors from ai-memory internal', async () => {
  const transitiveMissingDependencyError = Object.assign(
    new Error("Cannot find package 'pg' imported from /tmp/worktree/packages/ai-memory/dist/internal.js"),
    {
      code: 'ERR_MODULE_NOT_FOUND',
      specifier: 'pg',
    },
  );

  await assert.rejects(
    () =>
      loadAiMemoryInternalLogging({
        loadInternal: () => Promise.reject(transitiveMissingDependencyError),
      }),
    transitiveMissingDependencyError,
  );
});

test('rethrows unexpected ai-memory internal load errors', async () => {
  const unexpectedError = new Error('permission denied');

  await assert.rejects(
    () =>
      loadAiMemoryInternalLogging({
        loadInternal: () => Promise.reject(unexpectedError),
      }),
    unexpectedError,
  );
});
