import { stableJsonHash } from './hashing.js';
import { toJsonbParam } from './normalization.js';
import { toIngestionFailureRecord } from './records.js';

interface DatabaseClient {
  query(text: string, values?: readonly unknown[]): DbQueryResult | Promise<DbQueryResult>;
}

interface DbQueryResult {
  rowCount?: null | number;
  rows: Record<string, unknown>[];
}

interface EventConflictFailureInput {
  eventId: string;
  existingHash: string;
  existingRawHash: string;
  incomingHash: string;
  incomingRawHash: string;
  sessionId?: string | undefined;
}

interface ExistingConflictFailureRow extends Record<string, unknown> {
  id?: unknown;
}

interface ExistingPayloadRow extends Record<string, unknown> {
  payload_json?: unknown;
}

interface IngestionFailureInsertInput {
  agent?: string | undefined;
  details?: unknown;
  errorMessage: string;
  repoId?: string | undefined;
  sessionId?: string | undefined;
  source: string;
  stage: string;
}

interface MemoryEventInsertInput {
  actor?: string | undefined;
  eventType: string;
  memoryId: number;
  payloadJson: unknown;
}

interface SessionEventInsertInput {
  createdAt: string;
  eventId: string;
  eventType: string;
  payloadJson: unknown;
  sessionId: string;
  summary?: string | undefined;
}

const EVENT_CONFLICT_SOURCE = 'ai-memory';
const EVENT_CONFLICT_STAGE = 'event_conflict_mismatch';
const VOLATILE_SESSION_EVENT_KEYS = new Set(['created_at', 'createdAt', 'timestamp', 'ts', 'updated_at', 'updatedAt']);

export async function insertIngestionFailureWithClient(client: DatabaseClient, input: IngestionFailureInsertInput) {
  const sessionLink = await resolveIngestionFailureSessionLink(client, {
    details: input.details,
    sessionId: input.sessionId,
  });
  const sql = `
    INSERT INTO ai_ingestion_failures (
      source,
      stage,
      session_id,
      agent,
      repo_id,
      error_message,
      details_json
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
  `;

  const result = await client.query(sql, [
    input.source,
    input.stage,
    sessionLink.sessionId,
    input.agent,
    input.repoId,
    input.errorMessage,
    toJsonbParam(sessionLink.details),
  ]);
  return toIngestionFailureRecord(result.rows[0]);
}

export async function insertMemoryEventWithClient(client: DatabaseClient, input: MemoryEventInsertInput) {
  const sql = `
    INSERT INTO ai_memory_events (
      memory_id,
      event_type,
      actor,
      payload_json
    )
    VALUES ($1, $2, $3, $4)
  `;

  await client.query(sql, [input.memoryId, input.eventType, input.actor, toJsonbParam(input.payloadJson)]);
}

export async function insertSessionEventWithClient(client: DatabaseClient, input: SessionEventInsertInput) {
  const sql = `
    INSERT INTO ai_session_events (
      event_id,
      session_id,
      event_type,
      summary,
      payload_json,
      created_at
    )
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (event_id)
    DO NOTHING
    RETURNING event_id
  `;

  const params: unknown[] = [
    input.eventId,
    input.sessionId,
    input.eventType,
    input.summary,
    toJsonbParam(input.payloadJson),
    input.createdAt,
  ];

  const result = await client.query(sql, params);
  if ((result.rowCount ?? 0) === 0) {
    await detectEventConflictMismatch(client, input);
  }
}

function addUnlinkedSessionDetails(details: unknown, sessionId: string): Record<string, unknown> {
  const base = isRecord(details) ? details : { original_details: details ?? null };
  return {
    ...base,
    session_link_status: 'missing_session',
    unlinked_session_id: sessionId,
  };
}

function canonicalizeSessionEventPayload(payload: unknown): unknown {
  if (Array.isArray(payload)) {
    return payload.map(item => canonicalizeSessionEventPayload(item));
  }

  if (payload === null || typeof payload !== 'object') {
    return payload;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (VOLATILE_SESSION_EVENT_KEYS.has(key)) {
      continue;
    }

    normalized[key] = canonicalizeSessionEventPayload(value);
  }

  return normalized;
}

