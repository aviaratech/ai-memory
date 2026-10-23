import assert from 'node:assert/strict';
import { beforeEach, test } from 'vitest';
import { buildBrief } from '../brief.js';

import {
  runSessionStartHook,
  serializeSessionStartHook,
  type SessionStartHookDependencies,
} from './session-start-hook.js';

const startupArms: unknown[] = [];

const hookState: {
  continuityError: Error | undefined;
  continuityInputs: unknown[];
  continuityPack: Awaited<ReturnType<SessionStartHookDependencies['getContinuityPack']>>;
  infoEvents: { event: string; fields: Record<string, unknown> }[];
  memories: {
    category: string;
    confidence: number;
    content: string;
    memoryKey?: string;
    project?: string;
    audience?: string[];
  }[];
  orientError: Error | undefined;
  orientInputs: unknown[];
  orientResult: unknown;
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

test('background recall cannot reintroduce memories excluded by the brief audience', async () => {
  hookState.memories = [
    {
      category: 'convention',
      confidence: 0.9,
      content: 'WORKER_ONLY_RULE',
      memoryKey: 'rule/worker',
      project: 'example/catalog',
      audience: ['worker'],
    },
  ];
  const outcome = await runSessionStartHook(undefined, { host: 'codex', dependencies: TEST_DEPENDENCIES });
  assert.doesNotMatch(serializeSessionStartHook(outcome), /WORKER_ONLY_RULE/u);
});

test('hook serializes stale flags and observes only IDs of brief items actually injected', async () => {
  const observations: unknown[] = [];
  const dependencies: SessionStartHookDependencies = {
    ...TEST_DEPENDENCIES,
    recordMemoryConsumption: input => {
      observations.push(input);
      return Promise.resolve();
    },
    refreshBrief: (scope, options) =>
      Promise.resolve(
        buildBrief(
          scope,
          [
            {
              id: 41,
              project: scope.project,
              memoryKey: 'example/catalog:old',
              content: 'Old synthetic rule.',
              importance: 1,
              status: 'active',
              pinned: true,
              audience: ['all'],
              lastVerifiedAt: '2026-01-01T00:00:00.000Z',
            },
            {
              id: 42,
              project: scope.project,
              memoryKey: 'example/catalog:huge',
              content: 'x'.repeat(9000),
              status: 'active',
              pinned: true,
              audience: ['all'],
              lastVerifiedAt: '2026-01-01T00:00:00.000Z',
            },
            {
              id: 43,
              project: 'other/catalog',
              memoryKey: 'other/catalog:rule',
              content: 'Foreign rule.',
              status: 'active',
              pinned: true,
              audience: ['all'],
            },
          ],
          { onSelected: options?.onSelected },
        ),
      ),
    readCachedBrief: () => Promise.resolve(undefined),
  };
  const outcome = await runSessionStartHook(undefined, {
    host: 'codex',
    sessionId: 'synthetic-brief-session',
    dependencies,
  });
  assert.match(serializeSessionStartHook(outcome), /\(check: unverified_30d\)/u);
  assert.deepEqual(observations, [
    {
      host: 'codex',
      project: 'example/catalog',
      sessionId: 'synthetic-brief-session',
      kind: 'injected',
      memoryIds: [41],
      observation: 'prompt',
    },
  ]);
});

test('startup, clear, compact and Codex preserve the complete brief and use scoped cached fallback on outage', async () => {
  const scope = { project: 'example/catalog', host: 'claude-code', role: 'lead' };
  const fixtures = Array.from({ length: 40 }, (_, index) => ({
    id: index,
    project: scope.project,
    category: 'convention',
    memoryKey: `rule/${String(index)}`,
    content: `Synthetic standing rule ${String(index)}. ` + 'Complete synthetic content. '.repeat(5),
    status: 'active',
    pinned: true,
    importance: index / 100,
    audience: [index % 2 === 0 ? 'all' : 'worker'],
    lastVerifiedAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    evidenceRefs: ['https://example.com/rule'],
  }));
  const brief = buildBrief(scope, [
    ...fixtures,
    { ...fixtures[0]!, memoryKey: 'state/lead', category: 'state', content: 'Complete state.' },
  ]);
  const calls: unknown[] = [];
  const dependencies = {
    ...TEST_DEPENDENCIES,
    refreshBrief: (scope: unknown) => {
      calls.push(scope);
      return Promise.resolve(brief);
    },
    readCachedBrief: (scope: unknown) => {
      calls.push(scope);
      return Promise.resolve({ text: brief, generatedAt: '2026-10-01T00:00:00.000Z' });
    },
  };
  const priorRole = process.env.AI_MEMORY_ROLE;
  process.env.AI_MEMORY_ROLE = 'lead';
  try {
    for (const host of ['claude-code', 'codex'] as const) {
      for (const source of ['startup', 'clear', 'compact']) {
        const outcome = await runSessionStartHook(undefined, { host, source, dependencies });
        assert.equal(outcome.briefText, brief);
        const serialized = serializeSessionStartHook(outcome);
        const envelope = JSON.parse(serialized) as { hookSpecificOutput: { additionalContext: string } };
        assert.ok(envelope.hookSpecificOutput.additionalContext.includes(brief));
        assert.ok(envelope.hookSpecificOutput.additionalContext.length <= 8000);
        assert.deepEqual(calls.at(-1), { project: 'example/catalog', host, role: 'lead' });
      }
    }
    hookState.postgresStatus = { ok: false };
    const fallback = await runSessionStartHook(undefined, { host: 'codex', dependencies });
    assert.match(fallback.briefText ?? '', /generated at 2026-10-01T00:00:00.000Z/u);
    assert.match(fallback.briefText ?? '', /Complete state\./u);
    assert.equal(fallback.continue, true);
    hookState.postgresStatus = { ok: true };
    const failed = await runSessionStartHook(undefined, {
      host: 'codex',
      dependencies: { ...dependencies, initializeDatabase: () => Promise.reject(new Error('connection refused')) },
    });
    assert.match(failed.briefText ?? '', /Complete state\./u);
  } finally {
    if (priorRole === undefined) delete process.env.AI_MEMORY_ROLE;
    else process.env.AI_MEMORY_ROLE = priorRole;
  }
});

const TEST_DEPENDENCIES: SessionStartHookDependencies = {
  armPromptRetrieval: input => {
    startupArms.push(input);
    return Promise.resolve();
  },
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
      content: 'Keyed project facts remain available.',
      memoryKey: 'example/catalog:fact',
      project: 'example/catalog',
    },
  ];
  hookState.orientError = undefined;
  hookState.orientInputs = [];
  startupArms.length = 0;
  hookState.postgresStatus = { ok: true };
  hookState.repoId = 'example/catalog';
  hookState.timeoutError = undefined;
  hookState.timeoutInputs = [];
  hookState.toolInvocations = [];
  hookState.warnEvents = [];
});

