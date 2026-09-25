import assert from 'node:assert/strict';
import { beforeEach, test } from 'vitest';

import {
  runSessionStartHook,
  serializeSessionStartHook,
  type SessionStartHookDependencies,
} from './session-start-hook.js';

type OrientResult = Awaited<ReturnType<SessionStartHookDependencies['orientMemory']>>;

const hookState: {
  continuityError: Error | undefined;
  continuityInputs: unknown[];
  continuityPack: Awaited<ReturnType<SessionStartHookDependencies['getContinuityPack']>>;
  infoEvents: { event: string; fields: Record<string, unknown> }[];
  memories: { category: string; confidence: number; content: string }[];
  orientError: Error | undefined;
  orientInputs: unknown[];
  orientResult: OrientResult | undefined;
  postgresStatus: Awaited<ReturnType<SessionStartHookDependencies['ensurePostgresRunning']>>;
  repoId: string | undefined;
  timeoutError: Error | undefined;
  timeoutInputs: { operation: string; timeoutMs: number }[];
  toolInvocations: Parameters<SessionStartHookDependencies['recordToolInvocation']>[0][];
  warnEvents: { event: string; fields: Record<string, unknown> }[];
} = {
  continuityError: undefined,
  continuityInputs: [],
  continuityPack: { project: 'example/catalog', scopeKey: 'project:example/catalog', status: 'missing' },
  infoEvents: [],
  memories: [],
  orientError: undefined,
  orientInputs: [],
  orientResult: undefined,
  postgresStatus: { ok: true },
  repoId: 'example/catalog',
  timeoutError: undefined,
  timeoutInputs: [],
  toolInvocations: [],
  warnEvents: [],
};
const TEST_CWD = '/workspace/aviaratech-ai';

const TEST_DEPENDENCIES: SessionStartHookDependencies = {
  closePool: () => Promise.resolve(),
  ensurePostgresRunning: () => Promise.resolve(hookState.postgresStatus),
  getContinuityPack: (input: unknown) => {
    hookState.continuityInputs.push(input);
    if (hookState.continuityError !== undefined) {
      throw hookState.continuityError;
    }
    const request = input as { project: string; task?: string };
    if (
      request.task !== undefined &&
      hookState.continuityPack.status === 'found' &&
      hookState.continuityPack.pack.scopeKey !== `task:${request.project}:${request.task}`
    ) {
      return Promise.resolve({
        project: request.project,
        scopeKey: `task:${request.project}:${request.task}`,
        status: 'missing',
      });
    }
    return Promise.resolve(hookState.continuityPack);
  },
  initializeDatabase: () => Promise.resolve(),
  logAiMemoryInfo: (event, fields) => {
    hookState.infoEvents.push({ event, fields });
  },
  logAiMemoryWarn: (event, fields) => {
    hookState.warnEvents.push({ event, fields });
  },
  orientMemory: (input: unknown) => {
    hookState.orientInputs.push(input);
    if (hookState.orientError !== undefined) {
      throw hookState.orientError;
    }
    if (hookState.orientResult === undefined) {
      throw new Error('orient result fixture missing');
    }
    return Promise.resolve(hookState.orientResult);
  },
  recallMemories: () => Promise.resolve(hookState.memories),
  recordToolInvocation: input => {
    hookState.toolInvocations.push(input);
    return Promise.resolve();
  },
  resolveRepoIdFromCwd: () => Promise.resolve(hookState.repoId),
  withTimeout: input => {
    hookState.timeoutInputs.push({ operation: input.operation, timeoutMs: input.timeoutMs });
    if (hookState.timeoutError !== undefined) {
      return Promise.reject(hookState.timeoutError);
    }
    return input.task();
  },
};

