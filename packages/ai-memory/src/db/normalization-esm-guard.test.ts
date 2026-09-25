/**
 * Regression test: esbuild __esm lazy-init failure mode.
 *
 * The original trigger was a schema loader that could throw during bundled
 * module initialization. Schemas are now inlined, but this guard remains useful
 * for any future module-init failure before runtime constants are assigned.
 * normalizeEnumValue previously called allowedValues.includes() without
 * guarding against undefined, crashing with "Cannot read properties of
 * undefined (reading 'includes')". The Array.isArray guard added in the fix
 * produces a descriptive error instead.
 *
 * This test mocks runtime.js to export undefined constants, then imports
 * normalization.ts and verifies the guard fires.
 */
import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';

// Mock runtime.js BEFORE importing normalization — simulates __esm init failure
// where constants remain undefined before assignment.
vi.doMock('./runtime.js', () => ({
  DERIVED_MEMORY_KEY_PREFIX: 'derived-memory',
  MEMORY_IDENTITY_HASH_VERSION: 'v1',
  MEMORY_STATUS_VALUES: undefined,
  MIN_DURABLE_CONTENT_CHARS: 24,
  MIN_HIGH_CONFIDENCE_DURABLE: 0.5,
  PATCH_SNAPSHOT_ID_PREFIX: 'patch-snapshot',
  SENSITIVITY_VALUES: undefined,
  SESSION_SUMMARY_CATEGORY: 'session-summary',
  SESSION_SUMMARY_MAX_CONFIDENCE: 0.5,
  UNKNOWN_INGESTION_FAILURE: 'unknown ingestion failure',
}));

const { normalizeMemoryInput } = await import('./normalization.js');

describe('normalizeEnumValue Array.isArray guard regression', () => {
  it('throws descriptive error when SENSITIVITY_VALUES is undefined (simulated __esm failure)', () => {
    assert.throws(
      () =>
        normalizeMemoryInput({
          category: 'decision',
          confidence: 0.8,
          content: 'Test content that is long enough for normalization.',
          sensitivity: 'internal',
        }),
      (err: Error) => {
        // Must NOT be the original crash: "Cannot read properties of undefined (reading 'includes')"
        assert.ok(
          !err.message.includes('Cannot read properties of undefined'),
          `should not crash with TypeError — got: ${err.message}`,
        );
        // Must mention the runtime constants being unavailable
        assert.ok(
          err.message.includes('runtime constants unavailable') || err.message.includes('must be one of'),
          `should produce a descriptive error — got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it('falls back gracefully when sensitivity is null/undefined and constants are unavailable', () => {
    // When value is null/undefined, normalizeEnumValue returns the fallback
    // without consulting allowedValues — so this should NOT throw.
    const result = normalizeMemoryInput({
      category: 'decision',
      confidence: 0.8,
      content: 'Test content that is long enough for normalization.',
    });
    assert.equal(result.sensitivity, 'internal', 'should return fallback when value is nullish');
  });
});