test('fresh startup never injects a different session latest project flush', async () => {
  hookState.continuityPack = {
    status: 'found',
    pack: {
      project: 'example/catalog',
      scopeKey: 'project:example/catalog',
      sessionId: 'other-session',
      source: 'manual-flush',
      status: 'fresh',
      budgetChars: 6000,
      payloadChars: 100,
      createdAt: undefined,
      updatedAt: undefined,
      pack: { summary: 'UNRELATED_SESSION_FLUSH' },
    },
  };
  const result = await runSessionStartHook(undefined, { dependencies: TEST_DEPENDENCIES, sessionId: 'fresh-session' });
  assert.doesNotMatch(serializeSessionStartHook(result), /UNRELATED_SESSION_FLUSH/u);
  assert.deepEqual(hookState.continuityInputs, [{ project: 'example/catalog', task: 'fresh-session' }]);
  assert.equal(hookState.orientInputs.length, 0);
});

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
      memoryKey: 'example/catalog:fact',
      project: 'example/catalog',
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
      scopeKey: 'task:example/catalog:matching-task',
      sessionId: 'prior-session',
      source: 'manual-flush',
      status: 'fresh',
      updatedAt: '2026-09-10T00:00:00Z',
    },
    status: 'found',
  };
  const outcome = await runSessionStartHook(undefined, { dependencies: TEST_DEPENDENCIES, sessionId: 'matching-task' });
  const output = serializeSessionStartHook(outcome);
  assert.match(output, /REQUIRED_NEXT_ACTION/u);
  assert.match(output, /prior-session/u);
  assert.match(output, /truncated/u);
  const calls = hookState.toolInvocations.filter(row => row.toolName === 'memory_continuity_pack');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.summaryFields?.continuity_pack_projection_truncated, 1);
  assert.ok(Number(calls[0]?.summaryFields?.continuity_pack_projection_chars) > 0);
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
      scopeKey: 'task:example/catalog:matching-task',
      sessionId: 'prior-session',
      source: 'manual-flush',
      status: 'fresh',
      updatedAt: '2026-09-10T00:00:00Z',
    },
    status: 'found',
  };
  const outcome = await runSessionStartHook(undefined, { dependencies: TEST_DEPENDENCIES, sessionId: 'matching-task' });
  assert.match(readBootstrapText(outcome).split('### Recent Memories')[0] ?? '', /truncated/u);
  assert.equal(
    hookState.toolInvocations.find(row => row.toolName === 'memory_continuity_pack')?.summaryFields
      ?.continuity_pack_projection_truncated,
    1,
  );
});

