-- Index the stored search vector so search finds candidates through the index
-- instead of reading every row. Queries now read the generated column, so the
-- two expression indexes no longer serve any query: the original membership
-- index (the 003 expression, without reference terms) and the reference index
-- (the same expression as the stored column).
--
-- Index builds block writes (the whole migration takes well under a second on
-- a 40k-row table); reads continue. CREATE INDEX CONCURRENTLY cannot run
-- inside the migration transaction. The statements that take exclusive locks
-- (the tags index setting and the drops) come last, and the locks last until
-- the transaction commits. fastupdate is off so a query never scans a pending
-- list.
CREATE INDEX IF NOT EXISTS ai_memory_entries_search_vector_idx
  ON ai_memory_entries
  USING GIN (search_vector)
  WITH (fastupdate = off);

-- Reversal-prior lookups (run by every search and every write) match on the
-- author expression and lower(category). The earlier index keyed on category
-- itself, so no query could use it; this one matches the lookups.
CREATE INDEX IF NOT EXISTS ai_memory_entries_author_category_created_v2_idx
  ON ai_memory_entries (
    (COALESCE(NULLIF(agent, ''), NULLIF(updated_by, ''), NULLIF(source, ''), 'unknown')),
    (lower(category)),
    created_at DESC
  );

-- Search now reads the tags index on every call (exact tag candidates and the
-- reversal-prior tag lookups). With the default fastupdate, new entries wait
-- in a pending list that every read scans in full until vacuum or a 4 MB flush.
-- Merge any entries already waiting, then turn it off. The merge comes first
-- because ALTER INDEX holds an exclusive lock until the transaction commits.
DO $$
BEGIN
  IF to_regclass('ai_memory_entries_tags_gin_idx') IS NOT NULL THEN
    PERFORM gin_clean_pending_list('ai_memory_entries_tags_gin_idx'::regclass);
  END IF;
END $$;
ALTER INDEX IF EXISTS ai_memory_entries_tags_gin_idx SET (fastupdate = off);

DROP INDEX IF EXISTS ai_memory_entries_search_idx;
DROP INDEX IF EXISTS ai_memory_entries_reference_search_idx;
DROP INDEX IF EXISTS ai_memory_entries_author_category_created_idx;
ALTER INDEX ai_memory_entries_author_category_created_v2_idx RENAME TO ai_memory_entries_author_category_created_idx;
