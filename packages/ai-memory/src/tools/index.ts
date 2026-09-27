/**
 * @aviaratech/ai-memory — Public surface
 *
 * Exports the former tools root ingestion API from the consolidated package.
 * Operational modules remain separate from the core package root.
 */

export {
  type IngestSource,
  runIngestPipeline,
  type RunIngestPipelineResult,
  type SessionIngestEvent,
} from './ingestion/pipeline.js';
