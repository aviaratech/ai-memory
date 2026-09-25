const DEFAULT_DB_READ_TIMEOUT_MS = 5_000;
const DEFAULT_DB_WRITE_TIMEOUT_MS = 15_000;
const DEFAULT_EMBEDDING_TIMEOUT_MS = 5_000;
const DEFAULT_ORIENT_STEP_TIMEOUT_MS = 5_000;
const DEFAULT_ORIENT_TIMEOUT_TARGET_PCT = 1;

const TIMEOUT_WARNING_FRAGMENT = 'timed out';

export interface TimeoutPolicy {
  db: {
    queryTimeoutMs: number;
    readTimeoutMs: number;
    statementTimeoutMs: number;
    writeTimeoutMs: number;
  };
  embedding: {
    timeoutMs: number;
  };
  health: {
    orientTimeoutTargetPct: number;
  };
  orient: {
    stepTimeoutMs: number;
  };
}

interface WithTimeoutInput<T> {
  operation: string;
  task: () => Promise<T>;
  timeoutMs: number;
}

export class TimeoutError extends Error {
  readonly operation: string;
  readonly timeoutMs: number;

  constructor(operation: string, timeoutMs: number) {
    super(formatTimeoutMessage(operation, timeoutMs));
    this.name = 'TimeoutError';
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

export function formatTimeoutMessage(operation: string, timeoutMs: number): string {
  return `${operation} timed out after ${String(timeoutMs)}ms`;
}

export function hasTimeoutWarning(message: string): boolean {
  return message.toLowerCase().includes(TIMEOUT_WARNING_FRAGMENT);
}

export function isTimeoutError(error: unknown): error is TimeoutError {
  if (error instanceof TimeoutError) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  return hasTimeoutWarning(error.message);
}

export function resolveTimeoutPolicy(env: NodeJS.ProcessEnv = process.env): TimeoutPolicy {
  const readTimeoutMs = readPositiveIntegerEnv({
    env,
    fallback: DEFAULT_DB_READ_TIMEOUT_MS,
    key: 'AI_MEMORY_DB_READ_TIMEOUT_MS',
  });
  const writeTimeoutMs = readPositiveIntegerEnv({
    env,
    fallback: DEFAULT_DB_WRITE_TIMEOUT_MS,
    key: 'AI_MEMORY_DB_WRITE_TIMEOUT_MS',
  });

  return {
    db: {
      queryTimeoutMs: writeTimeoutMs,
      readTimeoutMs,
      statementTimeoutMs: writeTimeoutMs,
      writeTimeoutMs,
    },
    embedding: {
      timeoutMs: readPositiveIntegerEnv({
        env,
        fallback: DEFAULT_EMBEDDING_TIMEOUT_MS,
        key: 'AI_MEMORY_EMBEDDING_TIMEOUT_MS',
      }),
    },
    health: {
      orientTimeoutTargetPct: readPositiveNumberEnv({
        env,
        fallback: DEFAULT_ORIENT_TIMEOUT_TARGET_PCT,
        key: 'AI_MEMORY_ORIENT_TIMEOUT_TARGET_PCT',
      }),
    },
    orient: {
      stepTimeoutMs: readPositiveIntegerEnv({
        env,
        fallback: DEFAULT_ORIENT_STEP_TIMEOUT_MS,
        key: 'AI_MEMORY_ORIENT_STEP_TIMEOUT_MS',
      }),
    },
  };
}

/**
 * Shared DB read step wrapper: runs a task with a timeout and a named operation label.
 * Use this in orient, search, and any other read paths that need consistent timeout behavior.
 */
export function runDbStepWithTimeout<T>(input: {
  operation: string;
  stepTimeoutMs: number;
  task: () => Promise<T>;
}): Promise<T> {
  return withTimeout({
    operation: input.operation,
    task: input.task,
    timeoutMs: input.stepTimeoutMs,
  });
}

export function withTimeout<T>(input: WithTimeoutInput<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeoutMs = Math.max(1, Math.floor(input.timeoutMs));
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new TimeoutError(input.operation, timeoutMs));
    }, timeoutMs);

    input
      .task()
      .then(result => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
  });
}

function readPositiveIntegerEnv(input: { env: NodeJS.ProcessEnv; fallback: number; key: string }): number {
  const value = input.env[input.key];
  if (value === undefined) {
    return input.fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return input.fallback;
  }
  return parsed;
}

function readPositiveNumberEnv(input: { env: NodeJS.ProcessEnv; fallback: number; key: string }): number {
  const value = input.env[input.key];
  if (value === undefined) {
    return input.fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return input.fallback;
  }
  return parsed;
}