beforeEach(() => {
  hookState.continuityError = undefined;
  hookState.continuityInputs = [];
  hookState.continuityPack = { project: 'example/catalog', scopeKey: 'project:example/catalog', status: 'missing' };
  hookState.infoEvents = [];
  hookState.memories = [
    {
      category: 'decision',
      confidence: 0.9,
      content: 'Recall remains available before auto-orient output is appended.',
    },
  ];
  hookState.orientError = undefined;
  hookState.orientInputs = [];
  hookState.orientResult = buildOrientResult();
  hookState.postgresStatus = { ok: true };
  hookState.repoId = 'example/catalog';
  hookState.timeoutError = undefined;
  hookState.timeoutInputs = [];
  hookState.toolInvocations = [];
  hookState.warnEvents = [];
});

test('session-start hook prepends bounded cross-chat continuity pack when one exists', async () => {
  hookState.continuityPack = {
    pack: {
      budgetChars: 1600,
      createdAt: '2026-06-28T19:58:00.000Z',
      pack: {
        decisions: ['Use a pre-materialized read model rather than session-start fanout.'],
        nextActions: ['Wire continuity pack refresh into the existing post-commit reflection path.'],
        openQuestions: ['Should stale packs render a warning line or only telemetry?'],
        provenance: {
          sessionId: 'previous-session',
          source: 'manual-flush',
        },
        summary:
          'Cross-chat continuity design was approved: session-start reads one bounded pack, session-end refreshes it from flush/compaction.',
      },
      payloadChars: 580,
      project: 'example/catalog',
      scopeKey: 'project:example/catalog',
      sessionId: 'previous-session',
      source: 'manual-flush',
      status: 'fresh',
      updatedAt: '2026-06-28T20:00:00.000Z',
    },
    status: 'found',
  };

  const outcome = await runSessionStartHook(undefined, {
    cwd: TEST_CWD,
    dependencies: TEST_DEPENDENCIES,
    hookEventName: 'SessionStart',
    sessionId: 'session-123',
  });

  assert.deepEqual(hookState.continuityInputs[0], {
    project: 'example/catalog',
    task: 'session-123',
  });
  assert.deepEqual(hookState.continuityInputs[1], { project: 'example/catalog' });
  assert.deepEqual(
    hookState.timeoutInputs.find(input => input.operation === 'memory_continuity_pack.session_start'),
    {
      operation: 'memory_continuity_pack.session_start',
      timeoutMs: 500,
    },
    'startup continuity should remain a bounded materialized-pack read, not query fanout',
  );
  const bootstrapText = readBootstrapText(outcome);
  assert.match(bootstrapText, /Cross-Chat Continuity/u);
  assert.match(bootstrapText, /pre-materialized read model/u);
  assert.match(bootstrapText, /Wire continuity pack refresh/u);
  assert.ok(
    bootstrapText.indexOf('Cross-Chat Continuity') < bootstrapText.indexOf('Recent Memories'),
    'continuity pack should orient the agent before recent memory recall',
  );

  const invocation = findToolInvocation('memory_continuity_pack');
  assert.ok(invocation !== undefined, 'continuity-pack read should record telemetry');
  assert.equal(invocation.sessionId, 'session-123');
  assert.equal(invocation.project, 'example/catalog');
  assert.equal(invocation.responseStatus, 'found');
});

