import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  getAllKnownCategories,
  getCategoryTier,
  getCategoryWeight,
  getStatusWeight,
  getTierSortPriority,
  TAXONOMY_TIERS,
} from './taxonomy.js';

const IMPLEMENTATION_NOTE = 'implementation-note';
const SESSION_SUMMARY = 'session-summary';

test('getCategoryTier returns actionable for known actionable categories', () => {
  for (const category of TAXONOMY_TIERS.actionable.categories) {
    assert.equal(getCategoryTier(category), 'actionable', `expected ${category} to be actionable`);
  }
});

test('getCategoryTier returns contextual for known contextual categories', () => {
  for (const category of TAXONOMY_TIERS.contextual.categories) {
    assert.equal(getCategoryTier(category), 'contextual', `expected ${category} to be contextual`);
  }
});

test('getCategoryTier returns low-signal for known low-signal categories', () => {
  for (const category of TAXONOMY_TIERS['low-signal'].categories) {
    assert.equal(getCategoryTier(category), 'low-signal', `expected ${category} to be low-signal`);
  }
});

test('getCategoryTier defaults to contextual for unknown categories', () => {
  assert.equal(getCategoryTier('unknown-category'), 'contextual');
  assert.equal(getCategoryTier('misc'), 'contextual');
});

test('getCategoryTier defaults to contextual for null/undefined/empty', () => {
  assert.equal(getCategoryTier(null), 'contextual');
  assert.equal(getCategoryTier(undefined), 'contextual');
  assert.equal(getCategoryTier(''), 'contextual');
});

test('getCategoryTier is case-insensitive', () => {
  assert.equal(getCategoryTier('Architecture'), 'actionable');
  assert.equal(getCategoryTier('SESSION-SUMMARY'), 'low-signal');
  assert.equal(getCategoryTier('Convention'), 'actionable');
});

test('getCategoryWeight returns 1.0 for actionable categories', () => {
  assert.equal(getCategoryWeight('architecture'), 1.0);
  assert.equal(getCategoryWeight('convention'), 1.0);
  assert.equal(getCategoryWeight('decision'), 1.0);
  assert.equal(getCategoryWeight('root-cause'), 1.0);
});

test('getCategoryWeight returns 0.5 for contextual categories', () => {
  assert.equal(getCategoryWeight(IMPLEMENTATION_NOTE), 0.5);
  assert.equal(getCategoryWeight('workflow'), 0.5);
});

test('getCategoryWeight returns 0.0 for low-signal categories', () => {
  assert.equal(getCategoryWeight(SESSION_SUMMARY), 0.0);
  assert.equal(getCategoryWeight('audit-log'), 0.0);
  assert.equal(getCategoryWeight('checkpoint'), 0.0);
});

test('getCategoryWeight returns default (0.5) for unknown categories', () => {
  assert.equal(getCategoryWeight('something-else'), 0.5);
  assert.equal(getCategoryWeight(null), 0.5);
});

test('getTierSortPriority returns correct ordering', () => {
  assert.equal(getTierSortPriority('convention'), 0);
  assert.equal(getTierSortPriority(IMPLEMENTATION_NOTE), 1);
  assert.equal(getTierSortPriority(SESSION_SUMMARY), 2);
  assert.ok(getTierSortPriority('convention') < getTierSortPriority(SESSION_SUMMARY));
});

test('getAllKnownCategories includes all tier categories', () => {
  const all = getAllKnownCategories();
  assert.ok(all.includes('architecture'));
  assert.ok(all.includes('convention'));
  assert.ok(all.includes(SESSION_SUMMARY));
  assert.ok(all.includes(IMPLEMENTATION_NOTE));
  assert.ok(all.includes('audit-log'));
  assert.ok(all.includes('checkpoint'));
});

test('taxonomy tiers have no duplicate categories', () => {
  const seen = new Set<string>();
  for (const tier of Object.values(TAXONOMY_TIERS)) {
    for (const category of tier.categories) {
      assert.ok(!seen.has(category), `duplicate category: ${category}`);
      seen.add(category);
    }
  }
});

test('taxonomy tier weights are ordered highest to lowest', () => {
  assert.ok(TAXONOMY_TIERS.actionable.weight > TAXONOMY_TIERS.contextual.weight);
  assert.ok(TAXONOMY_TIERS.contextual.weight > TAXONOMY_TIERS['low-signal'].weight);
});

test('getStatusWeight returns 0.5 for contested status', () => {
  assert.equal(getStatusWeight('contested'), 0.5);
});

test('getStatusWeight returns 1.0 for active status', () => {
  assert.equal(getStatusWeight('active'), 1.0);
});

test('getStatusWeight returns 1.0 for unknown/null/undefined status', () => {
  assert.equal(getStatusWeight('superseded'), 1.0);
  assert.equal(getStatusWeight(null), 1.0);
  assert.equal(getStatusWeight(undefined), 1.0);
  assert.equal(getStatusWeight(''), 1.0);
});

test('getCategoryTier returns actionable for methodology', () => {
  assert.equal(getCategoryTier('methodology'), 'actionable');
});

test('getCategoryWeight returns 1.0 for methodology', () => {
  assert.equal(getCategoryWeight('methodology'), 1.0);
});

test('getTierSortPriority returns 0 for methodology', () => {
  assert.equal(getTierSortPriority('methodology'), 0);
});

test('getAllKnownCategories includes methodology', () => {
  const all = getAllKnownCategories();
  assert.ok(all.includes('methodology'));
});
