import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'vitest';

import {
  assertLocalDatabaseUrl,
  closePool,
  getCapabilities,
  initializeDatabase,
  resetEmbeddingProvider,
  searchMemories,
  storeMemory,
} from '@aviaratech/ai-memory/internal';
import { Pool } from 'pg';

import {
  buildMemorySearchMatchQuerySql,
  buildMemorySearchOrRankSql,
  buildMemorySearchSemanticRankSql,
} from './memory-sql.js';
import { normalizeSearchReferenceText } from './query-helpers.js';
import { SEARCH_VECTOR_SQL } from './runtime.js';

const databaseUrl = process.env.AI_MEMORY_DATABASE_URL;
const vector = (index: number) => Array.from({ length: 1536 }, (_, position) => Number(position === index));

const RANK_DOCUMENTS = [
  '',
  'the and or',
  'forest canopy sample',
  'canopy forest forest forests',
  'run running runs',
  'harbor forest canopy tide',
  'café naïve résumé Überprüfung',
  'cafe\u0301 naïve',
  'issue4821 source ledger',
  'issue 4821 source ledger',
  '1 12 123 0123 1.2 3_4',
  'forest '.repeat(300),
  'forest harbor canopy '.repeat(1000),
];
const RANK_RAW_VECTORS = [
  '',
  "'forest'",
  "'forest' 'canopi':1D,2A 'harbor':1A,3C",
  "'forest':1A,2B,3C,4D 'canopi':1D,4A 'harbor':1C,2D",
  "'forest':1D,16382A,16383B 'canopi':16383C",
  "'run':1A,2D 'forest':1B 'harbor':1C",
];
const RANK_QUERIES = [
  '',
  '!!!',
  'the and or',
  'forest',
  'absent',
  'forest forest forests',
  'forests canopy forest',
  'run running runs',
  'forest OR harbor',
  '"forest canopy"',
  '"canopy forest"',
  '-forest -harbor',
  'forest -harbor',
  '"forest canopy" OR -harbor',
  'forest* :A',
  'canopy-forest',
  "forest's canopy",
  'forest_harbor',
  'issue4821',
  'Issue #4821',
  'PR_4821',
  'issues/4821 -harbor',
  '4821 samples',
  '1 12 123 0123',
  'https://example.invalid/issues/4821',
  'café naïve résumé',
  'cafe\u0301 naïve',
  'Überprüfung',
  '森林 canopy',
  'forest '.repeat(80),
  Array.from({ length: 80 }, (_, index) => `absent${String(index)}`).join(' ') + ' forest canopy',
];
const RANK_ROW_COUNT = RANK_DOCUMENTS.length * 7 + RANK_RAW_VECTORS.length;
// Query parameters: $1 query, $2 documents, $3 raw vectors.
const RANK_VECTORS_SQL = `WITH records AS (
        SELECT content, 'synthetic/reference'::text AS project, 'convention'::text AS category,
          'synthetic-source'::text AS source, 'fixture:issue4821'::text AS memory_key,
          '["https://example.invalid/issues/4821", {"source":"PR4822"}]'::jsonb AS evidence_refs,
          ARRAY['canopy','issue4823']::text[] AS tags FROM unnest($2::text[]) AS docs(content)
      ), vectors AS (
        SELECT 'plain:' || content AS label, to_tsvector('english',content) AS search_vector FROM records
        UNION ALL SELECT 'canonical:' || content, ${SEARCH_VECTOR_SQL} FROM records
        UNION ALL SELECT 'stripped:' || content, strip(to_tsvector('english',content)) FROM records
        UNION ALL SELECT weight || ':' || content, setweight(to_tsvector('english',content), weight::"char") FROM records CROSS JOIN unnest(ARRAY['A','B','C','D']) AS weights(weight)
        UNION ALL SELECT 'raw:' || vector_text, vector_text::tsvector FROM unnest($3::text[]) AS raw(vector_text)
      )`;
