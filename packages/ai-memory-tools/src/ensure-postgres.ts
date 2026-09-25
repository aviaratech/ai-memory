#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { createPool, redactDatabaseUrl } from '@aviaratech/ai-memory/internal';
import { loadAiMemoryInternalLogging } from './aiMemoryInternalLogging.js';
import {
  type AiMemoryDatabaseTarget,
  formatAiMemoryDatabaseTarget,
  loadAiMemoryPostgresEnvConfig,
  requireAiMemoryCliDatabaseTarget,
} from './runtimeEnv.js';

const execFileAsync = promisify(execFile);
const { formatError, logAiMemoryDebug, logAiMemoryError, logAiMemoryInfo, logAiMemoryWarn } =
  await loadAiMemoryInternalLogging();

const DEFAULT_CONNECT_TIMEOUT_MS = 2_500;
const DEFAULT_POSTGRES_REQUIRED_MAJOR = 18;
const DEFAULT_POSTGRES_SERVICE = 'postgresql@18';
const DEFAULT_START_COMMAND_TIMEOUT_MS = 20_000;
const DEFAULT_WAIT_TIMEOUT_MS = 15_000;
const DEFAULT_WAIT_INTERVAL_MS = 500;
const GENERIC_POSTGRES_SERVICE = 'postgresql';
const LOCAL_DATABASE_HOSTS = new Set(['0.0.0.0', '127.0.0.1', '::1', '[::1]', 'localhost']);
const POSTGRES_VERSION_MAJOR_PATTERN = /PostgreSQL\s+(\d+)/i;
const SAFE_HOMEBREW_SERVICE_PATTERN = /^[a-z0-9@._+-]+$/i;

export type EnsurePostgresRunningResult = PostgresProbeResult & {
  hint?: string | undefined;
  startAttempt?: PostgresStartAttemptResult | undefined;
  startAttempted: boolean;
  startedNow: boolean;
  status: 'not_running' | 'running';
};

interface BuildStartCommandPlanResult {
  args: string[];
  command: string;
  label: string;
}

interface CliArguments {
  hookMode: boolean;
  quiet: boolean;
  startIfNeeded: boolean;
}

interface EnsurePostgresRunningInput {
  connectTimeoutMs?: number | undefined;
  databaseUrl?: string | undefined;
  logProgress?: boolean | undefined;
  startCommandTimeoutMs?: number | undefined;
  startIfNeeded?: boolean | undefined;
  waitIntervalMs?: number | undefined;
  waitTimeoutMs?: number | undefined;
}

interface ExecFileErrorLike {
  code?: unknown;
  stderr?: unknown;
  stdout?: unknown;
}

interface PostgresProbeFailure {
  databaseName: undefined;
  databaseUrl: string;
  detectedServerVersion?: string | undefined;
  errorMessage: string;
  latencyMs: number;
  ok: false;
  serverVersion: undefined;
}

type PostgresProbeResult = PostgresProbeFailure | PostgresProbeSuccess;

interface PostgresProbeSuccess {
  databaseName?: string | undefined;
  databaseUrl: string;
  errorMessage: undefined;
  latencyMs: number;
  ok: true;
  serverVersion?: string | undefined;
}

interface PostgresStartAttemptRecord {
  command: string;
  error?: string | undefined;
  exitCode?: number | undefined;
  ok: boolean;
  stderr?: string | undefined;
  stdout?: string | undefined;
}

interface PostgresStartAttemptResult {
  attempted: boolean;
  attempts: PostgresStartAttemptRecord[];
  commandLabel?: string | undefined;
  successful: boolean;
}

interface ProbePostgresInput {
  connectTimeoutMs?: number | undefined;
  databaseTarget?: AiMemoryDatabaseTarget | undefined;
  databaseUrl?: string | undefined;
}

interface ProbeQueryRow {
  database_name?: string;
  server_version?: string;
}

