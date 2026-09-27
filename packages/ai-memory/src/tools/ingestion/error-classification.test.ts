import assert from 'node:assert/strict';
import { test } from 'vitest';

import { classifyError } from './error-classification.js';

// --- type_error ---

test('classifies "TypeError: x is not a function" as type_error', () => {
  assert.equal(classifyError('TypeError: x is not a function'), 'type_error');
});

test('classifies "Type error in module" as type_error', () => {
  assert.equal(classifyError('Type error in module'), 'type_error');
});

test('classifies "is not assignable to type" as type_error', () => {
  assert.equal(classifyError("Argument of type 'string' is not assignable to type 'number'"), 'type_error');
});

// --- lint_failure ---

test('classifies "ESLint found 3 errors" as lint_failure', () => {
  assert.equal(classifyError('ESLint found 3 errors'), 'lint_failure');
});

test('classifies "lint failed with warnings" as lint_failure', () => {
  assert.equal(classifyError('lint failed with warnings'), 'lint_failure');
});

// --- test_failure ---

test('classifies "test failed: expected true" as test_failure', () => {
  assert.equal(classifyError('test failed: expected true'), 'test_failure');
});

test('classifies "Test failure in suite" as test_failure', () => {
  assert.equal(classifyError('Test failure in suite'), 'test_failure');
});

test('classifies "expect(received).toBe(expected)" as test_failure', () => {
  assert.equal(classifyError('Expected: 42, Received: 0 — expect(received).toBe(expected)'), 'test_failure');
});

// --- build_failure ---

test('classifies "build failed with exit code 1" as build_failure', () => {
  assert.equal(classifyError('build failed with exit code 1'), 'build_failure');
});

test('classifies "build error: missing module" as build_failure', () => {
  assert.equal(classifyError('build error: missing module'), 'build_failure');
});

test('classifies "compilation failed" as build_failure', () => {
  assert.equal(classifyError('compilation failed'), 'build_failure');
});

// --- filesystem_error ---

test('classifies "ENOENT: no such file or directory" as filesystem_error', () => {
  assert.equal(classifyError('ENOENT: no such file or directory'), 'filesystem_error');
});

test('classifies "EACCES: permission denied" as filesystem_error', () => {
  assert.equal(classifyError('EACCES: permission denied'), 'filesystem_error');
});

test('classifies "EPERM: operation not permitted" as filesystem_error', () => {
  assert.equal(classifyError('EPERM: operation not permitted'), 'filesystem_error');
});

// --- runtime_error (fallback) ---

test('classifies unrecognized error as runtime_error', () => {
  assert.equal(classifyError('Something went wrong'), 'runtime_error');
});

test('classifies empty string as runtime_error', () => {
  assert.equal(classifyError(''), 'runtime_error');
});

// --- priority order: first match wins ---

test('type_error takes priority over lint_failure when both match', () => {
  assert.equal(classifyError('TypeError in eslint plugin'), 'type_error');
});
