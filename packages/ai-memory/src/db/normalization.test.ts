import assert from 'node:assert/strict';
import { test } from 'vitest';

import { createDurableMemoryKey, createMemoryDedupeHash } from './hashing.js';
import {
  normalizeDurableMemoryProposals,
  normalizeMemoryInput,
  normalizeProjectScope,
  readOptionalText,
  readStringArray,
  truncateText,
} from './normalization.js';
import { DERIVED_MEMORY_KEY_PREFIX } from './runtime.js';

const TEST_PROJECT = 'example/catalog';
const DERIVED_KEY_PREFIX_WITH_SEPARATOR = `${DERIVED_MEMORY_KEY_PREFIX}:`;
const MEMORY_KEY_SHOULD_BE_DERIVED = 'memoryKey should be auto-derived';
const VALID_CONTENT = 'This is a durable memory payload that is long enough.';
const VALID_EVIDENCE_REFS = ['packages/foo/src/bar.ts'];

test('verified repository identity unifies basename writes without aliasing other repositories', () => {
  assert.equal(normalizeProjectScope({ project: 'catalog', repoSlug: 'example/catalog' }), 'example/catalog');
  assert.equal(normalizeProjectScope({ project: 'catalog', repoId: 'other/catalog' }), 'other/catalog');
  assert.equal(normalizeProjectScope({ project: 'catalog' }), 'catalog');
  assert.throws(
    () => normalizeProjectScope({ project: 'catalog', repoId: 'other/catalog', repoSlug: 'example/catalog' }),
    /Conflicting repository/u,
  );
  assert.equal(normalizeProjectScope({ repoId: 'opaque-id' }), undefined);
  assert.equal(normalizeProjectScope({ project: 'team-project', repoSlug: 'example/catalog' }), 'team-project');
  for (const source of ['codex', 'claude-session-end', 'grok-session-end']) {
    const memory = normalizeMemoryInput({
      category: 'decision',
      content: VALID_CONTENT,
      project: 'catalog',
      repoSlug: 'example/catalog',
      sessionId: 'host-session',
      source,
      threadId: 'logical-task',
    });
    assert.equal(memory.project, 'example/catalog');
    assert.equal(memory.source, source);
    assert.equal(memory.sessionId, 'host-session');
    assert.equal(memory.threadId, 'logical-task');
    assert.equal(memory.repoSlug, 'example/catalog');
  }
});

test('normalizeMemoryInput preserves non-repo project identifiers without runtime canonicalization', () => {
  const normalized = normalizeMemoryInput({
    category: 'decision',
    content: 'Preserve memory_store project aliases at ingest time.',
    project: 'legacy-project',
    tags: ['Backfill', 'Legacy'],
  });

  assert.equal(normalized.project, 'legacy-project');
  assert.equal(
    normalized.dedupeHash,
    createMemoryDedupeHash({
      category: 'decision',
      content: 'Preserve memory_store project aliases at ingest time.',
      project: 'legacy-project',
      sensitivity: 'internal',
      tags: ['backfill', 'legacy'],
    }),
  );
});

test('normalizeDurableMemoryProposals preserves proposal project aliases', () => {
  const normalized = normalizeDurableMemoryProposals([
    {
      category: 'decision',
      content: 'Proposal project aliases should be preserved.',
      project: 'CONSUMER-MONOREPO',
    },
  ]);

  assert.equal(normalized.length, 1);
  assert.ok(normalized[0] !== undefined);
  assert.equal(normalized[0].project, 'CONSUMER-MONOREPO');
});

test('normalizeDurableMemoryProposals preserves non-legacy project identifiers', () => {
  const normalized = normalizeDurableMemoryProposals([
    {
      category: 'decision',
      content: 'Non-legacy project identifiers are preserved.',
      project: 'aviaratech/mobile',
    },
  ]);

  assert.equal(normalized.length, 1);
  assert.ok(normalized[0] !== undefined);
  assert.equal(normalized[0].project, 'aviaratech/mobile');
});

