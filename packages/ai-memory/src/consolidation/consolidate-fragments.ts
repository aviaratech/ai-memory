import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { createDurableMemoryKey, stableJsonHash } from '../db/hashing.js';
import { normalizeMemoryInput } from '../db/normalization.js';
import { inferMemoryTypeFromCategory, normalizeMemoryType } from '../db/memory-types.js';
import { isRecord } from '../db/type-guards.js';
import { probeCapabilities } from '../db/capabilities.js';
import { getEmbedding } from '../db/embeddings.js';
import { artifactIdentity, databaseIdentity, readNativeRows } from '../db/project-scope-backfill.js';
import { runBoundedQuery } from '../db/query-runner.js';
import { computeWriteCalibration } from '../db/write-calibration.js';
import { storeMemoryWithAuditEvent } from '../db/memory-api.js';
import { insertMemoryEventWithClient } from '../db/failure-events.js';
import type { DbClient, DbPool } from '../db/pool.js';
import { resolveTimeoutPolicy } from '../timeout-policy.js';
import {
  classifyMemoryFragments,
  getFragmentClassifierIdentity,
  parseFragmentClassification,
  type FragmentClassification,
  type FragmentContext,
} from './llm-classify.js';

const MAX_BYTES = 32 * 1024 * 1024;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const idSchema = z
  .string()
  .regex(/^[1-9]\d*$/u)
  .max(16)
  .refine(id => Number.isSafeInteger(Number(id)));
const nativeRow = z.record(z.string(), z.unknown());
const selectorsSchema = z
  .object({
    project: z
      .string()
      .regex(/^[^/\s]+\/[^/\s]+$/u)
      .max(1024),
    orgId: z.string().trim().min(1).max(1024).nullable(),
    sensitivity: z.enum(['public', 'internal', 'confidential', 'restricted']),
    sessionId: z.string().trim().min(1).max(8192).optional(),
    limit: z.number().int().min(1).max(50),
  })
  .strict();
const identitySchema = z
  .object({ code: digestSchema, namespace: z.string().min(1).max(4096), schema: digestSchema })
  .strict();
const classifierSchema = z.object({ model: z.string().min(1).max(1024), prompt: digestSchema }).strict();
const capabilitiesSchema = z
  .object({ hasEmbeddingColumn: z.boolean(), hasTrigram: z.boolean(), hasVector: z.boolean() })
  .strict();
const snapshotSchema = z
  .object({
    capturedAt: z.iso.datetime(),
    capabilities: capabilitiesSchema,
    exclusions: z.record(z.string(), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)),
    fragments: z.array(nativeRow).max(51),
    keyedContext: z.array(nativeRow).max(51),
    sessions: z.array(nativeRow).max(50),
    collisions: z.array(nativeRow).max(26),
  })
  .strict();
const calibrationSchema = z
  .object({
    calibratedConfidence: z.number().min(0).max(1),
    declaredConfidence: z.number().min(0).max(1),
    meanDeclaredConfidence: z.number().min(0).max(1).nullable(),
    priorMemoryCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    reversalRate: z.number().min(0).max(1),
    scope: z.enum(['author x category', 'author x category x tag']),
    window: z.literal('30d'),
  })
  .strict();
const vectorSchema = z.array(z.number()).length(1536).nullable();
const factSchema = z
  .object({
    category: z.enum(['architecture', 'convention', 'methodology', 'preference', 'root-cause', 'decision']),
    content: z.string().min(24).max(65536),
    declaredConfidence: z.number().min(0.5).max(1),
    embedding: vectorSchema,
    evidenceRefs: z.array(z.union([z.string(), nativeRow])),
    memoryKey: z.string().min(1).max(1024),
    memoryType: z.enum(['episodic', 'semantic', 'procedural']),
    supersedes: z.array(idSchema).min(2).max(50),
  })
  .strict();
const planSchema = z
  .object({
    version: z.literal(1),
    status: z.enum(['empty', 'ready', 'refused']),
    complete: z.boolean(),
    selectors: selectorsSchema,
    identity: identitySchema,
    classifierIdentity: classifierSchema,
    snapshot: snapshotSchema,
    classification: nativeRow.nullable(),
    facts: z.array(factSchema).max(25),
    calibrationBaselines: z.array(calibrationSchema).max(25),
    refusals: z.array(z.string().min(1).max(100)).max(200),
    digest: digestSchema,
  })
  .strict();

export type FragmentConsolidationSelectors = z.infer<typeof selectorsSchema>;
export type FragmentSnapshot = z.infer<typeof snapshotSchema>;
export type FragmentFact = z.infer<typeof factSchema>;
export type FragmentConsolidationPlan = z.infer<typeof planSchema>;
type Identity = z.infer<typeof identitySchema>;
type ClassifierIdentity = z.infer<typeof classifierSchema>;
type Calibration = z.infer<typeof calibrationSchema>;
type NativeRow = Record<string, unknown>;

