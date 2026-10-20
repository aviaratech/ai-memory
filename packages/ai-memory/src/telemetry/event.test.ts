import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'vitest';
import { parseTelemetryEvent, projectHostTelemetry, projectIdForTelemetry, projectOpenAIUsage } from './event.js';

const projectId = `sha256:${'a'.repeat(64)}`;
const edge = {
  schemaVersion: 1,
  kind: 'edge',
  source: 'producer',
  producer: 'synthetic',
  eventId: 'event-1',
  projectId,
  taskId: 'task-1',
  stage: 'verify',
  edge: 'failure',
  evidenceIds: ['proof-1'],
};
const usage = {
  schemaVersion: 1,
  kind: 'usage',
  source: 'openai-responses',
  producer: 'synthetic',
  eventId: 'usage-1',
  responseId: 'response-1',
};

test('normalizes absent observations without manufacturing usage, identity or time', () => {
  const result = parseTelemetryEvent(edge);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.event.usage, null);
  assert.equal(result.event.observedAt, null);
  assert.equal(result.event.sessionId, null);
  assert.equal(result.event.executionMs, null);
  assert.equal(result.event.dedupCoverage, 'producer-stable');
  const binding = parseTelemetryEvent({
    ...edge,
    kind: 'correlation',
    edge: null,
    host: 'codex',
    sessionId: 'session-1',
  });
  assert.equal(binding.ok, true);
  assert.equal(parseTelemetryEvent({ ...usage, usage: null }).ok, true);
});

test('known measured zero differs from unknown and preserves provider subsets', () => {
  assert.deepEqual(
    projectOpenAIUsage({
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 80, cache_write_tokens: 10 },
      output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 5 },
      total_tokens: 120,
    }),
    {
      inputTokens: 100,
      cachedInputTokens: 80,
      cacheWriteInputTokens: 10,
      outputTokens: 20,
      reasoningOutputTokens: 5,
      accounting: 'openai-responses',
    },
  );
  assert.equal(projectOpenAIUsage({ input_tokens: 100 }).cachedInputTokens, null);
  assert.equal(
    projectOpenAIUsage({ input_tokens: 100, input_tokens_details: { cached_tokens: 0 } }).cachedInputTokens,
    0,
  );
  assert.equal(projectOpenAIUsage({ input_tokens: 100 }).cacheWriteInputTokens, null);
  assert.equal(
    projectIdForTelemetry('example/project'),
    `sha256:${createHash('sha256').update('example/project').digest('hex')}`,
  );
  assert.notEqual(projectIdForTelemetry('example/project'), projectIdForTelemetry('example/Project'));
});

for (const invalid of [
  { input_tokens: -1 },
  { output_tokens: 0.5 },
  { input_tokens: Number.MAX_SAFE_INTEGER + 1 },
  { input_tokens: 10, input_tokens_details: { cached_tokens: 11 } },
  { input_tokens: 10, input_tokens_details: { cached_tokens: 8, cache_write_tokens: 3 } },
  { output_tokens: 1, output_tokens_details: { reasoning_tokens: 2 } },
  { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 },
  { input_tokens: 10, output_tokens: 2, total_tokens: 13 },
  { input_tokens_details: { prompt: 'PRIVATE_SENTINEL' } },
  { arbitrary: 1 },
])
  test(`rejects invalid provider usage ${JSON.stringify(invalid)}`, () => {
    assert.deepEqual(parseTelemetryEvent({ ...usage, usage: invalid }), { ok: false, code: 'invalid_usage' });
  });

for (const invalid of [
  { ...edge, prompt: 'PRIVATE_SENTINEL' },
  { ...edge, schemaVersion: 2 },
  { ...edge, eventId: 'a'.repeat(129) },
  { ...edge, producer: 'a'.repeat(65) },
  { ...edge, taskId: '/tmp/private' },
  { ...edge, projectId: 'example/project' },
  { ...edge, observedAt: '2026-02-30T00:00:00.000Z' },
  { ...edge, observedAt: '2026-01-01T00:00:00+01:00' },
  { ...edge, executionMs: -1 },
  { ...edge, attempt: 0 },
  { ...edge, evidenceIds: Array.from({ length: 9 }, (_, i) => `e${String(i)}`) },
  { ...edge, evidenceIds: ['e1', 'e1'] },
  { ...edge, evidenceIds: [] },
  { ...edge, edge: 'accepted' },
  { ...edge, relatedEvent: { producer: 'x', eventId: 'y' } },
  { ...edge, edge: 'correction', relatedEvent: { producer: 'x', eventId: 'y', body: 'PRIVATE_SENTINEL' } },
  { ...edge, usage: { input_tokens: 1 } },
  { ...usage, responseId: null },
  { ...edge, kind: 'host', host: 'codex', hostEvent: 'Stop' },
  { ...edge, kind: 'correlation', edge: null, host: 'codex', sessionId: null },
])
  test(`rejects invalid event ${JSON.stringify(invalid).slice(0, 160)}`, () => {
    const result = parseTelemetryEvent(invalid);
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes('PRIVATE_SENTINEL'), false);
  });