test('normalizeDurableMemoryProposals preserves an explicit harness source', () => {
  const normalized = normalizeDurableMemoryProposals([
    {
      category: 'session-summary',
      confidence: 0.4,
      content: 'The durable proposal retains its originating harness source.',
      source: 'grok-session-end',
      source_timestamp: '2026-09-08T11:01:00.000Z',
      ttl_days: 7,
    },
  ]);

  const [proposal] = normalized;
  assert.ok(proposal !== undefined);
  assert.equal(proposal.source, 'grok-session-end');
  assert.equal(proposal.sourceTimestamp, '2026-09-08T11:01:00.000Z');
});

test('normalizeMemoryInput infers episodic memoryType for root-cause category', () => {
  const normalized = normalizeMemoryInput({
    category: 'root-cause',
    confidence: 0.9,
    content: VALID_CONTENT,
    evidenceRefs: VALID_EVIDENCE_REFS,
  });

  assert.equal(normalized.memoryType, 'episodic');
});

test('normalizeMemoryInput infers semantic memoryType for decision category', () => {
  const normalized = normalizeMemoryInput({
    category: 'decision',
    confidence: 0.8,
    content: VALID_CONTENT,
  });

  assert.equal(normalized.memoryType, 'semantic');
});

test('normalizeMemoryInput infers procedural memoryType for workflow category', () => {
  const normalized = normalizeMemoryInput({
    category: 'workflow',
    confidence: 0.8,
    content: VALID_CONTENT,
  });

  assert.equal(normalized.memoryType, 'procedural');
});

test('normalizeMemoryInput infers expected default memoryType for all mapped categories', () => {
  const expectedByCategory: Record<string, string> = {
    architecture: 'semantic',
    'audit-log': 'episodic',
    bugfix: 'episodic',
    checkpoint: 'episodic',
    convention: 'semantic',
    decision: 'semantic',
    'implementation-note': 'episodic',
    preference: 'procedural',
    'root-cause': 'episodic',
    'session-summary': 'episodic',
    workflow: 'procedural',
  };

  for (const [category, expectedMemoryType] of Object.entries(expectedByCategory)) {
    const input: Record<string, unknown> = {
      category,
      confidence: category === 'session-summary' ? 0.4 : 0.8,
      content: VALID_CONTENT,
    };
    if (category === 'session-summary') {
      input.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    }
    if (
      category === 'architecture' ||
      category === 'convention' ||
      category === 'preference' ||
      category === 'root-cause'
    ) {
      input.evidenceRefs = VALID_EVIDENCE_REFS;
    }

    const normalized = normalizeMemoryInput(input);
    assert.equal(
      normalized.memoryType,
      expectedMemoryType,
      `expected ${category} -> ${expectedMemoryType}, got ${normalized.memoryType}`,
    );
  }
});

test('normalizeMemoryInput preserves explicit memoryType override', () => {
  const normalized = normalizeMemoryInput({
    category: 'decision',
    confidence: 0.8,
    content: VALID_CONTENT,
    memoryType: 'reflective',
  });

  assert.equal(normalized.memoryType, 'reflective');
});

test('normalizeMemoryInput defaults unmapped categories to episodic memoryType', () => {
  const normalized = normalizeMemoryInput({
    category: 'custom-category',
    confidence: 0.8,
    content: VALID_CONTENT,
  });

  assert.equal(normalized.memoryType, 'episodic');
  assert.notEqual(normalized.memoryType, 'reflective');
});

test('normalizeMemoryInput rejects invalid memoryType values', () => {
  assert.throws(
    () =>
      normalizeMemoryInput({
        category: 'decision',
        confidence: 0.8,
        content: VALID_CONTENT,
        memoryType: 'invalid-type',
      }),
    /memoryType must be one of/i,
  );
});

// --- memoryKey auto-derivation tests ---

