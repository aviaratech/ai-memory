export function buildMemoryInsertReturningSql(hasEmbeddingColumn: boolean) {
  return `
    ${buildMemoryInsertBaseSql(hasEmbeddingColumn)}
    RETURNING *
  `;
}

export function buildMemorySearchKeywordHintSql(queryParam: string) {
  return `(
    lower(content) LIKE '%' || lower(${queryParam}) || '%'
    OR lower(coalesce(project, '')) LIKE '%' || lower(${queryParam}) || '%'
    OR lower(coalesce(category, '')) LIKE '%' || lower(${queryParam}) || '%'
    OR lower(coalesce(source, '')) LIKE '%' || lower(${queryParam}) || '%'
    OR lower(coalesce(memory_key, '')) LIKE '%' || lower(${queryParam}) || '%'
    OR lower(coalesce(evidence_refs::text, '')) LIKE '%' || lower(${queryParam}) || '%'
    OR EXISTS (
      SELECT 1
      FROM unnest(tags) AS tag
      WHERE lower(tag) = lower(${queryParam})
        OR lower(tag) LIKE '%' || lower(${queryParam}) || '%'
    )
  )`;
}

/**
 * Index-first candidate retrieval. Each channel reads its index and is capped;
 * ranks are computed afterwards, only on the union of the channels.
 */
export const SEARCH_CHANNEL_ROW_CAP = 100;
/** A query term that matches more rows than this is too common to enumerate. */
export const SEARCH_COMMON_TERM_ROW_LIMIT = 2_000;
/** Query terms probed in the stored-vector index; the longest terms are probed first (longer terms are rarer). */
export const SEARCH_PROBE_LEXEME_LIMIT = 32;
/** Below this many full-text candidates, the newest rows matching any query term fill the pool. */
export const SEARCH_MIN_POOL_ROWS = 50;

export interface MemorySearchPoolInput {
  /** Conditions every channel applies, written against `ai_memory_entries` columns. */
  baseConditions: string[];
  /** Parameter holding the exact memory keys to look up. */
  exactKeysParam: string;
  /** Parameter holding the exact tags to look up. */
  exactTagsParam: string;
  /** Text parameters that carry the query: the original and, when it differs, the normalized form. */
  queryParams: string[];
  /**
   * Reference lookup: a text[] parameter of issue numbers and the regex pattern parameter. Both must come from
   * the query text alone; references in the active goal may re-rank candidates but never select them.
   */
  reference?: { numbersParam: string; patternParam: string } | undefined;
  /**
   * Rows that match the query (any term) and also hold an issue number from the active goal. The goal only
   * re-ranks rows the query text selects; this channel keeps such rows from falling outside the caps.
   */
  goalReference?: { numbersParam: string; patternParam: string } | undefined;
}

/**
 * Builds the candidate-pool CTEs for search: `text_pool` holds the ids of every
 * row that any channel returned. Channels:
 * - `phrase_candidates`: rows matching the websearch query, newest first;
 * - `term_candidates`: rows matching the rarest query terms, ordered by how
 *   much of the query they cover (a rarity-weighted count);
 * - `exact_candidates`: exact memory-key and tag lookups (two indexes);
 * - `reference_candidates`: issue and pull-request references, through the
 *   number terms the stored vector already holds;
 * - `goal_candidates`: rows that match any query term and hold an issue number
 *   from the active goal;
 * - `fill_candidates`: when the whole-query and rare-term channels found few rows,
 *   the newest rows matching any query term.
 * Every channel reads `search_vector`, `memory_key` or `tags` through its index.
 * Query terms the websearch syntax negates never select candidates.
 */
