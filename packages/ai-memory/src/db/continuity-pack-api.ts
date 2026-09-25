import type { DbClient } from './pool.js';
import type { QueryResultRow } from 'pg';

import { resolveTimeoutPolicy } from '../timeout-policy.js';
import { normalizeOptionalText, normalizeRequiredText } from './normalization.js';
import { runBoundedQuery } from './query-runner.js';
import { pool } from './runtime.js';
import { isRecord } from './type-guards.js';

const CONTINUITY_PACK_SCHEMA_VERSION = 'continuity_pack@0.1';
const PROJECT_SCOPE_PREFIX = 'project:';

export const CONTINUITY_PACK_SCOPE_TYPES = ['lead', 'outcome', 'project', 'task'] as const;

export type ContinuityPackReadResult =
  | {
      pack: ContinuityPackRecord;
      status: 'found';
    }
  | {
      project: string | undefined;
      scopeKey: string | undefined;
      status: 'missing';
    };

export interface ContinuityPackRecord {
  budgetChars: number;
  createdAt: string | undefined;
  pack: Record<string, unknown>;
  payloadChars: number;
  project: string;
  scopeKey: string;
  sessionId: string | undefined;
  source: string;
  status: 'fresh';
  updatedAt: string | undefined;
}

export interface ContinuityPackScope {
  id?: string | undefined;
  type: ContinuityPackScopeType;
}

export type ContinuityPackScopeType = (typeof CONTINUITY_PACK_SCOPE_TYPES)[number];

export interface ContinuityPackWriteInput {
  budgetChars: number;
  pack: Record<string, unknown>;
  payloadText: string;
  project: string;
  scope?: ContinuityPackScope | undefined;
  sessionId?: string | undefined;
  source: string;
  updatedAt?: string | undefined;
}

export interface ContinuityPackWriteResult {
  budgetChars: number;
  payloadChars: number;
  project: string;
  scopeKey: string;
  status: 'updated';
}

interface ContinuityPackRow extends QueryResultRow {
  budget_chars?: number | string;
  created_at?: Date | string;
  pack_json?: unknown;
  payload_chars?: number | string;
  project?: string;
  scope_key?: string;
  session_id?: string;
  source?: string;
  updated_at?: Date | string;
}

export function buildContinuityPackScopeKey(project: string): string {
  const normalized = project.trim();
  if (normalized.length === 0) {
    throw new Error('project is required for continuity pack scope.');
  }
  return `${PROJECT_SCOPE_PREFIX}${normalized}`;
}

export function buildScopedContinuityPackScopeKey(input: { project: string; scope: ContinuityPackScope }): string {
  const project = normalizeRequiredText(input.project, 'project');
  if (input.scope.type === 'project') {
    return buildContinuityPackScopeKey(project);
  }

  const scopeId = normalizeRequiredText(input.scope.id, `${input.scope.type} scope id`);
  return `${input.scope.type}:${project}:${scopeId}`;
}

export async function getContinuityPack(input: unknown): Promise<ContinuityPackReadResult> {
  const request = isRecord(input) ? input : {};
  const project = normalizeOptionalText(request.project) ?? normalizeOptionalText(request.repoId);
  if (project === undefined) {
    return { project: undefined, scopeKey: undefined, status: 'missing' };
  }

  const scopeKey = buildScopedContinuityPackScopeKey({ project, scope: resolveContinuityPackScope(request) });
  const result = await runDbReadQuery({
    operation: 'continuity_pack',
    task: client =>
      client.query<ContinuityPackRow>(
        `
          SELECT *
          FROM ai_continuity_packs
          WHERE scope_key = $1
          LIMIT 1
        `,
        [scopeKey],
      ),
  });
  const row = result.rows.at(0);
  if (row === undefined) {
    return { project, scopeKey, status: 'missing' };
  }
  return {
    pack: toContinuityPackRecord(row),
    status: 'found',
  };
}

