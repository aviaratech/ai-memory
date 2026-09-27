import {
  buildScopedContinuityPackScopeKey,
  closePool,
  type ContinuityPackReadResult,
  formatError,
  getContinuityPack,
  hasTimeoutWarning,
  initializeDatabase,
  logAiMemoryInfo,
  logAiMemoryWarn,
  type MemoryOrientResponse,
  normalizeProjectScope,
  orientMemory,
  recallMemories,
  recordToolInvocation,
  withTimeout,
} from '@aviaratech/ai-memory/internal';
import { randomUUID } from 'node:crypto';

import { ensurePostgresRunning, formatPostgresRecoveryHint } from '../ensure-postgres.js';
import { resolveRepoIdFromCwd } from './auto-session-ingest.js';
import { formatContinuityPackMarkdown } from './continuity-pack.js';

/** Maximum decoded model-visible context, including guidance and warnings (UTF-16 characters). */
export const SESSION_START_CONTEXT_MAX_CHARS = 8000;
const START_GUIDANCE =
  'ai-memory: use the memory-lifecycle skill on demand for retrieval, storage, and flush procedures.';
const TRUNCATION_NOTICE = '\n[truncated; retrieve scoped details with memory tools]';

export function serializeSessionStartHook(outcome: SessionStartHookOutcome): string {
  const context = boundText(
    [START_GUIDANCE, `status: ${outcome.status}`, outcome.warning, outcome.bootstrapText ?? outcome.recallText]
      .filter(Boolean)
      .join('\n\n'),
    SESSION_START_CONTEXT_MAX_CHARS,
  );
  return JSON.stringify(
    process.env.CURSOR_PLUGIN_ROOT
      ? { additional_context: context }
      : { hookSpecificOutput: { additionalContext: context, hookEventName: 'SessionStart' } },
  );
}

function boundText(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit - TRUNCATION_NOTICE.length) + TRUNCATION_NOTICE;
}

const DEFAULT_RECALL_LIMIT = 8;
const DEFAULT_SINCE_DAYS = 90;
const SESSION_START_ORIENT_SOURCE = 'session-start-hook';
const SESSION_START_ORIENT_TIMEOUT_MS = 22_000;
const SESSION_START_CONTINUITY_TIMEOUT_MS = 500;
const MAX_RECALL_LIMIT = 50;
const MAX_SINCE_DAYS = 3650;

export interface SessionStartHookContext {
  /** Working directory for repo resolution */
  cwd?: string | undefined;
  /** Test seam / dependency override; production callers should omit */
  dependencies?: SessionStartHookDependencies | undefined;
  /** Hook event name for logging */
  hookEventName?: string | undefined;
  /** Explicit project scope; a basename is resolved against the working repository. */
  repoId?: string | undefined;
  /** Host-supplied session identity; also probes a task pack with this exact identity. */
  sessionId?: string | undefined;
}

export interface SessionStartHookDependencies {
  closePool: () => Promise<unknown>;
  ensurePostgresRunning: (input: {
    logProgress: boolean;
    startIfNeeded: boolean;
  }) => Promise<SessionStartPostgresStatus>;
  getContinuityPack: (input: unknown) => Promise<ContinuityPackReadResult>;
  initializeDatabase: () => Promise<unknown>;
  logAiMemoryInfo: (event: string, fields: Record<string, unknown>) => void;
  logAiMemoryWarn: (event: string, fields: Record<string, unknown>) => void;
  orientMemory: (input: unknown) => Promise<MemoryOrientResponse>;
  recallMemories: (input: unknown) => Promise<unknown[]>;
  recordToolInvocation: typeof recordToolInvocation;
  resolveRepoIdFromCwd: (cwd: string) => Promise<string | undefined>;
  withTimeout: typeof withTimeout;
}

export interface SessionStartHookInput {
  /** Override recall limit (default from env AI_MEMORY_SESSION_START_RECALL_LIMIT or 8) */
  recallLimit?: number;
  /** Override lookback days (default from env AI_MEMORY_SESSION_START_RECALL_SINCE_DAYS or 90) */
  recallSinceDays?: number;
}

export interface SessionStartHookOutcome {
  /** Combined bootstrap text for SessionStart injection */
  bootstrapText?: string;
  /** Always true — hooks should not block session startup */
  continue: true;
  /** Formatted recall text (markdown) when recall succeeds */
  recallText?: string;
  /** Overall status */
  status: 'degraded' | 'ok' | 'unavailable';
  /** Whether to suppress hook output (true when recall is disabled or no data) */
  suppressOutput: boolean;
  /** Warning message when Postgres is unavailable or other startup issues */
  warning?: string;
}

