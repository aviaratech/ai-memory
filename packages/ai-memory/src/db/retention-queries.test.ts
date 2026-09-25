import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';

import { PURGE_TABLE_ORDER, RETENTION_QUERY_DEFS } from './retention-queries.js';

/**
 * Collect all index names from migration statements.
 * Matches both `CREATE INDEX IF NOT EXISTS <name>` and `CREATE UNIQUE INDEX IF NOT EXISTS <name>`.
 */
function collectMigrationIndexNames(sql: string): Set<string> {
  const names = new Set<string>();
  const pattern = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi;

  let match: null | RegExpExecArray;
  while ((match = pattern.exec(sql)) !== null) {
    const indexName: string | undefined = match[1];
    if (indexName !== undefined && indexName.length > 0) {
      names.add(indexName);
    }
  }

  return names;
}

async function readMigrationSql(): Promise<string> {
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
  const files = (await readdir(migrationsDir))
    .filter(file => file.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right));
  const sources = await Promise.all(files.map(file => readFile(join(migrationsDir, file), 'utf-8')));
  return sources.join('\n');
}

test('every PURGE_TABLE_ORDER key has a retention query definition', () => {
  for (const key of PURGE_TABLE_ORDER) {
    assert.ok(key in RETENTION_QUERY_DEFS, `Missing retention query definition for purge key: ${key}`);
  }
});

test('every retention query def references an index that exists in migrations', async () => {
  const migrationIndexes = collectMigrationIndexNames(await readMigrationSql());

  for (const [key, def] of Object.entries(RETENTION_QUERY_DEFS)) {
    assert.ok(
      migrationIndexes.has(def.coveringIndex),
      `Retention query '${key}' references index '${def.coveringIndex}' which is not defined in any migration. Available indexes: ${Array.from(
        migrationIndexes,
      )
        .sort((a, b) => a.localeCompare(b))
        .join(', ')}`,
    );
  }
});

test('every retention query def specifies a non-empty orderColumn for deterministic ordering', () => {
  for (const [key, def] of Object.entries(RETENTION_QUERY_DEFS)) {
    assert.ok(
      typeof def.orderColumn === 'string' && def.orderColumn.length > 0,
      `Retention query '${key}' has empty or missing orderColumn`,
    );
  }
});

test('every retention query def specifies a non-empty idColumn for batch delete', () => {
  for (const [key, def] of Object.entries(RETENTION_QUERY_DEFS)) {
    assert.ok(
      typeof def.idColumn === 'string' && def.idColumn.length > 0,
      `Retention query '${key}' has empty or missing idColumn`,
    );
  }
});

test('every retention query def specifies a non-empty boundsColumn for range queries', () => {
  for (const [key, def] of Object.entries(RETENTION_QUERY_DEFS)) {
    assert.ok(
      typeof def.boundsColumn === 'string' && def.boundsColumn.length > 0,
      `Retention query '${key}' has empty or missing boundsColumn`,
    );
  }
});

test('context_packs uses pack_id as idColumn (not id)', () => {
  const def = RETENTION_QUERY_DEFS.ai_context_packs;
  assert.equal(def.idColumn, 'pack_id');
  assert.equal(def.table, 'ai_context_packs');
});

test('memory_deltas uses delta_id as idColumn (not id)', () => {
  const def = RETENTION_QUERY_DEFS.ai_memory_deltas;
  assert.equal(def.idColumn, 'delta_id');
  assert.equal(def.table, 'ai_memory_deltas');
});

test('sessions uses session_id as idColumn and started_at as boundsColumn', () => {
  const def = RETENTION_QUERY_DEFS.ai_sessions;
  assert.equal(def.idColumn, 'session_id');
  assert.equal(def.boundsColumn, 'started_at');
  assert.equal(def.orderColumn, 'started_at, session_id');
});

test('virtual table keys resolve to physical ai_memory_entries table', () => {
  assert.equal(RETENTION_QUERY_DEFS.ai_memory_entries_expired.table, 'ai_memory_entries');
  assert.equal(RETENTION_QUERY_DEFS.ai_memory_entries_retired.table, 'ai_memory_entries');
});

test('buildCondition produces valid SQL fragments with default config', () => {
  const config = {
    auditDays: 180,
    batchSize: 1000,
    expiredGraceDays: 30,
    failureDays: 30,
    sessionDays: 90,
    sessionSummaryDays: 14,
    supersededDays: 180,
    telemetryDays: 90,
  };

  for (const [key, def] of Object.entries(RETENTION_QUERY_DEFS)) {
    const condition = def.buildCondition(config);
    assert.ok(
      typeof condition === 'string' && condition.length > 0,
      `buildCondition for '${key}' returned empty string`,
    );
    // Verify no template literal placeholders remain
    assert.ok(
      !condition.includes('undefined') && !condition.includes('NaN'),
      `buildCondition for '${key}' contains unresolved value: ${condition}`,
    );
  }
});

test('expired session-summary condition includes category and expires_at predicates', () => {
  const config = {
    auditDays: 180,
    batchSize: 1000,
    expiredGraceDays: 30,
    failureDays: 30,
    sessionDays: 90,
    sessionSummaryDays: 14,
    supersededDays: 180,
    telemetryDays: 90,
  };

  const condition = RETENTION_QUERY_DEFS.ai_memory_entries_expired.buildCondition(config);
  assert.ok(condition.includes("category = 'session-summary'"));
  assert.ok(condition.includes('expires_at IS NOT NULL'));
  assert.ok(condition.includes('expires_at <='));
});