export async function upsertContinuityPack(input: ContinuityPackWriteInput): Promise<ContinuityPackWriteResult> {
  const project = normalizeRequiredText(input.project, 'project');
  const source = normalizeRequiredText(input.source, 'source');
  const sessionId = normalizeOptionalText(input.sessionId);
  const updatedAt = normalizeOptionalText(input.updatedAt) ?? new Date().toISOString();
  const budgetChars = normalizeNonNegativeInteger(input.budgetChars, 'budgetChars');
  const payloadChars = input.payloadText.length;
  const scopeKey = buildScopedContinuityPackScopeKey({
    project,
    scope: normalizeContinuityPackScope(input.scope),
  });
  const pack = {
    ...input.pack,
    schemaVersion: CONTINUITY_PACK_SCHEMA_VERSION,
  };

  await runDbWriteQuery({
    operation: 'continuity_pack',
    task: client =>
      client.query(
        `
          INSERT INTO ai_continuity_packs (
            scope_key,
            project,
            session_id,
            source,
            payload_chars,
            budget_chars,
            pack_json,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz)
          ON CONFLICT (scope_key)
          DO UPDATE
            SET
              project = EXCLUDED.project,
              session_id = EXCLUDED.session_id,
              source = EXCLUDED.source,
              payload_chars = EXCLUDED.payload_chars,
              budget_chars = EXCLUDED.budget_chars,
              pack_json = EXCLUDED.pack_json,
              updated_at = EXCLUDED.updated_at
        `,
        [scopeKey, project, sessionId, source, payloadChars, budgetChars, JSON.stringify(pack), updatedAt],
      ),
  });

  return {
    budgetChars,
    payloadChars,
    project,
    scopeKey,
    status: 'updated',
  };
}

function normalizeContinuityPackScope(scope: ContinuityPackScope | undefined): ContinuityPackScope {
  if (scope === undefined || scope.type === 'project') {
    return { type: 'project' };
  }
  if (!CONTINUITY_PACK_SCOPE_TYPES.includes(scope.type)) {
    throw new Error(`Unsupported continuity pack scope type: ${scope.type}.`);
  }
  return {
    id: normalizeRequiredText(scope.id, `${scope.type} scope id`),
    type: scope.type,
  };
}

function normalizeNonNegativeInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer.`);
  }
  return value;
}

function resolveContinuityPackScope(request: Record<string, unknown>): ContinuityPackScope {
  const scopes = (['lead', 'outcome', 'task'] as const)
    .map(type => ({ id: normalizeOptionalText(request[type]), type }))
    .filter((scope): scope is { id: string; type: 'lead' | 'outcome' | 'task' } => scope.id !== undefined);
  if (scopes.length === 0) {
    return { type: 'project' };
  }
  if (scopes.length > 1) {
    throw new Error('Continuity pack recovery accepts exactly one of lead, outcome, or task.');
  }
  const scope = scopes[0];
  if (scope !== undefined) {
    return scope;
  }
  throw new Error('Continuity pack recovery did not resolve a requested scope.');
}

function runDbReadQuery<T>(input: { operation: string; task: (client: DbClient) => Promise<T> }): Promise<T> {
  return runBoundedQuery({
    phase: `db.read.${input.operation}`,
    pool,
    task: client => input.task(client),
    timeoutMs: resolveTimeoutPolicy().db.readTimeoutMs,
  });
}

function runDbWriteQuery<T>(input: { operation: string; task: (client: DbClient) => Promise<T> }): Promise<T> {
  return runBoundedQuery({
    phase: `db.write.${input.operation}`,
    pool,
    task: client => input.task(client),
    timeoutMs: resolveTimeoutPolicy().db.writeTimeoutMs,
  });
}

function toContinuityPackRecord(row: ContinuityPackRow): ContinuityPackRecord {
  const project = typeof row.project === 'string' ? row.project : '';
  const scopeKey = typeof row.scope_key === 'string' ? row.scope_key : buildContinuityPackScopeKey(project);
  return {
    budgetChars: toNumber(row.budget_chars),
    createdAt: toIsoIfDate(row.created_at),
    pack: isRecord(row.pack_json) ? row.pack_json : {},
    payloadChars: toNumber(row.payload_chars),
    project,
    scopeKey,
    sessionId: typeof row.session_id === 'string' ? row.session_id : undefined,
    source: typeof row.source === 'string' ? row.source : 'unknown',
    status: 'fresh',
    updatedAt: toIsoIfDate(row.updated_at),
  };
}

function toIsoIfDate(value: unknown): string | undefined {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return typeof value === 'string' ? value : undefined;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}