interface RunCommandInput {
  args: string[];
  command: string;
  timeoutMs: number;
}

interface RunCommandResult {
  error?: string | undefined;
  exitCode?: number | undefined;
  ok: boolean;
  stderr?: string | undefined;
  stdout?: string | undefined;
}

interface TryStartLocalPostgresInput {
  detectedServerVersion?: string | undefined;
  logProgress?: boolean | undefined;
  requiredMajor?: number | undefined;
  startCommandTimeoutMs?: number | undefined;
}

interface WaitForPostgresReadyInput {
  connectTimeoutMs?: number | undefined;
  databaseUrl?: string | undefined;
  timeoutMs?: number | undefined;
  waitIntervalMs?: number | undefined;
}

export async function ensurePostgresRunning(
  input: EnsurePostgresRunningInput = {},
): Promise<EnsurePostgresRunningResult> {
  const databaseTarget =
    input.databaseUrl === undefined ? getAiMemoryDatabaseTarget() : createUrlDatabaseTarget(input.databaseUrl);
  const databaseUrl = formatAiMemoryDatabaseTarget(databaseTarget);
  const logProgress = input.logProgress !== false;
  const startIfNeeded = input.startIfNeeded === true;
  const requiredMajor = resolveRequiredPostgresMajor();

  const initialProbe = await probePostgres({
    connectTimeoutMs: input.connectTimeoutMs,
    databaseTarget,
  });

  const initialMismatchMessage = initialProbe.ok
    ? getPostgresMajorMismatchMessage({
        requiredMajor,
        serverVersion: initialProbe.serverVersion,
      })
    : undefined;

  if (initialProbe.ok && initialMismatchMessage === undefined) {
    if (logProgress) {
      logAiMemoryInfo('postgres.running', {
        database: initialProbe.databaseName,
        database_url: initialProbe.databaseUrl,
        latency_ms: initialProbe.latencyMs,
        message: `Postgres ready (${String(initialProbe.latencyMs)} ms) at ${initialProbe.databaseUrl}`,
        server_version: initialProbe.serverVersion,
      });
    }

    return {
      ...initialProbe,
      hint: undefined,
      startAttempted: false,
      startedNow: false,
      status: 'running',
    };
  }

  const mismatchFailure =
    initialProbe.ok && initialMismatchMessage !== undefined
      ? toMajorMismatchFailure({
          databaseUrl: initialProbe.databaseUrl,
          detectedServerVersion: initialProbe.serverVersion,
          latencyMs: initialProbe.latencyMs,
          message: initialMismatchMessage,
        })
      : undefined;
  const initialFailure = mismatchFailure ?? initialProbe;

  if (!startIfNeeded || !isLocalDatabaseTarget(databaseTarget)) {
    const hint = formatPostgresRecoveryHint(databaseTarget, initialFailure.errorMessage);

    if (logProgress) {
      logAiMemoryWarn('postgres.not_running', {
        database_url: initialFailure.databaseUrl,
        error: initialFailure.errorMessage,
        hint,
        message: `Postgres not ready at ${initialFailure.databaseUrl}. ${hint}`,
      });
    }

    return {
      ...initialFailure,
      hint,
      startAttempted: false,
      startedNow: false,
      status: 'not_running',
    };
  }

  if (logProgress) {
    logAiMemoryInfo('postgres.start_requested', {
      database_url: initialFailure.databaseUrl,
      message: `Postgres not ready; attempting startup for ${initialFailure.databaseUrl}`,
    });
  }

  const startAttempt = await tryStartLocalPostgres({
    detectedServerVersion: getDetectedServerVersion(initialFailure),
    logProgress,
    requiredMajor,
    startCommandTimeoutMs: input.startCommandTimeoutMs,
  });

  if (!startAttempt.successful) {
    const hint = formatPostgresRecoveryHint(databaseTarget, initialFailure.errorMessage);

    if (logProgress) {
      logAiMemoryError('postgres.start_failed', {
        attempts: startAttempt.attempts,
        database_url: initialFailure.databaseUrl,
        hint,
        message: `Automatic Postgres startup failed. ${hint}`,
      });
    }

    return {
      ...initialFailure,
      hint,
      startAttempt,
      startAttempted: startAttempt.attempted,
      startedNow: false,
      status: 'not_running',
    };
  }

  const readyProbe = await waitForPostgresReady({
    connectTimeoutMs: input.connectTimeoutMs,
    databaseUrl: databaseTarget.authMode === 'url' ? databaseTarget.databaseUrl : databaseUrl,
    timeoutMs: input.waitTimeoutMs,
    waitIntervalMs: input.waitIntervalMs,
  });

  const readyMismatchMessage = readyProbe.ok
    ? getPostgresMajorMismatchMessage({
        requiredMajor,
        serverVersion: readyProbe.serverVersion,
      })
    : undefined;

  if (readyProbe.ok && readyMismatchMessage === undefined) {
    if (logProgress) {
      logAiMemoryInfo('postgres.started', {
        database: readyProbe.databaseName,
        database_url: readyProbe.databaseUrl,
        latency_ms: readyProbe.latencyMs,
        message: `Postgres started and reachable at ${readyProbe.databaseUrl}`,
        server_version: readyProbe.serverVersion,
        startup_command: startAttempt.commandLabel,
      });
    }

    return {
      ...readyProbe,
      hint: undefined,
      startAttempt,
      startAttempted: startAttempt.attempted,
      startedNow: true,
      status: 'running',
    };
  }

  const readyFailure =
    readyProbe.ok && readyMismatchMessage !== undefined
      ? toMajorMismatchFailure({
          databaseUrl: readyProbe.databaseUrl,
          detectedServerVersion: readyProbe.serverVersion,
          latencyMs: readyProbe.latencyMs,
          message: readyMismatchMessage,
        })
      : readyProbe;

  const hint = formatPostgresRecoveryHint(databaseTarget, readyFailure.errorMessage);

  if (logProgress) {
    logAiMemoryWarn('postgres.start_timeout', {
      database_url: readyFailure.databaseUrl,
      error: readyFailure.errorMessage,
      hint,
      message: `Postgres startup command ran but DB is still not ready. ${hint}`,
      startup_command: startAttempt.commandLabel,
    });
  }

  return {
    ...readyFailure,
    hint,
    startAttempt,
    startAttempted: startAttempt.attempted,
    startedNow: false,
    status: 'not_running',
  };
}

