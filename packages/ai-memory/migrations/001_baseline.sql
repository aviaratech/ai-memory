-- ai-memory node-pg-migrate baseline.
--
-- This file mechanically preserves the legacy in-code migrations through
-- 2026_02_26_019_write_calibration_confidence. Existing databases that have
-- that legacy migration recorded in ai_memory_migrations are seeded with this
-- baseline in public.ai_memory_pgmigrations and do not replay it. Fresh and partially
-- migrated databases apply this idempotent baseline through node-pg-migrate.
--
-- Rollback: revert the runner change to restore the legacy initialization path,
-- then remove the public.ai_memory_pgmigrations row named '001_baseline' only if the
-- reverted code must resume owning migration metadata. Do not drop ai-memory
-- data tables as part of runner rollback.

-- legacy migration: 2026_02_05_001_base
CREATE TABLE IF NOT EXISTS ai_memory_entries (
        id BIGSERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        project TEXT,
        category TEXT,
        tags TEXT[] NOT NULL DEFAULT '{}',
        source TEXT NOT NULL DEFAULT 'manual',
        confidence DOUBLE PRECISION NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (confidence >= 0 AND confidence <= 1)
      );

CREATE INDEX IF NOT EXISTS ai_memory_entries_search_idx
      ON ai_memory_entries
      USING GIN (
  to_tsvector(
    'english',
    coalesce(content, '') ||
    ' ' ||
    coalesce(project, '') ||
    ' ' ||
    coalesce(category, '')
  )
);

CREATE INDEX IF NOT EXISTS ai_memory_entries_created_at_idx
      ON ai_memory_entries (created_at DESC);

-- legacy migration: 2026_02_05_002_schema_v11
ALTER TABLE ai_memory_entries ADD COLUMN IF NOT EXISTS memory_key TEXT;

ALTER TABLE ai_memory_entries ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

ALTER TABLE ai_memory_entries ADD COLUMN IF NOT EXISTS supersedes_id BIGINT;

ALTER TABLE ai_memory_entries ADD COLUMN IF NOT EXISTS agent TEXT;

ALTER TABLE ai_memory_entries ADD COLUMN IF NOT EXISTS model TEXT;

ALTER TABLE ai_memory_entries ADD COLUMN IF NOT EXISTS tool TEXT;

ALTER TABLE ai_memory_entries ADD COLUMN IF NOT EXISTS session_id TEXT;

ALTER TABLE ai_memory_entries ADD COLUMN IF NOT EXISTS thread_id TEXT;

ALTER TABLE ai_memory_entries ADD COLUMN IF NOT EXISTS org_id TEXT;

ALTER TABLE ai_memory_entries ADD COLUMN IF NOT EXISTS repo_id TEXT;

ALTER TABLE ai_memory_entries ADD COLUMN IF NOT EXISTS repo_slug TEXT;

ALTER TABLE ai_memory_entries ADD COLUMN IF NOT EXISTS user_id TEXT;

ALTER TABLE ai_memory_entries ADD COLUMN IF NOT EXISTS sensitivity TEXT NOT NULL DEFAULT 'internal';

ALTER TABLE ai_memory_entries ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

ALTER TABLE ai_memory_entries ADD COLUMN IF NOT EXISTS evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE ai_memory_entries ADD COLUMN IF NOT EXISTS metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE ai_memory_entries ADD COLUMN IF NOT EXISTS updated_by TEXT;

DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'ai_memory_entries_status_check'
        ) THEN
          ALTER TABLE ai_memory_entries
            ADD CONSTRAINT ai_memory_entries_status_check
            CHECK (status IN ('active', 'superseded', 'expired', 'archived'));
        END IF;
      END $$;

DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'ai_memory_entries_sensitivity_check'
        ) THEN
          ALTER TABLE ai_memory_entries
            ADD CONSTRAINT ai_memory_entries_sensitivity_check
            CHECK (sensitivity IN ('public', 'internal', 'confidential', 'restricted'));
        END IF;
      END $$;

DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'ai_memory_entries_supersedes_fk'
        ) THEN
          ALTER TABLE ai_memory_entries
            ADD CONSTRAINT ai_memory_entries_supersedes_fk
            FOREIGN KEY (supersedes_id)
            REFERENCES ai_memory_entries(id)
            ON DELETE SET NULL;
        END IF;
      END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ai_memory_entries_memory_key_uidx
      ON ai_memory_entries(memory_key)
      WHERE memory_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS ai_memory_entries_project_created_idx
      ON ai_memory_entries(project, created_at DESC);

CREATE INDEX IF NOT EXISTS ai_memory_entries_status_created_idx
      ON ai_memory_entries(status, created_at DESC);

CREATE INDEX IF NOT EXISTS ai_memory_entries_tags_gin_idx
      ON ai_memory_entries
      USING GIN (tags);

CREATE INDEX IF NOT EXISTS ai_memory_entries_expires_at_idx
      ON ai_memory_entries(expires_at)
      WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS ai_memory_entries_session_idx
      ON ai_memory_entries(session_id);

CREATE TABLE IF NOT EXISTS ai_sessions (
        session_id TEXT PRIMARY KEY,
        org_id TEXT,
        repo_id TEXT,
        repo_slug TEXT,
        user_id TEXT,
        agent TEXT NOT NULL,
        model TEXT,
        tool TEXT,
        task_id TEXT,
        task_type TEXT,
        task_title TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ended_at TIMESTAMPTZ
      );

DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'ai_sessions_status_check'
        ) THEN
          ALTER TABLE ai_sessions
            ADD CONSTRAINT ai_sessions_status_check
            CHECK (status IN ('active', 'completed', 'abandoned', 'error'));
        END IF;
      END $$;

CREATE INDEX IF NOT EXISTS ai_sessions_repo_updated_idx
      ON ai_sessions(repo_slug, updated_at DESC);