test('auto-derives memoryKey for convention category when omitted', () => {
  const normalized = normalizeMemoryInput({
    category: 'convention',
    confidence: 0.9,
    content: VALID_CONTENT,
    evidenceRefs: VALID_EVIDENCE_REFS,
  });

  assert.ok(normalized.memoryKey !== undefined, MEMORY_KEY_SHOULD_BE_DERIVED);
  assert.ok(normalized.memoryKey.startsWith(DERIVED_KEY_PREFIX_WITH_SEPARATOR), 'should use derived prefix');
});

test('auto-derives memoryKey for architecture category when omitted', () => {
  const normalized = normalizeMemoryInput({
    category: 'architecture',
    confidence: 0.85,
    content: VALID_CONTENT,
    evidenceRefs: VALID_EVIDENCE_REFS,
  });

  assert.ok(normalized.memoryKey !== undefined, MEMORY_KEY_SHOULD_BE_DERIVED);
  assert.ok(normalized.memoryKey.startsWith(DERIVED_KEY_PREFIX_WITH_SEPARATOR));
});

test('auto-derives memoryKey for preference category when omitted', () => {
  const normalized = normalizeMemoryInput({
    category: 'preference',
    confidence: 0.8,
    content: VALID_CONTENT,
    evidenceRefs: VALID_EVIDENCE_REFS,
  });

  assert.ok(normalized.memoryKey !== undefined, MEMORY_KEY_SHOULD_BE_DERIVED);
  assert.ok(normalized.memoryKey.startsWith(DERIVED_KEY_PREFIX_WITH_SEPARATOR));
});

test('auto-derives memoryKey for root-cause category when omitted', () => {
  const normalized = normalizeMemoryInput({
    category: 'root-cause',
    confidence: 0.9,
    content: VALID_CONTENT,
    evidenceRefs: VALID_EVIDENCE_REFS,
  });

  assert.ok(normalized.memoryKey !== undefined, MEMORY_KEY_SHOULD_BE_DERIVED);
  assert.ok(normalized.memoryKey.startsWith(DERIVED_KEY_PREFIX_WITH_SEPARATOR));
});

test('auto-derived memoryKey is deterministic for identical input', () => {
  const input = {
    category: 'convention',
    confidence: 0.9,
    content: VALID_CONTENT,
    evidenceRefs: VALID_EVIDENCE_REFS,
  };

  const first = normalizeMemoryInput(input);
  const second = normalizeMemoryInput(input);

  assert.equal(first.memoryKey, second.memoryKey, 'same input should produce same derived key');
});

test('auto-derived memoryKey matches createDurableMemoryKey output', () => {
  const normalized = normalizeMemoryInput({
    category: 'convention',
    confidence: 0.9,
    content: VALID_CONTENT,
    evidenceRefs: VALID_EVIDENCE_REFS,
    project: TEST_PROJECT,
    tags: ['zustand', 'naming'],
  });

  const expectedKey = createDurableMemoryKey({
    category: 'convention',
    content: VALID_CONTENT,
    project: TEST_PROJECT,
    sensitivity: 'internal',
    tags: ['naming', 'zustand'],
  });

  assert.equal(normalized.memoryKey, expectedKey);
});

test('preserves explicit memoryKey for strict categories', () => {
  const normalized = normalizeMemoryInput({
    category: 'convention',
    confidence: 0.9,
    content: VALID_CONTENT,
    evidenceRefs: VALID_EVIDENCE_REFS,
    memoryKey: 'example/catalog:my-convention',
  });

  assert.equal(normalized.memoryKey, 'example/catalog:my-convention');
});

test('does not auto-derive memoryKey for non-strict categories', () => {
  const normalized = normalizeMemoryInput({
    category: 'decision',
    confidence: 0.8,
    content: VALID_CONTENT,
  });

  assert.equal(normalized.memoryKey, undefined);
});

test('does not auto-derive memoryKey for session-summary category', () => {
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const normalized = normalizeMemoryInput({
    category: 'session-summary',
    confidence: 0.4,
    content: VALID_CONTENT,
    expiresAt,
  });

  assert.equal(normalized.memoryKey, undefined);
});

