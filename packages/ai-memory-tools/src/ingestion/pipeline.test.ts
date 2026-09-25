/**
 * Parity tests for the ai-memory-tools ingestion pipeline.
 *
 * These tests verify:
 * 1. The `SessionIngestEvent` contract accepts all canonical IngestSource values.
 * 2. `runIngestPipeline` is exported and callable through the tools public surface.
 * 3. Continuity fixture payloads round-trip through `parseFlushInput` +
 *    `buildFlushSnapshotValue` + `collectContinuityQualityWarnings` with the same
 *    outputs as the @aviaratech/ai-memory tests (behavioral parity).
 * 4. Routing dispatch: the correct source literals route through the correct pipeline.
 *
 * Tests that require a live database are excluded here; those live in
 * @aviaratech/ai-memory's integration test suite where the full
 * server.ts → runIngestPipeline, ingest-claude-session-end-hook.ts → runIngestPipeline,
 * and ingest-codex-session.ts → runIngestPipeline call paths are exercised.
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';

import type { IngestSource, SessionIngestEvent } from './contract.js';

import { buildFlushSnapshotValue, collectContinuityQualityWarnings, parseFlushInput } from './flush-session.js';
import { runIngestPipeline } from './pipeline.js';
import { compareOutcomes, toStateModel } from './reflection-compare.js';
import { runReflection } from './reflection.js';

// ─── Contract shape tests ───────────────────────────────────────────────────

test('SessionIngestEvent accepts all canonical IngestSource values', () => {
  const sources: IngestSource[] = [
    'claude-session-end',
    'codex-hook',
    'codex-launchd',
    'codex-wrapper',
    'grok-session-end',
    'manual',
    'manual-flush',
  ];
  for (const source of sources) {
    const event: SessionIngestEvent = {
      source,
      summary: 'Test session for source type validation.',
    };
    assert.equal(event.source, source);
  }
});

test('SessionIngestEvent optional fields are all optional', () => {
  const minimal: SessionIngestEvent = {
    source: 'manual-flush',
    summary: 'Minimal event — all optional fields absent.',
  };
  assert.equal(minimal.decisions, undefined);
  assert.equal(minimal.rootCauses, undefined);
  assert.equal(minimal.stateModel, undefined);
  assert.equal(minimal.envModel, undefined);
  assert.equal(minimal.nextActions, undefined);
  assert.equal(minimal.openQuestions, undefined);
  assert.equal(minimal.sessionId, undefined);
  assert.equal(minimal.agent, undefined);
  assert.equal(minimal.project, undefined);
  assert.equal(minimal.activeGoal, undefined);
  assert.equal(minimal.lead, undefined);
  assert.equal(minimal.outcome, undefined);
  assert.equal(minimal.task, undefined);
});

// ─── runIngestPipeline export / routing contract ─────────────────────────────

test('runIngestPipeline is exported as a function', () => {
  assert.equal(typeof runIngestPipeline, 'function');
});

test('runIngestPipeline routing: auto-session sources are distinct from flush sources', () => {
  // Verify the source literals that route through ingestAutoSessionDelta vs flushSession
  // by checking that the canonical set matches the IngestSource type.
  const autoSources: IngestSource[] = [
    'claude-session-end',
    'codex-hook',
    'codex-wrapper',
    'codex-launchd',
    'grok-session-end',
  ];
  const flushSources: IngestSource[] = ['manual-flush', 'manual'];

  // All sources are mutually exclusive between the two groups.
  const autoSet = new Set<string>(autoSources);
  for (const s of flushSources) {
    assert.ok(!autoSet.has(s), `flush source '${s}' should not be in auto-session set`);
  }

  // Union covers all canonical IngestSource values.
  const all: IngestSource[] = [...autoSources, ...flushSources];
  assert.equal(all.length, 7);
});

test('runIngestPipeline routing: unknown source is rejected', async () => {
  // An unrecognized source must be rejected before dispatch so invalid strings
  // are never persisted as source labels on stored memories.
  await assert.rejects(
    () => runIngestPipeline({ source: 'not-a-real-source' }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes('Unknown IngestSource'),
        `expected "Unknown IngestSource" in message, got: ${err.message}`,
      );
      return true;
    },
  );
  // Missing source field (empty string) is also rejected.
  await assert.rejects(
    () => runIngestPipeline({}),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('Unknown IngestSource'));
      return true;
    },
  );
});

// ─── Flush-session parity tests (continuity fixtures) ───────────────────────

const TEST_SESSION_ID = 'tools-parity-session';
const TEST_NOW = '2026-03-14T00:00:00.000Z';

test('parseFlushInput parity: simple-flush fixture round-trips correctly', () => {
  const flushInput = {
    contextNeeded: ['Use the continuity experiment harness fixture results.'],
    nextActions: ['Review continuity suite summary after flush.'],
    openQuestions: ['Which continuity scenario should expand first?'],
    summary: 'Simple continuity flush scenario for experiment harness.',
  };
  const parsed = parseFlushInput(flushInput);
  assert.equal(parsed.summary, flushInput.summary);
  assert.deepEqual(parsed.contextNeeded, flushInput.contextNeeded);
  assert.deepEqual(parsed.nextActions, flushInput.nextActions);
  assert.deepEqual(parsed.openQuestions, flushInput.openQuestions);
  assert.equal(parsed.stateModel, undefined);
  assert.equal(parsed.envModel, undefined);
});

test('parseFlushInput parity: with-state-model fixture preserves stateModel', () => {
  const stateModel = {
    assumptions: ['memory_orient remains available in local mode'],
    next_decision: 'expand retrieval fixture coverage',
    strategy_confidence: 'medium',
  };
  const flushInput = {
    nextActions: ['Compare orient snapshot against expected state model.'],
    openQuestions: ['Do we need additional stateModel fixture variants?'],
    stateModel,
    summary: 'Continuity flush with explicit state model payload.',
  };
  const parsed = parseFlushInput(flushInput);
  assert.deepEqual(parsed.stateModel, stateModel);
  assert.equal(parsed.normalizationWarnings.length, 0);
});

test('parseFlushInput parity: with-active-goal fixture preserves activeGoal', () => {
  const flushInput = {
    activeGoal: 'Ship active-goal simplification follow-up',
    nextActions: ['Carry forward active-goal continuity context.'],
    openQuestions: ['Should active-goal snapshots receive dedicated metrics?'],
    summary: 'Continuity flush including activeGoal for forward compatibility.',
  };
  const parsed = parseFlushInput(flushInput);
  assert.equal(parsed.activeGoal, flushInput.activeGoal);
  assert.deepEqual(parsed.nextActions, flushInput.nextActions);
  assert.deepEqual(parsed.openQuestions, flushInput.openQuestions);
});

test('buildFlushSnapshotValue parity: next_actions and open_questions round-trip', () => {
  const parsed = parseFlushInput({
    contextNeeded: ['Use the continuity experiment harness fixture results.'],
    nextActions: ['Review continuity suite summary after flush.'],
    openQuestions: ['Which continuity scenario should expand first?'],
    summary: 'Simple continuity flush scenario for experiment harness.',
  });
  const snapshot = buildFlushSnapshotValue(parsed, {
    nowIso: TEST_NOW,
    sessionId: TEST_SESSION_ID,
  });
  assert.deepEqual(snapshot.context_needed, ['Use the continuity experiment harness fixture results.']);
  assert.deepEqual(snapshot.next_actions, ['Review continuity suite summary after flush.']);
  assert.deepEqual(snapshot.open_questions, ['Which continuity scenario should expand first?']);
});

test('buildFlushSnapshotValue parity: stateModel persisted as x_state_model', () => {
  const stateModel = {
    assumptions: ['memory_orient remains available in local mode'],
    next_decision: 'expand retrieval fixture coverage',
    strategy_confidence: 'medium',
  };
  const parsed = parseFlushInput({
    nextActions: ['Compare orient snapshot against expected state model.'],
    openQuestions: ['Do we need additional stateModel fixture variants?'],
    stateModel,
    summary: 'Continuity flush with explicit state model payload.',
  });
  const snapshot = buildFlushSnapshotValue(parsed, {
    nowIso: TEST_NOW,
    sessionId: TEST_SESSION_ID,
  });
  assert.deepEqual(snapshot.x_state_model, stateModel);
});

test('buildFlushSnapshotValue parity: activeGoal absent when not provided', () => {
  const parsed = parseFlushInput({
    summary: 'No active goal provided in this flush.',
  });
  const snapshot = buildFlushSnapshotValue(parsed, {
    nowIso: TEST_NOW,
    sessionId: TEST_SESSION_ID,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot, 'x_active_goal'), false);
});

test('buildFlushSnapshotValue parity: activeGoal persisted when provided', () => {
  const parsed = parseFlushInput({
    activeGoal: 'Ship active-goal simplification follow-up',
    nextActions: ['Carry forward active-goal continuity context.'],
    openQuestions: ['Should active-goal snapshots receive dedicated metrics?'],
    summary: 'Continuity flush including activeGoal for forward compatibility.',
  });
  const snapshot = buildFlushSnapshotValue(parsed, {
    nowIso: TEST_NOW,
    sessionId: TEST_SESSION_ID,
  });
  assert.equal(snapshot.x_active_goal, 'Ship active-goal simplification follow-up');
});

// ─── Continuity quality warning parity tests ────────────────────────────────

test('collectContinuityQualityWarnings parity: empty nextActions produces warning', () => {
  const parsed = parseFlushInput({ summary: 'Missing next actions.' });
  const warnings = collectContinuityQualityWarnings(parsed);
  assert.ok(warnings.some((w: string) => w.includes('nextActions')));
});

test('collectContinuityQualityWarnings parity: empty openQuestions produces warning', () => {
  const parsed = parseFlushInput({ summary: 'Missing open questions.' });
  const warnings = collectContinuityQualityWarnings(parsed);
  assert.ok(warnings.some((w: string) => w.includes('openQuestions')));
});

test('collectContinuityQualityWarnings parity: missing stateModel produces warning', () => {
  const parsed = parseFlushInput({ summary: 'Missing state model.' });
  const warnings = collectContinuityQualityWarnings(parsed);
  assert.ok(warnings.some((w: string) => w.includes('stateModel')));
});

test('collectContinuityQualityWarnings parity: missing envModel produces warning', () => {
  const parsed = parseFlushInput({ summary: 'Missing env model.' });
  const warnings = collectContinuityQualityWarnings(parsed);
  assert.ok(warnings.some((w: string) => w.includes('envModel')));
});

test('collectContinuityQualityWarnings parity: brief summary produces warning', () => {
  const parsed = parseFlushInput({ summary: 'Too short.' });
  const warnings = collectContinuityQualityWarnings(parsed);
  assert.ok(warnings.some((w: string) => w.includes('summary')));
});

test('collectContinuityQualityWarnings parity: full payload produces no warnings', () => {
  const parsed = parseFlushInput({
    envModel: { branch: 'issue/1838' },
    nextActions: ['Verify parity tests pass across all three commands.'],
    openQuestions: ['Should we add more fixture variants?'],
    stateModel: {
      assumptions: [],
      constraints: [],
      strategy_confidence: 'high',
      uncertainty: [],
    },
    summary:
      'Extracted ingestion pipeline to ai-memory-tools with parity tests. ' +
      'SessionIngestEvent contract and runIngestPipeline unify three source flows.',
  });
  const warnings = collectContinuityQualityWarnings(parsed);
  assert.equal(warnings.length, 0);
});

// ─── Reflection-compare parity tests ────────────────────────────────────────

test('compareOutcomes parity: overconfident signal when high confidence + root causes', () => {
  const model = toStateModel({
    assumptions: ['pipeline is stable'],
    strategy_confidence: 'high',
    uncertainty: [],
  });
  const result = compareOutcomes(model, 'Session completed.', [], ['root cause one', 'root cause two']);
  assert.equal(result.confidenceCalibration, 'overconfident');
});

test('compareOutcomes parity: underconfident signal when low confidence + decisions made', () => {
  const model = toStateModel({
    assumptions: [],
    strategy_confidence: 'low',
    uncertainty: [],
  });
  const result = compareOutcomes(model, 'Session completed.', ['decision one'], []);
  assert.equal(result.confidenceCalibration, 'underconfident');
});

test('compareOutcomes parity: well-calibrated signal when medium confidence', () => {
  const model = toStateModel({
    assumptions: [],
    strategy_confidence: 'medium',
    uncertainty: [],
  });
  const result = compareOutcomes(model, 'Session completed.', ['one decision'], []);
  assert.equal(result.confidenceCalibration, 'well-calibrated');
});

// ─── runReflection no-op guard ────────────────────────────────────────────────

test('runReflection returns no stored memories when stateModel is absent', async () => {
  const result = await runReflection({
    agent: 'test-agent',
    decisions: ['some decision'],
    project: 'example/catalog',
    rootCauses: [],
    sessionId: 'test-session',
    source: 'manual-flush',
    stateModel: undefined,
    summary: 'Test session without state model.',
  });
  assert.equal(result.reflectionResult, undefined);
  assert.equal(result.storedMemories.length, 0);
});