CREATE INDEX IF NOT EXISTS ai_sessions_agent_repo_updated_idx
      ON ai_sessions(agent, repo_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS ai_sessions_repo_id_updated_idx
      ON ai_sessions(repo_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS ai_session_snapshots (
        id BIGSERIAL PRIMARY KEY,
        snapshot_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        schema_version TEXT NOT NULL DEFAULT 'session_snapshot@0.1',
        snapshot_json JSONB NOT NULL,
        source_delta_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT ai_session_snapshots_session_fk
          FOREIGN KEY (session_id)
          REFERENCES ai_sessions(session_id)
          ON DELETE CASCADE
      );

CREATE INDEX IF NOT EXISTS ai_session_snapshots_session_created_idx
      ON ai_session_snapshots(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_session_events (
        id BIGSERIAL PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT ai_session_events_session_fk
          FOREIGN KEY (session_id)
          REFERENCES ai_sessions(session_id)
          ON DELETE CASCADE
      );

CREATE INDEX IF NOT EXISTS ai_session_events_session_created_idx
      ON ai_session_events(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_context_packs (
        pack_id TEXT PRIMARY KEY,
        schema_version TEXT NOT NULL DEFAULT 'context_pack@0.1',
        session_id TEXT,
        produced_by_agent TEXT NOT NULL,
        produced_by_instance_id TEXT,
        tenancy_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        task_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        pinned_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        working_set_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        budgets_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        stats_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        raw_json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT ai_context_packs_session_fk
          FOREIGN KEY (session_id)
          REFERENCES ai_sessions(session_id)
          ON DELETE SET NULL
      );

CREATE INDEX IF NOT EXISTS ai_context_packs_session_created_idx
      ON ai_context_packs(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_memory_deltas (
        delta_id TEXT PRIMARY KEY,
        schema_version TEXT NOT NULL DEFAULT 'memory_delta@0.1',
        session_id TEXT,
        produced_by_agent TEXT NOT NULL,
        produced_by_model TEXT,
        tenancy_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        snapshot_mode TEXT NOT NULL,
        snapshot_json JSONB NOT NULL,
        append_events_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        artifacts_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        telemetry_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        raw_json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT ai_memory_deltas_session_fk
          FOREIGN KEY (session_id)
          REFERENCES ai_sessions(session_id)
          ON DELETE SET NULL
      );

DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'ai_memory_deltas_snapshot_mode_check'
        ) THEN
          ALTER TABLE ai_memory_deltas
            ADD CONSTRAINT ai_memory_deltas_snapshot_mode_check
            CHECK (snapshot_mode IN ('replace', 'patch'));
        END IF;
      END $$;

CREATE INDEX IF NOT EXISTS ai_memory_deltas_session_created_idx
      ON ai_memory_deltas(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_memory_events (
        id BIGSERIAL PRIMARY KEY,
        memory_id BIGINT NOT NULL,
        event_type TEXT NOT NULL,
        actor TEXT,
        payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT ai_memory_events_memory_fk
          FOREIGN KEY (memory_id)
          REFERENCES ai_memory_entries(id)
          ON DELETE CASCADE
      );

CREATE INDEX IF NOT EXISTS ai_memory_events_memory_created_idx
      ON ai_memory_events(memory_id, created_at DESC);

-- legacy migration: 2026_02_05_003_ingestion_failure_audit
CREATE TABLE IF NOT EXISTS ai_ingestion_failures (
        id BIGSERIAL PRIMARY KEY,
        source TEXT NOT NULL,
        stage TEXT NOT NULL DEFAULT 'unknown',
        session_id TEXT,
        agent TEXT,
        repo_id TEXT,
        error_message TEXT NOT NULL,
        details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'ai_ingestion_failures_session_fk'
        ) THEN
          ALTER TABLE ai_ingestion_failures
            ADD CONSTRAINT ai_ingestion_failures_session_fk
            FOREIGN KEY (session_id)
            REFERENCES ai_sessions(session_id)
            ON DELETE SET NULL;
        END IF;
      END $$;

CREATE INDEX IF NOT EXISTS ai_ingestion_failures_created_idx
      ON ai_ingestion_failures(created_at DESC);

CREATE INDEX IF NOT EXISTS ai_ingestion_failures_source_created_idx
      ON ai_ingestion_failures(source, created_at DESC);

CREATE INDEX IF NOT EXISTS ai_ingestion_failures_session_created_idx
      ON ai_ingestion_failures(session_id, created_at DESC);

-- legacy migration: 2026_02_06_004_agent_query_indexes
CREATE INDEX IF NOT EXISTS ai_memory_entries_project_status_created_idx
      ON ai_memory_entries(project, status, created_at DESC);

CREATE INDEX IF NOT EXISTS ai_ingestion_failures_source_stage_created_idx
      ON ai_ingestion_failures(source, stage, created_at DESC);

DO $$
      BEGIN
        BEGIN
          CREATE EXTENSION IF NOT EXISTS pg_trgm;
        EXCEPTION
          WHEN insufficient_privilege THEN
            RAISE NOTICE 'Skipping pg_trgm extension creation: insufficient privilege';
          WHEN undefined_file THEN
            RAISE NOTICE 'Skipping pg_trgm extension creation: extension unavailable';
        END;
      END $$;

DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
          EXECUTE '
            CREATE INDEX IF NOT EXISTS ai_memory_entries_content_trgm_idx
            ON ai_memory_entries
            USING GIN (content gin_trgm_ops)
          ';
        END IF;
      END $$;

-- legacy migration: 2026_02_06_005_memory_dedupe_hash
ALTER TABLE ai_memory_entries ADD COLUMN IF NOT EXISTS dedupe_hash TEXT;

CREATE INDEX IF NOT EXISTS ai_memory_entries_dedupe_hash_idx
      ON ai_memory_entries(dedupe_hash, updated_at DESC)
      WHERE dedupe_hash IS NOT NULL AND memory_key IS NULL;

-- legacy migration: 2026_02_06_006_session_events_append_only
CREATE OR REPLACE FUNCTION prevent_event_update()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'UPDATE on ai_session_events is not allowed (append-only table)';
      END;
      $$ LANGUAGE plpgsql;

DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgname = 'ai_session_events_no_update'
            AND tgrelid = 'ai_session_events'::regclass
        ) THEN
          CREATE TRIGGER ai_session_events_no_update
            BEFORE UPDATE ON ai_session_events
            FOR EACH ROW EXECUTE FUNCTION prevent_event_update();
        END IF;
      END $$;

-- legacy migration: 2026_02_08_007_retention_purge_indexes
CREATE INDEX IF NOT EXISTS ai_ingestion_failures_retention_created_idx
      ON ai_ingestion_failures(created_at, id);

CREATE INDEX IF NOT EXISTS ai_memory_entries_retention_expired_idx
      ON ai_memory_entries(expires_at, id)
      WHERE category = 'session-summary' AND expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS ai_memory_entries_retention_retired_idx
      ON ai_memory_entries(updated_at, id)
      WHERE status IN ('superseded', 'archived');

CREATE INDEX IF NOT EXISTS ai_sessions_retention_started_idx
      ON ai_sessions(started_at, session_id);

CREATE INDEX IF NOT EXISTS ai_context_packs_retention_created_idx
      ON ai_context_packs(created_at, pack_id);

CREATE INDEX IF NOT EXISTS ai_memory_deltas_retention_created_idx
      ON ai_memory_deltas(created_at, delta_id);

CREATE INDEX IF NOT EXISTS ai_memory_events_retention_created_idx
      ON ai_memory_events(created_at, id);

-- legacy migration: 2026_02_20_008_pgvector_embeddings
DO $$
      BEGIN
        BEGIN
          CREATE EXTENSION IF NOT EXISTS vector;
        EXCEPTION
          WHEN insufficient_privilege THEN
            RAISE NOTICE 'Skipping vector extension creation: insufficient privilege';
          WHEN undefined_file THEN
            RAISE NOTICE 'Skipping vector extension creation: extension files missing';
          WHEN feature_not_supported THEN
            RAISE NOTICE 'Skipping vector extension creation: extension not available';
        END;
      END $$;

DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
          EXECUTE '
            ALTER TABLE ai_memory_entries ADD COLUMN IF NOT EXISTS embedding vector(1536)
          ';
        END IF;
      END $$;

DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
          EXECUTE '
            CREATE INDEX IF NOT EXISTS ai_memory_entries_embedding_hnsw_idx
            ON ai_memory_entries
            USING hnsw (embedding vector_cosine_ops)
            WITH (m = 16, ef_construction = 64)
          ';
        END IF;
      END $$;

-- legacy migration: 2026_02_20_009_contested_status
ALTER TABLE ai_memory_entries DROP CONSTRAINT IF EXISTS ai_memory_entries_status_check;

ALTER TABLE ai_memory_entries
        ADD CONSTRAINT ai_memory_entries_status_check
        CHECK (status IN ('active', 'contested', 'superseded', 'expired', 'archived'));

-- legacy migration: 2026_02_22_010_pgvector_embedding_repair
DO $$
      BEGIN
        BEGIN
          CREATE EXTENSION IF NOT EXISTS vector;
        EXCEPTION
          WHEN insufficient_privilege THEN
            RAISE NOTICE 'Skipping vector extension creation: insufficient privilege';
          WHEN undefined_file THEN
            RAISE NOTICE 'Skipping vector extension creation: extension files missing';
          WHEN feature_not_supported THEN
            RAISE NOTICE 'Skipping vector extension creation: extension not available';
        END;
      END $$;

DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
          EXECUTE '
            ALTER TABLE ai_memory_entries ADD COLUMN IF NOT EXISTS embedding vector(1536)
          ';
        END IF;
      END $$;

DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
          EXECUTE '
            CREATE INDEX IF NOT EXISTS ai_memory_entries_embedding_hnsw_idx
            ON ai_memory_entries
            USING hnsw (embedding vector_cosine_ops)
            WITH (m = 16, ef_construction = 64)
          ';
        END IF;
      END $$;

-- legacy migration: 2026_02_22_011_memory_type_tiering
ALTER TABLE ai_memory_entries ADD COLUMN IF NOT EXISTS memory_type TEXT;

DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'ai_memory_entries_memory_type_check'
        ) THEN
          ALTER TABLE ai_memory_entries
            ADD CONSTRAINT ai_memory_entries_memory_type_check
            CHECK (
              memory_type IS NULL
              OR memory_type IN ('episodic', 'semantic', 'procedural', 'reflective')
            );
        END IF;
      END $$;

-- legacy migration: 2026_02_22_012_importance_scoring
ALTER TABLE ai_memory_entries ADD COLUMN IF NOT EXISTS importance DOUBLE PRECISION;

DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'ai_memory_entries_importance_check'
        ) THEN
          ALTER TABLE ai_memory_entries
            ADD CONSTRAINT ai_memory_entries_importance_check
            CHECK (importance IS NULL OR (importance >= 0 AND importance <= 1));
        END IF;
      END $$;

-- legacy migration: 2026_02_22_013_goal_hierarchy
CREATE TABLE IF NOT EXISTS ai_goals (
        id BIGSERIAL PRIMARY KEY,
        goal_id UUID NOT NULL,
        parent_goal_id UUID,
        level TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        project TEXT,
        agent TEXT,
        session_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        CONSTRAINT ai_goals_goal_id_unique UNIQUE (goal_id),
        CONSTRAINT ai_goals_parent_goal_fk
          FOREIGN KEY (parent_goal_id)
          REFERENCES ai_goals(goal_id)
          ON DELETE SET NULL,
        CONSTRAINT ai_goals_level_check
          CHECK (level IN ('mission', 'objective', 'task')),
        CONSTRAINT ai_goals_status_check
          CHECK (status IN ('active', 'completed', 'abandoned', 'blocked')),
        CONSTRAINT ai_goals_tree_shape_check
          CHECK (
            (level = 'mission' AND parent_goal_id IS NULL) OR
            (level IN ('objective', 'task') AND parent_goal_id IS NOT NULL)
          )
      );

CREATE UNIQUE INDEX IF NOT EXISTS ai_goals_goal_id_uidx
      ON ai_goals(goal_id);

CREATE INDEX IF NOT EXISTS ai_goals_project_status_idx
      ON ai_goals(project, status);

CREATE INDEX IF NOT EXISTS ai_goals_parent_goal_idx
      ON ai_goals(parent_goal_id);

-- legacy migration: 2026_02_23_014_memory_type_not_null_enforcement
UPDATE ai_memory_entries
      SET memory_type = CASE lower(coalesce(category, ''))
        WHEN 'architecture' THEN 'semantic'
        WHEN 'audit-log' THEN 'episodic'
        WHEN 'bugfix' THEN 'episodic'
        WHEN 'checkpoint' THEN 'episodic'
        WHEN 'convention' THEN 'semantic'
        WHEN 'decision' THEN 'semantic'
        WHEN 'implementation-note' THEN 'episodic'
        WHEN 'preference' THEN 'procedural'
        WHEN 'root-cause' THEN 'episodic'
        WHEN 'session-summary' THEN 'episodic'
        WHEN 'workflow' THEN 'procedural'
        ELSE 'episodic'
      END
      WHERE memory_type IS NULL;

ALTER TABLE ai_memory_entries ALTER COLUMN memory_type SET NOT NULL;

ALTER TABLE ai_memory_entries DROP CONSTRAINT IF EXISTS ai_memory_entries_memory_type_check;

ALTER TABLE ai_memory_entries
        ADD CONSTRAINT ai_memory_entries_memory_type_check
        CHECK (memory_type IN ('episodic', 'semantic', 'procedural', 'reflective'));

-- legacy migration: 2026_02_23_015_drop_goal_hierarchy_schema
DROP TABLE IF EXISTS ai_goals;

-- legacy migration: 2026_02_25_016_tool_invocations
CREATE TABLE IF NOT EXISTS ai_tool_invocations (
        id BIGSERIAL PRIMARY KEY,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        tool_name TEXT NOT NULL,
        tool_category TEXT,
        status TEXT NOT NULL,
        response_status TEXT,
        duration_ms INTEGER,
        warning_count INTEGER NOT NULL DEFAULT 0,
        timeout_warning_count INTEGER NOT NULL DEFAULT 0,
        resolved_via TEXT,
        write_disposition TEXT,
        invocation_id TEXT,
        session_id TEXT,
        project TEXT,
        repo_id TEXT,
        summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

CREATE UNIQUE INDEX IF NOT EXISTS ai_tool_invocations_invocation_id_uidx
      ON ai_tool_invocations(invocation_id)
      WHERE invocation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ai_tool_invocations_created_at_idx
      ON ai_tool_invocations(created_at DESC);

CREATE INDEX IF NOT EXISTS ai_tool_invocations_tool_name_created_idx
      ON ai_tool_invocations(tool_name, created_at);

CREATE INDEX IF NOT EXISTS ai_tool_invocations_status_created_idx
      ON ai_tool_invocations(status, created_at);

CREATE INDEX IF NOT EXISTS ai_tool_invocations_retention_created_idx
      ON ai_tool_invocations(created_at, id);

-- legacy migration: 2026_02_25_017_reviewer_decision_importance_backfill
UPDATE ai_memory_entries
      SET importance = 0.75
      WHERE lower(category) = 'decision'
        AND lower(source) LIKE '%reviewer%'
        AND tags @> ARRAY['approved']
        AND NOT (tags && ARRAY['request-changes', 'changes-requested'])
        AND importance IS DISTINCT FROM 0.75;

UPDATE ai_memory_entries
      SET importance = 0.90
      WHERE lower(category) = 'decision'
        AND lower(source) LIKE '%reviewer%'
        AND (tags @> ARRAY['request-changes'] OR tags @> ARRAY['changes-requested'])
        AND importance IS DISTINCT FROM 0.90;

-- legacy migration: 2026_02_25_018_ingestion_failure_resolution
ALTER TABLE ai_ingestion_failures
        ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS resolved_by TEXT,
        ADD COLUMN IF NOT EXISTS resolved_reason TEXT,
        ADD COLUMN IF NOT EXISTS resolution_batch_id TEXT;

CREATE INDEX IF NOT EXISTS ai_ingestion_failures_unresolved_idx
      ON ai_ingestion_failures(created_at DESC)
      WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS ai_ingestion_failures_batch_idx
      ON ai_ingestion_failures(resolution_batch_id)
      WHERE resolution_batch_id IS NOT NULL;

-- legacy migration: 2026_02_26_019_write_calibration_confidence
ALTER TABLE ai_memory_entries ADD COLUMN IF NOT EXISTS declared_confidence DOUBLE PRECISION;

ALTER TABLE ai_memory_entries ADD COLUMN IF NOT EXISTS calibrated_confidence DOUBLE PRECISION;

DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'ai_memory_entries_declared_confidence_check'
        ) THEN
          ALTER TABLE ai_memory_entries
            ADD CONSTRAINT ai_memory_entries_declared_confidence_check
            CHECK (declared_confidence IS NULL OR (declared_confidence >= 0 AND declared_confidence <= 1));
        END IF;
      END $$;

DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'ai_memory_entries_calibrated_confidence_check'
        ) THEN
          ALTER TABLE ai_memory_entries
            ADD CONSTRAINT ai_memory_entries_calibrated_confidence_check
            CHECK (calibrated_confidence IS NULL OR (calibrated_confidence >= 0 AND calibrated_confidence <= 1));
        END IF;
      END $$;

CREATE INDEX IF NOT EXISTS ai_memory_entries_author_category_created_idx
      ON ai_memory_entries (
        COALESCE(NULLIF(agent, ''), NULLIF(updated_by, ''), NULLIF(source, ''), 'unknown'),
        category,
        created_at DESC
      );
