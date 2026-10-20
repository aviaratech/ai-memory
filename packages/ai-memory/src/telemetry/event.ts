import { createHash } from 'node:crypto';
import * as z from 'zod/v4';

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/u);
const slug = id.max(64);
const project = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const optionalCount = count.nullable().optional();
const rawUsageSchema = z.strictObject({
  input_tokens: optionalCount,
  input_tokens_details: z
    .strictObject({ cached_tokens: optionalCount, cache_write_tokens: optionalCount })
    .nullable()
    .optional(),
  output_tokens: optionalCount,
  output_tokens_details: z.strictObject({ reasoning_tokens: optionalCount }).nullable().optional(),
  total_tokens: optionalCount,
});
const eventSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.enum(['host', 'usage', 'edge', 'correlation']),
  producer: slug,
  eventId: id,
  source: z.enum(['codex-hook', 'claude-hook', 'openai-responses', 'producer']),
  observedAt: z.iso.datetime().nullable().default(null),
  projectId: project.nullable().default(null),
  taskId: id.nullable().default(null),
  sessionId: id.nullable().default(null),
  turnId: id.nullable().default(null),
  responseId: id.nullable().default(null),
  host: z.enum(['codex', 'claude-code']).nullable().default(null),
  model: id.nullable().default(null),
  stage: slug.nullable().default(null),
  toolCategory: slug.nullable().default(null),
  edge: z.enum(['stage', 'retry', 'failure', 'blocker', 'correction', 'accepted']).nullable().default(null),
  attempt: count.min(1).nullable().default(null),
  executionMs: count.nullable().default(null),
  queueMs: count.nullable().default(null),
  relatedEvent: z.strictObject({ producer: slug, eventId: id }).nullable().default(null),
  evidenceIds: z
    .array(id)
    .max(8)
    .refine(a => new Set(a).size === a.length)
    .default([]),
  hostEvent: z.enum(['SessionStart', 'Stop', 'SessionEnd']).nullable().default(null),
  // Validate usage separately to return a fixed usage-specific failure code.
  usage: z.unknown().optional(),
  dedupCoverage: z.enum(['producer-stable', 'host-turn', 'invocation-only']).default('producer-stable'),
});

export type TelemetryEventInputV1 = Omit<z.input<typeof eventSchema>, 'usage'> & {
  usage?: z.input<typeof rawUsageSchema> | null;
};
export interface TelemetryUsageV1 {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  accounting: 'openai-responses' | 'unknown';
}
export type TelemetryEventV1 = Omit<z.output<typeof eventSchema>, 'usage'> & { usage: TelemetryUsageV1 | null };
export type TelemetryRejectCode =
  | 'invalid_event'
  | 'unsupported_version'
  | 'oversized'
  | 'invalid_usage'
  | 'invalid_correlation';
export type TelemetryParseResult = { ok: true; event: TelemetryEventV1 } | { ok: false; code: TelemetryRejectCode };

/** Only data properties are visited; serialization cannot execute getters/toJSON. */
function isPlainData(value: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
    return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length > 512 || keys.some(key => typeof key !== 'string')) return false;
  return keys.every(key => {
    if (Array.isArray(value) && key === 'length') return true;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      descriptor !== undefined &&
      descriptor.enumerable &&
      'value' in descriptor &&
      isPlainData(descriptor.value, depth + 1)
    );
  });
}