export function validateFragmentConsolidationSelectors(value: unknown): FragmentConsolidationSelectors {
  const parsed = selectorsSchema.safeParse(value);
  if (!parsed.success) throw new Error('invalid_selectors');
  return parsed.data;
}

function nativeId(row: NativeRow): string {
  const id = idSchema.safeParse(row.id);
  if (!id.success) throw new Error('unsafe_native_id');
  return id.data;
}

function fingerprint(row: NativeRow): string {
  const { search_vector: _derived, ...native } = row;
  return stableJsonHash(native);
}

function jsonSafe(value: unknown): void {
  if (
    typeof value === 'number' &&
    (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
  )
    throw new Error('native_numeric_precision');
  if (Array.isArray(value)) for (const child of value) jsonSafe(child);
  else if (isRecord(value)) for (const child of Object.values(value)) jsonSafe(child);
}

function assertScope(
  row: NativeRow,
  selectors: FragmentConsolidationSelectors,
  sessions: NativeRow[],
  source: boolean,
) {
  if (
    row.project !== selectors.project ||
    (row.org_id ?? null) !== selectors.orgId ||
    row.sensitivity !== selectors.sensitivity
  )
    throw new Error('scope_conflict');
  const claims = [row.repo_id, row.repo_slug];
  if (source && row.session_id != null) {
    if (typeof row.session_id !== 'string') throw new Error('invalid_session_evidence');
    const session = sessions.filter(value => value.session_id === row.session_id);
    if (session.length !== 1) throw new Error('missing_session_evidence');
    claims.push(session[0]!.repo_id, session[0]!.repo_slug);
  }
  const evidence = claims.filter(claim => claim != null && claim !== '');
  const basename = selectors.project.split('/')[1];
  const qualified = evidence.some(claim => claim === selectors.project || claim === `github.com/${selectors.project}`);
  if (
    evidence.some(
      claim => claim !== selectors.project && claim !== `github.com/${selectors.project}` && claim !== basename,
    ) ||
    (evidence.includes(basename) && !qualified)
  )
    throw new Error('repository_conflict');
  if (source && selectors.sessionId !== undefined && row.session_id !== selectors.sessionId)
    throw new Error('session_scope_conflict');
}

function context(row: NativeRow): FragmentContext {
  const memoryType =
    normalizeMemoryType(row.memory_type, 'memory_type') ?? inferMemoryTypeFromCategory(String(row.category));
  if (
    memoryType === undefined ||
    typeof row.content !== 'string' ||
    typeof row.category !== 'string' ||
    typeof row.confidence !== 'number' ||
    !Number.isFinite(row.confidence) ||
    row.confidence < 0 ||
    row.confidence > 1
  )
    throw new Error('unsupported_fragment_evidence');
  return { id: nativeId(row), content: row.content, category: row.category, confidence: row.confidence, memoryType };
}

function assertSnapshot(snapshot: FragmentSnapshot, selectors: FragmentConsolidationSelectors) {
  jsonSafe(snapshot);
  if (snapshot.fragments.length > selectors.limit || snapshot.keyedContext.length > 50)
    throw new Error('incomplete_input_unit');
  const ids = snapshot.fragments.concat(snapshot.keyedContext).map(nativeId);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate_native_id');
  if (new Set(snapshot.sessions.map(row => row.session_id)).size !== snapshot.sessions.length)
    throw new Error('duplicate_session_evidence');
  for (const row of snapshot.fragments.concat(snapshot.keyedContext)) {
    const source = row.memory_key === null;
    assertScope(row, selectors, snapshot.sessions, source);
    context(row);
    if (
      row.status !== 'active' ||
      (row.expires_at != null &&
        (typeof row.expires_at !== 'string' ||
          !Number.isFinite(Date.parse(row.expires_at)) ||
          Date.parse(row.expires_at) <= Date.parse(snapshot.capturedAt)))
    )
      throw new Error('ineligible_fragment');
  }
  for (const row of snapshot.fragments) {
    if (
      row.memory_key !== null ||
      String(row.category).toLowerCase() === 'session-summary' ||
      context(row).memoryType === 'reflective'
    )
      throw new Error('ineligible_fragment');
  }
  for (const row of snapshot.keyedContext)
    if (typeof row.memory_key !== 'string' || row.memory_key.length === 0) throw new Error('invalid_keyed_context');
  if (snapshot.collisions.length) throw new Error('occupied_target_key');
}

function canonicalFact(
  snapshot: FragmentSnapshot,
  fact: NonNullable<FragmentClassification>['facts'][number],
): FragmentFact {
  const sources = fact.sourceIds.map(id => snapshot.fragments.find(row => row.id === id)!);
  const supersedes = [...fact.sourceIds].sort((a, b) => Number(a) - Number(b));
  const confidence = Math.min(
    ...sources.map(row => Number(row.confidence)),
    ...sources.map(row => (row.declared_confidence == null ? Number(row.confidence) : Number(row.declared_confidence))),
  );
  if (!Number.isFinite(confidence) || confidence < 0.5 || confidence > 1) throw new Error('insufficient_confidence');
  const evidence = sources.flatMap(row => {
    if (row.evidence_refs == null) return [];
    if (!Array.isArray(row.evidence_refs)) throw new Error('invalid_source_evidence');
    return row.evidence_refs as unknown[];
  });
  const evidenceRefs = [...new Map(evidence.map(value => [stableJsonHash(value), value])).values()];
  const normalized = normalizeMemoryInput({
    content: fact.content,
    category: fact.category,
    confidence,
    evidenceRefs,
    memoryKey: 'pending-canonical-key',
    source: 'consolidation',
    tags: [],
  });
  return {
    category: fact.category,
    content: normalized.content,
    declaredConfidence: confidence,
    embedding: null,
    evidenceRefs: normalized.evidenceRefs ?? [],
    memoryKey: '',
    memoryType: normalized.memoryType as FragmentFact['memoryType'],
    supersedes,
  };
}

export function buildFragmentConsolidationPlan(input: {
  snapshot: FragmentSnapshot;
  classification: FragmentClassification | null;
  classifierIdentity: ClassifierIdentity;
  identity: Identity;
  selectors: FragmentConsolidationSelectors;
  calibrationBaselines?: Calibration[];
  embeddings?: (number[] | null)[];
}): FragmentConsolidationPlan {
  const selectors = validateFragmentConsolidationSelectors(input.selectors);
  const snapshot = snapshotSchema.parse(input.snapshot);
  const refusals: string[] = [];
  const facts: FragmentFact[] = [];
  const calibrationBaselines = z
    .array(calibrationSchema)
    .max(25)
    .parse(input.calibrationBaselines ?? []);
  try {
    assertSnapshot(snapshot, selectors);
    if (snapshot.fragments.length) {
      if (input.classification === null || input.classification.model !== input.classifierIdentity.model)
        throw new Error('classification_unavailable');
      const { model, ...response } = input.classification;
      const classification = parseFragmentClassification(
        response,
        { fragments: snapshot.fragments.map(context), keyedContext: snapshot.keyedContext.map(context) },
        model,
      );
      if (classification === null) throw new Error('invalid_classification');
      if (classification.contradictions.length) throw new Error('contradictory_evidence');
      for (const [index, proposal] of classification.facts.entries()) {
        const fact = canonicalFact(snapshot, proposal);
        fact.memoryKey = createDurableMemoryKey({
          category: fact.category,
          content: fact.content,
          orgId: selectors.orgId ?? undefined,
          project: selectors.project,
          repoId: selectors.project,
          repoSlug: selectors.project,
          sensitivity: selectors.sensitivity,
          tags: [],
        });
        fact.embedding = vectorSchema.parse(input.embeddings?.[index] ?? null);
        facts.push(fact);
      }
      if (new Set(facts.map(fact => fact.memoryKey)).size !== facts.length) throw new Error('duplicate_target_key');
      if (facts.length !== calibrationBaselines.length) throw new Error('missing_calibration_baseline');
      for (const [index, fact] of facts.entries()) {
        const baseline = calibrationBaselines[index]!;
        if (
          baseline.declaredConfidence !== fact.declaredConfidence ||
          baseline.calibratedConfidence < 0.5 ||
          baseline.calibratedConfidence > fact.declaredConfidence
        )
          throw new Error('invalid_calibration_baseline');
        if (fact.embedding !== null && (!snapshot.capabilities.hasEmbeddingColumn || !snapshot.capabilities.hasVector))
          throw new Error('incompatible_embedding_capabilities');
      }
    }
  } catch (error) {
    refusals.push(error instanceof Error && /^[a-z_]+$/u.test(error.message) ? error.message : 'invalid_fragment_plan');
  }
  const body = {
    version: 1 as const,
    selectors,
    identity: identitySchema.parse(input.identity),
    classifierIdentity: classifierSchema.parse(input.classifierIdentity),
    snapshot,
    classification: input.classification,
    facts,
    calibrationBaselines,
    refusals,
    complete: refusals.length === 0,
    status: refusals.length ? ('refused' as const) : facts.length ? ('ready' as const) : ('empty' as const),
  };
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_BYTES) throw new Error('oversized_plan');
  return { ...body, digest: stableJsonHash(body) };
}

