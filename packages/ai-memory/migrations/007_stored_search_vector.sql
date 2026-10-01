-- Keep the existing expression GIN index for membership. Store its exact vector
-- once per write so every candidate rank can reuse lexemes and positions.
ALTER TABLE ai_memory_entries
  ADD COLUMN search_vector TSVECTOR GENERATED ALWAYS AS (
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
) STORED;
