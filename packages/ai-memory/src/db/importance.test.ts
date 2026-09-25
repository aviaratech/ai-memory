import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  buildReviewerApprovedDecisionPenaltySqlExpression,
  computeInitialImportance,
  computeReadTimeDecayedImportance,
  decayedImportance,
  detectReviewerDecisionImportance,
  isReviewerApprovedDecision,
  resolveMemoryHalfLifeDays,
  resolveReviewerApprovedDecisionPenalty,
  REVIEWER_APPROVED_DECISION_RANKING_PENALTY,
  REVIEWER_DECISION_APPROVE_IMPORTANCE,
  REVIEWER_DECISION_CHANGES_REQUESTED_IMPORTANCE,
} from './importance.js';

const FIXED_NOW = new Date('2026-02-22T00:00:00.000Z');

test('decayedImportance keeps value at age 0 days', () => {
  const result = decayedImportance({
    createdAt: '2026-02-22T00:00:00.000Z',
    halfLifeDays: 90,
    importance: 0.8,
    now: FIXED_NOW,
  });
  assert.equal(result, 0.8);
});

test('decayedImportance halves at one half-life interval', () => {
  const result = decayedImportance({
    createdAt: '2025-11-24T00:00:00.000Z',
    halfLifeDays: 90,
    importance: 0.8,
    now: FIXED_NOW,
  });
  assert.ok(Math.abs(result - 0.4) < 0.005, `expected ~0.4, got ${String(result)}`);
});

test('decayedImportance decays faster with shorter half-life', () => {
  const fastDecay = decayedImportance({
    createdAt: '2026-02-08T00:00:00.000Z',
    halfLifeDays: 14,
    importance: 0.8,
    now: FIXED_NOW,
  });
  const slowDecay = decayedImportance({
    createdAt: '2026-02-08T00:00:00.000Z',
    halfLifeDays: 180,
    importance: 0.8,
    now: FIXED_NOW,
  });
  assert.ok(fastDecay < slowDecay, 'shorter half-life should decay more');
});

test('computeInitialImportance uses confidence + tier + explicit fallback formula', () => {
  const result = computeInitialImportance({
    category: 'decision',
    confidence: 0.9,
  });

  const expected = 0.9 * 0.4 + 1.0 * 0.3 + 0.5 * 0.3;
  assert.ok(Math.abs(result - expected) < 0.0001, `expected ${String(expected)}, got ${String(result)}`);
});

test('computeInitialImportance respects explicit importance signal', () => {
  const result = computeInitialImportance({
    category: 'decision',
    confidence: 0.9,
    explicitImportance: 1.0,
  });
  assert.ok(result > 0.81, 'explicit importance should raise computed score');
});

test('resolveMemoryHalfLifeDays applies session-summary and actionable-active rules', () => {
  const sessionSummaryHalfLife = resolveMemoryHalfLifeDays({
    category: 'session-summary',
    defaultHalfLifeDays: 90,
    status: 'active',
  });
  const actionableHalfLife = resolveMemoryHalfLifeDays({
    category: 'decision',
    defaultHalfLifeDays: 90,
    status: 'active',
  });
  const contextualHalfLife = resolveMemoryHalfLifeDays({
    category: 'workflow',
    defaultHalfLifeDays: 90,
    status: 'active',
  });

  assert.equal(sessionSummaryHalfLife, 14);
  assert.equal(actionableHalfLife, 180);
  assert.equal(contextualHalfLife, 90);
});

test('detectReviewerDecisionImportance returns 0.75 for approve-only reviewer decision', () => {
  const result = detectReviewerDecisionImportance({
    category: 'decision',
    source: 'claude-reviewer',
    tags: ['approved', 'epic-123', 'pr-456', 'review'],
  });
  assert.equal(result, REVIEWER_DECISION_APPROVE_IMPORTANCE);
  assert.equal(result, 0.75);
});

test('detectReviewerDecisionImportance returns 0.90 for request-changes reviewer decision', () => {
  const result = detectReviewerDecisionImportance({
    category: 'decision',
    source: 'claude-reviewer',
    tags: ['epic-123', 'pr-456', 'request-changes', 'review'],
  });
  assert.equal(result, REVIEWER_DECISION_CHANGES_REQUESTED_IMPORTANCE);
  assert.equal(result, 0.9);
});

test('detectReviewerDecisionImportance returns 0.90 for changes-requested reviewer decision', () => {
  const result = detectReviewerDecisionImportance({
    category: 'decision',
    source: 'claude-reviewer',
    tags: ['changes-requested', 'epic-123', 'pr-456', 'review'],
  });
  assert.equal(result, REVIEWER_DECISION_CHANGES_REQUESTED_IMPORTANCE);
  assert.equal(result, 0.9);
});

test('detectReviewerDecisionImportance returns undefined for non-reviewer source', () => {
  const result = detectReviewerDecisionImportance({
    category: 'decision',
    source: 'claude-code',
    tags: ['approved', 'pr-456'],
  });
  assert.equal(result, undefined);
});

test('detectReviewerDecisionImportance returns undefined for non-decision category', () => {
  const result = detectReviewerDecisionImportance({
    category: 'root-cause',
    source: 'claude-reviewer',
    tags: ['approved'],
  });
  assert.equal(result, undefined);
});

test('detectReviewerDecisionImportance returns undefined when no outcome tag present', () => {
  const result = detectReviewerDecisionImportance({
    category: 'decision',
    source: 'claude-reviewer',
    tags: ['epic-123', 'pr-456', 'review'],
  });
  assert.equal(result, undefined);
});

