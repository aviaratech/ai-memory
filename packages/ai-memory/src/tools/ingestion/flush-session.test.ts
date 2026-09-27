import {
  assertValidMemoryDelta,
  isRecord,
  STRATEGY_CONFIDENCE_VALUES,
  toSessionSnapshotRecord,
} from '@aviaratech/ai-memory/internal';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import { buildFlushSnapshotValue, collectContinuityQualityWarnings, parseFlushInput } from './flush-session.js';
import { buildFlushDeltaPayload } from './flush-session-core-builders.js';
import { buildScopedContinuityPacksFromFlush } from './continuity-pack.js';

const TEST_NOW = '2026-02-22T00:00:00.000Z';
const TEST_SESSION_ID = 'session-1352';
const MEMORY_FLUSH_AGENT = 'memory-flush';

test('verified basename flush writes the canonical repository and retains exact task and host identity', () => {
  const parsed = parseFlushInput({
    project: 'catalog',
    repoSlug: 'example/catalog',
    sessionId: 'producer-session',
    summary: 'Preserve the current operator decision and pending work across harness reconnects.',
    task: 'logical-task',
  });
  assert.equal(parsed.project, 'example/catalog');
  const payload = buildFlushDeltaPayload({
    buildFlushSnapshotValue,
    nowIso: TEST_NOW,
    parsed,
    sessionId: 'producer-session',
  });
  assertValidMemoryDelta(payload.memoryDelta);
  assert.ok(isRecord(payload.memoryDelta));
  assert.deepEqual(payload.memoryDelta.tenancy, { repo_id: 'example/catalog' });
  const packs = buildScopedContinuityPacksFromFlush({
    nowIso: TEST_NOW,
    parsed,
    reflectionCount: 0,
    sessionId: 'producer-session',
  });
  assert.deepEqual(
    packs.map(pack => pack.scopeKey),
    ['project:example/catalog', 'task:example/catalog:logical-task'],
  );
  assert.equal(packs[1]?.pack.provenance.sessionId, 'producer-session');
});

test('parseFlushInput extracts stateModel and envModel objects', () => {
  const stateModel = {
    assumptions: ['pipeline health is stable'],
    strategy_confidence: 'medium',
  };
  const envModel = {
    branch: 'issue-1352',
    workspace_dirty: true,
  };

  const parsed = parseFlushInput({
    envModel,
    stateModel,
    summary: 'Added state/env model handling.',
  });

  assert.deepEqual(parsed.stateModel, stateModel);
  assert.deepEqual(parsed.envModel, envModel);
  assert.equal(parsed.activeGoal, undefined);
});

test('parseFlushInput returns undefined models when stateModel and envModel are not provided', () => {
  const parsed = parseFlushInput({
    summary: 'No models provided for this flush.',
  });

  assert.equal(parsed.stateModel, undefined);
  assert.equal(parsed.envModel, undefined);
});

test('parseFlushInput extracts contextNeeded for explicit flush handoffs', () => {
  const contextNeeded = ['Confirm whether Claude Desktop was reloaded after plugin refresh.'];
  const parsed = parseFlushInput({
    contextNeeded,
    summary: 'Persisting context needed for the next session.',
  });

  assert.deepEqual(parsed.contextNeeded, contextNeeded);
});

test('buildFlushSnapshotValue includes x_state_model when stateModel is provided', () => {
  const parsed = parseFlushInput({
    stateModel: {
      assumptions: ['patch materialization is available'],
      strategy_confidence: 'high',
    },
    summary: 'Persisting state model.',
  });

  const snapshotValue = buildFlushSnapshotValue(parsed, {
    nowIso: TEST_NOW,
    sessionId: TEST_SESSION_ID,
  });
  assert.ok('x_state_model' in snapshotValue, 'snapshot value should include x_state_model');
});

test('buildFlushSnapshotValue includes x_active_goal when activeGoal is provided', () => {
  const parsed = parseFlushInput({
    activeGoal: 'Ship active-goal simplification',
    summary: 'Persisting flush linked to active goal.',
  });

  const snapshotValue = buildFlushSnapshotValue(parsed, {
    nowIso: TEST_NOW,
    sessionId: TEST_SESSION_ID,
  });
  assert.equal(snapshotValue.x_active_goal, 'Ship active-goal simplification');
});

