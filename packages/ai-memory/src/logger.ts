import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { isRecord } from './db/type-guards.js';
import { resolveLogFilePath } from './log-path.js';

interface LogEventPayload {
  event?: string;
  fields?: LogFields;
}

type LogFields = Record<string, unknown>;
type LogLevel = 'debug' | 'error' | 'info' | 'warn';

export function logAiMemoryDebug(event: string, fields: LogFields = {}) {
  if (process.env.AI_MEMORY_DEBUG !== '1') {
    return;
  }

  logAiMemoryEvent('debug', { event, fields });
}

export function logAiMemoryError(event: string, fields: LogFields = {}) {
  logAiMemoryEvent('error', { event, fields });
}

export function logAiMemoryEvent(level: string, payload: LogEventPayload = {}) {
  const event =
    typeof payload.event === 'string' && payload.event.trim().length > 0 ? payload.event : 'ai-memory.event';
  const fields = payload.fields ?? {};
  const normalizedLevel = normalizeLevel(level);
  const record: Record<string, unknown> = {
    event,
    level: normalizedLevel,
    ts: new Date().toISOString(),
    ...sanitizeFields(fields),
  };

  writeLogLine(record);

  const fieldsMessage = fields.message;
  const summary = typeof fieldsMessage === 'string' && fieldsMessage.trim().length > 0 ? fieldsMessage.trim() : event;
  if (process.env.AI_MEMORY_LOG_STDERR !== '0') {
    process.stderr.write(`[ai-memory][${normalizedLevel}] ${summary}\n`);
  }
}

export function logAiMemoryInfo(event: string, fields: LogFields = {}) {
  logAiMemoryEvent('info', { event, fields });
}

export function logAiMemoryWarn(event: string, fields: LogFields = {}) {
  logAiMemoryEvent('warn', { event, fields });
}

function cloneLogValue(value: unknown) {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
}

function normalizeLevel(level: string): LogLevel {
  const normalized = level.toLowerCase();
  if (normalized === 'debug' || normalized === 'info' || normalized === 'warn' || normalized === 'error') {
    return normalized;
  }

  return 'info';
}

function sanitizeFields(fields: unknown): Record<string, unknown> {
  if (!isRecord(fields)) {
    return {};
  }

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue;
    }

    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      output[key] = value;
      continue;
    }

    output[key] = cloneLogValue(value);
  }

  return output;
}

function writeLogLine(record: Record<string, unknown>) {
  try {
    const { path: logPath } = resolveLogFilePath();
    const logDirectory = dirname(logPath);
    mkdirSync(logDirectory, { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[ai-memory][logger] unable to write log file: ${message}\n`);
  }
}