export function validateFragmentConsolidationPlan(value: unknown): FragmentConsolidationPlan {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) throw new Error('oversized_plan');
  const parsed = planSchema.safeParse(value);
  if (!parsed.success) throw new Error('invalid_plan');
  const plan = parsed.data;
  jsonSafe(plan);
  const { digest, ...body } = plan;
  if (stableJsonHash(body) !== digest) throw new Error('invalid_plan_digest');
  const classification = plan.classification as FragmentClassification | null;
  const canonical = buildFragmentConsolidationPlan({
    ...plan,
    classification,
    embeddings: plan.facts.map(fact => fact.embedding),
  });
  if (canonical.digest !== digest) throw new Error('invalid_plan_intent');
  return plan;
}

async function operationArtifact() {
  const artifact = await artifactIdentity();
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const modules = [
    './consolidate-fragments',
    './llm-classify',
    '../tools/consolidate',
    '../tools/pluginCli',
    '../db/memory-api',
    '../db/memory-sql',
    '../db/quality-gates',
    '../db/memory-types',
    '../db/write-calibration',
    '../db/embeddings',
    '../db/capabilities',
    '../db/importance',
    '../db/records',
  ];
  const bytes = [];
  for (const name of modules)
    bytes.push([name, stableJsonHash(await readFile(new URL(`${name}.${extension}`, import.meta.url), 'utf8'))]);
  const embeddingModel = process.env.AI_MEMORY_EMBEDDING_MODEL?.trim();
  const configuration = {
    classifier: getFragmentClassifierIdentity(),
    embeddingProvider: process.env.AI_MEMORY_EMBEDDING_PROVIDER?.trim().toLowerCase() ?? 'none',
    embeddingModel:
      embeddingModel !== undefined && embeddingModel.length > 0 ? embeddingModel : 'text-embedding-3-small',
    timeouts: resolveTimeoutPolicy(),
  };
  return { ...artifact, code: stableJsonHash({ base: artifact.code, bytes, configuration }) };
}

