import { getCategoryTier, getCategoryWeight, TAXONOMY_TIERS } from './taxonomy.js';

const DEFAULT_DECAY_HALF_LIFE_DAYS = 90;
const ACTIONABLE_ACTIVE_HALF_LIFE_DAYS = 180;
const SESSION_SUMMARY_HALF_LIFE_DAYS = 14;
const INITIAL_IMPORTANCE_EXPLICIT_FALLBACK = 0.5;
export const REVIEWER_APPROVED_DECISION_RANKING_PENALTY = 0.6;
export const IMPORTANCE_ACCESS_BOOST_INCREMENT = 0.02;
export const IMPORTANCE_ACCESS_BOOST_THROTTLE_HOURS = 24;

/**
 * Initial importance for approve-only reviewer decisions.
 * Lower than root-cause/architecture defaults to prevent audit records from crowding
 * out higher-value guidance in recall ordering.
 */
export const REVIEWER_DECISION_APPROVE_IMPORTANCE = 0.75;

/**
 * Initial importance for changes-requested reviewer decisions.
 * Higher than approve-only because changes-requested decisions carry actionable signal.
 */
export const REVIEWER_DECISION_CHANGES_REQUESTED_IMPORTANCE = 0.9;

const ACTIONABLE_SQL_LIST = TAXONOMY_TIERS.actionable.categories.map(quoteSqlLiteral).join(', ');
const LOW_SIGNAL_SQL_LIST = TAXONOMY_TIERS['low-signal'].categories.map(quoteSqlLiteral).join(', ');

interface DecayedImportanceForMemoryInput {
  category?: unknown;
  confidence?: unknown;
  createdAt?: unknown;
  defaultHalfLifeDays?: number | undefined;
  importance?: unknown;
  now?: Date | undefined;
  status?: unknown;
  tags?: unknown;
}

interface DecayedImportanceInput {
  createdAt: unknown;
  halfLifeDays: number;
  importance: number;
  now?: Date | undefined;
}

interface InitialImportanceInput {
  category?: unknown;
  confidence: number;
  explicitImportance?: number | undefined;
}

interface MemoryHalfLifeInput {
  category?: unknown;
  defaultHalfLifeDays: number;
  status?: unknown;
}

interface SqlExpressionColumns {
  categoryColumn?: string | undefined;
  confidenceColumn?: string | undefined;
  createdAtColumn?: string | undefined;
  importanceColumn?: string | undefined;
  statusColumn?: string | undefined;
  tagsColumn?: string | undefined;
}

export function buildBaseImportanceSqlExpression(columns: SqlExpressionColumns = {}): string {
  const confidenceColumn = columns.confidenceColumn ?? 'confidence';
  const importanceColumn = columns.importanceColumn ?? 'importance';
  const tierWeightSql = buildTierWeightSqlExpression(columns);
  const reviewerApprovedPenaltySql = buildReviewerApprovedDecisionPenaltySqlExpression(columns);

  return `LEAST(
    1.0,
    GREATEST(
      0.0,
      COALESCE(
        ${importanceColumn},
        COALESCE(${confidenceColumn}, 1.0) * (${tierWeightSql})
      ) * (${reviewerApprovedPenaltySql})
    )
  )`;
}

export function buildDecayedImportanceSqlExpression(
  defaultHalfLifeDays: number,
  columns: SqlExpressionColumns = {},
): string {
  const createdAtColumn = columns.createdAtColumn ?? 'created_at';
  const baseImportanceSql = buildBaseImportanceSqlExpression(columns);
  const halfLifeSql = buildDecayHalfLifeSqlExpression(defaultHalfLifeDays, columns);
  const ageDaysSql = `GREATEST(EXTRACT(EPOCH FROM (NOW() - COALESCE(${createdAtColumn}, NOW()))) / 86400.0, 0.0)`;

  return `LEAST(
    1.0,
    GREATEST(
      0.0,
      (${baseImportanceSql}) * POWER(0.5, (${ageDaysSql}) / (${halfLifeSql}))
    )
  )`;
}

