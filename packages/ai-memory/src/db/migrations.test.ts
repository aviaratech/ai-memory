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

test('index-first search migration builds the new indexes before dropping the old ones', async () => {
  const sql = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations', '010_index_first_search.sql'),
    'utf-8',
  );
  const statements = sql.replace(/^--.*$/gmu, '');
  const at = (text: string) => {
    const index = statements.indexOf(text);
    assert.ok(index >= 0, `expected ${text}`);
    return index;
  };
  const createSearch = at('CREATE INDEX IF NOT EXISTS ai_memory_entries_search_vector_idx');
  const createAuthor = at('CREATE INDEX IF NOT EXISTS ai_memory_entries_author_category_created_v2_idx');
  const dropSearch = at('DROP INDEX IF EXISTS ai_memory_entries_search_idx');
  const dropReference = at('DROP INDEX IF EXISTS ai_memory_entries_reference_search_idx');
  const dropAuthor = at('DROP INDEX IF EXISTS ai_memory_entries_author_category_created_idx');
  const rename = at('ALTER INDEX ai_memory_entries_author_category_created_v2_idx RENAME TO');

  assert.match(statements, /USING GIN \(search_vector\)\s+WITH \(fastupdate = off\)/u);
  assert.match(statements, /\(lower\(category\)\)/u, 'the author index must key on lower(category) like its lookups');
  for (const drop of [dropSearch, dropReference, dropAuthor]) {
    assert.ok(drop > createSearch && drop > createAuthor, 'every drop follows both builds');
  }
  assert.ok(rename > dropAuthor, 'the replacement takes the old index name after the old one is gone');
  const mergePending = at("gin_clean_pending_list('ai_memory_entries_tags_gin_idx'::regclass)");
  const setFastupdate = at('ALTER INDEX IF EXISTS ai_memory_entries_tags_gin_idx SET (fastupdate = off)');
  assert.ok(
    mergePending < setFastupdate && setFastupdate < dropSearch,
    'the tags index is read on every search, so it must not carry a pending list; merge before the exclusive lock',
  );
  assert.ok(createSearch < mergePending, 'builds come before the statements that take exclusive locks');
  assert.ok(!statements.includes('CONCURRENTLY'), 'migrations run in a transaction, where CONCURRENTLY is invalid');
});