export function buildMemorySearchPoolCtes(input: MemorySearchPoolInput) {
  const base = input.baseConditions.length > 0 ? `AND ${input.baseConditions.join(' AND ')}` : '';
  const webQuerySql = input.queryParams.map(param => `websearch_to_tsquery('english', ${param})`).join(' || ');
  const positiveTokensSql = input.queryParams.map(param => buildTokenizedOrQuerySql(stripNegatedTermsSql(param)));
  const anyTermQuerySql = positiveTokensSql
    .map(
      tokens => `CASE WHEN ${tokens} IS NOT NULL THEN websearch_to_tsquery('english', ${tokens}) ELSE ''::tsquery END`,
    )
    .join(' || ');
  const channels = ['phrase_candidates', 'term_candidates', 'exact_candidates'];

  // The tsqueries are computed once and read as parameters, so the planner reads
  // the full-text index instead of guessing that a common-looking query is cheap
  // to find by walking rows in recency order.
  const ctes = [
    `search_query AS MATERIALIZED (
      SELECT (${webQuerySql}) AS web_query, (${anyTermQuerySql}) AS any_term_query${
        input.goalReference === undefined
          ? ''
          : `,
        -- An empty any-term query would vanish from the AND and leave the goal numbers alone.
        CASE WHEN numnode(${anyTermQuerySql}) > 0
          THEN (SELECT string_agg(quote_literal(number), ' | ')::tsquery FROM unnest(${input.goalReference.numbersParam}::text[]) AS number) && (${anyTermQuerySql})
        END AS goal_query`
      }
    )`,
    `phrase_candidates AS (
      SELECT id
      FROM ai_memory_entries
      WHERE search_vector @@ (SELECT web_query FROM search_query)
        ${base}
      ORDER BY created_at DESC, id DESC
      LIMIT ${String(SEARCH_CHANNEL_ROW_CAP)}
    )`,
    `term_probes AS MATERIALIZED (
      SELECT lexeme
      FROM unnest(to_tsvector('english', concat_ws(' ', ${positiveTokensSql.join(', ')}))) AS probe(lexeme, positions, weights)
      ORDER BY length(lexeme) DESC, positions[1], lexeme
      LIMIT ${String(SEARCH_PROBE_LEXEME_LIMIT)}
    )`,
    `term_hits AS MATERIALIZED (
      SELECT probes.lexeme, hit.id, hit.created_at
      FROM term_probes AS probes
      CROSS JOIN LATERAL (
        SELECT id, created_at
        FROM ai_memory_entries
        WHERE search_vector @@ quote_literal(probes.lexeme)::tsquery
          ${base}
        LIMIT ${String(SEARCH_COMMON_TERM_ROW_LIMIT + 1)}
      ) AS hit
    )`,
    `term_weights AS MATERIALIZED (
      SELECT lexeme, ln(1 + ${String(SEARCH_COMMON_TERM_ROW_LIMIT)}::float8 / count(*)) AS weight
      FROM term_hits
      GROUP BY lexeme
      HAVING count(*) <= ${String(SEARCH_COMMON_TERM_ROW_LIMIT)}
    )`,
    `term_candidates AS (
      SELECT hits.id
      FROM term_hits AS hits
      JOIN term_weights AS weights ON weights.lexeme = hits.lexeme
      GROUP BY hits.id, hits.created_at
      ORDER BY sum(weights.weight) DESC, hits.created_at DESC, hits.id DESC
      LIMIT ${String(SEARCH_CHANNEL_ROW_CAP)}
    )`,
    `exact_candidates AS (
      (
        SELECT id
        FROM ai_memory_entries
        WHERE memory_key = ANY(${input.exactKeysParam}::text[])
          ${base}
        LIMIT ${String(SEARCH_CHANNEL_ROW_CAP)}
      )
      UNION ALL
      (
        SELECT id
        FROM ai_memory_entries
        WHERE tags && ${input.exactTagsParam}::text[]
          ${base}
        ORDER BY created_at DESC, id DESC
        LIMIT ${String(SEARCH_CHANNEL_ROW_CAP)}
      )
    )`,
  ];

  if (input.reference !== undefined) {
    // The stored vector indexes every reference number, so the regex only
    // confirms rows that the index already returned.
    ctes.push(`reference_candidates AS (
      SELECT id
      FROM ai_memory_entries
      WHERE search_vector @@ (
          SELECT string_agg(quote_literal(number), ' | ')::tsquery
          FROM unnest(${input.reference.numbersParam}::text[]) AS number
        )
        AND ${buildMemorySearchReferenceMatchSql(input.reference.patternParam)}
        ${base}
      ORDER BY created_at DESC, id DESC
      LIMIT ${String(SEARCH_CHANNEL_ROW_CAP)}
    )`);
    channels.push('reference_candidates');
  }

  if (input.goalReference !== undefined) {
    ctes.push(`goal_candidates AS (
      SELECT id
      FROM ai_memory_entries
      WHERE search_vector @@ (SELECT goal_query FROM search_query)
        AND ${buildMemorySearchReferenceMatchSql(input.goalReference.patternParam)}
        ${base}
      ORDER BY created_at DESC, id DESC
      LIMIT ${String(SEARCH_CHANNEL_ROW_CAP)}
    )`);
    channels.push('goal_candidates');
  }

  ctes.push(`fill_candidates AS (
      SELECT id
      FROM ai_memory_entries
      WHERE (
          SELECT count(*)
          FROM (SELECT id FROM phrase_candidates UNION SELECT id FROM term_candidates) AS found
        ) < ${String(SEARCH_MIN_POOL_ROWS)}
        AND search_vector @@ (SELECT any_term_query FROM search_query)
        ${base}
      ORDER BY created_at DESC, id DESC
      LIMIT ${String(SEARCH_CHANNEL_ROW_CAP)}
    )`);
  channels.push('fill_candidates');

  ctes.push(`text_pool AS MATERIALIZED (
      ${channels.map(channel => `SELECT id FROM ${channel}`).join('\n      UNION\n      ')}
    )`);
  return ctes.join(',\n    ');
}