test('accepts safe numeric and identifier boundaries and explicit referenced outcomes', () => {
  assert.equal(
    parseTelemetryEvent({
      ...edge,
      producer: 'a'.repeat(64),
      eventId: 'x'.repeat(128),
      executionMs: Number.MAX_SAFE_INTEGER,
      attempt: 1,
      queueMs: 0,
      observedAt: '2026-01-01T00:00:00Z',
      evidenceIds: Array.from({ length: 8 }, (_, i) => `e${String(i)}`),
    }).ok,
    true,
  );
  assert.equal(
    parseTelemetryEvent({ ...edge, edge: 'accepted', relatedEvent: { producer: 'synthetic', eventId: 'event-0' } }).ok,
    true,
  );
});

test('rejects non-data, excessive depth and oversized input without calling getters or toJSON', () => {
  let calls = 0;
  const accessor = Object.defineProperty({ ...edge }, 'prompt', {
    enumerable: true,
    get() {
      calls++;
      return 'PRIVATE_SENTINEL';
    },
  });
  assert.equal(parseTelemetryEvent(accessor).ok, false);
  assert.equal(
    parseTelemetryEvent({
      ...edge,
      toJSON() {
        calls++;
        return edge;
      },
    }).ok,
    false,
  );
  assert.equal(parseTelemetryEvent(Object.assign(Object.create({ private: true }), edge)).ok, false);
  assert.equal(parseTelemetryEvent({ ...edge, [Symbol('private')]: 1 }).ok, false);
  assert.equal(parseTelemetryEvent({ ...edge, extra: { a: { b: { c: { d: 1 } } } } }).ok, false);
  assert.deepEqual(parseTelemetryEvent({ ...edge, extra: 'x'.repeat(16 * 1024) }), { ok: false, code: 'oversized' });
  assert.equal(calls, 0);
});

test('Codex stable Stop replays identically while opaque host content never enters the event', () => {
  const payload = {
    hook_event_name: 'Stop',
    session_id: 'session-1',
    turn_id: 'turn-1',
    cwd: '/do/not/read',
    transcript_path: '/do/not/read',
    prompt: 'PRIVATE_SENTINEL',
    last_assistant_message: 'PRIVATE_SENTINEL',
  };
  const first = projectHostTelemetry('codex', payload, () => 'first');
  const replay = projectHostTelemetry('codex', payload, () => 'second');
  assert.deepEqual(first, replay);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.event.dedupCoverage, 'host-turn');
  assert.equal(first.event.taskId, null);
  assert.equal(first.event.projectId, null);
  assert.equal(first.event.observedAt, null);
  assert.equal(first.event.usage, null);
  assert.equal(JSON.stringify(first).includes('PRIVATE_SENTINEL'), false);
  assert.equal(JSON.stringify(first).includes('/do/not/read'), false);
});

test('Claude Stop does not invent stable turn identity, usage or model; SessionStart may report model', () => {
  const payload = {
    hook_event_name: 'Stop',
    session_id: 'session-1',
    model: 'not-documented-here',
    turn_id: 'not-documented-here',
  };
  const first = projectHostTelemetry('claude-code', payload, () => 'first');
  const second = projectHostTelemetry('claude-code', payload, () => 'second');
  assert.notDeepEqual(first, second);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.event.dedupCoverage, 'invocation-only');
  assert.equal(first.event.model, null);
  assert.equal(first.event.turnId, null);
  assert.equal(first.event.usage, null);
  const start = projectHostTelemetry(
    'claude-code',
    { hook_event_name: 'SessionStart', session_id: 's1', model: 'model-1' },
    () => 'third',
  );
  assert.equal(start.ok && start.event.model, 'model-1');
  assert.equal(projectHostTelemetry('codex', { hook_event_name: 'Unsupported' }, () => 'fourth').ok, false);
});

test('host projection ignores unknown getters and rejects accessors on projected fields', () => {
  let calls = 0;
  const payload = Object.defineProperty({ hook_event_name: 'Stop' }, 'transcript_path', {
    get() {
      calls++;
      throw new Error('PRIVATE_SENTINEL');
    },
  });
  assert.equal(projectHostTelemetry('codex', payload, () => 'first').ok, true);
  Object.defineProperty(payload, 'session_id', {
    get() {
      calls++;
      return 'private';
    },
  });
  assert.equal(projectHostTelemetry('codex', payload, () => 'second').ok, false);
  assert.equal(calls, 0);
});

test('enforces UTF-8 wire bytes at the exact boundary and rejects hidden producer properties', () => {
  const skeleton = { ...edge, extra: '' };
  const emptyBytes = Buffer.byteLength(JSON.stringify(skeleton));
  assert.deepEqual(parseTelemetryEvent({ ...skeleton, extra: 'x'.repeat(16 * 1024 - emptyBytes) }), {
    ok: false,
    code: 'invalid_event',
  });
  assert.deepEqual(parseTelemetryEvent({ ...skeleton, extra: 'x'.repeat(16 * 1024 - emptyBytes + 1) }), {
    ok: false,
    code: 'oversized',
  });
  assert.deepEqual(parseTelemetryEvent({ ...skeleton, extra: 'é'.repeat(8192) }), { ok: false, code: 'oversized' });
  assert.equal(
    parseTelemetryEvent(Object.defineProperty({ ...edge }, 'private', { value: 'PRIVATE_SENTINEL' })).ok,
    false,
  );
});
