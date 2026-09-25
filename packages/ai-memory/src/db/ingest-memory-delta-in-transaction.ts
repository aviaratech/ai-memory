import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

import { insertMemoryEventWithClient, insertSessionEventWithClient } from './failure-events.js';
import { createDurableMemoryKey } from './hashing.js';
import { createDeltaEventId } from './ids.js';
import { storeMemoryWithClient } from './memory-store.js';
import {
  addDaysToIso,
  normalizeDurableMemoryProposals,
  normalizeOptionalText,
  normalizeProjectScope,
  normalizeRequiredText,
  normalizeRequiredTimestamp,
  normalizeWorkflowMetadata,
  selectContractPayload,
} from './normalization.js';
import { MEMORY_DELTA_TOOL } from './runtime.js';
import { assertValidMemoryDelta } from './schema-validation.js';
import { getSessionProjectWithClient } from './session-api.js';
import { materializeSessionSnapshotForDeltaWithClient } from './snapshot-materialization.js';
import { isRecord } from './type-guards.js';
import { upsertMemoryDeltaWithClient, upsertSessionWithClient } from './upserts.js';

export interface IngestMemoryDeltaClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<IngestMemoryDeltaQueryResult<Row>>;
}

export interface IngestMemoryDeltaQueryResult<Row> {
  rowCount?: null | number;
  rows: Row[];
}

export interface IngestMemoryDeltaResult extends Record<string, unknown> {
  deltaId: string;
  durableMemoriesDeduped: number;
  durableMemoriesInserted: number;
  durableMemoriesStored: number;
  durableMemoriesUpdated: number;
  eventsIngested: number;
  schemaVersion: string;
  sessionId: string;
  status: 'ok';
  storedDurableMemoryIds: number[];
}

interface DurableMemoryStats {
  durableMemoriesDeduped: number;
  durableMemoriesInserted: number;
  durableMemoriesUpdated: number;
  storedDurableMemoryIds: number[];
}

interface IngestMemoryDeltaContext {
  appendEvents: MemoryDeltaAppendEvent[];
  deltaCreatedAt: string;
  durableMemories: ReturnType<typeof normalizeDurableMemoryProposals>;
  memoryDelta: MemoryDeltaPayload;
  producedByAgent: string;
  producedByModel: string | undefined;
  sessionId: string;
  tenancyOrgId: string | undefined;
  tenancyRepoId: string | undefined;
  tenancyRepoSlug: string | undefined;
  tenancyUserId: string | undefined;
  workflowMetadata: ReturnType<typeof normalizeWorkflowMetadata>;
}

type JsonRecord = Record<string, unknown>;

interface MemoryDeltaAppendEvent extends JsonRecord {
  summary: string;
  ts?: string;
  type: string;
}

interface MemoryDeltaPayload extends JsonRecord {
  append_events?: MemoryDeltaAppendEvent[];
  artifacts?: unknown[];
  created_at: string;
  delta_id: string;
  produced_by: JsonRecord & {
    agent: string;
    model?: string;
  };
  schema_version: string;
  session_id: string;
  snapshot: MemoryDeltaSnapshot;
  telemetry?: JsonRecord & {
    pack_used_id?: string;
  };
  tenancy: JsonRecord & {
    org_id?: string;
    repo_id?: string;
    repo_slug?: string;
    user_id?: string;
  };
  workflow?: JsonRecord;
  x_durable_memories?: unknown;
}

interface MemoryDeltaSnapshot extends JsonRecord {
  mode: 'patch' | 'replace';
  value: unknown;
}

interface StoredMemoryRecord {
  id: number;
  writeDisposition: 'dedupe_update' | 'inserted' | 'keyed_upsert';
}

/**
 * Ingest a memory delta using a caller-provided database client.
 *
 * TRANSACTION CONTRACT: The caller owns the transaction. This function
 * does NOT call BEGIN/COMMIT/ROLLBACK. It must be called within an
 * active transaction managed by the caller.
 *
 * For a self-contained convenience wrapper that manages its own transaction,
 * use `ingestMemoryDelta()` from `./ingest-api.js`.
 */
