import type { DbPool } from '../db/pool.js';

import { buildHybridSearchQuery } from '../db/memory-api.js';
import { normalizeLimit, normalizeOptionalText, normalizeProjectScope } from '../db/normalization.js';
import { normalizeMemoryType } from '../db/memory-types.js';
import { rerankHybridSearchRows } from '../db/query-helpers.js';
import { runBoundedQuery } from '../db/query-runner.js';
import { toMemoryRecord } from '../db/records.js';
import { applyReadReversalPenalties } from '../db/retrieval-penalty.js';
import { pool } from '../db/runtime.js';
import { isRecord } from '../db/type-guards.js';
import { buildBrief, readCachedBrief, resolveBriefScope } from './brief.js';

interface TopicRecallContext {
  database?: DbPool;
  host?: string | undefined;
  role?: string | undefined;
  cacheDir?: string;
}

export async function recallTopic(input: unknown, context: TopicRecallContext = {}) {
  const request = isRecord(input) ? input : {};
  const project = normalizeProjectScope(request);
  if (project === undefined) throw new Error('project is required for topic recall.');
  const topic = normalizeOptionalText(request.topic);
  if (topic === undefined) throw new Error('topic must be a non-empty string.');
  const limit = normalizeLimit(request.limit, { fallback: 5, max: 5 });
  const { sql, params } = buildHybridSearchQuery({
    activeKeyedOnly: true,
    category: normalizeOptionalText(request.category),
    includeInactive: false,
    limit,
    memoryType: normalizeMemoryType(request.memoryType, 'memoryType'),
    project,
    queryEmbedding: null,
    queryText: topic,
  });
  try {
    const ranked = await runBoundedQuery({
      deadlineMs: 1000,
      timeoutMs: 1000,
      phase: 'db.read.topic_recall',
      pool: context.database ?? pool,
      task: async client => {
        const result = await client.query<Record<string, unknown>>(sql, params);
        const rows = await applyReadReversalPenalties(client, result.rows);
        return rerankHybridSearchRows(rows, { limit, queryText: topic });
      },
    });
    const memories = ranked.map(row => {
      const memory = toMemoryRecord(row);
      return {
        id: memory.id,
        project,
        key: String(memory.memoryKey),
        excerpt: String(memory.content ?? '')
          .replace(/\s+/gu, ' ')
          .trim()
          .slice(0, 400),
        lastVerifiedAt: memory.lastVerifiedAt ?? memory.updatedAt ?? null,
        evidenceRefs: memory.evidenceRefs,
      };
    });
    return { status: 'ok' as const, count: memories.length, memories, brief: '' };
  } catch {
    let brief = '';
    if (context.host === 'codex' || context.host === 'claude-code') {
      const scope = resolveBriefScope({
        project,
        host: context.host,
        role: normalizeOptionalText(context.role) ?? 'default',
      });
      brief = (await readCachedBrief(scope, context.cacheDir))?.text ?? buildBrief(scope, []);
    }
    return {
      status: 'degraded' as const,
      count: 0,
      memories: [],
      brief,
      notice: 'Topic recall unavailable; using the scoped cached brief when available.',
    };
  }
}
