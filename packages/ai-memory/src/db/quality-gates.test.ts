import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  assertDurableMemoryInputPolicy,
  assertDurableMemoryProposalPolicy,
  isStrictMetadataCategory,
} from './quality-gates.js';

const VALID_CONTENT = 'This is a durable memory payload that is long enough.';
const VALID_EVIDENCE_REFS = ['some-file.ts'];
const VALID_MEMORY_KEY = 'test:convention-key';
const CONVENTION_CATEGORY = 'convention';
const SESSION_SUMMARY_CATEGORY = 'session-summary';

test('non-session-summary durable memory requires high confidence', () => {
  assert.throws(() => {
    assertDurableMemoryInputPolicy({
      category: 'decision',
      confidence: 0.49,
      content: VALID_CONTENT,
    });
  }, /confidence >= 0.5/);
});

test('non-session-summary low-confidence rejection includes caller guidance', () => {
  assert.throws(() => {
    assertDurableMemoryInputPolicy({
      category: 'decision',
      confidence: 0.49,
      content: VALID_CONTENT,
    });
  }, /Guidance: raise confidence to at least 0.5.*session-summary.*expiresAt/u);
});

test('session-summary durable memory requires expiresAt', () => {
  assert.throws(() => {
    assertDurableMemoryInputPolicy({
      category: SESSION_SUMMARY_CATEGORY,
      confidence: 0.4,
      content: VALID_CONTENT,
    });
  }, /must include expiresAt/);
});

test('session-summary proposal requires ttlDays', () => {
  assert.throws(() => {
    assertDurableMemoryProposalPolicy(
      {
        category: SESSION_SUMMARY_CATEGORY,
        confidence: 0.4,
        content: VALID_CONTENT,
      },
      0,
    );
  }, /ttl_days is required/);
});

test('proposal low-confidence rejection includes caller guidance', () => {
  assert.throws(() => {
    assertDurableMemoryProposalPolicy(
      {
        category: 'decision',
        confidence: 0.49,
        content: VALID_CONTENT,
      },
      0,
    );
  }, /Guidance: set x_durable_memories\[0\]\.confidence to at least 0.5.*session-summary.*ttl_days/u);
});

test('valid non-session proposal passes policy checks', () => {
  assert.doesNotThrow(() => {
    assertDurableMemoryProposalPolicy(
      {
        category: 'decision',
        confidence: 0.85,
        content: VALID_CONTENT,
      },
      1,
    );
  });
});

test('convention category requires memoryKey', () => {
  assert.throws(() => {
    assertDurableMemoryInputPolicy({
      category: CONVENTION_CATEGORY,
      confidence: 0.9,
      content: VALID_CONTENT,
      evidenceRefs: VALID_EVIDENCE_REFS,
    });
  }, /memoryKey is required for 'convention'/);
});

test('architecture category requires memoryKey', () => {
  assert.throws(() => {
    assertDurableMemoryInputPolicy({
      category: 'architecture',
      confidence: 0.9,
      content: VALID_CONTENT,
      evidenceRefs: VALID_EVIDENCE_REFS,
    });
  }, /memoryKey is required for 'architecture'/);
});

test('preference category requires memoryKey', () => {
  assert.throws(() => {
    assertDurableMemoryInputPolicy({
      category: 'preference',
      confidence: 0.9,
      content: VALID_CONTENT,
      evidenceRefs: VALID_EVIDENCE_REFS,
    });
  }, /memoryKey is required for 'preference'/);
});

test('root-cause category requires memoryKey', () => {
  assert.throws(() => {
    assertDurableMemoryInputPolicy({
      category: 'root-cause',
      confidence: 0.9,
      content: VALID_CONTENT,
      evidenceRefs: VALID_EVIDENCE_REFS,
    });
  }, /memoryKey is required for 'root-cause'/);
});

test('convention category warns when evidenceRefs missing', () => {
  const result = assertDurableMemoryInputPolicy({
    category: CONVENTION_CATEGORY,
    confidence: 0.9,
    content: VALID_CONTENT,
    memoryKey: VALID_MEMORY_KEY,
  });

  assert.ok(result.warnings.length > 0, 'should have warnings');
  assert.ok(result.warnings[0]?.includes('evidenceRefs') === true, 'warning should mention evidenceRefs');
});

