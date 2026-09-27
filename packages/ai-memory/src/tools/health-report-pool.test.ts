// Behavioral regression test for the pg@9 client-query deprecation warning that the
// health-report runner. It routes statement_timeout
// and idle_in_transaction_session_timeout through pg startup parameters instead of an
// `on('connect')` `SET statement_timeout` handler that races the first pool-dispatched
// query on the same `pg.Client._queryQueue`.
//
// This test runs in its own file so it can install a top-level `vi.doMock('pg', ...)`
// before `health-report.ts` is imported. With the mock in place we instantiate the real
// `createHealthReportPool` helper, drive the concurrent metric-collection hot path, and
// assert behaviorally that:
//   - the pool never registers an `on('connect')` handler under our resolved config
//   - no `pg.Client.query` call dispatches against a client that already has an
//     in-flight query (the pg@9 deprecation condition)
//   - no `SET statement_timeout` / `SET idle_in_transaction_session_timeout` statement
//     is issued via `client.query`
//   - the pg@9 `Calling client.query() when the client is already executing a query`
//     warning is never emitted on the healthy path
//
// Why a separate file: `vi.doMock('pg', ...)` only affects modules imported after it
// runs. The main `health-report.test.ts` statically imports `health-report.ts` at the
// top of the file, so we cannot retrofit the mock there. Running this test in its own
// test module lets us install the mock before the first import.

import type { PoolConfig as PgPoolConfig } from 'pg';

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test, vi } from 'vitest';

interface ClientQueryLog {
  clientId: number;
  sql: string;
}

type ConnectListener = (client: unknown) => void;

const trackingState = {
  clientQueries: [] as ClientQueryLog[],
  connectListeners: [] as ConnectListener[],
  inFlightByClient: new Map<number, number>(),
  nextClientId: 0,
  poolConfigs: [] as unknown[],
  sameClientConcurrencyEvents: [] as string[],
};

class TrackingClient {
  public readonly id: number;

  constructor() {
    trackingState.nextClientId += 1;
    this.id = trackingState.nextClientId;
  }

  public async query(sql: string): Promise<{ rowCount: number; rows: Record<string, unknown>[] }> {
    recordClientQueryStart(this.id, sql);
    try {
      // Yield to the event loop so a same-client concurrent query that races this one
      // has a chance to be observed before we resolve.
      await Promise.resolve();
      return { rowCount: 0, rows: [] };
    } finally {
      recordClientQueryEnd(this.id);
    }
  }

  public release(): void {
    /* no-op */
  }
}

class TrackingPool extends EventEmitter {
  public constructor(public readonly config: PgPoolConfig) {
    super();
    trackingState.poolConfigs.push(config);
  }

  public connect(): Promise<TrackingClient> {
    const client = new TrackingClient();
    // Mirror pg.Pool semantics: fire registered 'connect' listeners synchronously the
    // first time the client is handed out. ai-db's attachSessionDefaults attaches such
    // a listener (and inside it calls `client.query('SET ...')`) when either timeout
    // is > 0. With our resolved config (both 0), no listener should be present, so this
    // loop should be a no-op on the healthy path.
    for (const listener of trackingState.connectListeners) {
      listener(client);
    }
    return Promise.resolve(client);
  }

  public end(): Promise<void> {
    return Promise.resolve();
  }

  public override on(event: string, listener: (...args: unknown[]) => void): this {
    if (event === 'connect') {
      trackingState.connectListeners.push(listener);
    }
    return super.on(event, listener);
  }

  public async query(sql: string): Promise<{ rowCount: number; rows: Record<string, unknown>[] }> {
    const client = await this.connect();
    try {
      return await client.query(sql);
    } finally {
      client.release();
    }
  }
}

function recordClientQueryEnd(clientId: number): void {
  const remaining = (trackingState.inFlightByClient.get(clientId) ?? 1) - 1;
  trackingState.inFlightByClient.set(clientId, remaining);
}

function recordClientQueryStart(clientId: number, sql: string): void {
  const prior = trackingState.inFlightByClient.get(clientId) ?? 0;
  if (prior > 0) {
    trackingState.sameClientConcurrencyEvents.push(
      `client ${String(clientId)}: "${sql.slice(0, 60)}" dispatched while ${String(prior)} other query(ies) were in flight`,
    );
  }
  trackingState.inFlightByClient.set(clientId, prior + 1);
  trackingState.clientQueries.push({ clientId, sql });
}

