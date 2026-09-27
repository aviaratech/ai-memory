/**
 * @aviaratech/ai-memory — Core engine public surface
 *
 * Exports: DB, retention, contracts, consolidation, orient, env-probe.
 * Ingestion, MCP, health, eval, and ops are separate modules in this package.
 */

export {
  closePool,
  getDatabaseUrlForDisplay,
  getSessionResume,
  ingestContextPack,
  ingestMemoryDelta,
  initializeDatabase,
  listIngestionFailures,
  listSessionEvents,
  recallMemories,
  recordIngestionFailure,
  runRetentionPurge,
  searchMemories,
  storeMemory,
} from './db.js';
