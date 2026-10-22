import type { ParsedFlushInput } from './flush-session.js';

export const FLUSH_SOURCE = 'memory-flush';

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

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
