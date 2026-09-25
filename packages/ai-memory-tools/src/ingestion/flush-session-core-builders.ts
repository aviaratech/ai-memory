import type { ParsedFlushInput } from './flush-session.js';

const CATEGORY_ROOT_CAUSE = 'root-cause';
const FLUSH_CHECKPOINT_CONFIDENCE = 0.45;
const FLUSH_CHECKPOINT_TTL_DAYS = 14;
const FLUSH_DECISION_CONFIDENCE = 0.7;
const FLUSH_ROOT_CAUSE_CONFIDENCE = 0.7;
const MAX_ITEM_CHARS = 500;
const MAX_SUMMARY_CHARS = 2000;

export const FLUSH_SOURCE = 'memory-flush';

export interface PreparedCoreMemoryWrite {
  category: string;
  confidence: number;
  content: string;
  input: Record<string, unknown>;
}

export function buildActionableMemoryWrites(input: {
  parsed: ParsedFlushInput;
  sessionId: string;
}): PreparedCoreMemoryWrite[] {
  const writes: PreparedCoreMemoryWrite[] = [];

  for (const decision of input.parsed.decisions) {
    const content = truncate(decision, MAX_ITEM_CHARS);
    writes.push(
      buildPreparedMemoryWrite({
        category: 'decision',
        confidence: FLUSH_DECISION_CONFIDENCE,
        content,
        parsed: input.parsed,
        sessionId: input.sessionId,
        tag: 'decision',
      }),
    );
  }

  for (const rootCause of input.parsed.rootCauses) {
    const content = truncate(rootCause, MAX_ITEM_CHARS);
    writes.push(
      buildPreparedMemoryWrite({
        category: CATEGORY_ROOT_CAUSE,
        confidence: FLUSH_ROOT_CAUSE_CONFIDENCE,
        content,
        parsed: input.parsed,
        sessionId: input.sessionId,
        tag: CATEGORY_ROOT_CAUSE,
      }),
    );
  }

  return writes;
}

export function buildCheckpointMemoryInput(input: {
  now: Date;
  parsed: ParsedFlushInput;
  sessionId: string;
}): Record<string, unknown> {
  const expiresAt = new Date(input.now.getTime() + FLUSH_CHECKPOINT_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return {
    ...(input.parsed.agent !== undefined ? { agent: input.parsed.agent } : {}),
    category: 'session-summary',
    confidence: FLUSH_CHECKPOINT_CONFIDENCE,
    content: truncate(input.parsed.summary, MAX_SUMMARY_CHARS),
    expiresAt,
    ...(input.parsed.project !== undefined ? { project: input.parsed.project } : {}),
    ...(input.parsed.repoSlug !== undefined ? { repoSlug: input.parsed.repoSlug } : {}),
    sensitivity: 'internal',
    sessionId: input.sessionId,
    ...(input.parsed.source !== undefined ? { source: input.parsed.source } : {}),
    tags: [FLUSH_SOURCE, 'pre-compaction'],
  };
}

export function buildFlushDeltaPayload(input: {
  buildFlushSnapshotValue: (
    parsed: ParsedFlushInput,
    context: { nowIso: string; sessionId: string },
  ) => Record<string, unknown>;
  nowIso: string;
  parsed: ParsedFlushInput;
  sessionId: string;
}): Record<string, unknown> {
  const snapshotValue = input.buildFlushSnapshotValue(input.parsed, {
    nowIso: input.nowIso,
    sessionId: input.sessionId,
  });

  return {
    memoryDelta: {
      append_events: [
        {
          summary: `memory_flush: ${truncate(input.parsed.summary, 120)}`,
          ts: input.nowIso,
          type: 'checkpoint',
        },
      ],
      artifacts: [],
      created_at: input.nowIso,
      delta_id: `${FLUSH_SOURCE}-${input.sessionId}-${Date.now().toString()}`,
      produced_by: { agent: input.parsed.agent ?? FLUSH_SOURCE },
      schema_version: 'memory_delta@0.1',
      session_id: input.sessionId,
      snapshot: {
        mode: 'replace',
        value: snapshotValue,
      },
      tenancy: input.parsed.project === undefined ? {} : { repo_id: input.parsed.project },
      workflow: {
        entity_id: input.sessionId,
        entity_type: 'agent_session',
        system: FLUSH_SOURCE,
        title: 'Pre-compaction flush',
      },
    },
  };
}

function buildPreparedMemoryWrite(input: {
  category: string;
  confidence: number;
  content: string;
  parsed: ParsedFlushInput;
  sessionId: string;
  tag: string;
}): PreparedCoreMemoryWrite {
  return {
    category: input.category,
    confidence: input.confidence,
    content: input.content,
    input: {
      ...(input.parsed.agent !== undefined ? { agent: input.parsed.agent } : {}),
      category: input.category,
      confidence: input.confidence,
      content: input.content,
      ...(input.parsed.project !== undefined ? { project: input.parsed.project } : {}),
      ...(input.parsed.repoSlug !== undefined ? { repoSlug: input.parsed.repoSlug } : {}),
      sensitivity: 'internal',
      sessionId: input.sessionId,
      ...(input.parsed.source !== undefined ? { source: input.parsed.source } : {}),
      tags: [FLUSH_SOURCE, input.tag],
    },
  };
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
