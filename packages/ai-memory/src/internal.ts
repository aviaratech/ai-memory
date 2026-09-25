/**
 * @aviaratech/ai-memory/internal — Privileged export surface for ai-memory-tools.
 *
 * External consumers should use the main `@aviaratech/ai-memory` export.
 * This barrel consolidates all deep paths that ai-memory-tools needs.
 */

// ── standalone modules ──────────────────────────────────────────────
export * from './consolidation/consolidateMemories.js';

// ── contracts (MemoryType collides with db/memory-types — resolve) ──
export * from './contracts/types.js';

// ── db barrel (curated public-ish surface from db/index) ────────────
export * from './db.js';
// ── db sub-modules with no overlap ──────────────────────────────────
export * from './db/ingest-memory-delta-in-transaction.js';
// ── db/memory-api (items NOT already in the db barrel) ──────────────
export { buildRecallTierOrderSql, buildTokenFallbackQuery, storeMemoryWithAuditEvent } from './db/memory-api.js';
export * from './db/memory-types.js';
// Re-export MemoryType explicitly to resolve the ambiguity
// (contracts/types re-exports the same type from db/memory-types)
export type { MemoryType } from './db/memory-types.js';
export * from './db/normalization.js';
export { type BoundedQueryContext, type BoundedQueryInput, runBoundedQuery } from './db/query-runner.js';
export * from './db/records.js';
export { assertLocalDatabaseUrl, createPool, redactDatabaseUrl } from './db/pool.js';
export type { DbClient, DbConfig, DbPool, DbResult } from './db/pool.js';
export * from './db/runtime.js';

export * from './db/schema-validation.js';

export { getSessionProject } from './db/session-api.js';

export * from './db/type-guards.js';
export type { WriteCalibration } from './db/write-calibration.js';
export * from './env-probe.js';
export * from './health-constants.js';
export * from './log-path.js';
export * from './logger.js';
export * from './memory-projection.js';
export * from './orient.js';
export * from './timeout-policy.js';
export * from './warning-channel.js';
