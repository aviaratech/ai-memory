import { assertLocalDatabaseUrl, createPool, type DbPool } from './pool.js';
import type { AnySchemaObject } from 'ajv';

import addFormats from 'ajv-formats';
import Ajv2020 from 'ajv/dist/2020.js';

import contextPackSchemaJson from '../schemas/context_pack_v0_1.schema.json' with { type: 'json' };
import memoryDeltaSchemaJson from '../schemas/memory_delta_v0_1.schema.json' with { type: 'json' };
import { resolveTimeoutPolicy } from '../timeout-policy.js';

export function getDatabaseUrl(): string | undefined {
  const value = process.env.AI_MEMORY_DATABASE_URL;
  return value === undefined || value.trim().length === 0 ? undefined : assertLocalDatabaseUrl(value);
}

let _pool: DbPool | undefined;

function getPool(): DbPool {
  if (_pool === undefined) {
    const url = getDatabaseUrl();
    if (url === undefined) {
      throw new Error('AI_MEMORY_DATABASE_URL is required for the local ai-memory database.');
    }
    const timeoutPolicy = resolveTimeoutPolicy();
    _pool = createPool({
      connectionString: url,
      pgOptions: {
        query_timeout: timeoutPolicy.db.queryTimeoutMs,
        statement_timeout: timeoutPolicy.db.statementTimeoutMs,
      },
    });
  }
  return _pool;
}

export const pool: DbPool = {
  connect: (...args) => getPool().connect(...args),
  end: (...args) => (_pool === undefined ? Promise.resolve() : _pool.end(...args)),
  getClient: (...args) => getPool().getClient(...args),
  query: (...args) => getPool().query(...args),
};

export const CONTEXT_PACK_TOOL = 'context-pack';
export const MEMORY_DELTA_TOOL = 'memory-delta';
export const SESSION_SNAPSHOT_SCHEMA_VERSION = 'session_snapshot@0.1';
export const PATCH_SNAPSHOT_ID_PREFIX = 'patch-snapshot';
export const PATCH_OUT_OF_ORDER_STAGE = 'ingest_memory_delta_patch_out_of_order';
export const PATCH_BACKFILL_SESSION_FAILURE_STAGE = 'backfill_patch_snapshots_session';
export const PATCH_BACKFILL_SOURCE = 'backfill-patch-snapshots';

export const MEMORY_STATUS_VALUES = ['active', 'contested', 'superseded', 'expired', 'archived'];
export const SENSITIVITY_VALUES = ['public', 'internal', 'confidential', 'restricted'];
export const UNSAFE_JSON_POINTER_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export const DERIVED_MEMORY_KEY_PREFIX = 'derived-memory';
export const MEMORY_IDENTITY_HASH_VERSION = 'v1';
export const MIN_DURABLE_CONTENT_CHARS = 24;
export const MIN_HIGH_CONFIDENCE_DURABLE = 0.5;
export const SESSION_SUMMARY_CATEGORY = 'session-summary';
export const SESSION_SUMMARY_MAX_CONFIDENCE = 0.5;
export const UNKNOWN_INGESTION_FAILURE = 'unknown ingestion failure';

const contextPackSchema = contextPackSchemaJson as AnySchemaObject;
const memoryDeltaSchema = memoryDeltaSchemaJson as AnySchemaObject;

interface AjvLike {
  compile(schema: AnySchemaObject): AjvValidator;
}

interface AjvValidator {
  (payload: unknown): boolean;
  errors?: unknown;
}

const Ajv2020Ctor = Ajv2020 as unknown as new (options: { allErrors: boolean; strict: boolean }) => AjvLike;
const addFormatsFn = addFormats as unknown as (instance: AjvLike) => void;
const ajv = new Ajv2020Ctor({ allErrors: true, strict: false });
addFormatsFn(ajv);

export const validateContextPackV01: AjvValidator = ajv.compile(contextPackSchema);
export const validateMemoryDeltaV01: AjvValidator = ajv.compile(memoryDeltaSchema);

export const SEARCH_VECTOR_SQL = `
  (
  to_tsvector(
    'english',
    coalesce(content, '') ||
    ' ' ||
    coalesce(project, '') ||
    ' ' ||
    coalesce(category, '') ||
    ' ' ||
    coalesce(source, '') ||
    ' ' ||
    coalesce(memory_key, '') ||
    ' ' ||
    coalesce(evidence_refs::text, '') ||
    ' ' ||
    ai_memory_tags_to_search_text(tags)
  ) || to_tsvector(
    'english',
    ai_memory_reference_search_terms(content, memory_key, evidence_refs, tags)
  )
  )
`;
