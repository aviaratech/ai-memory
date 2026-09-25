import assert from 'node:assert/strict';
import { test } from 'vitest';

import { formatMemoryPayload } from './memory-projection.js';

test('compact memory projection keeps source links and status while deferring full content', () => {
  const content = 'Detailed multi-page evidence body that should not be returned by default search previews.';
  const projected = formatMemoryPayload({
    fullContentTopN: 0,
    memories: [
      {
        agent: 'tech-lead',
        category: 'decision',
        content,
        evidenceRefs: [
          { type: 'github_issue', url: 'https://github.com/example/catalog/issues/2930' },
          { type: 'github_pr', url: 'https://github.com/example/catalog/pull/2930' },
          { type: 'session', url: 'codex://session/lead-session-2930' },
        ],
        id: 2930,
        memoryKey: 'example/catalog:primary-cross-harness-memory-2026-09-08',
        sessionId: 'lead-session-2930',
        source: 'codex-hook',
        status: 'superseded',
      },
    ],
    memoryDetail: 'compact',
  });

  assert.deepEqual(projected, [
    {
      agent: 'tech-lead',
      category: 'decision',
      evidenceRefs: [
        { type: 'github_issue', url: 'https://github.com/example/catalog/issues/2930' },
        { type: 'github_pr', url: 'https://github.com/example/catalog/pull/2930' },
      ],
      excerpt: content,
      id: 2930,
      memoryKey: 'example/catalog:primary-cross-harness-memory-2026-09-08',
      sessionId: 'lead-session-2930',
      source: 'codex-hook',
      status: 'superseded',
    },
  ]);
});

test('compact memory projection permits an explicit top-N content expansion', () => {
  const projected = formatMemoryPayload({
    fullContentTopN: 1,
    memories: [
      { content: 'First detail.', id: 1 },
      { content: 'Second detail.', id: 2 },
    ],
    memoryDetail: 'compact',
  });

  assert.deepEqual(projected, [
    { content: 'First detail.', excerpt: 'First detail.', id: 1 },
    { excerpt: 'Second detail.', id: 2 },
  ]);
});

test('search-only preview bounds oversized metadata without changing other projector callers', () => {
  const memory = {
    content: 'body',
    evidenceRefs: [`https://example.com/${'r'.repeat(4000)}`],
    id: 7,
    signals: { oversized: 's'.repeat(4000) },
    source: 'x'.repeat(4000),
    tags: Array.from({ length: 100 }, () => 'tag'.repeat(1000)),
  };
  const [bounded] = formatMemoryPayload({
    boundPreview: true,
    fullContentTopN: 0,
    memories: [memory],
    memoryDetail: 'compact',
  });
  assert.ok(JSON.stringify(bounded).length < 4000);
  assert.equal((bounded as Record<string, unknown>).id, 7);
  assert.equal((bounded as Record<string, unknown>).previewTruncated, true);
  const [unchanged] = formatMemoryPayload({ fullContentTopN: 0, memories: [memory], memoryDetail: 'compact' });
  assert.equal((unchanged as Record<string, unknown>).source, memory.source);
  assert.deepEqual(
    formatMemoryPayload({ boundPreview: true, fullContentTopN: 0, memories: [memory], memoryDetail: 'full' }),
    [memory],
  );
});

test('query preview selects late supporting conditions and their evidence while preserving lineage', () => {
  const condition =
    'Do not activate the installation unless the operator approves the exact release and the recorded rollback check passes; a successful source merge alone does not authorize activation.';
  const memory = {
    content: 'Archive export notes describe layout and examples. '.repeat(6) + condition,
    evidenceRefs: [
      'https://example.invalid/evidence/layout',
      'https://example.invalid/evidence/headings',
      'https://example.invalid/evidence/activation-approval',
    ],
    id: 8301,
    status: 'active',
    supersedesId: 8300,
  };
  const [result] = formatMemoryPayload({
    boundPreview: true,
    fullContentTopN: 0,
    memories: [memory],
    memoryDetail: 'compact',
    query: 'When may the installation be activated?',
  });
  const projected = result as Record<string, unknown>;
  assert.ok(typeof projected.excerpt === 'string');
  assert.ok(projected.excerpt.includes(condition), projected.excerpt);
  assert.ok(projected.excerpt.length <= 240);
  assert.match(projected.excerpt, /memory_get/u);
  assert.equal(projected.supersedesId, 8300);
  assert.deepEqual(projected.evidenceRefs, [memory.evidenceRefs[2], memory.evidenceRefs[0]]);
  assert.equal(
    memory.evidenceRefs[0],
    'https://example.invalid/evidence/layout',
    'projection must not reorder source evidence',
  );
});

test('an overlong conditional passage is explicitly incomplete and contested status survives', () => {
  const [result] = formatMemoryPayload({
    boundPreview: true,
    fullContentTopN: 0,
    memories: [
      {
        content: `Activation is permitted only if ${'the exact release approval and every prerequisite are verified, '.repeat(8)}otherwise do not activate.`,
        id: 8302,
        status: 'contested',
        supersedesId: 8301,
      },
    ],
    memoryDetail: 'compact',
    query: 'Is activation permitted?',
  });
  const projected = result as Record<string, unknown>;
  assert.equal(projected.status, 'contested');
  assert.equal(projected.supersedesId, 8301);
  assert.ok(typeof projected.excerpt === 'string');
  assert.match(projected.excerpt, /incomplete passage; use memory_get/u);
  assert.ok(projected.excerpt.length <= 240);
});