vi.doMock('pg', () => ({ default: { Pool: TrackingPool } }));

// Dynamic import is required so that the mock installed above is in place before
// `health-report.ts` resolves `import { createPool } from '@aviaratech/ai-memory/internal'`, which
// in turn does `import pg from 'pg'`.
const { createHealthReportPool } = (await import('./health-report.js')) as {
  createHealthReportPool: (config: { connectionString: string }) => {
    end(): Promise<void>;
    query(sql: string, params?: unknown[]): Promise<{ rowCount: number; rows: Record<string, unknown>[] }>;
  };
};

test('createHealthReportPool: no on-connect SET races client.query under concurrent metric load', async () => {
  // Drain state in case ordering changes ever stack runs of this test in one process.
  trackingState.clientQueries.length = 0;
  trackingState.connectListeners.length = 0;
  trackingState.inFlightByClient.clear();
  trackingState.nextClientId = 0;
  trackingState.poolConfigs.length = 0;
  trackingState.sameClientConcurrencyEvents.length = 0;

  const observedWarnings: string[] = [];
  const warningListener = (warning: Error): void => {
    observedWarnings.push(warning.message);
  };
  process.on('warning', warningListener);

  try {
    const pool = createHealthReportPool({ connectionString: 'postgresql://localhost:5432/test_db' });

    // `collectDatabaseMetrics` dispatches ~30 parallel queries through Promise.all. We
    // drive a similar concurrent shape so the on-connect-SET race (if it existed) would
    // have ample opportunity to interleave against the same fresh client.
    await Promise.all(Array.from({ length: 12 }, (_, index) => pool.query(`SELECT ${String(index)}`)));
    await pool.end();
  } finally {
    process.off('warning', warningListener);
  }

  // Contract 1: ai-db's attachSessionDefaults must short-circuit when both timeouts are 0.
  // No 'connect' listener registration means no client.query('SET ...') can fire and race
  // the first pool-dispatched user query against the same pg.Client.
  assert.equal(
    trackingState.connectListeners.length,
    0,
    'ai-db must register zero "connect" listeners under the resolved config — that is the SET race path',
  );

  // Contract 2: no client was ever asked to run two queries simultaneously. This is the
  // exact precondition for the pg@9 client-queue deprecation; tracking it on the mock
  // gives a tighter signal than the warning observation alone.
  assert.deepEqual(
    trackingState.sameClientConcurrencyEvents,
    [],
    'no client may have two queries in flight at once on the healthy path',
  );

  // Contract 3: no `SET statement_timeout` or `SET idle_in_transaction_session_timeout`
  // is issued through client.query. The healthy path must deliver these via pg startup
  // parameters, captured in the pool config below.
  const setStatements = trackingState.clientQueries.filter(entry => entry.sql.startsWith('SET '));
  assert.deepEqual(setStatements, [], 'no SET statement may be issued through client.query on the healthy path');

  // Contract 4: the pool was built with the expected startup-parameter shape, so the
  // Postgres backend applies timeouts before any application query runs.
  assert.ok(trackingState.poolConfigs.length > 0, 'TrackingPool must have been constructed');
  const poolConfig = trackingState.poolConfigs[0] as PgPoolConfig & {
    idle_in_transaction_session_timeout?: number;
    statement_timeout?: number;
  };
  assert.ok(
    typeof poolConfig.statement_timeout === 'number' && poolConfig.statement_timeout > 0,
    'statement_timeout must be threaded into pg.Pool config as a startup parameter',
  );
  assert.ok(
    typeof poolConfig.idle_in_transaction_session_timeout === 'number' &&
      poolConfig.idle_in_transaction_session_timeout > 0,
    'idle_in_transaction_session_timeout must be threaded into pg.Pool config as a startup parameter',
  );

  // Contract 5: pg@9 deprecation warning was not emitted by anything during the run.
  const offendingWarning = observedWarnings.find(message =>
    message.includes('Calling client.query() when the client is already executing a query'),
  );
  assert.equal(offendingWarning, undefined, 'pg@9 client.query deprecation warning must not fire on the healthy path');
});
