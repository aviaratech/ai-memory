import { computeReversalPrior as computeReadReversalPrior } from './reversal-prior.js';
import {
  MIN_REVERSAL_PRIOR_MEMORIES,
  REVERSAL_PRIOR_WINDOW_DAYS,
  type ReversalPrior,
  type ReversalPriorScope,
  roundMetric,
} from './write-calibration.js';

interface DatabaseClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

interface PriorLookupCell {
  author: string;
  category: string;
  tag?: string | undefined;
}

export const READ_REVERSAL_PENALTY_CAP = 0.5;

export async function applyReadReversalPenalties(
  client: DatabaseClient,
  rows: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  if (rows.length === 0) {
    return rows;
  }

  let priorsByRowIndex: Map<number, null | ReversalPrior>;
  try {
    priorsByRowIndex = await queryReadReversalPriorsByRowIndex(client, rows);
  } catch {
    return rows;
  }

  const penalizedRows: Record<string, unknown>[] = [];
  for (const [index, row] of rows.entries()) {
    const prior = priorsByRowIndex.get(index) ?? null;
    if (prior === null) {
      penalizedRows.push(row);
      continue;
    }
    const readPrior = computeReadReversalPrior(prior);
    if (readPrior === null) {
      penalizedRows.push(row);
      continue;
    }

    penalizedRows.push({
      ...row,
      reversal_penalty: readPrior.reversalPenalty,
      reversal_prior_memory_count: readPrior.priorMemoryCount,
      reversal_prior_scope: readPrior.scope,
      reversal_rate: readPrior.reversalRate,
      signals: {
        ...readRecord(row.signals),
        priorMemoryCount: readPrior.priorMemoryCount,
        reversalPenalty: readPrior.reversalPenalty,
        reversalRate: readPrior.reversalRate,
        scope: readPrior.scope,
        window: readPrior.window,
      },
    });
  }

  return penalizedRows;
}

export function computeReadReversalPenalty(reversalRate: number): number {
  const normalizedRate = clampToUnitInterval(reversalRate);
  return roundMetric(1 - Math.min(READ_REVERSAL_PENALTY_CAP, normalizedRate));
}

function categoryLookupKey(cell: Pick<PriorLookupCell, 'author' | 'category'>): string {
  return JSON.stringify([cell.author, cell.category.toLowerCase()]);
}

