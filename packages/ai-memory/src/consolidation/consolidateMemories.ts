/**
 * Session-end consolidation pipeline (AI Memory v2 Phase F).
 *
 * Two-stage algorithm:
 *   Stage 1 — Vector similarity scan: finds near-duplicate memories above cosine threshold 0.82.
 *   Stage 2 — LLM classification: classifies each candidate pair as reinforce / contradict / refine / unrelated.
 *
 * Graceful degradation:
 *   - Embedding unavailable → skip (caller guards with isEmbeddingAvailable())
 *   - Vector query fails (pgvector unavailable) → skip memory, log warn
 *   - LLM classification fails → log to ai_ingestion_failures, skip pair
 *   - Any throw → caught at top-level, flush continues normally
 */

import { randomUUID } from 'node:crypto';

import { getEmbedding } from '../db/embeddings.js';
import {
  insertIngestionFailureWithClient,
  insertMemoryEventWithClient,
  insertSessionEventWithClient,
} from '../db/failure-events.js';
import { type MemoryType, normalizeMemoryType } from '../db/memory-types.js';
import { runBoundedQuery } from '../db/query-runner.js';
import { pool } from '../db/runtime.js';
import { logAiMemoryError, logAiMemoryWarn } from '../logger.js';
import { resolveTimeoutPolicy, TimeoutError } from '../timeout-policy.js';
import { recordAiMemoryWarningDetail } from '../warning-channel.js';
import { classifyMemoryPair } from './llm-classify.js';

export type { ConsolidationClassification } from './llm-classify.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONSOLIDATION_ACTOR = 'consolidation-pipeline';
const CONSOLIDATION_SOURCE = 'consolidation';
const CONSOLIDATION_METRIC_EVENT_TYPE = 'consolidation_metrics';
const CONSOLIDATION_METRIC_SCHEMA_VERSION = 'consolidation_metrics@0.1';
const CONSOLIDATION_STAGE = 'consolidation_classify';
const MAX_CANDIDATES_PER_MEMORY = 3;
const SIMILARITY_THRESHOLD = 0.82;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ConsolidationAction = 'contradict' | 'episodic_to_semantic' | 'none' | 'refine' | 'reinforce';
export interface ConsolidationMemory {
  category: string;
  confidence?: number | undefined;
  content: string;
  id: number;
  memoryKey?: null | string | undefined;
  memoryType?: null | string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export type ConsolidationMetricAction = 'dedupe' | 'none' | 'refine' | 'supersede';

export interface ConsolidationPairMetric {
  actionTaken: ConsolidationMetricAction;
  candidateMemoryId: number;
  candidateMemoryKey?: null | string | undefined;
  contradictionFlagged?: boolean | undefined;
  newMemoryId: number;
  newMemoryKey?: null | string | undefined;
  relationship?: null | string | undefined;
}

export interface ConsolidationRunMetrics {
  actions: Record<ConsolidationMetricAction, number>;
  contradictionsFlagged: number;
  latencyMs: number;
  outcomes: ConsolidationPairMetric[];
  pairsClassified: number;
  pairsExamined: number;
  sessionId?: string | undefined;
}

interface ActionOptions {
  candidate: SimilarCandidate;
  classification: {
    confidenceDelta: number;
    reasoning: string;
    relationship: string;
  };
  newMemory: ConsolidationMemory;
}

interface DatabaseClient {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rowCount?: null | number; rows: Record<string, unknown>[] }>;
}

interface PairInput {
  candidate: SimilarCandidate;
  newMemory: ConsolidationMemory;
  sessionId?: string | undefined;
}

