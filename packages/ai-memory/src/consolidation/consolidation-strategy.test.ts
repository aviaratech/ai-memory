import assert from 'node:assert/strict';
import { describe, test } from 'vitest';

import { resolveConsolidationAction, shouldAttemptConsolidation } from './consolidateMemories.js';

describe('shouldAttemptConsolidation', () => {
  test('returns true for legacy decision memory without memoryType', () => {
    assert.equal(
      shouldAttemptConsolidation({
        category: 'decision',
        content: 'Legacy memory with no type still participates in consolidation.',
        id: 1,
      }),
      true,
    );
  });

  test('returns true for typed episodic memory', () => {
    assert.equal(
      shouldAttemptConsolidation({
        category: 'workflow',
        content: 'Observed workflow failure while running checks.',
        id: 2,
        memoryType: 'episodic',
      }),
      true,
    );
  });

  test('returns false for reflective memory', () => {
    assert.equal(
      shouldAttemptConsolidation({
        category: 'decision',
        content: 'Meta observation about recurring planning mistakes.',
        id: 3,
        memoryType: 'reflective',
      }),
      false,
    );
  });
});

describe('resolveConsolidationAction', () => {
  test('keeps contradictory relationships as contradict', () => {
    assert.equal(
      resolveConsolidationAction({
        candidateMemoryType: 'semantic',
        newMemoryType: 'episodic',
        relationship: 'contradict',
      }),
      'contradict',
    );
  });

  test('maps unrelated relationships to none', () => {
    assert.equal(
      resolveConsolidationAction({
        candidateMemoryType: 'semantic',
        newMemoryType: 'episodic',
        relationship: 'unrelated',
      }),
      'none',
    );
  });

  test('prevents refine from superseding reflective memories', () => {
    assert.equal(
      resolveConsolidationAction({
        candidateMemoryType: 'reflective',
        newMemoryType: 'semantic',
        relationship: 'refine',
      }),
      'reinforce',
    );
  });

  test('routes episodic+semantic refine to episodic_to_semantic consolidation', () => {
    assert.equal(
      resolveConsolidationAction({
        candidateMemoryType: 'semantic',
        newMemoryType: 'episodic',
        relationship: 'refine',
      }),
      'episodic_to_semantic',
    );
  });

  test('keeps regular refine behavior when no special memory-type rule applies', () => {
    assert.equal(
      resolveConsolidationAction({
        candidateMemoryType: 'episodic',
        newMemoryType: 'semantic',
        relationship: 'refine',
      }),
      'refine',
    );
  });
});
