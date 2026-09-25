-- Forward correction after 005: the historical GitHub-qualified repository ID
-- github.com/example/catalog is the same repository as an attested example/catalog
-- slug. Other hosts/owners remain conflicts. Preserve historical ID metadata;
-- repeat bounded checkpoint reconciliation for sessions 005 conservatively skipped.
CREATE TEMP TABLE ai_project_identity_sessions ON COMMIT DROP AS
SELECT s.session_id
FROM ai_sessions s
WHERE (s.repo_slug = 'example/catalog' OR s.repo_id = 'example/catalog'
  OR EXISTS (
    SELECT 1 FROM ai_memory_entries m
    WHERE m.session_id = s.session_id
      AND (m.repo_slug = 'example/catalog' OR m.repo_id = 'example/catalog')
  ))
  AND (s.repo_slug IS NULL OR s.repo_slug = 'example/catalog')
  AND (s.repo_id IS NULL OR s.repo_id IN ('catalog', 'example/catalog'))
  AND NOT EXISTS (
    SELECT 1 FROM ai_memory_entries m
    WHERE m.session_id = s.session_id
      AND ((m.repo_slug IS NOT NULL AND m.repo_slug <> 'example/catalog')
        OR (m.repo_id IS NOT NULL AND m.repo_id NOT IN ('catalog', 'example/catalog', 'github.com/example/catalog'))
        OR (m.project IS NOT NULL AND m.project NOT IN ('catalog', 'example/catalog')))
  );

UPDATE ai_memory_entries
SET project = 'example/catalog'
WHERE project = 'catalog'
  AND (repo_slug = 'example/catalog' OR repo_id = 'example/catalog'
    OR session_id IN (SELECT session_id FROM ai_project_identity_sessions))
  AND (repo_slug IS NULL OR repo_slug = 'example/catalog')
  AND (repo_id IS NULL OR repo_id IN ('catalog', 'example/catalog', 'github.com/example/catalog'));

UPDATE ai_sessions SET repo_id = 'example/catalog'
WHERE session_id IN (SELECT session_id FROM ai_project_identity_sessions)
  AND (repo_id = 'catalog' OR repo_id IS NULL);

-- Freeze both checkpoint versions before reconciling the same logical scope.
-- Keep the newest at the canonical key and preserve the older at the legacy
-- key. This is offline reconciliation, not a runtime alias or fallback read.
CREATE TEMP TABLE ai_project_identity_pairs ON COMMIT DROP AS
SELECT legacy.scope_key AS legacy_key, canonical.scope_key AS canonical_key,
       legacy AS legacy_record, canonical AS canonical_record
FROM ai_continuity_packs legacy
JOIN ai_continuity_packs canonical
  ON canonical.scope_key = regexp_replace(legacy.scope_key, '^(task|lead|outcome):catalog:', '\1:example/catalog:')
WHERE legacy.project = 'catalog'
  AND legacy.scope_key ~ '^(task|lead|outcome):catalog:'
  AND legacy.session_id IN (SELECT session_id FROM ai_project_identity_sessions);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM ai_project_identity_pairs p
    WHERE (p.canonical_record).project <> 'example/catalog'
      OR (p.canonical_record).session_id IS NULL
      OR (p.canonical_record).session_id NOT IN (SELECT session_id FROM ai_project_identity_sessions)
      OR ((p.canonical_record).updated_at = (p.legacy_record).updated_at
          AND (p.canonical_record).pack_json <> (p.legacy_record).pack_json)
  ) THEN
    RAISE EXCEPTION 'Verified project identity checkpoint collision: reconcile the ai and example/catalog scoped checkpoints before retrying migration 006';
  END IF;
END $$;

UPDATE ai_continuity_packs target SET
  (session_id, source, payload_chars, budget_chars, pack_json, created_at, updated_at) =
  ((p.legacy_record).session_id, (p.legacy_record).source, (p.legacy_record).payload_chars,
   (p.legacy_record).budget_chars, (p.legacy_record).pack_json, (p.legacy_record).created_at, (p.legacy_record).updated_at)
FROM ai_project_identity_pairs p
WHERE target.scope_key = p.canonical_key
  AND (p.legacy_record).updated_at > (p.canonical_record).updated_at;

UPDATE ai_continuity_packs target SET
  (session_id, source, payload_chars, budget_chars, pack_json, created_at, updated_at) =
  ((p.canonical_record).session_id, (p.canonical_record).source, (p.canonical_record).payload_chars,
   (p.canonical_record).budget_chars, (p.canonical_record).pack_json, (p.canonical_record).created_at, (p.canonical_record).updated_at)
FROM ai_project_identity_pairs p
WHERE target.scope_key = p.legacy_key
  AND (p.legacy_record).updated_at > (p.canonical_record).updated_at;

UPDATE ai_continuity_packs
SET project = 'example/catalog',
    scope_key = regexp_replace(scope_key, '^(task|lead|outcome):catalog:', '\1:example/catalog:')
WHERE project = 'catalog'
  AND scope_key ~ '^(task|lead|outcome):catalog:'
  AND session_id IN (SELECT session_id FROM ai_project_identity_sessions)
  AND scope_key NOT IN (SELECT legacy_key FROM ai_project_identity_pairs);

-- Existing canonical background wins over an older alias background; retain the
-- historical alias cache rather than deleting data or substituting it for a task.
UPDATE ai_continuity_packs
SET project = 'example/catalog', scope_key = 'project:example/catalog'
WHERE project = 'catalog' AND scope_key = 'project:ai'
  AND session_id IN (SELECT session_id FROM ai_project_identity_sessions)
  AND NOT EXISTS (SELECT 1 FROM ai_continuity_packs WHERE scope_key = 'project:example/catalog');
