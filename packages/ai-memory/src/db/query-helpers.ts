interface DatabaseClient {
  query(text: string, values?: readonly unknown[]): DbQueryResult | Promise<DbQueryResult>;
}

interface DbQueryResult {
  rowCount?: null | number;
  rows: Record<string, unknown>[];
}

interface MemoryDeltaRow extends Record<string, unknown> {
  created_at?: unknown;
  delta_id?: string;
  produced_by_agent?: string;
  snapshot_json?: unknown;
  snapshot_mode?: string;
  tenancy_json?: unknown;
}

interface SessionIdRow extends Record<string, unknown> {
  session_id?: string;
}

interface SessionSnapshotRow extends Record<string, unknown> {
  created_at?: unknown;
  id?: number;
  session_id?: string;
  snapshot_id?: string;
  snapshot_json?: unknown;
  source_delta_id?: string;
}

import { computeReadTimeDecayedImportance, resolveDecayHalfLifeDays } from './importance.js';
import { getCategoryWeight, getStatusWeight } from './taxonomy.js';

const HYBRID_IMPORTANCE_WEIGHT = 0.04;
const HYBRID_EXISTING_SIGNAL_REBALANCE = 1 - HYBRID_IMPORTANCE_WEIGHT;
const HYBRID_VECTOR_WEIGHT = 0.35 * HYBRID_EXISTING_SIGNAL_REBALANCE;
const HYBRID_KEYWORD_WEIGHT = 0.25 * HYBRID_EXISTING_SIGNAL_REBALANCE;
const HYBRID_SEMANTIC_WEIGHT = 0.28 * HYBRID_EXISTING_SIGNAL_REBALANCE;
const HYBRID_KEYWORD_HINT_WEIGHT = 0.04 * HYBRID_EXISTING_SIGNAL_REBALANCE;
const HYBRID_TAXONOMY_WEIGHT = 0.04 * HYBRID_EXISTING_SIGNAL_REBALANCE;
const HYBRID_CONFIDENCE_WEIGHT = 0.04 * HYBRID_EXISTING_SIGNAL_REBALANCE;
const HYBRID_GOAL_OVERLAP_WEIGHT = 0.12;
const OR_SEMANTIC_SCALE = 0.8;
const MAX_QUERY_TOKENS = 12;
const QUERY_TOKEN_MIN_LENGTH = 2;

interface HybridSearchRankingInput {
  category?: unknown;
  confidence?: unknown;
  content?: unknown;
  created_at?: unknown;
  decayed_importance?: unknown;
  evidence_refs?: unknown;
  evidenceRefs?: unknown;
  importance?: unknown;
  keyword_hint?: unknown;
  max_vector_similarity?: unknown;
  memory_key?: unknown;
  memoryKey?: unknown;
  or_semantic_relevance?: unknown;
  project?: unknown;
  relevance?: unknown;
  reversal_penalty?: unknown;
  semantic_relevance?: unknown;
  signals?: unknown;
  source?: unknown;
  status?: unknown;
  tags?: unknown;
  vector_similarity?: unknown;
}

interface HybridSearchSignalInput {
  defaultHalfLifeDays: number;
  goalTokens?: string[] | undefined;
  input: HybridSearchRankingInput;
  queryText: string;
  queryTokens?: string[] | undefined;
}

interface RerankHybridSearchRowsInput {
  goalText?: string | undefined;
  limit: number;
  queryText: string;
}

export function buildSearchQueryTokens(queryText: string) {
  const normalizedQuery = normalizeText(queryText);
  if (normalizedQuery.length === 0) {
    return [];
  }

  const deduped = new Set<string>();
  for (const token of normalizedQuery.split(/[^a-z0-9]+/)) {
    if (token.length === 0) {
      continue;
    }

    const isNumeric = /^\d+$/.test(token);
    if (!isNumeric && token.length < QUERY_TOKEN_MIN_LENGTH) {
      continue;
    }

    deduped.add(token);
    if (deduped.size >= MAX_QUERY_TOKENS) {
      break;
    }
  }

  return Array.from(deduped);
}