test('projection observations follow actual item omissions and fail open when canonical telemetry rejects', async () => {
  for (const [item, truncated] of [
    ['short', 0],
    ['x'.repeat(181), 1],
  ] as const) {
    hookState.toolInvocations = [];
    hookState.continuityPack = {
      status: 'found',
      pack: {
        project: 'example/catalog',
        scopeKey: 'task:example/catalog:matching-task',
        sessionId: 'prior-session',
        source: 'manual-flush',
        status: 'fresh',
        budgetChars: 6000,
        payloadChars: 99999,
        createdAt: undefined,
        updatedAt: undefined,
        pack: { summary: 'Short.', nextActions: [item] },
      },
    };
    const outcome = await runSessionStartHook(undefined, {
      dependencies: TEST_DEPENDENCIES,
      sessionId: 'matching-task',
    });
    const calls = hookState.toolInvocations.filter(row => row.toolName === 'memory_continuity_pack');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.summaryFields?.continuity_pack_projection_truncated, truncated);
    assert.equal(calls[0]?.summaryFields?.continuity_pack_payload_chars, 99999);
    const failedTelemetry = {
      ...TEST_DEPENDENCIES,
      recordToolInvocation: () => Promise.reject(new Error('synthetic telemetry unavailable')),
    };
    const degraded = await runSessionStartHook(undefined, {
      dependencies: failedTelemetry,
      sessionId: 'matching-task',
    });
    assert.equal(serializeSessionStartHook(degraded), serializeSessionStartHook(outcome));
  }
});

test('missing continuity has unknown projection observations', async () => {
  await runSessionStartHook(undefined, { dependencies: TEST_DEPENDENCIES, sessionId: 'missing-task' });
  const row = hookState.toolInvocations.find(value => value.toolName === 'memory_continuity_pack');
  assert.ok(row);
  assert.equal(row.summaryFields?.continuity_pack_projection_chars, undefined);
  assert.equal(row.summaryFields?.continuity_pack_projection_truncated, undefined);
});

