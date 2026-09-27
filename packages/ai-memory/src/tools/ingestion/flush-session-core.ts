import type { DbClient, DbPool } from '@aviaratech/ai-memory/internal';
import type { BoundedQueryContext } from '@aviaratech/ai-memory/internal';

import {
  consolidateMemories,
  type ConsolidationRunMetrics,
  getEmbedding,
  ingestMemoryDeltaInTransaction,
  isEmbeddingAvailable,
  logAiMemoryError,
  logAiMemoryWarn,
  pool,
  resolveTimeoutPolicy,
  runBoundedQuery,
  storeMemoryWithAuditEvent,
  type WriteCalibration,
} from '@aviaratech/ai-memory/internal';

import type { ParsedFlushInput } from './flush-session.js';

import {
  buildActionableMemoryWrites,
  buildCheckpointMemoryInput,
  buildFlushDeltaPayload,
  FLUSH_SOURCE,
  type PreparedCoreMemoryWrite,
} from './flush-session-core-builders.js';

export { FLUSH_SOURCE };
export type { ConsolidationRunMetrics };

export interface FlushSessionCoreDependencies {
  consolidateMemories: (
    memories: Parameters<typeof consolidateMemories>[0],
    sessionId?: string,
  ) => Promise<ConsolidationRunMetrics | undefined>;
  getEmbedding: typeof getEmbedding;
  ingestMemoryDeltaInTransaction: typeof ingestMemoryDeltaInTransaction;
  isEmbeddingAvailable: () => boolean;
  logError: typeof logAiMemoryError;
  logWarn: typeof logAiMemoryWarn;
  now: () => Date;
  pool: DbPool;
  storeMemoryWithAuditEvent: (
    client: DbClient,
    input: unknown,
  ) => Promise<{
    calibratedConfidence?: unknown;
    calibration?: unknown;
    category?: unknown;
    confidence?: unknown;
    declaredConfidence?: unknown;
    id: number;
    memoryKey?: unknown;
    memoryType?: unknown;
  }>;
  writeTimeoutMs?: number;
}

export interface StoredCoreWrites {
  actionableMemories: StoredMemoryInfo[];
  calibrations: StoredMemoryCalibration[];
  totalStored: number;
}

export interface StoredMemoryCalibration extends WriteCalibration {
  category: string;
  memoryId: number;
}

export interface StoredMemoryInfo {
  calibration?: StoredMemoryCalibration | undefined;
  category: string;
  confidence: number;
  content: string;
  id: number;
  memoryKey?: null | string | undefined;
  memoryType?: null | string;
}

interface PreparedCoreWrites {
  actionableWrites: PreparedCoreMemoryWrite[];
  checkpointInput: Record<string, unknown>;
}

export function commitCoreFlushWrites(input: {
  buildFlushSnapshotValue: (
    parsed: ParsedFlushInput,
    context: { nowIso: string; sessionId: string },
  ) => Record<string, unknown>;
  dependencies: FlushSessionCoreDependencies;
  parsed: ParsedFlushInput;
  preparedCoreWrites: PreparedCoreWrites;
  sessionId: string;
}): Promise<StoredCoreWrites> {
  const { buildFlushSnapshotValue, dependencies, parsed, preparedCoreWrites, sessionId } = input;
  const timeoutMs = dependencies.writeTimeoutMs ?? resolveTimeoutPolicy().db.writeTimeoutMs;

  return runBoundedQuery({
    phase: 'db.write.memory_flush',
    pool: dependencies.pool,
    task: async (client: DbClient, ctx: BoundedQueryContext) => {
      ctx.setPhase('checkpoint');
      const checkpoint = await dependencies.storeMemoryWithAuditEvent(client, preparedCoreWrites.checkpointInput);

      ctx.setPhase('actionable');
      const storedActionable = await storePreparedActionableMemories({
        client,
        dependencies,
        writes: preparedCoreWrites.actionableWrites,
      });

      ctx.setPhase('delta');
      const nowIso = dependencies.now().toISOString();
      await dependencies.ingestMemoryDeltaInTransaction(
        client,
        buildFlushDeltaPayload({
          buildFlushSnapshotValue,
          nowIso,
          parsed,
          sessionId,
        }),
      );

      const checkpointCalibration = buildStoredCalibration({
        category: 'session-summary',
        memory: checkpoint,
      });
      const calibrations = [
        ...(checkpointCalibration !== undefined ? [checkpointCalibration] : []),
        ...storedActionable.flatMap(memory => (memory.calibration !== undefined ? [memory.calibration] : [])),
      ];
      return {
        actionableMemories: storedActionable,
        calibrations,
        totalStored: 1 + storedActionable.length,
      };
    },
    timeoutMs,
  });
}

