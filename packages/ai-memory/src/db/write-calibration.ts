import type { normalizeMemoryInput } from './normalization.js';

export interface ReversalPrior {
  meanDeclaredConfidence: null | number;
  priorMemoryCount: number;
  reversalCount: number;
  reversalRate: number;
  scope: ReversalPriorScope;
  window: '30d';
}

export type ReversalPriorScope = 'author x category' | 'author x category x tag';

export interface WriteCalibration {
  calibratedConfidence: number;
  declaredConfidence: number;
  meanDeclaredConfidence: null | number;
  priorMemoryCount: number;
  reversalRate: number;
  scope: ReversalPriorScope;
  window: '30d';
}

interface CalibrationRow extends Record<string, unknown> {
  author?: unknown;
  category?: unknown;
  mean_declared_confidence?: unknown;
  prior_memory_count?: unknown;
  reversal_count?: unknown;
}

interface DatabaseClient {
  query(text: string, values?: readonly unknown[]): Promise<DatabaseQueryResult<CalibrationRow>>;
}

interface DatabaseQueryResult<Row> {
  rowCount?: null | number;
  rows: Row[];
}

type NormalizedMemoryInput = ReturnType<typeof normalizeMemoryInput>;

export const REVERSAL_PRIOR_WINDOW_DAYS = 30;
export const MIN_REVERSAL_PRIOR_MEMORIES = 10;

export async function computeReversalPrior(
  client: DatabaseClient,
  input: {
    author: string;
    category: string;
    tags?: readonly string[] | undefined;
  },
): Promise<ReversalPrior> {
  const firstTag = input.tags?.[0];

  if (firstTag !== undefined) {
    const tagScoped = await queryReversalPrior(client, {
      author: input.author,
      category: input.category,
      scope: 'author x category x tag',
      tag: firstTag,
    });
    if (tagScoped.priorMemoryCount >= MIN_REVERSAL_PRIOR_MEMORIES) {
      return tagScoped;
    }
  }

  return queryReversalPrior(client, {
    author: input.author,
    category: input.category,
    scope: 'author x category',
  });
}

export async function computeWriteCalibration(
  client: DatabaseClient,
  memory: NormalizedMemoryInput,
): Promise<WriteCalibration> {
  const declaredConfidence = clampConfidence(memory.confidence);
  const author = resolveAuthor(memory);
  const prior = await computeReversalPrior(client, {
    author,
    category: memory.category,
    tags: memory.tags,
  });
  return computeCalibrationFromSummary(declaredConfidence, prior);
}

export function roundMetric(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Number(value.toFixed(4));
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

function computeCalibrationFromSummary(
  declaredConfidence: number,
  summary: {
    meanDeclaredConfidence: null | number;
    priorMemoryCount: number;
    reversalRate: number;
    scope: ReversalPriorScope;
  },
): WriteCalibration {
  const calibratedConfidence = roundMetric(declaredConfidence * (1 - summary.reversalRate));

  return {
    calibratedConfidence,
    declaredConfidence,
    meanDeclaredConfidence: summary.meanDeclaredConfidence,
    priorMemoryCount: summary.priorMemoryCount,
    reversalRate: summary.reversalRate,
    scope: summary.scope,
    window: '30d',
  };
}

async function queryReversalPrior(
  client: DatabaseClient,
  input: {
    author: string;
    category: string;
    scope: ReversalPriorScope;
    tag?: string | undefined;
  },
): Promise<ReversalPrior> {
  const params: unknown[] = [input.author, input.category, REVERSAL_PRIOR_WINDOW_DAYS];
  const tagPredicate =
    input.tag === undefined
      ? ''
      : (() => {
          params.push(input.tag);
          return `AND tags @> ARRAY[$${String(params.length)}]::text[]`;
        })();

  const result = await client.query(
    `
      /* write_calibration ${input.scope === 'author x category x tag' ? 'read_reversal_prior_tag' : 'read_reversal_prior_category'} */
      SELECT
        $1::text AS author,
        lower($2::text) AS category,
        COUNT(*)::int AS prior_memory_count,
        COUNT(*) FILTER (WHERE status IN ('superseded', 'contested-resolved-against'))::int AS reversal_count,
        AVG(COALESCE(declared_confidence, confidence))::double precision AS mean_declared_confidence
      FROM ai_memory_entries
      WHERE COALESCE(NULLIF(agent, ''), NULLIF(updated_by, ''), NULLIF(source, ''), 'unknown') = $1
        AND lower(category) = lower($2)
        AND created_at >= NOW() - ($3::int * INTERVAL '1 day')
        ${tagPredicate}
    `,
    params,
  );

  const row = selectPriorRow(result.rows, input);
  const priorMemoryCount = toNonNegativeInteger(row?.prior_memory_count);
  const reversalCount = toNonNegativeInteger(row?.reversal_count);
  const reversalRate = priorMemoryCount === 0 ? 0 : roundMetric(reversalCount / priorMemoryCount);
  return {
    meanDeclaredConfidence: toNullableMetric(row?.mean_declared_confidence),
    priorMemoryCount,
    reversalCount,
    reversalRate,
    scope: input.scope,
    window: '30d',
  };
}

function resolveAuthor(memory: NormalizedMemoryInput): string {
  return memory.agent ?? memory.updatedBy ?? memory.source;
}

function selectPriorRow(
  rows: CalibrationRow[],
  input: {
    author: string;
    category: string;
  },
): CalibrationRow | undefined {
  if (rows.length === 0) {
    return undefined;
  }

  const hasScopeEcho = rows.some(row => row.author !== undefined || row.category !== undefined);
  if (!hasScopeEcho) {
    return rows[0];
  }

  const expectedCategory = input.category.toLowerCase();
  return rows.find(row => {
    const authorMatches = typeof row.author !== 'string' || row.author === input.author;
    const categoryMatches = typeof row.category !== 'string' || row.category.toLowerCase() === expectedCategory;
    return authorMatches && categoryMatches;
  });
}

function toNonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.floor(parsed);
}

function toNullableMetric(value: unknown): null | number {
  if (value === undefined || value === null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? roundMetric(parsed) : null;
}
