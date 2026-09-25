import { redactDatabaseUrl } from './pool.js';

export function redactUrl(value: string) {
  return redactDatabaseUrl(value);
}

export function toIsoTimestamp(value: unknown) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.valueOf())) {
      return parsed.toISOString();
    }
  }

  return undefined;
}

export function toJsonbParam(value: unknown) {
  return JSON.stringify(value);
}
