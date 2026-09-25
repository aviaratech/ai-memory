/**
 * @aviaratech/ai-memory-tools — Public surface
 *
 * Owns all consumer-facing surfaces: ingestion pipeline, MCP server,
 * health-report, eval suite, ops/backfill CLIs, Docker, and Codex wrapper.
 * Core engine (DB, contracts, orient, retention) is in @aviaratech/ai-memory.
 */

export {
  type IngestSource,
  runIngestPipeline,
  type RunIngestPipelineResult,
  type SessionIngestEvent,
} from './ingestion/pipeline.js';