const rankQueryVariants = () => new Set(RANK_QUERIES.flatMap(value => [value, normalizeSearchReferenceText(value)]));

test(
  'positive token-OR ranks preserve exact float4 bytes for every document and query variant',
  { skip: databaseUrl === undefined },
  async () => {
    assert.ok(databaseUrl);
    assertLocalDatabaseUrl(databaseUrl);
    const verificationPool = new Pool({ connectionString: databaseUrl });
    // Independent pre-correction oracle: preserve each rank, not merely GREATEST
    // or selected candidates that could hide a per-query difference.
    const tokens = `nullif(regexp_replace(trim(regexp_replace(lower($1), '[^[:alnum:]]+', ' ', 'g')), '[[:space:]]+', ' OR ', 'g'), '')`;
    const prior = `CASE WHEN ${tokens} IS NOT NULL THEN ts_rank_cd(search_vector, websearch_to_tsquery('english', ${tokens})) ELSE 0 END`;
    try {
      await initializeDatabase();
      for (const query of rankQueryVariants()) {
        const result = await verificationPool.query<{ after: string; before: string; label: string }>(
          `${RANK_VECTORS_SQL} SELECT label, encode(float4send(${prior}), 'hex') AS before,
        encode(float4send(${buildMemorySearchOrRankSql('$1')}), 'hex') AS after FROM vectors`,
          [query, RANK_DOCUMENTS, RANK_RAW_VECTORS],
        );
        assert.equal(result.rows.length, RANK_ROW_COUNT);
        for (const row of result.rows)
          assert.equal(row.after, row.before, JSON.stringify({ query, fixture: row.label.slice(0, 100) }));
      }
    } finally {
      await verificationPool.end();
    }
  },
);

test(
  'detoasted vectors and the guarded semantic rank preserve exact float4 bytes',
  { skip: databaseUrl === undefined },
  async () => {
    assert.ok(databaseUrl);
    assertLocalDatabaseUrl(databaseUrl);
    const verificationPool = new Pool({ connectionString: databaseUrl });
    try {
      await initializeDatabase();
      for (const query of rankQueryVariants()) {
        // Search ranks a detoasted copy of each stored vector; the oracle ranks the original.
        const result = await verificationPool.query<{
          label: string;
          or_after: string;
          or_before: string;
          semantic_after: string;
          semantic_before: string;
        }>(
          `${RANK_VECTORS_SQL}, ranked AS (
        SELECT label,
          encode(float4send(ts_rank_cd(search_vector, websearch_to_tsquery('english', $1))), 'hex') AS semantic_before,
          encode(float4send(${buildMemorySearchOrRankSql('$1')}), 'hex') AS or_before,
          (search_vector || ''::tsvector) AS detoasted_vector
        FROM vectors
      ) SELECT label, semantic_before, or_before,
        encode(float4send(${buildMemorySearchSemanticRankSql('$1').replaceAll('search_vector', 'detoasted_vector')}), 'hex') AS semantic_after,
        encode(float4send(${buildMemorySearchOrRankSql('$1').replaceAll('search_vector', 'detoasted_vector')}), 'hex') AS or_after
      FROM ranked`,
          [query, RANK_DOCUMENTS, RANK_RAW_VECTORS],
        );
        assert.equal(result.rows.length, RANK_ROW_COUNT);
        for (const row of result.rows) {
          const fixture = JSON.stringify({ query, fixture: row.label.slice(0, 100) });
          assert.equal(row.semantic_after, row.semantic_before, `semantic ${fixture}`);
          assert.equal(row.or_after, row.or_before, `token-OR ${fixture}`);
        }
      }
    } finally {
      await verificationPool.end();
    }
  },
);