test('continuity telemetry preserves the explicit host for found, missing and failed reads', async () => {
  for (const host of ['codex', 'claude-code', undefined] as const) {
    for (const status of ['found', 'missing', 'error']) {
      hookState.toolInvocations = [];
      hookState.continuityError = status === 'error' ? new Error('synthetic read failure') : undefined;
      hookState.continuityPack =
        status === 'found'
          ? {
              status: 'found',
              pack: {
                budgetChars: 6000,
                createdAt: '2026-09-10T00:00:00Z',
                pack: { summary: 'Synthetic checkpoint.' },
                payloadChars: 100,
                project: 'example/catalog',
                scopeKey: 'task:example/catalog:matching-task',
                sessionId: 'prior-session',
                source: 'manual-flush',
                status: 'fresh',
                updatedAt: '2026-09-10T00:00:00Z',
              },
            }
          : { project: 'example/catalog', scopeKey: 'task:example/catalog:matching-task', status: 'missing' };
      await runSessionStartHook(undefined, { dependencies: TEST_DEPENDENCIES, host, sessionId: 'matching-task' });
      const rows = hookState.toolInvocations.filter(row => row.toolName === 'memory_continuity_pack');
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.summaryFields?.memory_host, host);
    }
  }
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

for (const sessionId of ['fixture-native-task'])
  test(`startup rejects foreign scope with host identity ${sessionId}`, async () => {
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
  assert.deepEqual(hookState.continuityInputs, []);
});

test('startup does not read foreign background memories when the project is unknown', async () => {
  hookState.repoId = undefined;
  const outcome = await runSessionStartHook(undefined, {
    cwd: TEST_CWD,
    dependencies: {
      ...TEST_DEPENDENCIES,
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

test('only a recognized startup event arms prompt eligibility; resume and compact never rearm', async () => {
  for (const source of ['startup', 'resume', 'compact', 'clear', 'fork']) {
    await runSessionStartHook(undefined, {
      dependencies: TEST_DEPENDENCIES,
      source,
      host: 'codex',
      sessionId: 'session-a',
    });
  }
  assert.deepEqual(startupArms, [{ host: 'codex', project: 'example/catalog', sessionId: 'session-a' }]);
});

test('startup renders keyed durable facts only, excluding unkeyed and session summaries', async () => {
  hookState.memories = [
    {
      category: 'architecture',
      confidence: 0.9,
      content: 'SAFE_FACT',
      memoryKey: 'example/catalog:key',
      project: 'example/catalog',
    },
    {
      category: 'session-summary',
      confidence: 0.5,
      content: 'OTHER_FLUSH',
      memoryKey: 'session:key',
      project: 'example/catalog',
    },
    {
      category: 'architecture',
      confidence: 0.9,
      content: 'FOREIGN_FACT',
      memoryKey: 'other/catalog:key',
      project: 'other/catalog',
    },
    { category: 'architecture', confidence: 0.9, content: 'UNKEYED' },
  ];
  const outcome = await runSessionStartHook(undefined, { dependencies: TEST_DEPENDENCIES, sessionId: 'fresh' });
  assert.match(serializeSessionStartHook(outcome), /SAFE_FACT/u);
  assert.doesNotMatch(serializeSessionStartHook(outcome), /OTHER_FLUSH|FOREIGN_FACT|UNKEYED/u);
});

test('startup rejects automatic checkpoints from another or unknown producer host', async () => {
  for (const agent of ['claude-code', undefined]) {
    hookState.continuityPack = {
      status: 'found',
      pack: {
        scopeKey: 'task:example/catalog:session-a',
        project: 'example/catalog',
        sessionId: 'session-a',
        source: 'pre-compact',
        pack: { summary: 'FOREIGN_HOST_CHECKPOINT', provenance: { agent } },
        budgetChars: 6000,
        payloadChars: 100,
        status: 'fresh',
        createdAt: undefined,
        updatedAt: undefined,
      },
    };
    const outcome = await runSessionStartHook(undefined, {
      dependencies: TEST_DEPENDENCIES,
      sessionId: 'session-a',
      host: 'codex',
      source: 'compact',
    });
    assert.doesNotMatch(outcome.bootstrapText ?? '', /FOREIGN_HOST_CHECKPOINT/u);
  }
});
