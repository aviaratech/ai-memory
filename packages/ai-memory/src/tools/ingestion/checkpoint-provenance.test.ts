import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildContinuityPackFromFlush, formatContinuityPackMarkdown } from './continuity-pack.js';
import { parseFlushInput } from './flush-session.js';

test('automatic checkpoint distinguishes derived summary from carried-forward actions', () => {
  const built = buildContinuityPackFromFlush({
    nowIso: '2026-10-19T00:00:00.000Z',
    reflectionCount: 0,
    sessionId: 'session-a',
    scope: { type: 'task', id: 'session-a' },
    parsed: parseFlushInput({
      project: 'example/catalog',
      summary: 'Derived summary',
      nextActions: ['Keep the explicitly chosen action'],
      source: 'pre-compact',
    }),
    fieldProvenance: {
      summary: 'derived',
      nextActions: 'carry-forward',
      openQuestions: 'derived',
      contextNeeded: 'derived',
      decisions: 'derived',
    },
  });
  assert.equal(built.pack.provenance.fields?.summary, 'derived');
  assert.equal(built.pack.provenance.fields?.nextActions, 'carry-forward');
  const text = formatContinuityPackMarkdown({
    ...built,
    status: 'fresh',
    createdAt: undefined,
    updatedAt: undefined,
    sessionId: 'session-a',
  });
  assert.match(text, /summary=derived/u);
  assert.match(text, /nextActions=carry-forward/u);
});
