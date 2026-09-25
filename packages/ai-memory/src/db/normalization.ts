import { createDurableMemoryKey, createMemoryDedupeHash } from './hashing.js';
import { normalizeMemoryType, resolveMemoryTypeFromCategory } from './memory-types.js';
import {
  assertDurableMemoryInputPolicy,
  assertDurableMemoryProposalPolicy,
  isStrictMetadataCategory,
} from './quality-gates.js';
import {
  MEMORY_STATUS_VALUES,
  PATCH_SNAPSHOT_ID_PREFIX,
  SENSITIVITY_VALUES,
  UNKNOWN_INGESTION_FAILURE,
} from './runtime.js';
import { isRecord } from './type-guards.js';
export { redactUrl, toIsoTimestamp, toJsonbParam } from './value-utils.js';

export function addDaysToIso(baseIso: string, ttlDays: number) {
  const baseDate = new Date(baseIso);
  if (Number.isNaN(baseDate.valueOf())) {
    throw new Error('Unable to compute expiresAt because base timestamp is invalid.');
  }

  baseDate.setUTCDate(baseDate.getUTCDate() + ttlDays);
  return baseDate.toISOString();
}

export function isTimestampBefore(leftTimestamp: string, rightTimestamp: unknown) {
  const leftMs = Date.parse(leftTimestamp);
  if (!Number.isFinite(leftMs)) {
    return false;
  }

  if (rightTimestamp instanceof Date) {
    return leftMs < rightTimestamp.valueOf();
  }

  if (typeof rightTimestamp === 'string') {
    const rightMs = Date.parse(rightTimestamp);
    return Number.isFinite(rightMs) ? leftMs < rightMs : false;
  }

  return false;
}

export function normalizeBoolean(value: unknown, fallback: boolean) {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (typeof value !== 'boolean') {
    throw new Error('Expected a boolean value.');
  }

  return value;
}

export function normalizeDurableMemoryProposals(value: unknown) {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error('x_durable_memories must be an array when provided.');
  }

  return value.map((proposal, index) => {
    const proposalIndex = String(index);
    if (!isRecord(proposal)) {
      throw new Error(`x_durable_memories[${proposalIndex}] must be an object.`);
    }

    const normalized = {
      category: normalizeRequiredText(proposal.category, `x_durable_memories[${proposalIndex}].category`),
      confidence: normalizeConfidence(proposal.confidence),
      content: normalizeRequiredText(proposal.content, `x_durable_memories[${proposalIndex}].content`),
      evidenceRefs: normalizeEvidenceRefs(proposal.evidence_refs),
      memoryKey: normalizeOptionalText(proposal.memory_key),
      project: normalizeOptionalText(proposal.project),
      sensitivity: normalizeEnumValue(proposal.sensitivity, {
        allowedValues: SENSITIVITY_VALUES,
        fallback: 'internal',
        fieldName: `x_durable_memories[${proposalIndex}].sensitivity`,
      }),
      source: normalizeOptionalText(proposal.source),
      sourceModel: proposal.source_model === null ? null : normalizeOptionalText(proposal.source_model),
      sourceTimestamp: normalizeOptionalTimestamp(
        proposal.source_timestamp,
        `x_durable_memories[${proposalIndex}].source_timestamp`,
      ),
      status: normalizeEnumValue(proposal.status, {
        allowedValues: MEMORY_STATUS_VALUES,
        fallback: 'active',
        fieldName: `x_durable_memories[${proposalIndex}].status`,
      }),
      tags: normalizeTags(proposal.tags),
      ttlDays: normalizeOptionalInteger(proposal.ttl_days, `x_durable_memories[${proposalIndex}].ttl_days`),
    };

    assertDurableMemoryProposalPolicy(normalized, index);
    return normalized;
  });
}

