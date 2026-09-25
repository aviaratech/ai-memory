-- Make existing provenance fields part of full-text retrieval without changing
-- any memory payload or retention policy. Build the replacement before
-- retiring the prior expression index so a failed migration leaves the
-- installed search index available.
--
-- PostgreSQL classifies array_to_string as STABLE. Wrap its text[]-only use in
-- a declared immutable helper so it can participate in this expression index.
CREATE OR REPLACE FUNCTION ai_memory_tags_to_search_text(tags TEXT[])
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$
  SELECT array_to_string(tags, ' ');
$$;

CREATE INDEX IF NOT EXISTS ai_memory_entries_search_v2_idx
      ON ai_memory_entries
      USING GIN (
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
  )
);

DROP INDEX IF EXISTS ai_memory_entries_search_idx;

ALTER INDEX ai_memory_entries_search_v2_idx RENAME TO ai_memory_entries_search_idx;