async function detectEventConflictMismatch(client: DatabaseClient, input: SessionEventInsertInput) {
  const existingResult = await client.query('SELECT payload_json FROM ai_session_events WHERE event_id = $1', [
    input.eventId,
  ]);
  const existingRows = existingResult.rows as ExistingPayloadRow[];

  if (existingRows.length === 0) {
    return;
  }

  const existingRawPayload = existingRows[0]?.payload_json;
  const existingHash = stableJsonHash(canonicalizeSessionEventPayload(existingRawPayload));
  const incomingHash = stableJsonHash(canonicalizeSessionEventPayload(input.payloadJson));
  if (existingHash === incomingHash) {
    return;
  }

  const existingRawHash = stableJsonHash(existingRawPayload);
  const incomingRawHash = stableJsonHash(input.payloadJson);

  await insertEventConflictFailureWithClient(client, {
    eventId: input.eventId,
    existingHash,
    existingRawHash,
    incomingHash,
    incomingRawHash,
    sessionId: input.sessionId,
  });
}

async function insertEventConflictFailureWithClient(client: DatabaseClient, input: EventConflictFailureInput) {
  const advisoryLockSql = `
    SELECT pg_advisory_xact_lock(hashtext($1))
  `;
  const advisoryLockKey = [
    EVENT_CONFLICT_SOURCE,
    EVENT_CONFLICT_STAGE,
    input.sessionId ?? '<none>',
    input.eventId,
    input.existingHash,
    input.incomingHash,
  ].join('|');
  await client.query(advisoryLockSql, [advisoryLockKey]);

  const existingFailureSql = `
    SELECT id
    FROM ai_ingestion_failures
    WHERE source = $1
      AND stage = $2
      AND session_id IS NOT DISTINCT FROM $3
      AND details_json ->> 'eventId' = $4
      AND details_json ->> 'existingHash' = $5
      AND details_json ->> 'incomingHash' = $6
    LIMIT 1
  `;
  const existingFailureResult = await client.query(existingFailureSql, [
    EVENT_CONFLICT_SOURCE,
    EVENT_CONFLICT_STAGE,
    input.sessionId,
    input.eventId,
    `sha256:${input.existingHash}`,
    `sha256:${input.incomingHash}`,
  ]);
  const existingFailures = existingFailureResult.rows as ExistingConflictFailureRow[];
  if (existingFailures.length > 0) {
    return;
  }

  await insertIngestionFailureWithClient(client, {
    details: {
      comparison: 'session_event_payload_v1',
      eventId: input.eventId,
      existingHash: `sha256:${input.existingHash}`,
      existingRawHash: `sha256:${input.existingRawHash}`,
      incomingHash: `sha256:${input.incomingHash}`,
      incomingRawHash: `sha256:${input.incomingRawHash}`,
    },
    errorMessage: `Event ${input.eventId} conflict: payload hash mismatch (existing: ${input.existingHash.slice(0, 12)}, incoming: ${input.incomingHash.slice(0, 12)})`,
    sessionId: input.sessionId,
    source: EVENT_CONFLICT_SOURCE,
    stage: EVENT_CONFLICT_STAGE,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function resolveIngestionFailureSessionLink(
  client: DatabaseClient,
  input: {
    details: unknown;
    sessionId: string | undefined;
  },
): Promise<{ details: unknown; sessionId: null | string }> {
  const { details, sessionId } = input;
  if (sessionId === undefined) {
    return { details, sessionId: null };
  }

  const existingSession = await client.query('SELECT 1 FROM ai_sessions WHERE session_id = $1 LIMIT 1', [sessionId]);
  if (existingSession.rows.length > 0) {
    return { details, sessionId };
  }

  return {
    details: addUnlinkedSessionDetails(details, sessionId),
    sessionId: null,
  };
}
