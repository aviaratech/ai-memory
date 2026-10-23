import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { logAiMemoryWarn } from '@aviaratech/ai-memory/internal';
import type * as Internal from '@aviaratech/ai-memory/internal';
import type * as SessionTaskHooks from './session-task-hooks.js';
import * as autoIngest from './auto-session-ingest.js';
import { runIngestPipeline } from './pipeline.js';
import { isGrokSessionEndHook, runSessionEndHook } from './session-end-hook.js';
import { recordSessionCitationObservations } from './session-task-hooks.js';

vi.mock('@aviaratech/ai-memory/internal', async importOriginal => ({
  ...(await importOriginal<typeof Internal>()),
  logAiMemoryInfo: vi.fn(),
  logAiMemoryWarn: vi.fn(),
  probeEnvironment: vi.fn(() => ({ environment: {} })),
}));
vi.mock('./pipeline.js', () => ({ runIngestPipeline: vi.fn() }));
vi.mock('./session-task-hooks.js', async importOriginal => ({
  ...(await importOriginal<typeof SessionTaskHooks>()),
  recordSessionCitationObservations: vi.fn(),
}));

const payload = {
  hook_event_name: 'Stop',
  session_id: 'synthetic-host-session',
  transcript_path: '/synthetic/session.jsonl',
  cwd: '/synthetic/project',
  repo_id: 'example/catalog',
};

