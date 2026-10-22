import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { afterEach, test, vi } from 'vitest';

import { parseArgs } from './backfill-embeddings.js';

const runtime = vi.hoisted(() => ({
  available: false,
  close: () => {},
  embeddings: [] as string[],
  failBatchAfterFirstWrite: false,
  initialized: 0,
  queries: [] as string[],
  rows: [] as { content: string; embedded: boolean; id: number }[],
}));

vi.mock('../runtimeEnv.js', () => ({ bootstrapAiMemoryCliRuntimeEnv: () => {} }));
vi.mock('@aviaratech/ai-memory/internal', () => ({
  closePool: () => {
    runtime.close();
    return Promise.resolve();
  },
  getDatabaseUrlForDisplay: () => 'synthetic-fixture',
  getEmbedding: (content: string) => {
    runtime.embeddings.push(content);
    return Promise.resolve([0.1, 0.2]);
  },
  initializeDatabase: () => {
    runtime.initialized += 1;
    return Promise.resolve();
  },
  isEmbeddingAvailable: () => runtime.available,
  pool: {
    connect: () =>
      Promise.resolve({
        query: (sql: string, params: unknown[] = []) => {
          runtime.queries.push(sql);
          if (sql.includes('UPDATE ai_memory_entries')) {
            const row = runtime.rows.find(row => row.id === params[1]);
            if (row) row.embedded = true;
            return Promise.resolve({ rowCount: row ? 1 : 0, rows: [] });
          }
          return Promise.resolve({ rows: [] });
        },
        release: () => {},
      }),
    query: (sql: string, params: unknown[] = []) => {
      runtime.queries.push(sql);
      if (sql.includes('COUNT(*)'))
        return Promise.resolve({ rows: [{ count: String(runtime.rows.filter(row => !row.embedded).length) }] });
      if (runtime.failBatchAfterFirstWrite && runtime.rows.some(row => row.embedded)) {
        runtime.failBatchAfterFirstWrite = false;
        return Promise.reject(new Error('Synthetic interruption before the next batch.'));
      }
      return Promise.resolve({
        rows: runtime.rows
          .filter(row => !row.embedded && row.id > Number(params[1]))
          .slice(0, Number(params[2]))
          .map(row => ({ category: 'convention', content: row.content, id: row.id })),
      });
    },
  },
  SESSION_SUMMARY_CATEGORY: 'session-summary',
}));

afterEach(() => {
  vi.restoreAllMocks();
  runtime.available = false;
  runtime.embeddings = [];
  runtime.failBatchAfterFirstWrite = false;
  runtime.initialized = 0;
  runtime.queries = [];
  runtime.rows = [];
});

async function runCli(args: string[]): Promise<number | undefined> {
  const argv = process.argv;
  const exitCode = process.exitCode;
  let finished!: () => void;
  const closed = new Promise<void>(resolve => {
    finished = resolve;
  });
  runtime.close = finished;
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  process.argv = [argv[0]!, fileURLToPath(new URL('./backfill-embeddings.ts', import.meta.url)), ...args];
  process.exitCode = undefined;
  try {
    vi.resetModules();
    await import('./backfill-embeddings.js');
    await closed;
    return process.exitCode;
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
  }
}

test('backfill embeddings parser ignores pnpm argument separator', () => {
  const options = parseArgs(['--', '--dry-run', '--skip-init']);

  assert.equal(options.dryRun, true);
  assert.equal(options.skipInit, true);
});

test('embedding dry-run plans eligible durable work without a provider or schema initialization', async () => {
  runtime.rows = [{ content: 'Preserve the durable convention.', embedded: false, id: 1 }];
  assert.equal(await runCli(['--dry-run']), undefined);
  assert.equal(runtime.initialized, 0);
  assert.deepEqual(runtime.embeddings, []);
  const count = runtime.queries.find(sql => sql.includes('COUNT(*)'));
  assert.ok(count !== undefined);
  assert.ok(count.includes('memory_key IS NOT NULL'));
  assert.ok(count.includes("'manual-flush'"));
  assert.ok(count.includes('expires_at IS NULL OR expires_at > NOW()'));
  assert.ok(!runtime.queries.some(sql => sql.includes('UPDATE ai_memory_entries')));
});

test('embedding backfill reuses committed rows after interruption between batches', async () => {
  runtime.available = true;
  runtime.rows = [
    { content: 'First durable fact.', embedded: false, id: 1 },
    { content: 'Second durable fact.', embedded: false, id: 2 },
  ];
  runtime.failBatchAfterFirstWrite = true;
  assert.equal(await runCli(['--apply', '--skip-init', '--batch-size', '1', '--delay-ms', '0']), 1);
  assert.deepEqual(runtime.embeddings, ['First durable fact.']);
  assert.equal(await runCli(['--apply', '--skip-init', '--batch-size', '1', '--delay-ms', '0']), undefined);
  assert.deepEqual(runtime.embeddings, ['First durable fact.', 'Second durable fact.']);
  assert.ok(runtime.rows.every(row => row.embedded));
});