export async function ingestMemoryDeltaInTransaction(client: IngestMemoryDeltaClient, input: unknown) {
  const context = parseIngestMemoryDeltaContext(input);
  if (!context.tenancyRepoId?.includes('/')) {
    context.tenancyRepoId = normalizeProjectScope({
      project: context.tenancyRepoId,
      repoId: await getSessionProjectWithClient(client, context.sessionId),
    });
  }

  await upsertSessionForDelta(client, context);
  await upsertDeltaWithSnapshot(client, context);
  await insertDeltaEvents(client, context);

  const durableStats = await storeDurableMemories(client, context);
  return buildIngestMemoryDeltaResult(context, durableStats);
}

export function normalizeMemoryDeltaRelatedLinks(memoryDelta: unknown): void {
  if (!isRecord(memoryDelta)) return;
  const snapshot = memoryDelta.snapshot;
  if (!isRecord(snapshot)) return;
  const snapshotValue = snapshot.value;
  if (!isRecord(snapshotValue)) return;
  const anchors = snapshotValue.anchors;
  if (!isRecord(anchors)) return;
  const relatedLinks = anchors.related_links;
  if (!Array.isArray(relatedLinks)) return;
  for (const link of relatedLinks) {
    if (isRecord(link) && typeof link.url === 'string') {
      link.url = normalizeRelatedLinkUrl(link.url);
    }
  }
}

/**
 * Normalize each `snapshot.value.anchors.related_links[i].url` so the AJV
 * `format: "uri"` check at `assertValidMemoryDelta` accepts producer payloads
 * that supplied an absolute filesystem path instead of a file:// URI.
 *
 * Absolute paths are converted via `pathToFileURL`. Already-valid URIs
 * (http://, https://, file://, mailto:, etc.) pass through unchanged so the
 * stored payload contract stays strict for downstream consumers. Anything
 * else (empty string, "foo bar", relative path) is returned unchanged so AJV
 * can still reject it — this preserves actionability for legitimate failures.
 *
 * Boundary contract: any caller of `ingestMemoryDelta` —
 * auto-session-ingest, agent-direct MCP `memory_ingest_delta`, future
 * producers — gets defensive normalization at the validation seam rather
 * than relying on each producer to remember the rule.
 */
export function normalizeRelatedLinkUrl(value: string): string {
  if (isValidUri(value)) {
    return value;
  }
  if (isAbsolute(value)) {
    return pathToFileURL(value).href;
  }
  return value;
}

function buildIngestMemoryDeltaResult(
  context: IngestMemoryDeltaContext,
  durableStats: DurableMemoryStats,
): IngestMemoryDeltaResult {
  return {
    deltaId: context.memoryDelta.delta_id,
    durableMemoriesDeduped: durableStats.durableMemoriesDeduped,
    durableMemoriesInserted: durableStats.durableMemoriesInserted,
    durableMemoriesStored: durableStats.storedDurableMemoryIds.length,
    durableMemoriesUpdated: durableStats.durableMemoriesUpdated,
    eventsIngested: context.appendEvents.length,
    schemaVersion: context.memoryDelta.schema_version,
    sessionId: context.sessionId,
    status: 'ok',
    storedDurableMemoryIds: durableStats.storedDurableMemoryIds,
  };
}

async function insertDeltaEvents(client: IngestMemoryDeltaClient, context: IngestMemoryDeltaContext) {
  for (const [index, event] of context.appendEvents.entries()) {
    const eventCreatedAt = normalizeRequiredTimestamp(
      event.ts ?? context.memoryDelta.created_at,
      `memoryDelta.append_events[${String(index)}].ts`,
    );

    await insertSessionEventWithClient(client, {
      createdAt: eventCreatedAt,
      eventId: createDeltaEventId(context.memoryDelta.delta_id, index),
      eventType: event.type,
      payloadJson: event,
      sessionId: context.sessionId,
      summary: event.summary,
    });
  }
}