export function projectIdForTelemetry(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

/** Accepts a usage object supplied by a cooperating caller, never a response body. */
export function projectOpenAIUsage(input: unknown): TelemetryUsageV1 {
  if (!isPlainData(input)) throw new Error('invalid_usage');
  const result = rawUsageSchema.safeParse(input);
  if (!result.success) throw new Error('invalid_usage');
  const raw = result.data;
  const usage: TelemetryUsageV1 = {
    inputTokens: raw.input_tokens ?? null,
    cachedInputTokens: raw.input_tokens_details?.cached_tokens ?? null,
    cacheWriteInputTokens: raw.input_tokens_details?.cache_write_tokens ?? null,
    outputTokens: raw.output_tokens ?? null,
    reasoningOutputTokens: raw.output_tokens_details?.reasoning_tokens ?? null,
    accounting: 'openai-responses',
  };
  const {
    inputTokens: i,
    cachedInputTokens: c,
    cacheWriteInputTokens: w,
    outputTokens: o,
    reasoningOutputTokens: r,
  } = usage;
  if (
    (i !== null && c !== null && c > i) ||
    (i !== null && w !== null && w > i) ||
    (o !== null && r !== null && r > o) ||
    (c !== null && w !== null && (!Number.isSafeInteger(c + w) || (i !== null && c + w > i))) ||
    (i !== null &&
      o !== null &&
      (!Number.isSafeInteger(i + o) || (raw.total_tokens != null && raw.total_tokens !== i + o)))
  )
    throw new Error('invalid_usage');
  return usage;
}

export function parseTelemetryEvent(input: unknown): TelemetryParseResult {
  try {
    if (!isPlainData(input)) return { ok: false, code: 'invalid_event' };
    if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 16 * 1024) return { ok: false, code: 'oversized' };
    if (typeof input !== 'object' || input === null || Array.isArray(input))
      return { ok: false, code: 'invalid_event' };
    if ('schemaVersion' in input && input.schemaVersion !== 1) return { ok: false, code: 'unsupported_version' };
    const parsed = eventSchema.safeParse(input);
    if (!parsed.success) return { ok: false, code: 'invalid_event' };
    const e = parsed.data;
    let usage: TelemetryUsageV1 | null = null;
    if (e.usage != null) {
      if (e.source !== 'openai-responses' || e.kind !== 'usage') return { ok: false, code: 'invalid_usage' };
      try {
        usage = projectOpenAIUsage(e.usage);
      } catch {
        return { ok: false, code: 'invalid_usage' };
      }
    }
    if (e.kind === 'host') {
      if (
        e.hostEvent === null ||
        e.host === null ||
        e.source !== (e.host === 'codex' ? 'codex-hook' : 'claude-hook') ||
        e.edge !== null ||
        e.relatedEvent !== null ||
        usage !== null
      )
        return { ok: false, code: 'invalid_event' };
    } else if (e.kind === 'usage') {
      if (
        e.source !== 'openai-responses' ||
        e.responseId === null ||
        e.edge !== null ||
        e.hostEvent !== null ||
        e.relatedEvent !== null
      )
        return { ok: false, code: 'invalid_event' };
    } else {
      if (
        e.source !== 'producer' ||
        e.projectId === null ||
        e.taskId === null ||
        e.evidenceIds.length === 0 ||
        e.hostEvent !== null ||
        usage !== null
      )
        return { ok: false, code: 'invalid_correlation' };
      if (e.kind === 'edge') {
        if (
          e.stage === null ||
          e.edge === null ||
          (e.edge === 'accepted' || e.edge === 'correction') !== (e.relatedEvent !== null)
        )
          return { ok: false, code: 'invalid_correlation' };
      } else if (e.host === null || e.sessionId === null || e.edge !== null || e.relatedEvent !== null)
        return { ok: false, code: 'invalid_correlation' };
    }
    if (
      e.dedupCoverage === 'host-turn' &&
      (e.kind !== 'host' || e.host !== 'codex' || e.hostEvent !== 'Stop' || e.sessionId === null || e.turnId === null)
    )
      return { ok: false, code: 'invalid_event' };
    return { ok: true, event: { ...e, usage } };
  } catch {
    return { ok: false, code: 'invalid_event' };
  }
}

export function projectHostTelemetry(
  host: 'codex' | 'claude-code',
  payload: unknown,
  newId: () => string,
): TelemetryParseResult {
  try {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload))
      return { ok: false, code: 'invalid_event' };
    const prototype: unknown = Object.getPrototypeOf(payload);
    if (prototype !== Object.prototype && prototype !== null) return { ok: false, code: 'invalid_event' };
    const read = (key: string): unknown => {
      const d = Object.getOwnPropertyDescriptor(payload, key);
      if (d === undefined) return null;
      if (!('value' in d)) throw new Error('invalid_event');
      return d.value;
    };
    const hostEvent = read('hook_event_name');
    const sessionId = read('session_id');
    const turnId = host === 'codex' && hostEvent === 'Stop' ? read('turn_id') : null;
    const stable = typeof sessionId === 'string' && typeof turnId === 'string';
    const eventId = stable
      ? createHash('sha256')
          .update(JSON.stringify([host, sessionId, turnId]))
          .digest('hex')
      : newId();
    return parseTelemetryEvent({
      schemaVersion: 1,
      kind: 'host',
      producer: 'ai-memory-hook',
      eventId,
      source: host === 'codex' ? 'codex-hook' : 'claude-hook',
      host,
      hostEvent,
      sessionId,
      turnId,
      model: host === 'claude-code' && hostEvent === 'SessionStart' ? read('model') : null,
      dedupCoverage: stable ? 'host-turn' : 'invocation-only',
    });
  } catch {
    return { ok: false, code: 'invalid_event' };
  }
}
