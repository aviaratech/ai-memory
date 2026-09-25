import type { DbClient } from './pool.js';

import { resolveTimeoutPolicy } from '../timeout-policy.js';
import { getCapabilities } from './capabilities.js';
import { getEmbedding } from './embeddings.js';
import { insertMemoryEventWithClient } from './failure-events.js';
import {
  buildBaseImportanceSqlExpression,
  buildDecayedImportanceSqlExpression,
  IMPORTANCE_ACCESS_BOOST_INCREMENT,
  IMPORTANCE_ACCESS_BOOST_THROTTLE_HOURS,
  resolveDecayHalfLifeDays,
} from './importance.js';
import {
  buildMemorySearchKeywordHintSql,
  buildMemorySearchKeywordMatchSql,
  buildMemorySearchOrRankSql,
  buildMemorySearchReferenceMatchSql,
} from './memory-sql.js';
import { storeMemoryWithClient } from './memory-store.js';
import { normalizeMemoryType } from './memory-types.js';
import { normalizeBoolean, normalizeLimit, normalizeOptionalText } from './normalization.js';
import {
  buildSearchQueryTokens,
  buildSearchReferencePattern,
  normalizeSearchReferenceText,
  rerankHybridSearchRows,
  resolveSearchCandidateLimits,
} from './query-helpers.js';
import { runBoundedQuery } from './query-runner.js';
import { toMemoryRecord } from './records.js';
import { applyReadReversalPenalties } from './retrieval-penalty.js';
import { pool, SEARCH_VECTOR_SQL } from './runtime.js';
import { TAXONOMY_TIERS } from './taxonomy.js';
import { isRecord } from './type-guards.js';

type ContestedResolutionAction = 'keep_both' | 'keep_first' | 'keep_second' | 'merge';
interface ContestedResolvedEventInput {
  action: string;
  client: Parameters<typeof insertMemoryEventWithClient>[0];
  memoryId: number;
  memoryIdA: number;
  memoryIdB: number;
  mergedMemoryId?: number | undefined;
}

const CONTESTED_STATUS = 'contested';
const DEFAULT_CONTESTED_LIST_LIMIT = 100;
const MAX_MEMORY_GET_IDS = 100;
const MAX_CONTESTED_LIST_LIMIT = 500;

/**
 * Builds the SQL CASE expression used to sort recall results by taxonomy tier.
 * Actionable = 0 (highest), low-signal = 2 (lowest), everything else = 1 (contextual).
 * Unknown/missing categories default to contextual, matching the taxonomy contract.
 */
export function buildRecallTierOrderSql() {
  const actionableCategories = TAXONOMY_TIERS.actionable.categories.map(c => `'${c}'`).join(', ');
  const lowSignalCategories = TAXONOMY_TIERS['low-signal'].categories.map(c => `'${c}'`).join(', ');

  return `CASE
        WHEN lower(coalesce(category, '')) IN (${actionableCategories}) THEN 0
        WHEN lower(coalesce(category, '')) IN (${lowSignalCategories}) THEN 2
        ELSE 1
      END`;
}

/**
 * Builds the SQL and parameters for the deterministic token fallback query.
 * Exported for testability — the actual fallback execution is in searchMemoriesTokenFallback.
 *
 * Uses index-compatible predicates:
 * - `content ILIKE` uses the trigram GIN index (gin_trgm_ops) when available
 * - `category ILIKE` on a small column (fast even without dedicated index)
 * - `tags @> ARRAY[]::text[]` uses the tags GIN index for exact element containment
 */
export function buildTokenFallbackQuery(input: {
  category: string | undefined;
  includeInactive: boolean;
  limit: number;
  memoryType: string | undefined;
  project: string | undefined;
  sessionId?: string | undefined;
  tokens: string[];
}) {
  const { category, includeInactive, limit, memoryType, project, sessionId, tokens } = input;
  const decayedImportanceSql = buildDecayedImportanceSqlExpression(resolveDecayHalfLifeDays());
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (!includeInactive) {
    conditions.push(`status = 'active'`);
    conditions.push(`(expires_at IS NULL OR expires_at > NOW())`);
  }

  if (project !== undefined) {
    params.push(project);
    conditions.push(`project = $${String(params.length)}`);
  }

  if (category !== undefined) {
    params.push(category);
    conditions.push(`category = $${String(params.length)}`);
  }

  if (memoryType !== undefined) {
    params.push(memoryType);
    conditions.push(`memory_type = $${String(params.length)}`);
  }

  if (sessionId !== undefined) {
    params.push(sessionId);
    conditions.push(`session_id = $${String(params.length)}`);
  }

  const tokenConditions = tokens.map(token => {
    params.push(`%${token}%`);
    const ilikeParam = `$${String(params.length)}`;
    params.push(token);
    const exactParam = `$${String(params.length)}`;
    return `(
      content ILIKE ${ilikeParam}
      OR category ILIKE ${ilikeParam}
      OR tags @> ARRAY[${exactParam}]::text[]
    )`;
  });
  conditions.push(`(${tokenConditions.join(' OR ')})`);

  const candidateLimit = Math.min(limit * 3, 80);
  params.push(candidateLimit);
  const limitParam = `$${String(params.length)}`;

  const sql = `
    SELECT *,
      0::double precision AS semantic_relevance,
      0::double precision AS or_semantic_relevance,
      0 AS keyword_hint,
      ${decayedImportanceSql} AS decayed_importance
    FROM ai_memory_entries
    WHERE ${conditions.join(' AND ')}
    ORDER BY confidence DESC, created_at DESC
    LIMIT ${limitParam}
  `;

  return { params, sql };
}