test(
  'stored search vector stays exact across insert, upsert and contributing-field updates',
  { skip: databaseUrl === undefined },
  async () => {
    assert.ok(databaseUrl);
    assertLocalDatabaseUrl(databaseUrl);
    const verificationPool = new Pool({ connectionString: databaseUrl });
    const project = `ci/stored-vector-${randomUUID()}`;
    let id: number | undefined;
    const check = async () => {
      const result = await verificationPool.query<{ exact: boolean }>(
        `SELECT search_vector::text = (${SEARCH_VECTOR_SQL})::text AS exact FROM ai_memory_entries WHERE id=$1`,
        [id],
      );
      assert.equal(result.rows[0]?.exact, true);
    };
    try {
      await initializeDatabase();
      const input = {
        category: 'convention',
        confidence: 0.8,
        content: 'Synthetic forest issue4821',
        memoryKey: `${project}:key`,
        project,
        source: 'integration-test',
        tags: ['forest'],
        evidenceRefs: ['https://example.invalid/issues/4821'],
      };
      const inserted = await storeMemory(input);
      id = inserted.id;
      await check();
      const upserted = await storeMemory({
        ...input,
        content: 'Synthetic harbor issue4822',
        tags: ['harbor'],
        evidenceRefs: ['https://example.invalid/issues/4822'],
      });
      assert.equal(upserted.id, id);
      await check();
      const updates = [
        ['content', 'Synthetic canopy issue4823'],
        ['project', `${project}/updated`],
        ['category', 'implementation-note'],
        ['source', 'synthetic-updated'],
        ['memory_key', `${project}:issue4824`],
        ['evidence_refs', JSON.stringify(['https://example.invalid/issues/4825', { source: 'issue4826' }])],
        ['tags', ['canopy', 'issue4827']],
      ] as const;
      for (const [column, value] of updates) {
        await verificationPool.query(`UPDATE ai_memory_entries SET ${column}=$2 WHERE id=$1`, [id, value]);
        await check();
      }
      const generated = await verificationPool.query<{ generated: string }>(
        "SELECT attgenerated AS generated FROM pg_attribute WHERE attrelid='ai_memory_entries'::regclass AND attname='search_vector'",
      );
      assert.equal(generated.rows[0]?.generated, 's');
    } finally {
      try {
        if (id !== undefined) await verificationPool.query('DELETE FROM ai_memory_entries WHERE id=$1', [id]);
      } finally {
        await verificationPool.end();
      }
    }
  },
);

test(
  'combined full-text membership preserves original and normalized query matches',
  { skip: databaseUrl === undefined },
  async () => {
    assert.ok(databaseUrl);
    assertLocalDatabaseUrl(databaseUrl);
    const verificationPool = new Pool({ connectionString: databaseUrl });
    const contents = [
      '',
      'forest canopy sample',
      'forest harbor sample',
      'harbor tide sample',
      'the and or',
      'issue4821 accepted reference',
      'issue 4821 accepted reference',
      '4821 measured samples',
      'source decision ledger',
      'café naïve résumé',
      'source review publication checkpoint preserved supporting evidence',
    ];
    const queries = [
      'forest canopy',
      '"forest canopy"',
      '"canopy forest"',
      'forest OR harbor',
      'forest -harbor',
      '-harbor',
      '-forest -harbor',
      '"forest canopy" OR -harbor',
      'the and or',
      '!!!',
      'issue4821',
      'issue #4821',
      'issues/4821 -harbor',
      '4821 samples',
      'café naïve',
      'source decision ledger accepted supporting evidence issue4821 current checkpoint review publication',
    ];
    // The pre-correction predicate is the oracle for membership, including its
    // token-OR additions to phrase and negative websearch queries.
    const priorMatch = (param: string) => {
      const tokens = `nullif(regexp_replace(trim(regexp_replace(lower(${param}), '[^[:alnum:]]+', ' ', 'g')), '[[:space:]]+', ' OR ', 'g'), '')`;
      return `(search_vector @@ websearch_to_tsquery('english', ${param}) OR
      (${tokens} IS NOT NULL AND search_vector @@ websearch_to_tsquery('english', ${tokens})))`;
    };
    try {
      for (const query of queries) {
        const result = await verificationPool.query<{ after: boolean; before: boolean; content: string }>(
          `WITH fixture AS (
          SELECT content, to_tsvector('english', content) AS search_vector
          FROM unnest($3::text[]) AS documents(content)
        )
        SELECT content,
          (${priorMatch('$1')} OR ${priorMatch('$2')}) AS before,
          search_vector @@ (${buildMemorySearchMatchQuerySql('$1')} || ${buildMemorySearchMatchQuerySql('$2')}) AS after
        FROM fixture`,
          [query, normalizeSearchReferenceText(query), contents],
        );
        assert.equal(result.rows.length, contents.length);
        for (const row of result.rows) {
          assert.equal(
            row.after,
            row.before,
            `membership changed for ${JSON.stringify({ content: row.content, query })}`,
          );
        }
      }
    } finally {
      await verificationPool.end();
    }
  },
);

