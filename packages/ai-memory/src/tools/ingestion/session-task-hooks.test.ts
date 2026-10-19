import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  runUserPromptSubmitHook,
  runPreCompactHook,
  runMemoryUsedHook,
  recordSessionCitationObservations,
  type TaskHookDependencies,
} from './session-task-hooks.js';
import { runSessionStartHook } from './session-start-hook.js';
import type {
  ContinuityPackReadResult,
  ContinuityPackRecord,
  writeAutomaticSessionCheckpoint,
} from '../../db/continuity-pack-api.js';

function fixture() {
  const calls: unknown[] = [];
  let eligible = true;
  const dependencies: TaskHookDependencies = {
    closePool: () => Promise.resolve(),
    consumePromptRetrieval: input => {
      calls.push(input);
      const winner = eligible;
      eligible = false;
      return Promise.resolve(winner);
    },
    ensurePostgresRunning: () => Promise.resolve({ ok: true }),
    initializeDatabase: () => Promise.resolve(),
    recordMemoryConsumption: input => {
      calls.push(input);
      return Promise.resolve();
    },
    resolveRepoIdFromCwd: () => Promise.resolve('example/catalog'),
    searchMemories: input => {
      calls.push(input);
      return Promise.resolve(
        Array.from({ length: 12 }, (_, index) => ({
          id: index + 41,
          category: 'architecture',
          createdAt: '2026-10-19T00:00:00.000Z',
          content: 'Seeded catalog topic. '.repeat(150),
          project: 'example/catalog',
        })),
      );
    },
  };
  return { calls, dependencies };
}

const payload = {
  hook_event_name: 'UserPromptSubmit',
  session_id: 'session-a',
  cwd: '/fixture',
  prompt: 'catalog topic',
};

test('first prompt includes the seeded memory ID within 3200 decoded characters; later prompts emit nothing', async () => {
  const { calls, dependencies } = fixture();
  const first = await runUserPromptSubmitHook(payload, dependencies, { CODEX: '1' });
  const context = first.hookSpecificOutput?.additionalContext;
  assert.ok(typeof context === 'string');
  assert.ok(context.length <= 3200);
  assert.match(context, /41/u);
  const second = await runUserPromptSubmitHook(payload, dependencies, { CODEX: '1' });
  assert.equal(second.hookSpecificOutput, undefined);
  const searchCalls = calls.filter(x => typeof x === 'object' && x !== null && 'query' in x);
  assert.equal(searchCalls.length, 1);
  assert.ok(
    !JSON.stringify(calls.filter(x => typeof x === 'object' && x !== null && 'memoryIds' in x)).includes(
      payload.prompt,
    ),
  );
});

test('unknown harness, missing session and missing project fail closed without retrieval', async () => {
  for (const input of [{ ...payload, session_id: '' }, payload]) {
    const { calls, dependencies } = fixture();
    const result = await runUserPromptSubmitHook(input, dependencies, {});
    assert.equal(result.hookSpecificOutput, undefined);
    assert.equal(calls.length, 0);
  }
  const { calls, dependencies } = fixture();
  dependencies.resolveRepoIdFromCwd = () => Promise.resolve(undefined);
  const result = await runUserPromptSubmitHook(payload, dependencies, { CODEX: '1' });
  assert.equal(result.hookSpecificOutput, undefined);
  assert.equal(calls.length, 0);
});

test('an uncertain claim suppresses search and never leaks its error or prompt', async () => {
  const { calls, dependencies } = fixture();
  dependencies.consumePromptRetrieval = () => Promise.reject(new Error('private provider URL or prompt'));
  const result = await runUserPromptSubmitHook(payload, dependencies, { CODEX: '1' });
  assert.equal(result.continue, true);
  assert.equal(result.hookSpecificOutput, undefined);
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.equal(calls.length, 0);
});

test('PreCompact writes only the current session checkpoint with derived provenance', async () => {
  const { dependencies } = fixture();
  const writes: unknown[] = [];
  const result = await runPreCompactHook(
    {
      hook_event_name: 'PreCompact',
      trigger: 'auto',
      session_id: 'session-a',
      cwd: '/fixture',
      transcript_path: '/synthetic/transcript',
    },
    {
      ...dependencies,
      readTranscript: () =>
        Promise.resolve([
          { type: 'session_meta', payload: { id: 'session-a', cwd: '/fixture' } },
          {
            type: 'event_msg',
            timestamp: '2026-10-19T00:00:00.000Z',
            payload: { type: 'agent_message', message: 'Next actions:\n- Verify the catalog.' },
          },
        ]),
      getContinuityPack: () =>
        Promise.resolve({ status: 'missing', project: 'example/catalog', scopeKey: 'task:example/catalog:session-a' }),
      writeAutomaticSessionCheckpoint: input => {
        writes.push(input);
        return Promise.resolve(true);
      },
    },
    { CODEX: '1' },
  );
  assert.equal(result.continue, true);
  assert.equal(writes.length, 1);
  assert.match(JSON.stringify(writes), /derived/u);
  assert.match(JSON.stringify(writes), /task/u);
  assert.ok(!JSON.stringify(writes).includes('project:example/catalog'));
});

