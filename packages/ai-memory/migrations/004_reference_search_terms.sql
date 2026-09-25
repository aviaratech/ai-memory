-- Preserve the prior expression index for active older bundles and code-first
-- rollback. This migration changes index terms, never stored memory records.
CREATE FUNCTION ai_memory_reference_search_terms(
  memory_content TEXT,
  memory_key TEXT,
  memory_evidence JSONB,
  memory_tags TEXT[]
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  WITH fields(value) AS (
    SELECT memory_content UNION ALL SELECT memory_key
    UNION ALL SELECT CASE WHEN jsonb_typeof(item) = 'string' THEN item #>> '{}' ELSE item::text END
      FROM jsonb_array_elements(memory_evidence) AS item
    UNION ALL SELECT unnest(memory_tags)
  )
  SELECT coalesce(string_agg(DISTINCT matched[1], ' ' ORDER BY matched[1]), '')
  FROM fields
  CROSS JOIN LATERAL regexp_matches(
    value,
    '(?<![a-z0-9])(?:(?:issues?|prs?|pulls?)[[:space:]#/:._-]*|#)([0-9]+)(?![a-z0-9])',
    'gi'
  ) AS matched;
$$;

CREATE INDEX ai_memory_entries_reference_search_idx
  ON ai_memory_entries
  USING GIN (

  (
  to_tsvector(
    'english',
    coalesce(content, '') ||
    ' ' ||
    coalesce(project, '') ||
    ' ' ||
    coalesce(category, '') ||
    ' ' ||
    coalesce(source, '') ||
    ' ' ||
    coalesce(memory_key, '') ||
    ' ' ||
    coalesce(evidence_refs::text, '') ||
    ' ' ||
    ai_memory_tags_to_search_text(tags)
  ) || to_tsvector(
    'english',
    ai_memory_reference_search_terms(content, memory_key, evidence_refs, tags)
  )
  )

);
