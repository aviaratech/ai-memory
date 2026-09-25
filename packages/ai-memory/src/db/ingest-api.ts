import { resolveTimeoutPolicy } from '../timeout-policy.js';
import { insertSessionEventWithClient } from './failure-events.js';
import { ingestMemoryDeltaInTransaction } from './ingest-memory-delta-in-transaction.js';
import {
  normalizeOptionalText,
  normalizeProjectScope,
  normalizeRequiredText,
  normalizeRequiredTimestamp,
  normalizeWorkflowMetadata,
  selectContractPayload,
} from './normalization.js';
import { runBoundedQuery } from './query-runner.js';
import { CONTEXT_PACK_TOOL, pool } from './runtime.js';
import { assertValidContextPack } from './schema-validation.js';
import { getSessionProjectWithClient } from './session-api.js';
import { upsertContextPackWithClient, upsertSessionSnapshotWithClient, upsertSessionWithClient } from './upserts.js';

interface ContextPackPayload extends JsonRecord {
  budgets?: JsonRecord;
  created_at: string;
  pack_id: string;
  pinned?: JsonRecord;
  produced_by: ContextPackProducedBy;
  schema_version: string;
  session: JsonRecord & {
    recent_events?: ContextPackRecentEvent[];
    session_id: string;
    snapshot: ContextPackSnapshot;
  };
  stats?: JsonRecord;
  task: JsonRecord & {
    task_id?: string;
    title?: string;
    type?: string;
  };
  tenancy: JsonRecord & {
    org_id?: string;
    repo_id?: string;
    repo_slug?: string;
    user_id?: string;
  };
  workflow?: JsonRecord;
  working_set?: JsonRecord;
}

interface ContextPackProducedBy extends JsonRecord {
  agent: string;
  instance_id?: string;
}

interface ContextPackRecentEvent extends JsonRecord {
  event_id: string;
  summary: string;
  ts: string;
  type: string;
}

interface ContextPackSnapshot extends JsonRecord {
  created_at?: string;
  snapshot_id: string;
}

type IngestApiClient = Parameters<typeof insertSessionEventWithClient>[0];

type JsonRecord = Record<string, unknown>;

interface ParsedContextPackIngestion {
  contextPack: ContextPackPayload;
  packCreatedAt: string;
  recentEvents: ContextPackRecentEvent[];
  sessionId: string;
  snapshot: ContextPackSnapshot;
  snapshotCreatedAt: string;
  workflowMetadata: ReturnType<typeof normalizeWorkflowMetadata>;
}

export async function ingestContextPack(input: unknown) {
  const parsed = parseContextPackIngestion(input);
  return await runBoundedQuery({
    phase: 'db.write.ingest_context_pack',
    pool,
    task: async client => {
      await writeContextPackRows(client, parsed);
      return buildContextPackIngestResult(parsed);
    },
    timeoutMs: resolveTimeoutPolicy().db.writeTimeoutMs,
  });
}

export async function ingestMemoryDelta(input: unknown) {
  return await runBoundedQuery({
    phase: 'db.write.ingest_memory_delta',
    pool,
    task: client => ingestMemoryDeltaInTransaction(client, input),
    timeoutMs: resolveTimeoutPolicy().db.writeTimeoutMs,
  });
}

function buildContextPackIngestResult(parsed: ParsedContextPackIngestion) {
  return {
    eventsIngested: parsed.recentEvents.length,
    packId: parsed.contextPack.pack_id,
    schemaVersion: parsed.contextPack.schema_version,
    sessionId: parsed.sessionId,
    snapshotId: parsed.snapshot.snapshot_id,
    status: 'ok' as const,
  };
}

async function insertContextPackRecentEvents(client: IngestApiClient, input: ParsedContextPackIngestion) {
  for (const event of input.recentEvents) {
    await insertSessionEventWithClient(client, {
      createdAt: normalizeRequiredTimestamp(event.ts, `contextPack.session.recent_events.${event.event_id}.ts`),
      eventId: event.event_id,
      eventType: event.type,
      payloadJson: event,
      sessionId: input.sessionId,
      summary: event.summary,
    });
  }
}

function parseContextPackIngestion(input: unknown): ParsedContextPackIngestion {
  const contextPack = parseContextPackPayload(input);
  const snapshot = contextPack.session.snapshot;
  return {
    contextPack,
    packCreatedAt: normalizeRequiredTimestamp(contextPack.created_at, 'contextPack.created_at'),
    recentEvents: Array.isArray(contextPack.session.recent_events) ? contextPack.session.recent_events : [],
    sessionId: contextPack.session.session_id,
    snapshot,
    snapshotCreatedAt: normalizeRequiredTimestamp(
      snapshot.created_at ?? contextPack.created_at,
      'contextPack.session.snapshot.created_at',
    ),
    workflowMetadata: normalizeWorkflowMetadata(contextPack.workflow),
  };
}

function parseContextPackPayload(input: unknown): ContextPackPayload {
  const contextPack = selectContractPayload(input, 'contextPack');
  assertValidContextPack(contextPack);
  return contextPack as ContextPackPayload;
}

async function writeContextPackRows(client: IngestApiClient, input: ParsedContextPackIngestion) {
  let repoId = normalizeOptionalText(input.contextPack.tenancy.repo_id);
  if (!repoId?.includes('/')) {
    repoId = normalizeProjectScope({
      project: repoId,
      repoId: await getSessionProjectWithClient(client, input.sessionId),
      repoSlug: input.contextPack.tenancy.repo_slug,
    });
  }
  await upsertSessionWithClient(client, {
    agent: normalizeRequiredText(input.contextPack.produced_by.agent, 'contextPack.produced_by.agent'),
    metadata: {
      produced_by_instance_id: normalizeOptionalText(input.contextPack.produced_by.instance_id),
      source_contract: 'context_pack@0.1',
      ...(input.workflowMetadata ? { workflow: input.workflowMetadata } : {}),
    },
    orgId: normalizeOptionalText(input.contextPack.tenancy.org_id),
    repoId,
    repoSlug: normalizeOptionalText(input.contextPack.tenancy.repo_slug),
    sessionId: input.sessionId,
    taskId: normalizeOptionalText(input.contextPack.task.task_id),
    taskTitle: normalizeOptionalText(input.contextPack.task.title),
    taskType: normalizeOptionalText(input.contextPack.task.type),
    tool: CONTEXT_PACK_TOOL,
    updatedAt: input.packCreatedAt,
    userId: normalizeOptionalText(input.contextPack.tenancy.user_id),
  });

  await upsertContextPackWithClient(client, {
    budgetsJson: input.contextPack.budgets ?? {},
    createdAt: input.packCreatedAt,
    packId: input.contextPack.pack_id,
    pinnedJson: input.contextPack.pinned ?? {},
    producedByAgent: input.contextPack.produced_by.agent,
    producedByInstanceId: normalizeOptionalText(input.contextPack.produced_by.instance_id),
    rawJson: input.contextPack,
    schemaVersion: input.contextPack.schema_version,
    sessionId: input.sessionId,
    statsJson: input.contextPack.stats ?? {},
    taskJson: input.contextPack.task,
    tenancyJson: input.contextPack.tenancy,
    workingSetJson: input.contextPack.working_set ?? {},
  });

  await upsertSessionSnapshotWithClient(client, {
    createdAt: input.snapshotCreatedAt,
    schemaVersion: 'session_snapshot@0.1',
    sessionId: input.sessionId,
    snapshotId: input.snapshot.snapshot_id,
    snapshotJson: input.snapshot,
    sourceDeltaId: undefined,
  });

  await insertContextPackRecentEvents(client, input);
}