async function insertIngestedMemoryEvent(input: {
  client: IngestMemoryDeltaClient;
  context: IngestMemoryDeltaContext;
  memoryId: number;
  proposalIndex: number;
}) {
  await insertMemoryEventWithClient(input.client, {
    actor: input.context.producedByAgent,
    eventType: 'ingested_from_memory_delta',
    memoryId: input.memoryId,
    payloadJson: {
      delta_id: input.context.memoryDelta.delta_id,
      proposal_index: input.proposalIndex,
      session_id: input.context.sessionId,
    },
  });
}

function isValidUri(value: string): boolean {
  try {
    return new URL(value).href.length > 0;
  } catch {
    return false;
  }
}

function parseIngestMemoryDeltaContext(input: unknown): IngestMemoryDeltaContext {
  const memoryDelta = parseMemoryDeltaPayload(input);

  return {
    appendEvents: Array.isArray(memoryDelta.append_events) ? memoryDelta.append_events : [],
    deltaCreatedAt: normalizeRequiredTimestamp(memoryDelta.created_at, 'memoryDelta.created_at'),
    durableMemories: normalizeDurableMemoryProposals(memoryDelta.x_durable_memories),
    memoryDelta,
    producedByAgent: normalizeRequiredText(memoryDelta.produced_by.agent, 'memoryDelta.produced_by.agent'),
    producedByModel: normalizeOptionalText(memoryDelta.produced_by.model),
    sessionId: memoryDelta.session_id,
    tenancyOrgId: normalizeOptionalText(memoryDelta.tenancy.org_id),
    tenancyRepoId: normalizeOptionalText(memoryDelta.tenancy.repo_id),
    tenancyRepoSlug: normalizeOptionalText(memoryDelta.tenancy.repo_slug),
    tenancyUserId: normalizeOptionalText(memoryDelta.tenancy.user_id),
    workflowMetadata: normalizeWorkflowMetadata(memoryDelta.workflow),
  };
}

function parseMemoryDeltaPayload(input: unknown): MemoryDeltaPayload {
  const memoryDelta = selectContractPayload(input, 'memoryDelta');
  normalizeMemoryDeltaRelatedLinks(memoryDelta);
  assertValidMemoryDelta(memoryDelta);
  return memoryDelta as MemoryDeltaPayload;
}

async function storeDurableMemories(client: IngestMemoryDeltaClient, context: IngestMemoryDeltaContext) {
  const stats: DurableMemoryStats = {
    durableMemoriesDeduped: 0,
    durableMemoriesInserted: 0,
    durableMemoriesUpdated: 0,
    storedDurableMemoryIds: [],
  };

  for (const [index, proposal] of context.durableMemories.entries()) {
    const memoryRecord = await storeDurableMemoryProposal({
      client,
      context,
      index,
      proposal,
    });
    stats.storedDurableMemoryIds.push(memoryRecord.id);
    updateDurableMemoryStats(stats, memoryRecord);
    await insertIngestedMemoryEvent({
      client,
      context,
      memoryId: memoryRecord.id,
      proposalIndex: index,
    });
  }

  return stats;
}

