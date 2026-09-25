/**
 * Test helper: mocks `pool.connect()` to return a fake client that captures
 * task-SQL through `handler` and silently absorbs transaction overhead
 * (`BEGIN`, `SET LOCAL statement_timeout = N`, `COMMIT`, `ROLLBACK`).
 *
 * Memory-api read/write helpers route through `runBoundedQuery`, which wraps
 * every operation in a transaction. Tests that need to assert task-SQL should
 * mock at the client level rather than at `pool.query`.
 */
import type { QueryResult, QueryResultRow } from 'pg';

import { mock } from 'node:test';

import { pool } from './runtime.js';

const TRANSACTION_BOILERPLATE_PREFIXES = ['BEGIN', 'COMMIT', 'ROLLBACK', 'SET LOCAL statement_timeout'];

export function isTransactionBoilerplate(sql: string): boolean {
  return TRANSACTION_BOILERPLATE_PREFIXES.some(prefix => sql.startsWith(prefix));
}

/**
 * Replaces `pool.connect` AND `pool.query` with stubs that forward task-SQL to
 * `handler`. Transaction boilerplate (BEGIN/COMMIT/ROLLBACK/SET LOCAL) is
 * silently absorbed so callers only see the SQL they care about.
 *
 * Direct `pool.query` calls (e.g. background importance boosts) and bounded
 * `pool.connect().query` calls share the same handler, so tests that capture
 * both read and background-write SQL keep working without distinguishing them.
 */
export function mockPoolConnect(
  handler: (sql: string, params?: readonly unknown[]) => Promise<QueryResult<QueryResultRow>>,
): void {
  mock.method(pool, 'connect', () => {
    return Promise.resolve({
      query: (sql: string, params?: readonly unknown[]) => {
        if (isTransactionBoilerplate(sql)) {
          return Promise.resolve({ command: 'SET', fields: [], oid: 0, rowCount: 0, rows: [] });
        }
        return handler(sql, params);
      },
      release: () => undefined,
    });
  });
  mock.method(pool, 'query', (sql: string, params?: readonly unknown[]) => {
    if (isTransactionBoilerplate(sql)) {
      return Promise.resolve({ command: 'SET', fields: [], oid: 0, rowCount: 0, rows: [] });
    }
    return handler(sql, params);
  });
}
