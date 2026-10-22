import type { DbClient, DbPool } from '@aviaratech/ai-memory/internal';
import type { BoundedQueryContext } from '@aviaratech/ai-memory/internal';

import {
  ingestMemoryDeltaInTransaction,
  logAiMemoryWarn,
  pool,
  resolveTimeoutPolicy,
  runBoundedQuery,
} from '@aviaratech/ai-memory/internal';

import type { ParsedFlushInput } from './flush-session.js';

import { buildFlushDeltaPayload, FLUSH_SOURCE } from './flush-session-core-builders.js';

export { FLUSH_SOURCE };

export interface FlushSessionCoreDependencies {
  ingestMemoryDeltaInTransaction: typeof ingestMemoryDeltaInTransaction;
  logWarn: typeof logAiMemoryWarn;
  now: () => Date;
  pool: DbPool;
  writeTimeoutMs?: number;
}

/**
 * Commits the flush checkpoint: one memory delta, which records the session,
 * its snapshot and its checkpoint event. Flush writes no durable memories.
 */
export async function commitFlushCheckpoint(input: {
  buildFlushSnapshotValue: (
    parsed: ParsedFlushInput,
    context: { nowIso: string; sessionId: string },
  ) => Record<string, unknown>;
  dependencies: FlushSessionCoreDependencies;
  parsed: ParsedFlushInput;
  sessionId: string;
}): Promise<void> {
  const { buildFlushSnapshotValue, dependencies, parsed, sessionId } = input;
  const timeoutMs = dependencies.writeTimeoutMs ?? resolveTimeoutPolicy().db.writeTimeoutMs;

  await runBoundedQuery({
    phase: 'db.write.memory_flush',
    pool: dependencies.pool,
    task: async (client: DbClient, ctx: BoundedQueryContext) => {
      ctx.setPhase('delta');
      await dependencies.ingestMemoryDeltaInTransaction(
        client,
        buildFlushDeltaPayload({
          buildFlushSnapshotValue,
          nowIso: dependencies.now().toISOString(),
          parsed,
          sessionId,
        }),
      );
    },
    timeoutMs,
  });
}

export function createDefaultFlushSessionCoreDependencies(): FlushSessionCoreDependencies {
  return {
    ingestMemoryDeltaInTransaction,
    logWarn: logAiMemoryWarn,
    now: () => new Date(),
    pool,
  };
}

export function logContinuityWarnings(input: {
  dependencies: Pick<FlushSessionCoreDependencies, 'logWarn'>;
  sessionId: string;
  warnings: string[];
}) {
  const { dependencies, sessionId, warnings } = input;
  if (warnings.length === 0) {
    return;
  }

  dependencies.logWarn('flush_session.continuity_quality_warning', {
    message: 'Continuity payload is missing optional quality fields.',
    sessionId,
    warnings,
  });
}