export function formatPostgresProbeError(error: unknown): string {
  const message = formatError(error);
  const code = getErrorCode(error);
  if (code === undefined || message.includes(`code: ${code}`)) {
    return message;
  }

  return `${message} (code: ${code})`;
}

export function formatPostgresRecoveryHint(
  databaseTarget: AiMemoryDatabaseTarget | string = getAiMemoryDatabaseTarget(),
  probeErrorMessage?: string,
): string {
  const target = typeof databaseTarget === 'string' ? createUrlDatabaseTarget(databaseTarget) : databaseTarget;
  const databaseUrl = target.databaseUrl;
  const remoteHost = isLocalDatabaseUrl(databaseUrl) ? undefined : getDatabaseHost(databaseUrl);
  if (remoteHost !== undefined) {
    return prefixProbeError(
      `AI_MEMORY_DATABASE_URL points at remote Postgres host \`${remoteHost}\`; configure a loopback PostgreSQL URL and retry.`,
      probeErrorMessage,
    );
  }

  const postgresConfig = loadAiMemoryPostgresEnvConfig();
  const requiredMajor = postgresConfig.requiredMajor;
  const requiredService = postgresConfig.service;
  const envStartCommand = postgresConfig.startCommand;
  const previousMajor = requiredMajor > 1 ? requiredMajor - 1 : undefined;
  const stopPreviousCommand =
    previousMajor === undefined ? undefined : `brew services stop postgresql@${String(previousMajor)}`;

  const hintParts = [
    `Run \`npm run pg:ensure -w @aviaratech/ai-memory-tools\` to start local Postgres ${String(requiredMajor)}.`,
    typeof envStartCommand === 'string' && envStartCommand.trim().length > 0
      ? `Configured startup command: \`${envStartCommand}\`.`
      : '',
    stopPreviousCommand === undefined
      ? ''
      : `If an older major is running, stop it first (for example: \`${stopPreviousCommand}\`).`,
    `Start a local PostgreSQL ${String(requiredMajor)} instance using your service manager. On macOS with Homebrew: \`brew services start ${requiredService}\`.`,
  ];

  return prefixProbeError(hintParts.filter(value => value.length > 0).join(' '), probeErrorMessage);
}