/**
 * Builds the primary websearch rank. A document that does not match a query
 * without negation has no cover, so its rank is 0 and the costly ranking pass
 * is skipped; negated queries are always ranked.
 */
export function buildMemorySearchSemanticRankSql(queryParam: string) {
  const querySql = `websearch_to_tsquery('english', ${queryParam})`;

  return `CASE
    WHEN position('!' IN ${querySql}::text) > 0 OR search_vector @@ ${querySql}
    THEN ts_rank_cd(search_vector, ${querySql})
    ELSE 0
  END`;
}

/**
 * Builds SQL that computes ts_rank_cd using a tokenized OR-based tsquery.
 * This gives non-zero relevance scores to memories that match ANY query term,
 * unlike the AND-based websearch_to_tsquery used for primary semantic ranking.
 * Only this positive English OR query can discard absent lexemes: doing so
 * preserves its covers, positions and weights while reducing rank allocation.
 */
export function buildMemorySearchOrRankSql(queryParam: string) {
  const tokenizedOrQuerySql = buildTokenizedOrQuerySql(queryParam);

  return `CASE
    WHEN ${tokenizedOrQuerySql} IS NOT NULL
    THEN ts_rank_cd(
      search_vector,
      coalesce((
        SELECT string_agg(quote_literal(lexeme), ' | ')::tsquery
        FROM unnest(tsvector_to_array(to_tsvector('english', ${tokenizedOrQuerySql}))) AS terms(lexeme)
        WHERE search_vector @@ quote_literal(lexeme)::tsquery
      ), ''::tsquery)
    )
    ELSE 0
  END`;
}

export function buildMemorySearchReferenceMatchSql(patternParam: string) {
  return `EXISTS (
    SELECT 1
    FROM (
      SELECT content AS value
      UNION ALL SELECT memory_key
      UNION ALL
        SELECT CASE WHEN jsonb_typeof(item) = 'string' THEN item #>> '{}' ELSE item::text END
        FROM jsonb_array_elements(evidence_refs) AS item
      UNION ALL SELECT unnest(tags)
    ) AS reference_fields
    WHERE lower(coalesce(reference_fields.value, '')) ~ ${patternParam}
  )`;
}

export function buildMemoryUpdateByIdSql(hasEmbeddingColumn: boolean) {
  return `
    UPDATE ai_memory_entries
    SET
      content = $1,
      project = $2,
      category = $3,
      memory_type = $4,
      tags = $5,
      source = $6,
      confidence = $7,
      declared_confidence = $8,
      calibrated_confidence = $9,
      importance = $10,
      memory_key = $11,
      dedupe_hash = $12,
      status = $13,
      supersedes_id = $14,
      agent = $15,
      model = $16,
      tool = $17,
      session_id = $18,
      thread_id = $19,
      org_id = $20,
      repo_id = $21,
      repo_slug = $22,
      user_id = $23,
      sensitivity = $24,
      expires_at = $25,
      evidence_refs = $26,
      metadata_json = $27,
      updated_by = $28,
      audience = $29,
      pinned = $30,
      last_verified_at = COALESCE($31, last_verified_at),
      updated_at = NOW()${hasEmbeddingColumn ? ',\n      embedding = $32' : ''}
    WHERE id = $${hasEmbeddingColumn ? '33' : '32'}
    RETURNING *
  `;
}