async function currentIdentity(client: DbClient, artifact: Awaited<ReturnType<typeof operationArtifact>>) {
  const base = await databaseIdentity(client, artifact);
  const catalog = (
    await client.query<NativeRow>(`SELECT
    EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='ai_memory_entries' AND column_name='embedding') AS embedding,
    EXISTS(SELECT 1 FROM pg_extension WHERE extname='vector') AS vector,
    EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_trgm') AS trigram,
    (SELECT format_type(a.atttypid,a.atttypmod) FROM pg_attribute a WHERE a.attrelid='ai_memory_entries'::regclass AND a.attname='embedding' AND NOT a.attisdropped) AS embedding_type,
    (SELECT jsonb_object_agg(extname,extversion) FROM pg_extension WHERE extname IN ('vector','pg_trgm')) AS extensions`)
  ).rows[0];
  if (catalog === undefined) throw new Error('unavailable_capabilities');
  const capabilities = {
    hasEmbeddingColumn: catalog.embedding === true,
    hasTrigram: catalog.trigram === true,
    hasVector: catalog.vector === true,
  };
  if (capabilities.hasEmbeddingColumn && (!capabilities.hasVector || catalog.embedding_type !== 'vector(1536)'))
    throw new Error('incompatible_embedding_capabilities');
  if (stableJsonHash(await probeCapabilities(client)) !== stableJsonHash(capabilities))
    throw new Error('incompatible_cached_capabilities');
  return { identity: { ...base, schema: stableJsonHash({ base: base.schema, catalog }) }, capabilities };
}

