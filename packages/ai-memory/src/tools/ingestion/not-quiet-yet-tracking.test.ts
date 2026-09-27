import assert from 'node:assert/strict';
import { test } from 'vitest';

import { decideNotQuietYetEmission, NOT_QUIET_EMIT_INTERVAL } from './not-quiet-yet-tracking.js';

const SESSION_A = '/sessions/a.jsonl';
const SESSION_B = '/sessions/b.jsonl';
const SESSION_X = '/sessions/x.jsonl';

test('first skip for a session emits', () => {
  const result = decideNotQuietYetEmission(undefined, SESSION_A);
  assert.equal(result.shouldEmit, true);
  assert.equal(result.tracking.consecutiveSkips, 1);
  assert.equal(result.suppressedCount, 0);
});

test('second skip is suppressed', () => {
  const first = decideNotQuietYetEmission(undefined, SESSION_A);
  const second = decideNotQuietYetEmission(first.tracking, SESSION_A);
  assert.equal(second.shouldEmit, false);
  assert.equal(second.tracking.consecutiveSkips, 2);
});

test('skips 2 through N-1 are suppressed before interval triggers', () => {
  let tracking = decideNotQuietYetEmission(undefined, SESSION_A).tracking;
  for (let i = 2; i < NOT_QUIET_EMIT_INTERVAL + 1; i++) {
    const result = decideNotQuietYetEmission(tracking, SESSION_A);
    assert.equal(result.shouldEmit, false, `skip ${String(i)} should be suppressed`);
    tracking = result.tracking;
  }
});

test('emit interval triggers after N consecutive skips', () => {
  let tracking = decideNotQuietYetEmission(undefined, SESSION_A).tracking;

  for (let i = 2; i <= NOT_QUIET_EMIT_INTERVAL; i++) {
    const result = decideNotQuietYetEmission(tracking, SESSION_A);
    tracking = result.tracking;
  }

  const emitResult = decideNotQuietYetEmission(tracking, SESSION_A);
  assert.equal(emitResult.shouldEmit, true);
  assert.equal(emitResult.tracking.consecutiveSkips, NOT_QUIET_EMIT_INTERVAL + 1);
  assert.equal(emitResult.suppressedCount, NOT_QUIET_EMIT_INTERVAL - 1);
});

test('different session file resets tracking and emits', () => {
  const first = decideNotQuietYetEmission(undefined, SESSION_A);
  const second = decideNotQuietYetEmission(first.tracking, SESSION_B);
  assert.equal(second.shouldEmit, true);
  assert.equal(second.tracking.consecutiveSkips, 1);
  assert.equal(second.tracking.sessionFile, SESSION_B);
  assert.equal(second.suppressedCount, 0);
});

test('sustained skips produce ~80% reduction over 226 events', () => {
  let tracking = undefined;
  let emitCount = 0;

  for (let i = 0; i < 226; i++) {
    const result = decideNotQuietYetEmission(tracking, SESSION_A);
    if (result.shouldEmit) {
      emitCount++;
    }
    tracking = result.tracking;
  }

  const reductionPercent = ((226 - emitCount) / 226) * 100;
  assert.ok(reductionPercent >= 60, `Expected >=60% reduction, got ${String(Math.round(reductionPercent))}%`);
  assert.ok(emitCount < 91, `Expected <91 emissions from 226, got ${String(emitCount)}`);
});

test('suppressedCount reports correct number of suppressed events', () => {
  let tracking = decideNotQuietYetEmission(undefined, SESSION_A).tracking;
  let lastSuppressedCount = 0;

  for (let i = 2; i <= 20; i++) {
    const result = decideNotQuietYetEmission(tracking, SESSION_A);
    if (result.shouldEmit) {
      lastSuppressedCount = result.suppressedCount;
    }
    tracking = result.tracking;
  }

  assert.equal(lastSuppressedCount, NOT_QUIET_EMIT_INTERVAL - 1);
});

test('undefined previous starts fresh', () => {
  const result = decideNotQuietYetEmission(undefined, SESSION_X);
  assert.equal(result.tracking.consecutiveSkips, 1);
  assert.equal(result.tracking.lastEmittedAtSkip, 1);
  assert.equal(result.tracking.sessionFile, SESSION_X);
});
