import assert from 'node:assert/strict';
import { describe, test } from 'vitest';

import {
  buildMemoryInsertReturningSql,
  buildMemorySearchPoolCtes,
  buildMemoryUpdateByIdSql,
  buildMemoryUpsertByMemoryKeySql,
  SEARCH_CHANNEL_ROW_CAP,
  SEARCH_COMMON_TERM_ROW_LIMIT,
  SEARCH_MIN_POOL_ROWS,
  SEARCH_PROBE_LEXEME_LIMIT,
} from './memory-sql.js';

describe('memory write SQL builders', () => {
  test('include embedding column and params when hasEmbeddingColumn is true', () => {
    const insertSql = buildMemoryInsertReturningSql(true);
    const upsertSql = buildMemoryUpsertByMemoryKeySql(true);
    const updateSql = buildMemoryUpdateByIdSql(true);

    assert.ok(insertSql.includes('embedding'));
    assert.ok(insertSql.includes('$32'));
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
    assert.ok(updateSql.includes('embedding = $32'));
    assert.ok(updateSql.includes('WHERE id = $33'));
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
    assert.ok(!updateSql.includes('embedding = $32'));
    assert.ok(updateSql.includes('WHERE id = $32'));
  });
});

describe('index-first search candidate pool', () => {
  const poolInput = {
    baseConditions: ["status IN ('active', 'contested')", 'project = $7'],
    exactKeysParam: '$5',
    exactTagsParam: '$6',
    queryParams: ['$1'],
  };

  /** Body of one CTE, up to the next top-level CTE. */
  function cte(sql: string, name: string): string {
    const start = sql.indexOf(`${name} AS`);
    assert.ok(start >= 0, `expected CTE ${name}`);
    const rest = sql.slice(start);
    const end = rest.search(/\n {4}\),\n {4}\w+ AS/u);
    return end < 0 ? rest : rest.slice(0, end);
  }

  test('reads each channel through one index and caps every channel', () => {
    const sql = buildMemorySearchPoolCtes(poolInput);

    assert.ok(cte(sql, 'search_query').includes("websearch_to_tsquery('english', $1)"));
    assert.ok(
      cte(sql, 'phrase_candidates').includes('search_vector @@ (SELECT web_query FROM search_query)'),
      'the websearch query is read as a parameter so the planner uses the full-text index',
    );
    assert.ok(sql.includes('quote_literal(probes.lexeme)::tsquery'), 'term probes look each lexeme up by index');
    assert.ok(sql.includes('memory_key = ANY($5::text[])'));
    assert.ok(sql.includes('tags && $6::text[]'));
    assert.match(
      sql,
      /text_pool AS MATERIALIZED \(\s+SELECT id FROM phrase_candidates\s+UNION\s+SELECT id FROM term_candidates\s+UNION\s+SELECT id FROM exact_candidates\s+UNION\s+SELECT id FROM fill_candidates/u,
    );
    assert.equal(
      (sql.match(new RegExp(`LIMIT ${String(SEARCH_CHANNEL_ROW_CAP)}\\b`, 'gu')) ?? []).length,
      5,
      'phrase, term, memory-key, tag, and fill reads are each capped',
    );
    assert.ok(sql.includes(`LIMIT ${String(SEARCH_PROBE_LEXEME_LIMIT)}`), 'the number of probed terms is bounded');
    assert.ok(
      sql.includes(`LIMIT ${String(SEARCH_COMMON_TERM_ROW_LIMIT + 1)}`),
      'a probe stops one row past the common-term limit',
    );
    assert.ok(
      sql.includes(`HAVING count(*) <= ${String(SEARCH_COMMON_TERM_ROW_LIMIT)}`),
      'terms too common to enumerate do not select candidates',
    );
  });

  test('applies the base conditions to every read of every channel', () => {
    const sql = buildMemorySearchPoolCtes({ ...poolInput, reference: { numbersParam: '$3', patternParam: '$4' } });
    for (const name of ['phrase_candidates', 'term_hits', 'reference_candidates', 'fill_candidates']) {
      const body = cte(sql, name);
      assert.ok(body.includes("status IN ('active', 'contested')"), `${name} must filter by status`);
      assert.ok(body.includes('project = $7'), `${name} must filter by project`);
    }
    const exact = cte(sql, 'exact_candidates');
    const reads = exact.split('UNION ALL');
    assert.equal(reads.length, 2, 'the exact channel reads the memory-key and tag indexes separately');
    for (const read of reads) {
      assert.ok(read.includes("status IN ('active', 'contested')") && read.includes('project = $7'));
    }
    assert.ok(reads[0]?.includes('memory_key = ANY'));
    assert.ok(reads[1]?.includes('tags &&'));
  });

  test('looks up reference numbers by index and confirms them in the same read', () => {
    const withReference = buildMemorySearchPoolCtes({
      ...poolInput,
      reference: { numbersParam: '$3', patternParam: '$4' },
    });
    const channel = cte(withReference, 'reference_candidates');
    assert.ok(channel.indexOf('search_vector @@ (') < channel.indexOf('~ $4'));
    assert.ok(channel.includes('unnest($3::text[])'));
    assert.ok(
      channel.indexOf('~ $4') < channel.indexOf('ORDER BY created_at DESC'),
      'the cap applies after the regex, so older true references are not crowded out by newer plain numbers',
    );
    assert.equal(channel.match(/LIMIT/gu)?.length, 1, 'one cap, after confirmation');
    assert.match(withReference, /UNION\s+SELECT id FROM reference_candidates/u);

    const withoutReference = buildMemorySearchPoolCtes(poolInput);
    assert.ok(!withoutReference.includes('reference_candidates'));
  });

  test('selects goal references only among rows that match a query term', () => {
    const sql = buildMemorySearchPoolCtes({
      ...poolInput,
      goalReference: { numbersParam: '$3', patternParam: '$4' },
    });
    const goal = cte(sql, 'goal_candidates');
    assert.ok(goal.includes('search_vector @@ (SELECT goal_query FROM search_query)'));
    assert.ok(goal.includes('~ $4'));
    assert.ok(goal.includes("status IN ('active', 'contested')") && goal.includes('project = $7'));
    const query = cte(sql, 'search_query');
    assert.match(query, /unnest\(\$3::text\[\]\)[\s\S]*&&[\s\S]*AS goal_query/u);
    assert.match(query, /CASE WHEN numnode\(/u, 'an empty any-term query must admit no goal rows');
    assert.match(sql, /UNION\s+SELECT id FROM goal_candidates/u);
    assert.ok(!buildMemorySearchPoolCtes(poolInput).includes('goal_candidates'));
  });

  test('joins the websearch queries of every text parameter', () => {
    const sql = buildMemorySearchPoolCtes({ ...poolInput, queryParams: ['$1', '$2'] });
    assert.ok(sql.includes("websearch_to_tsquery('english', $1) || websearch_to_tsquery('english', $2)"));
    assert.ok(sql.includes("concat_ws(' ',"), 'probe terms combine the tokens of both text parameters');
  });

  test('negated terms never select candidates', () => {
    const sql = buildMemorySearchPoolCtes(poolInput);
    const strip = "regexp_replace($1, '(^|[[:space:]])-(\"[^\"]*\"|[^[:space:]]+)', ' ', 'g')";
    assert.ok(cte(sql, 'term_probes').includes(strip), 'probe terms drop negated terms');
    assert.ok(cte(sql, 'search_query').includes(strip), 'the any-term query drops negated terms');
  });

  test('probes the longest terms first so a rare term late in a long query is still probed', () => {
    const probes = cte(buildMemorySearchPoolCtes(poolInput), 'term_probes');
    assert.ok(probes.includes('ORDER BY length(lexeme) DESC, positions[1], lexeme'));
  });

  test('fills a thin pool with the newest rows that match any term, and only then', () => {
    const fill = cte(buildMemorySearchPoolCtes(poolInput), 'fill_candidates');
    assert.ok(fill.includes('SELECT id FROM phrase_candidates UNION SELECT id FROM term_candidates'));
    assert.ok(fill.includes(`< ${String(SEARCH_MIN_POOL_ROWS)}`));
    assert.ok(fill.includes('search_vector @@ (SELECT any_term_query FROM search_query)'));
    assert.ok(fill.indexOf('< ') < fill.indexOf('search_vector @@'));
  });
});