export function normalizeEvidenceRefs(value: unknown) {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error('evidenceRefs must be an array.');
  }

  const refs: (Record<string, unknown> | string)[] = [];

  for (const item of value) {
    if (typeof item === 'string') {
      const normalized = item.trim();
      if (normalized) {
        refs.push(normalized);
      }
      continue;
    }

    if (isRecord(item)) {
      refs.push(item);
      continue;
    }

    throw new Error('evidenceRefs entries must be strings or objects.');
  }

  return refs;
}

export function normalizeFailureDetails(value: unknown) {
  if (value === undefined || value === null) {
    return {};
  }

  if (isRecord(value)) {
    return value;
  }

  return {
    value: truncateFailureText(String(value), 2_000),
  };
}

export function normalizeFailureMessage(value: unknown) {
  if (value instanceof Error) {
    return truncateFailureText(value.message || UNKNOWN_INGESTION_FAILURE, 2_000);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return truncateFailureText(trimmed, 2_000);
    }

    return UNKNOWN_INGESTION_FAILURE;
  }

  if (value === undefined || value === null) {
    return UNKNOWN_INGESTION_FAILURE;
  }

  try {
    return truncateFailureText(JSON.stringify(value), 2_000);
  } catch {
    return truncateFailureText(String(value), 2_000);
  }
}

export function normalizeLimit(
  value: unknown,
  options: {
    fallback: number;
    max: number;
  },
) {
  const { fallback, max } = options;

  if (value === undefined || value === null) {
    return fallback;
  }

  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    throw new Error('Expected a numeric limit.');
  }

  return Math.max(1, Math.min(max, Math.floor(numericValue)));
}

export function normalizeMemoryInput(input: unknown) {
  const memoryInput = isRecord(input) ? input : {};
  const content = normalizeRequiredText(memoryInput.content, 'content');
  const detectedSource = normalizeOptionalText(memoryInput.detectedSource);
  const explicitMemoryType = normalizeMemoryType(memoryInput.memoryType ?? memoryInput.memory_type, 'memoryType');
  const normalizedMemory = {
    agent: normalizeOptionalText(memoryInput.agent),
    category: normalizeRequiredText(memoryInput.category, 'category'),
    confidence: normalizeConfidence(memoryInput.confidence),
    content,
    evidenceRefs: normalizeEvidenceRefs(memoryInput.evidenceRefs),
    expiresAt: normalizeOptionalTimestamp(memoryInput.expiresAt, 'expiresAt'),
    importance: normalizeOptionalImportance(memoryInput.importance),
    memoryKey: normalizeOptionalText(memoryInput.memoryKey),
    memoryType: explicitMemoryType,
    metadata: normalizeMetadata(memoryInput.metadata),
    model: normalizeOptionalText(memoryInput.model),
    orgId: normalizeOptionalText(memoryInput.orgId),
    project: normalizeProjectScope(memoryInput),
    repoId: normalizeOptionalText(memoryInput.repoId),
    repoSlug: normalizeOptionalText(memoryInput.repoSlug),
    sensitivity: normalizeEnumValue(memoryInput.sensitivity, {
      allowedValues: SENSITIVITY_VALUES,
      fallback: 'internal',
      fieldName: 'sensitivity',
    }),
    sessionId: normalizeOptionalText(memoryInput.sessionId),
    source: normalizeOptionalText(memoryInput.source) ?? detectedSource ?? 'manual',
    status: normalizeEnumValue(memoryInput.status, {
      allowedValues: MEMORY_STATUS_VALUES,
      fallback: 'active',
      fieldName: 'status',
    }),
    supersedesId: normalizeOptionalInteger(memoryInput.supersedesId, 'supersedesId'),
    tags: normalizeTags(memoryInput.tags),
    threadId: normalizeOptionalText(memoryInput.threadId),
    tool: normalizeOptionalText(memoryInput.tool),
    updatedBy: normalizeOptionalText(memoryInput.updatedBy),
    userId: normalizeOptionalText(memoryInput.userId),
  };

  if (isStrictMetadataCategory(normalizedMemory.category) && normalizedMemory.memoryKey === undefined) {
    normalizedMemory.memoryKey = createDurableMemoryKey({
      category: normalizedMemory.category,
      content: normalizedMemory.content,
      orgId: normalizedMemory.orgId,
      project: normalizedMemory.project,
      repoId: normalizedMemory.repoId,
      repoSlug: normalizedMemory.repoSlug,
      sensitivity: normalizedMemory.sensitivity,
      tags: normalizedMemory.tags,
    });
  }

  const policyResult = assertDurableMemoryInputPolicy(normalizedMemory);

  if (policyResult.warnings.length > 0) {
    normalizedMemory.metadata = {
      ...normalizedMemory.metadata,
      missingEvidenceRefs: true,
      policyWarnings: policyResult.warnings,
    };
  }

  return {
    ...normalizedMemory,
    dedupeHash: createMemoryDedupeHash({
      category: normalizedMemory.category,
      content: normalizedMemory.content,
      orgId: normalizedMemory.orgId,
      project: normalizedMemory.project,
      repoId: normalizedMemory.repoId,
      repoSlug: normalizedMemory.repoSlug,
      sensitivity: normalizedMemory.sensitivity,
      tags: normalizedMemory.tags,
    }),
    embedding: normalizeEmbedding(memoryInput.embedding),
    memoryType: normalizedMemory.memoryType ?? resolveMemoryTypeFromCategory(normalizedMemory.category),
  };
}