export interface SessionStartPostgresStatus {
  databaseUrl?: string | undefined;
  errorMessage?: string | undefined;
  hint?: string | undefined;
  ok: boolean;
}

const DEFAULT_DEPENDENCIES: SessionStartHookDependencies = {
  closePool,
  ensurePostgresRunning,
  getContinuityPack,
  initializeDatabase,
  logAiMemoryInfo,
  logAiMemoryWarn,
  orientMemory,
  recallMemories,
  recordToolInvocation,
  resolveRepoIdFromCwd,
  withTimeout,
};

export async function runSessionStartHook(
  input?: SessionStartHookInput,
  context?: SessionStartHookContext,
): Promise<SessionStartHookOutcome> {
  const dependencies = context?.dependencies ?? DEFAULT_DEPENDENCIES;
  try {
    const outcome = await runSessionStartHookCore(input, context);
    return { ...outcome, ...(outcome.warning === undefined ? {} : { warning: boundText(outcome.warning, 800) }) };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    dependencies.logAiMemoryWarn('hook.session_start_recall_failed', {
      error: errorMessage,
      message: `Session-start ai-memory recall check failed: ${errorMessage}`,
    });
    return {
      continue: true,
      status: 'degraded',
      suppressOutput: false,
      warning: `⚠ ai-memory session-start check failed — memory tools may not work. ${formatPostgresRecoveryHint()}`,
    };
  } finally {
    await dependencies.closePool().catch(() => {});
  }
}

async function runSessionStartHookCore(
  input?: SessionStartHookInput,
  context?: SessionStartHookContext,
): Promise<SessionStartHookOutcome> {
  const dependencies = context?.dependencies ?? DEFAULT_DEPENDENCIES;
  const hookEventName = context?.hookEventName ?? 'unknown';
  const sessionId = context?.sessionId;
  const cwd = context?.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.env.PWD ?? process.cwd();

  const status = await dependencies.ensurePostgresRunning({
    logProgress: false,
    startIfNeeded: false,
  });

  if (!status.ok) {
    const hint = status.hint ?? formatPostgresRecoveryHint();
    dependencies.logAiMemoryWarn('postgres.session_start_unavailable', {
      database_url: status.databaseUrl,
      error: status.errorMessage,
      hint,
      message: `ai-memory Postgres is unavailable at session start. ${hint}`,
    });
    return {
      continue: true,
      status: 'unavailable',
      suppressOutput: false,
      warning: `⚠ ai-memory unavailable — memory tools will not work this session. ${hint}`,
    };
  }

  if (!isRecallEnabled()) {
    logInfoQuietly({
      dependencies,
      event: 'hook.session_start_recall_skipped',
      fields: {
        hook_event_name: hookEventName,
        message: 'ai-memory session-start recall disabled via AI_MEMORY_SESSION_START_RECALL',
        session_id: sessionId,
      },
    });
    return {
      continue: true,
      status: 'ok',
      suppressOutput: true,
    };
  }

  const repoId = normalizeProjectScope({
    project: context?.repoId,
    repoId: await dependencies.resolveRepoIdFromCwd(cwd),
  });
  if (repoId === undefined) {
    return {
      continue: true,
      status: 'ok',
      suppressOutput: false,
      warning:
        'Project identity unavailable. Supply an explicit project and task to memory_continuity_pack; no unscoped background memories were read.',
    };
  }
  const recallLimit = clampPositiveInt(
    input?.recallLimit ?? parsePositiveIntFromEnv(process.env.AI_MEMORY_SESSION_START_RECALL_LIMIT),
    { fallback: DEFAULT_RECALL_LIMIT, max: MAX_RECALL_LIMIT },
  );
  const sinceDays = clampPositiveInt(
    input?.recallSinceDays ?? parsePositiveIntFromEnv(process.env.AI_MEMORY_SESSION_START_RECALL_SINCE_DAYS),
    { fallback: DEFAULT_SINCE_DAYS, max: MAX_SINCE_DAYS },
  );

  await dependencies.initializeDatabase();
  const continuityPack = await readContinuityPackForSessionStart({
    dependencies,
    hookEventName,
    repoId,
    sessionId,
  });
  if (continuityPack.taskCheckpointFound === true) {
    return {
      bootstrapText: [`scope: ${boundText(repoId, 240)}`, continuityPack.text].filter(Boolean).join('\n\n'),
      continue: true,
      status: continuityPack.status,
      suppressOutput: false,
    };
  }
  const memories = await dependencies.recallMemories({
    limit: recallLimit,
    project: repoId,
    sinceDays,
  });

  logInfoQuietly({
    dependencies,
    event: 'hook.session_start_recall_complete',
    fields: {
      hook_event_name: hookEventName,
      memory_count: memories.length,
      message: `ai-memory session-start recall loaded ${String(memories.length)} memory entries for ${repoId}.`,
      recall_limit: recallLimit,
      repo_id: repoId,
      session_id: sessionId,
      since_days: sinceDays,
    },
  });

  const recallText = memories.length > 0 ? formatRecallMarkdown(memories) : undefined;
  const orientText = await runAutoOrientForSessionStart({
    cwd,
    dependencies,
    hookEventName,
    repoId,
    sessionId,
  });
  const bootstrapText = joinBootstrapSections(
    `scope: ${boundText(repoId, 240)}`,
    continuityPack.text === undefined ? undefined : boundText(continuityPack.text, 5800),
    recallText === undefined ? undefined : boundText(recallText, 1000),
    orientText === undefined ? undefined : boundText(orientText.text, 700),
  );
  const outputStatus = continuityPack.status === 'degraded' || orientText?.status === 'degraded' ? 'degraded' : 'ok';

  if (bootstrapText === undefined) {
    return {
      continue: true,
      status: outputStatus,
      suppressOutput: true,
    };
  }

  return {
    bootstrapText,
    continue: true,
    ...(recallText !== undefined ? { recallText } : {}),
    status: outputStatus,
    suppressOutput: false,
  };
}