test('session-start hook runs orient and appends orientation to bootstrap text', async () => {
  const outcome = await runSessionStartHook(undefined, {
    cwd: TEST_CWD,
    dependencies: TEST_DEPENDENCIES,
    hookEventName: 'SessionStart',
    sessionId: 'session-123',
  });

  assert.equal(hookState.orientInputs.length, 1, 'hook should run orient once');
  assert.deepEqual(hookState.orientInputs[0], {
    cwd: TEST_CWD,
    envProbe: 'local',
    memoryDetail: 'compact',
    project: 'example/catalog',
    source: 'session-start-hook',
    stateModel: {
      assumptions: [],
      constraints: [],
      strategy_confidence: 'medium',
      uncertainty: [],
    },
  });
  assert.deepEqual(
    hookState.timeoutInputs.find(input => input.operation === 'memory_orient.session_start'),
    {
      operation: 'memory_orient.session_start',
      timeoutMs: 22_000,
    },
  );

  const bootstrapText = readBootstrapText(outcome);
  assert.match(bootstrapText, /Recent Memories/u, 'recall output should remain in bootstrap text');
  assert.match(bootstrapText, /Memory Orientation/u, 'orient output should be appended');
  assert.match(bootstrapText, /truncatedSections: taskRelevant/u, 'payload truncation should be surfaced');
  assert.match(bootstrapText, /payload: 7200 chars \/ 8000 budget/u, 'payload budget summary should be surfaced');

  const invocation = findToolInvocation('memory_orient');
  assert.ok(invocation !== undefined, 'auto-orient should record telemetry');
  assert.equal(invocation.status, 'ok');
  assert.equal(invocation.toolCategory, 'read');
  assert.deepEqual(invocation.summaryFields, {
    detected_source: 'session-start-hook',
    environment_status: 'local',
    orient_payload_budget_chars: 8000,
    orient_payload_budget_exceeded: 0,
    orient_payload_chars: 7200,
    orient_payload_tokens_estimate: 1800,
    source: 'session-start-hook',
  });
});

test('session-start hook preserves environment-only unavailability separately from memory health', async () => {
  hookState.orientResult = {
    ...buildOrientResult(),
    orientation: {
      ...buildOrientResult().orientation,
      environmentStatus: 'unavailable',
    },
    warnings: ['gh_auth_no_active_account'],
  };

  const outcome = await runSessionStartHook(undefined, {
    cwd: TEST_CWD,
    dependencies: TEST_DEPENDENCIES,
    hookEventName: 'SessionStart',
    sessionId: 'session-123',
  });

  const bootstrapText = readBootstrapText(outcome);
  assert.match(bootstrapText, /status: ok/u, 'memory health should remain healthy');
  assert.match(bootstrapText, /environmentStatus: unavailable/u, 'environment state should remain explicit');
  assert.match(bootstrapText, /warnings: gh_auth_no_active_account/u, 'environment warning should remain visible');

  const invocation = findToolInvocation('memory_orient');
  assert.ok(invocation !== undefined, 'auto-orient should record telemetry');
  assert.equal(invocation.responseStatus, 'ok');
  assert.equal(invocation.summaryFields.environment_status, 'unavailable');
});

test('session-start hook keeps recall output when orient fails', async () => {
  hookState.orientError = new Error('orient fanout timeout');

  const outcome = await runSessionStartHook(undefined, {
    cwd: TEST_CWD,
    dependencies: TEST_DEPENDENCIES,
    hookEventName: 'SessionStart',
    sessionId: 'session-123',
  });

  const bootstrapText = readBootstrapText(outcome);
  assert.match(bootstrapText, /Recent Memories/u, 'recall output should still be emitted');
  assert.doesNotMatch(bootstrapText, /Memory Orientation/u, 'failed orient output should be omitted');
  assert.equal(outcome.warning, undefined, 'orient failure must not replace recall with a warning-only message');
  assert.equal(outcome.continue, true);

  assert.ok(
    hookState.warnEvents.some(event => event.event === 'hook.session_start_orient_failed'),
    'orient failure should be logged for diagnostics',
  );
  const invocation = findToolInvocation('memory_orient');
  assert.ok(invocation !== undefined, 'failed auto-orient should still be tagged in telemetry');
  assert.equal(invocation.status, 'error');
  assert.deepEqual(invocation.summaryFields, {
    detected_source: 'session-start-hook',
    source: 'session-start-hook',
  });
});

