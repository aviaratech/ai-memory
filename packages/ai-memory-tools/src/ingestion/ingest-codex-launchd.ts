#!/usr/bin/env node

import { logAiMemoryInfo, logAiMemoryWarn } from '@aviaratech/ai-memory/internal';
import { writeJsonFile } from '../json-file.js';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { ensurePostgresRunning, formatPostgresRecoveryHint } from '../ensure-postgres.js';
import {
  closeAiMemoryPool,
  findLatestCodexSessionFile,
  lookupSessionContinuityFromPool,
  parseCodexSessionSummary,
  recordAutoIngestionFailure,
  resolveRepoIdFromCwd,
} from './auto-session-ingest.js';
import { decideNotQuietYetEmission, type NotQuietYetTracking } from './not-quiet-yet-tracking.js';
import { runIngestPipeline } from './pipeline.js';

const DEFAULT_QUIET_SECONDS = 120;
const DEFAULT_MAX_STATE_SESSIONS = 200;
const DEFAULT_STATE_FILE = join(homedir(), '.local', 'state', 'ai-memory', 'codex-launchd-state.json');
const DEFAULT_SESSIONS_ROOT = join(homedir(), '.codex', 'sessions');
const LAUNCHD_SOURCE = 'codex-launchd';
const STATE_VERSION = 1;

interface BuildNextStateInput {
  nowIso: string;
  previousState: LaunchdState;
  sessionKey: string;
  value: SessionStateEntry;
}

type CodexSessionSummary = ReturnType<typeof parseCodexSessionSummary>;

interface CreateIngestionSignatureInput {
  mtimeMs: number;
  sessionFile: string;
  size: number;
  summary: CodexSessionSummary;
}

interface LaunchdArguments {
  dryRun: boolean;
  force: boolean;
  quietSeconds: number;
  root?: string | undefined;
  stateFile?: string | undefined;
}

interface LaunchdState {
  lastRunAt?: string | undefined;
  notQuietYetTracking?: NotQuietYetTracking | undefined;
  sessions: Record<string, SessionStateEntry>;
  updatedAt?: string | undefined;
  version: number;
}

interface SessionStateEntry {
  fileMtimeMs: number;
  filePath: string;
  fileSize: number;
  lastIngestedAt?: string | undefined;
  repoId?: string | undefined;
  sessionId?: string | undefined;
  signature: string;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const now = Date.now();
  const stateFile = args.stateFile ?? DEFAULT_STATE_FILE;
  const sessionsRoot = args.root ?? DEFAULT_SESSIONS_ROOT;
  const quietMs = args.quietSeconds * 1_000;
  const state = loadState(stateFile);

  const sessionFile = findLatestCodexSessionFile({ root: sessionsRoot });
  if (sessionFile === undefined) {
    persistState(stateFile, {
      ...state,
      lastRunAt: new Date(now).toISOString(),
    });
    emitResult({
      reason: 'no_session_file',
      stateFile,
      status: 'skipped',
    });
    return;
  }

  const stats = statSync(sessionFile);
  const ageMs = now - stats.mtimeMs;
  if (!args.force && ageMs < quietMs) {
    const { shouldEmit, suppressedCount, tracking } = decideNotQuietYetEmission(state.notQuietYetTracking, sessionFile);

    persistState(stateFile, {
      ...state,
      lastRunAt: new Date(now).toISOString(),
      notQuietYetTracking: tracking,
    });

    if (shouldEmit) {
      emitResult({
        ageMs,
        quietMs,
        reason: 'not_quiet_yet',
        sessionFile,
        stateFile,
        status: 'skipped',
        ...(suppressedCount > 0 ? { suppressedSinceLastEmit: suppressedCount } : {}),
      });
    }
    return;
  }

  const summary = parseCodexSessionSummary(sessionFile);
  const repoId = summary.repoId ?? (await resolveRepoIdFromCwd(summary.cwd));
  const sessionId = summary.sessionId;
  const sessionKey = sessionId ?? sessionFile;
  const signature = createIngestionSignature({
    mtimeMs: stats.mtimeMs,
    sessionFile,
    size: stats.size,
    summary,
  });
  const previous = state.sessions[sessionKey];