async function readSnapshot(
  client: DbClient,
  selectors: FragmentConsolidationSelectors,
  capabilities: z.infer<typeof capabilitiesSchema>,
  keys: string[] = [],
): Promise<FragmentSnapshot> {
  let bytes = 0;
  const rows = async (table: string, key: string, where: string, params: unknown[], limit: number) => {
    const result = await readNativeRows(client, { table, key, where, params, limit, maxBytes: MAX_BYTES - bytes });
    bytes += result.bytes;
    return result.rows;
  };
  const scope = 'project=$1 AND org_id IS NOT DISTINCT FROM $2 AND sensitivity=$3';
  const params: unknown[] = [selectors.project, selectors.orgId, selectors.sensitivity];
  const session = selectors.sessionId === undefined ? '' : ' AND session_id=$4';
  const sourceParams = selectors.sessionId === undefined ? params : [...params, selectors.sessionId];
  const eligible =
    "status='active' AND (expires_at IS NULL OR expires_at>NOW()) AND lower(coalesce(category,''))<>'session-summary' AND lower(coalesce(memory_type,''))<>'reflective'";
  const fragments = await rows(
    'ai_memory_entries',
    'id',
    `${scope} AND memory_key IS NULL AND ${eligible}${session}`,
    sourceParams,
    selectors.limit + 1,
  );
  const keyedContext = await rows(
    'ai_memory_entries',
    'id',
    `${scope} AND memory_key IS NOT NULL AND status='active' AND (expires_at IS NULL OR expires_at>NOW())`,
    params,
    51,
  );
  const sessionIds = [
    ...new Set(fragments.map(row => row.session_id).filter((id): id is string => typeof id === 'string')),
  ];
  const sessions = sessionIds.length
    ? await rows('ai_sessions', 'session_id', 'session_id=ANY($1::text[])', [sessionIds], 50)
    : [];
  const collisions = keys.length ? await rows('ai_memory_entries', 'id', 'memory_key=ANY($1::text[])', [keys], 26) : [];
  const excluded = await client.query<{ reason: string; count: string }>(
    `SELECT CASE
    WHEN status<>'active' THEN 'inactive'
    WHEN expires_at IS NOT NULL AND expires_at<=NOW() THEN 'expired'
    WHEN lower(category)='session-summary' THEN 'session_summary'
    WHEN lower(coalesce(memory_type,''))='reflective' THEN 'reflective'
    END AS reason,count(*)::text AS count
    FROM ai_memory_entries WHERE ${scope} AND memory_key IS NULL AND NOT (${eligible})${session}
    GROUP BY 1 ORDER BY 1`,
    sourceParams,
  );
  const exclusions = Object.fromEntries(excluded.rows.map(row => [row.reason, Number(row.count)]));
  const now = (await client.query<{ now: Date }>('SELECT NOW() AS now')).rows[0]?.now;
  if (!(now instanceof Date)) throw new Error('unavailable_snapshot_clock');
  return snapshotSchema.parse({
    fragments,
    keyedContext,
    sessions,
    collisions,
    exclusions,
    capabilities,
    capturedAt: now.toISOString(),
  });
}

function cohortIdentity(snapshot: FragmentSnapshot) {
  const { capturedAt: _clock, collisions: _collisions, ...cohort } = snapshot;
  return stableJsonHash(cohort);
}

function factInput(
  plan: Pick<FragmentConsolidationPlan, 'selectors' | 'snapshot'>,
  fact: FragmentFact,
  digest?: string,
) {
  const input = {
    content: fact.content,
    category: fact.category,
    confidence: fact.declaredConfidence,
    embedding: fact.embedding,
    evidenceRefs: fact.evidenceRefs,
    memoryKey: fact.memoryKey,
    memoryType: fact.memoryType,
    project: plan.selectors.project,
    orgId: plan.selectors.orgId ?? undefined,
    repoId: plan.selectors.project,
    repoSlug: plan.selectors.project,
    sensitivity: plan.selectors.sensitivity,
    source: 'consolidation',
    tags: [],
    supersedesId: Number(fact.supersedes[0]),
    metadata:
      digest === undefined
        ? {}
        : {
            consolidation: {
              version: 1,
              planDigest: digest,
              supersedes: fact.supersedes,
              sources: fact.supersedes.map(id => {
                const source = plan.snapshot.fragments.find(row => row.id === id)!;
                const { search_vector: _derived, ...provenance } = source;
                return { id, fingerprint: fingerprint(source), provenance };
              }),
            },
          },
  };
  return input;
}

