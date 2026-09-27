import { logAiMemoryInfo, logAiMemoryWarn, probeEnvironment } from '@aviaratech/ai-memory/internal';
import { statSync } from 'node:fs';

import {
  closeAiMemoryPool,
  extractContinuityFromText,
  findLatestCodexSessionFile,
  loadGrokSessionExport,
  lookupSessionContinuityFromPool,
  parseClaudeTranscriptSummary,
  parseCodexSessionSummary,
  recordAutoIngestionFailure,
  resolveRepoIdFromCwd,
} from './auto-session-ingest.js';
import { runIngestPipeline } from './pipeline.js';

const CLAUDE_SESSION_END_SOURCE = 'claude-session-end';
const GROK_SESSION_END_SOURCE = 'grok-session-end';

/** Hook event names that indicate a session-end ingestion should run. */
const SESSION_END_EVENT_NAMES = new Set(['SessionEnd', 'Stop', 'unknown']);

export interface SessionEndHookInput {
  /** The hook event payload from stdin */
  payload: Record<string, unknown>;
}

export interface SessionEndHookOutcome {
  continue: true;
  /** Whether ingestion was actually performed */
  ingested: boolean;
  suppressOutput: true;
  /** Warning if something went wrong (non-fatal) */
  warning?: string;
}

interface FailureContext {
  agent: string;
  details: Record<string, unknown>;
  repoId?: string | undefined;
  sessionId?: string | undefined;
  source: string;
  stage: string;
}

export function isGrokSessionEndHook(
  payload: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const eventName = firstDefinedText(
    payload.hook_event_name,
    payload.hookEventName,
    payload.event_name,
    payload.eventName,
  );
  return env.GROK_HOOK_EVENT === 'SessionEnd' && eventName === 'SessionEnd';
}

export async function runSessionEndHook(input: SessionEndHookInput): Promise<SessionEndHookOutcome> {
  const failureContext: FailureContext = {
    agent: 'claude-code',
    details: {},
    source: CLAUDE_SESSION_END_SOURCE,
    stage: 'hook_init',
  };

  try {
    return await runSessionEndHookCore(input.payload, failureContext);
  } catch (error: unknown) {
    await recordAutoIngestionFailure({
      ...failureContext,
      details: {
        ...failureContext.details,
        cwd: process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
      },
      error,
    });

    const message = error instanceof Error ? error.message : String(error);
    logAiMemoryWarn('hook.session_end_warning', {
      message: `Session-end hook warning (${failureContext.source}): ${message}`,
      source: failureContext.source,
    });

    return { continue: true, ingested: false, suppressOutput: true, warning: message };
  } finally {
    await closeAiMemoryPool().catch(() => {});
  }
}

function firstDefinedIsoTimestamp(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }

    const parsed = new Date(value);
    if (!Number.isNaN(parsed.valueOf())) {
      return parsed.toISOString();
    }
  }

  return undefined;
}

function firstDefinedText(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }

    const normalized = value.trim();
    if (normalized.length > 0) {
      return normalized;
    }
  }

  return undefined;
}

function resolveIngestCreatedAt(payload: Record<string, unknown>, transcriptPath: string | undefined) {
  const fromPayload = firstDefinedIsoTimestamp(
    payload.created_at,
    payload.createdAt,
    payload.event_ts,
    payload.eventTs,
    payload.event_time,
    payload.eventTime,
    payload.session_ended_at,
    payload.sessionEndedAt,
    payload.timestamp,
    payload.ts,
  );
  if (fromPayload !== undefined) {
    return fromPayload;
  }

  if (transcriptPath !== undefined) {
    try {
      return statSync(transcriptPath).mtime.toISOString();
    } catch {
      // Ignore transcript stat errors and fall back to current clock.
    }
  }

  return new Date().toISOString();
}