export function createDefaultFlushSessionCoreDependencies(): FlushSessionCoreDependencies {
  return {
    consolidateMemories,
    getEmbedding,
    ingestMemoryDeltaInTransaction,
    isEmbeddingAvailable,
    logError: logAiMemoryError,
    logWarn: logAiMemoryWarn,
    now: () => new Date(),
    pool,
    storeMemoryWithAuditEvent,
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

export async function prepareCoreWrites(input: {
  dependencies: FlushSessionCoreDependencies;
  parsed: ParsedFlushInput;
  sessionId: string;
}): Promise<PreparedCoreWrites> {
  const { dependencies, parsed, sessionId } = input;
  const now = dependencies.now();
  const checkpointInput = await attachEmbedding({
    getEmbeddingFn: dependencies.getEmbedding,
    inputRecord: buildCheckpointMemoryInput({
      now,
      parsed,
      sessionId,
    }),
    operation: 'memory_flush.checkpoint',
  });

  const actionableWrites = await attachEmbeddingsToWrites(
    buildActionableMemoryWrites({ parsed, sessionId }),
    dependencies,
  );
  return { actionableWrites, checkpointInput };
}

export async function runConsolidation(input: {
  dependencies: FlushSessionCoreDependencies;
  memories: StoredMemoryInfo[];
  sessionId: string | undefined;
}): Promise<ConsolidationRunMetrics | undefined> {
  const { dependencies, memories, sessionId } = input;
  if (memories.length === 0 || !dependencies.isEmbeddingAvailable()) {
    return undefined;
  }

  try {
    const metrics = await dependencies.consolidateMemories(memories, sessionId);
    return metrics;
  } catch (error) {
    dependencies.logError('flush_session.consolidation_failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

async function attachEmbedding(input: {
  getEmbeddingFn: FlushSessionCoreDependencies['getEmbedding'];
  inputRecord: Record<string, unknown>;
  operation: string;
}): Promise<Record<string, unknown>> {
  const { getEmbeddingFn, inputRecord, operation } = input;
  const rawContent = typeof inputRecord.content === 'string' ? inputRecord.content.trim() : '';
  const rawCategory = typeof inputRecord.category === 'string' ? inputRecord.category.trim() : '';
  const embedding = await getEmbeddingFn(rawContent, { category: rawCategory, operation });
  return { ...inputRecord, embedding };
}

async function attachEmbeddingsToWrites(
  writes: PreparedCoreMemoryWrite[],
  dependencies: FlushSessionCoreDependencies,
): Promise<PreparedCoreMemoryWrite[]> {
  const prepared: PreparedCoreMemoryWrite[] = [];
  for (const write of writes) {
    prepared.push({
      ...write,
      input: await attachEmbedding({
        getEmbeddingFn: dependencies.getEmbedding,
        inputRecord: write.input,
        operation: 'memory_flush.actionable',
      }),
    });
  }
  return prepared;
}

function buildStoredCalibration(input: {
  category: string;
  memory: {
    calibration?: unknown;
    id: number;
  };
}): StoredMemoryCalibration | undefined {
  const calibration = input.memory.calibration;
  if (!isWriteCalibration(calibration)) {
    return undefined;
  }

  return {
    ...calibration,
    category: input.category,
    memoryId: input.memory.id,
  };
}

function isWriteCalibration(value: unknown): value is WriteCalibration {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.calibratedConfidence === 'number' &&
    typeof record.declaredConfidence === 'number' &&
    typeof record.priorMemoryCount === 'number' &&
    typeof record.reversalRate === 'number' &&
    typeof record.scope === 'string' &&
    typeof record.window === 'string'
  );
}

async function storePreparedActionableMemories(input: {
  client: DbClient;
  dependencies: Pick<FlushSessionCoreDependencies, 'storeMemoryWithAuditEvent'>;
  writes: PreparedCoreMemoryWrite[];
}): Promise<StoredMemoryInfo[]> {
  const stored: StoredMemoryInfo[] = [];
  for (const write of input.writes) {
    const memory = await input.dependencies.storeMemoryWithAuditEvent(input.client, write.input);
    stored.push({
      calibration: buildStoredCalibration({
        category: write.category,
        memory,
      }),
      category: write.category,
      confidence: typeof memory.confidence === 'number' ? memory.confidence : write.confidence,
      content: write.content,
      id: memory.id,
      memoryKey: typeof memory.memoryKey === 'string' ? memory.memoryKey : null,
      memoryType: typeof memory.memoryType === 'string' ? memory.memoryType : null,
    });
  }

  return stored;
}
