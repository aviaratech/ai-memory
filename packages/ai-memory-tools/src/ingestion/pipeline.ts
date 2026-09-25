/**
 * Unified ingestion pipeline for all session-end ingest sources.
 *
 * `runIngestPipeline` is the single live entry point for session-end writes.
 * All three source flows route through it:
 *
 * - `claude-session-end` → `ingestAutoSessionDelta` (session transcript path)
 * - `codex-wrapper` / `codex-launchd` → `ingestAutoSessionDelta` (codex path)
 * - `grok-session-end` → `ingestAutoSessionDelta` (Grok session export)
 * - `manual-flush` / `manual` → `flushSession` (explicit MCP flush path)
 *
 * Owned by @aviaratech/ai-memory-tools. Core engine imports from @aviaratech/ai-memory.
 */

import { isRecord } from '@aviaratech/ai-memory/internal';

import type { IngestSource, RunIngestPipelineResult } from './contract.js';

import { type AutoMemoryDeltaInput, ingestAutoSessionDelta } from './auto-session-ingest.js';
import { flushSession } from './flush-session.js';

export type { IngestSource, RunIngestPipelineResult };
export type { SessionIngestEvent } from './contract.js';

/** Sources that route through the auto-session-ingest path. */
const AUTO_INGEST_SOURCES: ReadonlySet<string> = new Set<IngestSource>([
  'claude-session-end',
  'codex-hook',
  'codex-launchd',
  'codex-wrapper',
  'grok-session-end',
]);

/** Sources that route through the explicit flush path. */
const FLUSH_SOURCES: ReadonlySet<string> = new Set<IngestSource>(['manual', 'manual-flush']);

/**
 * Options forwarded to the underlying ingest function for auto-session sources.
 * The `lookupContinuity` function lets callers override continuity fields with
 * previously stored explicit flush values (guardrail pattern).
 */
export interface RunIngestPipelineOptions {
  lookupContinuity?: (sessionId: string) => Promise<{
    contextNeeded?: string[];
    nextActions: string[];
    openQuestions: string[];
    stateModel?: Record<string, unknown>;
  }>;
}

/**
 * Run the unified session ingestion pipeline.
 *
 * Dispatches to the correct underlying implementation based on `input.source`:
 * - Auto-session sources → `ingestAutoSessionDelta`
 * - Flush sources → `flushSession`
 *
 * All sources produce the same `RunIngestPipelineResult` shape.
 *
 * @example Manual flush (from MCP server):
 * ```ts
 * const result = await runIngestPipeline({ source: 'manual-flush', summary: '...', ...args });
 * ```
 *
 * @example Auto-session (from Claude session-end hook):
 * ```ts
 * const result = await runIngestPipeline({ source: 'claude-session-end', ...sessionInput },
 *   { lookupContinuity: lookupSessionContinuityFromPool });
 * ```
 */
export async function runIngestPipeline(
  input: unknown,
  options: RunIngestPipelineOptions = {},
): Promise<RunIngestPipelineResult> {
  const source = isRecord(input) && typeof input.source === 'string' ? input.source : '';

  if (AUTO_INGEST_SOURCES.has(source)) {
    // Safe narrowing: callers for auto-ingest sources pass AutoMemoryDeltaInput-shaped
    // objects. All AutoMemoryDeltaInput fields are optional unknown, so this cast is
    // structurally safe — no data is lost or coerced.
    const autoResult = await ingestAutoSessionDelta(input as AutoMemoryDeltaInput, options);
    return {
      flushed: true,
      memoriesStored: autoResult.durableMemoriesStored,
      sessionId: autoResult.sessionId ?? '',
      ...(autoResult.continuityWarnings.length > 0 ? { warnings: autoResult.continuityWarnings } : {}),
    };
  }

  if (!FLUSH_SOURCES.has(source)) {
    const valid = [...AUTO_INGEST_SOURCES, ...FLUSH_SOURCES].join(', ');
    throw new Error(`Unknown IngestSource: "${source}". Expected one of: ${valid}`);
  }

  return flushSession(input);
}
