/**
 * @aviaratech/ai-memory — Core engine public surface
 *
 * Exports: DB, retention, contracts, consolidation, orient, env-probe.
 * Consumer surfaces (ingestion, MCP, health, eval, ops) are in @aviaratech/ai-memory-tools.
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