test('detectReviewerDecisionImportance returns undefined when tags is undefined at runtime', () => {
  const result = detectReviewerDecisionImportance({
    category: 'decision',
    source: 'claude-reviewer',
    tags: undefined as unknown as string[],
  });
  assert.equal(result, undefined);
});

test('detectReviewerDecisionImportance is case-insensitive for category and source', () => {
  const result = detectReviewerDecisionImportance({
    category: 'Decision',
    source: 'Claude-Reviewer',
    tags: ['approved'],
  });
  assert.equal(result, REVIEWER_DECISION_APPROVE_IMPORTANCE);
});

test('recall ordering: root-cause outranks approve-only reviewer decision at confidence 0.9', () => {
  const rootCauseImportance = computeInitialImportance({
    category: 'root-cause',
    confidence: 0.9,
  });
  const approveImportance = REVIEWER_DECISION_APPROVE_IMPORTANCE;

  assert.ok(
    rootCauseImportance > approveImportance,
    `root-cause (${String(rootCauseImportance)}) should outrank approve-only reviewer (${String(approveImportance)})`,
  );
});

test('recall ordering: architecture with explicit importance 0.9 outranks changes-requested reviewer decision', () => {
  // Agents writing architecture memories typically provide explicit importance >= 0.9.
  // With confidence=0.9 and explicitImportance=0.9: 0.9*0.4 + 1.0*0.3 + 0.9*0.3 = 0.36+0.3+0.27 = 0.93.
  const architectureImportance = computeInitialImportance({
    category: 'architecture',
    confidence: 0.9,
    explicitImportance: 0.9,
  });
  const changesRequestedImportance = REVIEWER_DECISION_CHANGES_REQUESTED_IMPORTANCE;

  assert.ok(
    architectureImportance > changesRequestedImportance,
    `architecture (${String(architectureImportance)}) with explicit importance should outrank changes-requested reviewer (${String(changesRequestedImportance)})`,
  );
});

test('recall ordering: changes-requested reviewer decision outranks approve-only', () => {
  // Verify the importance constants satisfy the intended ordering.
  // changes-requested carries actionable signal; approve-only is audit-level.
  assert.equal(REVIEWER_DECISION_APPROVE_IMPORTANCE, 0.75);
  assert.equal(REVIEWER_DECISION_CHANGES_REQUESTED_IMPORTANCE, 0.9);
});

test('resolveReviewerApprovedDecisionPenalty applies penalty for approved review decisions', () => {
  const penalty = resolveReviewerApprovedDecisionPenalty({
    category: 'decision',
    tags: ['review', 'approved', 'pr-123'],
  });

  assert.equal(penalty, REVIEWER_APPROVED_DECISION_RANKING_PENALTY);
  assert.equal(penalty, 0.6);
});

test('resolveReviewerApprovedDecisionPenalty does not penalize request-changes decisions', () => {
  const penalty = resolveReviewerApprovedDecisionPenalty({
    category: 'decision',
    tags: ['review', 'approved', 'request-changes'],
  });

  assert.equal(penalty, 1);
});

test('isReviewerApprovedDecision requires both review and approved tags on decision category', () => {
  assert.equal(
    isReviewerApprovedDecision({
      category: 'decision',
      tags: ['approved'],
    }),
    false,
  );

  assert.equal(
    isReviewerApprovedDecision({
      category: 'decision',
      tags: ['review', 'approved'],
    }),
    true,
  );
});

test('buildReviewerApprovedDecisionPenaltySqlExpression emits approved-review detection SQL', () => {
  const sql = buildReviewerApprovedDecisionPenaltySqlExpression();
  assert.ok(sql.includes("= 'decision'"));
  assert.ok(sql.includes("@> ARRAY['review']::text[]"));
  assert.ok(sql.includes("@> ARRAY['approved']::text[]"));
  assert.ok(sql.includes("ARRAY['request-changes', 'changes-requested']::text[]"));
});

test('computeReadTimeDecayedImportance falls back to confidence*tierWeight when importance is null', () => {
  const result = computeReadTimeDecayedImportance({
    category: 'decision',
    confidence: 0.8,
    createdAt: '2025-11-24T00:00:00.000Z',
    defaultHalfLifeDays: 90,
    importance: null,
    now: FIXED_NOW,
    status: 'active',
  });

  // Fallback base importance = 0.8 * actionable tier(1.0) = 0.8; 90-day age with 180-day half-life => sqrt(0.5).
  const expected = 0.8 * Math.pow(0.5, 90 / 180);
  assert.ok(Math.abs(result - expected) < 0.005, `expected ~${String(expected)}, got ${String(result)}`);
});

test('computeReadTimeDecayedImportance applies approved-review penalty when tags match', () => {
  const penalized = computeReadTimeDecayedImportance({
    category: 'decision',
    confidence: 0.8,
    createdAt: '2025-11-24T00:00:00.000Z',
    defaultHalfLifeDays: 90,
    importance: null,
    now: FIXED_NOW,
    status: 'active',
    tags: ['approved', 'review'],
  });
  const unpenalized = computeReadTimeDecayedImportance({
    category: 'decision',
    confidence: 0.8,
    createdAt: '2025-11-24T00:00:00.000Z',
    defaultHalfLifeDays: 90,
    importance: null,
    now: FIXED_NOW,
    status: 'active',
    tags: ['review'],
  });

  assert.ok(penalized < unpenalized, `expected penalized(${String(penalized)}) < unpenalized(${String(unpenalized)})`);
});
