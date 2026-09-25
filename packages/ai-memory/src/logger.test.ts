import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { afterEach, test, vi } from 'vitest';

afterEach(() => {
  mock.restoreAll();
});

test('logAiMemoryWarn does not throw when file log path cannot be resolved', async () => {
  const stderrChunks: string[] = [];

  vi.doMock('./log-path.js', () => ({
    resolveLogFilePath() {
      throw new Error('Unable to resolve log file path from repository root');
    },
  }));

  mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  });

  const { logAiMemoryWarn } = await import('./logger.js');

  assert.doesNotThrow(() => {
    logAiMemoryWarn('mcp.postgres_unavailable', {
      message: 'Postgres unavailable at postgresql://localhost:5432/ai_memory',
    });
  });

  assert.ok(
    stderrChunks.some(chunk => chunk.includes('unable to write log file')),
    'expected a logger fallback warning on stderr',
  );
  assert.ok(
    stderrChunks.some(chunk => chunk.includes('[ai-memory][warn] Postgres unavailable')),
    'expected the original ai-memory warning summary on stderr',
  );
});
