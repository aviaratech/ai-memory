import assert from 'node:assert/strict';
import { test } from 'vitest';

import { compareOutcomes, runReflection, storeReflectiveMemories } from './reflection.js';

const TEST_PROJECT = 'example/catalog';
const TEST_SESSION_ID = 'session-1360';
const TEST_SOURCE = 'memory-flush';
const SIGNAL_CONFIDENCE_CALIBRATION = 'confidence-calibration';
const SIGNAL_VALIDATED_ASSUMPTIONS = 'validated-assumptions';

test('compareOutcomes validates assumptions from decision keyword matches', () => {
  const result = compareOutcomes(
    {
      assumptions: ['goal hierarchy exists', 'transaction scope is stable'],
      strategy_confidence: 'medium',
    },
    'Finished implementation updates.',
    ['Implemented goal hierarchy persistence and tightened transaction scope behavior.'],
    [],
  );

  assert.deepEqual(result.validatedAssumptions, ['goal hierarchy exists', 'transaction scope is stable']);
  assert.deepEqual(result.unresolvedAssumptions, []);
});

test('compareOutcomes keeps non-matching assumptions unresolved', () => {
  const result = compareOutcomes(
    {
      assumptions: ['embedding backfill is complete'],
      strategy_confidence: 'medium',
    },
    'Worked on ingestion behavior.',
    ['Adjusted flush-session ordering.'],
    ['Detected ordering mismatch in flush flow.'],
  );

  assert.deepEqual(result.validatedAssumptions, []);
  assert.deepEqual(result.unresolvedAssumptions, ['embedding backfill is complete']);
  assert.ok(result.reflections.some(reflection => reflection.includes('Unresolved assumptions')));
});

test('compareOutcomes detects overconfidence for high confidence with multiple root causes', () => {
  const result = compareOutcomes(
    {
      strategy_confidence: 'high',
    },
    'Session ended with blockers.',
    ['Implemented first pass.'],
    ['Mismatch in session metadata', 'Unexpected schema validation failure'],
  );

  assert.equal(result.confidenceCalibration, 'overconfident');
});

test('compareOutcomes detects underconfidence for low confidence with successful outcome', () => {
  const result = compareOutcomes(
    {
      strategy_confidence: 'low',
    },
    'Session completed with no incidents.',
    ['Completed runReflection integration.'],
    [],
  );

  assert.equal(result.confidenceCalibration, 'underconfident');
});

test('compareOutcomes returns well-calibrated for mixed medium-confidence outcomes', () => {
  const result = compareOutcomes(
    {
      strategy_confidence: 'medium',
    },
    'Mixed results with follow-up needed.',
    ['Completed memory flush updates.'],
    ['One downstream schema inconsistency found'],
  );

  assert.equal(result.confidenceCalibration, 'well-calibrated');
});

test('storeReflectiveMemories enforces max 3-memory cap', async () => {
  const storedInputs: unknown[] = [];
  const stored = await storeReflectiveMemories({
    agent: 'codex',
    calibrationSignal: { actual: 'partial', predicted: 'high' },
    drafts: [
      { content: 'reflection-1', signal: SIGNAL_VALIDATED_ASSUMPTIONS },
      { content: 'reflection-2', signal: SIGNAL_VALIDATED_ASSUMPTIONS },
      { content: 'reflection-3', signal: SIGNAL_CONFIDENCE_CALIBRATION },
      { content: 'reflection-4', signal: SIGNAL_VALIDATED_ASSUMPTIONS },
      { content: 'reflection-5', signal: SIGNAL_CONFIDENCE_CALIBRATION },
    ],
    project: TEST_PROJECT,
    sessionId: TEST_SESSION_ID,
    source: TEST_SOURCE,
    storeMemory: input => {
      storedInputs.push(input);
      return Promise.resolve({
        id: storedInputs.length,
        memoryType: 'reflective',
      });
    },
  });

  assert.equal(storedInputs.length, 3);
  assert.equal(stored.length, 3);
});

test('runReflection skips reflection when stateModel is absent', async () => {
  let storeCalls = 0;

  const result = await runReflection(
    {
      agent: 'codex',
      decisions: ['Updated flush-session orchestration.'],
      project: TEST_PROJECT,
      rootCauses: ['No reflection data available'],
      sessionId: TEST_SESSION_ID,
      source: TEST_SOURCE,
      stateModel: undefined,
      summary: 'No state model available in this flush.',
    },
    {
      storeMemory: () => {
        storeCalls += 1;
        return Promise.resolve({ id: 1 });
      },
    },
  );

  assert.equal(storeCalls, 0);
  assert.deepEqual(result.storedMemories, []);
  assert.equal(result.reflectionResult, undefined);
});

test('runReflection does not throw when reflective memory storage fails', async () => {
  const result = await runReflection(
    {
      agent: 'codex',
      decisions: ['Implemented reflection flow and flush integration.'],
      project: TEST_PROJECT,
      rootCauses: ['Unexpected migration mismatch', 'Incorrect inferred status'],
      sessionId: TEST_SESSION_ID,
      source: TEST_SOURCE,
      stateModel: {
        assumptions: ['flush ordering is already correct', 'all metadata paths are stable'],
        strategy_confidence: 'high',
      },
      summary: 'Reflection path encountered non-blocking issues.',
    },
    {
      storeMemory: () => Promise.reject(new Error('write failed')),
    },
  );

  assert.equal(result.reflectionResult?.confidenceCalibration, 'overconfident');
  assert.deepEqual(result.storedMemories, []);
});

test('runReflection stores reflective memories with calibration metadata and session linkage', async () => {
  const storedInputs: unknown[] = [];

  const result = await runReflection(
    {
      agent: 'codex',
      decisions: ['Completed reflection integration tests.'],
      project: TEST_PROJECT,
      rootCauses: [],
      sessionId: TEST_SESSION_ID,
      source: TEST_SOURCE,
      stateModel: {
        assumptions: ['reflection module can be integrated safely', 'calibration metadata is shaped correctly'],
        strategy_confidence: 'low',
      },
      summary: 'Successful reflection run.',
    },
    {
      storeMemory: input => {
        storedInputs.push(input);
        return Promise.resolve({
          id: storedInputs.length,
          memoryType: 'reflective',
        });
      },
    },
  );

  assert.ok(storedInputs.length >= 1);
  const firstWrite = storedInputs[0];
  assert.ok(isRecord(firstWrite));
  assert.equal(firstWrite.category, 'reflective');
  assert.equal(firstWrite.sessionId, TEST_SESSION_ID);
  assert.deepEqual(firstWrite.tags, ['reflection', 'auto-generated']);
  assert.ok(isRecord(firstWrite.metadata));
  assert.deepEqual(firstWrite.metadata.calibration_signal, {
    actual: 'success',
    predicted: 'low',
  });
  assert.equal(result.storedMemories.length, storedInputs.length);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
