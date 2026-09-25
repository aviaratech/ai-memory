import { normalizeMetadata, toJsonbParam } from './normalization.js';

interface ContextPackUpsertInput {
  budgetsJson: unknown;
  createdAt: string;
  packId: string;
  pinnedJson: unknown;
  producedByAgent: string;
  producedByInstanceId?: string | undefined;
  rawJson: unknown;
  schemaVersion: string;
  sessionId: string;
  statsJson: unknown;
  taskJson: unknown;
  tenancyJson: unknown;
  workingSetJson: unknown;
}

interface DatabaseClient {
  query(text: string, values?: readonly unknown[]): DbQueryResult | Promise<DbQueryResult>;
}

interface DbQueryResult {
  rowCount?: null | number;
  rows: Record<string, unknown>[];
}

interface MemoryDeltaUpsertInput {
  appendEventsJson: unknown;
  artifactsJson: unknown;
  createdAt: string;
  deltaId: string;
  producedByAgent: string;
  producedByModel?: string | undefined;
  rawJson: unknown;
  schemaVersion: string;
  sessionId: string;
  snapshotJson: unknown;
  snapshotMode: string;
  telemetryJson: unknown;
  tenancyJson: unknown;
}

interface SessionSnapshotUpsertInput {
  createdAt: string;
  schemaVersion: string;
  sessionId: string;
  snapshotId: string;
  snapshotJson: unknown;
  sourceDeltaId?: string | undefined;
}

interface SessionUpsertInput {
  agent?: string | undefined;
  metadata?: unknown;
  model?: string | undefined;
  orgId?: string | undefined;
  repoId?: string | undefined;
  repoSlug?: string | undefined;
  sessionId: string;
  taskId?: string | undefined;
  taskTitle?: string | undefined;
  taskType?: string | undefined;
  tool?: string | undefined;
  updatedAt?: string | undefined;
  userId?: string | undefined;
}

export async function upsertContextPackWithClient(client: DatabaseClient, input: ContextPackUpsertInput) {
  const sql = `
    INSERT INTO ai_context_packs (
      pack_id,
      schema_version,
      session_id,
      produced_by_agent,
      produced_by_instance_id,
      tenancy_json,
      task_json,
      pinned_json,
      working_set_json,
      budgets_json,
      stats_json,
      raw_json,
      created_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
    )
    ON CONFLICT (pack_id)
    DO UPDATE
      SET
        schema_version = EXCLUDED.schema_version,
        session_id = EXCLUDED.session_id,
        produced_by_agent = EXCLUDED.produced_by_agent,
        produced_by_instance_id = EXCLUDED.produced_by_instance_id,
        tenancy_json = EXCLUDED.tenancy_json,
        task_json = EXCLUDED.task_json,
        pinned_json = EXCLUDED.pinned_json,
        working_set_json = EXCLUDED.working_set_json,
        budgets_json = EXCLUDED.budgets_json,
        stats_json = EXCLUDED.stats_json,
        raw_json = EXCLUDED.raw_json,
        created_at = EXCLUDED.created_at
  `;

  const params: unknown[] = [
    input.packId,
    input.schemaVersion,
    input.sessionId,
    input.producedByAgent,
    input.producedByInstanceId,
    toJsonbParam(input.tenancyJson),
    toJsonbParam(input.taskJson),
    toJsonbParam(input.pinnedJson),
    toJsonbParam(input.workingSetJson),
    toJsonbParam(input.budgetsJson),
    toJsonbParam(input.statsJson),
    toJsonbParam(input.rawJson),
    input.createdAt,
  ];

  await client.query(sql, params);
}

