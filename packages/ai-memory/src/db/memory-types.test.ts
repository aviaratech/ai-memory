import assert from 'node:assert/strict';
import { test } from 'vitest';

import { inferMemoryTypeFromCategory, resolveMemoryTypeFromCategory } from './memory-types.js';

test('inferMemoryTypeFromCategory returns semantic for methodology', () => {
  assert.equal(inferMemoryTypeFromCategory('methodology'), 'semantic');
});

test('resolveMemoryTypeFromCategory returns semantic for methodology', () => {
  assert.equal(resolveMemoryTypeFromCategory('methodology'), 'semantic');
});

test('inferMemoryTypeFromCategory returns semantic for architecture', () => {
  assert.equal(inferMemoryTypeFromCategory('architecture'), 'semantic');
});

test('inferMemoryTypeFromCategory returns semantic for convention', () => {
  assert.equal(inferMemoryTypeFromCategory('convention'), 'semantic');
});

test('inferMemoryTypeFromCategory returns procedural for preference', () => {
  assert.equal(inferMemoryTypeFromCategory('preference'), 'procedural');
});

test('inferMemoryTypeFromCategory returns undefined for unknown category', () => {
  assert.equal(inferMemoryTypeFromCategory('unknown-category'), undefined);
});

test('resolveMemoryTypeFromCategory falls back to episodic for unknown category', () => {
  assert.equal(resolveMemoryTypeFromCategory('unknown-category'), 'episodic');
});