/** Match identifiers with reference markers, not the same number used as a measurement. */
export function buildSearchReferencePattern(queryText: string, goalText = ''): string | undefined {
  const numbers = new Set<string>();
  // A bare number is a precise lookup; quantities in descriptive queries are not.
  if (/^\d+$/u.test(queryText.trim())) numbers.add(queryText.trim());
  const references = `${queryText} ${goalText}`.matchAll(
    /(?<![a-z0-9])(?:(?:issue|pr|pull)s?[\s#/:._-]*|#)(\d+)(?![a-z0-9])/giu,
  );
  // Bound references separately so ordinary words cannot hide a late identifier.
  for (const match of references) {
    if (match[1] !== undefined) numbers.add(match[1]);
    if (numbers.size >= MAX_QUERY_TOKENS) break;
  }
  if (numbers.size === 0) return undefined;
  return `(^|[^a-z0-9])((issues?|prs?|pulls?)[\t\r\n #/:._-]*|#)(${[...numbers].join('|')})([^a-z0-9]|$)`;
}

export async function getLatestSessionSnapshotWithClient(client: DatabaseClient, sessionId: string) {
  const sql = `
    SELECT *
    FROM ai_session_snapshots
    WHERE session_id = $1
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `;
  const result = await client.query(sql, [sessionId]);
  const rows = result.rows as SessionSnapshotRow[];
  return rows[0];
}

export async function getSessionSnapshotBySourceDeltaIdWithClient(
  client: DatabaseClient,
  input: { sessionId: string; sourceDeltaId: string },
) {
  const sql = `
    SELECT *
    FROM ai_session_snapshots
    WHERE session_id = $1
      AND source_delta_id = $2
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `;
  const result = await client.query(sql, [input.sessionId, input.sourceDeltaId]);
  const rows = result.rows as SessionSnapshotRow[];
  return rows[0];
}

export async function listMemoryDeltasForSessionWithClient(client: DatabaseClient, sessionId: string) {
  const sql = `
    SELECT delta_id, snapshot_mode, snapshot_json, created_at, produced_by_agent, tenancy_json
    FROM ai_memory_deltas
    WHERE session_id = $1
    ORDER BY created_at ASC, delta_id ASC
  `;
  const result = await client.query(sql, [sessionId]);
  return result.rows as MemoryDeltaRow[];
}

export async function listPatchBackfillSessionsWithClient(
  client: DatabaseClient,
  input: { limit: number; sessionId?: string | undefined },
) {
  const limit = input.limit;
  const sessionId = input.sessionId;
  const params: unknown[] = [];
  const conditions: string[] = ["d.snapshot_mode = 'patch'"];

  if (sessionId !== undefined) {
    params.push(sessionId);
    conditions.push(`d.session_id = $${String(params.length)}`);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;
  params.push(limit);
  const limitParam = `$${String(params.length)}`;
  const sql = `
    SELECT d.session_id
    FROM ai_memory_deltas d
    LEFT JOIN ai_session_snapshots s
      ON s.session_id = d.session_id
      AND s.source_delta_id = d.delta_id
    ${whereClause}
      AND s.id IS NULL
    Group BY d.session_id
    ORDER BY d.session_id ASC
    LIMIT ${limitParam}
  `;

  const result = await client.query(sql, params);
  const rows = result.rows as SessionIdRow[];
  return rows.flatMap(row => (typeof row.session_id === 'string' ? [row.session_id] : []));
}

export function normalizeSearchReferenceText(text: string): string {
  return text.replace(/\b(issues?|prs?|pulls?)[#/:._ -]*(\d+)/giu, '$1 $2');
}

export function rerankHybridSearchRows(rows: Record<string, unknown>[], rerankInput: RerankHybridSearchRowsInput) {
  const { goalText, limit, queryText } = rerankInput;
  const goalTokens = buildSearchQueryTokens(goalText ?? '');
  const queryTokens = buildSearchQueryTokens(queryText);
  const defaultHalfLifeDays = resolveDecayHalfLifeDays();
  const referencePattern = buildSearchReferencePattern(queryText, goalText);
  const referenceMatcher = referencePattern === undefined ? undefined : new RegExp(referencePattern, 'iu');
  const dedupedRows = new Map<string, Record<string, unknown>>();

  for (const row of rows) {
    const rowId = row.id;
    const dedupeKey =
      typeof rowId === 'string' || typeof rowId === 'number' ? String(rowId) : `row:${String(dedupedRows.size)}`;
    if (!dedupedRows.has(dedupeKey)) {
      dedupedRows.set(dedupeKey, row);
    }
  }

  const scoredRows: Record<string, unknown>[] = Array.from(dedupedRows.values()).map(row => {
    const searchSignal = computeHybridSearchSignal({
      defaultHalfLifeDays,
      goalTokens,
      input: row,
      queryText,
      queryTokens,
    });
    return {
      ...row,
      keyword_relevance: searchSignal.keywordRelevance,
      relevance: clampToUnitInterval(
        searchSignal.hybridRelevance +
          (referenceMatcher !== undefined &&
          [
            normalizeText(row.content),
            normalizeText(row.memory_key ?? row.memoryKey),
            ...normalizeEvidenceRefList(row.evidence_refs ?? row.evidenceRefs),
            ...normalizeTagList(row.tags),
          ].some(field => referenceMatcher.test(field))
            ? 0.24 *
              getStatusWeight(row.status) *
              resolveReversalPenalty(row.reversal_penalty ?? readSignalReversalPenalty(row.signals))
            : 0),
      ),
      semantic_relevance: searchSignal.semanticRelevance,
    };
  });

  scoredRows.sort((left, right) => {
    const relevanceDelta = toFiniteNumber(right.relevance) - toFiniteNumber(left.relevance);
    if (relevanceDelta !== 0) {
      return relevanceDelta;
    }

    const keywordDelta = toFiniteNumber(right.keyword_relevance) - toFiniteNumber(left.keyword_relevance);
    if (keywordDelta !== 0) {
      return keywordDelta;
    }

    const semanticDelta = toFiniteNumber(right.semantic_relevance) - toFiniteNumber(left.semantic_relevance);
    if (semanticDelta !== 0) {
      return semanticDelta;
    }

    return getTimestampMs(right.created_at) - getTimestampMs(left.created_at);
  });

  const boundedLimit = Math.max(1, Math.floor(limit));
  return scoredRows.slice(0, boundedLimit);
}

export function resolveSearchCandidateLimits(limit: number) {
  const boundedLimit = Math.max(1, Math.floor(limit));

  return {
    combinedCandidateLimit: Math.min(Math.max(boundedLimit * 2, 8), 80),
    keywordCandidateLimit: Math.min(Math.max(boundedLimit * 2, 8), 40),
    semanticCandidateLimit: Math.min(Math.max(boundedLimit * 2, 8), 50),
    vectorCandidateLimit: Math.min(Math.max(boundedLimit * 2, 8), 40),
  };
}

function clampToUnitInterval(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (value <= 0) {
    return 0;
  }

  if (value >= 1) {
    return 1;
  }

  return value;
}

function computeGoalOverlapSignal(input: { goalTokens?: string[] | undefined; input: HybridSearchRankingInput }) {
  const { goalTokens, input: rowInput } = input;
  if (goalTokens === undefined || goalTokens.length === 0) {
    return 0;
  }

  const content = normalizeText(rowInput.content);
  const tags = normalizeTagList(rowInput.tags);
  let matched = 0;
  for (const token of goalTokens) {
    if (content.includes(token) || tags.some(tag => tag.includes(token))) {
      matched += 1;
    }
  }

  return clampToUnitInterval(matched / goalTokens.length);
}

function computeHybridSearchSignal(signalInput: HybridSearchSignalInput) {
  const { defaultHalfLifeDays, goalTokens, input, queryText, queryTokens } = signalInput;
  const semanticRaw = toFiniteNumber(input.semantic_relevance ?? input.relevance);
  const orSemanticRaw = toFiniteNumber(input.or_semantic_relevance);
  const andSemanticSignal = toSemanticSignal(semanticRaw);
  const orSemanticSignal = toSemanticSignal(orSemanticRaw) * OR_SEMANTIC_SCALE;
  const semanticRelevance = Math.max(andSemanticSignal, orSemanticSignal);
  const keywordRelevance = computeKeywordSignal({
    defaultHalfLifeDays,
    input,
    queryText,
    queryTokens,
  });
  const goalOverlapSignal = computeGoalOverlapSignal({ goalTokens, input });
  const keywordHint = toFiniteNumber(input.keyword_hint) > 0 ? 1 : 0;
  const taxonomySignal = getCategoryWeight(input.category);
  const confidenceSignal = clampToUnitInterval(toFiniteNumber(input.confidence));
  const importanceSignal = resolveImportanceSignal(input, defaultHalfLifeDays);
  const statusMultiplier = getStatusWeight(input.status);
  const reversalPenalty = resolveReversalPenalty(input.reversal_penalty ?? readSignalReversalPenalty(input.signals));
  // Prefer max_vector_similarity when available: it captures vector score across dedup'd duplicate rows
  const vectorSimilarity = clampToUnitInterval(toFiniteNumber(input.max_vector_similarity ?? input.vector_similarity));
  const hasVector = vectorSimilarity > 0;

  let hybridRelevance: number;
  if (hasVector) {
    hybridRelevance = clampToUnitInterval(
      vectorSimilarity * HYBRID_VECTOR_WEIGHT +
        semanticRelevance * HYBRID_SEMANTIC_WEIGHT +
        keywordRelevance * HYBRID_KEYWORD_WEIGHT +
        keywordHint * HYBRID_KEYWORD_HINT_WEIGHT +
        taxonomySignal * HYBRID_TAXONOMY_WEIGHT +
        confidenceSignal * HYBRID_CONFIDENCE_WEIGHT +
        importanceSignal * HYBRID_IMPORTANCE_WEIGHT,
    );
  } else {
    // No vector signal: redistribute vector weight proportionally to keyword + semantic
    const kvSum = HYBRID_KEYWORD_WEIGHT + HYBRID_SEMANTIC_WEIGHT;
    const redistributedKeywordWeight = HYBRID_KEYWORD_WEIGHT + HYBRID_VECTOR_WEIGHT * (HYBRID_KEYWORD_WEIGHT / kvSum);
    const redistributedSemanticWeight =
      HYBRID_SEMANTIC_WEIGHT + HYBRID_VECTOR_WEIGHT * (HYBRID_SEMANTIC_WEIGHT / kvSum);
    hybridRelevance = clampToUnitInterval(
      semanticRelevance * redistributedSemanticWeight +
        keywordRelevance * redistributedKeywordWeight +
        keywordHint * HYBRID_KEYWORD_HINT_WEIGHT +
        taxonomySignal * HYBRID_TAXONOMY_WEIGHT +
        confidenceSignal * HYBRID_CONFIDENCE_WEIGHT +
        importanceSignal * HYBRID_IMPORTANCE_WEIGHT,
    );
  }

  const goalConditionedRelevance = clampToUnitInterval(
    hybridRelevance + goalOverlapSignal * HYBRID_GOAL_OVERLAP_WEIGHT,
  );

  return {
    hybridRelevance: clampToUnitInterval(goalConditionedRelevance * statusMultiplier * reversalPenalty),
    keywordRelevance,
    semanticRelevance,
  };
}

function computeKeywordSignal(signalInput: HybridSearchSignalInput) {
  const { input, queryText, queryTokens } = signalInput;
  const normalizedQuery = normalizeText(queryText);
  const tokens = queryTokens ?? buildSearchQueryTokens(queryText);
  const content = normalizeText(input.content);
  const project = normalizeText(input.project);
  const category = normalizeText(input.category);
  const source = normalizeText(input.source);
  const memoryKey = normalizeText(input.memory_key ?? input.memoryKey);
  const evidenceRefs = normalizeEvidenceRefs(input.evidence_refs ?? input.evidenceRefs);
  const tags = normalizeTagList(input.tags);
  const searchableText = `${content} ${project} ${category} ${source} ${memoryKey} ${evidenceRefs}`.trim();

  let tokenCoverage = 0;
  if (tokens.length > 0) {
    let matchedCount = 0;
    for (const token of tokens) {
      if (searchableText.includes(token) || tags.some(tag => tag.includes(token))) {
        matchedCount += 1;
      }
    }
    tokenCoverage = matchedCount / tokens.length;
  }

  const hasPhraseMatch =
    normalizedQuery.length >= 4 && (searchableText.includes(normalizedQuery) || tags.includes(normalizedQuery));
  const hasExactTagMatch = normalizedQuery.length >= 2 && tags.includes(normalizedQuery);
  const hasPartialTagMatch =
    normalizedQuery.length >= 3 && !hasExactTagMatch && tags.some(tag => tag.includes(normalizedQuery));

  const fieldCoverageBoost = clampToUnitInterval((Number(content.length > 0) + Number(tags.length > 0)) * 0.03);
  const phraseBoost = hasPhraseMatch ? 0.2 : 0;
  let tagBoost = 0;
  if (hasExactTagMatch) {
    tagBoost = 0.15;
  } else if (hasPartialTagMatch) {
    tagBoost = 0.08;
  }
  const keywordSignal = tokenCoverage * 0.72 + phraseBoost + tagBoost + fieldCoverageBoost;

  return clampToUnitInterval(keywordSignal);
}

function getTimestampMs(value: unknown) {
  if (value instanceof Date) {
    return value.valueOf();
  }

  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function hasOwnProperty(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeEvidenceRefList(value: unknown) {
  const references = Array.isArray(value) ? value : [value];
  return references.map(reference => normalizeEvidenceRefs(reference)).filter(reference => reference.length > 0);
}

function normalizeEvidenceRefs(value: unknown) {
  if (value === undefined || value === null) {
    return '';
  }
  try {
    return normalizeText(JSON.stringify(value));
  } catch {
    return '';
  }
}

function normalizeTagList(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap(tag => (typeof tag === 'string' ? [normalizeText(tag)] : [])).filter(tag => tag.length > 0);
}

function normalizeText(value: unknown) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function readSignalReversalPenalty(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return (value as Record<string, unknown>).reversalPenalty;
}

function resolveImportanceSignal(input: HybridSearchRankingInput, defaultHalfLifeDays: number) {
  if (hasOwnProperty(input, 'decayed_importance')) {
    return clampToUnitInterval(toFiniteNumber(input.decayed_importance));
  }

  return clampToUnitInterval(
    computeReadTimeDecayedImportance({
      category: input.category,
      confidence: input.confidence,
      createdAt: input.created_at,
      defaultHalfLifeDays,
      importance: input.importance,
      status: input.status,
      tags: input.tags,
    }),
  );
}

function resolveReversalPenalty(value: unknown) {
  const parsed = toFiniteNumber(value);
  if (parsed <= 0) {
    return 1;
  }
  if (parsed < 0.5) {
    return 0.5;
  }
  if (parsed > 1) {
    return 1;
  }
  return parsed;
}

function toFiniteNumber(value: unknown) {
  if (value === undefined || value === null) {
    return 0;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toSemanticSignal(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return clampToUnitInterval(value / (value + 0.05));
}