export function buildMemoryUpsertByMemoryKeySql(hasEmbeddingColumn: boolean) {
  return `
    ${buildMemoryInsertBaseSql(hasEmbeddingColumn)}
    ON CONFLICT (memory_key)
    WHERE memory_key IS NOT NULL
    DO UPDATE
      SET
        content = EXCLUDED.content,
        project = EXCLUDED.project,
        category = EXCLUDED.category,
        memory_type = EXCLUDED.memory_type,
        tags = EXCLUDED.tags,
        source = EXCLUDED.source,
        confidence = EXCLUDED.confidence,
        declared_confidence = EXCLUDED.declared_confidence,
        calibrated_confidence = EXCLUDED.calibrated_confidence,
        importance = EXCLUDED.importance,
        dedupe_hash = EXCLUDED.dedupe_hash,
        status = EXCLUDED.status,
        supersedes_id = EXCLUDED.supersedes_id,
        agent = EXCLUDED.agent,
        model = EXCLUDED.model,
        tool = EXCLUDED.tool,
        session_id = EXCLUDED.session_id,
        thread_id = EXCLUDED.thread_id,
        org_id = EXCLUDED.org_id,
        repo_id = EXCLUDED.repo_id,
        repo_slug = EXCLUDED.repo_slug,
        user_id = EXCLUDED.user_id,
        sensitivity = EXCLUDED.sensitivity,
        expires_at = EXCLUDED.expires_at,
        evidence_refs = EXCLUDED.evidence_refs,
        metadata_json = EXCLUDED.metadata_json,
        updated_by = EXCLUDED.updated_by,
        audience = EXCLUDED.audience,
        pinned = EXCLUDED.pinned,
        last_verified_at = CASE WHEN ai_memory_entries.content = EXCLUDED.content
          THEN NOW() ELSE EXCLUDED.last_verified_at END,
        updated_at = NOW()${hasEmbeddingColumn ? ',\n        embedding = EXCLUDED.embedding' : ''}
    RETURNING *
  `;
}

function buildMemoryInsertBaseSql(hasEmbeddingColumn: boolean) {
  return `
    INSERT INTO ai_memory_entries (
      content,
      project,
      category,
      memory_type,
      tags,
      source,
      confidence,
      declared_confidence,
      calibrated_confidence,
      importance,
      memory_key,
      dedupe_hash,
      status,
      supersedes_id,
      agent,
      model,
      tool,
      session_id,
      thread_id,
      org_id,
      repo_id,
      repo_slug,
      user_id,
      sensitivity,
      expires_at,
      evidence_refs,
      metadata_json,
      updated_by,
      updated_at,
      audience,
      pinned,
      last_verified_at${hasEmbeddingColumn ? ',\n      embedding' : ''}
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9,
      $10, $11, $12, $13, $14, $15, $16, $17,
      $18, $19, $20, $21, $22, $23, $24, $25,
      $26, $27, $28, NOW(), $29, $30, $31${hasEmbeddingColumn ? ',\n      $32' : ''}
    )
  `;
}

/** Tokenizes a query parameter into an OR-separated form for websearch_to_tsquery. */
function buildTokenizedOrQuerySql(queryParam: string) {
  return `nullif(
    regexp_replace(
      trim(regexp_replace(lower(${queryParam}), '[^[:alnum:]]+', ' ', 'g')),
      '[[:space:]]+',
      ' OR ',
      'g'
    ),
    ''
  )`;
}

/** Removes terms that websearch syntax negates (`-term`, `-"phrase"`), so they cannot select candidates. */
function stripNegatedTermsSql(queryParam: string) {
  return `regexp_replace(${queryParam}, '(^|[[:space:]])-("[^"]*"|[^[:space:]]+)', ' ', 'g')`;
}