export async function countContestedMemories(input: unknown = {}) {
  const request = isRecord(input) ? input : {};
  const project = normalizeOptionalText(request.project);

  const conditions: string[] = [`status = '${CONTESTED_STATUS}'`];
  const params: unknown[] = [];

  if (project !== undefined) {
    params.push(project);
    conditions.push(`project = $${String(params.length)}`);
  }

  const sql = `SELECT COUNT(*)::int AS count FROM ai_memory_entries WHERE ${conditions.join(' AND ')}`;
  const result = await runDbReadQuery({
    operation: 'count_contested_memories',
    task: client => client.query(sql, params),
  });
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return typeof row?.count === 'number' ? row.count : 0;
}

export async function getMemoryEntries(input: unknown = {}) {
  const request = isRecord(input) ? input : {};
  const includeInactive = normalizeBoolean(request.includeInactive, true);
  const project = normalizeOptionalText(request.project);
  const ids = normalizeMemoryLookupIds(request);

  const conditions: string[] = ['id = ANY($1::bigint[])'];
  const params: unknown[] = [ids];

  if (!includeInactive) {
    conditions.push(`status IN ('active', 'contested')`);
    conditions.push(`(expires_at IS NULL OR expires_at > NOW())`);
  }

  if (project !== undefined) {
    params.push(project);
    conditions.push(`project = $${String(params.length)}`);
  }

  const sql = `
    SELECT *
    FROM ai_memory_entries
    WHERE ${conditions.join(' AND ')}
    ORDER BY array_position($1::bigint[], id)
  `;

  const result = await runDbReadQuery({
    operation: 'get_memory_entries',
    task: client => client.query(sql, params),
  });
  return result.rows.map(row => toMemoryRecord(row));
}

export async function listContestedMemories(input: unknown = {}) {
  const request = isRecord(input) ? input : {};
  const project = normalizeOptionalText(request.project);
  const limit = normalizeLimit(request.limit, {
    fallback: DEFAULT_CONTESTED_LIST_LIMIT,
    max: MAX_CONTESTED_LIST_LIMIT,
  });

  const conditions: string[] = [`status = '${CONTESTED_STATUS}'`];
  const params: unknown[] = [];

  if (project !== undefined) {
    params.push(project);
    conditions.push(`project = $${String(params.length)}`);
  }

  params.push(limit);
  const limitParam = `$${String(params.length)}`;

  const sql = `
    SELECT *
    FROM ai_memory_entries
    WHERE ${conditions.join(' AND ')}
    ORDER BY updated_at DESC, id DESC
    LIMIT ${limitParam}
  `;

  const result = await runDbReadQuery({
    operation: 'list_contested_memories',
    task: client => client.query(sql, params),
  });
  return result.rows.map(row => toMemoryRecord(row));
}

export async function recallMemories(input: unknown = {}) {
  const request = isRecord(input) ? input : {};
  const project = normalizeOptionalText(request.project);
  const category = normalizeOptionalText(request.category);
  const memoryType = normalizeMemoryType(request.memoryType ?? request.memory_type, 'memoryType');
  const includeInactive = normalizeBoolean(request.includeInactive, false);
  const limit = normalizeLimit(request.limit, { fallback: 10, max: 50 });
  const candidateLimit = Math.min(limit * 3, 150);
  const sinceDays = normalizeLimit(request.sinceDays, {
    fallback: 90,
    max: 3650,
  });
  const decayedImportanceSql = buildDecayedImportanceSqlExpression(resolveDecayHalfLifeDays());

  const conditions: string[] = ['created_at >= NOW() - make_interval(days => $1::int)'];
  const params: unknown[] = [sinceDays];

  if (!includeInactive) {
    conditions.push(`status IN ('active', 'contested')`);
    conditions.push(`(expires_at IS NULL OR expires_at > NOW())`);
  }

  if (project !== undefined) {
    params.push(project);
    conditions.push(`project = $${String(params.length)}`);
  }

  if (category !== undefined) {
    params.push(category);
    conditions.push(`category = $${String(params.length)}`);
  }

  if (memoryType !== undefined) {
    params.push(memoryType);
    conditions.push(`memory_type = $${String(params.length)}`);
  }

  params.push(candidateLimit);
  const limitParam = `$${String(params.length)}`;

  const sql = `
    SELECT *,
      ${decayedImportanceSql} AS decayed_importance
    FROM ai_memory_entries
    WHERE ${conditions.join(' AND ')}
    ORDER BY
      ${buildRecallTierOrderSql()} ASC,
      CASE WHEN status = 'contested' THEN 1 ELSE 0 END ASC,
      decayed_importance DESC,
      confidence DESC,
      created_at DESC
    LIMIT ${limitParam}
  `;

  const result = await runDbReadQuery({
    operation: 'recall_memories',
    task: client => client.query(sql, params),
  });
  const recallRows = result.rows.filter(isRecord);
  const penalizedRows = await runDbReadQuery({
    operation: 'recall_memories.reversal_penalty',
    task: client => applyReadReversalPenalties(client, recallRows),
  });
  const rerankedRows = rerankRecallRows(penalizedRows, limit);
  scheduleImportanceBoost(rerankedRows);
  return rerankedRows.map(row => toMemoryRecord(row));
}

