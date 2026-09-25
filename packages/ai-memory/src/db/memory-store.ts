import { getCapabilities } from './capabilities.js';
import {
  computeTextSimilarity,
  DEFAULT_SIMILARITY_THRESHOLD,
  normalizeFingerprintText,
  SIMILARITY_CATEGORIES,
} from './hashing.js';
import { computeInitialImportance, detectReviewerDecisionImportance } from './importance.js';
import {
  buildMemoryInsertReturningSql,
  buildMemoryUpdateByIdSql,
  buildMemoryUpsertByMemoryKeySql,
} from './memory-sql.js';
import { normalizeMemoryInput, normalizeProjectScope } from './normalization.js';
import { toMemoryRecord, withWriteDisposition } from './records.js';
import { getSessionProjectWithClient } from './session-api.js';
import { isRecord } from './type-guards.js';
import { computeWriteCalibration, type WriteCalibration } from './write-calibration.js';

type CalibrationAwareMemoryInput = NormalizedMemoryInput & {
  calibratedConfidence: number;
  declaredConfidence: number;
};

interface DatabaseClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<DatabaseQueryResult<Row>>;
}

interface DatabaseQueryResult<Row> {
  rowCount?: null | number;
  rows: Row[];
}

interface MemoryIdRow extends Record<string, unknown> {
  id?: number | string;
}

type NormalizedMemoryInput = ReturnType<typeof normalizeMemoryInput>;

interface SimilarityCandidate extends Record<string, unknown> {
  content?: string;
  id?: number | string;
}

type StoredMemoryRecord = ReturnType<typeof toMemoryRecord> & {
  calibration: WriteCalibration;
  writeDisposition: WriteDisposition;
};

type WriteDisposition = 'dedupe_update' | 'inserted' | 'keyed_upsert' | 'similarity_supersede';

const SIMILARITY_CANDIDATES_SQL = `
  SELECT id, content
  FROM ai_memory_entries
  WHERE status = 'active'
    AND (expires_at IS NULL OR expires_at > NOW())
    AND lower(category) = lower($1)
    AND coalesce(lower(project), '') = $2
    AND coalesce(lower(org_id), '') = $3
    AND coalesce(lower(repo_id), '') = $4
    AND coalesce(lower(repo_slug), '') = $5
    AND coalesce(lower(sensitivity), '') = $6
  ORDER BY updated_at DESC
  LIMIT 50
`;

export async function storeMemoryWithClient(client: DatabaseClient, input: unknown): Promise<StoredMemoryRecord> {
  const sourceInput = remapApprovedReviewerDecisionToAuditLogInput(input);
  let memory = normalizeMemoryInput(sourceInput);
  if (memory.sessionId !== undefined && !memory.project?.includes('/')) {
    const project = normalizeProjectScope({
      project: memory.project,
      repoId: await getSessionProjectWithClient(client, memory.sessionId),
    });
    if (project !== memory.project && isRecord(sourceInput)) memory = normalizeMemoryInput({ ...sourceInput, project });
  }
  const calibration = await computeWriteCalibration(client, memory);
  const calibratedMemory: CalibrationAwareMemoryInput = {
    ...memory,
    calibratedConfidence: calibration.calibratedConfidence,
    confidence: calibration.calibratedConfidence,
    declaredConfidence: calibration.declaredConfidence,
  };
  const memoryWithImportance = {
    ...calibratedMemory,
    importance:
      typeof calibratedMemory.importance === 'number'
        ? calibratedMemory.importance
        : (detectReviewerDecisionImportance({
            category: calibratedMemory.category,
            source: calibratedMemory.source,
            tags: calibratedMemory.tags,
          }) ??
          computeInitialImportance({
            category: calibratedMemory.category,
            confidence: calibratedMemory.confidence,
          })),
  };
  const hasEmbeddingColumn = getCapabilities().hasEmbeddingColumn;
  const memoryInsertReturningSql = buildMemoryInsertReturningSql(hasEmbeddingColumn);
  const memoryUpdateByIdSql = buildMemoryUpdateByIdSql(hasEmbeddingColumn);
  const memoryUpsertByMemoryKeySql = buildMemoryUpsertByMemoryKeySql(hasEmbeddingColumn);

  if (memoryWithImportance.memoryKey !== undefined) {
    const result = await client.query(
      memoryUpsertByMemoryKeySql,
      buildMemoryWriteParams(memoryWithImportance, hasEmbeddingColumn),
    );
    return withCalibration(
      withWriteDisposition(toMemoryRecord(result.rows[0]), 'keyed_upsert'),
      calibration,
    ) as StoredMemoryRecord;
  }

  const similarityScope = buildSimilarityScopeKey(memoryWithImportance);
  if (similarityScope !== undefined) {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [similarityScope]);

    const similarMatch = await findSimilarMemory(client, memoryWithImportance);
    if (similarMatch !== undefined) {
      const paramsWithSupersede = buildMemoryWriteParams(
        {
          ...memoryWithImportance,
          supersedesId: similarMatch,
        },
        hasEmbeddingColumn,
      );
      const insertResult = await client.query(memoryInsertReturningSql, paramsWithSupersede);

      await client.query(`UPDATE ai_memory_entries SET status = 'superseded', updated_at = NOW() WHERE id = $1`, [
        similarMatch,
      ]);

      return withCalibration(
        withWriteDisposition(toMemoryRecord(insertResult.rows[0]), 'similarity_supersede'),
        calibration,
      ) as StoredMemoryRecord;
    }
  }

  if (memoryWithImportance.dedupeHash.length === 0) {
    const result = await client.query(
      memoryInsertReturningSql,
      buildMemoryWriteParams(memoryWithImportance, hasEmbeddingColumn),
    );
    return withCalibration(
      withWriteDisposition(toMemoryRecord(result.rows[0]), 'inserted'),
      calibration,
    ) as StoredMemoryRecord;
  }

  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    `ai-memory-dedupe:${memoryWithImportance.dedupeHash}`,
  ]);

  const existingResult = await client.query<MemoryIdRow>(
    `
      SELECT id
      FROM ai_memory_entries
      WHERE memory_key IS NULL AND dedupe_hash = $1
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
      FOR UPDATE
    `,
    [memoryWithImportance.dedupeHash],
  );

  const existingMemoryIdRaw = existingResult.rows[0]?.id;
  const existingMemoryId = Number(existingMemoryIdRaw);
  if (Number.isInteger(existingMemoryId) && existingMemoryId > 0) {
    const result = await client.query(memoryUpdateByIdSql, [
      ...buildMemoryWriteParams(memoryWithImportance, hasEmbeddingColumn),
      existingMemoryId,
    ]);
    return withCalibration(
      withWriteDisposition(toMemoryRecord(result.rows[0]), 'dedupe_update'),
      calibration,
    ) as StoredMemoryRecord;
  }

  const result = await client.query(
    memoryInsertReturningSql,
    buildMemoryWriteParams(memoryWithImportance, hasEmbeddingColumn),
  );
  return withCalibration(
    withWriteDisposition(toMemoryRecord(result.rows[0]), 'inserted'),
    calibration,
  ) as StoredMemoryRecord;
}

