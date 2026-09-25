import assert from 'node:assert/strict';
import { test } from 'vitest';

import { buildRecallTierOrderSql } from './memory-api.js';
import { getAllKnownCategories, getCategoryTier, getTierSortPriority, TAXONOMY_TIERS } from './taxonomy.js';

test('buildRecallTierOrderSql includes all actionable categories', () => {
  const sql = buildRecallTierOrderSql();
  for (const category of TAXONOMY_TIERS.actionable.categories) {
    assert.ok(sql.includes(`'${category}'`), `expected actionable category '${category}' in SQL`);
  }
});

test('buildRecallTierOrderSql includes all low-signal categories', () => {
  const sql = buildRecallTierOrderSql();
  for (const category of TAXONOMY_TIERS['low-signal'].categories) {
    assert.ok(sql.includes(`'${category}'`), `expected low-signal category '${category}' in SQL`);
  }
});

test('buildRecallTierOrderSql maps actionable to 0, low-signal to 2, else to 1', () => {
  const sql = buildRecallTierOrderSql();
  assert.ok(sql.includes('THEN 0'), 'expected actionable tier mapped to 0');
  assert.ok(sql.includes('THEN 2'), 'expected low-signal tier mapped to 2');
  assert.ok(sql.includes('ELSE 1'), 'expected unknown/contextual fallback mapped to 1');
});

test('recall tier SQL values are consistent with getTierSortPriority for all known categories', () => {
  for (const category of getAllKnownCategories()) {
    const tier = getCategoryTier(category);
    const priority = getTierSortPriority(category);

    if (tier === 'actionable') {
      assert.equal(priority, 0, `expected actionable category '${category}' to have priority 0`);
    } else if (tier === 'low-signal') {
      assert.equal(priority, 2, `expected low-signal category '${category}' to have priority 2`);
    } else {
      assert.equal(priority, 1, `expected contextual category '${category}' to have priority 1`);
    }
  }
});

test('unknown categories default to contextual (priority 1) in taxonomy', () => {
  assert.equal(getTierSortPriority('unknown-category'), 1);
  assert.equal(getTierSortPriority('misc'), 1);
  assert.equal(getTierSortPriority(''), 1);
  assert.equal(getTierSortPriority(null), 1);
});

test('recall SQL uses ELSE 1 so unknown categories are contextual, not low-signal', () => {
  const sql = buildRecallTierOrderSql();
  // Unknown categories should NOT be pushed to low-signal (ELSE 2)
  assert.ok(!sql.includes('ELSE 2'), 'ELSE 2 would incorrectly demote unknown categories to low-signal');
  assert.ok(sql.includes('ELSE 1'), 'unknown categories should default to contextual (1)');
});