export async function resolveContestedMemory(input: unknown) {
  const request = isRecord(input) ? input : {};
  const action = request.action;
  const memoryIdA = request.memoryIdA;
  const memoryIdB = request.memoryIdB;
  const mergedContent = request.mergedContent;

  if (typeof action !== 'string' || !['keep_both', 'keep_first', 'keep_second', 'merge'].includes(action)) {
    throw new Error('action must be one of: keep_first, keep_second, keep_both, merge');
  }
  if (typeof memoryIdA !== 'number' || !Number.isInteger(memoryIdA) || memoryIdA <= 0) {
    throw new Error('memoryIdA must be a positive integer');
  }
  if (typeof memoryIdB !== 'number' || !Number.isInteger(memoryIdB) || memoryIdB <= 0) {
    throw new Error('memoryIdB must be a positive integer');
  }
  if (memoryIdA === memoryIdB) {
    throw new Error('memoryIdA and memoryIdB must reference different memories');
  }
  if (action === 'merge' && (typeof mergedContent !== 'string' || mergedContent.trim().length === 0)) {
    throw new Error('mergedContent is required when action is merge');
  }

  return await runDbWriteQuery({
    operation: 'resolve_contested_memory',
    task: client =>
      resolveContestedMemoryWithClient(client, {
        action: action as ContestedResolutionAction,
        memoryIdA,
        memoryIdB,
        mergedContent: typeof mergedContent === 'string' ? mergedContent.trim() : undefined,
      }),
  });
}