export function getAiMemoryDatabaseTarget(): AiMemoryDatabaseTarget {
  return requireAiMemoryCliDatabaseTarget();
}

export function getAiMemoryDatabaseUrl(): string {
  return formatAiMemoryDatabaseTarget(getAiMemoryDatabaseTarget());
}

export function getPostgresMajorMismatchMessage(input: {
  requiredMajor: number;
  serverVersion?: string | undefined;
}): string | undefined {
  const detectedMajor = parsePostgresMajor(input.serverVersion);
  if (detectedMajor === input.requiredMajor) {
    return undefined;
  }

  if (detectedMajor === undefined) {
    return `Unable to determine Postgres major version. ai-memory requires PostgreSQL ${String(input.requiredMajor)}.x.`;
  }

  const detectedVersion = input.serverVersion ?? `PostgreSQL ${String(detectedMajor)}`;
  return `Detected ${detectedVersion}; ai-memory requires PostgreSQL ${String(input.requiredMajor)}.x.`;
}

export async function probePostgres(input: ProbePostgresInput = {}): Promise<PostgresProbeResult> {
  const databaseTarget =
    input.databaseTarget ??
    (input.databaseUrl === undefined ? getAiMemoryDatabaseTarget() : createUrlDatabaseTarget(input.databaseUrl));
  const connectTimeoutMs = normalizePositiveInteger(input.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);

  const redactedDatabaseUrl = redactDatabaseUrl(databaseTarget.databaseUrl);

  const startedAt = Date.now();
  const pool = createPool({
    connectionString: databaseTarget.databaseUrl,
    connectionTimeoutMillis: connectTimeoutMs,
    idleInTransactionTimeoutMs: 0,
    statementTimeoutMs: 0,
  });

  try {
    const queryResult = await pool.query<ProbeQueryRow>(
      'SELECT current_database() AS database_name, version() AS server_version',
    );
    const row = queryResult.rows.at(0);

    return {
      databaseName: typeof row?.database_name === 'string' ? row.database_name : undefined,
      databaseUrl: redactedDatabaseUrl,
      errorMessage: undefined,
      latencyMs: Date.now() - startedAt,
      ok: true,
      serverVersion: summarizeServerVersion(row?.server_version),
    };
  } catch (error: unknown) {
    return {
      databaseName: undefined,
      databaseUrl: redactedDatabaseUrl,
      errorMessage: formatPostgresProbeError(error),
      latencyMs: Date.now() - startedAt,
      ok: false,
      serverVersion: undefined,
    };
  } finally {
    await pool.end().catch(() => undefined);
  }
}