test('retired durable condition includes status and updated_at predicates', () => {
  const config = {
    auditDays: 180,
    batchSize: 1000,
    expiredGraceDays: 30,
    failureDays: 30,
    sessionDays: 90,
    sessionSummaryDays: 14,
    supersededDays: 180,
    telemetryDays: 90,
  };

  const condition = RETENTION_QUERY_DEFS.ai_memory_entries_retired.buildCondition(config);
  assert.ok(condition.includes("'superseded'"));
  assert.ok(condition.includes("'archived'"));
  assert.ok(condition.includes('updated_at'));
});

test('orphaned events condition includes NOT EXISTS and memory_id reference', () => {
  const config = {
    auditDays: 180,
    batchSize: 1000,
    expiredGraceDays: 30,
    failureDays: 30,
    sessionDays: 90,
    sessionSummaryDays: 14,
    supersededDays: 180,
    telemetryDays: 90,
  };

  const condition = RETENTION_QUERY_DEFS.ai_memory_events.buildCondition(config);
  assert.ok(condition.includes('NOT EXISTS'));
  assert.ok(condition.includes('ai_memory_events.memory_id'));
  assert.ok(condition.includes('created_at'));
});

/**
 * Extract index column lists from migration CREATE INDEX statements.
 * Returns a map of index_name → column list string (e.g. "created_at, id").
 */
function collectMigrationIndexColumns(sql: string): Map<string, string> {
  const map = new Map<string, string>();
  const pattern = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+(\w+)\s+ON\s+\w+\(([^)]+)\)/gi;

  let match: null | RegExpExecArray;
  while ((match = pattern.exec(sql)) !== null) {
    const indexName: string | undefined = match[1];
    const columns: string | undefined = match[2];
    if (indexName !== undefined && indexName.length > 0 && columns !== undefined && columns.length > 0) {
      // Normalize whitespace
      map.set(indexName, columns.replace(/\s+/g, ' ').trim());
    }
  }

  return map;
}

test('every orderColumn is index-aligned: leading columns match covering index', async () => {
  const indexColumns = collectMigrationIndexColumns(await readMigrationSql());

  for (const [key, def] of Object.entries(RETENTION_QUERY_DEFS)) {
    const indexCols = indexColumns.get(def.coveringIndex);
    assert.ok(indexCols !== undefined, `Covering index '${def.coveringIndex}' for '${key}' not found in migrations`);

    // Normalize column lists by splitting on comma and trimming whitespace
    const orderCols = def.orderColumn.split(',').map(c => c.trim());
    const idxCols = indexCols.split(',').map(c => c.trim());

    // The orderColumn columns must match the index columns in order
    assert.deepEqual(
      orderCols,
      idxCols,
      `ORDER BY columns for '${key}' (${orderCols.join(', ')}) do not match covering index '${def.coveringIndex}' columns (${idxCols.join(', ')})`,
    );
  }
});

test('every orderColumn ends with idColumn as deterministic tie-breaker', () => {
  for (const [key, def] of Object.entries(RETENTION_QUERY_DEFS)) {
    const orderCols = def.orderColumn.split(',').map(c => c.trim());
    assert.ok(orderCols.length > 0, `orderColumn for '${key}' produced empty column list`);
    assert.equal(
      orderCols[orderCols.length - 1],
      def.idColumn,
      `ORDER BY for '${key}' must end with idColumn '${def.idColumn}' for deterministic ordering`,
    );
  }
});

test('DELETE query shape: filter + order satisfied by covering index', () => {
  const config = {
    auditDays: 180,
    batchSize: 1000,
    expiredGraceDays: 30,
    failureDays: 30,
    sessionDays: 90,
    sessionSummaryDays: 14,
    supersededDays: 180,
    telemetryDays: 90,
  };

  for (const [key, def] of Object.entries(RETENTION_QUERY_DEFS)) {
    const condition = def.buildCondition(config);
    const deleteSql = `DELETE FROM ${def.table} WHERE ${def.idColumn} IN (SELECT ${def.idColumn} FROM ${def.table} WHERE ${condition} ORDER BY ${def.orderColumn} ASC LIMIT 1000)`;

    // Verify the generated SQL includes the expected ORDER BY clause
    assert.ok(
      deleteSql.includes(`ORDER BY ${def.orderColumn} ASC`),
      `DELETE query for '${key}' missing expected ORDER BY '${def.orderColumn}': ${deleteSql.substring(0, 120)}`,
    );

    // Verify the filter references the bounds/predicate column used by the index
    const orderLeadingCol = def.orderColumn.split(',')[0]?.trim() ?? '';
    assert.ok(
      condition.includes(orderLeadingCol) || deleteSql.includes(orderLeadingCol),
      `DELETE query for '${key}' does not reference leading order column '${orderLeadingCol}' in its condition`,
    );
  }
});

test('retention indexes in migrations are additive (CREATE INDEX IF NOT EXISTS)', async () => {
  const sql = await readMigrationSql();

  for (const def of Object.values(RETENTION_QUERY_DEFS)) {
    assert.match(
      sql,
      new RegExp(`CREATE\\s+INDEX\\s+IF\\s+NOT\\s+EXISTS\\s+${def.coveringIndex}\\b`, 'iu'),
      `Retention covering index '${def.coveringIndex}' must be additive in migrations`,
    );
  }
});
