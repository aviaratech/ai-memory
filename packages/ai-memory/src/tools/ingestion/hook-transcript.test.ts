import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseHookTranscript } from './auto-session-ingest.js';

test('automatic hook transcript projection requires embedded identity and rejects mixed sessions', () => {
  const entry = {
    type: 'assistant',
    sessionId: 'session-a',
    cwd: '/fixture',
    timestamp: '2026-10-19T00:00:00.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Next: verify the catalog. [memory:41]' }] },
  };
  const result = parseHookTranscript({ entries: [entry], host: 'claude-code', sessionId: 'session-a' });
  assert.equal(result?.lastAssistantMessage, entry.message.content[0]?.text);
  assert.deepEqual(result?.workingDirectories, ['/fixture']);
  assert.equal(
    parseHookTranscript({ entries: [{ ...entry, sessionId: 'foreign' }], host: 'claude-code', sessionId: 'session-a' }),
    undefined,
  );
  assert.equal(
    parseHookTranscript({
      entries: [entry, { ...entry, sessionId: 'foreign' }],
      host: 'claude-code',
      sessionId: 'session-a',
    }),
    undefined,
  );
  assert.equal(
    parseHookTranscript({ entries: [{ ...entry, sessionId: undefined }], host: 'claude-code', sessionId: 'session-a' }),
    undefined,
  );
  assert.equal(
    parseHookTranscript({
      entries: [entry, { ...entry, sessionId: undefined }],
      host: 'claude-code',
      sessionId: 'session-a',
    }),
    undefined,
  );
});

test('Codex hook transcript identity comes from metadata, never a filename', () => {
  const entry = { type: 'session_meta', payload: { id: 'session-a', cwd: '/fixture' } };
  assert.ok(parseHookTranscript({ entries: [entry], host: 'codex', sessionId: 'session-a' }));
  assert.equal(
    parseHookTranscript({
      entries: [{ ...entry, payload: { ...entry.payload, id: 'foreign' } }],
      host: 'codex',
      sessionId: 'session-a',
    }),
    undefined,
  );
  assert.equal(parseHookTranscript({ entries: [], host: 'codex', sessionId: 'session-a' }), undefined);
});
