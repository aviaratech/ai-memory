import { insertIngestionFailureWithClient } from './failure-events.js';
import {
  isTimestampBefore,
  normalizeOptionalText,
  normalizePatchSnapshotId,
  normalizeRequiredText,
  normalizeRequiredTimestamp,
  normalizeSnapshotCreatedAt,
  readRepoIdFromTenancy,
  toIsoTimestamp,
} from './normalization.js';
import { applySnapshotPatch, cloneJson } from './patch.js';
import {
  getLatestSessionSnapshotWithClient,
  getSessionSnapshotBySourceDeltaIdWithClient,
  listMemoryDeltasForSessionWithClient,
} from './query-helpers.js';
import { MEMORY_DELTA_TOOL, PATCH_OUT_OF_ORDER_STAGE, SESSION_SNAPSHOT_SCHEMA_VERSION } from './runtime.js';
import { isRecord } from './type-guards.js';
import { upsertSessionSnapshotWithClient } from './upserts.js';

type DatabaseClient = Parameters<typeof listMemoryDeltasForSessionWithClient>[0];

interface DeltaSnapshotInput {
  deltaCreatedAt: string;
  deltaId: string;
  enforceOrdering?: boolean | undefined;
  producedByAgent?: string | undefined;
  repoId?: string | undefined;
  sessionId: string;
  snapshotMode: string;
  snapshotValue: unknown;
}

interface MaterializePatchBackfillInput {
  sessionId: string;
}

interface MemoryDeltaRow {
  created_at: unknown;
  delta_id: string;
  produced_by_agent?: string | undefined;
  snapshot_json: unknown;
  snapshot_mode: string;
  tenancy_json?: unknown;
}

interface SessionSnapshotRow {
  created_at: unknown;
  snapshot_id: string;
  snapshot_json: unknown;
}

type SnapshotMaterializationResult =
  | { snapshotId: string; status: 'duplicate' | 'materialized' }
  | { status: 'out_of_order' | 'skipped' };

export async function materializeSessionSnapshotForDeltaWithClient(
  client: DatabaseClient,
  input: DeltaSnapshotInput,
): Promise<SnapshotMaterializationResult> {
  if (input.snapshotMode === 'replace') {
    return await materializeReplaceSnapshotForDeltaWithClient(client, input);
  }

  if (input.snapshotMode === 'patch') {
    return await materializePatchSnapshotForDeltaWithClient(client, input);
  }

  return { status: 'skipped' };
}

export async function materializeSnapshotsFromStoredDeltasForSessionWithClient(
  client: DatabaseClient,
  input: MaterializePatchBackfillInput,
) {
  const sessionId = input.sessionId;
  const rawDeltas: unknown = await listMemoryDeltasForSessionWithClient(client, sessionId);
  const deltas = normalizeMemoryDeltaRows(rawDeltas);
  if (deltas.length === 0) {
    return {
      failuresLogged: 0,
      snapshotsMaterialized: 0,
      status: 'ok',
    };
  }

  let failuresLogged = 0;
  let snapshotsMaterialized = 0;

  for (const delta of deltas) {
    const deltaCreatedAt = toIsoTimestamp(delta.created_at);
    if (deltaCreatedAt === undefined) {
      throw new Error('ai_memory_deltas.created_at must be a non-empty ISO timestamp string.');
    }

    const result = await materializeSessionSnapshotForDeltaWithClient(client, {
      deltaCreatedAt,
      deltaId: delta.delta_id,
      enforceOrdering: false,
      producedByAgent: delta.produced_by_agent,
      repoId: readRepoIdFromTenancy(delta.tenancy_json),
      sessionId,
      snapshotMode: delta.snapshot_mode,
      snapshotValue: delta.snapshot_json,
    });

    if (result.status === 'materialized') {
      snapshotsMaterialized += 1;
    }
    if (result.status === 'out_of_order') {
      failuresLogged += 1;
    }
  }

  return {
    failuresLogged,
    snapshotsMaterialized,
    status: 'ok',
  };
}