export function normalizeMetadata(value: unknown) {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('metadata must be an object.');
  }

  return value;
}

export function normalizeOptionalText(value: unknown) {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error('Expected a string value.');
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeOptionalTimestamp(value: unknown, fieldName: string) {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be an ISO timestamp string.`);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new Error(`${fieldName} must be a valid ISO timestamp.`);
  }

  return parsed.toISOString();
}

export function normalizePatchSnapshotId(value: unknown, deltaId: string) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return `${PATCH_SNAPSHOT_ID_PREFIX}:${deltaId}`;
}

/** Resolve only a repository's own basename; never map an unqualified project globally. */
export function normalizeProjectScope(input: { project?: unknown; repoId?: unknown; repoSlug?: unknown }) {
  const project = normalizeOptionalText(input.project);
  const repoSlug = normalizeOptionalText(input.repoSlug);
  const repoId = normalizeOptionalText(input.repoId);
  const repositories = [repoSlug, repoId].filter(
    (value): value is string => value !== undefined && /^[^/\s]+\/[^/\s]+$/u.test(value),
  );
  if (new Set(repositories).size > 1)
    throw new Error('Conflicting repository identities; supply one verified repository scope.');
  const repository = repositories[0];
  if (repository === undefined) return project;
  if (project === undefined || project === repository.split('/')[1]) return repository;
  return project;
}

export function normalizeRequiredText(value: unknown, fieldName: string) {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  return normalized;
}

export function normalizeRequiredTimestamp(value: unknown, fieldName: string) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty ISO timestamp string.`);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new Error(`${fieldName} must be a valid ISO timestamp.`);
  }

  return parsed.toISOString();
}

export function normalizeSnapshotCreatedAt(value: unknown, fallbackIso: string) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      try {
        return normalizeOptionalTimestamp(trimmed, 'memoryDelta.snapshot.value.created_at') ?? fallbackIso;
      } catch {
        return fallbackIso;
      }
    }
  }

  return fallbackIso;
}

