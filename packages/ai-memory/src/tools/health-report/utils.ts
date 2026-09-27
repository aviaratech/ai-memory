import { isRecord as isRecordBase } from '@aviaratech/ai-memory/internal';

import type { JsonRecord } from './types.js';

export function formatNumber(value: unknown, decimals: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '0';
  }
  return value.toFixed(decimals);
}

export function formatPercent(value: number): string {
  return `${formatNumber(value, 1)}%`;
}

export function isRecord(value: unknown): value is JsonRecord {
  return isRecordBase(value);
}

export function parseJsonObject(value: unknown): JsonRecord | null {
  if (isRecord(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseTimestampMs(value: unknown): null | number {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

export function percent(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }
  return Number(((numerator / denominator) * 100).toFixed(1));
}

export function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

export function toPositiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

export function toText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
