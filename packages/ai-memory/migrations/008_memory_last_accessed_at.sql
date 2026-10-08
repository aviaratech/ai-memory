-- Record read access separately so recall and search never change the edit
-- timestamp. A nullable column without a default is a catalog-only change.
ALTER TABLE ai_memory_entries
  ADD COLUMN last_accessed_at TIMESTAMPTZ;