export function normalizeWorkflowMetadata(value: unknown) {
  if (!isRecord(value)) {
    return undefined;
  }

  const system = normalizeOptionalText(value.system);
  const entityType = normalizeOptionalText(value.entity_type);
  const entityId = normalizeOptionalText(value.entity_id);

  if (system === undefined || entityType === undefined || entityId === undefined) {
    return undefined;
  }

  const metadata: Record<string, unknown> = {
    entity_id: entityId,
    entity_type: entityType,
    system,
  };

  const entityUrl = normalizeOptionalText(value.entity_url);
  if (entityUrl !== undefined) {
    metadata.entity_url = entityUrl;
  }

  const state = normalizeOptionalText(value.state);
  if (state !== undefined) {
    metadata.state = state;
  }

  const title = normalizeOptionalText(value.title);
  if (title !== undefined) {
    metadata.title = title;
  }

  for (const [key, fieldValue] of Object.entries(value)) {
    if (!key.startsWith('x_')) {
      continue;
    }
    metadata[key] = fieldValue;
  }

  return metadata;
}

/**
 * Lenient optional text reader: trims and returns undefined for non-strings or empty strings.
 * Suitable for ingestion/input reading where non-string values should be silently ignored.
 * Unlike normalizeOptionalText, this never throws.
 */
export function readOptionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function readRepoIdFromTenancy(value: unknown) {
  if (!isRecord(value) || typeof value.repo_id !== 'string') {
    return undefined;
  }

  const repoId = value.repo_id.trim();
  return repoId.length > 0 ? repoId : undefined;
}

/**
 * Lenient string array reader: returns a trimmed, non-empty string array from any input.
 * Non-array inputs return []. Non-string items and empty strings are filtered out.
 */
export function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed.length > 0) {
        result.push(trimmed);
      }
    }
  }
  return result;
}

export function selectContractPayload(input: unknown, key: string) {
  if (isRecord(input)) {
    const nestedPayload = input[key];
    if (isRecord(nestedPayload)) {
      return nestedPayload;
    }

    return input;
  }

  throw new Error(`Expected ${key} payload object.`);
}

/**
 * Truncates a string to maxChars with an ellipsis suffix.
 * If the string is within the limit, it is returned unchanged.
 */
export function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function normalizeConfidence(value: unknown) {
  if (value === undefined || value === null) {
    return 1;
  }

  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    throw new Error('confidence must be a number between 0 and 1');
  }

  if (numericValue < 0 || numericValue > 1) {
    throw new Error('confidence must be between 0 and 1');
  }

  return numericValue;
}

function normalizeEmbedding(value: unknown): null | number[] {
  if (Array.isArray(value)) {
    return value as number[];
  }
  return null;
}

function normalizeEnumValue(
  value: unknown,
  options: {
    allowedValues: readonly string[];
    fallback: string;
    fieldName: string;
  },
) {
  const { allowedValues, fallback, fieldName } = options;

  if (value === undefined || value === null) {
    return fallback;
  }

  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string.`);
  }

  const normalized = value.trim().toLowerCase();
  if (!Array.isArray(allowedValues) || !allowedValues.includes(normalized)) {
    throw new Error(
      `${fieldName} must be one of: ${Array.isArray(allowedValues) ? allowedValues.join(', ') : 'unknown (runtime constants unavailable)'}`,
    );
  }

  return normalized;
}

function normalizeOptionalImportance(value: unknown) {
  if (value === undefined || value === null) {
    return undefined;
  }

  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    throw new Error('importance must be a number between 0 and 1');
  }

  if (numericValue < 0 || numericValue > 1) {
    throw new Error('importance must be between 0 and 1');
  }

  return numericValue;
}

function normalizeOptionalInteger(value: unknown, fieldName: string) {
  if (value === undefined || value === null) {
    return undefined;
  }

  const numericValue = Number(value);
  if (!Number.isInteger(numericValue) || numericValue <= 0) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }

  return numericValue;
}

function normalizeTags(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const tags: string[] = [];

  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }

    const normalized = item.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    tags.push(normalized);
  }

  return tags.sort((left, right) => left.localeCompare(right));
}

function truncateFailureText(value: string, maxChars: number) {
  return truncateText(value, maxChars);
}
