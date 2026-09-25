import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { test, vi } from 'vitest';

import type { DbConfig } from './pool.js';
import type * as RuntimeModule from './runtime.js';

const previousUrl = process.env.AI_MEMORY_DATABASE_URL;
const previousHost = process.env.DB_HOST;
const calls: DbConfig[] = [];
const fakePool = {
  connect: mock.fn(),
  end: mock.fn(() => Promise.resolve()),
  getClient: mock.fn(),
  query: mock.fn(() => Promise.resolve({ rowCount: 1, rows: [] })),
};
vi.doMock('./pool.js', () => ({
  assertLocalDatabaseUrl: (value: string) => value,
  createPool: (config: DbConfig) => {
    calls.push(config);
    return fakePool;
  },
}));

async function runtime(): Promise<typeof RuntimeModule> {
  vi.resetModules();
  return await import('./runtime.js');
}

function restore() {
  if (previousUrl === undefined) delete process.env.AI_MEMORY_DATABASE_URL;
  else process.env.AI_MEMORY_DATABASE_URL = previousUrl;
  if (previousHost === undefined) delete process.env.DB_HOST;
  else process.env.DB_HOST = previousHost;
}

test('runtime selects only its explicit local URL even when shared DB variables exist', async () => {
  calls.length = 0;
  process.env.AI_MEMORY_DATABASE_URL = 'postgresql://example:example@127.0.0.1:5432/ai_memory_test';
  process.env.DB_HOST = 'unrelated.example.invalid';
  try {
    await (await runtime()).pool.query('SELECT 1');
  } finally {
    restore();
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.connectionString, 'postgresql://example:example@127.0.0.1:5432/ai_memory_test');
  assert.equal(typeof calls[0]?.pgOptions?.query_timeout, 'number');
});

test('runtime fails closed without AI_MEMORY_DATABASE_URL', async () => {
  calls.length = 0;
  delete process.env.AI_MEMORY_DATABASE_URL;
  process.env.DB_HOST = 'unrelated.example.invalid';
  try {
    const module = await runtime();
    assert.throws(() => module.pool.query('SELECT 1'), /AI_MEMORY_DATABASE_URL is required/u);
  } finally {
    restore();
  }
  assert.equal(calls.length, 0);
});
