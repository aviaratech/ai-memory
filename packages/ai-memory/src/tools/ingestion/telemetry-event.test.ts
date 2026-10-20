import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import type { DbPool, DbResult } from '../../db/pool.js';
import { ingestTelemetryEvent } from './telemetry-event.js';

afterEach(() => vi.unstubAllEnvs());
const input = {
  schemaVersion: 1,
  kind: 'edge',
  source: 'producer',
  producer: 'fixture',
  eventId: 'event-1',
  projectId: `sha256:${'a'.repeat(64)}`,
  taskId: 'task-1',
  stage: 'verify',
  edge: 'failure',
  evidenceIds: ['proof-1'],
};

test('invalid producer data never acquires a pool or returns its private fields', async () => {
  let connected = 0;
  const fail = () => {
    connected++;
    throw new Error('PRIVATE_SENTINEL');
  };
  const db: DbPool = { connect: fail, getClient: fail, query: fail, end: fail };
  assert.deepEqual(await ingestTelemetryEvent({ ...input, prompt: 'PRIVATE_SENTINEL' }, { dbPool: db }), {
    status: 'rejected',
    code: 'invalid_event',
  });
  assert.equal(connected, 0);
});

test('supplied pool stays caller-owned and database failures are fixed-code unavailable', async () => {
  let ended = 0;
  let released = 0;
  const client = {
    release() {
      released++;
    },
    async query<T>(): Promise<DbResult<T>> {
      throw new Error('PRIVATE_SENTINEL');
    },
  };
  const db: DbPool = {
    connect: async () => client,
    getClient: async () => client,
    query: () => client.query(),
    end: async () => {
      ended++;
    },
  };
  assert.deepEqual(await ingestTelemetryEvent(input, { dbPool: db }), {
    status: 'unavailable',
    code: 'storage_unavailable',
  });
  assert.equal(released, 1);
  assert.equal(ended, 0);
});

test('missing explicit configuration fails open without provisioning a database', async () => {
  vi.stubEnv('AI_MEMORY_DATABASE_URL', undefined);
  assert.deepEqual(await ingestTelemetryEvent(input), { status: 'unavailable', code: 'storage_unavailable' });
});

test('successful supplied-pool ingestion stores only bounded typed parameters', async () => {
  const parameters: unknown[][] = [];
  const client = {
    release() {},
    async query<T>(sql: string, params: unknown[] = []): Promise<DbResult<T>> {
      parameters.push(params);
      return { rowCount: sql.startsWith('INSERT') ? 1 : 0, rows: [] };
    },
  };
  const db: DbPool = {
    connect: async () => client,
    getClient: async () => client,
    query: (sql, params) => client.query(sql, params),
    end: async () => {
      throw new Error('caller-owned pool closed');
    },
  };
  assert.deepEqual(await ingestTelemetryEvent(input, { dbPool: db }), { status: 'stored' });
  assert.ok(parameters.some(values => values.includes('task-1')));
  assert.equal(JSON.stringify(parameters).includes('prompt'), false);
});