  if (!args.force && previous?.signature === signature) {
    persistState(stateFile, {
      ...state,
      lastRunAt: new Date(now).toISOString(),
    });
    emitResult({
      reason: 'unchanged_session_signature',
      sessionFile,
      sessionId,
      stateFile,
      status: 'skipped',
    });
    return;
  }

  const postgresStatus = await ensurePostgresRunning({
    logProgress: false,
    startIfNeeded: shouldAutoStartPostgres(),
  });

  if (!postgresStatus.ok) {
    const hint = postgresStatus.hint ?? formatPostgresRecoveryHint();
    await recordAutoIngestionFailure({
      agent: 'codex-cli',
      details: {
        database_url: postgresStatus.databaseUrl,
        hint,
        session_file: sessionFile,
      },
      error: postgresStatus.errorMessage,
      repoId,
      sessionId,
      source: LAUNCHD_SOURCE,
      stage: 'postgres_unavailable',
    });

    logAiMemoryWarn('hook.codex_launchd_postgres_unavailable', {
      database_url: postgresStatus.databaseUrl,
      hint,
      message: `Codex launchd ingest skipped: Postgres unavailable. ${hint}`,
      session_file: sessionFile,
    });

    emitResult({
      hint,
      reason: 'postgres_unavailable',
      sessionFile,
      sessionId,
      stateFile,
      status: 'skipped',
    });
    return;
  }

  if (args.dryRun) {
    emitResult({
      ageMs,
      quietMs,
      repoId,
      sessionFile,
      sessionId,
      signature,
      stateFile,
      status: 'dry-run',
      summary: {
        lastAssistantMessage: summary.lastAssistantMessage,
        lastUserMessage: summary.lastUserMessage,
        modelResolutionStatus: summary.modelResolutionStatus,
        requestedModel: summary.requestedModel,
        resolvedModel: summary.resolvedModel,
        toolCallCount: summary.toolCallCount,
      },
    });
    return;
  }

  const result = await runIngestPipeline(
    {
      agent: 'codex-cli',
      assistantMessage: summary.lastAssistantMessage,
      createdAt: summary.createdAt,
      cwd: summary.cwd,
      dedupeNamespace: 'codex',
      eventReason: 'post-session-launchd',
      history: summary.history,
      model: summary.model,
      modelResolutionError: summary.modelResolutionError,
      modelResolutionStatus: summary.modelResolutionStatus,
      repoId,
      requestedModel: summary.requestedModel,
      resolvedModel: summary.resolvedModel,
      sessionFilePath: sessionFile,
      sessionId: sessionId ?? 'unknown',
      source: LAUNCHD_SOURCE,
      toolCallCount: summary.toolCallCount,
      userMessage: summary.lastUserMessage,
    },
    { lookupContinuity: lookupSessionContinuityFromPool },
  );

  const nowIso = new Date(now).toISOString();
  const nextState = buildNextState({
    nowIso,
    previousState: state,
    sessionKey,
    value: {
      fileMtimeMs: stats.mtimeMs,
      filePath: sessionFile,
      fileSize: stats.size,
      lastIngestedAt: nowIso,
      repoId,
      sessionId,
      signature,
    },
  });
  nextState.notQuietYetTracking = undefined;
  persistState(stateFile, nextState);

  logAiMemoryInfo('hook.codex_launchd_ingest_complete', {
    message: `Codex launchd ingest complete for session ${sessionId ?? 'unknown'}.`,
    session_file: sessionFile,
    session_id: sessionId,
    source: LAUNCHD_SOURCE,
  });

  emitResult({
    memoriesStored: result.memoriesStored,
    repoId,
    sessionFile,
    sessionId,
    stateFile,
    status: 'ok',
  });
}