export async function searchMemories(input: unknown) {
  const request = isRecord(input) ? input : {};
  const queryText = normalizeOptionalText(request.query);
  if (queryText === undefined) {
    throw new Error('query must be a non-empty string');
  }

  const project = normalizeOptionalText(request.project);
  const category = normalizeOptionalText(request.category);
  const activeGoal = normalizeOptionalText(request.activeGoal);
  const memoryType = normalizeMemoryType(request.memoryType ?? request.memory_type, 'memoryType');
  const sessionId = normalizeOptionalText(request.sessionId ?? request.session_id);
  const includeEmbedding = normalizeBoolean(request.includeEmbedding, true);
  const includeInactive = normalizeBoolean(request.includeInactive, false);
  const limit = normalizeLimit(request.limit, { fallback: 8, max: 25 });
  const defaultHalfLifeDays = resolveDecayHalfLifeDays();
  const decayedImportanceSql = buildDecayedImportanceSqlExpression(defaultHalfLifeDays);
  const { combinedCandidateLimit, keywordCandidateLimit, semanticCandidateLimit, vectorCandidateLimit } =
    resolveSearchCandidateLimits(limit);
  const goalText = activeGoal;

  const hasEmbeddingColumn = getCapabilities().hasEmbeddingColumn;
  // Compute query embedding before acquiring DB connection, but only when search can use it.
  const queryEmbedding =
    includeEmbedding && hasEmbeddingColumn ? await getEmbedding(queryText, { operation: 'search_memories' }) : null;

  const baseConditions: string[] = [];
  const params: unknown[] = [];

  params.push(queryText);
  const queryParam = `$${String(params.length)}`;
  const textQueryParams = [queryParam];
  const normalizedReferenceText = normalizeSearchReferenceText(queryText);
  if (normalizedReferenceText !== queryText) {
    params.push(normalizedReferenceText);
    textQueryParams.push(`$${String(params.length)}`);
  }
  const referencePattern = buildSearchReferencePattern(queryText, activeGoal);
  let referenceMatchSql = 'FALSE';
  if (referencePattern !== undefined) {
    params.push(referencePattern);
    referenceMatchSql = buildMemorySearchReferenceMatchSql(`$${String(params.length)}`);
  }
  const keywordHintSql = textQueryParams.map(buildMemorySearchKeywordHintSql).join(' OR ');
  const orRanks = textQueryParams.map(buildMemorySearchOrRankSql);
  const orRankSql = `GREATEST(${orRanks.join(', ')})`;
  // Keep original joined lexemes eligible while adding normalized reference terms.
  const textSearchCondition = `(${textQueryParams
    .map(
      param =>
        `(${SEARCH_VECTOR_SQL} @@ websearch_to_tsquery('english', ${param}) OR ${buildMemorySearchKeywordMatchSql(param)})`,
    )
    .join(' OR ')})`;

  if (!includeInactive) {
    baseConditions.push(`status IN ('active', 'contested')`);
    baseConditions.push(`(expires_at IS NULL OR expires_at > NOW())`);
  }

  if (project !== undefined) {
    params.push(project);
    baseConditions.push(`project = $${String(params.length)}`);
  }

  if (category !== undefined) {
    params.push(category);
    baseConditions.push(`category = $${String(params.length)}`);
  }

  if (memoryType !== undefined) {
    params.push(memoryType);
    baseConditions.push(`memory_type = $${String(params.length)}`);
  }

  if (sessionId !== undefined) {
    params.push(sessionId);
    baseConditions.push(`session_id = $${String(params.length)}`);
  }

  const filteredCandidateConditions = [textSearchCondition, ...baseConditions];

  params.push(semanticCandidateLimit);
  const semanticCandidateLimitParam = `$${String(params.length)}`;

  params.push(keywordCandidateLimit);
  const keywordCandidateLimitParam = `$${String(params.length)}`;

  // Vector CTE — only added when query embedding is available and embedding column exists
  let vectorCandidateCte = '';
  let vectorCandidateUnion = '';

  if (queryEmbedding !== null && hasEmbeddingColumn) {
    params.push(JSON.stringify(queryEmbedding));
    const embeddingParam = `$${String(params.length)}`;
    params.push(vectorCandidateLimit);
    const vectorCandidateLimitParam = `$${String(params.length)}`;

    const vectorBaseWhere =
      baseConditions.length > 0 ? `embedding IS NOT NULL AND ${baseConditions.join(' AND ')}` : `embedding IS NOT NULL`;

    vectorCandidateCte = `
    vector_candidates AS (
      SELECT
        id,
        created_at,
        0::double precision AS semantic_relevance,
        0::double precision AS or_semantic_relevance,
        0 AS keyword_hint,
        0 AS reference_hint,
        ${decayedImportanceSql} AS decayed_importance,
        1 - (embedding <=> ${embeddingParam}::vector) AS vector_similarity
      FROM ai_memory_entries
      WHERE ${vectorBaseWhere}
      ORDER BY embedding <=> ${embeddingParam}::vector
      LIMIT ${vectorCandidateLimitParam}
    ),`;

    vectorCandidateUnion = `
        UNION ALL
        SELECT id, created_at, semantic_relevance, or_semantic_relevance, keyword_hint, reference_hint, decayed_importance, vector_similarity
        FROM vector_candidates`;
  }

  params.push(combinedCandidateLimit);
  const combinedCandidateLimitParam = `$${String(params.length)}`;

  const sql = `
    WITH filtered_candidates AS (
      SELECT
        id,
        created_at,
        ts_rank_cd(${SEARCH_VECTOR_SQL}, websearch_to_tsquery('english', ${queryParam})) AS semantic_relevance,
        ${orRankSql} AS or_semantic_relevance,
        CASE WHEN ${keywordHintSql} THEN 1 ELSE 0 END AS keyword_hint,
        CASE WHEN ${referenceMatchSql} THEN 1 ELSE 0 END AS reference_hint,
        ${decayedImportanceSql} AS decayed_importance,
        0::double precision AS vector_similarity
      FROM ai_memory_entries
      WHERE ${filteredCandidateConditions.join(' AND ')}
    ),
    semantic_candidates AS (
      SELECT id, created_at, semantic_relevance, or_semantic_relevance, keyword_hint, reference_hint, decayed_importance, vector_similarity
      FROM filtered_candidates
      ORDER BY reference_hint DESC, GREATEST(semantic_relevance, or_semantic_relevance * 0.8) DESC, created_at DESC
      LIMIT ${semanticCandidateLimitParam}
    ),
    keyword_candidates AS (
      SELECT id, created_at, semantic_relevance, or_semantic_relevance, keyword_hint, reference_hint, decayed_importance, vector_similarity
      FROM filtered_candidates
      WHERE keyword_hint = 1 OR reference_hint = 1
      ORDER BY reference_hint DESC, created_at DESC
      LIMIT ${keywordCandidateLimitParam}
    ),${vectorCandidateCte}
    combined_candidates AS (
      SELECT id, created_at, semantic_relevance, or_semantic_relevance, keyword_hint, reference_hint, decayed_importance, vector_similarity
      FROM semantic_candidates
      UNION ALL
      SELECT id, created_at, semantic_relevance, or_semantic_relevance, keyword_hint, reference_hint, decayed_importance, vector_similarity
      FROM keyword_candidates${vectorCandidateUnion}
    ),
    deduped_candidates AS (
      SELECT
        id,
        created_at,
        semantic_relevance,
        or_semantic_relevance,
        keyword_hint,
        reference_hint,
        decayed_importance,
        vector_similarity,
        MAX(vector_similarity) OVER (PARTITION BY id) AS max_vector_similarity,
        ROW_NUMBER() OVER (PARTITION BY id ORDER BY reference_hint DESC, semantic_relevance DESC, or_semantic_relevance DESC, keyword_hint DESC, created_at DESC) AS dedupe_rank
      FROM combined_candidates
    ),
    limited_candidates AS (
      SELECT
        id,
        created_at,
        semantic_relevance,
        or_semantic_relevance,
        keyword_hint,
        reference_hint,
        decayed_importance,
        max_vector_similarity
      FROM deduped_candidates
      WHERE dedupe_rank = 1
      ORDER BY reference_hint DESC, GREATEST(semantic_relevance, or_semantic_relevance * 0.8) DESC, keyword_hint DESC, created_at DESC
      LIMIT ${combinedCandidateLimitParam}
    )
    SELECT
      entries.*,
      candidates.semantic_relevance,
      candidates.or_semantic_relevance,
      candidates.keyword_hint,
      candidates.reference_hint,
      candidates.decayed_importance,
      candidates.max_vector_similarity
    FROM limited_candidates AS candidates
    JOIN ai_memory_entries AS entries ON entries.id = candidates.id
    ORDER BY candidates.reference_hint DESC, GREATEST(candidates.semantic_relevance, candidates.or_semantic_relevance * 0.8) DESC,
      candidates.keyword_hint DESC,
      candidates.created_at DESC
  `;

  const result = await runDbReadQuery({
    operation: 'search_memories',
    task: client => client.query(sql, params),
  });
  const searchRows = result.rows.filter(isRecord);
  const penalizedRows = await runDbReadQuery({
    operation: 'search_memories.reversal_penalty',
    task: client => applyReadReversalPenalties(client, searchRows),
  });
  const rerankedRows = rerankHybridSearchRows(penalizedRows, {
    goalText,
    limit,
    queryText,
  });

  // Deterministic fallback: if hybrid pipeline returns zero results, use ILIKE-based token matching
  if (rerankedRows.length === 0) {
    const fallbackRows = await searchMemoriesTokenFallback({
      category,
      goalText,
      includeInactive,
      limit,
      memoryType,
      project,
      queryText,
      sessionId,
    });
    scheduleImportanceBoost(fallbackRows);
    return fallbackRows.map(row => toMemoryRecord(row));
  }

  scheduleImportanceBoost(rerankedRows);
  return rerankedRows.map(row => toMemoryRecord(row));
}