test('convention category warns on empty evidenceRefs array', () => {
  const result = assertDurableMemoryInputPolicy({
    category: CONVENTION_CATEGORY,
    confidence: 0.9,
    content: VALID_CONTENT,
    evidenceRefs: [],
    memoryKey: VALID_MEMORY_KEY,
  });

  assert.ok(result.warnings.length > 0, 'should have warnings');
});

test('strict category with all required fields passes with no warnings', () => {
  const result = assertDurableMemoryInputPolicy({
    category: CONVENTION_CATEGORY,
    confidence: 0.9,
    content: VALID_CONTENT,
    evidenceRefs: ['packages/foo/src/bar.ts'],
    memoryKey: VALID_MEMORY_KEY,
  });

  assert.equal(result.warnings.length, 0, 'should have no warnings');
});

test('architecture category with all required fields passes', () => {
  assert.doesNotThrow(() => {
    assertDurableMemoryInputPolicy({
      category: 'architecture',
      confidence: 0.85,
      content: VALID_CONTENT,
      evidenceRefs: [{ path: 'docs/decisions/0001.md', type: 'adr' }],
      memoryKey: 'test:arch-decision',
    });
  });
});

test('non-strict category does not require memoryKey', () => {
  assert.doesNotThrow(() => {
    assertDurableMemoryInputPolicy({
      category: 'decision',
      confidence: 0.8,
      content: VALID_CONTENT,
    });
  });
});

test('non-strict category does not require evidenceRefs', () => {
  assert.doesNotThrow(() => {
    assertDurableMemoryInputPolicy({
      category: 'bugfix',
      confidence: 0.7,
      content: VALID_CONTENT,
    });
  });
});

test('memoryKey error includes remediation guidance', () => {
  try {
    assertDurableMemoryInputPolicy({
      category: CONVENTION_CATEGORY,
      confidence: 0.9,
      content: VALID_CONTENT,
      evidenceRefs: ['file.ts'],
    });
    assert.fail('Expected error');
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes('Provide a stable key'), 'should include remediation guidance');
    assert.ok(error.message.includes('ai-memory-agent-rules.md'), 'should reference docs');
  }
});

test('evidenceRefs warning includes remediation guidance', () => {
  const result = assertDurableMemoryInputPolicy({
    category: 'architecture',
    confidence: 0.9,
    content: VALID_CONTENT,
    memoryKey: 'test:key',
  });

  assert.ok(result.warnings.length > 0, 'should have warnings');
  assert.ok(
    result.warnings[0]?.includes('Include at least one reference') === true,
    'should include remediation guidance',
  );
});

test('isStrictMetadataCategory returns true for strict categories', () => {
  assert.equal(isStrictMetadataCategory(CONVENTION_CATEGORY), true);
  assert.equal(isStrictMetadataCategory('architecture'), true);
  assert.equal(isStrictMetadataCategory('preference'), true);
  assert.equal(isStrictMetadataCategory('root-cause'), true);
});

test('isStrictMetadataCategory is case-insensitive', () => {
  assert.equal(isStrictMetadataCategory('Convention'), true);
  assert.equal(isStrictMetadataCategory('ARCHITECTURE'), true);
  assert.equal(isStrictMetadataCategory('Preference'), true);
  assert.equal(isStrictMetadataCategory('Root-Cause'), true);
  assert.equal(isStrictMetadataCategory('ROOT-CAUSE'), true);
});

test('isStrictMetadataCategory returns false for non-strict categories', () => {
  assert.equal(isStrictMetadataCategory('decision'), false);
  assert.equal(isStrictMetadataCategory('bugfix'), false);
  assert.equal(isStrictMetadataCategory(SESSION_SUMMARY_CATEGORY), false);
  assert.equal(isStrictMetadataCategory(''), false);
});

test('mixed-case strict category enforces memoryKey', () => {
  assert.throws(() => {
    assertDurableMemoryInputPolicy({
      category: 'Convention',
      confidence: 0.9,
      content: VALID_CONTENT,
      evidenceRefs: VALID_EVIDENCE_REFS,
    });
  }, /memoryKey is required/);
});