export async function createFragmentConsolidationPlan(input: {
  pool: DbPool;
  selectors: FragmentConsolidationSelectors;
}): Promise<FragmentConsolidationPlan> {
  const selectors = validateFragmentConsolidationSelectors(input.selectors);
  const artifact = await operationArtifact();
  const classifierIdentity = getFragmentClassifierIdentity();
  const read = <T>(task: (client: DbClient) => Promise<T>) =>
    runBoundedQuery({
      pool: input.pool,
      phase: 'db.read.fragment_consolidation',
      timeoutMs: resolveTimeoutPolicy().db.readTimeoutMs,
      task: async client => {
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        return task(client);
      },
    });
  const initial = await read(async client => {
    const { identity, capabilities } = await currentIdentity(client, artifact);
    return { identity, snapshot: await readSnapshot(client, selectors, capabilities) };
  });
  const base = { ...initial, selectors, classifierIdentity };
  try {
    assertSnapshot(initial.snapshot, selectors);
  } catch {
    return buildFragmentConsolidationPlan({ ...base, classification: null });
  }
  if (!initial.snapshot.fragments.length) return buildFragmentConsolidationPlan({ ...base, classification: null });
  // The read transaction and client have been released before provider work.
  const classification = await classifyMemoryFragments({
    fragments: initial.snapshot.fragments.map(context),
    keyedContext: initial.snapshot.keyedContext.map(context),
  });
  const draft = buildFragmentConsolidationPlan({ ...base, classification });
  if (draft.refusals.some(code => code !== 'missing_calibration_baseline') || !draft.facts.length) return draft;
  const embeddings: (number[] | null)[] = [];
  for (const fact of draft.facts)
    embeddings.push(await getEmbedding(fact.content, { category: fact.category, operation: 'consolidate_plan' }));
  const refreshedArtifact = await operationArtifact();
  if (refreshedArtifact.code !== artifact.code) throw new Error('incompatible_plan_identity');
  return read(async client => {
    const current = await currentIdentity(client, refreshedArtifact);
    if (stableJsonHash(current.identity) !== stableJsonHash(initial.identity))
      throw new Error('incompatible_plan_identity');
    const snapshot = await readSnapshot(
      client,
      selectors,
      current.capabilities,
      draft.facts.map(fact => fact.memoryKey),
    );
    if (cohortIdentity(snapshot) !== cohortIdentity(initial.snapshot)) throw new Error('stale_fragment_snapshot');
    const calibrationBaselines = [];
    for (const fact of draft.facts)
      calibrationBaselines.push(await computeWriteCalibration(client, normalizeMemoryInput(factInput(draft, fact))));
    return buildFragmentConsolidationPlan({
      ...base,
      snapshot: { ...snapshot, capturedAt: initial.snapshot.capturedAt },
      classification,
      embeddings,
      calibrationBaselines,
    });
  });
}

const UNIT_EVENT = 'consolidation_unit:v1';
const FACT_EVENT = 'consolidation_fact_created:v1';
const SOURCE_EVENT = 'consolidation_fragment_superseded:v1';
const ACTOR = 'fragment-consolidation';
const stateSchema = z.object({ id: idSchema, fingerprint: digestSchema }).strict();
const completionSchema = z
  .object({
    version: z.literal(1),
    planDigest: digestSchema,
    identity: identitySchema,
    selectors: selectorsSchema,
    appliedAt: z.iso.datetime({ offset: true }),
    createdFacts: z
      .array(
        z
          .object({
            id: idSchema,
            memoryKey: z.string().min(1).max(1024),
            confidence: z.number().min(0.5).max(1),
            declaredConfidence: z.number().min(0.5).max(1),
          })
          .strict(),
      )
      .min(1)
      .max(25),
    consumedSourceIds: z.array(idSchema).min(2).max(50),
    postState: z.array(stateSchema).min(3).max(75),
    auditState: z.array(stateSchema).min(4).max(100),
    completionDigest: digestSchema,
  })
  .strict();
type Completion = z.infer<typeof completionSchema>;
export type FragmentConsolidationReceipt = Completion & { status: 'applied' | 'skipped' };

async function readMemories(client: DbClient, ids: string[]) {
  return (
    await readNativeRows(client, {
      table: 'ai_memory_entries',
      key: 'id',
      where: 'id=ANY($1::bigint[])',
      params: [ids],
      limit: ids.length + 1,
      maxBytes: MAX_BYTES,
    })
  ).rows;
}

async function readEvents(client: DbClient, where: string, params: unknown[], limit: number): Promise<NativeRow[]> {
  const result = await readNativeRows(client, {
    table: 'ai_memory_events',
    key: 'id',
    where,
    params,
    limit,
    maxBytes: MAX_BYTES,
  });
  return result.rows.map(row => {
    jsonSafe(row);
    if (typeof row.id !== 'number' || !Number.isSafeInteger(row.id) || row.id <= 0) throw new Error('unsafe_event_id');
    return { ...row, id: String(row.id) };
  });
}

function state(rows: NativeRow[]) {
  return rows.map(row => ({ id: nativeId(row), fingerprint: fingerprint(row) }));
}

async function verifyPostState(client: DbClient, completion: Completion) {
  const memories = await readMemories(
    client,
    completion.postState.map(row => row.id),
  );
  const audits = await readEvents(
    client,
    'id=ANY($1::bigint[])',
    [completion.auditState.map(row => row.id)],
    completion.auditState.length + 1,
  );
  if (
    stableJsonHash(state(memories)) !== stableJsonHash(completion.postState) ||
    stableJsonHash(state(audits)) !== stableJsonHash(completion.auditState)
  )
    throw new Error('incompatible_post_state');
}

