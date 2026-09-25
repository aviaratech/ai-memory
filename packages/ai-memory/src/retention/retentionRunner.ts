import type { PurgeTableKey } from '../db/retention-queries.js';
import type { RetentionConfig } from './retentionConfig.js';

import { PURGE_TABLE_ORDER, RETENTION_QUERY_DEFS } from '../db/retention-queries.js';
import { pool } from '../db/runtime.js';
import { logAiMemoryError, logAiMemoryInfo } from '../logger.js';
import { resolveRetentionConfig } from './retentionConfig.js';

interface BatchDeleteInput {
  batchSize: number;
  client: DatabaseClient;
  condition: string;
  conditionParams: unknown[];
  idColumn: string;
  orderColumn: string;
  table: string;
}

interface DatabaseClient {
  query(text: string, values?: readonly unknown[]): DbQueryResult | Promise<DbQueryResult>;
  release(): void;
}

interface DbQueryResult {
  rowCount?: null | number;
  rows: Record<string, unknown>[];
}

interface PurgeHandlerInput {
  batchSize: number;
  client: DatabaseClient;
  config: RetentionConfig;
  dryRun: boolean;
}

interface RetentionPurgeInput {
  batchSize?: number | undefined;
  config?: Partial<RetentionConfig> | undefined;
  dataset?: string | undefined;
  dryRun?: boolean | undefined;
}

interface RetentionPurgeResult {
  config: RetentionConfig;
  dryRun: boolean;
  durationMs: number;
  errors: { error: string; table: string }[];
  status: 'error' | 'ok' | 'partial';
  tables: TablePurgeResult[];
  totalCandidates: number;
  totalDeleted: number;
}

interface TablePurgeResult {
  candidates: number;
  deleted: number;
  newestCreatedAt?: string | undefined;
  oldestCreatedAt?: string | undefined;
  table: string;
}

async function batchDelete(input: BatchDeleteInput): Promise<number> {
  const { batchSize, client, condition, conditionParams, idColumn, orderColumn, table } = input;
  let totalDeleted = 0;
  let hasMore = true;

  while (hasMore) {
    const deleteSql = `DELETE FROM ${table} WHERE ${idColumn} IN (SELECT ${idColumn} FROM ${table} WHERE ${condition} ORDER BY ${orderColumn} ASC LIMIT ${String(batchSize)})`;
    const result = await client.query(deleteSql, conditionParams);
    const rowCount = result.rowCount ?? 0;
    totalDeleted += rowCount;
    hasMore = rowCount >= batchSize;

    logAiMemoryInfo('retention.batch_delete', {
      batchDeleted: rowCount,
      table,
      totalDeleted,
    });
  }

  return totalDeleted;
}

async function countCandidates(input: {
  boundsColumn: string;
  client: DatabaseClient;
  condition: string;
  conditionParams: unknown[];
  table: string;
}): Promise<{
  candidates: number;
  newestCreatedAt?: string | undefined;
  oldestCreatedAt?: string | undefined;
}> {
  const { boundsColumn, client, condition, conditionParams, table } = input;
  const countSql = `SELECT COUNT(*) AS cnt FROM ${table} WHERE ${condition}`;
  const countResult = await client.query(countSql, conditionParams);
  const candidates = Number(countResult.rows[0]?.cnt ?? 0);

  if (candidates === 0) {
    return { candidates: 0 };
  }

  const boundsSql = `SELECT MIN(${boundsColumn})::text AS oldest, MAX(${boundsColumn})::text AS newest FROM ${table} WHERE ${condition}`;
  const boundsResult = await client.query(boundsSql, conditionParams);
  const oldest = boundsResult.rows[0]?.oldest;
  const newest = boundsResult.rows[0]?.newest;

  return {
    candidates,
    newestCreatedAt: typeof newest === 'string' ? newest : undefined,
    oldestCreatedAt: typeof oldest === 'string' ? oldest : undefined,
  };
}