export async function searchTemporalMemories(input: unknown) {
  const request = isRecord(input) ? input : {};
  const queryText = normalizeOptionalText(request.query);
  if (queryText === undefined) {
    throw new Error('query must be a non-empty string');
  }

  const project = normalizeOptionalText(request.project);
  const memoryType = normalizeMemoryType(request.memoryType ?? request.memory_type, 'memoryType');
  const includeInactive = normalizeBoolean(request.includeInactive, false);
  const limit = normalizeLimit(request.limit, { fallback: 5, max: 5 });

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (!includeInactive) {
    conditions.push(`status IN ('active', 'contested')`);
    conditions.push(`(expires_at IS NULL OR expires_at > NOW())`);
  }

  if (project !== undefined) {
    params.push(project);
    conditions.push(`project = $${String(params.length)}`);
  }

  if (memoryType !== undefined) {
    params.push(memoryType);
    conditions.push(`memory_type = $${String(params.length)}`);
  }

  // Temporal signal: contested OR supersession-linked (active records that participate in supersession chains)
  const temporalCondition = `(status = 'contested' OR supersedes_id IS NOT NULL OR id IN (SELECT supersedes_id FROM ai_memory_entries WHERE supersedes_id IS NOT NULL))`;
  conditions.push(temporalCondition);

  // Text relevance filter: match task tokens against content
  params.push(queryText);
  const queryParam = `$${String(params.length)}`;
  const textFilter = `(${SEARCH_VECTOR_SQL} @@ websearch_to_tsquery('english', ${queryParam}) OR content ILIKE '%' || ${queryParam} || '%')`;
  conditions.push(textFilter);

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  params.push(limit);
  const limitParam = `$${String(params.length)}`;

  const sql = `
    SELECT *,
      CASE
        WHEN status = 'contested' THEN 3
        WHEN supersedes_id IS NOT NULL THEN 2
        ELSE 1
      END AS temporal_priority
    FROM ai_memory_entries
    ${whereClause}
    ORDER BY temporal_priority DESC, updated_at DESC, created_at DESC
    LIMIT ${limitParam}
  `;

  const result = await runDbReadQuery({
    operation: 'search_temporal_memories',
    task: client => client.query(sql, params),
  });
  return result.rows.map(row => toMemoryRecord(row));
}

export async function storeMemory(input: unknown) {
  const request = isRecord(input) ? input : {};
  const rawContent = typeof request.content === 'string' ? request.content.trim() : '';
  const rawCategory = typeof request.category === 'string' ? request.category.trim() : '';
  const embedding = await getEmbedding(rawContent, { category: rawCategory, operation: 'store_memory' });
  const enrichedInput = { ...request, embedding };

  return runDbWriteQuery({
    operation: 'store_memory',
    task: client => storeMemoryWithAuditEvent(client, enrichedInput),
  });
}

export async function storeMemoryWithAuditEvent(client: Parameters<typeof storeMemoryWithClient>[0], input: unknown) {
  const memory = await storeMemoryWithClient(client, input);
  await insertMemoryEventWithClient(client, {
    actor: typeof memory.agent === 'string' ? memory.agent : undefined,
    eventType: 'stored_via_memory_store',
    memoryId: memory.id,
    payloadJson: {
      session_id: memory.sessionId,
      source: memory.source,
      write_disposition: memory.writeDisposition,
    },
  });
  return memory;
}