test('buildFlushSnapshotValue omits x_state_model when stateModel is undefined', () => {
  const parsed = parseFlushInput({
    summary: 'Persisting flush without state model.',
  });

  const snapshotValue = buildFlushSnapshotValue(parsed, {
    nowIso: TEST_NOW,
    sessionId: TEST_SESSION_ID,
  });
  assert.equal('x_state_model' in snapshotValue, false);
});

test('buildFlushSnapshotValue includes required replace-snapshot fields', () => {
  const parsed = parseFlushInput({
    summary: 'Persisting flush snapshot defaults.',
  });

  const snapshotValue = buildFlushSnapshotValue(parsed, {
    nowIso: TEST_NOW,
    sessionId: TEST_SESSION_ID,
  });
  assert.deepEqual(snapshotValue.anchors, {
    focus_paths: [],
    related_links: [],
  });
  assert.deepEqual(snapshotValue.context_needed, []);
  assert.deepEqual(snapshotValue.plan, []);
  assert.deepEqual(snapshotValue.progress, {
    blockers: [],
    completed: [],
    in_flight: [],
  });
});

test('buildFlushSnapshotValue includes context_needed when explicit flush provides contextNeeded', () => {
  const parsed = parseFlushInput({
    contextNeeded: ['Wait for ai-reviewer approval before merging.'],
    summary: 'Persisting explicit context-needed handoff.',
  });

  const snapshotValue = buildFlushSnapshotValue(parsed, {
    nowIso: TEST_NOW,
    sessionId: TEST_SESSION_ID,
  });
  assert.deepEqual(snapshotValue.context_needed, ['Wait for ai-reviewer approval before merging.']);
});

test('flush snapshot with both models round-trips through session resume snapshot serialization', () => {
  const stateModel = {
    constraints: ['must keep read path unchanged'],
    next_decision: 'phase-3 protocol doc scope',
    strategy_confidence: 'medium',
    uncertainty: ['production warning taxonomy still emerging'],
  };
  const envModel = {
    blocked_by: [],
    branch: 'issue-1352',
    failing_checks: [],
    open_prs: [{ number: 1352, title: 'State model + env model snapshot extensions' }],
    tooling_available: ['memory_flush', 'memory_session_resume'],
    uncommitted_files: 0,
    workspace_dirty: false,
  };

  const parsed = parseFlushInput({
    contextNeeded: ['Operator has refreshed and reloaded the plugin runtime.'],
    envModel,
    stateModel,
    summary: 'Persisting both operational consciousness models.',
  });

  const snapshotValue = buildFlushSnapshotValue(parsed, {
    nowIso: TEST_NOW,
    sessionId: TEST_SESSION_ID,
  });
  const resumedSnapshot = toSessionSnapshotRecord({
    created_at: TEST_NOW,
    id: 1,
    schema_version: 'session_snapshot@0.1',
    session_id: TEST_SESSION_ID,
    snapshot_id: 'resume-snapshot-1352',
    snapshot_json: snapshotValue,
    source_delta_id: `${MEMORY_FLUSH_AGENT}-${TEST_SESSION_ID}`,
  });

  const snapshotJson = resumedSnapshot.snapshotJson as Record<string, unknown>;
  assert.deepEqual(snapshotJson.context_needed, ['Operator has refreshed and reloaded the plugin runtime.']);
  assert.deepEqual(snapshotJson.x_state_model, stateModel);
  assert.deepEqual(snapshotJson.x_env_model, envModel);
});

test('flush snapshot round-trips x_active_goal when activeGoal is present', () => {
  const parsed = parseFlushInput({
    activeGoal: 'Preserve active goal continuity',
    summary: 'Persisting active goal linkage.',
  });

  const snapshotValue = buildFlushSnapshotValue(parsed, {
    nowIso: TEST_NOW,
    sessionId: TEST_SESSION_ID,
  });
  const resumedSnapshot = toSessionSnapshotRecord({
    created_at: TEST_NOW,
    id: 2,
    schema_version: 'session_snapshot@0.1',
    session_id: TEST_SESSION_ID,
    snapshot_id: 'resume-snapshot-goal',
    snapshot_json: snapshotValue,
    source_delta_id: `${MEMORY_FLUSH_AGENT}-${TEST_SESSION_ID}`,
  });

  const snapshotJson = resumedSnapshot.snapshotJson as Record<string, unknown>;
  assert.equal(snapshotJson.x_active_goal, 'Preserve active goal continuity');
});

