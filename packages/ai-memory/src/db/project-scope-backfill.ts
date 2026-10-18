import {
  createDurableMemoryKey,
  createFlushSessionDecisionDedupeHash,
  createMemoryDedupeHash,
  stableJsonHash,
} from './hashing.js';
import { FLUSH_SESSION_DECISION_DEDUPE_PREFIX } from './runtime.js';
import { isRecord } from './type-guards.js';
import { readFile, readdir } from 'node:fs/promises';
import { z } from 'zod';
import type { DbClient, DbPool } from './pool.js';
import { insertMemoryEventWithClient, insertSessionEventWithClient } from './failure-events.js';
import { runBoundedQuery } from './query-runner.js';
import { resolveTimeoutPolicy } from '../timeout-policy.js';

export interface BackfillSelectors {
  legacyProject: string;
  limit: number;
  project: string;
  sessionId?: string;
}
export interface BackfillIdentity {
  code: string;
  namespace: string;
  schema: string;
}
export interface BackfillData {
  collisionOnly?: { memoryIds: string[]; packKeys: string[] };
  memories: Record<string, unknown>[];
  packs: Record<string, unknown>[];
  sessions: Record<string, unknown>[];
}
export interface BackfillChange {
  after: string;
  before: string;
  evidence?: 'exact-session' | 'native-row';
  from: Record<string, string | null>;
  id: string;
  prospectiveKey?: string;
  table: 'continuity' | 'memory' | 'session';
  to: Record<string, string | null>;
}
export interface BackfillPlan {
  anchor?: { id: string; kind: 'memory' | 'session' };
  changes: BackfillChange[];
  complete: boolean;
  counts: { foreign: number; unknown: number };
  digest: string;
  identity: BackfillIdentity;
  observations: { fingerprint: string; id: string; table: BackfillChange['table'] }[];
  refusals: { code: string; id: string }[];
  selectors: BackfillSelectors;
  status: 'empty' | 'ready' | 'refused';
  version: 1;
}