function assertContestedResolutionPreconditions(input: {
  memoryA: Record<string, unknown>;
  memoryB: Record<string, unknown>;
  memoryIdA: number;
  memoryIdB: number;
}) {
  const statusA = readMemoryStatus(input.memoryA);
  const statusB = readMemoryStatus(input.memoryB);
  if (statusA === CONTESTED_STATUS && statusB === CONTESTED_STATUS) {
    return;
  }

  throw new Error(
    `memoryIdA (${String(input.memoryIdA)}) and memoryIdB (${String(input.memoryIdB)}) must both be in contested status before resolution; got ${statusA} and ${statusB}`,
  );
}

function assertExpectedRowCount(input: {
  action: ContestedResolutionAction;
  actual: null | number | undefined;
  expected: number;
  operation: string;
}) {
  if (input.actual === input.expected) {
    return;
  }

  throw new Error(
    `Contested resolution (${input.action}) failed to ${input.operation}: expected ${String(input.expected)} row(s), got ${String(input.actual ?? 0)}. The memories may have been resolved concurrently; refresh and retry.`,
  );
}

async function boostImportanceForAccessedMemories(memoryIds: number[]) {
  const baseImportanceSql = buildBaseImportanceSqlExpression();
  const sql = `
      UPDATE ai_memory_entries
      SET
        importance = LEAST(1.0, GREATEST(0.0, (${baseImportanceSql}) + $2::double precision)),
        updated_at = NOW()
      WHERE id = ANY($1::bigint[])
        AND updated_at <= NOW() - make_interval(hours => $3::int)
    `;
  const params = [memoryIds, IMPORTANCE_ACCESS_BOOST_INCREMENT, IMPORTANCE_ACCESS_BOOST_THROTTLE_HOURS];
  await runDbWriteQuery({
    operation: 'importance_boost',
    task: client => client.query(sql, params),
  });
}

function extractBoostableMemoryIds(rows: Record<string, unknown>[]) {
  const ids = new Set<number>();
  for (const row of rows) {
    const id = toPositiveInt(row.id);
    if (id !== undefined) {
      ids.add(id);
    }
  }
  return Array.from(ids);
}

function getReadReversalPenalty(row: Record<string, unknown>) {
  const parsed = Number(row.reversal_penalty);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(0.5, Math.min(1, parsed)) : 1;
}

function getRecallTierOrder(row: Record<string, unknown>): number {
  const category = typeof row.category === 'string' ? row.category.toLowerCase() : '';
  if (TAXONOMY_TIERS.actionable.categories.includes(category)) {
    return 0;
  }
  if (TAXONOMY_TIERS['low-signal'].categories.includes(category)) {
    return 2;
  }
  return 1;
}