function buildLocalStartCommands(requiredMajor: number, detectedServerVersion?: string): BuildStartCommandPlanResult[] {
  const commands: BuildStartCommandPlanResult[] = [];
  const requiredService = resolveRequiredPostgresService(requiredMajor);
  const detectedMajor = parsePostgresMajor(detectedServerVersion);

  if (
    detectedMajor !== undefined &&
    detectedMajor !== requiredMajor &&
    SAFE_HOMEBREW_SERVICE_PATTERN.test(requiredService)
  ) {
    const detectedService = `postgresql@${String(detectedMajor)}`;
    commands.push({
      args: [
        '-lc',
        `brew services stop ${detectedService} >/dev/null 2>&1 || true; brew services start ${requiredService}`,
      ],
      command: '/bin/bash',
      label: `brew services stop ${detectedService} || true; brew services start ${requiredService}`,
    });
  }

  const candidateServices = [
    requiredService,
    requiredMajor === DEFAULT_POSTGRES_REQUIRED_MAJOR ? DEFAULT_POSTGRES_SERVICE : undefined,
    GENERIC_POSTGRES_SERVICE,
  ];
  const uniqueServices = new Set<string>();

  for (const service of candidateServices) {
    if (typeof service !== 'string' || service.trim().length === 0 || uniqueServices.has(service)) {
      continue;
    }

    uniqueServices.add(service);
    commands.push({
      args: ['services', 'start', service],
      command: 'brew',
      label: `brew services start ${service}`,
    });
  }

  return commands;
}

function buildStartCommandPlan(requiredMajor: number, detectedServerVersion?: string): BuildStartCommandPlanResult[] {
  const commands: BuildStartCommandPlanResult[] = [];
  const postgresConfig = loadAiMemoryPostgresEnvConfig();
  const envCommand = postgresConfig.startCommand;

  if (typeof envCommand === 'string' && envCommand.trim().length > 0) {
    const shellValue = postgresConfig.shell;
    const shellPath = typeof shellValue === 'string' && shellValue.trim().length > 0 ? shellValue : '/bin/bash';
    commands.push({
      args: ['-lc', envCommand],
      command: shellPath,
      label: envCommand,
    });
  }

  commands.push(...buildLocalStartCommands(requiredMajor, detectedServerVersion));
  return commands;
}

function createUrlDatabaseTarget(databaseUrl: string): AiMemoryDatabaseTarget {
  return {
    authMode: 'url',
    databaseUrl,
    databaseUrlHost: getDatabaseHost(databaseUrl),
    resolvedVia: undefined,
  };
}

function emitHookResult(): void {
  process.stdout.write(
    `${JSON.stringify({
      continue: true,
      suppressOutput: true,
    })}\n`,
  );
}

function getDatabaseHost(databaseUrl: string | undefined): string | undefined {
  if (typeof databaseUrl !== 'string' || databaseUrl.trim().length === 0) {
    return undefined;
  }

  try {
    const host = new URL(databaseUrl).hostname.trim().toLowerCase();
    return host.length > 0 ? host : undefined;
  } catch {
    return undefined;
  }
}

function getDetectedServerVersion(probe: PostgresProbeResult): string | undefined {
  return probe.ok ? probe.serverVersion : probe.detectedServerVersion;
}

function getErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') {
    return undefined;
  }

  const code = (error as Record<string, unknown>).code;
  return typeof code === 'string' && code.trim().length > 0 ? code.trim() : undefined;
}

function isEnsurePostgresCliEntrypoint(scriptPath: string | undefined): boolean {
  if (typeof scriptPath !== 'string') {
    return false;
  }

  const scriptName = basename(scriptPath);
  if (scriptName !== 'ensure-postgres.ts' && scriptName !== 'ensure-postgres.js') {
    return false;
  }

  if (import.meta.url === pathToFileURL(scriptPath).href) {
    return true;
  }

  try {
    return import.meta.url === pathToFileURL(realpathSync(scriptPath)).href;
  } catch {
    return false;
  }
}

function isExecFileErrorLike(error: unknown): error is ExecFileErrorLike {
  return error !== null && typeof error === 'object';
}

function isLocalDatabaseTarget(databaseTarget: AiMemoryDatabaseTarget): boolean {
  return databaseTarget.authMode === 'url' && isLocalDatabaseUrl(databaseTarget.databaseUrl);
}