test('mixed-case strict category warns on missing evidenceRefs', () => {
  const result = assertDurableMemoryInputPolicy({
    category: 'ARCHITECTURE',
    confidence: 0.9,
    content: VALID_CONTENT,
    memoryKey: VALID_MEMORY_KEY,
  });

  assert.ok(result.warnings.length > 0, 'should have warnings');
});

test('strict category warns on empty object evidence ref', () => {
  const result = assertDurableMemoryInputPolicy({
    category: CONVENTION_CATEGORY,
    confidence: 0.9,
    content: VALID_CONTENT,
    evidenceRefs: [{}],
    memoryKey: VALID_MEMORY_KEY,
  });

  assert.ok(result.warnings.length > 0, 'should have warnings');
  assert.ok(result.warnings[0]?.includes('auditable') === true, 'warning should mention auditability');
});

test('strict category warns on object evidence ref with empty path', () => {
  const result = assertDurableMemoryInputPolicy({
    category: CONVENTION_CATEGORY,
    confidence: 0.9,
    content: VALID_CONTENT,
    evidenceRefs: [{ path: '' }],
    memoryKey: VALID_MEMORY_KEY,
  });

  assert.ok(result.warnings.length > 0, 'should have warnings');
});

test('strict category warns on empty string evidence ref', () => {
  const result = assertDurableMemoryInputPolicy({
    category: CONVENTION_CATEGORY,
    confidence: 0.9,
    content: VALID_CONTENT,
    evidenceRefs: [''],
    memoryKey: VALID_MEMORY_KEY,
  });

  assert.ok(result.warnings.length > 0, 'should have warnings');
});

test('strict category warns on whitespace-only string evidence ref', () => {
  const result = assertDurableMemoryInputPolicy({
    category: CONVENTION_CATEGORY,
    confidence: 0.9,
    content: VALID_CONTENT,
    evidenceRefs: ['  '],
    memoryKey: VALID_MEMORY_KEY,
  });

  assert.ok(result.warnings.length > 0, 'should have warnings');
});

test('strict category accepts object evidence ref with url field', () => {
  assert.doesNotThrow(() => {
    assertDurableMemoryInputPolicy({
      category: CONVENTION_CATEGORY,
      confidence: 0.9,
      content: VALID_CONTENT,
      evidenceRefs: [{ url: 'https://github.com/org/repo/pull/123' }],
      memoryKey: VALID_MEMORY_KEY,
    });
  });
});

test('strict category accepts object evidence ref with pr field', () => {
  assert.doesNotThrow(() => {
    assertDurableMemoryInputPolicy({
      category: 'architecture',
      confidence: 0.9,
      content: VALID_CONTENT,
      evidenceRefs: [{ pr: '#90006' }],
      memoryKey: VALID_MEMORY_KEY,
    });
  });
});

test('methodology category requires memoryKey', () => {
  assert.throws(() => {
    assertDurableMemoryInputPolicy({
      category: 'methodology',
      confidence: 0.9,
      content: VALID_CONTENT,
      evidenceRefs: VALID_EVIDENCE_REFS,
    });
  }, /memoryKey is required for 'methodology'/);
});

test('methodology category warns when evidenceRefs missing', () => {
  const result = assertDurableMemoryInputPolicy({
    category: 'methodology',
    confidence: 0.9,
    content: VALID_CONTENT,
    memoryKey: 'example/catalog:methodology:test:param',
  });

  assert.ok(result.warnings.length > 0, 'should have warnings');
  assert.ok(result.warnings[0]?.includes('evidenceRefs') === true);
});

test('methodology category with all fields passes with no warnings', () => {
  const result = assertDurableMemoryInputPolicy({
    category: 'methodology',
    confidence: 0.9,
    content: VALID_CONTENT,
    evidenceRefs: ['packages/ai-memory/src/db/taxonomy.ts'],
    memoryKey: 'example/catalog:methodology:test:param',
  });

  assert.equal(result.warnings.length, 0);
});

test('isStrictMetadataCategory returns true for methodology', () => {
  assert.equal(isStrictMetadataCategory('methodology'), true);
});

test('isStrictMetadataCategory returns true for Methodology (case-insensitive)', () => {
  assert.equal(isStrictMetadataCategory('Methodology'), true);
});