test('memory_flush replace snapshot accepts x_ extension fields in memory_delta schema validation', () => {
  const parsed = parseFlushInput({
    activeGoal: 'Validate schema with active goal extensions',
    envModel: {
      blocked_by: [],
      branch: 'issue/1378',
      failing_checks: [],
      open_prs: [{ number: 1378, title: 'Fix replace snapshot validation' }],
      uncommitted_files: 0,
      workspace_dirty: false,
    },
    stateModel: {
      assumptions: ['replace mode should accept x_ extensions'],
      strategy_confidence: 'high',
      uncertainty: [],
    },
    summary: 'Schema validation for memory_flush replace payload with extension fields.',
  });
  const snapshotValue = buildFlushSnapshotValue(parsed, {
    nowIso: TEST_NOW,
    sessionId: TEST_SESSION_ID,
  });

  assert.doesNotThrow(() => {
    assertValidMemoryDelta({
      append_events: [
        {
          summary: 'memory_flush: Schema validation for memory_flush replace payload with extension fields.',
          ts: TEST_NOW,
          type: 'checkpoint',
        },
      ],
      artifacts: [],
      created_at: TEST_NOW,
      delta_id: `${MEMORY_FLUSH_AGENT}-${TEST_SESSION_ID}`,
      produced_by: { agent: MEMORY_FLUSH_AGENT },
      schema_version: 'memory_delta@0.1',
      session_id: TEST_SESSION_ID,
      snapshot: {
        mode: 'replace',
        value: snapshotValue,
      },
      tenancy: {},
      workflow: {
        entity_id: TEST_SESSION_ID,
        entity_type: 'agent_session',
        system: MEMORY_FLUSH_AGENT,
        title: 'Pre-compaction flush',
      },
    });
  }, 'memory_flush replace snapshot with x_ fields should pass memory_delta schema validation');
});

test('memory_flush replace snapshot rejects malformed core fields even with x_ extension fields', () => {
  const parsed = parseFlushInput({
    envModel: { branch: 'issue/1378', workspace_dirty: false },
    stateModel: { strategy_confidence: 'medium' },
    summary: 'Malformed replace payload should still fail strict validation.',
  });
  const snapshotValue = buildFlushSnapshotValue(parsed, {
    nowIso: TEST_NOW,
    sessionId: TEST_SESSION_ID,
  });

  delete snapshotValue.anchors;
  delete snapshotValue.plan;
  delete snapshotValue.progress;

  assert.throws(
    () => {
      assertValidMemoryDelta({
        append_events: [
          {
            summary: 'memory_flush: malformed replace payload validation check.',
            ts: TEST_NOW,
            type: 'checkpoint',
          },
        ],
        artifacts: [],
        created_at: TEST_NOW,
        delta_id: `${TEST_SESSION_ID}-malformed`,
        produced_by: { agent: MEMORY_FLUSH_AGENT },
        schema_version: 'memory_delta@0.1',
        session_id: TEST_SESSION_ID,
        snapshot: {
          mode: 'replace',
          value: snapshotValue,
        },
        tenancy: {},
      });
    },
    /required property 'plan'|required property 'progress'|required property 'anchors'/u,
    'replace snapshots must still enforce required core fields',
  );
});

// --- strategy_confidence normalization ---

test('parseFlushInput normalizes missing strategy_confidence to "medium" and emits a warning', () => {
  const parsed = parseFlushInput({
    stateModel: { assumptions: ['pipeline health is stable'] },
    summary: 'No confidence provided.',
  });

  assert.equal(
    parsed.stateModel?.strategy_confidence,
    'medium',
    'strategy_confidence should be normalized to "medium"',
  );
  assert.ok(
    parsed.normalizationWarnings.some(w => w.includes('strategy_confidence was missing')),
    'should emit a normalization warning for missing strategy_confidence',
  );
});