beforeEach(() => {
  for (const key of [
    'CODEX',
    'PLUGIN_ROOT',
    'CLAUDECODE',
    'CLAUDE_PLUGIN_ROOT',
    'AI_AGENT_IDENTITY',
    'GROK_HOOK_EVENT',
  ]) {
    vi.stubEnv(key, undefined);
  }
  vi.mocked(runIngestPipeline).mockResolvedValue({ flushed: true, sessionId: payload.session_id });
  vi.mocked(recordSessionCitationObservations).mockResolvedValue();
  vi.spyOn(autoIngest, 'closeAiMemoryPool').mockResolvedValue();
  vi.spyOn(autoIngest, 'recordAutoIngestionFailure').mockResolvedValue();
  vi.spyOn(autoIngest, 'findLatestCodexSessionFile').mockReturnValue(undefined);
  vi.spyOn(autoIngest, 'parseClaudeTranscriptSummary').mockReturnValue({
    assistantMessageCount: 1,
    userMessageCount: 1,
    lineCount: 2,
    history: [],
    lastAssistantMessage: 'Claude response',
    lastUserMessage: 'Claude prompt',
    sessionSummary: 'Claude summary',
    toolCallCount: 3,
  });
  vi.spyOn(autoIngest, 'parseCodexSessionSummary').mockReturnValue({
    agentMessageCount: 1,
    userMessageCount: 1,
    history: [],
    lastAssistantMessage: 'Codex response',
    lastUserMessage: 'Codex prompt',
    createdAt: undefined,
    cwd: undefined,
    model: undefined,
    repoId: undefined,
    requestedModel: undefined,
    resolvedModel: undefined,
    modelResolutionStatus: undefined,
    modelResolutionError: undefined,
    sessionId: payload.session_id,
    toolCallCount: 4,
  });
  vi.spyOn(autoIngest, 'loadGrokSessionExport').mockResolvedValue({
    history: [],
    lastAssistantMessage: 'Grok response',
    lastUserMessage: 'Grok prompt',
    toolCallCount: 5,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

for (const [key, value] of [
  ['CLAUDECODE', '1'],
  ['CLAUDE_PLUGIN_ROOT', '/synthetic/plugin'],
  ['AI_AGENT_IDENTITY', 'claude-code'],
]) {
  for (const event of ['Stop', 'SessionEnd']) {
    test(`Claude ${event} uses its ${key} signal, never the event name`, async () => {
      vi.stubEnv(key!, value);
      assert.equal((await runSessionEndHook({ payload: { ...payload, hook_event_name: event } })).ingested, true);
      const input = vi.mocked(runIngestPipeline).mock.calls[0]?.[0] as autoIngest.AutoMemoryDeltaInput;
      assert.equal(input.agent, 'claude-code');
      assert.equal(input.source, 'claude-session-end');
      assert.equal(vi.mocked(autoIngest.parseClaudeTranscriptSummary).mock.calls.length, 1);
      assert.equal(vi.mocked(autoIngest.parseCodexSessionSummary).mock.calls.length, 0);
    });
  }
}

for (const [key, value] of [
  ['CODEX', '1'],
  ['PLUGIN_ROOT', '/synthetic/plugin'],
  ['AI_AGENT_IDENTITY', 'codex'],
]) {
  test(`Codex Stop uses its ${key} signal and retains the Codex dedupe namespace`, async () => {
    vi.stubEnv(key!, value);
    assert.equal((await runSessionEndHook({ payload })).ingested, true);
    assert.deepEqual(
      vi.mocked(runIngestPipeline).mock.calls.map(([input]) => {
        const { agent, source, dedupeNamespace, assistantMessage } = input as autoIngest.AutoMemoryDeltaInput;
        return { agent, source, dedupeNamespace, assistantMessage };
      }),
      [{ agent: 'codex-cli', source: 'codex-hook', dedupeNamespace: 'codex', assistantMessage: 'Codex response' }],
    );
    assert.equal(vi.mocked(autoIngest.parseClaudeTranscriptSummary).mock.calls.length, 0);
  });
}

test('Grok SessionEnd retains its explicit marker priority over ambient host signals', async () => {
  vi.stubEnv('GROK_HOOK_EVENT', 'SessionEnd');
  vi.stubEnv('CODEX', '1');
  vi.stubEnv('CLAUDECODE', '1');
  assert.equal((await runSessionEndHook({ payload: { ...payload, hook_event_name: 'SessionEnd' } })).ingested, true);
  const input = vi.mocked(runIngestPipeline).mock.calls[0]?.[0] as autoIngest.AutoMemoryDeltaInput;
  assert.equal(input.agent, 'grok-build');
  assert.equal(input.source, 'grok-session-end');
  assert.equal(input.assistantMessage, 'Grok response');
  assert.equal(vi.mocked(autoIngest.parseCodexSessionSummary).mock.calls.length, 0);
  assert.equal(vi.mocked(autoIngest.parseClaudeTranscriptSummary).mock.calls.length, 0);
});

for (const event of ['Stop', 'SessionEnd']) {
  for (const conflicting of [false, true]) {
    test(`${event} with ${conflicting ? 'conflicting' : 'no'} host signals warns and records unknown without host reads`, async () => {
      if (conflicting) {
        vi.stubEnv('CODEX', '1');
        vi.stubEnv('CLAUDE_PLUGIN_ROOT', '/synthetic/plugin');
      }
      assert.equal((await runSessionEndHook({ payload: { ...payload, hook_event_name: event } })).ingested, true);
      const input = vi.mocked(runIngestPipeline).mock.calls[0]?.[0] as autoIngest.AutoMemoryDeltaInput;
      assert.equal(input.agent, 'unknown');
      assert.equal(input.source, 'session-end');
      assert.equal(input.assistantMessage, undefined);
      assert.equal(vi.mocked(logAiMemoryWarn).mock.calls[0]?.[0], 'hook.session_end_unknown_host');
      assert.equal(
        vi.mocked(logAiMemoryWarn).mock.calls[0]?.[1]?.message,
        'Session-end host signal missing or conflicting; recording agent unknown.',
      );
      for (const fn of [
        autoIngest.findLatestCodexSessionFile,
        autoIngest.parseCodexSessionSummary,
        autoIngest.parseClaudeTranscriptSummary,
        autoIngest.loadGrokSessionExport,
        recordSessionCitationObservations,
      ]) {
        assert.equal(vi.mocked(fn).mock.calls.length, 0);
      }
    });
  }
}

test('Grok SessionEnd detection requires both the supported hook event and environment marker', () => {
  assert.equal(
    isGrokSessionEndHook(
      { hookEventName: 'SessionEnd', sessionId: 'grok-session-fixture' },
      { GROK_HOOK_EVENT: 'SessionEnd' },
    ),
    true,
  );
  assert.equal(
    isGrokSessionEndHook(
      { hookEventName: 'SessionEnd', sessionId: 'grok-session-fixture' },
      { GROK_HOOK_EVENT: 'PreToolUse' },
    ),
    false,
  );
  assert.equal(
    isGrokSessionEndHook(
      { hookEventName: 'Stop', sessionId: 'codex-session-fixture' },
      { GROK_HOOK_EVENT: 'SessionEnd' },
    ),
    false,
  );
});

test('unknown host without a transcript never discovers local Codex sessions', async () => {
  assert.equal((await runSessionEndHook({ payload: { ...payload, transcript_path: undefined } })).ingested, true);
  assert.equal(vi.mocked(autoIngest.findLatestCodexSessionFile).mock.calls.length, 0);
});

test('unknown host ingestion failure retains neutral provenance and fails open', async () => {
  vi.mocked(runIngestPipeline).mockRejectedValueOnce(new Error('Synthetic ingestion failure'));
  assert.deepEqual(await runSessionEndHook({ payload }), {
    continue: true,
    ingested: false,
    suppressOutput: true,
    warning: 'Synthetic ingestion failure',
  });
  const failure = vi.mocked(autoIngest.recordAutoIngestionFailure).mock.calls[0]?.[0];
  assert.equal(failure?.agent, 'unknown');
  assert.equal(failure?.source, 'session-end');
  assert.equal(vi.mocked(autoIngest.closeAiMemoryPool).mock.calls.length, 1);
});