export function buildProjectScopeBackfillPlan(input: {
  data: BackfillData;
  identity: BackfillIdentity;
  selectors: BackfillSelectors;
}): BackfillPlan {
  validateBackfillSelectors(input.selectors);
  const { data, selectors } = input;
  const changes: BackfillChange[] = [];
  const refusals: BackfillPlan['refusals'] = [];
  const counts = { foreign: 0, unknown: 0 };
  const collisionMemories = new Set(data.collisionOnly?.memoryIds ?? []);
  const collisionPacks = new Set(data.collisionOnly?.packKeys ?? []);
  const selectedSession = (row: Record<string, unknown>) =>
    selectors.sessionId === undefined || row.session_id === selectors.sessionId;
  const candidateMemories = data.memories.filter(row => selectedSession(row) && !collisionMemories.has(String(row.id)));
  const candidatePacks = data.packs.filter(row => selectedSession(row) && !collisionPacks.has(String(row.scope_key)));
  const candidateSessions = data.sessions.filter(selectedSession);
  const observations: BackfillPlan['observations'] = [];
  const refuse = (code: string, id: string) => refusals.push({ code, id });
  for (const [table, rows, key] of [
    ['memory', data.memories, 'id'],
    ['session', data.sessions, 'session_id'],
    ['continuity', data.packs, 'scope_key'],
  ] as const) {
    const ids = new Set<string>();
    for (const row of rows) {
      const id = String(row[key]);
      if (ids.has(id)) refuse('duplicate_identity', id);
      ids.add(id);
      observations.push({ fingerprint: rowFingerprint(table, row), id, table });
    }
  }
  if (observations.length > selectors.limit) refuse('incomplete_dependency_closure', 'unit');
  const verifiedSessions = new Set<string>();
  for (const session of candidateSessions) {
    const id = String(session.session_id);
    const members = candidateMemories.filter(row => row.session_id === id);
    const ownClaim = evidence(session, selectors);
    if (ownClaim === 'conflict') refuse('repository_conflict', id);
    const positive = ownClaim === 'verified' || members.some(row => evidence(row, selectors) === 'verified');
    if (!positive) continue;
    if (
      ownClaim === 'foreign' ||
      members.some(
        row =>
          ['conflict', 'foreign'].includes(evidence(row, selectors)) ||
          (row.project != null && row.project !== selectors.project && row.project !== selectors.legacyProject),
      ) ||
      candidatePacks.some(
        row => row.session_id === id && row.project !== selectors.project && row.project !== selectors.legacyProject,
      )
    ) {
      refuse('session_conflict', id);
      continue;
    }
    if (ownClaim === 'verified') verifiedSessions.add(id);
  }
  const add = (
    table: BackfillChange['table'],
    id: string,
    row: Record<string, unknown>,
    from: BackfillChange['from'],
    to: BackfillChange['to'],
    prospectiveKey?: string,
  ) => {
    changes.push({
      after: rowFingerprint(table, { ...row, ...to }),
      before: rowFingerprint(table, row),
      from,
      id,
      ...(prospectiveKey === undefined ? {} : { prospectiveKey }),
      table,
      to,
    });
  };
  for (const row of candidateMemories) {
    if (evidence(row, selectors) === 'conflict') {
      refuse('repository_conflict', String(row.id));
      continue;
    }
    if (row.project !== selectors.legacyProject) continue;
    const id = String(row.id);
    if (!Number.isSafeInteger(Number(id)) || Number(id) < 1) {
      refuse('unsupported_memory_id', id);
      continue;
    }
    const claim = evidence(row, selectors);
    const sessionVerified = verifiedSessions.has(String(row.session_id));
    if (claim === 'foreign') {
      counts.foreign++;
      continue;
    }
    if (claim !== 'verified' && !sessionVerified) {
      counts.unknown++;
      continue;
    }
    if (
      typeof row.content !== 'string' ||
      typeof row.category !== 'string' ||
      (row.tags != null && (!Array.isArray(row.tags) || !row.tags.every(tag => typeof tag === 'string')))
    ) {
      refuse('unsupported_memory_identity', id);
      continue;
    }
    const oldHash = text(row.dedupe_hash);
    let newHash = oldHash;
    if (row.memory_key == null && oldHash !== null) {
      const before = createMemoryDedupeHash(memoryIdentity(row));
      const after = createMemoryDedupeHash(memoryIdentity({ ...row, project: selectors.project }));
      if (oldHash.startsWith(FLUSH_SESSION_DECISION_DEDUPE_PREFIX)) {
        if (
          row.category !== 'decision' ||
          row.memory_type !== 'episodic' ||
          typeof row.session_id !== 'string' ||
          row.session_id.length === 0 ||
          row.expires_at == null ||
          oldHash !== createFlushSessionDecisionDedupeHash(before, row.session_id)
        ) {
          refuse('unreproducible_private_hash', id);
          continue;
        }
        newHash = createFlushSessionDecisionDedupeHash(after, row.session_id);
      } else if (oldHash !== before) {
        refuse('unreproducible_hash', id);
        continue;
      } else newHash = after;
    }
    const prospectiveKey =
      row.memory_key == null
        ? undefined
        : createDurableMemoryKey({
            ...memoryIdentity({ ...row, project: selectors.project }),
            category: row.category,
            content: row.content,
          });
    add(
      'memory',
      id,
      row,
      { dedupe_hash: oldHash, project: selectors.legacyProject },
      { dedupe_hash: newHash, project: selectors.project },
      prospectiveKey,
    );
    changes[changes.length - 1]!.evidence = claim === 'verified' ? 'native-row' : 'exact-session';
  }
  for (const row of candidateSessions) {
    if (
      verifiedSessions.has(String(row.session_id)) &&
      (row.repo_id == null || row.repo_id === selectors.legacyProject)
    )
      add('session', String(row.session_id), row, { repo_id: text(row.repo_id) }, { repo_id: selectors.project });
  }
  for (const row of candidatePacks) {
    if (row.project !== selectors.legacyProject) continue;
    const id = String(row.scope_key);
    if (!verifiedSessions.has(String(row.session_id))) {
      counts.unknown++;
      continue;
    }
    let target: string | undefined;
    let scope: { id?: string; type: string } | undefined;
    if (id === `project:${selectors.legacyProject}`) {
      target = `project:${selectors.project}`;
      scope = { type: 'project' };
    } else
      for (const type of ['task', 'lead', 'outcome']) {
        const prefix = `${type}:${selectors.legacyProject}:`;
        if (id.startsWith(prefix) && id.length > prefix.length) {
          const suffix = id.slice(prefix.length);
          target = `${type}:${selectors.project}:${suffix}`;
          scope = { id: suffix, type };
          break;
        }
      }
    const payload = row.pack_json;
    const provenance = isRecord(payload) && isRecord(payload.provenance) ? payload.provenance : {};
    if (
      target === undefined ||
      !isRecord(payload) ||
      (provenance.sessionId !== undefined && provenance.sessionId !== row.session_id) ||
      (provenance.source !== undefined && provenance.source !== row.source) ||
      (provenance.scope !== undefined && stableJsonHash(provenance.scope) !== stableJsonHash(scope))
    ) {
      refuse('continuity_provenance_conflict', id);
      continue;
    }
    if (data.packs.some(other => other.scope_key === target)) {
      refuse('continuity_collision', id);
      continue;
    }
    add(
      'continuity',
      id,
      row,
      { project: selectors.legacyProject, scope_key: id },
      { project: selectors.project, scope_key: target },
    );
  }
  for (const change of changes.filter(item => item.table === 'memory')) {
    if (
      change.prospectiveKey !== undefined &&
      data.memories.some(row => String(row.id) !== change.id && row.memory_key === change.prospectiveKey)
    )
      refuse('key_collision', change.id);
    const hash = change.to.dedupe_hash;
    const original = data.memories.find(row => String(row.id) === change.id);
    if (
      original?.memory_key == null &&
      hash !== null &&
      (data.memories.some(row => String(row.id) !== change.id && row.memory_key == null && row.dedupe_hash === hash) ||
        changes.some(
          other =>
            other !== change &&
            other.table === 'memory' &&
            data.memories.find(row => String(row.id) === other.id)?.memory_key == null &&
            other.to.dedupe_hash === hash,
        ))
    )
      refuse('dedupe_collision', change.id);
  }
  for (const change of changes) if (change.table !== 'memory') change.evidence = 'exact-session';
  const sessionAnchors = [...verifiedSessions]
    .filter(id =>
      changes.some(
        change =>
          (change.table === 'session' && change.id === id) ||
          (change.table === 'memory' &&
            data.memories.some(row => String(row.id) === change.id && row.session_id === id)) ||
          (change.table === 'continuity' &&
            data.packs.some(row => row.scope_key === change.id && row.session_id === id)),
      ),
    )
    .sort();
  const memoryAnchor = changes.find(change => change.table === 'memory');
  const anchor: BackfillPlan['anchor'] =
    sessionAnchors[0] !== undefined
      ? { id: sessionAnchors[0], kind: 'session' }
      : memoryAnchor === undefined
        ? undefined
        : { id: memoryAnchor.id, kind: 'memory' };
  if (changes.length > 0 && anchor === undefined) refuse('unattested_anchor', 'unit');
  const body = {
    ...(anchor === undefined ? {} : { anchor }),
    changes,
    complete: observations.length <= selectors.limit,
    counts,
    identity: input.identity,
    observations,
    refusals,
    selectors,
    status: refusals.length > 0 ? ('refused' as const) : changes.length > 0 ? ('ready' as const) : ('empty' as const),
    version: 1 as const,
  };
  return { ...body, digest: stableJsonHash(body) };
}