const CONTENT_PREVIEW_LENGTH = 120;
const ORIENT_TEXT_LIST_LIMIT = 5;

interface AutoOrientText {
  status: 'degraded' | 'ok';
  text: string;
}

interface ClampOptions {
  fallback: number;
  max: number;
}

interface ContinuityPackBootstrap {
  status: 'degraded' | 'ok';
  taskCheckpointFound?: boolean;
  text?: string | undefined;
}

function clampPositiveInt(value: number | undefined, options: ClampOptions): number {
  if (value === undefined || !Number.isInteger(value) || value <= 0) {
    return options.fallback;
  }

  return Math.min(value, options.max);
}

function formatInlineList(values: readonly string[]): string {
  return values.slice(0, ORIENT_TEXT_LIST_LIMIT).join(', ');
}

function formatOrientMarkdown(result: MemoryOrientResponse): string {
  const { orientation } = result;
  const lines = [
    '### Memory Orientation',
    '',
    `- status: ${result.status}`,
    `- environmentStatus: ${orientation.environmentStatus}`,
  ];

  lines.push(
    `- payload: ${String(orientation.memoryPayloadChars)} chars / ` +
      `${String(orientation.memoryPayloadBudgetChars)} budget ` +
      `(tokens≈${String(orientation.memoryPayloadApproxTokens)}, ` +
      `budgetExceeded=${String(orientation.memoryPayloadBudgetExceeded)})`,
  );
  if (orientation.truncatedSections !== undefined && orientation.truncatedSections.length > 0) {
    lines.push(`- truncatedSections: ${formatInlineList(orientation.truncatedSections)}`);
  }
  if (result.warnings.length > 0) {
    lines.push(`- warnings: ${formatInlineList(result.warnings)}`);
  }

  return lines.join('\n');
}

function formatRecallMarkdown(memories: readonly unknown[]): string {
  const unique = new Map<string, unknown>();
  for (const memory of memories) {
    const record = isRecordLike(memory) ? memory : {};
    const key = JSON.stringify(record.id ?? record.memoryKey ?? [record.category, record.content]);
    if (!unique.has(key)) unique.set(key, memory);
  }
  const lines: string[] = [`### Recent Memories (${String(unique.size)} entries)`, ''];
  for (const memory of unique.values()) {
    const record = isRecordLike(memory) ? memory : {};
    const category = typeof record.category === 'string' ? record.category : 'general';
    const confidence = typeof record.confidence === 'number' ? record.confidence.toFixed(1) : '?';
    const raw = typeof record.content === 'string' ? record.content : '';
    const preview = raw.length > CONTENT_PREVIEW_LENGTH ? `${raw.slice(0, CONTENT_PREVIEW_LENGTH)}...` : raw;
    const singleLine = preview.replace(/\n/g, ' ');
    lines.push(`- **[${category}]** (confidence: ${confidence}): ${singleLine}`);
  }
  return lines.join('\n');
}