export async function upsertMemoryDeltaWithClient(client: DatabaseClient, input: MemoryDeltaUpsertInput) {
  const sql = `
    INSERT INTO ai_memory_deltas (
      delta_id,
      schema_version,
      session_id,
      produced_by_agent,
      produced_by_model,
      tenancy_json,
      snapshot_mode,
      snapshot_json,
      append_events_json,
      artifacts_json,
      telemetry_json,
      raw_json,
      created_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
    )
    ON CONFLICT (delta_id)
    DO UPDATE
      SET
        schema_version = EXCLUDED.schema_version,
        session_id = EXCLUDED.session_id,
        produced_by_agent = EXCLUDED.produced_by_agent,
        produced_by_model = EXCLUDED.produced_by_model,
        tenancy_json = EXCLUDED.tenancy_json,
        snapshot_mode = EXCLUDED.snapshot_mode,
        snapshot_json = EXCLUDED.snapshot_json,
        append_events_json = EXCLUDED.append_events_json,
        artifacts_json = EXCLUDED.artifacts_json,
        telemetry_json = EXCLUDED.telemetry_json,
        raw_json = EXCLUDED.raw_json,
        created_at = EXCLUDED.created_at
  `;

  const params: unknown[] = [
    input.deltaId,
    input.schemaVersion,
    input.sessionId,
    input.producedByAgent,
    input.producedByModel,
    toJsonbParam(input.tenancyJson),
    input.snapshotMode,
    toJsonbParam(input.snapshotJson),
    toJsonbParam(input.appendEventsJson),
    toJsonbParam(input.artifactsJson),
    toJsonbParam(input.telemetryJson),
    toJsonbParam(input.rawJson),
    input.createdAt,
  ];

  await client.query(sql, params);
}

export async function upsertSessionSnapshotWithClient(client: DatabaseClient, input: SessionSnapshotUpsertInput) {
  const sql = `
    INSERT INTO ai_session_snapshots (
      snapshot_id,
      session_id,
      schema_version,
      snapshot_json,
      source_delta_id,
      created_at
    )
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (snapshot_id)
    DO UPDATE
      SET
        session_id = EXCLUDED.session_id,
        schema_version = EXCLUDED.schema_version,
        snapshot_json = EXCLUDED.snapshot_json,
        source_delta_id = EXCLUDED.source_delta_id,
        created_at = EXCLUDED.created_at
  `;

  const params: unknown[] = [
    input.snapshotId,
    input.sessionId,
    input.schemaVersion,
    toJsonbParam(input.snapshotJson),
    input.sourceDeltaId,
    input.createdAt,
  ];

  await client.query(sql, params);
}

export async function upsertSessionWithClient(client: DatabaseClient, input: SessionUpsertInput) {
  const metadata = normalizeMetadata(input.metadata);
  const sql = `
    INSERT INTO ai_sessions (
      session_id,
      org_id,
      repo_id,
      repo_slug,
      user_id,
      agent,
      model,
      tool,
      task_id,
      task_type,
      task_title,
      status,
      metadata_json,
      started_at,
      updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
      'active', $12, COALESCE($13::timestamptz, NOW()), COALESCE($13::timestamptz, NOW())
    )
    ON CONFLICT (session_id)
    DO UPDATE
      SET
        org_id = COALESCE(EXCLUDED.org_id, ai_sessions.org_id),
        repo_id = COALESCE(EXCLUDED.repo_id, ai_sessions.repo_id),
        repo_slug = COALESCE(EXCLUDED.repo_slug, ai_sessions.repo_slug),
        user_id = COALESCE(EXCLUDED.user_id, ai_sessions.user_id),
        agent = COALESCE(EXCLUDED.agent, ai_sessions.agent),
        model = COALESCE(EXCLUDED.model, ai_sessions.model),
        tool = COALESCE(EXCLUDED.tool, ai_sessions.tool),
        task_id = COALESCE(EXCLUDED.task_id, ai_sessions.task_id),
        task_type = COALESCE(EXCLUDED.task_type, ai_sessions.task_type),
        task_title = COALESCE(EXCLUDED.task_title, ai_sessions.task_title),
        metadata_json = COALESCE(ai_sessions.metadata_json, '{}'::jsonb) || EXCLUDED.metadata_json,
        updated_at = COALESCE(EXCLUDED.updated_at, NOW())
    RETURNING session_id
  `;

  const params: unknown[] = [
    input.sessionId,
    input.orgId,
    input.repoId,
    input.repoSlug,
    input.userId,
    input.agent,
    input.model,
    input.tool,
    input.taskId,
    input.taskType,
    input.taskTitle,
    toJsonbParam(metadata),
    input.updatedAt,
  ];

  await client.query(sql, params);
}