test('strict category without evidenceRefs stores with warning metadata', () => {
  const normalized = normalizeMemoryInput({
    category: 'convention',
    confidence: 0.9,
    content: VALID_CONTENT,
  });

  assert.ok(normalized.memoryKey !== undefined, 'memoryKey should still be auto-derived');
  assert.equal((normalized.metadata as Record<string, unknown>).missingEvidenceRefs, true);
  assert.ok(
    Array.isArray((normalized.metadata as Record<string, unknown>).policyWarnings),
    'should have policyWarnings array',
  );
});

test('auto-derives memoryKey for mixed-case strict category', () => {
  const normalized = normalizeMemoryInput({
    category: 'Convention',
    confidence: 0.9,
    content: VALID_CONTENT,
    evidenceRefs: VALID_EVIDENCE_REFS,
  });

  assert.ok(normalized.memoryKey !== undefined, 'memoryKey should be auto-derived for mixed-case');
  assert.ok(normalized.memoryKey.startsWith(DERIVED_KEY_PREFIX_WITH_SEPARATOR));
});

test('normalizeMemoryInput accepts explicit importance override', () => {
  const normalized = normalizeMemoryInput({
    category: 'decision',
    confidence: 0.8,
    content: VALID_CONTENT,
    importance: 0.42,
  });

  assert.equal(normalized.importance, 0.42);
});

test('normalizeMemoryInput rejects out-of-range importance', () => {
  assert.throws(
    () =>
      normalizeMemoryInput({
        category: 'decision',
        confidence: 0.8,
        content: VALID_CONTENT,
        importance: 1.2,
      }),
    /importance must be between 0 and 1/,
  );
});

// --- readOptionalText ---

test('readOptionalText returns trimmed string for non-empty strings', () => {
  assert.equal(readOptionalText('  hello  '), 'hello');
  assert.equal(readOptionalText('world'), 'world');
});

test('readOptionalText returns undefined for empty or whitespace-only strings', () => {
  assert.equal(readOptionalText(''), undefined);
  assert.equal(readOptionalText('   '), undefined);
});

test('readOptionalText returns undefined for non-string values without throwing', () => {
  assert.equal(readOptionalText(undefined), undefined);
  assert.equal(readOptionalText(null), undefined);
  assert.equal(readOptionalText(42), undefined);
  assert.equal(readOptionalText({}), undefined);
  assert.equal(readOptionalText([]), undefined);
});

// --- readStringArray ---

test('readStringArray returns trimmed non-empty strings from an array', () => {
  assert.deepEqual(readStringArray(['  a  ', 'b', 'c']), ['a', 'b', 'c']);
});

test('readStringArray filters empty and whitespace-only strings', () => {
  assert.deepEqual(readStringArray(['a', '', '  ', 'b']), ['a', 'b']);
});

test('readStringArray filters non-string items', () => {
  assert.deepEqual(readStringArray(['a', 1, null, undefined, 'b']), ['a', 'b']);
});

test('readStringArray returns empty array for non-array input', () => {
  assert.deepEqual(readStringArray(undefined), []);
  assert.deepEqual(readStringArray(null), []);
  assert.deepEqual(readStringArray('string'), []);
  assert.deepEqual(readStringArray({}), []);
});

// --- truncateText ---

test('truncateText returns value unchanged when within limit', () => {
  assert.equal(truncateText('hello', 10), 'hello');
  assert.equal(truncateText('hello', 5), 'hello');
});

test('truncateText truncates with ellipsis when over limit', () => {
  const result = truncateText('hello world', 8);
  assert.ok(result.endsWith('...'), 'should end with ellipsis');
  assert.ok(result.length <= 8, 'should be within maxChars');
});

test('truncateText trims trailing whitespace before ellipsis', () => {
  const result = truncateText('hello   ', 7);
  assert.ok(!result.includes('   '), 'should not have trailing spaces before ellipsis');
});
