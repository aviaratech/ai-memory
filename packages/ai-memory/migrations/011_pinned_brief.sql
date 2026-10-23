-- Add curated brief metadata without changing existing memory fields.
ALTER TABLE ai_memory_entries ADD COLUMN audience TEXT[] NOT NULL DEFAULT ARRAY['all']::text[];
ALTER TABLE ai_memory_entries ADD COLUMN pinned BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE ai_memory_entries ADD COLUMN last_verified_at TIMESTAMPTZ;
UPDATE ai_memory_entries SET last_verified_at = updated_at;
ALTER TABLE ai_memory_entries ALTER COLUMN last_verified_at SET NOT NULL;
ALTER TABLE ai_memory_entries ADD CONSTRAINT ai_memory_entries_audience_check
  CHECK (cardinality(audience) > 0 AND array_position(audience, NULL) IS NULL AND NOT ('' = ANY(audience)));

-- Defaults cannot reference another column; preserve explicit historical dates.
CREATE FUNCTION ai_memory_default_verified_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.last_verified_at := COALESCE(NEW.last_verified_at, NEW.updated_at);
  RETURN NEW;
END;
$$;
CREATE TRIGGER ai_memory_entries_default_verified_at
  BEFORE INSERT ON ai_memory_entries FOR EACH ROW EXECUTE FUNCTION ai_memory_default_verified_at();

CREATE INDEX ai_memory_entries_brief_project_idx ON ai_memory_entries(project)
  WHERE status = 'active' AND (pinned OR category = 'state');