void (async () => {
  try {
    await main();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await recordAutoIngestionFailure({
      agent: 'codex-cli',
      error,
      source: LAUNCHD_SOURCE,
      stage: 'launchd_ingest',
    });

    logAiMemoryWarn('hook.codex_launchd_ingest_failed', {
      message: `Codex launchd ingest failed: ${message}`,
      source: LAUNCHD_SOURCE,
    });
    process.exitCode = 1;
  } finally {
    await closeAiMemoryPool().catch(() => {});
  }
})();

function buildNextState(input: BuildNextStateInput): LaunchdState {
  const sessions: Record<string, SessionStateEntry> = {
    ...input.previousState.sessions,
    [input.sessionKey]: input.value,
  };

  return {
    lastRunAt: input.nowIso,
    sessions: pruneSessionState(sessions),
    updatedAt: input.nowIso,
    version: STATE_VERSION,
  };
}

function createEmptyState(): LaunchdState {
  return {
    lastRunAt: undefined,
    notQuietYetTracking: undefined,
    sessions: {},
    updatedAt: undefined,
    version: STATE_VERSION,
  };
}

function createIngestionSignature(input: CreateIngestionSignatureInput): string {
  const payload = JSON.stringify({
    createdAt: input.summary.createdAt,
    lastAssistantMessage: input.summary.lastAssistantMessage,
    lastUserMessage: input.summary.lastUserMessage,
    model: input.summary.model,
    modelResolutionError: input.summary.modelResolutionError,
    modelResolutionStatus: input.summary.modelResolutionStatus,
    mtimeMs: input.mtimeMs,
    repoId: input.summary.repoId,
    requestedModel: input.summary.requestedModel,
    resolvedModel: input.summary.resolvedModel,
    sessionFile: input.sessionFile,
    sessionId: input.summary.sessionId,
    size: input.size,
    toolCallCount: input.summary.toolCallCount,
  });

  return createHash('sha256').update(payload).digest('hex');
}

