/**
 * Shared constants and utilities used by both core DB queries and tools-layer health reporting.
 *
 * These live in core because db/memory-api.ts depends on them. The tools-layer health-report
 * imports from @aviaratech/ai-memory/internal.
 */

export const DEFAULT_DAYS = 7;
export const DEFAULT_LOG_FILE = '.logs/ai-memory.log';
export const DEFAULT_RETROS_DIR = '.ai/state/retros';
export const DEFAULT_REPEATED_FIX_WINDOW_DAYS = 30;
export const DEFAULT_DECISION_REVERSAL_WINDOW_DAYS = 14;
export const DEFAULT_CALIBRATION_MIN_SIGNALS = 10;
export const DEFAULT_WRITER_PARTICIPATION_MIN_PCT = 20;
export const ACTIVE_FAILURE_WINDOW_DAYS = 1;
export const EVENT_CONFLICT_TARGET_PCT = 1;
export const FAILURE_SIGNATURE_SAMPLE_LIMIT = 2_000;
export const SESSION_END_CONFLICT_WINDOW_DAYS = 14;
export const SESSION_END_DELTA_EVENT_ID_PREFIX = 'claude-session-end-delta-%';
export const CODEX_HOOK_DELTA_EVENT_ID_PREFIX = 'codex-hook-delta-%';
export const TOP_FAILURE_SIGNATURE_LIMIT = 5;
/**
 * Top N timeout operations to surface in the rolling health report alongside
 * the existing failure signature breakdown. Used to answer "which DB phase is
 * driving the rolling timeout/degradation rate" at a glance.
 */
export const TOP_TIMEOUT_OPERATION_LIMIT = 5;
export const DEFAULT_TRANSCRIPTS_DIR = '.ai/state/transcripts';

import { isRecord } from './db/type-guards.js';

export function extractModulePath(reference: unknown): null | string {
  if (typeof reference === 'string') {
    const trimmed = reference.trim();
    if (trimmed.length === 0) {
      return null;
    }

    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      try {
        const url = new URL(trimmed);
        const segments = normalizePathSegments(url.pathname);
        const blobIndex = segments.indexOf('blob');
        if (blobIndex === -1) {
          return null;
        }
        return toModulePath(segments.slice(blobIndex + 2));
      } catch {
        return null;
      }
    }

    return toModulePath(normalizePathSegments(trimmed));
  }

  if (isRecord(reference) && 'path' in reference) {
    return extractModulePath(reference.path);
  }

  return null;
}

function normalizePathSegments(pathValue: string): string[] {
  return pathValue
    .replaceAll('\\', '/')
    .split('/')
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0);
}

function toModulePath(segments: string[]): null | string {
  const first = segments[0];
  const second = segments[1];
  if (first === undefined || second === undefined) {
    return null;
  }
  return `${first}/${second}`;
}
