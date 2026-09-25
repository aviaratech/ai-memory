import { randomUUID } from 'node:crypto';

import type { KnownFailureSignature } from './known-failure-signatures.js';
import type { Queryable } from './session-api.js';

import { buildFailureSignature } from './failure-signature.js';
import { KNOWN_FAILURE_SIGNATURES } from './known-failure-signatures.js';

/** Apply result: summary of DB updates performed. */
export interface ApplyResult {
  affectedRows: number;
  resolutionBatchId: string;
}

/** Dry-run result: per-signature match counts without any DB writes. */
export interface DryRunResult {
  matches: SignatureMatchSummary[];
  totalCandidates: number;
}

/** Per-signature match summary for dry-run output. */
export interface SignatureMatchSummary {
  /** IDs of failures that would be marked resolved (up to CANDIDATE_ID_DISPLAY_LIMIT). */
  candidateIds: number[];
  /** Total count of matching failures. */
  count: number;
  /** The normalized signature that matched. */
  signature: string;
}

/** Rollback query template — keyed by resolution_batch_id to reverse a specific apply run. */
export const ROLLBACK_QUERY_TEMPLATE = `
-- Rollback a specific resolution batch (substitute the actual batch ID):
UPDATE ai_ingestion_failures
SET resolved_at = NULL,
    resolved_by = NULL,
    resolved_reason = NULL,
    resolution_batch_id = NULL
WHERE resolution_batch_id = '<BATCH_ID>';

-- Verify post-rollback (should return 0):
SELECT COUNT(*) FROM ai_ingestion_failures WHERE resolution_batch_id = '<BATCH_ID>';
`.trim();

interface CandidateRow {
  created_at: Date;
  error_message: string;
  id: number;
  stage: string;
}

const CANDIDATE_FETCH_LIMIT = 10_000;
const CANDIDATE_ID_DISPLAY_LIMIT = 100;

/**
 * Resolve known historical ingestion failures by fix signature.
 *
 * Gate: only marks resolved when `created_at < fixDate` AND signature matches.
 * Post-fix regressions (created_at >= fixDate) remain actionable.
 *
 * @param pool  Connected pg Pool
 * @param options.dryRun  true = report only, no DB writes (default-safe)
 * @param options.signatures  Registry to use (defaults to KNOWN_FAILURE_SIGNATURES)
 */
export async function resolveKnownFailures(
  pool: Queryable,
  options: { dryRun: boolean; signatures?: readonly KnownFailureSignature[] },
): Promise<{ dryRun: false; result: ApplyResult } | { dryRun: true; result: DryRunResult }> {
  const signatures = options.signatures ?? KNOWN_FAILURE_SIGNATURES;
  if (options.dryRun) {
    const matches: SignatureMatchSummary[] = [];
    let totalCandidates = 0;

    for (const sig of signatures) {
      const rows = await fetchCandidates(pool, sig.fixDate);
      const matched = rows.filter(row => matchesSig(row, sig));
      if (matched.length > 0) {
        matches.push({
          candidateIds: matched.slice(0, CANDIDATE_ID_DISPLAY_LIMIT).map(r => r.id),
          count: matched.length,
          signature: sig.signature,
        });
        totalCandidates += matched.length;
      }
    }

    return { dryRun: true, result: { matches, totalCandidates } };
  }

  // Apply mode — update in batches per signature
  const resolutionBatchId = randomUUID();
  let affectedRows = 0;

  for (const sig of signatures) {
    const rows = await fetchCandidates(pool, sig.fixDate);
    const matchedIds = rows.filter(row => matchesSig(row, sig)).map(r => r.id);
    if (matchedIds.length === 0) continue;

    const sql = `
      UPDATE ai_ingestion_failures
      SET resolved_at = NOW(),
          resolved_by = $1,
          resolved_reason = $2,
          resolution_batch_id = $3
      WHERE id = ANY($4::bigint[])
        AND resolved_at IS NULL
    `;
    const updateResult = await pool.query(sql, [sig.resolvedBy, sig.resolvedReason, resolutionBatchId, matchedIds]);
    affectedRows += updateResult.rowCount;
  }

  return { dryRun: false, result: { affectedRows, resolutionBatchId } };
}

async function fetchCandidates(pool: Queryable, fixDate: string): Promise<CandidateRow[]> {
  const sql = `
    SELECT id, stage, error_message, created_at
    FROM ai_ingestion_failures
    WHERE resolved_at IS NULL
      AND created_at < $1::timestamptz
    ORDER BY created_at DESC
    LIMIT $2::int
  `;
  const result = await pool.query(sql, [fixDate, CANDIDATE_FETCH_LIMIT]);
  return result.rows as CandidateRow[];
}

function matchesSig(row: CandidateRow, sig: KnownFailureSignature): boolean {
  return buildFailureSignature(row.stage, row.error_message) === sig.signature;
}