function isLocalDatabaseUrl(databaseUrl: string | undefined): boolean {
  const host = getDatabaseHost(databaseUrl);
  return host !== undefined && LOCAL_DATABASE_HOSTS.has(host);
}

function normalizePositiveInteger(value: unknown, fallbackValue: number): number {
  if (value === undefined || value === null) {
    return fallbackValue;
  }

  const numericValue = Number(value);
  if (!Number.isInteger(numericValue) || numericValue <= 0) {
    return fallbackValue;
  }

  return numericValue;
}

function parseArguments(argv: readonly string[]): CliArguments {
  const output: CliArguments = {
    hookMode: false,
    quiet: false,
    startIfNeeded: false,
  };

  for (const arg of argv) {
    if (arg === '--status') {
      continue;
    }

    if (arg === '--start') {
      output.startIfNeeded = true;
      continue;
    }

    if (arg === '--quiet') {
      output.quiet = true;
      continue;
    }

    if (arg === '--hook') {
      output.hookMode = true;
      output.quiet = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return output;
}

function parsePostgresMajor(serverVersion: string | undefined): number | undefined {
  if (typeof serverVersion !== 'string') {
    return undefined;
  }

  const match = POSTGRES_VERSION_MAJOR_PATTERN.exec(serverVersion);
  if (!match) {
    return undefined;
  }

  const major = Number(match[1]);
  if (!Number.isInteger(major) || major <= 0) {
    return undefined;
  }

  return major;
}

function prefixProbeError(hint: string, probeErrorMessage?: string): string {
  const trimmedError = typeof probeErrorMessage === 'string' ? probeErrorMessage.trim() : '';
  if (trimmedError.length === 0) {
    return hint;
  }

  const normalizedError = trimmedError.endsWith('.') ? trimmedError : `${trimmedError}.`;
  return `Postgres probe failed: ${normalizedError} ${hint}`;
}

function resolveRequiredPostgresMajor(): number {
  return loadAiMemoryPostgresEnvConfig().requiredMajor;
}

function resolveRequiredPostgresService(requiredMajor: number): string {
  const fallbackService = `postgresql@${String(requiredMajor)}`;
  const configuredService = loadAiMemoryPostgresEnvConfig().service;

  if (typeof configuredService !== 'string' || configuredService.trim().length === 0) {
    return requiredMajor === DEFAULT_POSTGRES_REQUIRED_MAJOR ? DEFAULT_POSTGRES_SERVICE : fallbackService;
  }

  const sanitizedService = configuredService.trim();
  if (!SAFE_HOMEBREW_SERVICE_PATTERN.test(sanitizedService)) {
    return fallbackService;
  }

  return sanitizedService;
}

async function runCli(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const previousLogStderr = process.env.AI_MEMORY_LOG_STDERR;
  const suppressStderr = args.quiet && !args.hookMode;

  if (suppressStderr) {
    process.env.AI_MEMORY_LOG_STDERR = '0';
  }

  try {
    const result = await ensurePostgresRunning({
      logProgress: !args.quiet,
      startIfNeeded: args.startIfNeeded,
    });

    if (args.hookMode) {
      if (!result.ok) {
        const hint = result.hint ?? formatPostgresRecoveryHint(result.databaseUrl);
        logAiMemoryWarn('postgres.hook_warning', {
          database_url: result.databaseUrl,
          error: result.errorMessage,
          hint,
          message: `Postgres unavailable at session start. ${hint}`,
        });
      }

      emitHookResult();
      process.exitCode = 0;
      return;
    }

    if (!args.quiet) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }

    process.exitCode = result.ok ? 0 : 1;
  } finally {
    if (previousLogStderr === undefined) {
      delete process.env.AI_MEMORY_LOG_STDERR;
    } else {
      process.env.AI_MEMORY_LOG_STDERR = previousLogStderr;
    }
  }
}

async function runCommand(input: RunCommandInput): Promise<RunCommandResult> {
  try {
    const { stderr, stdout } = await execFileAsync(input.command, input.args, {
      maxBuffer: 1024 * 1024,
      timeout: input.timeoutMs,
    });

    return {
      error: undefined,
      exitCode: 0,
      ok: true,
      stderr,
      stdout,
    };
  } catch (error: unknown) {
    const execError = isExecFileErrorLike(error) ? error : {};
    return {
      error: formatError(error),
      exitCode: typeof execError.code === 'number' ? execError.code : undefined,
      ok: false,
      stderr: typeof execError.stderr === 'string' ? execError.stderr : undefined,
      stdout: typeof execError.stdout === 'string' ? execError.stdout : undefined,
    };
  }
}

function summarizeServerVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const match = /PostgreSQL\s+[\d.]+/i.exec(value);
  if (match) {
    return match[0];
  }

  return truncateText(value, 120);
}