function clampToUnitInterval(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

function dedupeCells(cells: PriorLookupCell[], keyForCell: (cell: PriorLookupCell) => string): PriorLookupCell[] {
  const deduped = new Map<string, PriorLookupCell>();
  for (const cell of cells) {
    const key = keyForCell(cell);
    if (!deduped.has(key)) {
      deduped.set(key, cell);
    }
  }
  return [...deduped.values()];
}

async function queryReadReversalPriorsByRowIndex(
  client: DatabaseClient,
  rows: Record<string, unknown>[],
): Promise<Map<number, null | ReversalPrior>> {
  const lookupsByRowIndex = new Map<number, PriorLookupCell>();
  const tagCells: PriorLookupCell[] = [];
  for (const [index, row] of rows.entries()) {
    const category = readNonEmptyText(row.category);
    if (category === undefined) {
      continue;
    }

    const cell = {
      author: resolveRowAuthor(row),
      category,
      tag: readStringArray(row.tags)[0],
    };
    lookupsByRowIndex.set(index, cell);
    if (cell.tag !== undefined) {
      tagCells.push(cell);
    }
  }

  const tagPriors = await queryReversalPriorBatch(client, {
    cells: dedupeCells(tagCells, tagLookupKey),
    scope: 'author x category x tag',
  });

  const categoryFallbackCells: PriorLookupCell[] = [];
  const priorsByRowIndex = new Map<number, null | ReversalPrior>();
  for (const [index, cell] of lookupsByRowIndex.entries()) {
    if (cell.tag !== undefined) {
      const tagPrior = tagPriors.get(tagLookupKey(cell));
      if (tagPrior !== undefined && tagPrior.priorMemoryCount >= MIN_REVERSAL_PRIOR_MEMORIES) {
        priorsByRowIndex.set(index, tagPrior);
        continue;
      }
    }
    categoryFallbackCells.push(cell);
  }

  const categoryPriors = await queryReversalPriorBatch(client, {
    cells: dedupeCells(categoryFallbackCells, categoryLookupKey),
    scope: 'author x category',
  });

  for (const [index, cell] of lookupsByRowIndex.entries()) {
    if (priorsByRowIndex.has(index)) {
      continue;
    }
    priorsByRowIndex.set(index, categoryPriors.get(categoryLookupKey(cell)) ?? null);
  }

  return priorsByRowIndex;
}

async function queryReversalPriorBatch(
  client: DatabaseClient,
  input: {
    cells: PriorLookupCell[];
    scope: ReversalPriorScope;
  },
): Promise<Map<string, ReversalPrior>> {
  if (input.cells.length === 0) {
    return new Map();
  }

  const includeTag = input.scope === 'author x category x tag';
  const params: unknown[] = [];
  const valueTuples = input.cells.map(cell => {
    params.push(cell.author, cell.category);
    const authorParam = `$${String(params.length - 1)}::text`;
    const categoryParam = `$${String(params.length)}::text`;
    if (!includeTag) {
      return `(${authorParam}, ${categoryParam})`;
    }
    params.push(cell.tag ?? '');
    const tagParam = `$${String(params.length)}::text`;
    return `(${authorParam}, ${categoryParam}, ${tagParam})`;
  });
  params.push(REVERSAL_PRIOR_WINDOW_DAYS);
  const windowDaysParam = `$${String(params.length)}::int`;

  const tagColumn = includeTag ? ', tag' : '';
  const tagSelect = includeTag ? ', input_cells.tag' : '';
  const tagJoin = includeTag ? `AND memory.tags @> ARRAY[input_cells.tag]::text[]` : '';
  const operationName = includeTag ? 'read_reversal_prior_tag_batch' : 'read_reversal_prior_category_batch';

  const result = await client.query(
    `
      /* write_calibration ${operationName} */
      WITH input_cells(author, category${tagColumn}) AS (
        VALUES ${valueTuples.join(',\n          ')}
      )
      SELECT
        input_cells.author,
        lower(input_cells.category) AS category${tagSelect},
        COUNT(memory.id)::int AS prior_memory_count,
        COUNT(memory.id) FILTER (WHERE memory.status IN ('superseded', 'contested-resolved-against'))::int AS reversal_count,
        AVG(COALESCE(memory.declared_confidence, memory.confidence))::double precision AS mean_declared_confidence
      FROM input_cells
      LEFT JOIN ai_memory_entries memory
        ON COALESCE(NULLIF(memory.agent, ''), NULLIF(memory.updated_by, ''), NULLIF(memory.source, ''), 'unknown') =
          input_cells.author
        AND lower(memory.category) = lower(input_cells.category)
        AND memory.created_at >= NOW() - (${windowDaysParam} * INTERVAL '1 day')
        ${tagJoin}
      GROUP BY input_cells.author, lower(input_cells.category)${tagSelect}
    `,
    params,
  );

  const priorsByKey = new Map<string, ReversalPrior>();
  for (const row of result.rows) {
    const prior = readReversalPriorFromBatchRow(row, input.scope);
    if (prior === null) {
      continue;
    }
    const key =
      input.scope === 'author x category x tag'
        ? tagLookupKey({ author: prior.author, category: prior.category, tag: readNonEmptyText(row.tag) })
        : categoryLookupKey({ author: prior.author, category: prior.category });
    priorsByKey.set(key, prior);
  }

  return priorsByKey;
}

function readNonEmptyText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function readReversalPriorFromBatchRow(
  row: Record<string, unknown>,
  scope: ReversalPriorScope,
): null | (ReversalPrior & { author: string; category: string }) {
  const author = readNonEmptyText(row.author);
  const category = readNonEmptyText(row.category);
  if (author === undefined || category === undefined) {
    return null;
  }

  const priorMemoryCount = toNonNegativeInteger(row.prior_memory_count);
  const reversalCount = toNonNegativeInteger(row.reversal_count);
  const reversalRate = priorMemoryCount === 0 ? 0 : roundMetric(reversalCount / priorMemoryCount);
  return {
    author,
    category,
    meanDeclaredConfidence: toNullableMetric(row.mean_declared_confidence),
    priorMemoryCount,
    reversalCount,
    reversalRate,
    scope,
    window: '30d',
  };
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap(item => {
    const normalized = readNonEmptyText(item);
    return normalized === undefined ? [] : [normalized];
  });
}

function resolveRowAuthor(row: Record<string, unknown>): string {
  return (
    readNonEmptyText(row.agent) ??
    readNonEmptyText(row.updated_by) ??
    readNonEmptyText(row.updatedBy) ??
    readNonEmptyText(row.source) ??
    'unknown'
  );
}

function tagLookupKey(cell: PriorLookupCell): string {
  return JSON.stringify([cell.author, cell.category.toLowerCase(), cell.tag ?? null]);
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
