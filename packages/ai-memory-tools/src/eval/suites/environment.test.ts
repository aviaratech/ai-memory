import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'vitest';

import { runEnvironmentSuite } from './environment.js';

test('runEnvironmentSuite returns skip when environment fixtures are missing', async () => {
  const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'ai-memory-environment-fixtures-missing-'));

  try {
    const report = await runEnvironmentSuite({ fixturesRoot: fixtureRoot });
    assert.equal(report.suite, 'environment');
    assert.equal(report.failed, 0);
    assert.equal(report.passed, 0);
    assert.equal(report.skipped, 1);
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});
