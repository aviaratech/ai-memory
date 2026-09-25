/**
 * Memory taxonomy — classifies memory categories by intent tier
 * and provides query-time weight signals for recall/search ranking.
 *
 * Tiers (highest → lowest priority):
 *   actionable  — guidance agents act on (conventions, decisions, architecture)
 *   contextual  — useful background (implementation notes, workflow)
 *   low-signal  — audit/ephemeral (session summaries, checkpoints, audit logs)
 *
 * Query-time weighting uses these tiers to boost actionable guidance
 * above low-signal audit history in recall and search results.
 */

export type TaxonomyTier = 'actionable' | 'contextual' | 'low-signal';

interface TierDefinition {
  readonly categories: readonly string[];
  readonly description: string;
  readonly weight: number;
}

/**
 * Canonical tier definitions with associated category lists and weights.
 * Weights are used as a signal component in hybrid search reranking
 * and as a sort key in recall ordering.
 */
export const TAXONOMY_TIERS: Readonly<Record<TaxonomyTier, TierDefinition>> = {
  actionable: {
    categories: ['architecture', 'bugfix', 'convention', 'decision', 'methodology', 'preference', 'root-cause'],
    description: 'Guidance agents act on: conventions, architecture decisions, root causes, preferences.',
    weight: 1.0,
  },
  contextual: {
    categories: ['implementation-note', 'workflow'],
    description: 'Useful background context: implementation notes, workflow details.',
    weight: 0.5,
  },
  'low-signal': {
    categories: ['audit-log', 'checkpoint', 'session-summary'],
    description: 'Ephemeral or audit-trail entries: session summaries, checkpoints, audit logs.',
    weight: 0.0,
  },
};

const categoryToTierMap = new Map<string, TaxonomyTier>();
for (const [tier, definition] of Object.entries(TAXONOMY_TIERS) as [TaxonomyTier, TierDefinition][]) {
  for (const category of definition.categories) {
    categoryToTierMap.set(category, tier);
  }
}

const DEFAULT_TIER: TaxonomyTier = 'contextual';
const DEFAULT_WEIGHT = TAXONOMY_TIERS[DEFAULT_TIER].weight;

export function getAllKnownCategories(): readonly string[] {
  return Object.values(TAXONOMY_TIERS).flatMap(tier => tier.categories);
}

export function getCategoryTier(category: unknown): TaxonomyTier {
  if (typeof category !== 'string' || category.length === 0) {
    return DEFAULT_TIER;
  }
  return categoryToTierMap.get(category.toLowerCase()) ?? DEFAULT_TIER;
}

export function getCategoryWeight(category: unknown): number {
  if (typeof category !== 'string' || category.length === 0) {
    return DEFAULT_WEIGHT;
  }
  const tier = categoryToTierMap.get(category.toLowerCase());
  if (tier === undefined) {
    return DEFAULT_WEIGHT;
  }
  return TAXONOMY_TIERS[tier].weight;
}

/**
 * Returns a multiplier applied to hybrid search relevance based on memory status.
 * Contested memories are surfaced but with reduced weight to signal lower confidence.
 */
export function getStatusWeight(status: unknown): number {
  if (status === 'contested') {
    return 0.5;
  }
  return 1.0;
}

export function getTierSortPriority(category: unknown): number {
  const tier = getCategoryTier(category);
  if (tier === 'actionable') {
    return 0;
  }
  if (tier === 'contextual') {
    return 1;
  }
  return 2;
}