function validateCompletion(value: unknown, plan: FragmentConsolidationPlan): Completion {
  const parsed = completionSchema.safeParse(value);
  if (!parsed.success) throw new Error('invalid_completion');
  const completion = parsed.data;
  const { completionDigest, ...body } = completion;
  if (
    stableJsonHash(body) !== completionDigest ||
    completion.planDigest !== plan.digest ||
    stableJsonHash(completion.identity) !== stableJsonHash(plan.identity) ||
    stableJsonHash(completion.selectors) !== stableJsonHash(plan.selectors)
  )
    throw new Error('conflicting_completion');
  const consumed = plan.facts.flatMap(fact => fact.supersedes).sort((a, b) => Number(a) - Number(b));
  if (
    stableJsonHash(consumed) !== stableJsonHash(completion.consumedSourceIds) ||
    completion.createdFacts.length !== plan.facts.length ||
    completion.createdFacts.some(
      (fact, index) =>
        fact.memoryKey !== plan.facts[index]!.memoryKey ||
        fact.declaredConfidence !== plan.facts[index]!.declaredConfidence ||
        fact.confidence > fact.declaredConfidence,
    )
  )
    throw new Error('conflicting_completion');
  const expected = completion.createdFacts
    .map(fact => fact.id)
    .concat(consumed)
    .sort((a, b) => Number(a) - Number(b));
  if (
    new Set(expected).size !== expected.length ||
    stableJsonHash(expected) !== stableJsonHash(completion.postState.map(row => row.id)) ||
    completion.auditState.length !== plan.facts.length * 2 + consumed.length ||
    new Set(completion.auditState.map(row => row.id)).size !== completion.auditState.length
  )
    throw new Error('conflicting_completion');
  return completion;
}

async function readCompletion(client: DbClient, plan: FragmentConsolidationPlan): Promise<Completion | null> {
  const rows = await readEvents(
    client,
    'event_type=$1 AND memory_id IN (SELECT id FROM ai_memory_entries WHERE memory_key=$2)',
    [UNIT_EVENT, plan.facts[0]!.memoryKey],
    2,
  );
  if (rows.length === 0) return null;
  if (rows.length !== 1 || rows[0]!.actor !== ACTOR) throw new Error('conflicting_completion');
  const completion = validateCompletion(rows[0]!.payload_json, plan);
  if (rows[0]!.created_at !== completion.appliedAt || String(rows[0]!.memory_id) !== completion.createdFacts[0]!.id)
    throw new Error('conflicting_completion');
  await verifyPostState(client, completion);
  return completion;
}