interface SimilarCandidate {
  category: string;
  confidence: number;
  content: string;
  id: number;
  memoryKey?: null | string | undefined;
  memoryType?: null | string;
  similarity: number;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Consolidate newly stored memories against existing durable memories.
 *
 * Processes consolidation-relevant memories (typed episodic/semantic and
 * legacy decision/root-cause records when type is absent).
 * Never throws — failures are logged but do not abort the flush.
 *
 * @param newMemories - Memories stored during this flush (all categories; non-actionable filtered internally)
 * @param sessionId   - Session ID for audit trail
 */
export async function consolidateMemories(
  newMemories: ConsolidationMemory[],
  sessionId?: string,
): Promise<ConsolidationRunMetrics> {
  const startedAt = Date.now();
  const actionable = newMemories.filter(shouldAttemptConsolidation);
  const metrics = createEmptyConsolidationRunMetrics(sessionId);

  for (const newMemory of actionable) {
    try {
      const embedding = await getEmbedding(newMemory.content, {
        category: newMemory.category,
        operation: 'consolidate',
      });
      if (embedding === null) continue;

      const candidates = await findSimilarCandidates(embedding, newMemory.id);
      metrics.pairsExamined += candidates.length;
      for (const candidate of candidates) {
        try {
          const outcome = await processMemoryPair({ candidate, newMemory, sessionId });
          metrics.pairsClassified += 1;
          metrics.actions[outcome.actionTaken] += 1;
          if (outcome.contradictionFlagged === true) {
            metrics.contradictionsFlagged += 1;
          }
          metrics.outcomes.push(outcome);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logAiMemoryError('consolidation.pair_failed', {
            candidateId: candidate.id,
            message: errorMessage,
            newMemoryId: newMemory.id,
          });
          try {
            await logConsolidationFailure({
              details: { candidateId: candidate.id, newMemoryId: newMemory.id },
              errorMessage,
              sessionId,
            });
          } catch {
            // Best-effort failure logging
          }
        }
      }
    } catch (error) {
      logAiMemoryError('consolidation.memory_failed', {
        memoryId: newMemory.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  metrics.latencyMs = Date.now() - startedAt;
  await recordConsolidationMetric(metrics);
  return metrics;
}

// ---------------------------------------------------------------------------
// Action handlers (each runs inside a transaction via the passed client)
// ---------------------------------------------------------------------------

export function resolveConsolidationAction(input: {
  candidateMemoryType: null | string | undefined;
  newMemoryType: null | string | undefined;
  relationship: string;
}): ConsolidationAction {
  const candidateType = parseNormalizedMemoryType(input.candidateMemoryType);
  const newType = parseNormalizedMemoryType(input.newMemoryType);

  if (input.relationship === 'unrelated') {
    return 'none';
  }

  if (input.relationship === 'contradict') {
    return 'contradict';
  }

  if (input.relationship === 'reinforce') {
    return 'reinforce';
  }

  if (candidateType === 'reflective' || newType === 'reflective') {
    return 'reinforce';
  }

  if (newType === 'episodic' && candidateType === 'semantic') {
    return 'episodic_to_semantic';
  }

  return 'refine';
}

export function shouldAttemptConsolidation(memory: ConsolidationMemory): boolean {
  const memoryType = parseNormalizedMemoryType(memory.memoryType);
  if (memoryType === 'reflective') {
    return false;
  }

  if (memoryType === 'episodic' || memoryType === 'semantic') {
    return true;
  }

  return memory.category === 'decision' || memory.category === 'root-cause';
}

async function applyContradict(client: DatabaseClient, options: ActionOptions): Promise<void> {
  const { candidate, classification, newMemory } = options;
  await client.query(`UPDATE ai_memory_entries SET status = 'contested', updated_at = NOW() WHERE id IN ($1, $2)`, [
    candidate.id,
    newMemory.id,
  ]);
  await insertMemoryEventWithClient(client, {
    actor: CONSOLIDATION_ACTOR,
    eventType: 'consolidation_classified',
    memoryId: candidate.id,
    payloadJson: {
      classification: classification.relationship,
      confidence_delta: 0,
      new_memory_id: newMemory.id,
      reasoning: classification.reasoning,
      vector_similarity: candidate.similarity,
    },
  });
  await insertMemoryEventWithClient(client, {
    actor: CONSOLIDATION_ACTOR,
    eventType: 'consolidation_classified',
    memoryId: newMemory.id,
    payloadJson: {
      classification: classification.relationship,
      confidence_delta: 0,
      existing_memory_id: candidate.id,
      reasoning: classification.reasoning,
      vector_similarity: candidate.similarity,
    },
  });
}

async function applyEpisodicToSemanticConsolidation(client: DatabaseClient, options: ActionOptions): Promise<void> {
  const { candidate, classification, newMemory } = options;
  await client.query(
    `UPDATE ai_memory_entries SET status = 'superseded', supersedes_id = $1, updated_at = NOW() WHERE id = $2`,
    [candidate.id, newMemory.id],
  );
  await insertMemoryEventWithClient(client, {
    actor: CONSOLIDATION_ACTOR,
    eventType: 'consolidation_classified',
    memoryId: candidate.id,
    payloadJson: {
      classification: 'episodic_to_semantic',
      confidence_delta: Math.max(classification.confidenceDelta, 0),
      episodic_memory_id: newMemory.id,
      reasoning: classification.reasoning,
      vector_similarity: candidate.similarity,
    },
  });
  await insertMemoryEventWithClient(client, {
    actor: CONSOLIDATION_ACTOR,
    eventType: 'consolidation_classified',
    memoryId: newMemory.id,
    payloadJson: {
      classification: 'episodic_to_semantic',
      confidence_delta: 0,
      reasoning: classification.reasoning,
      semantic_memory_id: candidate.id,
      vector_similarity: candidate.similarity,
    },
  });
}

// ---------------------------------------------------------------------------
// Vector similarity scan (Stage 1)
// ---------------------------------------------------------------------------

async function applyRefine(client: DatabaseClient, options: ActionOptions): Promise<void> {
  const { candidate, classification, newMemory } = options;
  // New memory supersedes existing: mark existing as superseded, link new → existing
  await client.query(`UPDATE ai_memory_entries SET status = 'superseded', updated_at = NOW() WHERE id = $1`, [
    candidate.id,
  ]);
  await client.query(`UPDATE ai_memory_entries SET supersedes_id = $1, updated_at = NOW() WHERE id = $2`, [
    candidate.id,
    newMemory.id,
  ]);
  await insertMemoryEventWithClient(client, {
    actor: CONSOLIDATION_ACTOR,
    eventType: 'consolidation_classified',
    memoryId: candidate.id,
    payloadJson: {
      classification: classification.relationship,
      confidence_delta: 0,
      new_memory_id: newMemory.id,
      reasoning: classification.reasoning,
      vector_similarity: candidate.similarity,
    },
  });
}

// ---------------------------------------------------------------------------
// Pair processing
// ---------------------------------------------------------------------------

async function applyReinforce(client: DatabaseClient, options: ActionOptions): Promise<void> {
  const { candidate, classification, newMemory } = options;
  // confidenceDelta is already clamped by classifyMemoryPair
  const delta = classification.confidenceDelta;
  await client.query(
    `UPDATE ai_memory_entries SET confidence = LEAST(1.0, confidence + $1), updated_at = NOW() WHERE id = $2`,
    [delta, candidate.id],
  );
  await insertMemoryEventWithClient(client, {
    actor: CONSOLIDATION_ACTOR,
    eventType: 'consolidation_classified',
    memoryId: candidate.id,
    payloadJson: {
      classification: classification.relationship,
      confidence_delta: delta,
      new_memory_id: newMemory.id,
      reasoning: classification.reasoning,
      vector_similarity: candidate.similarity,
    },
  });
}

function createEmptyConsolidationRunMetrics(sessionId: string | undefined): ConsolidationRunMetrics {
  return {
    actions: {
      dedupe: 0,
      none: 0,
      refine: 0,
      supersede: 0,
    },
    contradictionsFlagged: 0,
    latencyMs: 0,
    outcomes: [],
    pairsClassified: 0,
    pairsExamined: 0,
    sessionId,
  };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

async function findSimilarCandidates(embedding: number[], excludeId: number): Promise<SimilarCandidate[]> {
  const embeddingJson = JSON.stringify(embedding);
  const sql = `
    SELECT id, content, category, confidence, memory_key, memory_type,
           1 - (embedding <=> $1::vector) AS similarity
    FROM ai_memory_entries
    WHERE status = 'active'
      AND embedding IS NOT NULL
      AND id != $2
      AND (1 - (embedding <=> $1::vector)) >= $3
    ORDER BY embedding <=> $1::vector
    LIMIT $4
  `;

  let result: { rows: Record<string, unknown>[] };
  try {
    result = await runBoundedQuery({
      phase: 'db.read.memory_flush.promotion.candidates',
      pool,
      task: client => client.query(sql, [embeddingJson, excludeId, SIMILARITY_THRESHOLD, MAX_CANDIDATES_PER_MEMORY]),
      timeoutMs: resolveTimeoutPolicy().db.readTimeoutMs,
    });
  } catch (error) {
    // pgvector may not be installed — graceful degradation. Bounded timeouts
    // for the flush-promotion phase are also surfaced as warnings rather than
    // aborting the post-commit pipeline.
    if (error instanceof TimeoutError) {
      logAiMemoryWarn('consolidation.vector_query_timed_out', {
        message: error.message,
        operation: error.operation,
        timeoutMs: error.timeoutMs,
      });
      // Phase-attribute the timeout into the AsyncLocalStorage warning channel
      // so the active tool invocation can persist this phase into
      // `ai_tool_invocations.summary_json.timed_out_steps` and the health
      // report's top-timeout-operations breakdown. Without this call the
      // post-commit promotion-candidate timeout would be log-only and would
      // never reach the operator dashboards.
      recordAiMemoryWarningDetail({
        code: 'consolidation.vector_query_timed_out',
        message: error.message,
      });
      return [];
    }
    logAiMemoryWarn('consolidation.vector_query_failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return [];
  }

  const candidates: SimilarCandidate[] = [];
  for (const row of result.rows) {
    const id = toPositiveInt(row.id);
    const similarity = toSafeFloat(row.similarity);
    const content = typeof row.content === 'string' ? row.content : '';
    const category = typeof row.category === 'string' ? row.category : '';
    const confidence = toSafeFloat(row.confidence);
    const memoryKey = typeof row.memory_key === 'string' ? row.memory_key : null;
    const memoryType = parseNormalizedMemoryType(row.memory_type);
    if (id === undefined || content.length === 0 || similarity < SIMILARITY_THRESHOLD) continue;
    candidates.push({
      category,
      confidence,
      content,
      id,
      memoryKey,
      memoryType,
      similarity,
    });
  }

  return candidates;
}

async function logConsolidationFailure(input: {
  details?: unknown;
  errorMessage: string;
  sessionId?: string | undefined;
}): Promise<void> {
  await runBoundedQuery({
    phase: 'db.write.memory_flush.promotion.failure_audit',
    pool,
    task: client =>
      insertIngestionFailureWithClient(client, {
        details: input.details,
        errorMessage: input.errorMessage,
        sessionId: input.sessionId,
        source: CONSOLIDATION_SOURCE,
        stage: CONSOLIDATION_STAGE,
      }),
    timeoutMs: resolveTimeoutPolicy().db.writeTimeoutMs,
  });
}

function metricActionForConsolidationAction(action: ConsolidationAction): ConsolidationMetricAction {
  if (action === 'reinforce') {
    return 'dedupe';
  }
  if (action === 'episodic_to_semantic') {
    return 'supersede';
  }
  if (action === 'refine') {
    return 'refine';
  }
  return 'none';
}

function parseNormalizedMemoryType(value: unknown): MemoryType | null {
  try {
    return normalizeMemoryType(value, 'memoryType') ?? null;
  } catch {
    return null;
  }
}

async function processMemoryPair(input: PairInput): Promise<ConsolidationPairMetric> {
  const { candidate, newMemory, sessionId } = input;

  const classification = await classifyMemoryPair(newMemory, candidate);
  if (classification === null) {
    try {
      await logConsolidationFailure({
        details: { candidateId: candidate.id, newMemoryId: newMemory.id },
        errorMessage: 'LLM classification returned null — skipping pair',
        sessionId,
      });
    } catch {
      // Best-effort failure logging
    }
    return {
      actionTaken: 'none',
      candidateMemoryId: candidate.id,
      candidateMemoryKey: candidate.memoryKey,
      newMemoryId: newMemory.id,
      newMemoryKey: newMemory.memoryKey,
      relationship: null,
    };
  }

  const action = resolveConsolidationAction({
    candidateMemoryType: candidate.memoryType,
    newMemoryType: newMemory.memoryType,
    relationship: classification.relationship,
  });
  if (action === 'none') {
    return {
      actionTaken: 'none',
      candidateMemoryId: candidate.id,
      candidateMemoryKey: candidate.memoryKey,
      newMemoryId: newMemory.id,
      newMemoryKey: newMemory.memoryKey,
      relationship: classification.relationship,
    };
  }

  const actionTaken = metricActionForConsolidationAction(action);
  const contradictionFlagged = action === 'contradict';
  return await runBoundedQuery({
    phase: 'db.write.memory_flush.promotion.apply',
    pool,
    task: async (client, ctx) => {
      ctx.setPhase(action);
      const actionOptions: ActionOptions = {
        candidate,
        classification,
        newMemory,
      };
      if (action === 'reinforce') {
        await applyReinforce(client, actionOptions);
      } else if (action === 'contradict') {
        await applyContradict(client, actionOptions);
      } else if (action === 'episodic_to_semantic') {
        await applyEpisodicToSemanticConsolidation(client, actionOptions);
      } else {
        // action === 'refine'
        await applyRefine(client, actionOptions);
      }
      return {
        actionTaken,
        candidateMemoryId: candidate.id,
        candidateMemoryKey: candidate.memoryKey,
        contradictionFlagged,
        newMemoryId: newMemory.id,
        newMemoryKey: newMemory.memoryKey,
        relationship: classification.relationship,
      };
    },
    timeoutMs: resolveTimeoutPolicy().db.writeTimeoutMs,
  });
}

async function recordConsolidationMetric(metrics: ConsolidationRunMetrics): Promise<void> {
  if (metrics.sessionId === undefined) {
    return;
  }

  const sessionId = metrics.sessionId;
  try {
    await runBoundedQuery({
      phase: 'db.write.memory_flush.promotion.metric',
      pool,
      task: client =>
        insertSessionEventWithClient(client, {
          createdAt: new Date().toISOString(),
          eventId: `${CONSOLIDATION_METRIC_EVENT_TYPE}-${sessionId}-${randomUUID()}`,
          eventType: CONSOLIDATION_METRIC_EVENT_TYPE,
          payloadJson: {
            actions: metrics.actions,
            contradictions_flagged: metrics.contradictionsFlagged,
            latency_ms: metrics.latencyMs,
            outcomes: metrics.outcomes.map(outcome => ({
              action_taken: outcome.actionTaken,
              candidate_memory_id: outcome.candidateMemoryId,
              candidate_memory_key: outcome.candidateMemoryKey,
              contradiction_flagged: outcome.contradictionFlagged === true,
              new_memory_id: outcome.newMemoryId,
              new_memory_key: outcome.newMemoryKey,
              relationship: outcome.relationship ?? null,
            })),
            pairs_classified: metrics.pairsClassified,
            pairs_examined: metrics.pairsExamined,
            schema_version: CONSOLIDATION_METRIC_SCHEMA_VERSION,
          },
          sessionId,
          summary:
            `consolidation: pairs=${String(metrics.pairsExamined)} ` +
            `classified=${String(metrics.pairsClassified)} dedupe=${String(metrics.actions.dedupe)} ` +
            `supersede=${String(metrics.actions.supersede)} contradictions=${String(metrics.contradictionsFlagged)}`,
        }),
      timeoutMs: resolveTimeoutPolicy().db.writeTimeoutMs,
    });
  } catch (error) {
    logAiMemoryWarn('consolidation.metric_event_failed', {
      message: error instanceof Error ? error.message : String(error),
      sessionId,
    });
  }
}

function toPositiveInt(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function toSafeFloat(value: unknown): number {
  const n = Number(value);
  return Number.isNaN(n) ? 0 : n;
}