test('only successful canonical ai-memory returned IDs become get observations', async () => {
  const response = {
    content: [{ type: 'text', text: JSON.stringify({ count: 1, memories: [{ id: 41, project: 'example/catalog' }] }) }],
  };
  for (const [toolName, toolResponse, expected] of [
    ['mcp__ai_memory__memory_get', response, 1],
    ['mcp__other__memory_get', response, 0],
    ['mcp__ai_memory__memory_get', { ...response, isError: true }, 0],
    ['mcp__ai_memory__memory_get', { error: 'failed', id: 41 }, 0],
  ] as const) {
    const { calls, dependencies } = fixture();
    const result = await runMemoryUsedHook(
      {
        hook_event_name: 'PostToolUse',
        session_id: 'session-a',
        cwd: '/fixture',
        tool_name: toolName,
        tool_response: toolResponse,
        tool_input: { id: 999, content: 'private request' },
      },
      dependencies,
      { CODEX: '1' },
    );
    assert.equal(result.continue, true);
    assert.equal(result.hookSpecificOutput, undefined);
    const observations = calls.filter(x => typeof x === 'object' && x !== null && 'memoryIds' in x);
    assert.equal(observations.length, expected);
    assert.ok(!JSON.stringify(observations).includes('999'));
    assert.ok(!JSON.stringify(observations).includes('private request'));
  }
});

test('PreCompact followed by compact startup restores its producing-session checkpoint', async () => {
  const { dependencies } = fixture();
  let saved: ContinuityPackReadResult = {
    status: 'missing',
    project: 'example/catalog',
    scopeKey: 'task:example/catalog:session-a',
  };
  await runPreCompactHook(
    {
      hook_event_name: 'PreCompact',
      trigger: 'auto',
      session_id: 'session-a',
      cwd: '/fixture',
      transcript_path: '/synthetic/transcript',
    },
    {
      ...dependencies,
      readTranscript: () =>
        Promise.resolve([
          { type: 'session_meta', payload: { id: 'session-a', cwd: '/fixture' } },
          {
            type: 'event_msg',
            timestamp: '2026-10-19T00:00:00.000Z',
            payload: {
              type: 'agent_message',
              message: 'SAME_SESSION_CHECKPOINT\nNext actions:\n- Verify the catalog.',
            },
          },
        ]),
      getContinuityPack: () => Promise.resolve(saved),
      writeAutomaticSessionCheckpoint: input => {
        saved = {
          status: 'found',
          pack: {
            ...input.checkpoint,
            sessionId: input.checkpoint.sessionId,
            scopeKey: 'task:example/catalog:session-a',
            payloadChars: input.checkpoint.payloadText.length,
            status: 'fresh',
            createdAt: undefined,
            updatedAt: undefined,
          },
        };
        return Promise.resolve(true);
      },
    },
    { CODEX: '1' },
  );
  const start = await runSessionStartHook(undefined, {
    sessionId: 'session-a',
    source: 'compact',
    host: 'codex',
    dependencies: {
      ...dependencies,
      armPromptRetrieval: () => {
        throw new Error('compact must never rearm');
      },
      getContinuityPack: () => Promise.resolve(saved),
      logAiMemoryInfo: () => {},
      logAiMemoryWarn: () => {},
      recallMemories: () => {
        throw new Error('matching checkpoint must win');
      },
      recordToolInvocation: () => Promise.resolve(),
      withTimeout: input => input.task(),
    },
  });
  assert.match(start.bootstrapText ?? '', /SAME_SESSION_CHECKPOINT/u);
  assert.match(start.bootstrapText ?? '', /session-a/u);
  assert.doesNotMatch(start.bootstrapText ?? '', /background project context/u);
});