test('session-start hook reports degraded status when continuity pack read fails', async () => {
  hookState.continuityError = new Error('continuity pack read timed out');

  const outcome = await runSessionStartHook(undefined, {
    cwd: TEST_CWD,
    dependencies: TEST_DEPENDENCIES,
    hookEventName: 'SessionStart',
    sessionId: 'session-123',
  });

  const bootstrapText = readBootstrapText(outcome);
  assert.equal(outcome.status, 'degraded');
  assert.match(bootstrapText, /Recent Memories/u, 'recall output should still be emitted');
  assert.match(bootstrapText, /Memory Orientation/u, 'orient output should still be emitted');
  assert.ok(
    hookState.warnEvents.some(event => event.event === 'hook.session_start_continuity_pack_failed'),
    'continuity read failure should be logged for diagnostics',
  );
  const invocation = findToolInvocation('memory_continuity_pack');
  assert.ok(invocation !== undefined, 'failed continuity read should still be tagged in telemetry');
  assert.equal(invocation.sessionId, 'session-123');
  assert.equal(invocation.status, 'error');
  assert.deepEqual(invocation.summaryFields, {
    continuity_pack_status: 'error',
    detected_source: 'session-start-hook',
    source: 'session-start-hook',
  });
});

test('session-start hook records continuity telemetry without a session id when hosts omit it', async () => {
  const outcome = await runSessionStartHook(undefined, {
    cwd: TEST_CWD,
    dependencies: TEST_DEPENDENCIES,
    hookEventName: 'SessionStart',
  });

  assert.equal(outcome.continue, true);
  const invocation = findToolInvocation('memory_continuity_pack');
  assert.ok(invocation !== undefined, 'continuity-pack read should still record telemetry');
  assert.equal(invocation.sessionId, undefined);
  assert.equal(invocation.project, 'example/catalog');
  assert.equal(invocation.status, 'ok');
});

test('session-start hook surfaces actionable build-artifacts warning when memory core dist is missing', async () => {
  hookState.postgresStatus = {
    databaseUrl: 'postgres://example:****@host/db',
    errorMessage:
      '@aviaratech/ai-memory build artifacts are unavailable; cannot probe Postgres until the workspace dependency is built.',
    hint: 'Postgres probe failed: @aviaratech/ai-memory build artifacts are unavailable. Run `npm run build -w @aviaratech/ai-memory` in the worktree, then retry.',
    ok: false,
  };

  const outcome = await runSessionStartHook(undefined, {
    cwd: TEST_CWD,
    dependencies: TEST_DEPENDENCIES,
    hookEventName: 'SessionStart',
    sessionId: 'session-123',
  });

  assert.equal(outcome.status, 'unavailable');
  assert.equal(outcome.continue, true);
  assert.equal(typeof outcome.warning, 'string');
  assert.match(outcome.warning ?? '', /@aviaratech\/ai-memory build artifacts are unavailable/u);
  assert.match(outcome.warning ?? '', /npm run build -w @aviaratech\/ai-memory/u);
  assert.doesNotMatch(
    outcome.warning ?? '',
    /ERR_MODULE_NOT_FOUND/u,
    'hook warning must not surface module-not-found stack text to operators',
  );

  const unavailableEvent = hookState.warnEvents.find(e => e.event === 'postgres.session_start_unavailable');
  assert.ok(unavailableEvent !== undefined, 'unavailable diagnostic must be logged');
  assert.match(
    String(unavailableEvent.fields.message ?? ''),
    /@aviaratech\/ai-memory build artifacts are unavailable/u,
    'diagnostic log must name the build-artifacts cause, not generic Postgres reachability',
  );

  // Telemetry from auto-orient must not be invoked when Postgres status is unavailable —
  // the hook short-circuits before orient runs.
  assert.equal(hookState.orientInputs.length, 0, 'orient should not run when postgres is unavailable');
});

