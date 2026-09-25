/**
 * Bounded query runner: wraps every DB read/write in a transaction with a
 * per-call `SET LOCAL statement_timeout`, so server-side cancellation enforces
 * the budget and the connection is released within the budget — even if the
 * caller-level timeout (`TimeoutError`) would otherwise leave the pg query
 * running until the pool-wide `statement_timeout` (default 15s).
 *
 * Phase attribution:
 *   - `phase` is propagated into `TimeoutError` so failure-signature aggregation
 *     in the health report can distinguish search SQL from reversal-penalty
 *     reads from store/flush writes.
 *   - Multi-step transactions (e.g. `memory_flush`) can refine the phase per
 *     sub-step via `ctx.setPhase(subPhase)`. On cancellation, the most recently
 *     set sub-phase is appended to the base phase as
 *     `<phase>.<sub-phase>` — pinpointing which step held the connection when
 *     `statement_timeout` fired.
 *
 * Why a transaction (BEGIN/SET LOCAL/COMMIT) instead of session-level SET:
 *   - `SET LOCAL` is scoped to the current transaction; the connection's
 *     session statement_timeout is untouched after release.
 *   - One pooled connection cannot leak per-call budgets to a future caller.
 *   - This is the conventional pg pattern documented in the postgres manual.
 *
 */
import type { DbClient, DbPool } from './pool.js';

import { TimeoutError } from '../timeout-policy.js';

/** Postgres SQLSTATE for `canceling statement due to statement timeout`. */
const PG_SQLSTATE_QUERY_CANCELED = '57014';

export interface BoundedQueryContext {
  /**
   * Refine the active sub-phase. Used by multi-step transactions (e.g.
   * `memory_flush`) so a `statement_timeout` cancellation attributes to the
   * specific step (`db.write.memory_flush.checkpoint`,
   * `db.write.memory_flush.actionable`, `db.write.memory_flush.delta`) instead
   * of only the umbrella phase.
   */
  setPhase: (subPhase: string) => void;
}

export interface BoundedQueryInput<T> {
  /**
   * Phase label propagated into `TimeoutError` and downstream failure signatures
   * (`db.read.<phase>` or `db.write.<phase>` are the conventional shapes).
   */
  phase: string;
  /** Pool used to acquire the per-call client. */
  pool: DbPool;
  /** Task executed inside the per-call transaction; receives the bounded client. */
  task: (client: DbClient, ctx: BoundedQueryContext) => Promise<T>;
  /** Server-side `statement_timeout` budget in milliseconds; clamped to a positive integer. */
  timeoutMs: number;
}

export async function runBoundedQuery<T>(input: BoundedQueryInput<T>): Promise<T> {
  const { phase, pool, task } = input;
  const timeoutMs = Math.max(1, Math.floor(input.timeoutMs));
  const client = await pool.connect();
  let inTransaction = false;
  // Wrapper object avoids closure-narrowing where TS infers `activeSubPhase`
  // as always `null` because the only assignment lives in the `ctx.setPhase`
  // callback (which TS treats as out-of-band for narrowing).
  const subPhaseState: { value: string } = { value: '' };
  const ctx: BoundedQueryContext = {
    setPhase: (subPhase: string) => {
      subPhaseState.value = subPhase.trim();
    },
  };
  try {
    await client.query('BEGIN');
    inTransaction = true;
    await client.query(`SET LOCAL statement_timeout = ${String(timeoutMs)}`);
    const result: T = await task(client, ctx);
    await client.query('COMMIT');
    inTransaction = false;
    return result;
  } catch (err) {
    if (inTransaction) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Rollback can fail when the connection is already broken; swallow so we still release.
      }
    }
    if (isPgQueryCanceledError(err)) {
      const resolvedPhase = subPhaseState.value.length === 0 ? phase : `${phase}.${subPhaseState.value}`;
      throw new TimeoutError(resolvedPhase, timeoutMs);
    }
    throw err;
  } finally {
    client.release();
  }
}

function isPgQueryCanceledError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === PG_SQLSTATE_QUERY_CANCELED;
}