function buildMemoryWriteParams(memory: CalibrationAwareMemoryInput, hasEmbeddingColumn: boolean): unknown[] {
  const params: unknown[] = [
    memory.content,
    memory.project,
    memory.category,
    memory.memoryType,
    memory.tags,
    memory.source,
    memory.confidence,
    memory.declaredConfidence,
    memory.calibratedConfidence,
    memory.importance,
    memory.memoryKey,
    memory.dedupeHash,
    memory.status,
    memory.supersedesId,
    memory.agent,
    memory.model,
    memory.tool,
    memory.sessionId,
    memory.threadId,
    memory.orgId,
    memory.repoId,
    memory.repoSlug,
    memory.userId,
    memory.sensitivity,
    memory.expiresAt,
    JSON.stringify(memory.evidenceRefs),
    JSON.stringify(memory.metadata),
    memory.updatedBy,
  ];

  if (hasEmbeddingColumn) {
    params.push(memory.embedding !== null ? JSON.stringify(memory.embedding) : null);
  }

  return params;
}

function buildSimilarityCandidateParams(memory: NormalizedMemoryInput): unknown[] {
  return [
    memory.category,
    normalizeFingerprintText(memory.project),
    normalizeFingerprintText(memory.orgId),
    normalizeFingerprintText(memory.repoId),
    normalizeFingerprintText(memory.repoSlug),
    normalizeFingerprintText(memory.sensitivity),
  ];
}

function buildSimilarityScopeKey(memory: NormalizedMemoryInput): string | undefined {
  if (!SIMILARITY_CATEGORIES.has(memory.category.toLowerCase())) {
    return undefined;
  }

  return `ai-memory-similarity:${normalizeFingerprintText(memory.category)}:${normalizeFingerprintText(memory.project)}:${normalizeFingerprintText(memory.orgId)}:${normalizeFingerprintText(memory.repoSlug)}`;
}

async function findSimilarMemory(client: DatabaseClient, memory: NormalizedMemoryInput): Promise<number | undefined> {
  const candidatesResult = await client.query<SimilarityCandidate>(
    SIMILARITY_CANDIDATES_SQL,
    buildSimilarityCandidateParams(memory),
  );

  let bestId: number | undefined;
  let bestScore = 0;

  for (const row of candidatesResult.rows) {
    const candidateContent = typeof row.content === 'string' ? row.content : '';
    if (candidateContent.length === 0) {
      continue;
    }

    const score = computeTextSimilarity(memory.content, candidateContent);
    if (score >= DEFAULT_SIMILARITY_THRESHOLD && score > bestScore) {
      const candidateId = Number(row.id);
      if (Number.isInteger(candidateId) && candidateId > 0) {
        bestId = candidateId;
        bestScore = score;
      }
    }
  }

  return bestId;
}

function normalizeTagSet(value: unknown): Set<string> {
  if (!Array.isArray(value)) {
    return new Set<string>();
  }

  return new Set(
    value
      .filter((item): item is string => typeof item === 'string')
      .map(item => normalizeText(item))
      .filter(item => item.length > 0),
  );
}

function normalizeText(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().toLowerCase();
}

function remapApprovedReviewerDecisionToAuditLogInput(input: unknown): unknown {
  if (!isRecord(input)) {
    return input;
  }

  const category = normalizeText(input.category);
  if (category !== 'decision') {
    return input;
  }

  const tags = normalizeTagSet(input.tags);
  if (!tags.has('review') || !tags.has('approved')) {
    return input;
  }
  if (tags.has('request-changes') || tags.has('changes-requested')) {
    return input;
  }

  const metadata = isRecord(input.metadata) ? input.metadata : {};

  return {
    ...input,
    category: 'audit-log',
    metadata: {
      ...metadata,
      original_category: 'decision',
      reclassified_reason: 'approved-review-decision-to-audit-log',
    },
  };
}

function withCalibration<T extends Record<string, unknown>>(memory: T, calibration: WriteCalibration) {
  return {
    ...memory,
    calibration,
  };
}