test('pgvector memory write and search round trip', { skip: databaseUrl === undefined }, async () => {
  assert.ok(databaseUrl);
  assertLocalDatabaseUrl(databaseUrl);
  const project = `ci/vector-${randomUUID()}`;
  const targetContent = 'Synthetic forest canopy sample';
  const decoyContent = 'Synthetic harbor tide sample';
  const query = 'orbital violet lookup';
  const originalFetch = globalThis.fetch;
  const originalProvider = process.env.AI_MEMORY_EMBEDDING_PROVIDER;
  const originalKey = process.env.AI_MEMORY_EMBEDDING_API_KEY;
  const verificationPool = new Pool({ connectionString: databaseUrl });
  let databaseReady = false;

  try {
    await initializeDatabase();
    databaseReady = true;
    assert.deepEqual(getCapabilities(), {
      hasEmbeddingColumn: true,
      hasTrigram: true,
      hasVector: true,
    });
    console.log('PostgreSQL vector, embedding column, and pg_trgm capabilities available');

    process.env.AI_MEMORY_EMBEDDING_PROVIDER = 'openai';
    process.env.AI_MEMORY_EMBEDDING_API_KEY = 'synthetic-local-fixture';
    resetEmbeddingProvider();
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string };
      assert.ok([targetContent, decoyContent, query].includes(body.input));
      return new Response(JSON.stringify({ data: [{ embedding: vector(body.input === decoyContent ? 1 : 0) }] }), {
        status: 200,
      });
    };

    const target = await storeMemory({
      category: 'implementation-note',
      confidence: 0.8,
      content: targetContent,
      project,
      source: 'integration-test',
    });
    await storeMemory({
      category: 'implementation-note',
      confidence: 0.8,
      content: decoyContent,
      project,
      source: 'integration-test',
    });
    const stored = await verificationPool.query<{ distance: number }>(
      'SELECT embedding <=> $2::vector AS distance FROM ai_memory_entries WHERE id = $1',
      [target.id, JSON.stringify(vector(0))],
    );
    assert.equal(stored.rows[0]?.distance, 0);

    const withoutVector = await searchMemories({ includeEmbedding: false, project, query });
    assert.deepEqual(withoutVector, []);
    const results = await searchMemories({ project, query });
    assert.equal(results[0]?.id, target.id);
    console.log('Synthetic vector write/search round trip returned the nearest memory');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalProvider === undefined) delete process.env.AI_MEMORY_EMBEDDING_PROVIDER;
    else process.env.AI_MEMORY_EMBEDDING_PROVIDER = originalProvider;
    if (originalKey === undefined) delete process.env.AI_MEMORY_EMBEDDING_API_KEY;
    else process.env.AI_MEMORY_EMBEDDING_API_KEY = originalKey;
    resetEmbeddingProvider();
    try {
      if (databaseReady) await verificationPool.query('DELETE FROM ai_memory_entries WHERE project = $1', [project]);
    } finally {
      await verificationPool.end();
      await closePool();
    }
  }
});