async function materializePatchSnapshotForDeltaWithClient(
  client: DatabaseClient,
  input: DeltaSnapshotInput,
): Promise<SnapshotMaterializationResult> {
  if (!isRecord(input.snapshotValue) || !Array.isArray(input.snapshotValue.ops)) {
    return { status: 'skipped' };
  }

  const existingSnapshotRaw: unknown = await getSessionSnapshotBySourceDeltaIdWithClient(client, {
    sessionId: input.sessionId,
    sourceDeltaId: input.deltaId,
  });
  const existingSnapshot = normalizeSessionSnapshotRow(existingSnapshotRaw);
  if (existingSnapshot !== undefined) {
    return { snapshotId: existingSnapshot.snapshot_id, status: 'duplicate' };
  }

  const latestSnapshotRaw: unknown = await getLatestSessionSnapshotWithClient(client, input.sessionId);
  const latestSnapshot = normalizeSessionSnapshotRow(latestSnapshotRaw);
  const enforceOrdering = input.enforceOrdering ?? true;
  if (
    enforceOrdering &&
    latestSnapshot !== undefined &&
    isTimestampBefore(input.deltaCreatedAt, latestSnapshot.created_at)
  ) {
    await insertIngestionFailureWithClient(client, {
      agent: input.producedByAgent,
      details: {
        delta_created_at: input.deltaCreatedAt,
        delta_id: input.deltaId,
        latest_snapshot_created_at: toIsoTimestamp(latestSnapshot.created_at),
        latest_snapshot_id: latestSnapshot.snapshot_id,
        reason: 'out_of_order_patch_delta',
      },
      errorMessage: `Skipped out-of-order patch delta ${input.deltaId}.`,
      repoId: input.repoId,
      sessionId: input.sessionId,
      source: MEMORY_DELTA_TOOL,
      stage: PATCH_OUT_OF_ORDER_STAGE,
    });
    return { status: 'out_of_order' };
  }

  const baseSnapshot = latestSnapshot?.snapshot_json;
  const mergedSnapshot = applySnapshotPatch(baseSnapshot, {
    fieldName: 'memoryDelta.snapshot.value.ops',
    patch: input.snapshotValue,
  });

  const normalizedSnapshot: Record<string, unknown> = isRecord(mergedSnapshot) ? { ...mergedSnapshot } : {};
  const snapshotId = normalizePatchSnapshotId(normalizedSnapshot.snapshot_id, input.deltaId);
  const snapshotCreatedAt = normalizeSnapshotCreatedAt(normalizedSnapshot.created_at, input.deltaCreatedAt);
  normalizedSnapshot.snapshot_id = snapshotId;
  normalizedSnapshot.created_at = snapshotCreatedAt;

  await upsertSessionSnapshotWithClient(client, {
    createdAt: snapshotCreatedAt,
    schemaVersion: SESSION_SNAPSHOT_SCHEMA_VERSION,
    sessionId: input.sessionId,
    snapshotId,
    snapshotJson: normalizedSnapshot,
    sourceDeltaId: input.deltaId,
  });

  return { snapshotId, status: 'materialized' };
}

async function materializeReplaceSnapshotForDeltaWithClient(
  client: DatabaseClient,
  input: DeltaSnapshotInput,
): Promise<SnapshotMaterializationResult> {
  if (!isRecord(input.snapshotValue)) {
    return { status: 'skipped' };
  }

  const snapshotValue = cloneJson(input.snapshotValue);
  const snapshotIdRaw = snapshotValue.snapshot_id;
  if (typeof snapshotIdRaw !== 'string') {
    return { status: 'skipped' };
  }
  const snapshotId = snapshotIdRaw.trim();
  if (snapshotId.length === 0) {
    return { status: 'skipped' };
  }

  const snapshotCreatedAt = normalizeRequiredTimestamp(
    snapshotValue.created_at ?? input.deltaCreatedAt,
    'memoryDelta.snapshot.value.created_at',
  );

  snapshotValue.snapshot_id = snapshotId;
  snapshotValue.created_at = snapshotCreatedAt;

  await upsertSessionSnapshotWithClient(client, {
    createdAt: snapshotCreatedAt,
    schemaVersion: SESSION_SNAPSHOT_SCHEMA_VERSION,
    sessionId: input.sessionId,
    snapshotId,
    snapshotJson: snapshotValue,
    sourceDeltaId: input.deltaId,
  });

  return { snapshotId, status: 'materialized' };
}

function normalizeMemoryDeltaRow(row: unknown): MemoryDeltaRow {
  if (!isRecord(row)) {
    throw new Error('Expected ai_memory_deltas row object.');
  }

  return {
    created_at: row.created_at,
    delta_id: normalizeRequiredText(row.delta_id, 'ai_memory_deltas.delta_id'),
    produced_by_agent: normalizeOptionalText(row.produced_by_agent),
    snapshot_json: row.snapshot_json,
    snapshot_mode: normalizeRequiredText(row.snapshot_mode, 'ai_memory_deltas.snapshot_mode'),
    tenancy_json: row.tenancy_json,
  };
}

function normalizeMemoryDeltaRows(rows: unknown): MemoryDeltaRow[] {
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows.map(row => normalizeMemoryDeltaRow(row));
}

function normalizeSessionSnapshotRow(row: unknown): SessionSnapshotRow | undefined {
  if (!isRecord(row)) {
    return undefined;
  }

  const snapshotIdRaw = row.snapshot_id;
  if (typeof snapshotIdRaw !== 'string') {
    return undefined;
  }
  const snapshotId = snapshotIdRaw.trim();
  if (snapshotId.length === 0) {
    return undefined;
  }

  return {
    created_at: row.created_at,
    snapshot_id: snapshotId,
    snapshot_json: row.snapshot_json,
  };
}