function emitResult(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function loadState(stateFile: string): LaunchdState {
  if (!existsSync(stateFile)) {
    return createEmptyState();
  }

  try {
    const raw = readFileSync(stateFile, 'utf8').trim();
    if (raw.length === 0) {
      return createEmptyState();
    }

    const parsed: unknown = JSON.parse(raw);
    if (!isObjectRecord(parsed)) {
      return createEmptyState();
    }

    if (parsed.version !== STATE_VERSION || !isObjectRecord(parsed.sessions)) {
      return createEmptyState();
    }

    return {
      lastRunAt: normalizeOptionalText(parsed.lastRunAt),
      notQuietYetTracking: normalizeNotQuietYetTracking(parsed.notQuietYetTracking),
      sessions: normalizeSessionEntries(parsed.sessions),
      updatedAt: normalizeOptionalText(parsed.updatedAt),
      version: STATE_VERSION,
    };
  } catch {
    return createEmptyState();
  }
}

function normalizeNotQuietYetTracking(value: unknown): NotQuietYetTracking | undefined {
  if (!isObjectRecord(value)) {
    return undefined;
  }

  const sessionFile = normalizeOptionalText(value.sessionFile);
  const consecutiveSkips = toFiniteNumber(value.consecutiveSkips);
  const lastEmittedAtSkip = toFiniteNumber(value.lastEmittedAtSkip);

  if (sessionFile === undefined || consecutiveSkips === undefined || lastEmittedAtSkip === undefined) {
    return undefined;
  }

  return { consecutiveSkips, lastEmittedAtSkip, sessionFile };
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeSessionEntries(value: Record<string, unknown>): Record<string, SessionStateEntry> {
  const entries: Record<string, SessionStateEntry> = {};

  for (const [sessionKey, rawEntry] of Object.entries(value)) {
    if (!isObjectRecord(rawEntry)) {
      continue;
    }

    const filePath = normalizeOptionalText(rawEntry.filePath);
    const signature = normalizeOptionalText(rawEntry.signature);
    const fileMtimeMs = toFiniteNumber(rawEntry.fileMtimeMs);
    const fileSize = toFiniteNumber(rawEntry.fileSize);

    if (filePath === undefined || signature === undefined || fileMtimeMs === undefined || fileSize === undefined) {
      continue;
    }

    entries[sessionKey] = {
      fileMtimeMs,
      filePath,
      fileSize,
      lastIngestedAt: normalizeOptionalText(rawEntry.lastIngestedAt),
      repoId: normalizeOptionalText(rawEntry.repoId),
      sessionId: normalizeOptionalText(rawEntry.sessionId),
      signature,
    };
  }

  return entries;
}

function parseArguments(argv: readonly string[]): LaunchdArguments {
  const args: LaunchdArguments = {
    dryRun: false,
    force: false,
    quietSeconds: parsePositiveIntegerEnv('AI_MEMORY_CODEX_LAUNCHD_QUIET_SECONDS', DEFAULT_QUIET_SECONDS),
    root: undefined,
    stateFile: undefined,
  };

  const queue = [...argv];
  while (queue.length > 0) {
    const value = queue.shift();
    if (value === undefined) {
      break;
    }

    if (value === '--dry-run') {
      args.dryRun = true;
      continue;
    }

    if (value === '--force') {
      args.force = true;
      continue;
    }

    if (value === '--quiet-seconds') {
      args.quietSeconds = toPositiveInteger(requireNextArgument(queue, value), value);
      continue;
    }

    if (value === '--root') {
      args.root = requireNextArgument(queue, value);
      continue;
    }

    if (value === '--state-file') {
      args.stateFile = requireNextArgument(queue, value);
      continue;
    }

    if (value === '--help' || value === '-h') {
      printHelp();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${value}`);
  }

  return args;
}

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return fallback;
  }

  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function persistState(stateFile: string, state: LaunchdState): void {
  mkdirSync(dirname(stateFile), { recursive: true });
  const tempFile = `${stateFile}.tmp.json`;
  writeJsonFile(tempFile, state);
  renameSync(tempFile, stateFile);
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage: npm run ingest:codex:launchd -w @aviaratech/ai-memory-tools -- [-- options]',
      '',
      'Options:',
      '  --dry-run               Print candidate ingestion details only',
      '  --force                 Ignore quiet window and dedupe signature',
      '  --quiet-seconds <n>     Require latest session file to be quiet for n seconds',
      '  --root <path>           Override Codex sessions root (default: ~/.codex/sessions)',
      '  --state-file <path>     Override launchd ingestion state file',
      '  --help, -h              Show this help',
      '',
    ].join('\n'),
  );
}

function pruneSessionState(sessions: Record<string, SessionStateEntry>): Record<string, SessionStateEntry> {
  const entries = Object.entries(sessions).sort(([, left], [, right]) => {
    const leftAt = Date.parse(left.lastIngestedAt ?? '');
    const rightAt = Date.parse(right.lastIngestedAt ?? '');
    return (Number.isNaN(rightAt) ? 0 : rightAt) - (Number.isNaN(leftAt) ? 0 : leftAt);
  });

  const maxSessions = parsePositiveIntegerEnv('AI_MEMORY_CODEX_LAUNCHD_MAX_STATE_SESSIONS', DEFAULT_MAX_STATE_SESSIONS);
  const trimmed = entries.slice(0, maxSessions);
  return Object.fromEntries(trimmed);
}

function requireNextArgument(queue: string[], optionName: string): string {
  const value = queue.shift();
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${optionName} requires a value.`);
  }

  return value;
}

function shouldAutoStartPostgres(): boolean {
  const raw = process.env.AI_MEMORY_CODEX_LAUNCHD_AUTO_START_POSTGRES;
  if (raw === undefined) {
    return true;
  }

  const normalized = raw.trim().toLowerCase();
  return normalized !== '0' && normalized !== 'false' && normalized !== 'off' && normalized !== 'no';
}

function toFiniteNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toPositiveInteger(value: string, fieldName: string): number {
  const numericValue = Number(value);
  if (!Number.isInteger(numericValue) || numericValue <= 0) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }

  return numericValue;
}
