import { normalizeMemoryType } from './memory-types.js';

type DbRow = Record<string, unknown>;

const EMPTY_OBJECT: Record<string, unknown> = {};
const EMPTY_ARRAY: unknown[] = [];

export function toIngestionFailureRecord(row: unknown) {
  const normalizedRow = normalizeRow(row);

  return {
    agent: normalizedRow.agent,
    createdAt: toIsoIfDate(normalizedRow.created_at),
    details: toObjectOrDefault(normalizedRow.details_json),
    errorMessage: normalizedRow.error_message,
    id: toNumberOrUndefined(normalizedRow.id) ?? 0,
    repoId: normalizedRow.repo_id,
    resolutionBatchId: normalizedRow.resolution_batch_id ?? null,
    resolvedAt: toIsoIfDate(normalizedRow.resolved_at) ?? null,
    resolvedBy: normalizedRow.resolved_by ?? null,
    resolvedReason: normalizedRow.resolved_reason ?? null,
    sessionId: normalizedRow.session_id,
    source: normalizedRow.source,
    stage: normalizedRow.stage,
  };
}

export function toMemoryRecord(row: unknown) {
  const normalizedRow = normalizeRow(row);
  const memoryType = toMemoryTypeOrNull(normalizedRow.memory_type);

  return {
    agent: normalizedRow.agent,
    calibratedConfidence: toNumberOrUndefined(normalizedRow.calibrated_confidence),
    category: normalizedRow.category,
    confidence: toNumberOrUndefined(normalizedRow.confidence),
    content: normalizedRow.content,
    createdAt: toIsoIfDate(normalizedRow.created_at),
    decayedImportance: toNumberOrUndefined(normalizedRow.decayed_importance),
    declaredConfidence: toNumberOrUndefined(normalizedRow.declared_confidence),
    dedupeHash: normalizedRow.dedupe_hash,
    embedding: toNumberArrayOrNull(normalizedRow.embedding),
    evidenceRefs: toArrayOrDefault(normalizedRow.evidence_refs),
    expiresAt: toIsoIfDate(normalizedRow.expires_at),
    id: toNumberOrUndefined(normalizedRow.id) ?? 0,
    importance: toNumberOrUndefined(normalizedRow.importance),
    memory_type: memoryType,
    memoryKey: normalizedRow.memory_key,
    memoryType,
    metadata: toObjectOrDefault(normalizedRow.metadata_json),
    model: normalizedRow.model,
    orgId: normalizedRow.org_id,
    project: normalizedRow.project,
    relevance: toNumberOrUndefined(normalizedRow.relevance),
    repoId: normalizedRow.repo_id,
    repoSlug: normalizedRow.repo_slug,
    sensitivity: normalizedRow.sensitivity,
    sessionId: normalizedRow.session_id,
    ...(toObjectOrUndefined(normalizedRow.signals) !== undefined
      ? { signals: toObjectOrUndefined(normalizedRow.signals) }
      : {}),
    source: normalizedRow.source,
    status: normalizedRow.status,
    supersedesId: toNumberOrUndefined(normalizedRow.supersedes_id),
    tags: toArrayOrDefault(normalizedRow.tags),
    threadId: normalizedRow.thread_id,
    tool: normalizedRow.tool,
    updatedAt: toIsoIfDate(normalizedRow.updated_at),
    updatedBy: normalizedRow.updated_by,
    userId: normalizedRow.user_id,
  };
}

export function toSessionEventRecord(row: unknown) {
  const normalizedRow = normalizeRow(row);

  return {
    createdAt: toIsoIfDate(normalizedRow.created_at),
    eventId: normalizedRow.event_id,
    eventType: normalizedRow.event_type,
    id: toNumberOrUndefined(normalizedRow.id) ?? 0,
    payloadJson: toObjectOrDefault(normalizedRow.payload_json),
    sessionId: normalizedRow.session_id,
    summary: normalizedRow.summary,
  };
}

export function toSessionRecord(row: unknown) {
  const normalizedRow = normalizeRow(row);

  return {
    agent: normalizedRow.agent,
    endedAt: toIsoIfDate(normalizedRow.ended_at),
    metadata: toObjectOrDefault(normalizedRow.metadata_json),
    model: normalizedRow.model,
    orgId: normalizedRow.org_id,
    repoId: normalizedRow.repo_id,
    repoSlug: normalizedRow.repo_slug,
    sessionId: normalizedRow.session_id,
    startedAt: toIsoIfDate(normalizedRow.started_at),
    status: normalizedRow.status,
    taskId: normalizedRow.task_id,
    taskTitle: normalizedRow.task_title,
    taskType: normalizedRow.task_type,
    tool: normalizedRow.tool,
    updatedAt: toIsoIfDate(normalizedRow.updated_at),
    userId: normalizedRow.user_id,
  };
}

export function toSessionSnapshotRecord(row: unknown) {
  const normalizedRow = normalizeRow(row);

  return {
    createdAt: toIsoIfDate(normalizedRow.created_at),
    id: toNumberOrUndefined(normalizedRow.id) ?? 0,
    schemaVersion: normalizedRow.schema_version,
    sessionId: normalizedRow.session_id,
    snapshotId: normalizedRow.snapshot_id,
    snapshotJson: toObjectOrDefault(normalizedRow.snapshot_json),
    sourceDeltaId: normalizedRow.source_delta_id,
  };
}

export function withWriteDisposition<T extends Record<string, unknown>>(memory: T, writeDisposition: string) {
  return {
    ...memory,
    writeDisposition,
  };
}

function normalizeRow(row: unknown): DbRow {
  if (row !== null && typeof row === 'object' && !Array.isArray(row)) {
    return row as DbRow;
  }

  return EMPTY_OBJECT;
}

function toArrayOrDefault(value: unknown) {
  if (Array.isArray(value)) {
    return value as unknown[];
  }

  return EMPTY_ARRAY;
}

function toIsoIfDate(value: unknown) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return value;
}

function toMemoryTypeOrNull(value: unknown): null | string {
  try {
    return normalizeMemoryType(value, 'memoryType') ?? null;
  } catch {
    return null;
  }
}

function toNumberArrayOrNull(value: unknown): null | number[] {
  if (Array.isArray(value)) {
    return value as number[];
  }
  return null;
}

function toNumberOrUndefined(value: unknown) {
  if (value === undefined || value === null) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function toObjectOrDefault(value: unknown) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }

  return EMPTY_OBJECT;
}

function toObjectOrUndefined(value: unknown) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  return undefined;
}