test('parseFlushInput normalizes invalid strategy_confidence to "medium" and emits a warning', () => {
  const parsed = parseFlushInput({
    stateModel: {
      assumptions: ['assumption a'],
      strategy_confidence: 'very_high',
    },
    summary: 'Invalid confidence value.',
  });

  assert.equal(
    parsed.stateModel?.strategy_confidence,
    'medium',
    'invalid strategy_confidence should be normalized to "medium"',
  );
  assert.ok(
    parsed.normalizationWarnings.some(w => w.includes('had invalid value')),
    'should emit a normalization warning describing the original invalid value',
  );
});

test('parseFlushInput does not normalize valid strategy_confidence and emits no warning', () => {
  for (const value of STRATEGY_CONFIDENCE_VALUES) {
    const parsed = parseFlushInput({
      stateModel: { strategy_confidence: value },
      summary: 'Valid confidence value.',
    });

    assert.equal(
      parsed.stateModel?.strategy_confidence,
      value,
      `strategy_confidence "${value}" should remain unchanged`,
    );
    assert.equal(parsed.normalizationWarnings.length, 0, 'no normalization warning for valid confidence');
  }
});

test('parseFlushInput normalizes near-miss confidence_history values', () => {
  const parsed = parseFlushInput({
    stateModel: {
      confidence_history: [
        { reason: 'initial', value: 'medium-high' },
        { reason: 'adjusted', value: 'low' },
      ],
      strategy_confidence: 'high',
    },
    summary: 'Near-miss confidence_history value.',
  });

  if (parsed.stateModel === undefined) {
    assert.fail('expected stateModel');
  }
  const history = parsed.stateModel.confidence_history as { reason: string; value: string }[];
  if (history[0] === undefined || history[1] === undefined) {
    assert.fail('expected confidence_history entries');
  }
  assert.equal(history[0].value, 'medium', '"medium-high" should normalize to "medium" (earliest match)');
  assert.equal(history[1].value, 'low', 'valid value should remain unchanged');
  assert.ok(
    parsed.normalizationWarnings.some(w => w.includes('confidence_history[0]') && w.includes('medium-high')),
    'should emit a normalization warning for the near-miss value',
  );
});

test('parseFlushInput rejects fully invalid confidence_history values with descriptive error', () => {
  assert.throws(
    () =>
      parseFlushInput({
        stateModel: {
          confidence_history: [{ reason: 'bad', value: 'very_confident' }],
          strategy_confidence: 'high',
        },
        summary: 'Invalid confidence_history value.',
      }),
    (error: Error) => {
      assert.ok(error.message.includes('very_confident'), 'error should mention the invalid value');
      assert.ok(error.message.includes('high, medium, low'), 'error should list valid values');
      return true;
    },
  );
});

test('parseFlushInput rejects substring-only matches that are not token-delimited', () => {
  assert.throws(
    () =>
      parseFlushInput({
        stateModel: {
          confidence_history: [{ reason: 'bad', value: 'highlighted' }],
          strategy_confidence: 'high',
        },
        summary: 'Should not match substring high in highlighted.',
      }),
    (error: Error) => {
      assert.ok(error.message.includes('highlighted'), 'error should mention the invalid value');
      return true;
    },
  );
});

test('parseFlushInput does not warn for valid confidence_history values', () => {
  const parsed = parseFlushInput({
    stateModel: {
      confidence_history: [
        { reason: 'a', value: 'high' },
        { reason: 'b', value: 'medium' },
        { reason: 'c', value: 'low' },
      ],
      strategy_confidence: 'high',
    },
    summary: 'Valid confidence_history values.',
  });

  assert.equal(parsed.normalizationWarnings.length, 0, 'no warnings for all-valid confidence_history');
});

test('parseFlushInput normalizationWarnings is always an array', () => {
  const parsed = parseFlushInput({ summary: 'No state model.' });
  assert.ok(Array.isArray(parsed.normalizationWarnings), 'normalizationWarnings should always be an array');
  assert.equal(parsed.normalizationWarnings.length, 0);
});

// --- collectContinuityQualityWarnings ---

const LONG_SUMMARY = 'A'.repeat(120);