export async function applyFragmentConsolidation(input: {
  pool: DbPool;
  plan: unknown;
  expectedDigest: string;
}): Promise<FragmentConsolidationReceipt> {
  const plan = validateFragmentConsolidationPlan(input.plan);
  if (plan.digest !== input.expectedDigest || plan.status !== 'ready' || !plan.complete || plan.facts.length === 0)
    throw new Error('unapproved_plan');
  if (stableJsonHash(getFragmentClassifierIdentity()) !== stableJsonHash(plan.classifierIdentity))
    throw new Error('incompatible_classifier_identity');
  const artifact = await operationArtifact();
  return runBoundedQuery({
    pool: input.pool,
    phase: 'db.write.fragment_consolidation',
    timeoutMs: resolveTimeoutPolicy().db.writeTimeoutMs,
    task: async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await client.query(
        'LOCK TABLE ai_continuity_packs,ai_memory_entries,ai_memory_events,ai_session_events,ai_sessions,public.ai_memory_pgmigrations IN SHARE ROW EXCLUSIVE MODE NOWAIT',
      );
      const current = await currentIdentity(client, artifact);
      if (stableJsonHash(current.identity) !== stableJsonHash(plan.identity))
        throw new Error('incompatible_plan_identity');
      // A completed unit is checked before present-day source eligibility/calibration.
      const completed = await readCompletion(client, plan);
      if (completed !== null) return { ...completed, status: 'skipped' };
      const snapshot = await readSnapshot(
        client,
        plan.selectors,
        current.capabilities,
        plan.facts.map(fact => fact.memoryKey),
      );
      if (cohortIdentity(snapshot) !== cohortIdentity(plan.snapshot)) throw new Error('stale_fragment_snapshot');
      assertSnapshot(snapshot, plan.selectors);
      const calibrationBaselines = [];
      for (const fact of plan.facts)
        calibrationBaselines.push(await computeWriteCalibration(client, normalizeMemoryInput(factInput(plan, fact))));
      if (stableJsonHash(calibrationBaselines) !== stableJsonHash(plan.calibrationBaselines))
        throw new Error('stale_calibration_baseline');
      // Rebuild once more under the fence, including canonical within-unit key uniqueness.
      const admitted = buildFragmentConsolidationPlan({
        ...plan,
        snapshot: { ...snapshot, capturedAt: plan.snapshot.capturedAt },
        classification: plan.classification as FragmentClassification,
        calibrationBaselines,
        embeddings: plan.facts.map(fact => fact.embedding),
      });
      if (admitted.digest !== plan.digest) throw new Error('stale_fragment_plan');
      const clock = (await client.query<{ now: unknown }>('SELECT to_jsonb(NOW()) AS now')).rows[0]?.now;
      if (typeof clock !== 'string') throw new Error('unavailable_transaction_clock');
      const createdFacts: Completion['createdFacts'] = [];
      const sourceTargets = new Map<string, string>();
      for (const fact of plan.facts) {
        // Global target absence + unique intent keys + the table fence keep the
        // ordinary canonical upsert from overwriting any prior or new keyed row.
        const stored = await storeMemoryWithAuditEvent(client, factInput(plan, fact, plan.digest));
        const id = idSchema.parse(String(stored.id));
        const confidence = stored.confidence;
        if (
          typeof confidence !== 'number' ||
          !Number.isFinite(confidence) ||
          confidence < 0.5 ||
          confidence > fact.declaredConfidence ||
          stored.memoryKey !== fact.memoryKey
        )
          throw new Error('invalid_canonical_fact_result');
        createdFacts.push({ id, memoryKey: fact.memoryKey, confidence, declaredConfidence: fact.declaredConfidence });
        for (const sourceId of fact.supersedes) {
          const changed = await client.query(
            "UPDATE ai_memory_entries SET status='superseded',updated_at=NOW() WHERE id=$1 AND memory_key IS NULL AND status='active' AND (expires_at IS NULL OR expires_at>NOW())",
            [sourceId],
          );
          if (changed.rowCount !== 1) throw new Error('changed_source_row_count');
          sourceTargets.set(sourceId, id);
        }
      }
      const consumedSourceIds = [...sourceTargets.keys()].sort((a, b) => Number(a) - Number(b));
      const postRows = await readMemories(client, consumedSourceIds.concat(createdFacts.map(fact => fact.id)));
      if (postRows.length !== consumedSourceIds.length + createdFacts.length) throw new Error('incomplete_post_state');
      for (const sourceId of consumedSourceIds) {
        const before = plan.snapshot.fragments.find(row => row.id === sourceId)!;
        const after = postRows.find(row => row.id === sourceId)!;
        if (fingerprint({ ...before, status: 'superseded', updated_at: clock }) !== fingerprint(after))
          throw new Error('unexpected_source_mutation');
        await insertMemoryEventWithClient(client, {
          actor: ACTOR,
          eventType: SOURCE_EVENT,
          memoryId: Number(sourceId),
          payloadJson: {
            version: 1,
            planDigest: plan.digest,
            sourceId,
            factId: sourceTargets.get(sourceId),
            before: fingerprint(before),
            after: fingerprint(after),
          },
        });
      }
      for (const [index, created] of createdFacts.entries()) {
        const fact = plan.facts[index]!;
        const actual = postRows.find(row => row.id === created.id)!;
        if (
          actual.memory_key !== created.memoryKey ||
          actual.status !== 'active' ||
          actual.expires_at !== null ||
          actual.session_id !== null
        )
          throw new Error('invalid_canonical_fact_result');
        await insertMemoryEventWithClient(client, {
          actor: ACTOR,
          eventType: FACT_EVENT,
          memoryId: Number(created.id),
          payloadJson: {
            version: 1,
            planDigest: plan.digest,
            factId: created.id,
            supersedes: fact.supersedes,
            after: fingerprint(actual),
            sources: fact.supersedes.map(id => ({
              id,
              fingerprint: fingerprint(plan.snapshot.fragments.find(row => row.id === id)!),
            })),
          },
        });
      }
      const audits = await readEvents(
        client,
        "memory_id=ANY($1::bigint[]) OR (event_type=$2 AND payload_json->>'planDigest'=$3)",
        [createdFacts.map(fact => fact.id), SOURCE_EVENT, plan.digest],
        101,
      );
      const body = {
        version: 1 as const,
        planDigest: plan.digest,
        identity: plan.identity,
        selectors: plan.selectors,
        appliedAt: clock,
        createdFacts,
        consumedSourceIds,
        postState: state(postRows),
        auditState: state(audits),
      };
      const completion = validateCompletion({ ...body, completionDigest: stableJsonHash(body) }, plan);
      await insertMemoryEventWithClient(client, {
        actor: ACTOR,
        eventType: UNIT_EVENT,
        memoryId: Number(createdFacts[0]!.id),
        payloadJson: completion,
      });
      const readback = await readCompletion(client, plan);
      if (stableJsonHash(readback) !== stableJsonHash(completion)) throw new Error('completion_readback_failed');
      return { ...completion, status: 'applied' };
    },
  });
}
