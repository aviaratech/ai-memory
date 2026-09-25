/**
 * Shared event contract for the ai-memory ingestion pipeline.
 *
 * All session-end sources normalise their inputs into a `SessionIngestEvent`
 * before passing through `runIngestPipeline`. This ensures a single pipeline
 * shape owns flush orchestration, reflection/calibration, and continuity
 * snapshot writes — regardless of which ingest source triggers the run.
 *
 * Source literals match the persisted `source` field in the database to keep
 * analytics and health-report bucketing stable.
 *
 * Owned by: @aviaratech/ai-memory-tools
 * Core engine imports from @aviaratech/ai-memory.
 */

/**
 * Canonical source labels — these must match the persisted `source` field in
 * the database. Adding a new label here is safe; renaming or removing an
 * existing label requires a data migration and reporting update.
 */
export type IngestSource =
  | 'claude-session-end'
  | 'codex-hook'
  | 'codex-launchd'
  | 'codex-wrapper'
  | 'grok-session-end'
  | 'manual'
  | 'manual-flush';

/** Result returned by `runIngestPipeline` for every source type. */
export interface RunIngestPipelineResult {
  flushed: true;
  memoriesStored: number;
  reflections?: {
    count: number;
  };
  sessionId: string;
  warnings?: string[];
}

/**
 * Normalised event passed to `runIngestPipeline`.
 * Maps to the `memory_flush` input contract but is source-agnostic.
 */
export interface SessionIngestEvent {
  /** Active goal text for continuity conditioning. */
  activeGoal?: string;

  /** Agent identifier (e.g. 'claude', 'codex'). */
  agent?: string;

  /** Operator or project context the next session needs to proceed. */
  contextNeeded?: string[];

  /** Key decisions made during the session. */
  decisions?: string[];

  /** Environment context (branch, openPrs, failingChecks, etc.). */
  envModel?: Record<string, unknown>;

  /** Explicit active lead identity for a separate bounded continuity checkpoint. */
  lead?: string;

  /** Next actions for the following session. */
  nextActions?: string[];

  /** Open questions that remain unresolved. */
  openQuestions?: string[];

  /** Explicit outcome identity for a separate bounded continuity checkpoint. */
  outcome?: string;

  /** Project scope for memory storage (e.g. 'org/repo'). */
  project?: string;

  /** Root causes identified (used for reflection calibration). */
  rootCauses?: string[];

  /** Explicit session ID — generated if omitted. */
  sessionId?: string;

  /** The ingest source that produced this event (also persisted to the DB). */
  source: IngestSource;

  /**
   * Agent state model at session end.
   * Must include `strategy_confidence: 'high' | 'medium' | 'low'` for reflection.
   */
  stateModel?: Record<string, unknown>;

  /**
   * A human-readable summary of what occurred in the session.
   * Required: minimum 120 chars for full continuity quality.
   */
  summary: string;

  /** Explicit task identity for a separate bounded continuity checkpoint. */
  task?: string;
}