async function runSessionEndHookCore(
  payload: Record<string, unknown>,
  failureContext: FailureContext,
): Promise<SessionEndHookOutcome> {
  const hookEventName =
    firstDefinedText(payload.hook_event_name, payload.hookEventName, payload.event_name, payload.eventName) ??
    'unknown';
  failureContext.stage = 'hook_payload_read';
  failureContext.details = {
    ...failureContext.details,
    hook_event_name: hookEventName,
  };

  if (!SESSION_END_EVENT_NAMES.has(hookEventName)) {
    return { continue: true, ingested: false, suppressOutput: true };
  }

  const isGrok = isGrokSessionEndHook(payload);
  const isCodex = hookEventName === 'Stop';
  let agent = 'claude-code';
  let source = CLAUDE_SESSION_END_SOURCE;
  if (isGrok) {
    agent = 'grok-build';
    source = GROK_SESSION_END_SOURCE;
  } else if (isCodex) {
    agent = 'codex-cli';
    source = 'codex-hook';
  }
  failureContext.agent = agent;
  failureContext.source = source;

  const sessionId = firstDefinedText(payload.session_id, payload.sessionId, payload.agent_id, payload.agentId);
  if (sessionId === undefined) {
    logAiMemoryWarn('hook.session_end_skipped', {
      message: `${hookEventName} hook skipped: missing session id`,
      source,
    });
    return { continue: true, ingested: false, suppressOutput: true };
  }
  failureContext.sessionId = sessionId;

  const transcriptPath = firstDefinedText(
    payload.transcript_path,
    payload.transcriptPath,
    payload.agent_transcript_path,
  );
  const cwd =
    firstDefinedText(payload.cwd, process.env.CLAUDE_PROJECT_DIR, process.env.PWD) ??
    firstDefinedText(process.cwd(), undefined);
  const reason = firstDefinedText(payload.reason, payload.stop_reason, payload.stopReason);

  failureContext.stage = 'ingest_auto_delta';
  failureContext.details = {
    ...failureContext.details,
    transcript_path: transcriptPath,
  };

  // Branch parsing: Codex session files use a different format than Claude transcripts.
  let lastAssistantMessage: string | undefined;
  let lastUserMessage: string | undefined;
  let sessionSummary: string | undefined;
  let toolCallCount = 0;
  let model = firstDefinedText(payload.model, payload.model_name, payload.modelName);
  let resolvedRepoId: string | undefined;
  let history: unknown;
  let createdAt: string;

  if (isGrok) {
    const grokSummary = await loadGrokSessionExport({ sessionId });
    lastAssistantMessage = grokSummary.lastAssistantMessage;
    lastUserMessage = grokSummary.lastUserMessage;
    toolCallCount = grokSummary.toolCallCount;
    history = grokSummary.history;
    createdAt = resolveIngestCreatedAt(payload, undefined);
  } else if (isCodex) {
    // Codex Stop hook: resolve session file and parse with Codex-specific parser.
    // The transcript_path from Codex may point to the session file directly,
    // or we fall back to finding the latest session file.
    const codexSessionFile = transcriptPath ?? findLatestCodexSessionFile();
    try {
      const codexSummary = parseCodexSessionSummary(codexSessionFile);
      lastAssistantMessage = codexSummary.lastAssistantMessage;
      lastUserMessage = codexSummary.lastUserMessage;
      toolCallCount = codexSummary.toolCallCount;
      history = codexSummary.history;
      model = model ?? codexSummary.model;
      resolvedRepoId = codexSummary.repoId;
      createdAt = codexSummary.createdAt ?? resolveIngestCreatedAt(payload, transcriptPath);
    } catch {
      // If Codex session file is unavailable, fall back to payload-only ingestion.
      createdAt = resolveIngestCreatedAt(payload, transcriptPath);
    }
  } else {
    const claudeSummary = parseClaudeTranscriptSummary(transcriptPath);
    lastAssistantMessage = claudeSummary.lastAssistantMessage;
    lastUserMessage = claudeSummary.lastUserMessage;
    sessionSummary = claudeSummary.sessionSummary;
    toolCallCount = claudeSummary.toolCallCount;
    history = claudeSummary.history;
    createdAt = resolveIngestCreatedAt(payload, transcriptPath);
  }

  const repoId =
    firstDefinedText(payload.repo_id, payload.repoId, payload.repository, resolvedRepoId) ??
    (await resolveRepoIdFromCwd(cwd));
  failureContext.repoId = repoId;

  const fallbackText = sessionSummary ?? lastAssistantMessage ?? '';
  const extractedContinuity = extractContinuityFromText(fallbackText);
  const envProbeResult = probeEnvironment('local', cwd !== undefined ? { cwd } : {});

  const result = await runIngestPipeline(
    {
      agent,
      assistantMessage: lastAssistantMessage,
      contextNeeded: extractedContinuity.contextNeeded,
      continuityFieldProvenance: 'derived',
      createdAt,
      cwd,
      dedupeNamespace: isCodex ? 'codex' : undefined,
      envModel: envProbeResult.environment,
      eventReason: reason,
      evidenceRefs: isGrok ? [`grok://session/${sessionId}`] : undefined,
      history,
      model,
      nextActions: extractedContinuity.nextActions,
      openQuestions: extractedContinuity.openQuestions,
      repoId,
      sessionId,
      sessionSummary,
      source,
      toolCallCount,
      transcriptPath,
      userMessage: lastUserMessage,
    },
    { lookupContinuity: lookupSessionContinuityFromPool },
  );

  logAiMemoryInfo('hook.session_end_ingested', {
    memories_stored: result.memoriesStored,
    message: `${hookEventName} ingested (session=${result.sessionId}, memories=${String(result.memoriesStored)})`,
    session_id: result.sessionId,
    source,
  });

  return { continue: true, ingested: true, suppressOutput: true };
}