function getRowTimestampMs(value: unknown): number {
  if (value instanceof Date) {
    return value.valueOf();
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

async function insertContestedResolvedEvent(input: ContestedResolvedEventInput) {
  await insertMemoryEventWithClient(input.client, {
    eventType: 'contested_resolved',
    memoryId: input.memoryId,
    payloadJson: {
      action: input.action,
      memory_id_a: input.memoryIdA,
      memory_id_b: input.memoryIdB,
      ...(input.mergedMemoryId !== undefined ? { merged_memory_id: input.mergedMemoryId } : {}),
    },
  });
}

function normalizeMemoryLookupId(value: unknown, fieldName: 'id' | 'ids') {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must contain positive integer memory ids.`);
  }
  return parsed;
}

function normalizeMemoryLookupIds(request: Record<string, unknown>): number[] {
  const ids = new Set<number>();
  if ('id' in request && request.id !== undefined && request.id !== null) {
    ids.add(normalizeMemoryLookupId(request.id, 'id'));
  }

  if ('ids' in request && request.ids !== undefined && request.ids !== null) {
    if (!Array.isArray(request.ids)) {
      throw new Error('ids must be an array of positive integers.');
    }
    for (const value of request.ids) {
      ids.add(normalizeMemoryLookupId(value, 'ids'));
      if (ids.size > MAX_MEMORY_GET_IDS) {
        throw new Error(`ids must contain at most ${String(MAX_MEMORY_GET_IDS)} unique ids.`);
      }
    }
  }

  if (ids.size === 0) {
    throw new Error('Provide id or ids to fetch memory records.');
  }

  return [...ids];
}

function readMemoryStatus(memory: Record<string, unknown>) {
  const status = memory.status;
  return typeof status === 'string' && status.trim().length > 0 ? status : '(missing)';
}

function rerankRecallRows(rows: Record<string, unknown>[], limit: number) {
  return [...rows]
    .sort((left, right) => {
      const tierDelta = getRecallTierOrder(left) - getRecallTierOrder(right);
      if (tierDelta !== 0) {
        return tierDelta;
      }

      const contestedDelta = Number(left.status === CONTESTED_STATUS) - Number(right.status === CONTESTED_STATUS);
      if (contestedDelta !== 0) {
        return contestedDelta;
      }

      const importanceDelta =
        toSortableNumber(right.decayed_importance) * getReadReversalPenalty(right) -
        toSortableNumber(left.decayed_importance) * getReadReversalPenalty(left);
      if (importanceDelta !== 0) {
        return importanceDelta;
      }

      const confidenceDelta = toSortableNumber(right.confidence) - toSortableNumber(left.confidence);
      if (confidenceDelta !== 0) {
        return confidenceDelta;
      }

      return getRowTimestampMs(right.created_at) - getRowTimestampMs(left.created_at);
    })
    .slice(0, limit);
}

async function resolveContestedMemoryWithClient(
  client: Parameters<typeof storeMemoryWithClient>[0],
  input: {
    action: ContestedResolutionAction;
    memoryIdA: number;
    memoryIdB: number;
    mergedContent?: string | undefined;
  },
) {
  const { action, memoryIdA, memoryIdB } = input;
  const eventBase = { action, client, memoryIdA, memoryIdB };

  // Fetch and lock both rows so concurrent resolutions cannot mutate them mid-flight.
  const fetchSql = `SELECT * FROM ai_memory_entries WHERE id IN ($1, $2) FOR UPDATE`;
  const fetchResult = await client.query(fetchSql, [memoryIdA, memoryIdB]);
  if (fetchResult.rows.length < 2) {
    throw new Error(`Could not find both memories: expected ids ${String(memoryIdA)} and ${String(memoryIdB)}`);
  }

  const memoryA = fetchResult.rows.find((r: Record<string, unknown>) => toPositiveInt(r.id) === memoryIdA);
  if (memoryA === undefined) {
    throw new Error(`Could not find memory with id ${String(memoryIdA)}`);
  }
  const memoryB = fetchResult.rows.find((r: Record<string, unknown>) => toPositiveInt(r.id) === memoryIdB);
  if (memoryB === undefined) {
    throw new Error(`Could not find memory with id ${String(memoryIdB)}`);
  }

  assertContestedResolutionPreconditions({
    memoryA,
    memoryB,
    memoryIdA,
    memoryIdB,
  });

  if (action === 'keep_first') {
    const activateFirst = await client.query(
      `UPDATE ai_memory_entries SET status = 'active', updated_at = NOW() WHERE id = $1 AND status = $2`,
      [memoryIdA, CONTESTED_STATUS],
    );
    assertExpectedRowCount({
      action,
      actual: activateFirst.rowCount,
      expected: 1,
      operation: `activate memory ${String(memoryIdA)}`,
    });

    const supersedeSecond = await client.query(
      `UPDATE ai_memory_entries
       SET status = 'superseded', supersedes_id = $2, updated_at = NOW()
       WHERE id = $1 AND status = $3`,
      [memoryIdB, memoryIdA, CONTESTED_STATUS],
    );
    assertExpectedRowCount({
      action,
      actual: supersedeSecond.rowCount,
      expected: 1,
      operation: `supersede memory ${String(memoryIdB)}`,
    });
    await insertContestedResolvedEvent({ ...eventBase, memoryId: memoryIdA });
    await insertContestedResolvedEvent({ ...eventBase, memoryId: memoryIdB });
    return { action, keptIds: [memoryIdA], supersededIds: [memoryIdB] };
  }

  if (action === 'keep_second') {
    const activateSecond = await client.query(
      `UPDATE ai_memory_entries SET status = 'active', updated_at = NOW() WHERE id = $1 AND status = $2`,
      [memoryIdB, CONTESTED_STATUS],
    );
    assertExpectedRowCount({
      action,
      actual: activateSecond.rowCount,
      expected: 1,
      operation: `activate memory ${String(memoryIdB)}`,
    });

    const supersedeFirst = await client.query(
      `UPDATE ai_memory_entries
       SET status = 'superseded', supersedes_id = $2, updated_at = NOW()
       WHERE id = $1 AND status = $3`,
      [memoryIdA, memoryIdB, CONTESTED_STATUS],
    );
    assertExpectedRowCount({
      action,
      actual: supersedeFirst.rowCount,
      expected: 1,
      operation: `supersede memory ${String(memoryIdA)}`,
    });
    await insertContestedResolvedEvent({ ...eventBase, memoryId: memoryIdA });
    await insertContestedResolvedEvent({ ...eventBase, memoryId: memoryIdB });
    return { action, keptIds: [memoryIdB], supersededIds: [memoryIdA] };
  }

  if (action === 'keep_both') {
    const activateBoth = await client.query(
      `UPDATE ai_memory_entries
       SET status = 'active', updated_at = NOW()
       WHERE id IN ($1, $2) AND status = $3`,
      [memoryIdA, memoryIdB, CONTESTED_STATUS],
    );
    assertExpectedRowCount({
      action,
      actual: activateBoth.rowCount,
      expected: 2,
      operation: `activate both memories ${String(memoryIdA)} and ${String(memoryIdB)}`,
    });
    await insertContestedResolvedEvent({ ...eventBase, memoryId: memoryIdA });
    await insertContestedResolvedEvent({ ...eventBase, memoryId: memoryIdB });
    return { action, keptIds: [memoryIdA, memoryIdB], supersededIds: [] };
  }

  // action === 'merge'
  // Supersede both originals and create a new merged memory.
  const supersedeBoth = await client.query(
    `UPDATE ai_memory_entries
     SET status = 'superseded', updated_at = NOW()
     WHERE id IN ($1, $2) AND status = $3`,
    [memoryIdA, memoryIdB, CONTESTED_STATUS],
  );
  assertExpectedRowCount({
    action,
    actual: supersedeBoth.rowCount,
    expected: 2,
    operation: `supersede both memories ${String(memoryIdA)} and ${String(memoryIdB)}`,
  });

  // Create the merged memory using the store path, inheriting metadata from memory A.
  const mergedMemory = await storeMemoryWithClient(client, {
    agent: String(memoryA.agent ?? ''),
    category: String(memoryA.category ?? ''),
    confidence: typeof memoryA.confidence === 'number' ? memoryA.confidence : undefined,
    content: input.mergedContent,
    project: typeof memoryA.project === 'string' ? memoryA.project : undefined,
    sensitivity: typeof memoryA.sensitivity === 'string' ? memoryA.sensitivity : undefined,
    source: typeof memoryA.source === 'string' ? memoryA.source : undefined,
    supersedesId: memoryIdA,
    tags: Array.isArray(memoryA.tags) ? memoryA.tags : undefined,
  });

  const mergeEventBase = { ...eventBase, mergedMemoryId: mergedMemory.id };
  await insertContestedResolvedEvent({
    ...mergeEventBase,
    memoryId: memoryIdA,
  });
  await insertContestedResolvedEvent({
    ...mergeEventBase,
    memoryId: memoryIdB,
  });
  await insertContestedResolvedEvent({
    ...mergeEventBase,
    memoryId: mergedMemory.id,
  });

  return {
    action,
    keptIds: [mergedMemory.id],
    mergedMemory,
    supersededIds: [memoryIdA, memoryIdB],
  };
}

/**
 * Phase-attributed bounded read: wraps the task in a transaction with per-call
 * `SET LOCAL statement_timeout = readTimeoutMs`, so server-side cancellation
 * enforces the budget and the connection is released within budget — even if
 * the underlying SQL would otherwise run up to the pool's session statement
 * timeout. On `query_canceled`, the helper re-throws a phase-attributed
 * `TimeoutError(`db.read.<operation>`, budget)` so failure-signature
 * aggregation can pinpoint the SQL step.
 */
function runDbReadQuery<T>(input: { operation: string; task: (client: DbClient) => Promise<T> }): Promise<T> {
  return runBoundedQuery({
    phase: `db.read.${input.operation}`,
    pool,
    task: input.task,
    timeoutMs: resolveTimeoutPolicy().db.readTimeoutMs,
  });
}

/**
 * Phase-attributed bounded write: same contract as `runDbReadQuery` but with
 * the write budget applied. Use for transactional writes that perform reads
 * inline (e.g. similarity lookup before insert) so the inner read cannot run
 * past the write budget.
 */
function runDbWriteQuery<T>(input: { operation: string; task: (client: DbClient) => Promise<T> }): Promise<T> {
  return runBoundedQuery({
    phase: `db.write.${input.operation}`,
    pool,
    task: input.task,
    timeoutMs: resolveTimeoutPolicy().db.writeTimeoutMs,
  });
}

function scheduleImportanceBoost(rows: Record<string, unknown>[]) {
  const memoryIds = extractBoostableMemoryIds(rows);
  if (memoryIds.length === 0) {
    return;
  }

  void boostImportanceForAccessedMemories(memoryIds).catch(() => undefined);
}

/**
 * Deterministic fallback for when the hybrid search pipeline returns zero results.
 * Uses index-compatible per-token matching to find candidate memories,
 * then applies the standard hybrid reranker for consistent scoring.
 */
async function searchMemoriesTokenFallback(input: {
  category: string | undefined;
  goalText: string | undefined;
  includeInactive: boolean;
  limit: number;
  memoryType: string | undefined;
  project: string | undefined;
  queryText: string;
  sessionId?: string | undefined;
}) {
  const { category, goalText, includeInactive, limit, memoryType, project, queryText, sessionId } = input;
  const tokens = buildSearchQueryTokens(queryText);
  if (tokens.length === 0) {
    return [];
  }

  const { params, sql } = buildTokenFallbackQuery({
    category,
    includeInactive,
    limit,
    memoryType,
    project,
    sessionId,
    tokens,
  });
  const result = await runDbReadQuery({
    operation: 'search_memories.fallback',
    task: client => client.query(sql, params),
  });
  const fallbackRows = result.rows.filter(isRecord);
  const penalizedRows = await runDbReadQuery({
    operation: 'search_memories.fallback_reversal_penalty',
    task: client => applyReadReversalPenalties(client, fallbackRows),
  });
  return rerankHybridSearchRows(penalizedRows, { goalText, limit, queryText });
}

function toPositiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function toSortableNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
