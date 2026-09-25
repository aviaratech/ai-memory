import assert from 'node:assert/strict';
import { describe, test } from 'vitest';

import {
  buildMemoryInsertReturningSql,
  buildMemoryUpdateByIdSql,
  buildMemoryUpsertByMemoryKeySql,
} from './memory-sql.js';

describe('memory write SQL builders', () => {
  test('include embedding column and params when hasEmbeddingColumn is true', () => {
    const insertSql = buildMemoryInsertReturningSql(true);
    const upsertSql = buildMemoryUpsertByMemoryKeySql(true);
    const updateSql = buildMemoryUpdateByIdSql(true);

    assert.ok(insertSql.includes('embedding'));
    assert.ok(insertSql.includes('$29'));
    assert.ok(insertSql.includes('memory_type'));
    assert.ok(insertSql.includes('importance'));
    assert.ok(insertSql.includes('declared_confidence'));
    assert.ok(insertSql.includes('calibrated_confidence'));
    assert.ok(upsertSql.includes('memory_type = EXCLUDED.memory_type'));
    assert.ok(upsertSql.includes('declared_confidence = EXCLUDED.declared_confidence'));
    assert.ok(upsertSql.includes('calibrated_confidence = EXCLUDED.calibrated_confidence'));
    assert.ok(upsertSql.includes('importance = EXCLUDED.importance'));
    assert.ok(upsertSql.includes('embedding = EXCLUDED.embedding'));
    assert.ok(updateSql.includes('memory_type = $4'));
    assert.ok(updateSql.includes('confidence = $7'));
    assert.ok(updateSql.includes('declared_confidence = $8'));
    assert.ok(updateSql.includes('calibrated_confidence = $9'));
    assert.ok(updateSql.includes('importance = $10'));
    assert.ok(updateSql.includes('embedding = $29'));
    assert.ok(updateSql.includes('WHERE id = $30'));
  });

  test('omit embedding column and params when hasEmbeddingColumn is false', () => {
    const insertSql = buildMemoryInsertReturningSql(false);
    const upsertSql = buildMemoryUpsertByMemoryKeySql(false);
    const updateSql = buildMemoryUpdateByIdSql(false);

    assert.ok(!insertSql.includes('embedding'));
    assert.ok(insertSql.includes('memory_type'));
    assert.ok(insertSql.includes('declared_confidence'));
    assert.ok(insertSql.includes('calibrated_confidence'));
    assert.ok(insertSql.includes('importance'));
    assert.ok(upsertSql.includes('memory_type = EXCLUDED.memory_type'));
    assert.ok(upsertSql.includes('declared_confidence = EXCLUDED.declared_confidence'));
    assert.ok(upsertSql.includes('calibrated_confidence = EXCLUDED.calibrated_confidence'));
    assert.ok(upsertSql.includes('importance = EXCLUDED.importance'));
    assert.ok(!upsertSql.includes('embedding = EXCLUDED.embedding'));
    assert.ok(updateSql.includes('memory_type = $4'));
    assert.ok(updateSql.includes('confidence = $7'));
    assert.ok(updateSql.includes('declared_confidence = $8'));
    assert.ok(updateSql.includes('calibrated_confidence = $9'));
    assert.ok(updateSql.includes('importance = $10'));
    assert.ok(!updateSql.includes('embedding = $29'));
    assert.ok(updateSql.includes('WHERE id = $29'));
  });
});