test('session-start hook keeps recall output when auto-orient local timeout fires', async () => {
  hookState.timeoutError = new Error('memory_orient.session_start timed out after 22000ms');

  const outcome = await runSessionStartHook(undefined, {
    cwd: TEST_CWD,
    dependencies: TEST_DEPENDENCIES,
    hookEventName: 'SessionStart',
    sessionId: 'session-123',
  });

  const bootstrapText = readBootstrapText(outcome);
  assert.match(bootstrapText, /Recent Memories/u, 'recall output should still be emitted');
  assert.doesNotMatch(bootstrapText, /Memory Orientation/u, 'timed-out orient output should be omitted');
  assert.equal(outcome.warning, undefined, 'orient timeout must not replace recall with a warning-only message');

  const invocation = findToolInvocation('memory_orient');
  assert.ok(invocation !== undefined, 'timed-out auto-orient should still be tagged in telemetry');
  assert.equal(invocation.status, 'error');
  assert.equal(invocation.timeoutWarningCount, 1);
});

function buildOrientResult(): OrientResult {
  return {
    capabilities: {
      embedding: false,
      envProbe: 'local',
      search: false,
      searchAvailable: false,
      sessionResume: true,
    },
    orientation: {
      activeGoal: null,
      contested: 0,
      environment: null,
      environmentStatus: 'local',
      fullContentTopN: 0,
      memoryDetail: 'compact',
      memoryPayloadApproxTokens: 1800,
      memoryPayloadBudgetChars: 8000,
      memoryPayloadBudgetExceeded: false,
      memoryPayloadChars: 7200,
      priorSession: null,
      recentMemories: [],
      taskRelevant: [],
      taskSearchResultCount: null,
      taskSearchStatus: 'skipped',
      truncatedSections: ['taskRelevant'],
      x_active_goal: null,
    },
    status: 'ok',
    warnings: [],
  };
}

function findToolInvocation(
  toolName: string,
): Parameters<SessionStartHookDependencies['recordToolInvocation']>[0] | undefined {
  return hookState.toolInvocations.find(invocation => invocation.toolName === toolName);
}

function readBootstrapText(outcome: unknown): string {
  assert.ok(outcome !== null && typeof outcome === 'object', 'outcome should be an object');
  const record = outcome as { bootstrapText?: unknown; recallText?: unknown };
  const text = record.bootstrapText ?? record.recallText;
  if (typeof text !== 'string') {
    assert.fail('outcome should include bootstrap text');
  }
  return text;
}

for (const event of ['startup', 'clear', 'compact']) {
  test(`session-start ${event} bounds complete context and deduplicates recall`, async () => {
    hookState.memories = Array.from({ length: 50 }, () => ({
      category: 'decision',
      confidence: 0.9,
      content: 'unique-recall-entry',
    }));
    const outcome = await runSessionStartHook(undefined, {
      dependencies: TEST_DEPENDENCIES,
      hookEventName: event,
      repoId: 'example/catalog',
    });
    const text = readBootstrapText(outcome);
    assert.equal(text.split('unique-recall-entry').length - 1, 1);
    assert.ok(text.length <= 8000);
  });
}

test('session-start bounds oversized degradation warnings', async () => {
  hookState.postgresStatus = { hint: 'recovery '.repeat(2000), ok: false };
  const outcome = await runSessionStartHook(undefined, { dependencies: TEST_DEPENDENCIES });
  assert.ok((outcome.warning?.length ?? 0) <= 8000);
  assert.match(outcome.warning ?? '', /unavailable/u);
});