async function storeDurableMemoryProposal(input: {
  client: IngestMemoryDeltaClient;
  context: IngestMemoryDeltaContext;
  index: number;
  proposal: IngestMemoryDeltaContext['durableMemories'][number];
}): Promise<StoredMemoryRecord> {
  const { client, context, index, proposal } = input;
  const project = normalizeProjectScope({
    project: proposal.project,
    repoId: context.tenancyRepoId,
    repoSlug: context.tenancyRepoSlug,
  });
  const derivedMemoryKey = createDurableMemoryKey({
    category: proposal.category,
    content: proposal.content,
    orgId: context.tenancyOrgId,
    project,
    repoId: context.tenancyRepoId,
    repoSlug: context.tenancyRepoSlug,
    sensitivity: proposal.sensitivity,
    tags: proposal.tags,
  });

  const memoryRecord = (await storeMemoryWithClient(client, {
    agent: context.producedByAgent,
    category: proposal.category,
    confidence: proposal.confidence,
    content: proposal.content,
    evidenceRefs: proposal.evidenceRefs,
    expiresAt:
      proposal.ttlDays === undefined
        ? undefined
        : addDaysToIso(proposal.sourceTimestamp ?? context.deltaCreatedAt, proposal.ttlDays),
    memoryKey: proposal.memoryKey ?? derivedMemoryKey,
    metadata: {
      delta_id: context.memoryDelta.delta_id,
      proposal_index: index,
      source_contract: 'memory_delta@0.1',
      ...(proposal.sourceModel === undefined ? {} : { source_turn_model: proposal.sourceModel }),
      ...(proposal.sourceTimestamp === undefined ? {} : { source_turn_timestamp: proposal.sourceTimestamp }),
      telemetry_pack_used_id: normalizeOptionalText(context.memoryDelta.telemetry?.pack_used_id),
    },
    model: context.producedByModel,
    orgId: context.tenancyOrgId,
    project,
    repoId: context.tenancyRepoId,
    repoSlug: context.tenancyRepoSlug,
    sensitivity: proposal.sensitivity,
    sessionId: context.sessionId,
    source: proposal.source ?? MEMORY_DELTA_TOOL,
    status: proposal.status,
    tags: proposal.tags,
    tool: MEMORY_DELTA_TOOL,
    updatedBy: context.producedByAgent,
    userId: context.tenancyUserId,
  })) as StoredMemoryRecord;

  return memoryRecord;
}

function updateDurableMemoryStats(stats: DurableMemoryStats, memoryRecord: StoredMemoryRecord) {
  if (memoryRecord.writeDisposition === 'inserted') {
    stats.durableMemoriesInserted += 1;
  } else {
    stats.durableMemoriesUpdated += 1;
  }

  if (memoryRecord.writeDisposition === 'dedupe_update') {
    stats.durableMemoriesDeduped += 1;
  }
}

async function upsertDeltaWithSnapshot(client: IngestMemoryDeltaClient, context: IngestMemoryDeltaContext) {
  await upsertMemoryDeltaWithClient(client, {
    appendEventsJson: context.appendEvents,
    artifactsJson: Array.isArray(context.memoryDelta.artifacts) ? context.memoryDelta.artifacts : [],
    createdAt: context.deltaCreatedAt,
    deltaId: context.memoryDelta.delta_id,
    producedByAgent: context.producedByAgent,
    producedByModel: context.producedByModel,
    rawJson: context.memoryDelta,
    schemaVersion: context.memoryDelta.schema_version,
    sessionId: context.sessionId,
    snapshotJson: context.memoryDelta.snapshot.value,
    snapshotMode: context.memoryDelta.snapshot.mode,
    telemetryJson: context.memoryDelta.telemetry ?? {},
    tenancyJson: context.memoryDelta.tenancy,
  });

  await materializeSessionSnapshotForDeltaWithClient(client, {
    deltaCreatedAt: context.deltaCreatedAt,
    deltaId: context.memoryDelta.delta_id,
    producedByAgent: context.producedByAgent,
    repoId: context.tenancyRepoId,
    sessionId: context.sessionId,
    snapshotMode: context.memoryDelta.snapshot.mode,
    snapshotValue: context.memoryDelta.snapshot.value,
  });
}

async function upsertSessionForDelta(client: IngestMemoryDeltaClient, context: IngestMemoryDeltaContext) {
  await upsertSessionWithClient(client, {
    agent: context.producedByAgent,
    metadata: {
      source_contract: 'memory_delta@0.1',
      ...(context.workflowMetadata ? { workflow: context.workflowMetadata } : {}),
    },
    model: context.producedByModel,
    orgId: context.tenancyOrgId,
    repoId: context.tenancyRepoId,
    repoSlug: context.tenancyRepoSlug,
    sessionId: context.sessionId,
    tool: MEMORY_DELTA_TOOL,
    updatedAt: context.deltaCreatedAt,
    userId: context.tenancyUserId,
  });
}