test('citation observations retain original assistant timestamps and ignore user or timestamp-free markers', async () => {
  const { calls, dependencies } = fixture();
  await recordSessionCitationObservations(
    { session_id: 'session-a', cwd: '/fixture', transcript_path: '/synthetic/transcript' },
    {
      ...dependencies,
      getContinuityPack: () => {
        throw new Error('not used');
      },
      writeAutomaticSessionCheckpoint: () => {
        throw new Error('not used');
      },
      readTranscript: () =>
        Promise.resolve([
          { type: 'session_meta', payload: { id: 'session-a', cwd: '/fixture' } },
          {
            type: 'event_msg',
            timestamp: '2026-10-18T00:00:00.000Z',
            payload: { type: 'user_message', message: '[memory:99]' },
          },
          {
            type: 'event_msg',
            timestamp: '2026-10-18T01:00:00.000Z',
            payload: { type: 'agent_message', message: 'Applied [memory:41].' },
          },
          { type: 'event_msg', payload: { type: 'agent_message', message: 'Unknown time [memory:42].' } },
        ]),
    },
    { CODEX: '1' },
  );
  const observations = calls.filter(x => typeof x === 'object' && x !== null && 'memoryIds' in x);
  assert.deepEqual(observations, [
    {
      host: 'codex',
      project: 'example/catalog',
      sessionId: 'session-a',
      kind: 'used',
      memoryIds: [41],
      observation: 'citation',
      observedAt: '2026-10-18T01:00:00.000Z',
    },
  ]);
});

test('repeated compaction refreshes derived actions and preserves explicit field lineage', async () => {
  const { dependencies } = fixture();
  let saved: ContinuityPackReadResult = {
    status: 'missing',
    project: 'example/catalog',
    scopeKey: 'task:example/catalog:session-a',
  };
  function currentPack(): ContinuityPackRecord {
    assert.equal(saved.status, 'found');
    if (saved.status !== 'found') throw new Error('Checkpoint missing');
    return saved.pack;
  }
  let message = 'Next actions:\n- Implement X.';
  const hooks = {
    ...dependencies,
    readTranscript: () =>
      Promise.resolve([
        { type: 'session_meta', payload: { id: 'session-a', cwd: '/fixture' } },
        { type: 'event_msg', payload: { type: 'agent_message', message } },
      ]),
    getContinuityPack: () => Promise.resolve(saved),
    writeAutomaticSessionCheckpoint: (input: Parameters<typeof writeAutomaticSessionCheckpoint>[0]) => {
      saved = {
        status: 'found',
        pack: {
          ...input.checkpoint,
          sessionId: input.checkpoint.sessionId,
          scopeKey: 'task:example/catalog:session-a',
          payloadChars: input.checkpoint.payloadText.length,
          status: 'fresh',
          createdAt: undefined,
          updatedAt: undefined,
        },
      };
      return Promise.resolve(true);
    },
  };
  const input = {
    hook_event_name: 'PreCompact',
    session_id: 'session-a',
    cwd: '/fixture',
    transcript_path: '/fixture/transcript',
  };
  await runPreCompactHook(input, hooks, { CODEX: '1' });
  currentPack().pack.decisions = ['Explicit decision'];
  const provenance = currentPack().pack.provenance as { fields: Record<string, string> };
  provenance.fields.decisions = 'agent-authored';
  message = 'Completed X.\nNext actions:\n- Verify Y.';
  await runPreCompactHook(input, hooks, { CODEX: '1' });
  assert.deepEqual(currentPack().pack.nextActions, ['Verify Y.']);
  assert.deepEqual(currentPack().pack.decisions, ['Explicit decision']);
  assert.equal((currentPack().pack.provenance as typeof provenance).fields.nextActions, 'derived');
  assert.equal((currentPack().pack.provenance as typeof provenance).fields.decisions, 'carry-forward');
  message = 'Completed Y.\nNext actions:\n- Verify Z.';
  await runPreCompactHook(input, hooks, { CODEX: '1' });
  assert.deepEqual(currentPack().pack.nextActions, ['Verify Z.']);
  assert.deepEqual(currentPack().pack.decisions, ['Explicit decision']);
});

test('PreCompact refuses a different host automatic checkpoint before carrying or writing', async () => {
  const { dependencies } = fixture();
  let writes = 0;
  await runPreCompactHook(
    { hook_event_name: 'PreCompact', session_id: 'session-a', cwd: '/fixture', transcript_path: '/fixture/transcript' },
    {
      ...dependencies,
      readTranscript: () =>
        Promise.resolve([
          { type: 'session_meta', payload: { id: 'session-a', cwd: '/fixture' } },
          { type: 'event_msg', payload: { type: 'agent_message', message: 'Next actions:\n- Verify current task.' } },
        ]),
      getContinuityPack: () =>
        Promise.resolve({
          status: 'found',
          pack: {
            scopeKey: 'task:example/catalog:session-a',
            project: 'example/catalog',
            sessionId: 'session-a',
            source: 'pre-compact',
            pack: { nextActions: ['Foreign host action'], provenance: { agent: 'claude-code' } },
            budgetChars: 6000,
            payloadChars: 100,
            status: 'fresh',
            createdAt: undefined,
            updatedAt: undefined,
          },
        }),
      writeAutomaticSessionCheckpoint: () => {
        writes++;
        return Promise.resolve(true);
      },
    },
    { CODEX: '1' },
  );
  assert.equal(writes, 0);
});