async function executePurge(key: PurgeTableKey, input: PurgeHandlerInput): Promise<TablePurgeResult> {
  const def = RETENTION_QUERY_DEFS[key];
  const { batchSize, client, config, dryRun } = input;
  const condition = def.buildCondition(config);
  const conditionParams: unknown[] = [];

  const counts = await countCandidates({
    boundsColumn: def.boundsColumn,
    client,
    condition,
    conditionParams,
    table: def.table,
  });

  const result: TablePurgeResult = {
    ...counts,
    deleted: 0,
    table: def.displayName,
  };

  if (dryRun || counts.candidates === 0) {
    return result;
  }

  result.deleted = await batchDelete({
    batchSize,
    client,
    condition,
    conditionParams,
    idColumn: def.idColumn,
    orderColumn: def.orderColumn,
    table: def.table,
  });

  return result;
}

function resolveTableName(key: PurgeTableKey): string {
  return RETENTION_QUERY_DEFS[key].table;
}

async function runRetentionPurge(input?: RetentionPurgeInput): Promise<RetentionPurgeResult> {
  const resolvedInput = input ?? {};
  const client = await pool.connect();

  try {
    return await runRetentionPurgeWithClient(client, resolvedInput);
  } finally {
    (client as DatabaseClient).release();
  }
}

async function runRetentionPurgeWithClient(
  client: DatabaseClient,
  input: RetentionPurgeInput,
): Promise<RetentionPurgeResult> {
  const config = resolveRetentionConfig(input.config);
  const dryRun = input.dryRun !== false;
  const batchSize = input.batchSize ?? config.batchSize;

  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error(`batchSize must be a positive integer, got: ${String(batchSize)}`);
  }

  const datasetFilter = input.dataset;

  const startMs = Date.now();
  const tables: TablePurgeResult[] = [];
  const errors: { error: string; table: string }[] = [];

  const tablesToProcess =
    datasetFilter !== undefined
      ? PURGE_TABLE_ORDER.filter(key => {
          const tableName = resolveTableName(key);
          return tableName === datasetFilter || key === datasetFilter;
        })
      : [...PURGE_TABLE_ORDER];

  if (datasetFilter !== undefined && tablesToProcess.length === 0) {
    const allowedKeys = new Set<string>();
    for (const key of PURGE_TABLE_ORDER) {
      allowedKeys.add(key);
      allowedKeys.add(resolveTableName(key));
    }
    const sorted = Array.from(allowedKeys).sort((a, b) => a.localeCompare(b));
    throw new Error(`Unknown dataset '${datasetFilter}'. Allowed values: ${sorted.join(', ')}`);
  }

  for (const tableKey of tablesToProcess) {
    try {
      const result = await executePurge(tableKey, {
        batchSize,
        client,
        config,
        dryRun,
      });
      tables.push(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const tableName = resolveTableName(tableKey);
      errors.push({ error: message, table: tableName });
      logAiMemoryError('retention.table_error', {
        error: message,
        table: tableName,
      });
    }
  }

  const totalCandidates = tables.reduce((sum, t) => sum + t.candidates, 0);
  const totalDeleted = tables.reduce((sum, t) => sum + t.deleted, 0);
  const durationMs = Date.now() - startMs;

  let status: 'error' | 'ok' | 'partial' = 'ok';
  if (errors.length > 0 && tables.length === 0) {
    status = 'error';
  } else if (errors.length > 0) {
    status = 'partial';
  }

  const result: RetentionPurgeResult = {
    config,
    dryRun,
    durationMs,
    errors,
    status,
    tables,
    totalCandidates,
    totalDeleted,
  };

  logAiMemoryInfo('retention.purge_complete', {
    dryRun,
    durationMs,
    errorCount: errors.length,
    status,
    tableCount: tables.length,
    totalCandidates,
    totalDeleted,
  });

  return result;
}

export { runRetentionPurge, runRetentionPurgeWithClient };