function toMajorMismatchFailure(input: {
  databaseUrl: string;
  detectedServerVersion?: string | undefined;
  latencyMs: number;
  message: string;
}): PostgresProbeFailure {
  return {
    databaseName: undefined,
    databaseUrl: input.databaseUrl,
    detectedServerVersion: input.detectedServerVersion,
    errorMessage: input.message,
    latencyMs: input.latencyMs,
    ok: false,
    serverVersion: undefined,
  };
}

function truncateText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

async function tryStartLocalPostgres(input: TryStartLocalPostgresInput = {}): Promise<PostgresStartAttemptResult> {
  const logProgress = input.logProgress !== false;
  const requiredMajor = input.requiredMajor ?? resolveRequiredPostgresMajor();
  const timeoutMs = normalizePositiveInteger(input.startCommandTimeoutMs, DEFAULT_START_COMMAND_TIMEOUT_MS);

  const commands = buildStartCommandPlan(requiredMajor, input.detectedServerVersion);
  const attempts: PostgresStartAttemptRecord[] = [];

  for (const plan of commands) {
    if (logProgress) {
      logAiMemoryDebug('postgres.start_attempt', {
        command: plan.label,
        message: `Trying Postgres startup command: ${plan.label}`,
      });
    }

    const commandResult = await runCommand({
      args: plan.args,
      command: plan.command,
      timeoutMs,
    });

    attempts.push({
      command: plan.label,
      error: commandResult.error,
      exitCode: commandResult.exitCode,
      ok: commandResult.ok,
      stderr: truncateText(commandResult.stderr, 600),
      stdout: truncateText(commandResult.stdout, 600),
    });

    if (commandResult.ok) {
      return {
        attempted: true,
        attempts,
        commandLabel: plan.label,
        successful: true,
      };
    }
  }

  return {
    attempted: commands.length > 0,
    attempts,
    commandLabel: undefined,
    successful: false,
  };
}

async function waitForPostgresReady(input: WaitForPostgresReadyInput = {}): Promise<PostgresProbeResult> {
  const databaseTarget =
    input.databaseUrl === undefined ? getAiMemoryDatabaseTarget() : createUrlDatabaseTarget(input.databaseUrl);
  const timeoutMs = normalizePositiveInteger(input.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS);
  const waitIntervalMs = normalizePositiveInteger(input.waitIntervalMs, DEFAULT_WAIT_INTERVAL_MS);
  const connectTimeoutMs = normalizePositiveInteger(input.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const probe = await probePostgres({
      connectTimeoutMs,
      databaseTarget,
    });

    if (probe.ok) {
      return probe;
    }

    await sleep(waitIntervalMs);
  }

  return probePostgres({
    connectTimeoutMs,
    databaseTarget,
  });
}

const invokedAsScript = isEnsurePostgresCliEntrypoint(process.argv[1]);

if (invokedAsScript) {
  runCli().catch((error: unknown) => {
    const message = formatError(error);
    logAiMemoryError('postgres.ensure_failed', {
      error: message,
      message: `Postgres ensure script failed: ${message}`,
    });

    process.exitCode = 1;
  });
}