function isRecallEnabled(): boolean {
  const raw = process.env.AI_MEMORY_SESSION_START_RECALL;
  if (raw === undefined) {
    return true;
  }

  const normalized = raw.trim().toLowerCase();
  return normalized !== '0' && normalized !== 'false' && normalized !== 'off' && normalized !== 'no';
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function joinBootstrapSections(...sections: readonly (string | undefined)[]): string | undefined {
  const presentSections = sections.filter((section): section is string => section !== undefined && section.length > 0);
  return presentSections.length === 0 ? undefined : presentSections.join('\n\n');
}

function logInfoQuietly(input: {
  dependencies: Pick<SessionStartHookDependencies, 'logAiMemoryInfo'>;
  event: string;
  fields: Record<string, unknown>;
}): void {
  const previous = process.env.AI_MEMORY_LOG_STDERR;
  process.env.AI_MEMORY_LOG_STDERR = '0';
  try {
    input.dependencies.logAiMemoryInfo(input.event, input.fields);
  } finally {
    if (previous === undefined) {
      delete process.env.AI_MEMORY_LOG_STDERR;
    } else {
      process.env.AI_MEMORY_LOG_STDERR = previous;
    }
  }
}

function parsePositiveIntFromEnv(rawValue: unknown): number | undefined {
  if (typeof rawValue !== 'string' || rawValue.trim().length === 0) {
    return undefined;
  }

  const parsed = Number(rawValue.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

async function readContinuityPackForSessionStart(input: {
  dependencies: SessionStartHookDependencies;
  hookEventName: string;
  repoId: string | undefined;
  sessionId: string | undefined;
}): Promise<ContinuityPackBootstrap> {
  if (input.repoId === undefined) {
    return { status: 'ok' };
  }

  const startedAt = Date.now();
  const invocationId = randomUUID();
  const taskScopeKey =
    input.sessionId === undefined
      ? undefined
      : buildScopedContinuityPackScopeKey({
          project: input.repoId,
          scope: { id: input.sessionId, type: 'task' },
        });
  try {
    const result = await input.dependencies.withTimeout({
      operation: 'memory_continuity_pack.session_start',
      task: async () => {
        if (input.sessionId !== undefined) {
          const scoped = await input.dependencies.getContinuityPack({
            project: input.repoId,
            task: input.sessionId,
          });
          if (scoped.status === 'found') {
            if (scoped.pack.scopeKey !== taskScopeKey || scoped.pack.project !== input.repoId) {
              throw new Error('Task continuity lookup returned a different scope.');
            }
            return scoped;
          }
        }
        const background = await input.dependencies.getContinuityPack({ project: input.repoId });
        if (
          background.status === 'found' &&
          (background.pack.project !== input.repoId || background.pack.scopeKey !== `project:${input.repoId}`)
        ) {
          throw new Error('Project continuity lookup returned a different scope.');
        }
        return background;
      },
      timeoutMs: SESSION_START_CONTINUITY_TIMEOUT_MS,
    });
    await recordContinuityPackTelemetry({
      dependencies: input.dependencies,
      durationMs: Date.now() - startedAt,
      invocationId,
      repoId: input.repoId,
      result,
      sessionId: input.sessionId,
      status: 'ok',
    });

    if (result.status === 'missing') {
      logInfoQuietly({
        dependencies: input.dependencies,
        event: 'hook.session_start_continuity_pack_missing',
        fields: {
          hook_event_name: input.hookEventName,
          message: `No ai-memory continuity pack found for ${input.repoId}.`,
          repo_id: input.repoId,
          session_id: input.sessionId,
        },
      });
      return {
        status: 'ok',
        text:
          input.sessionId === undefined
            ? 'Task identity unavailable. Pass the logical task to memory_continuity_pack; pass its host sessionId separately when flushing.'
            : 'No checkpoint found for this host identity. For a logical task shared across sessions, pass its explicit task to memory_continuity_pack.',
      };
    }

    const taskCheckpointFound = result.pack.scopeKey === taskScopeKey;
    const listLimit = taskCheckpointFound ? 3 : 1;
    const listKeys = ['nextActions', 'contextNeeded', 'decisions', 'openQuestions'];
    const omittedListItems = listKeys.some(key => {
      const values: unknown = result.pack.pack[key];
      return Array.isArray(values) && values.length > listLimit;
    });
    return {
      status: 'ok',
      taskCheckpointFound,
      text: [
        ...(taskCheckpointFound
          ? []
          : [
              input.sessionId === undefined
                ? 'Task identity unavailable; this is background project context. Recover an explicit task with memory_continuity_pack.'
                : 'No task checkpoint matches this host identity; this is background project context. Recover a shared logical task with its explicit task identity.',
            ]),
        ...(omittedListItems ? ['Continuity lists truncated; retrieve scoped details with memory tools.'] : []),
        `Continuity provenance: scope=${boundText(result.pack.scopeKey, 200)}; source=${boundText(result.pack.source, 120)}; session=${boundText(result.pack.sessionId ?? 'unknown', 120)}`,
        formatContinuityPackMarkdown({
          ...result.pack,
          pack: {
            ...result.pack.pack,
            summary: boundText(
              typeof result.pack.pack.summary === 'string' ? result.pack.pack.summary : '',
              taskCheckpointFound ? 2000 : 600,
            ),
            ...Object.fromEntries(
              listKeys.map(key => {
                const values: unknown = result.pack.pack[key];
                return [
                  key,
                  Array.isArray(values)
                    ? values
                        .filter((value): value is string => typeof value === 'string')
                        .slice(0, listLimit)
                        .map(value => boundText(value, 180))
                    : [],
                ];
              }),
            ),
          },
        }),
      ].join('\n'),
    };
  } catch (error: unknown) {
    const errorMessage = formatError(error);
    input.dependencies.logAiMemoryWarn('hook.session_start_continuity_pack_failed', {
      error: errorMessage,
      hook_event_name: input.hookEventName,
      message: `Session-start continuity pack read failed; continuing with recall/orient bootstrap. ${errorMessage}`,
      repo_id: input.repoId,
      session_id: input.sessionId,
    });
    await recordContinuityPackTelemetry({
      dependencies: input.dependencies,
      durationMs: Date.now() - startedAt,
      error,
      invocationId,
      repoId: input.repoId,
      sessionId: input.sessionId,
      status: 'error',
    });
    return { status: 'degraded', text: 'Continuity pack unavailable; use scoped memory retrieval.' };
  }
}

async function recordAutoOrientTelemetry(input: {
  dependencies: SessionStartHookDependencies;
  durationMs: number;
  error?: unknown;
  invocationId: string;
  repoId: string | undefined;
  result?: MemoryOrientResponse;
  sessionId: string | undefined;
  status: 'error' | 'ok';
}): Promise<void> {
  const summaryFields =
    input.result === undefined
      ? {
          detected_source: SESSION_START_ORIENT_SOURCE,
          source: SESSION_START_ORIENT_SOURCE,
        }
      : summarizeOrientForTelemetry(input.result);

  await input.dependencies
    .recordToolInvocation({
      durationMs: input.durationMs,
      invocationId: input.invocationId,
      project: input.repoId,
      ...(input.result !== undefined ? { responseStatus: input.result.status } : {}),
      sessionId: input.sessionId,
      status: input.status,
      summaryFields,
      timeoutWarningCount:
        input.result?.warnings.filter(warning => hasTimeoutWarning(warning)).length ??
        (input.error instanceof Error && hasTimeoutWarning(input.error.message) ? 1 : 0),
      toolCategory: 'read',
      toolName: 'memory_orient',
      warningCount: input.result?.warnings.length ?? 0,
    })
    .catch((telemetryError: unknown) => {
      input.dependencies.logAiMemoryWarn('hook.session_start_orient_telemetry_failed', {
        error: formatError(telemetryError),
        message: 'Session-start auto-orient telemetry write failed; continuing hook output.',
        tool_name: 'memory_orient',
      });
    });
}

async function recordContinuityPackTelemetry(input: {
  dependencies: SessionStartHookDependencies;
  durationMs: number;
  error?: unknown;
  invocationId: string;
  repoId: string | undefined;
  result?: ContinuityPackReadResult;
  sessionId: string | undefined;
  status: 'error' | 'ok';
}): Promise<void> {
  const summaryFields =
    input.result === undefined
      ? {
          continuity_pack_status: 'error',
          detected_source: SESSION_START_ORIENT_SOURCE,
          source: SESSION_START_ORIENT_SOURCE,
        }
      : summarizeContinuityPackForTelemetry(input.result);

  await input.dependencies
    .recordToolInvocation({
      durationMs: input.durationMs,
      invocationId: input.invocationId,
      project: input.repoId,
      ...(input.result !== undefined ? { responseStatus: input.result.status } : {}),
      sessionId: input.sessionId,
      status: input.status,
      summaryFields,
      timeoutWarningCount: input.error instanceof Error && hasTimeoutWarning(input.error.message) ? 1 : 0,
      toolCategory: 'read',
      toolName: 'memory_continuity_pack',
      warningCount: 0,
    })
    .catch((telemetryError: unknown) => {
      input.dependencies.logAiMemoryWarn('hook.session_start_continuity_pack_telemetry_failed', {
        error: formatError(telemetryError),
        message: 'Session-start continuity-pack telemetry write failed; continuing hook output.',
        tool_name: 'memory_continuity_pack',
      });
    });
}

async function runAutoOrientForSessionStart(input: {
  cwd: string;
  dependencies: SessionStartHookDependencies;
  hookEventName: string;
  repoId: string | undefined;
  sessionId: string | undefined;
}): Promise<AutoOrientText | undefined> {
  const orientInput = {
    ...(input.repoId !== undefined ? { project: input.repoId } : {}),
    cwd: input.cwd,
    envProbe: 'local',
    memoryDetail: 'compact',
    source: SESSION_START_ORIENT_SOURCE,
    stateModel: {
      assumptions: [],
      constraints: [],
      strategy_confidence: 'medium',
      uncertainty: [],
    },
  };
  const startedAt = Date.now();
  const invocationId = randomUUID();

  try {
    const result = await input.dependencies.withTimeout({
      operation: 'memory_orient.session_start',
      task: () => input.dependencies.orientMemory(orientInput),
      timeoutMs: SESSION_START_ORIENT_TIMEOUT_MS,
    });
    await recordAutoOrientTelemetry({
      dependencies: input.dependencies,
      durationMs: Date.now() - startedAt,
      invocationId,
      repoId: input.repoId,
      result,
      sessionId: input.sessionId,
      status: 'ok',
    });

    logInfoQuietly({
      dependencies: input.dependencies,
      event: 'hook.session_start_orient_complete',
      fields: {
        hook_event_name: input.hookEventName,
        message:
          input.repoId === undefined
            ? 'ai-memory session-start orient completed.'
            : `ai-memory session-start orient completed for ${input.repoId}.`,
        repo_id: input.repoId,
        session_id: input.sessionId,
        status: result.status,
      },
    });

    const text = formatOrientMarkdown(result);
    return {
      status: result.status === 'ok' ? 'ok' : 'degraded',
      text,
    };
  } catch (error: unknown) {
    const errorMessage = formatError(error);
    input.dependencies.logAiMemoryWarn('hook.session_start_orient_failed', {
      error: errorMessage,
      hook_event_name: input.hookEventName,
      message: `Session-start ai-memory orient failed; continuing with recall-only bootstrap. ${errorMessage}`,
      repo_id: input.repoId,
      session_id: input.sessionId,
    });
    await recordAutoOrientTelemetry({
      dependencies: input.dependencies,
      durationMs: Date.now() - startedAt,
      error,
      invocationId,
      repoId: input.repoId,
      sessionId: input.sessionId,
      status: 'error',
    });
    return { status: 'degraded', text: 'Memory orientation unavailable; use scoped memory retrieval.' };
  }
}

function summarizeContinuityPackForTelemetry(result: ContinuityPackReadResult): Record<string, number | string> {
  const summary: Record<string, number | string> = {
    continuity_pack_status: result.status,
    detected_source: SESSION_START_ORIENT_SOURCE,
    source: SESSION_START_ORIENT_SOURCE,
  };
  if (result.status === 'found') {
    summary.continuity_pack_budget_chars = result.pack.budgetChars;
    summary.continuity_pack_payload_chars = result.pack.payloadChars;
  }
  return summary;
}

function summarizeOrientForTelemetry(result: MemoryOrientResponse): Record<string, number | string> {
  const summary: Record<string, number | string> = {
    detected_source: SESSION_START_ORIENT_SOURCE,
    source: SESSION_START_ORIENT_SOURCE,
  };
  const { orientation } = result;
  summary.orient_payload_chars = orientation.memoryPayloadChars;
  summary.orient_payload_tokens_estimate = orientation.memoryPayloadApproxTokens;
  summary.orient_payload_budget_chars = orientation.memoryPayloadBudgetChars;
  summary.orient_payload_budget_exceeded = orientation.memoryPayloadBudgetExceeded ? 1 : 0;
  summary.environment_status = orientation.environmentStatus;

  return summary;
}
