import { SEARCH_VECTOR_SQL } from './runtime.js';

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

export function buildMemorySearchKeywordMatchSql(queryParam: string) {
  const tokenizedOrQuerySql = buildTokenizedOrQuerySql(queryParam);

  return `
    (
      ${tokenizedOrQuerySql} IS NOT NULL
      AND ${SEARCH_VECTOR_SQL} @@ websearch_to_tsquery('english', ${tokenizedOrQuerySql})
    )
  `;
}

/**
 * Builds SQL that computes ts_rank_cd using a tokenized OR-based tsquery.
 * This gives non-zero relevance scores to memories that match ANY query term,
 * unlike the AND-based websearch_to_tsquery used for primary semantic ranking.
 */
export function buildMemorySearchOrRankSql(queryParam: string) {
  const tokenizedOrQuerySql = buildTokenizedOrQuerySql(queryParam);

  return `CASE
    WHEN ${tokenizedOrQuerySql} IS NOT NULL
    THEN ts_rank_cd(
      ${SEARCH_VECTOR_SQL},
      websearch_to_tsquery('english', ${tokenizedOrQuerySql})
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
      updated_at = NOW()${hasEmbeddingColumn ? ',\n      embedding = $29' : ''}
    WHERE id = $${hasEmbeddingColumn ? '30' : '29'}
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
      updated_at${hasEmbeddingColumn ? ',\n      embedding' : ''}
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9,
      $10, $11, $12, $13, $14, $15, $16, $17,
      $18, $19, $20, $21, $22, $23, $24, $25,
      $26, $27, $28, NOW()${hasEmbeddingColumn ? ',\n      $29' : ''}
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