export function validateBackfillSelectors(value: BackfillSelectors) {
  if (
    value.project.length > 1024 ||
    value.legacyProject.length > 1024 ||
    !/^[^/\s]+\/[^/\s]+$/u.test(value.project) ||
    value.legacyProject !== value.project.split('/')[1] ||
    !Number.isSafeInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > 5_000 ||
    (value.sessionId !== undefined && (!value.sessionId.trim() || value.sessionId !== value.sessionId.trim()))
  )
    throw new Error('Invalid bounded repository-scope selectors.');
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
function evidence(
  row: Record<string, unknown>,
  selectors: BackfillSelectors,
): 'conflict' | 'foreign' | 'unknown' | 'verified' {
  const claims = [row.repo_id, row.repo_slug].filter(value => value != null && value !== '');
  const positive = claims.some(value => value === selectors.project || value === `github.com/${selectors.project}`);
  const foreign = claims.some(
    value =>
      value !== selectors.legacyProject && value !== selectors.project && value !== `github.com/${selectors.project}`,
  );
  return foreign ? (positive ? 'conflict' : 'foreign') : positive ? 'verified' : 'unknown';
}
function memoryIdentity(row: Record<string, unknown>) {
  return {
    category: text(row.category) ?? undefined,
    content: text(row.content) ?? undefined,
    orgId: text(row.org_id) ?? undefined,
    project: text(row.project) ?? undefined,
    repoId: text(row.repo_id) ?? undefined,
    repoSlug: text(row.repo_slug) ?? undefined,
    sensitivity: text(row.sensitivity) ?? undefined,
    tags: row.tags as string[] | undefined,
  };
}

function rowFingerprint(table: BackfillChange['table'], row: Record<string, unknown>) {
  // PostgreSQL regenerates this projection. Its expression is schema-bound;
  // every source field, timestamp and native provenance remains fingerprinted.
  if (table === 'memory') {
    const { search_vector: _derived, ...native } = row;
    return stableJsonHash(native);
  }
  return stableJsonHash(row);
}

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const nativeIdSchema = z.string().min(1).max(8192);
const tableSchema = z.enum(['continuity', 'memory', 'session']);
const projectionSchema = z.record(z.string(), z.string().nullable());
const planSchema = z
  .object({
    anchor: z
      .object({ id: nativeIdSchema, kind: z.enum(['memory', 'session']) })
      .strict()
      .optional(),
    changes: z
      .array(
        z
          .object({
            after: digestSchema,
            before: digestSchema,
            evidence: z.enum(['exact-session', 'native-row']).optional(),
            from: projectionSchema,
            id: nativeIdSchema,
            prospectiveKey: nativeIdSchema.optional(),
            table: tableSchema,
            to: projectionSchema,
          })
          .strict(),
      )
      .max(5000),
    complete: z.boolean(),
    counts: z.object({ foreign: z.number().int().nonnegative(), unknown: z.number().int().nonnegative() }).strict(),
    digest: digestSchema,
    identity: z.object({ code: digestSchema, namespace: z.string().max(4096), schema: digestSchema }).strict(),
    observations: z
      .array(z.object({ fingerprint: digestSchema, id: nativeIdSchema, table: tableSchema }).strict())
      .max(5001),
    refusals: z.array(z.object({ code: z.string().max(100), id: nativeIdSchema }).strict()).max(10002),
    selectors: z
      .object({
        legacyProject: z.string().max(1024),
        limit: z.number().int(),
        project: z.string().max(1024),
        sessionId: nativeIdSchema.optional(),
      })
      .strict(),
    status: z.enum(['empty', 'ready', 'refused']),
    version: z.literal(1),
  })
  .strict();

export function validateProjectScopeBackfillPlan(value: unknown): BackfillPlan {
  const parsed = planSchema.safeParse(value);
  if (!parsed.success) throw new Error('invalid_plan');
  const plan = parsed.data as BackfillPlan;
  validateBackfillSelectors(plan.selectors);
  const { digest, ...body } = plan;
  if (stableJsonHash(body) !== digest) throw new Error('invalid_plan_digest');
  return plan;
}

const TABLES = ['ai_continuity_packs', 'ai_memory_entries', 'ai_memory_events', 'ai_session_events', 'ai_sessions'];
const ROW_TABLES = {
  continuity: ['ai_continuity_packs', 'scope_key'],
  memory: ['ai_memory_entries', 'id'],
  session: ['ai_sessions', 'session_id'],
} as const;
const UNIT_EVENT = 'project-scope-backfill-unit:v1';
const TRANSITION_EVENT = 'project-scope-backfill:v1';

export function parseBackfillNativeRow(value: string): Record<string, unknown> {
  const decimal = (source: string) => {
    const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(source);
    if (match === null) throw new Error('native_numeric_precision');
    let digits = `${match[2]}${match[3] ?? ''}`.replace(/^0+/u, '');
    if (digits === '') return '0';
    const exponent = Number(match[4] ?? 0) - (match[3]?.length ?? 0);
    if (!Number.isSafeInteger(exponent)) throw new Error('native_numeric_precision');
    const length = digits.length;
    digits = digits.replace(/0+$/u, '');
    return `${match[1]}${digits}e${String(exponent + length - digits.length)}`;
  };
  const row: unknown = JSON.parse(value, (_key, parsed: unknown, context?: { source?: string }) => {
    if (
      typeof parsed === 'number' &&
      (!Number.isFinite(parsed) ||
        context?.source === undefined ||
        decimal(context.source) !== decimal(JSON.stringify(parsed)))
    )
      throw new Error('native_numeric_precision');
    return parsed;
  });
  if (!isRecord(row)) throw new Error('unsupported_native_row');
  return row;
}

async function readNativeRows(
  client: DbClient,
  input: {
    table: string;
    key: string;
    where: string;
    params: unknown[];
    limit: number;
    maxBytes: number;
  },
) {
  const { table, key, where, params, limit, maxBytes } = input;
  const result = await client.query<{ row: string | null; total_bytes: string }>(
    `WITH selected AS MATERIALIZED (
      SELECT (to_jsonb(t) ${table === 'ai_memory_entries' ? "|| jsonb_build_object('id',t.id::text)" : ''})::text AS row
      FROM ${table} t WHERE ${where} ORDER BY ${key} LIMIT $${String(params.length + 1)}
    ), sized AS (SELECT row,sum(octet_length(row)) OVER () AS total_bytes FROM selected)
    SELECT CASE WHEN total_bytes <= $${String(params.length + 2)} THEN row ELSE NULL END AS row,total_bytes::text FROM sized`,
    [...params, limit, maxBytes],
  );
  if (result.rows.some(row => row.row === null)) throw new Error('oversized_input_unit');
  return {
    bytes: Number(result.rows[0]?.total_bytes ?? 0),
    rows: result.rows.map(row => parseBackfillNativeRow(row.row!)),
  };
}

async function artifactIdentity() {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const modules = [
    'project-scope-backfill',
    'normalization',
    'hashing',
    'memory-store',
    'runtime',
    'query-runner',
    'failure-events',
    'type-guards',
    'pool',
    'value-utils',
  ];
  const bytes = await Promise.all(
    modules.map(async name => [
      name,
      stableJsonHash(await readFile(new URL(`./${name}.${extension}`, import.meta.url), 'utf8')),
    ]),
  );
  bytes.push([
    'cli',
    stableJsonHash(await readFile(new URL(`../tools/backfill-project-scope.${extension}`, import.meta.url), 'utf8')),
  ]);
  bytes.push([
    'timeout-policy',
    stableJsonHash(await readFile(new URL(`../timeout-policy.${extension}`, import.meta.url), 'utf8')),
  ]);
  bytes.push(['node', process.versions.node], ['db-timeouts', stableJsonHash(resolveTimeoutPolicy().db)]);
  const names = (await readdir(new URL('../../migrations/', import.meta.url)))
    .filter(name => /^\d{3}_.+\.sql$/u.test(name))
    .sort();
  if (names.length === 0) throw new Error('missing_migration_assets');
  const sources = new Map<string, string>();
  for (const name of names) {
    const source = await readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
    bytes.push([name, stableJsonHash(source)]);
    sources.set(name, source);
  }
  const generatedExpression = /GENERATED ALWAYS AS \(([\s\S]+)\) STORED;/u.exec(
    sources.get('007_stored_search_vector.sql') ?? '',
  )?.[1];
  const membershipExpression = /USING GIN \(([\s\S]+)\);/u.exec(
    sources.get('003_searchable_provenance.sql') ?? '',
  )?.[1];
  if (generatedExpression === undefined || membershipExpression === undefined)
    throw new Error('incompatible_migration_assets');
  const functions = [
    {
      name: 'ai_memory_tags_to_search_text',
      file: '003_searchable_provenance.sql',
      args: 'text[]',
      language: 'sql',
      returns: 'text',
      parallel: 's',
      strict: true,
      volatility: 'i',
    },
    {
      name: 'ai_memory_reference_search_terms',
      file: '004_reference_search_terms.sql',
      args: 'text, text, jsonb, text[]',
      language: 'sql',
      returns: 'text',
      parallel: 's',
      strict: false,
      volatility: 'i',
    },
    {
      name: 'prevent_event_update',
      file: '001_baseline.sql',
      args: '',
      language: 'plpgsql',
      returns: 'trigger',
      parallel: 'u',
      strict: false,
      volatility: 'v',
    },
  ].map(specification => {
    const source = sources.get(specification.file) ?? '';
    const start = source.indexOf(`FUNCTION ${specification.name}(`);
    const body = start < 0 ? undefined : /AS\s+\$\$([\s\S]*?)\$\$/u.exec(source.slice(start))?.[1];
    if (body === undefined) throw new Error('incompatible_migration_assets');
    return { ...specification, body: body.trim() };
  });
  return {
    code: stableJsonHash(bytes),
    functions,
    generatedExpression,
    membershipExpression,
    migrationNames: names.map(name => name.slice(0, -4)),
  };
}

function canonicalSql(value: unknown) {
  return (String(value).match(/'(?:''|[^'])*'|"(?:""|[^"])*"|[^'"]+/gu) ?? [])
    .map(token =>
      token.startsWith("'") || token.startsWith('"')
        ? token
        : token
            .replace(/::(?:double precision|text|regconfig)\b/giu, '')
            .replace(/[()\s]/gu, '')
            .toLowerCase(),
    )
    .join('');
}

function assertCompatibleSchema(
  input: {
    columns: Record<string, unknown>[];
    constraints: Record<string, unknown>[];
    indexes: Record<string, unknown>[];
    triggers: Record<string, unknown>[];
  },
  artifact: Awaited<ReturnType<typeof artifactIdentity>>,
) {
  const columns: Record<string, string> = {
    ai_memory_entries:
      'id:int8! content:text! project:text category:text tags:_text! source:text! confidence:float8! created_at:timestamptz! updated_at:timestamptz! memory_key:text status:text! supersedes_id:int8 agent:text model:text tool:text session_id:text thread_id:text org_id:text repo_id:text repo_slug:text user_id:text sensitivity:text! expires_at:timestamptz evidence_refs:jsonb! metadata_json:jsonb! updated_by:text dedupe_hash:text memory_type:text! declared_confidence:float8 calibrated_confidence:float8 search_vector:tsvector last_accessed_at:timestamptz',
    ai_sessions:
      'session_id:text! org_id:text repo_id:text repo_slug:text user_id:text agent:text! model:text tool:text task_id:text task_type:text task_title:text status:text! metadata_json:jsonb! started_at:timestamptz! updated_at:timestamptz! ended_at:timestamptz',
    ai_continuity_packs:
      'scope_key:text! project:text! session_id:text source:text! payload_chars:int4! budget_chars:int4! pack_json:jsonb! created_at:timestamptz! updated_at:timestamptz!',
    ai_memory_events:
      'id:int8! memory_id:int8! event_type:text! actor:text payload_json:jsonb! created_at:timestamptz!',
    ai_session_events:
      'id:int8! event_id:text! session_id:text! event_type:text! summary:text! payload_json:jsonb! created_at:timestamptz!',
  };
  for (const [table, specification] of Object.entries(columns))
    for (const field of specification.split(' ')) {
      const [name, type] = field.split(':') as [string, string];
      const column = input.columns.find(row => row.table_name === table && row.column_name === name);
      if (
        column === undefined ||
        column.udt_name !== type.replace('!', '') ||
        column.is_nullable !== (type.endsWith('!') ? 'NO' : 'YES') ||
        (name === 'id' && !String(column.column_default).startsWith('nextval('))
      )
        throw new Error('incompatible_schema');
      if (name === 'search_vector') {
        if (
          column.is_generated !== 'ALWAYS' ||
          canonicalSql(column.generation_expression) !== canonicalSql(artifact.generatedExpression)
        )
          throw new Error('incompatible_schema');
      } else if (column.is_generated !== 'NEVER') throw new Error('incompatible_schema');
    }
  const indexes: [string, string, boolean, string[], string?][] = [
    ['ai_memory_entries_memory_key_uidx', 'btree', true, ['memory_key'], 'memory_key IS NOT NULL'],
    [
      'ai_memory_entries_dedupe_hash_idx',
      'btree',
      false,
      ['dedupe_hash', 'updated_at DESC'],
      'dedupe_hash IS NOT NULL AND memory_key IS NULL',
    ],
    ['ai_memory_entries_session_idx', 'btree', false, ['session_id']],
    ['ai_memory_entries_project_created_idx', 'btree', false, ['project', 'created_at DESC']],
    ['ai_memory_entries_project_status_created_idx', 'btree', false, ['project', 'status', 'created_at DESC']],
    ['ai_memory_entries_search_idx', 'gin', false, [artifact.membershipExpression]],
    ['ai_memory_entries_reference_search_idx', 'gin', false, [artifact.generatedExpression]],
    ['ai_sessions_repo_id_updated_idx', 'btree', false, ['repo_id', 'updated_at DESC']],
    ['ai_continuity_packs_project_updated_idx', 'btree', false, ['project', 'updated_at DESC']],
    ['ai_continuity_packs_session_idx', 'btree', false, ['session_id'], 'session_id IS NOT NULL'],
    ['ai_memory_events_memory_created_idx', 'btree', false, ['memory_id', 'created_at DESC']],
    ['ai_session_events_session_created_idx', 'btree', false, ['session_id', 'created_at DESC']],
  ];
  for (const [name, method, unique, keys, predicate] of indexes) {
    const index = input.indexes.find(row => row.indexname === name);
    const definition = String(index?.indexdef ?? '').split(' USING ')[1];
    const expected = `${method} (${keys.join(',')})${predicate === undefined ? '' : ` WHERE ${predicate}`}`;
    if (
      index === undefined ||
      index.valid !== true ||
      index.ready !== true ||
      index.method !== method ||
      index.unique !== unique ||
      index.tablename !== TABLES.find(table => name.startsWith(`${table}_`)) ||
      canonicalSql(definition) !== canonicalSql(expected)
    )
      throw new Error('incompatible_schema');
  }
  const constraints: Record<string, string> = {
    ai_memory_entries_pkey: 'PRIMARY KEY (id)',
    ai_memory_entries_confidence_check: 'CHECK (confidence >= 0 AND confidence <= 1)',
    ai_memory_entries_status_check:
      "CHECK (status = ANY (ARRAY['active','contested','superseded','expired','archived']))",
    ai_memory_entries_sensitivity_check:
      "CHECK (sensitivity = ANY (ARRAY['public','internal','confidential','restricted']))",
    ai_memory_entries_supersedes_fk: 'FOREIGN KEY (supersedes_id) REFERENCES ai_memory_entries(id) ON DELETE SET NULL',
    ai_memory_entries_memory_type_check:
      "CHECK (memory_type = ANY (ARRAY['episodic','semantic','procedural','reflective']))",
    ai_memory_entries_declared_confidence_check:
      'CHECK (declared_confidence IS NULL OR declared_confidence >= 0 AND declared_confidence <= 1)',
    ai_memory_entries_calibrated_confidence_check:
      'CHECK (calibrated_confidence IS NULL OR calibrated_confidence >= 0 AND calibrated_confidence <= 1)',
    ai_sessions_pkey: 'PRIMARY KEY (session_id)',
    ai_sessions_status_check: "CHECK (status = ANY (ARRAY['active','completed','abandoned','error']))",
    ai_continuity_packs_pkey: 'PRIMARY KEY (scope_key)',
    ai_continuity_packs_payload_chars_check: 'CHECK (payload_chars >= 0)',
    ai_continuity_packs_budget_chars_check: 'CHECK (budget_chars >= 0)',
    ai_continuity_packs_session_fk: 'FOREIGN KEY (session_id) REFERENCES ai_sessions(session_id) ON DELETE SET NULL',
    ai_memory_events_pkey: 'PRIMARY KEY (id)',
    ai_memory_events_memory_fk: 'FOREIGN KEY (memory_id) REFERENCES ai_memory_entries(id) ON DELETE CASCADE',
    ai_session_events_pkey: 'PRIMARY KEY (id)',
    ai_session_events_event_id_key: 'UNIQUE (event_id)',
    ai_session_events_session_fk: 'FOREIGN KEY (session_id) REFERENCES ai_sessions(session_id) ON DELETE CASCADE',
  };
  for (const [name, definition] of Object.entries(constraints)) {
    const constraint = input.constraints.find(row => row.conname === name);
    if (
      constraint === undefined ||
      constraint.valid !== true ||
      constraint.deferrable !== false ||
      canonicalSql(constraint.definition) !== canonicalSql(definition)
    )
      throw new Error('incompatible_schema');
  }
  const trigger = input.triggers[0];
  if (
    input.triggers.length !== 1 ||
    trigger?.relname !== 'ai_session_events' ||
    trigger.tgname !== 'ai_session_events_no_update' ||
    trigger.enabled !== 'O' ||
    trigger.type !== 19
  )
    throw new Error('incompatible_schema');
}

async function databaseIdentity(
  client: DbClient,
  artifact: Awaited<ReturnType<typeof artifactIdentity>>,
): Promise<BackfillIdentity> {
  const ledger = await client.query<{ name: string }>('SELECT name FROM public.ai_memory_pgmigrations ORDER BY name');
  if (stableJsonHash(ledger.rows.map(row => row.name)) !== stableJsonHash(artifact.migrationNames))
    throw new Error('incompatible_migration_history');
  const namespace = (
    await client.query<Record<string, unknown>>(`SELECT current_database() AS database, current_schema() AS schema,
    (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,
    (SELECT oid::text FROM pg_namespace WHERE nspname=current_schema()) AS schema_oid,
    inet_server_addr()::text AS address, inet_server_port() AS port`)
  ).rows[0];
  if (namespace === undefined) throw new Error('unavailable_namespace');
  const columns = await client.query<Record<string, unknown>>(
    `SELECT table_name,column_name,udt_name,is_nullable,column_default,is_generated,generation_expression
    FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=ANY($1::text[])
    ORDER BY table_name,ordinal_position`,
    [TABLES],
  );
  if (new Set(columns.rows.map(row => row.table_name)).size !== TABLES.length) throw new Error('incompatible_schema');
  const indexes = await client.query<Record<string, unknown>>(
    `SELECT c.relname AS tablename,i.relname AS indexname,pg_get_indexdef(i.oid) AS indexdef,
    x.indisvalid AS valid,x.indisready AS ready,x.indisunique AS unique,a.amname AS method,
    pg_get_expr(x.indpred,x.indrelid) AS predicate
    FROM pg_index x JOIN pg_class c ON c.oid=x.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_am a ON a.oid=i.relam
    WHERE n.nspname=current_schema() AND c.relname=ANY($1::text[]) ORDER BY c.relname,i.relname`,
    [TABLES],
  );
  const constraints = await client.query<Record<string, unknown>>(
    `SELECT c.relname,p.conname,pg_get_constraintdef(p.oid) AS definition,p.convalidated AS valid,p.condeferrable AS deferrable
    FROM pg_constraint p JOIN pg_class c ON c.oid=p.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() AND c.relname=ANY($1::text[]) ORDER BY c.relname,p.conname`,
    [TABLES],
  );
  const triggers = await client.query<Record<string, unknown>>(
    `SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid) AS definition,t.tgenabled AS enabled,t.tgtype::int AS type,
    t.tgfoid::text AS function_oid,t.tgnargs::int AS args,t.tgattr::text AS columns,t.tgqual IS NULL AS unconditional
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE NOT t.tgisinternal AND n.nspname=current_schema() AND c.relname=ANY($1::text[]) ORDER BY c.relname,t.tgname`,
    [TABLES],
  );
  assertCompatibleSchema(
    { columns: columns.rows, constraints: constraints.rows, indexes: indexes.rows, triggers: triggers.rows },
    artifact,
  );
  const functions = await client.query<Record<string, unknown>>(
    `SELECT p.oid::text AS oid,p.proname AS name,p.prosrc AS body,oidvectortypes(p.proargtypes) AS args,
    l.lanname AS language,format_type(p.prorettype,NULL) AS returns,p.proparallel AS parallel,
    p.proisstrict AS strict,p.provolatile AS volatility,p.prosecdef AS security_definer,p.proconfig AS config,
    p.prokind AS kind,p.proleakproof AS leakproof,pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
    WHERE n.nspname=current_schema() AND p.proname=ANY($1::text[]) ORDER BY p.proname,p.oid`,
    [artifact.functions.map(row => row.name)],
  );
  if (functions.rows.length !== artifact.functions.length) throw new Error('incompatible_schema');
  for (const expected of artifact.functions) {
    const actual = functions.rows.find(row => row.name === expected.name && row.args === expected.args);
    if (
      actual === undefined ||
      String(actual.body).trim() !== expected.body ||
      actual.language !== expected.language ||
      actual.returns !== expected.returns ||
      actual.parallel !== expected.parallel ||
      actual.strict !== expected.strict ||
      actual.volatility !== expected.volatility ||
      actual.security_definer !== false ||
      actual.config !== null ||
      actual.kind !== 'f' ||
      actual.leakproof !== false
    )
      throw new Error('incompatible_schema');
  }
  const trigger = triggers.rows[0]!;
  if (
    trigger.function_oid !== functions.rows.find(row => row.name === 'prevent_event_update')?.oid ||
    trigger.args !== 0 ||
    trigger.columns !== '' ||
    trigger.unconditional !== true
  )
    throw new Error('incompatible_schema');
  return {
    code: artifact.code,
    namespace: JSON.stringify(namespace),
    schema: stableJsonHash({
      columns: columns.rows,
      constraints: constraints.rows,
      functions: functions.rows,
      indexes: indexes.rows,
      ledger: ledger.rows,
      triggers: triggers.rows,
    }),
  };
}

async function loadData(client: DbClient, selectors: BackfillSelectors): Promise<BackfillData> {
  const data: BackfillData = { memories: [], packs: [], sessions: [] };
  let payloadBytes = 0;
  const size = () => data.memories.length + data.packs.length + data.sessions.length;
  const fetchRows = async (
    kind: 'memories' | 'packs' | 'sessions',
    table: string,
    key: string,
    where: string,
    params: unknown[],
  ) => {
    const remaining = Math.max(1, selectors.limit + 1 - size());
    const result = await readNativeRows(client, {
      table,
      key,
      where,
      params,
      limit: remaining,
      maxBytes: 32 * 1024 * 1024 - payloadBytes,
    });
    payloadBytes += result.bytes;
    data[kind].push(...result.rows);
    return size() <= selectors.limit;
  };
  const pair = [selectors.legacyProject, selectors.project];
  const filter = selectors.sessionId ?? null;
  if (
    !(await fetchRows(
      'memories',
      'ai_memory_entries',
      'id',
      'project=ANY($1::text[]) AND ($2::text IS NULL OR session_id=$2)',
      [pair, filter],
    ))
  )
    return data;
  if (
    !(await fetchRows(
      'packs',
      'ai_continuity_packs',
      'scope_key',
      'project=ANY($1::text[]) AND ($2::text IS NULL OR session_id=$2)',
      [pair, filter],
    ))
  )
    return data;
  const linked = [
    ...new Set([...data.memories, ...data.packs].map(row => text(row.session_id)).filter(value => value !== null)),
  ];
  if (
    !(await fetchRows(
      'sessions',
      'ai_sessions',
      'session_id',
      '($1::text IS NOT NULL AND session_id=$1) OR ($1::text IS NULL AND (session_id=ANY($2::text[]) OR repo_id=ANY($3::text[]) OR repo_slug=ANY($3::text[])))',
      [filter, linked, [selectors.project, `github.com/${selectors.project}`]],
    ))
  )
    return data;
  const sessions = data.sessions.map(row => row.session_id);
  if (
    !(await fetchRows(
      'memories',
      'ai_memory_entries',
      'id',
      'session_id=ANY($1::text[]) AND NOT(id::text=ANY($2::text[]))',
      [sessions, data.memories.map(row => String(row.id))],
    ))
  )
    return data;
  if (
    !(await fetchRows(
      'packs',
      'ai_continuity_packs',
      'scope_key',
      'session_id=ANY($1::text[]) AND NOT(scope_key=ANY($2::text[]))',
      [sessions, data.packs.map(row => row.scope_key)],
    ))
  )
    return data;
  const provisional = buildProjectScopeBackfillPlan({
    data,
    identity: { code: '', namespace: '', schema: '' },
    selectors,
  });
  const keys = provisional.changes.flatMap(change =>
    change.prospectiveKey === undefined ? [] : [change.prospectiveKey],
  );
  const hashes = provisional.changes
    .filter(
      change =>
        change.table === 'memory' && data.memories.find(row => String(row.id) === change.id)?.memory_key == null,
    )
    .map(change => change.to.dedupe_hash)
    .filter(value => value !== null);
  const candidateMemoryIds = new Set(data.memories.map(row => String(row.id)));
  const candidatePackKeys = new Set(data.packs.map(row => String(row.scope_key)));
  if (
    !(await fetchRows(
      'memories',
      'ai_memory_entries',
      'id',
      'NOT(id::text=ANY($1::text[])) AND (memory_key=ANY($2::text[]) OR (memory_key IS NULL AND dedupe_hash=ANY($3::text[])))',
      [data.memories.map(row => String(row.id)), keys, hashes],
    ))
  )
    return data;
  const packKeys = provisional.changes
    .filter(change => change.table === 'continuity')
    .map(change => change.to.scope_key);
  await fetchRows(
    'packs',
    'ai_continuity_packs',
    'scope_key',
    'scope_key=ANY($1::text[]) AND NOT(scope_key=ANY($2::text[]))',
    [packKeys, data.packs.map(row => row.scope_key)],
  );
  data.collisionOnly = {
    memoryIds: data.memories.filter(row => !candidateMemoryIds.has(String(row.id))).map(row => String(row.id)),
    packKeys: data.packs.filter(row => !candidatePackKeys.has(String(row.scope_key))).map(row => String(row.scope_key)),
  };
  for (const [kind, key] of [
    ['memories', 'id'],
    ['packs', 'scope_key'],
    ['sessions', 'session_id'],
  ] as const)
    data[kind].sort((a, b) => (String(a[key]) < String(b[key]) ? -1 : String(a[key]) > String(b[key]) ? 1 : 0));
  return data;
}

export async function createProjectScopeBackfillPlan(input: {
  pool: DbPool;
  selectors: BackfillSelectors;
}): Promise<BackfillPlan> {
  validateBackfillSelectors(input.selectors);
  const artifact = await artifactIdentity();
  return runBoundedQuery({
    phase: 'db.read.project_scope_backfill',
    pool: input.pool,
    timeoutMs: resolveTimeoutPolicy().db.readTimeoutMs,
    task: async client => {
      await client.query('SET TRANSACTION READ ONLY, ISOLATION LEVEL REPEATABLE READ');
      const identity = await databaseIdentity(client, artifact);
      return buildProjectScopeBackfillPlan({
        data: await loadData(client, input.selectors),
        identity,
        selectors: input.selectors,
      });
    },
  });
}

function completionPayload(plan: BackfillPlan) {
  return {
    anchor: plan.anchor,
    changes: plan.changes,
    identity: plan.identity,
    planDigest: plan.digest,
    selectors: plan.selectors,
    postState: plan.observations.map(observation => {
      const change = plan.changes.find(item => item.table === observation.table && item.id === observation.id);
      return change === undefined
        ? observation
        : {
            fingerprint: change.after,
            id: change.table === 'continuity' ? change.to.scope_key : change.id,
            table: change.table,
          };
    }),
    version: 1,
  };
}

async function readCompletion(client: DbClient, plan: BackfillPlan) {
  if (plan.anchor?.kind === 'session') {
    // event_id is globally unique. Do not filter out the wrong session/type.
    const result = await client.query<{ event_type: string; payload_json: unknown; session_id: string }>(
      'SELECT event_type,payload_json,session_id FROM ai_session_events WHERE event_id=$1',
      [`${TRANSITION_EVENT}:${plan.digest}`],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    if (row.event_type !== UNIT_EVENT || row.session_id !== plan.anchor.id) throw new Error('conflicting_completion');
    return row.payload_json;
  }
  if (plan.anchor?.kind !== 'memory') throw new Error('unattested_anchor');
  const result = await client.query<{ payload_json: unknown }>(
    `SELECT payload_json FROM ai_memory_events
    WHERE memory_id=$1 AND event_type=$2 AND payload_json->>'planDigest'=$3 ORDER BY id LIMIT 2`,
    [plan.anchor.id, UNIT_EVENT, plan.digest],
  );
  if (result.rowCount > 1) throw new Error('conflicting_completion');
  return result.rows[0]?.payload_json;
}

async function assertPostState(client: DbClient, plan: BackfillPlan) {
  const expected = completionPayload(plan).postState;
  let payloadBytes = 0;
  for (const table of ['continuity', 'memory', 'session'] as const) {
    const entries = expected.filter(row => row.table === table);
    if (entries.length === 0) continue;
    const [name, key] = ROW_TABLES[table];
    const result = await readNativeRows(client, {
      table: name,
      key,
      where: `${key}::text=ANY($1::text[])`,
      params: [entries.map(row => row.id)],
      limit: entries.length + 1,
      maxBytes: 32 * 1024 * 1024 - payloadBytes,
    });
    payloadBytes += result.bytes;
    if (
      result.rows.length !== entries.length ||
      result.rows.some(
        row => entries.find(entry => entry.id === String(row[key]))?.fingerprint !== rowFingerprint(table, row),
      )
    )
      throw new Error('incompatible_post_state');
  }
}

export async function applyProjectScopeBackfill(input: { expectedDigest: string; plan: unknown; pool: DbPool }) {
  const plan = validateProjectScopeBackfillPlan(input.plan);
  if (input.expectedDigest !== plan.digest || plan.status !== 'ready' || !plan.complete || plan.anchor === undefined)
    throw new Error('unapproved_plan');
  const anchor = plan.anchor;
  const artifact = await artifactIdentity();
  return runBoundedQuery({
    phase: 'db.write.project_scope_backfill',
    pool: input.pool,
    timeoutMs: resolveTimeoutPolicy().db.writeTimeoutMs,
    task: async client => {
      await client.query(
        'LOCK TABLE ai_continuity_packs,ai_memory_entries,ai_memory_events,ai_session_events,ai_sessions,public.ai_memory_pgmigrations IN SHARE ROW EXCLUSIVE MODE NOWAIT',
      );
      const identity = await databaseIdentity(client, artifact);
      if (stableJsonHash(identity) !== stableJsonHash(plan.identity)) throw new Error('incompatible_plan_identity');
      const payload = completionPayload(plan);
      const completed = await readCompletion(client, plan);
      if (completed !== undefined) {
        if (stableJsonHash(completed) !== stableJsonHash(payload)) throw new Error('conflicting_completion');
        await assertPostState(client, plan);
        return { planDigest: plan.digest, status: 'skipped' as const };
      }
      const current = buildProjectScopeBackfillPlan({
        data: await loadData(client, plan.selectors),
        identity,
        selectors: plan.selectors,
      });
      if (current.digest !== plan.digest) throw new Error('stale_plan');
      for (const change of plan.changes) {
        const [table, key] = ROW_TABLES[change.table];
        let result;
        if (change.table === 'memory')
          result = await client.query(
            `UPDATE ${table} SET project=$2,dedupe_hash=$3 WHERE ${key}=$1 AND project IS NOT DISTINCT FROM $4 AND dedupe_hash IS NOT DISTINCT FROM $5`,
            [change.id, change.to.project, change.to.dedupe_hash, change.from.project, change.from.dedupe_hash],
          );
        else if (change.table === 'session')
          result = await client.query(
            `UPDATE ${table} SET repo_id=$2 WHERE ${key}=$1 AND repo_id IS NOT DISTINCT FROM $3`,
            [change.id, change.to.repo_id, change.from.repo_id],
          );
        else
          result = await client.query(
            `UPDATE ${table} SET project=$2,scope_key=$3 WHERE ${key}=$1 AND project IS NOT DISTINCT FROM $4`,
            [change.id, change.to.project, change.to.scope_key, change.from.project],
          );
        if (result.rowCount !== 1) throw new Error('changed_row_count');
      }
      await assertPostState(client, plan);
      for (const change of plan.changes.filter(row => row.table === 'memory'))
        await insertMemoryEventWithClient(client, {
          actor: 'project-scope-backfill',
          eventType: TRANSITION_EVENT,
          memoryId: Number(change.id),
          payloadJson: {
            after: change.after,
            before: change.before,
            evidence: change.evidence,
            from: change.from,
            memoryId: change.id,
            planDigest: plan.digest,
            to: change.to,
            version: 1,
          },
        });
      if (anchor.kind === 'session')
        await insertSessionEventWithClient(client, {
          createdAt: new Date().toISOString(),
          eventId: `${TRANSITION_EVENT}:${plan.digest}`,
          eventType: UNIT_EVENT,
          payloadJson: payload,
          sessionId: anchor.id,
          summary: 'Verified bounded repository scope maintenance.',
        });
      else
        await insertMemoryEventWithClient(client, {
          actor: 'project-scope-backfill',
          eventType: UNIT_EVENT,
          memoryId: Number(anchor.id),
          payloadJson: payload,
        });
      if (stableJsonHash(await readCompletion(client, plan)) !== stableJsonHash(payload))
        throw new Error('completion_readback_failed');
      return { planDigest: plan.digest, status: 'applied' as const };
    },
  });
}