export function buildDecayHalfLifeSqlExpression(
  defaultHalfLifeDays: number,
  columns: SqlExpressionColumns = {},
): string {
  const categoryColumn = columns.categoryColumn ?? 'category';
  const statusColumn = columns.statusColumn ?? 'status';
  const normalizedDefaultHalfLifeDays = normalizeHalfLifeDays(defaultHalfLifeDays, DEFAULT_DECAY_HALF_LIFE_DAYS);

  return `CASE
    WHEN lower(coalesce(${categoryColumn}, '')) = 'session-summary' THEN ${String(SESSION_SUMMARY_HALF_LIFE_DAYS)}.0
    WHEN lower(coalesce(${statusColumn}, '')) = 'active'
      AND lower(coalesce(${categoryColumn}, '')) IN (${ACTIONABLE_SQL_LIST})
      THEN ${String(ACTIONABLE_ACTIVE_HALF_LIFE_DAYS)}.0
    ELSE ${String(normalizedDefaultHalfLifeDays)}.0
  END`;
}

export function buildReviewerApprovedDecisionPenaltySqlExpression(columns: SqlExpressionColumns = {}): string {
  const categoryColumn = columns.categoryColumn ?? 'category';
  const tagsColumn = columns.tagsColumn ?? 'tags';

  return `CASE
    WHEN lower(coalesce(${categoryColumn}, '')) = 'decision'
      AND coalesce(${tagsColumn}, ARRAY[]::text[]) @> ARRAY['review']::text[]
      AND coalesce(${tagsColumn}, ARRAY[]::text[]) @> ARRAY['approved']::text[]
      AND NOT (coalesce(${tagsColumn}, ARRAY[]::text[]) && ARRAY['request-changes', 'changes-requested']::text[])
      THEN ${String(REVIEWER_APPROVED_DECISION_RANKING_PENALTY)}
    ELSE 1.0
  END`;
}

export function buildTierWeightSqlExpression(columns: SqlExpressionColumns = {}): string {
  const categoryColumn = columns.categoryColumn ?? 'category';
  return `CASE
    WHEN lower(coalesce(${categoryColumn}, '')) IN (${ACTIONABLE_SQL_LIST}) THEN 1.0
    WHEN lower(coalesce(${categoryColumn}, '')) IN (${LOW_SIGNAL_SQL_LIST}) THEN 0.0
    ELSE 0.5
  END`;
}

export function clampImportance(value: unknown): number {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return 0;
  }
  if (numericValue <= 0) {
    return 0;
  }
  if (numericValue >= 1) {
    return 1;
  }
  return numericValue;
}

export function computeInitialImportance(input: InitialImportanceInput): number {
  const confidenceSignal = clampImportance(input.confidence);
  const tierWeight = clampImportance(getCategoryWeight(input.category));
  const explicitImportance = clampImportance(input.explicitImportance ?? INITIAL_IMPORTANCE_EXPLICIT_FALLBACK);

  return clampImportance(confidenceSignal * 0.4 + tierWeight * 0.3 + explicitImportance * 0.3);
}

export function computeReadTimeDecayedImportance(input: DecayedImportanceForMemoryInput): number {
  const defaultHalfLifeDays = resolveDecayHalfLifeDays();
  const resolvedDefaultHalfLifeDays = normalizeHalfLifeDays(input.defaultHalfLifeDays, defaultHalfLifeDays);
  const fallbackImportance = clampImportance(clampImportance(input.confidence) * getCategoryWeight(input.category));
  const reviewerApprovedPenalty = resolveReviewerApprovedDecisionPenalty({
    category: input.category,
    tags: input.tags,
  });
  const baseImportance = clampImportance(
    clampImportance(input.importance ?? fallbackImportance) * reviewerApprovedPenalty,
  );
  const halfLifeDays = resolveMemoryHalfLifeDays({
    category: input.category,
    defaultHalfLifeDays: resolvedDefaultHalfLifeDays,
    status: input.status,
  });

  return decayedImportance({
    createdAt: input.createdAt,
    halfLifeDays,
    importance: baseImportance,
    now: input.now,
  });
}

export function decayedImportance(input: DecayedImportanceInput) {
  const now = input.now ?? new Date();
  const normalizedImportance = clampImportance(input.importance);
  const normalizedHalfLifeDays = normalizeHalfLifeDays(input.halfLifeDays, DEFAULT_DECAY_HALF_LIFE_DAYS);
  const ageDays = Math.max(0, computeAgeDays(input.createdAt, now));

  return clampImportance(normalizedImportance * Math.pow(0.5, ageDays / normalizedHalfLifeDays));
}

