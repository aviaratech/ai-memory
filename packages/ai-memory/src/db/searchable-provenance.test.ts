import assert from 'node:assert/strict';
import { test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SEARCH_VECTOR_SQL } from './runtime.js';

test('search candidates index compact provenance keys alongside memory content', () => {
  for (const field of ['source', 'memory_key', 'evidence_refs::text', 'ai_memory_tags_to_search_text(tags)']) {
    assert.ok(
      SEARCH_VECTOR_SQL.includes(field),
      `search vector must include ${field} so a known harness, record key, or tag is naturally retrievable`,
    );
  }
});

test('reference index matches the runtime expression and retains the index used by older bundles', () => {
  const migration = readFileSync(
    fileURLToPath(new URL('../../migrations/004_reference_search_terms.sql', import.meta.url)),
    'utf8',
  );
  const compact = (value: string) => value.replace(/\s+/gu, ' ').trim();
  assert.ok(compact(migration).includes(`USING GIN ( ${compact(SEARCH_VECTOR_SQL)} )`));
  assert.ok(SEARCH_VECTOR_SQL.includes('ai_memory_reference_search_terms(content, memory_key, evidence_refs, tags)'));
  assert.match(migration, /CREATE FUNCTION ai_memory_reference_search_terms/u);
  assert.match(migration, /IMMUTABLE/u);
  assert.match(migration, /SELECT memory_content UNION ALL SELECT memory_key/u);
  assert.match(migration, /jsonb_array_elements/u);
  assert.match(migration, /unnest\(memory_tags\)/u);
  assert.doesNotMatch(migration, /DROP INDEX|ALTER INDEX|UPDATE ai_memory_entries|DELETE FROM/iu);
});
