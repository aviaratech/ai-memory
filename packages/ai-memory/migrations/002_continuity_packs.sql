CREATE TABLE IF NOT EXISTS ai_continuity_packs (
        scope_key TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        session_id TEXT,
        source TEXT NOT NULL,
        payload_chars INTEGER NOT NULL DEFAULT 0,
        budget_chars INTEGER NOT NULL DEFAULT 0,
        pack_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT ai_continuity_packs_payload_chars_check
          CHECK (payload_chars >= 0),
        CONSTRAINT ai_continuity_packs_budget_chars_check
          CHECK (budget_chars >= 0),
        CONSTRAINT ai_continuity_packs_session_fk
          FOREIGN KEY (session_id)
          REFERENCES ai_sessions(session_id)
          ON DELETE SET NULL
      );

CREATE INDEX IF NOT EXISTS ai_continuity_packs_project_updated_idx
      ON ai_continuity_packs(project, updated_at DESC);

CREATE INDEX IF NOT EXISTS ai_continuity_packs_session_idx
      ON ai_continuity_packs(session_id)
      WHERE session_id IS NOT NULL;
