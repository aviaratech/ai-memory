export interface AiMemoryInternalLogging extends AiMemoryInternalLoggingModule {
  usingFallback: boolean;
}

export interface LoadAiMemoryInternalLoggingOptions {
  loadInternal?: () => Promise<AiMemoryInternalLoggingModule>;
  warn?: (message: string) => void;
}

interface AiMemoryInternalLoggingModule {
  formatError: (error: unknown) => string;
  logAiMemoryDebug: (event: string, fields?: AiMemoryLogFields) => void;
  logAiMemoryError: (event: string, fields?: AiMemoryLogFields) => void;
  logAiMemoryInfo: (event: string, fields?: AiMemoryLogFields) => void;
  logAiMemoryWarn: (event: string, fields?: AiMemoryLogFields) => void;
}

type AiMemoryLogFields = Record<string, unknown>;

const AI_MEMORY_INTERNAL_DIST_MARKER = '/ai-memory/dist/internal';
const AI_MEMORY_INTERNAL_SPECIFIER = '@aviaratech/ai-memory/internal';

export const MISSING_AI_MEMORY_BUILD_WARNING =
  '[ai-memory] warning: @aviaratech/ai-memory build artifacts are unavailable; continuing bootstrap checks with fallback logging.';

export function createAiMemoryFallbackLogging(): AiMemoryInternalLogging {
  return createFallbackLogging();
}

export async function loadAiMemoryInternalLogging(
  options: LoadAiMemoryInternalLoggingOptions = {},
): Promise<AiMemoryInternalLogging> {
  try {
    const module = await (options.loadInternal ?? loadAiMemoryInternalModule)();
    return {
      formatError: error => module.formatError(error),
      logAiMemoryDebug: (event, fields = {}) => {
        module.logAiMemoryDebug(event, fields);
      },
      logAiMemoryError: (event, fields = {}) => {
        module.logAiMemoryError(event, fields);
      },
      logAiMemoryInfo: (event, fields = {}) => {
        module.logAiMemoryInfo(event, fields);
      },
      logAiMemoryWarn: (event, fields = {}) => {
        module.logAiMemoryWarn(event, fields);
      },
      usingFallback: false,
    };
  } catch (error: unknown) {
    if (!isMissingAiMemoryBuildError(error)) {
      throw error;
    }

    (options.warn ?? defaultWarn)(MISSING_AI_MEMORY_BUILD_WARNING);
    return createFallbackLogging();
  }
}

function createFallbackLogging(): AiMemoryInternalLogging {
  return {
    formatError: defaultFormatError,
    logAiMemoryDebug(event, fields = {}) {
      writeFallbackLog('debug', getLogSummary(event, fields));
    },
    logAiMemoryError(event, fields = {}) {
      writeFallbackLog('error', getLogSummary(event, fields));
    },
    logAiMemoryInfo(event, fields = {}) {
      writeFallbackLog('info', getLogSummary(event, fields));
    },
    logAiMemoryWarn(event, fields = {}) {
      writeFallbackLog('warn', getLogSummary(event, fields));
    },
    usingFallback: true,
  };
}

function defaultFormatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function defaultWarn(message: string): void {
  process.stderr.write(`${message}\n`);
}

function getLogSummary(event: string, fields: AiMemoryLogFields = {}): string {
  const candidate = fields.message;
  if (typeof candidate === 'string' && candidate.trim().length > 0) {
    return candidate.trim();
  }

  return event;
}

function getMissingTargetFromMessage(message: string): string | undefined {
  const match = /^Cannot find (?:module|package) ['"]([^'"]+)['"]/u.exec(message);
  return match?.[1];
}

function isMissingAiMemoryBuildError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }

  if (error.code !== 'ERR_MODULE_NOT_FOUND') {
    return false;
  }

  // This matcher is intentionally coupled to @aviaratech/ai-memory's
  // "./internal" export target. If that exports map changes, update the
  // fallback detection alongside it so fresh-worktree startup stays safe.
  const specifier = typeof error.specifier === 'string' ? error.specifier : undefined;
  if (matchesAiMemoryInternalTarget(specifier)) {
    return true;
  }

  const url = typeof error.url === 'string' ? error.url : undefined;
  if (matchesAiMemoryInternalTarget(url)) {
    return true;
  }

  const message = typeof error.message === 'string' ? error.message : defaultFormatError(error);
  const missingTarget = getMissingTargetFromMessage(message);
  return matchesAiMemoryInternalTarget(missingTarget);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function loadAiMemoryInternalModule(): Promise<AiMemoryInternalLoggingModule> {
  return import('@aviaratech/ai-memory/internal');
}

function matchesAiMemoryInternalTarget(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }

  if (value === AI_MEMORY_INTERNAL_SPECIFIER) {
    return true;
  }

  const normalized = value.replaceAll('\\', '/');
  return normalized.includes(AI_MEMORY_INTERNAL_DIST_MARKER);
}

function writeFallbackLog(level: 'debug' | 'error' | 'info' | 'warn', summary: string) {
  if (level === 'debug' && process.env.AI_MEMORY_DEBUG !== '1') {
    return;
  }

  if (process.env.AI_MEMORY_LOG_STDERR === '0') {
    return;
  }

  process.stderr.write(`[ai-memory][${level}] ${summary}\n`);
}
