import type { DbCapabilities } from './capabilities.js';

import { logAiMemoryWarn } from '../logger.js';
import { probeCapabilities } from './capabilities.js';
import { insertIngestionFailureWithClient } from './failure-events.js';
import {
  normalizeBoolean,
  normalizeFailureMessage,
  normalizeLimit,
  normalizeOptionalText,
  redactUrl,
} from './normalization.js';
import { listPatchBackfillSessionsWithClient } from './query-helpers.js';
import { runAiMemoryMigrations } from './run-migrations.js';
import { getDatabaseUrl, PATCH_BACKFILL_SESSION_FAILURE_STAGE, PATCH_BACKFILL_SOURCE, pool } from './runtime.js';
import { materializeSnapshotsFromStoredDeltasForSessionWithClient } from './snapshot-materialization.js';
import { formatError, isRecord } from './type-guards.js';

interface ExistsRow {
  exists?: boolean;
}

interface QueryClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const EMBEDDING_COLUMN_INDEX = 'ai_memory_entries_embedding_hnsw_idx';

export async function backfillPatchSnapshots(input: unknown = {}) {
  const request = isRecord(input) ? input : {};
  const dryRun = normalizeBoolean(request.dryRun, false);
  const limit = normalizeLimit(request.limit, { fallback: 200, max: 5_000 });
  const sessionId = normalizeOptionalText(request.sessionId);
  const candidateSessions = await listPatchBackfillSessionsWithClient(pool, {
    limit,
    sessionId,
  });
  const summary = {
    candidateSessions: candidateSessions.length,
    dryRun,
    failuresLogged: 0,
    limit,
    processedSessions: 0,
    sessionIdFilter: sessionId,
    sessionsBackfilled: 0,
    snapshotsMaterialized: 0,
    status: 'ok',
  };

  for (const candidateSessionId of candidateSessions) {
    summary.processedSessions += 1;

    const sessionClient = await pool.connect();
    try {
      await sessionClient.query('BEGIN');
      const materialization = await materializeSnapshotsFromStoredDeltasForSessionWithClient(sessionClient, {
        sessionId: candidateSessionId,
      });
      summary.failuresLogged += materialization.failuresLogged;
      summary.snapshotsMaterialized += materialization.snapshotsMaterialized;
      if (materialization.snapshotsMaterialized > 0) {
        summary.sessionsBackfilled += 1;
      }

      if (dryRun) {
        await sessionClient.query('ROLLBACK');
      } else {
        await sessionClient.query('COMMIT');
      }
    } catch (error) {
      await sessionClient.query('ROLLBACK').catch(() => undefined);
      summary.failuresLogged += 1;

      if (!dryRun) {
        const errorMessage = normalizeFailureMessage(error);
        try {
          await insertIngestionFailureWithClient(pool, {
            agent: undefined,
            details: {
              reason: 'backfill_session_failed',
              session_id: candidateSessionId,
            },
            errorMessage,
            repoId: undefined,
            sessionId: candidateSessionId,
            source: PATCH_BACKFILL_SOURCE,
            stage: PATCH_BACKFILL_SESSION_FAILURE_STAGE,
          });
        } catch {
          // Preserve backfill progress even if failure-audit logging itself fails.
        }
      }
    } finally {
      sessionClient.release();
    }
  }

  return summary;
}

export async function closePool() {
  await pool.end();
}

export function getDatabaseUrlForDisplay() {
  const url = getDatabaseUrl();
  if (url === undefined) {
    return '<database url not configured>';
  }
  return redactUrl(url);
}

export async function initializeDatabase() {
  await runAiMemoryMigrations(pool);

  const client = await pool.connect();

  try {
    const capabilities = await probeCapabilities(client);
    await warnForMissingOptionalSchemaCapabilities(client, capabilities);
  } finally {
    client.release();
  }
}

async function hasEmbeddingIndex(client: QueryClient) {
  const embeddingIndexResult = await client.query(
    `
      SELECT EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE indexname = $1
          AND tablename = 'ai_memory_entries'
          AND schemaname = ANY(current_schemas(false))
      )
    `,
    [EMBEDDING_COLUMN_INDEX],
  );
  return (embeddingIndexResult.rows[0] as ExistsRow | undefined)?.exists === true;
}

async function warnForMissingOptionalSchemaCapabilities(client: QueryClient, capabilities: DbCapabilities) {
  if (!capabilities.hasTrigram) {
    logAiMemoryWarn('db.pg_trgm_unavailable', {
      message: 'pg_trgm extension is unavailable; text search fallback runs without trigram acceleration.',
    });
  }

  if (!capabilities.hasVector) {
    logAiMemoryWarn('db.pgvector_unavailable', {
      message:
        'pgvector extension is unavailable; vector write/search paths are disabled. Install/enable extension "vector" and rerun `npm run init -w @aviaratech/ai-memory-tools` to enable semantic vectors.',
    });
    return;
  }

  if (!capabilities.hasEmbeddingColumn) {
    logAiMemoryWarn('db.embedding_column_unavailable', {
      message:
        'ai_memory_entries.embedding is unavailable; vector write/search paths are disabled. Rerun `npm run init -w @aviaratech/ai-memory-tools` after enabling pgvector.',
    });
    return;
  }

  try {
    const embeddingIndexExists = await hasEmbeddingIndex(client);
    if (!embeddingIndexExists) {
      logAiMemoryWarn('db.embedding_index_unavailable', {
        message:
          'ai_memory_entries_embedding_hnsw_idx is unavailable; vector search remains functional but may be slower. Rerun `npm run init -w @aviaratech/ai-memory-tools` to recreate the index.',
      });
    }
  } catch (error) {
    logAiMemoryWarn('db.embedding_index_probe_failed', {
      error: formatError(error),
      message: 'Unable to verify ai_memory_entries_embedding_hnsw_idx; continuing without hard failure.',
    });
  }
}