/**
 * Detects whether a memory write is a reviewer decision and returns the calibrated
 * initial importance override, or undefined if not applicable.
 *
 * Detection criteria:
 *  - category === 'decision'
 *  - source contains 'reviewer' (case-insensitive)
 *  - tags include 'approved' → 0.75 (approve-only)
 *  - tags include 'request-changes' or 'changes-requested' → 0.90
 *
 * Tags are expected to already be normalized (lowercase).
 */
export function detectReviewerDecisionImportance(input: {
  category: string;
  source: string;
  tags: string[];
}): number | undefined {
  if (input.category.toLowerCase() !== 'decision') {
    return undefined;
  }

  if (!input.source.toLowerCase().includes('reviewer')) {
    return undefined;
  }

  if (!Array.isArray(input.tags)) {
    return undefined;
  }

  if (input.tags.includes('request-changes') || input.tags.includes('changes-requested')) {
    return REVIEWER_DECISION_CHANGES_REQUESTED_IMPORTANCE;
  }

  if (input.tags.includes('approved')) {
    return REVIEWER_DECISION_APPROVE_IMPORTANCE;
  }

  return undefined;
}

export function isReviewerApprovedDecision(input: { category?: unknown; tags?: unknown }): boolean {
  if (normalizeOptionalText(input.category) !== 'decision') {
    return false;
  }

  const normalizedTags = normalizeTagSet(input.tags);
  if (!normalizedTags.has('approved') || !normalizedTags.has('review')) {
    return false;
  }

  return !normalizedTags.has('request-changes') && !normalizedTags.has('changes-requested');
}

export function resolveDecayHalfLifeDays(env: NodeJS.ProcessEnv = process.env): number {
  const rawValue = env.AI_MEMORY_DECAY_HALF_LIFE_DAYS;
  if (rawValue === undefined || rawValue.trim().length === 0) {
    return DEFAULT_DECAY_HALF_LIFE_DAYS;
  }

  const parsed = Number(rawValue);
  return normalizeHalfLifeDays(parsed, DEFAULT_DECAY_HALF_LIFE_DAYS);
}

export function resolveMemoryHalfLifeDays(input: MemoryHalfLifeInput): number {
  const tier = getCategoryTier(input.category);
  const normalizedStatus = normalizeOptionalText(input.status);

  if (normalizeOptionalText(input.category) === 'session-summary') {
    return SESSION_SUMMARY_HALF_LIFE_DAYS;
  }

  if (tier === 'actionable' && normalizedStatus === 'active') {
    return ACTIONABLE_ACTIVE_HALF_LIFE_DAYS;
  }

  return normalizeHalfLifeDays(input.defaultHalfLifeDays, DEFAULT_DECAY_HALF_LIFE_DAYS);
}

export function resolveReviewerApprovedDecisionPenalty(input: { category?: unknown; tags?: unknown }): number {
  return isReviewerApprovedDecision(input) ? REVIEWER_APPROVED_DECISION_RANKING_PENALTY : 1;
}

function computeAgeDays(createdAt: unknown, now: Date): number {
  const nowMs = now.valueOf();
  if (!Number.isFinite(nowMs)) {
    return 0;
  }

  const createdAtMs = toTimestampMs(createdAt);
  if (!Number.isFinite(createdAtMs)) {
    return 0;
  }

  return (nowMs - createdAtMs) / (1000 * 60 * 60 * 24);
}

function normalizeHalfLifeDays(value: unknown, fallback: number): number {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return fallback;
  }
  return numericValue;
}

function normalizeOptionalText(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().toLowerCase();
}

function normalizeTagSet(value: unknown): Set<string> {
  if (!Array.isArray(value)) {
    return new Set<string>();
  }

  return new Set(
    value
      .filter((item): item is string => typeof item === 'string')
      .map(item => item.trim().toLowerCase())
      .filter(item => item.length > 0),
  );
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function toTimestampMs(value: unknown): number {
  if (value instanceof Date) {
    return value.valueOf();
  }
  if (typeof value === 'string') {
    return Date.parse(value);
  }
  if (typeof value === 'number') {
    return value;
  }
  return Number.NaN;
}