for (const host of ['claude', 'cursor', 'codex', 'cursor-with-claude']) {
  test(`complete ${host} envelope includes warnings within 8000 characters`, () => {
    const previousClaude = process.env.CLAUDE_PLUGIN_ROOT;
    const previousCursor = process.env.CURSOR_PLUGIN_ROOT;
    try {
      delete process.env.CLAUDE_PLUGIN_ROOT;
      delete process.env.CURSOR_PLUGIN_ROOT;
      if (host === 'claude' || host === 'cursor-with-claude') process.env.CLAUDE_PLUGIN_ROOT = '/fixture';
      if (host.startsWith('cursor')) process.env.CURSOR_PLUGIN_ROOT = '/fixture';
      const output: unknown = JSON.parse(
        serializeSessionStartHook({
          bootstrapText: 'quoted " unicode 🌍\n'.repeat(2000),
          continue: true,
          status: 'degraded',
          suppressOutput: false,
          warning: 'recovery warning',
        }),
      );
      assert.ok(typeof output === 'object' && output !== null);
      const envelope = output as {
        additional_context?: string;
        hookSpecificOutput?: { additionalContext: string; hookEventName: string };
      };
      const cursor = host.startsWith('cursor');
      assert.deepEqual(Object.keys(envelope), [cursor ? 'additional_context' : 'hookSpecificOutput']);
      if (!cursor) {
        assert.equal(envelope.hookSpecificOutput?.hookEventName, 'SessionStart');
        assert.deepEqual(Object.keys(envelope.hookSpecificOutput ?? {}).sort(), ['additionalContext', 'hookEventName']);
      }
      const text = cursor ? envelope.additional_context : envelope.hookSpecificOutput?.additionalContext;
      assert.ok(text !== undefined && text.length <= 8000);
      assert.match(text, /recovery warning/u);
      assert.match(text, /truncated/u);
      assert.equal(Object.keys(output).length, 1);
    } finally {
      if (previousClaude === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = previousClaude;
      if (previousCursor === undefined) delete process.env.CURSOR_PLUGIN_ROOT;
      else process.env.CURSOR_PLUGIN_ROOT = previousCursor;
    }
  });
}

test('oversized continuity retains source and next action alongside bounded summary', async () => {
  hookState.continuityPack = {
    pack: {
      budgetChars: 6000,
      createdAt: '2026-09-10T00:00:00Z',
      pack: {
        nextActions: ['REQUIRED_NEXT_ACTION'],
        provenance: { sessionId: 'prior-session', source: 'manual-flush' },
        summary: 'oversized '.repeat(3000),
      },
      payloadChars: 99999,
      project: 'example/catalog',
      scopeKey: 'project:example/catalog',
      sessionId: 'prior-session',
      source: 'manual-flush',
      status: 'fresh',
      updatedAt: '2026-09-10T00:00:00Z',
    },
    status: 'found',
  };
  const outcome = await runSessionStartHook(undefined, { dependencies: TEST_DEPENDENCIES });
  const output = serializeSessionStartHook(outcome);
  assert.match(output, /REQUIRED_NEXT_ACTION/u);
  assert.match(output, /prior-session/u);
  assert.match(output, /truncated/u);
});

test('continuity signals omitted list items even when text fits', async () => {
  hookState.continuityPack = {
    pack: {
      budgetChars: 6000,
      createdAt: '2026-09-10T00:00:00Z',
      pack: {
        nextActions: ['first', 'second', 'third', 'fourth'],
        provenance: { sessionId: 'prior-session', source: 'manual-flush' },
        summary: 'Short summary.',
      },
      payloadChars: 100,
      project: 'example/catalog',
      scopeKey: 'project:example/catalog',
      sessionId: 'prior-session',
      source: 'manual-flush',
      status: 'fresh',
      updatedAt: '2026-09-10T00:00:00Z',
    },
    status: 'found',
  };
  const outcome = await runSessionStartHook(undefined, { dependencies: TEST_DEPENDENCIES });
  assert.match(readBootstrapText(outcome).split('### Recent Memories')[0] ?? '', /truncated/u);
});

test('task startup preserves its source session and skips unrelated project recall and orient', async () => {
  hookState.continuityPack = {
    pack: {
      budgetChars: 6000,
      createdAt: '2026-01-02T00:00:00Z',
      pack: {
        nextActions: ['Verify the local manifest checksum.'],
        provenance: {
          scope: { id: 'fixture-native-task', type: 'task' },
          sessionId: 'fixture-claude-session-b',
          source: 'manual-flush',
        },
        summary: 'Checkpoint B: keep the archive offline while customer review is pending.',
      },
      payloadChars: 200,
      project: 'example/catalog',
      scopeKey: 'task:example/catalog:fixture-native-task',
      sessionId: 'fixture-claude-session-b',
      source: 'manual-flush',
      status: 'fresh',
      updatedAt: '2026-01-02T00:00:00Z',
    },
    status: 'found',
  };
  const outcome = await runSessionStartHook(undefined, {
    cwd: TEST_CWD,
    dependencies: {
      ...TEST_DEPENDENCIES,
      orientMemory: () => {
        throw new Error('unrelated project orient');
      },
      recallMemories: () => {
        throw new Error('unrelated project recall');
      },
    },
    sessionId: 'fixture-native-task',
  });
  assert.equal(outcome.status, 'ok');
  assert.deepEqual(hookState.continuityInputs, [{ project: 'example/catalog', task: 'fixture-native-task' }]);
  assert.match(readBootstrapText(outcome), /Checkpoint B/u);
  assert.match(readBootstrapText(outcome), /fixture-claude-session-b/u);
  assert.match(readBootstrapText(outcome), /keep the archive offline/u);
  assert.doesNotMatch(readBootstrapText(outcome), /Recent Memories|Memory Orientation/u);
  assert.ok(readBootstrapText(outcome).length < 8000);
});

for (const sessionId of ['fixture-native-task', undefined])
  test(`startup rejects foreign scope with host identity ${String(sessionId)}`, async () => {
    const outcome = await runSessionStartHook(undefined, {
      cwd: TEST_CWD,
      dependencies: {
        ...TEST_DEPENDENCIES,
        getContinuityPack: () =>
          Promise.resolve({
            pack: {
              budgetChars: 6000,
              createdAt: undefined,
              pack: { summary: 'FOREIGN_CHECKPOINT' },
              payloadChars: 100,
              project: 'fixture/foreign',
              scopeKey: 'task:fixture/foreign:fixture-native-task',
              sessionId: 'fixture-foreign-session',
              source: 'manual-flush',
              status: 'fresh',
              updatedAt: undefined,
            },
            status: 'found',
          }),
      },
      sessionId,
    });
    assert.equal(outcome.status, 'degraded');
    assert.doesNotMatch(readBootstrapText(outcome), /FOREIGN_CHECKPOINT/u);
    assert.match(readBootstrapText(outcome), /unavailable/u);
  });

test('startup with no host identity reports explicit task recovery instead of inventing identity', async () => {
  const outcome = await runSessionStartHook(undefined, { cwd: TEST_CWD, dependencies: TEST_DEPENDENCIES });
  assert.match(readBootstrapText(outcome), /Task identity unavailable/u);
  assert.deepEqual(hookState.continuityInputs, [{ project: 'example/catalog' }]);
});

test('startup does not read foreign background memories when the project is unknown', async () => {
  hookState.repoId = undefined;
  const outcome = await runSessionStartHook(undefined, {
    cwd: TEST_CWD,
    dependencies: {
      ...TEST_DEPENDENCIES,
      orientMemory: () => {
        throw new Error('unscoped orient');
      },
      recallMemories: () => {
        throw new Error('unscoped recall');
      },
    },
  });
  assert.equal(outcome.status, 'ok');
  assert.match(outcome.warning ?? '', /Project identity unavailable/u);
  assert.deepEqual(hookState.continuityInputs, []);
});

test('startup resolves an explicit basename only against its verified working repository', async () => {
  await runSessionStartHook(undefined, {
    cwd: TEST_CWD,
    dependencies: TEST_DEPENDENCIES,
    repoId: 'catalog',
    sessionId: 'host-session',
  });
  assert.deepEqual(hookState.continuityInputs[0], { project: 'example/catalog', task: 'host-session' });
});