test('collectContinuityQualityWarnings emits warning when nextActions is empty', () => {
  const parsed = parseFlushInput({
    envModel: { branch: 'issue/1730' },
    openQuestions: ['Should we defer the schema migration?'],
    stateModel: { strategy_confidence: 'high' },
    summary: LONG_SUMMARY,
  });

  const warnings = collectContinuityQualityWarnings(parsed);

  assert.ok(
    warnings.some(w => w.includes('nextActions is missing or empty')),
    'should warn when nextActions is empty',
  );
  assert.ok(
    !warnings.some(w => w.includes('openQuestions is missing or empty')),
    'should not warn when openQuestions is non-empty',
  );
});

test('collectContinuityQualityWarnings emits warning when openQuestions is empty', () => {
  const parsed = parseFlushInput({
    envModel: { branch: 'issue/1730' },
    nextActions: ['Run integration tests.'],
    stateModel: { strategy_confidence: 'high' },
    summary: LONG_SUMMARY,
  });

  const warnings = collectContinuityQualityWarnings(parsed);

  assert.ok(
    warnings.some(w => w.includes('openQuestions is missing or empty')),
    'should warn when openQuestions is empty',
  );
  assert.ok(
    !warnings.some(w => w.includes('nextActions is missing or empty')),
    'should not warn when nextActions is non-empty',
  );
});

test('collectContinuityQualityWarnings returns empty warnings when all continuity fields are present', () => {
  const parsed = parseFlushInput({
    envModel: { branch: 'issue/1730', workspace_dirty: false },
    nextActions: ['Run integration tests.', 'Publish PR.'],
    openQuestions: ['Should we defer the schema migration?'],
    stateModel: { assumptions: ['CI is stable'], strategy_confidence: 'high' },
    summary: LONG_SUMMARY,
  });

  const warnings = collectContinuityQualityWarnings(parsed);

  assert.equal(warnings.length, 0, 'no continuity warnings expected when all fields are present');
});

test('collectContinuityQualityWarnings emits one warning per missing continuity field', () => {
  const parsed = parseFlushInput({
    summary: 'Short summary.',
  });

  const warnings = collectContinuityQualityWarnings(parsed);

  assert.ok(
    warnings.some(w => w.includes('summary is brief')),
    'should warn about brief summary',
  );
  assert.ok(
    warnings.some(w => w.includes('nextActions is missing or empty')),
    'should warn about nextActions',
  );
  assert.ok(
    warnings.some(w => w.includes('openQuestions is missing or empty')),
    'should warn about openQuestions',
  );
  assert.ok(
    warnings.some(w => w.includes('stateModel is missing')),
    'should warn about stateModel',
  );
  assert.ok(
    warnings.some(w => w.includes('envModel is missing')),
    'should warn about envModel',
  );
  assert.equal(warnings.length, 5, 'should emit exactly 5 warnings when all fields are missing or brief');
});

test('flush delta retains project and producer for exact scoped session resume', () => {
  const parsed = parseFlushInput({
    agent: 'codex',
    contextNeeded: ['Customer review remains pending.'],
    nextActions: ['Verify the manifest checksum.'],
    openQuestions: ['Has the customer accepted the archive review?'],
    project: 'fixture/recovery',
    sessionId: 'fixture-host-session-a',
    summary:
      'Prepared the offline archive and verified its manifest. The customer review is pending and the original approval requirement must survive this checkpoint.',
    task: 'fixture-logical-task-export',
  });
  const payload = buildFlushDeltaPayload({
    buildFlushSnapshotValue,
    nowIso: TEST_NOW,
    parsed,
    sessionId: 'fixture-host-session-a',
  });
  const delta = payload.memoryDelta;
  assertValidMemoryDelta(delta);
  assert.ok(isRecord(delta));
  assert.deepEqual(delta.produced_by, { agent: 'codex' });
  assert.deepEqual(delta.tenancy, { repo_id: 'fixture/recovery' });
  assert.equal(delta.session_id, 'fixture-host-session-a');
  assert.ok(isRecord(delta.workflow));
  assert.equal(delta.workflow.system, 'memory-flush', 'automatic carry-forward must still identify explicit flushes');
  assert.ok(isRecord(delta.snapshot) && isRecord(delta.snapshot.value));
  assert.deepEqual(delta.snapshot.value.context_needed, ['Customer review remains pending.']);
  assert.equal(parsed.task, 'fixture-logical-task-export', 'logical task is not replaced by host session');
});
