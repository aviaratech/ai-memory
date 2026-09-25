import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';

function readBaselineMigration(): Promise<string> {
  return readFile(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations', '001_baseline.sql'), 'utf-8');
}

function readSearchableProvenanceMigration(): Promise<string> {
  return readFile(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations', '003_searchable_provenance.sql'),
    'utf-8',
  );
}

test('baseline migration includes nullable write-calibration confidence columns', async () => {
  const sql = await readBaselineMigration();

  assert.match(sql, /ADD COLUMN IF NOT EXISTS declared_confidence DOUBLE PRECISION/u);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS calibrated_confidence DOUBLE PRECISION/u);
  assert.match(sql, /declared_confidence IS NULL OR \(declared_confidence >= 0 AND declared_confidence <= 1\)/u);
  assert.match(sql, /calibrated_confidence IS NULL OR \(calibrated_confidence >= 0 AND calibrated_confidence <= 1\)/u);
});

test('searchable-provenance migration replaces the search index only after creating the compatible expression', async () => {
  const sql = await readSearchableProvenanceMigration();
  const createTagFunctionAt = sql.indexOf('CREATE OR REPLACE FUNCTION ai_memory_tags_to_search_text');
  const createIndexAt = sql.indexOf('CREATE INDEX IF NOT EXISTS ai_memory_entries_search_v2_idx');
  const dropIndexAt = sql.indexOf('DROP INDEX IF EXISTS ai_memory_entries_search_idx');

  assert.ok(createTagFunctionAt >= 0, 'expected an immutable text-array helper for the search index');
  assert.ok(createIndexAt > createTagFunctionAt, 'must define the immutable tag helper before creating its index');
  assert.ok(createIndexAt >= 0, 'expected the compatible replacement search index');
  assert.ok(dropIndexAt > createIndexAt, 'must retain the existing index until its replacement exists');
  assert.match(sql, /RETURNS TEXT[\s\S]*?IMMUTABLE[\s\S]*?array_to_string\(tags, ' '\)/u);
  for (const field of ['coalesce(source', 'coalesce(memory_key', 'ai_memory_tags_to_search_text(tags)']) {
    assert.ok(sql.includes(field), `migration must index provenance field ${field}`);
  }
});
