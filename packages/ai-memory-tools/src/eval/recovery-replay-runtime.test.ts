import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';

import {
  createRecoveryTrace,
  isRecoveryRecord,
  readRecoveryJson,
  RECOVERY_AGENT_DURATION_MS,
  RECOVERY_TOOLS,
} from './recovery-replay.js';
import {
  buildRecoveryCodexConfig,
  createRecoveryHostTrace,
  gradeRecoveryCase,
  recoveryModelIdentity,
  recoveryRunOutcome,
  remapRecoveryLineage,
  resolveRecoveryCoreModule,
} from './recovery-replay-runtime.js';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

test('recovery resolves the core package from the clean npm workspace layout', () => {
  const corePackage = resolve(workspaceRoot, 'packages/ai-memory');
  assert.equal(realpathSync(resolve(workspaceRoot, 'node_modules/@aviaratech/ai-memory')), realpathSync(corePackage));
  assert.equal(
    existsSync(resolve(workspaceRoot, 'packages/ai-memory-tools/node_modules/@aviaratech/ai-memory')),
    false,
  );
  assert.equal(resolveRecoveryCoreModule(workspaceRoot), realpathSync(resolve(corePackage, 'dist/internal.js')));
});

test('recovery resolves each variant from its own workspace and rejects cross-source links', () => {
  const baselineRoot = mkdtempSync(resolve(tmpdir(), 'ai-memory-replay-baseline-'));
  const foreignRoot = mkdtempSync(resolve(tmpdir(), 'ai-memory-replay-foreign-'));
  function prepareWorkspace(root: string) {
    const core = resolve(root, 'packages/ai-memory');
    const tools = resolve(root, 'packages/ai-memory-tools');
    const dependency = resolve(root, 'node_modules/@aviaratech/ai-memory');
    mkdirSync(resolve(core, 'dist'), { recursive: true });
    mkdirSync(tools, { recursive: true });
    mkdirSync(dirname(dependency), { recursive: true });
    writeFileSync(
      resolve(core, 'package.json'),
      JSON.stringify({
        name: '@aviaratech/ai-memory',
        type: 'module',
        exports: { './internal': './dist/internal.js' },
      }),
    );
    writeFileSync(resolve(core, 'dist/internal.js'), 'export const baseline = true;\n');
    writeFileSync(resolve(tools, 'package.json'), JSON.stringify({ name: '@aviaratech/ai-memory-tools' }));
    return { core, dependency };
  }
  try {
    const baseline = prepareWorkspace(baselineRoot);
    symlinkSync(baseline.core, baseline.dependency);
    assert.equal(resolveRecoveryCoreModule(baselineRoot), realpathSync(resolve(baseline.core, 'dist/internal.js')));
    assert.notEqual(resolveRecoveryCoreModule(baselineRoot), resolveRecoveryCoreModule(workspaceRoot));

    const foreign = prepareWorkspace(foreignRoot);
    symlinkSync(resolve(workspaceRoot, 'packages/ai-memory'), foreign.dependency);
    assert.throws(() => resolveRecoveryCoreModule(foreignRoot), /Cross-source memory dependency rejected/u);
  } finally {
    rmSync(baselineRoot, { recursive: true, force: true });
    rmSync(foreignRoot, { recursive: true, force: true });
  }
});

function recoveryRunEvidence(hostError: unknown = null): Parameters<typeof recoveryRunOutcome>[0] {
  const host = createRecoveryHostTrace();
  const trace = createRecoveryTrace('fixture/recovery');
  const items: Record<string, unknown>[] = [];
  for (let index = 0; index < 2; index += 1) {
    const args = { ids: [index + 1], project: 'fixture/recovery' };
    const result = { content: [{ text: `evidence ${String(index)}`, type: 'text' }], isError: index === 1 };
    const item = {
      arguments: args,
      id: `host_${String(index)}`,
      server: 'recovery',
      status: result.isError ? 'failed' : 'completed',
      tool: 'memory_get',
      type: 'mcp_tool_call',
    };
    host.observe({ item: { ...item, status: 'in_progress' }, type: 'item.started' });
    trace.begin({ args, id: index + 10, name: 'memory_get', now: 1 });
    trace.finish(index + 10, { now: 2, result });
    items.push({ ...item, error: hostError, result: { content: result.content, structured_content: null } });
  }
  // Host events may complete in a different order from accepted MCP requests.
  for (const item of items.reverse()) host.observe({ item, type: 'item.completed' });
  return {
    elapsedMs: 45_022,
    events: [{ type: 'turn.started' }],
    host,
    identityMatches: true,
    rawOutputBytes: 1_000,
    result: { cancellation: { reason: 'max_duration' }, exitCode: 124 },
    trace: {
      attempts: trace.attempts,
      bytes: trace.bytes,
      calls: trace.calls,
      incomplete: trace.incomplete,
      rewrites: trace.rewrites,
      violations: trace.violations,
    },
    unexpectedTool: false,
  };
}

test('only a contained deadline with reconciled host and MCP delivery is a timeout observation', () => {
  assert.equal(RECOVERY_AGENT_DURATION_MS, 45_000);
  const input = recoveryRunEvidence();
  assert.equal(recoveryRunOutcome(input), 'timeout');
  assert.notEqual(input.host.bytes, input.trace.bytes);
  assert.equal(recoveryRunOutcome({ ...input, elapsedMs: 44_000, result: { exitCode: 0 } }), 'completed');
  const successful = input.host.completedCalls.find(item => item.status === 'completed');
  assert.ok(successful);
  successful.status = 'failed';
  assert.equal(recoveryRunOutcome(input), 'invalid');
});

test('deadline classification preserves cancellation, identity, resource, and trace integrity stops', () => {
  const cases: [string, (input: Parameters<typeof recoveryRunOutcome>[0]) => void][] = [
    [
      'external cancellation',
      input => {
        input.result.cancellation = { reason: 'external' };
      },
    ],
    [
      'idle cancellation',
      input => {
        input.result.cancellation = { reason: 'idle_timeout' };
      },
    ],
    [
      'missing typed cancellation',
      input => {
        delete input.result.cancellation;
      },
    ],
    [
      'wrong exit',
      input => {
        input.result.exitCode = 1;
      },
    ],
    [
      'fallback output',
      input => {
        input.result.outputFallback = true;
      },
    ],
    [
      'no genuine turn',
      input => {
        input.events = [];
      },
    ],
    [
      'multiple turns',
      input => {
        input.events.push({ type: 'turn.started' });
      },
    ],
    [
      'completed turn',
      input => {
        input.events.push({ type: 'turn.completed' });
      },
    ],
    [
      'failed turn',
      input => {
        input.events.push({ type: 'turn.failed' });
      },
    ],
    [
      'error event',
      input => {
        input.events.push({ type: 'error' });
      },
    ],
    [
      'wrong model or sandbox',
      input => {
        input.identityMatches = false;
      },
    ],
    [
      'unexpected tool',
      input => {
        input.unexpectedTool = true;
      },
    ],
    [
      'raw byte cap',
      input => {
        input.rawOutputBytes = 1_048_577;
      },
    ],
    [
      'early cancellation',
      input => {
        input.elapsedMs = 44_999;
      },
    ],
    [
      'unknown elapsed',
      input => {
        input.elapsedMs = Number.NaN;
      },
    ],
    [
      'fifth wrapper attempt',
      input => {
        input.trace.attempts = 5;
      },
    ],
    [
      'missing wrapper attempt',
      input => {
        input.trace.attempts = 1;
      },
    ],
    [
      'missing dispatch',
      input => {
        input.trace.calls = [];
      },
    ],
    [
      'incomplete dispatch',
      input => {
        input.trace.incomplete = 1;
      },
    ],
    [
      'missing violation evidence',
      input => {
        delete input.trace.violations;
      },
    ],
    [
      'scope violation',
      input => {
        input.trace.violations = ['foreign scope'];
      },
    ],
    [
      'second rewrite',
      input => {
        input.trace.rewrites = 2;
      },
    ],
    [
      'unknown rewrites',
      input => {
        input.trace.rewrites = Number.NaN;
      },
    ],
    [
      'wrong aggregate bytes',
      input => {
        input.trace.bytes = 1;
      },
    ],
    [
      'MCP byte cap',
      input => {
        input.trace.bytes = 65_537;
      },
    ],
    [
      'missing host completion',
      input => {
        input.host.observe({
          item: { arguments: {}, id: 'pending', server: 'recovery', tool: 'memory_get', type: 'mcp_tool_call' },
          type: 'item.started',
        });
      },
    ],
  ];
  for (const [label, mutate] of cases) {
    const input = recoveryRunEvidence();
    mutate(input);
    assert.equal(recoveryRunOutcome(input), 'invalid', label);
  }
  for (const error of [{ message: 'transport failed' }, { message: 'requires approval' }, 'delivery failed', '', false])
    assert.equal(recoveryRunOutcome(recoveryRunEvidence(error)), 'invalid');
});

test('deadline classification rejects unmatched, incomplete, duplicated, or altered MCP deliveries', () => {
  for (const [key, value] of [
    ['args', { ids: [99], project: 'fixture/recovery' }],
    ['name', 'memory_search'],
    ['result', { content: [{ text: 'different', type: 'text' }] }],
    ['bytes', 0],
    ['latencyMs', -1],
    ['id', 11],
    ['result', undefined],
  ] as const) {
    const input = recoveryRunEvidence();
    assert.ok(Array.isArray(input.trace.calls));
    const call: unknown = input.trace.calls[0];
    assert.ok(isRecoveryRecord(call));
    call[key] = value;
    assert.equal(recoveryRunOutcome(input), 'invalid', key);
  }
});

test('host evidence rejects invocation changes and conflicting repeated completions', () => {
  for (const changed of [
    { arguments: { ids: [99] } },
    { result: null },
    { error: 'late failure' },
    { status: 'in_progress' },
  ]) {
    const input = recoveryRunEvidence();
    const item = input.host.completedCalls[0];
    assert.ok(item);
    input.host.observe({ item: { ...item, ...changed }, type: 'item.completed' });
    assert.ok(input.host.violations.length > 0);
    assert.equal(recoveryRunOutcome(input), 'invalid');
  }
});

test('host accounting includes denied calls, deduplicates completions, and rejects a fifth attempt', () => {
  const trace = createRecoveryHostTrace();
  let expectedBytes = 0;
  for (let index = 0; index < 5; index += 1) {
    const item = { id: `item_${String(index)}`, server: 'recovery', tool: 'memory_search', type: 'mcp_tool_call' };
    const payload =
      index < 2
        ? { error: { message: 'MCP tool call requires approval' }, result: null }
        : { error: null, result: { content: [{ text: 'fixture evidence', type: 'text' }] } };
    trace.observe({ item, type: 'item.started' });
    const event = { item: { ...item, ...payload }, type: 'item.completed' };
    trace.observe(event);
    trace.observe(event);
    expectedBytes += Buffer.byteLength(JSON.stringify(payload), 'utf8');
  }
  assert.equal(trace.attempts, 5);
  assert.equal(trace.incomplete, 0);
  assert.equal(trace.bytes, expectedBytes);
  assert.deepEqual(trace.violations, [
    'Host permission denied an admitted fixture tool.',
    'Host permission denied an admitted fixture tool.',
    'Host four-call limit exceeded.',
  ]);
});

test('host accounting rejects foreign tools, missing starts, and excessive delivered results', () => {
  const trace = createRecoveryHostTrace();
  trace.observe({
    item: { id: 'x', result: 'x'.repeat(65_536), server: 'foreign', tool: 'memory_search', type: 'mcp_tool_call' },
    type: 'item.completed',
  });
  assert.equal(trace.attempts, 1);
  assert.equal(trace.violations.length, 3);
  assert.ok(trace.bytes > 65_536);
});

test('replay permissions name only the five admitted tools and disable optional plugin bootstrap', () => {
  const config = buildRecoveryCodexConfig('[mcp_servers.recovery]\ncommand = "node"\nargs = []\n');
  assert.equal((config.match(/approval_mode = "approve"/gu) ?? []).length, 5);
  assert.ok(config.includes(`enabled_tools = ${JSON.stringify(RECOVERY_TOOLS)}`));
  for (const tool of RECOVERY_TOOLS) assert.ok(config.includes(`[mcp_servers.recovery.tools.${tool}]`));
  assert.ok(config.includes('plugins = false\nremote_plugin = false'));
  assert.ok(config.includes('sandbox_mode = "read-only"\napproval_policy = "never"'));
  assert.ok(!config.includes('default_tools_approval_mode'));
});

test('implicit constraint grading accepts retained source wording and rejects lost restrictions', () => {
  const fixture = readRecoveryJson(
    fileURLToPath(new URL('./fixtures/retrieval/current-task-recovery.json', import.meta.url)),
  );
  assert.ok(Array.isArray(fixture.memories));
  const memory: unknown = fixture.memories.find(
    row => isRecoveryRecord(row) && row.memoryKey === 'fixture:recovery:implicit-export-constraint',
  );
  assert.ok(isRecoveryRecord(memory));
  assert.ok(typeof memory.content === 'string');
  const expected = {
    requiredConstraint: 'Do not upload while the customer review is pending.',
    sourceMemoryKey: memory.memoryKey,
  };
  const grade = (content: string) =>
    gradeRecoveryCase('A03', {
      answer: 'Do not upload while customer review is pending.',
      calls: [{ result: { memories: [{ ...memory, content }] } }],
      expected,
    });
  assert.equal(grade(memory.content), true);
  assert.equal(
    gradeRecoveryCase('A03', {
      answer: 'Keep the archive offline; uploading must wait until customer review is accepted.',
      calls: [{ result: { memories: [memory] } }],
      expected,
    }),
    true,
  );
  assert.equal(grade('Upload the archive while the customer review is pending.'), false);
  assert.equal(grade('Do not upload the archive.'), false);
});

test('fixture lineage uses allocated database IDs and refuses missing predecessors', () => {
  assert.deepEqual(remapRecoveryLineage({ content: 'current', id: 8201, supersedesId: 8200 }, new Map([[8200, 42]])), {
    content: 'current',
    supersedesId: 42,
  });
  assert.throws(() => remapRecoveryLineage({ id: 8201, supersedesId: 8200 }, new Map()), /predecessor/i);
});

test('catalog approval recovery requires bound provenance across successful responses', () => {
  const expected = { evidenceRef: 'https://example.invalid/issue/42', sourceMemoryKey: 'fixture:answer' };
  const answer = 'The approved catalog preview copyediting rule is in effect.';
  assert.equal(
    gradeRecoveryCase('A02', {
      answer: answer,
      calls: [{ result: { memoryKey: 'fixture:answer' } }],
      expected: expected,
    }),
    false,
  );
  assert.equal(
    gradeRecoveryCase('A02', {
      answer: answer,
      calls: [
        { result: { memories: [] } },
        { result: { evidenceRefs: [expected.evidenceRef], memoryKey: 'fixture:answer' } },
      ],
      expected: expected,
    }),
    true,
  );
  assert.equal(
    gradeRecoveryCase('A02', {
      answer: answer,
      calls: [{ result: { memoryKey: 'fixture:answer' } }, { result: { evidenceRefs: [expected.evidenceRef] } }],
      expected: expected,
    }),
    false,
  );
  assert.equal(
    gradeRecoveryCase('A02', {
      answer: answer,
      calls: [
        {
          result: {
            memories: [
              { memoryKey: 'fixture:answer' },
              { evidenceRefs: [expected.evidenceRef], memoryKey: 'fixture:unrelated' },
            ],
          },
        },
      ],
      expected: expected,
    }),
    false,
  );
  assert.equal(
    gradeRecoveryCase('A02', {
      answer: answer,
      calls: [
        {
          result: {
            evidenceRefs: [`${expected.evidenceRef}/different`],
            memoryKey: 'fixture:answer',
          },
        },
      ],
      expected: expected,
    }),
    false,
  );
});

test('current-task recovery accepts a later exact task checkpoint', () => {
  const expected = {
    sourceProject: 'fixture/recovery',
    sourceSession: 'fixture-claude-session-b',
    sourceTask: 'fixture-logical-task-export',
    summaryContains: 'Checkpoint B:',
  };
  assert.equal(
    gradeRecoveryCase('A01', {
      answer:
        'Continue from Checkpoint B in fixture-claude-session-b. Customer review is pending, so retain the upload hold.',
      calls: [
        { args: { project: 'fixture/recovery' }, result: { orientation: { priorSession: { status: 'not_found' } } } },
        {
          args: { project: 'fixture/recovery', task: 'fixture-logical-task-export' },
          result: {
            pack: {
              project: 'fixture/recovery',
              provenance: { sessionId: 'fixture-claude-session-b' },
              scopeKey: 'task:fixture/recovery:fixture-logical-task-export',
              summary: 'Checkpoint B: continue the archive task.',
            },
          },
        },
      ],
      expected,
    }),
    true,
  );
  assert.equal(
    gradeRecoveryCase('A01', {
      answer:
        'Continue from Checkpoint B in fixture-claude-session-b. Customer review is pending, so retain the upload hold.',
      calls: [
        {
          args: { project: 'fixture/recovery', task: 'fixture-logical-task-export' },
          result: {
            contextNeeded: {
              project: 'fixture/recovery',
              sessionId: 'fixture-claude-session-b',
              summary: 'Checkpoint B:',
              task: 'fixture-logical-task-export',
            },
            pack: {
              project: 'fixture/foreign',
              provenance: { sessionId: 'fixture-claude-session-b' },
              scopeKey: 'task:fixture/foreign:fixture-logical-task-export',
              summary: 'Checkpoint B: foreign task.',
            },
          },
        },
      ],
      expected,
    }),
    false,
  );
  assert.equal(
    gradeRecoveryCase('A01', {
      answer:
        'Continue from Checkpoint B in fixture-claude-session-b. Customer review is pending, so retain the upload hold.',
      calls: [
        {
          args: { project: 'fixture/recovery', task: 'fixture-logical-task-export' },
          result: {
            packs: [
              {
                project: 'fixture/recovery',
                scopeKey: 'task:fixture/recovery:fixture-logical-task-export',
                sessionId: 'fixture-other-session',
                summary: 'Checkpoint B: wrong session.',
              },
              {
                project: 'fixture/foreign',
                scopeKey: 'task:fixture/foreign:fixture-logical-task-export',
                sessionId: 'fixture-claude-session-b',
                summary: 'Checkpoint B: wrong scope.',
              },
            ],
          },
        },
      ],
      expected,
    }),
    false,
  );
  assert.equal(
    gradeRecoveryCase('A01', {
      answer: 'Worker W is the recovered checkpoint; the upload hold remains.',
      calls: [
        {
          args: { project: 'fixture/recovery', task: 'fixture-logical-task-export' },
          result: {
            pack: {
              project: 'fixture/recovery',
              provenance: { sessionId: 'fixture-claude-session-b' },
              scopeKey: 'task:fixture/recovery:fixture-logical-task-export',
              summary: 'Checkpoint B: continue the archive task.',
            },
          },
        },
      ],
      expected,
    }),
    false,
  );
  assert.equal(
    gradeRecoveryCase('A01', {
      answer:
        'Worker W is unrelated and has no authority. Continue from Checkpoint B in fixture-claude-session-b and retain the upload hold.',
      calls: [
        {
          args: { project: 'fixture/recovery', task: 'fixture-logical-task-export' },
          result: {
            pack: {
              project: 'fixture/recovery',
              provenance: { sessionId: 'fixture-claude-session-b' },
              scopeKey: 'task:fixture/recovery:fixture-logical-task-export',
              summary: 'Checkpoint B: continue the archive task.',
            },
          },
        },
      ],
      expected,
    }),
    true,
  );
});

test('activation recovery accepts conditions expanded after orientation', () => {
  const expected = {
    evidenceRef: 'https://example.invalid/evidence/activation-approval',
    sourceMemoryKey: 'fixture:recovery:late-activation-condition',
  };
  assert.equal(
    gradeRecoveryCase('A05', {
      answer:
        'No, the merge cannot authorize activation. Operator approval of the exact release and a passing rollback check are required.',
      calls: [
        { result: { memories: [{ category: 'decision' }] } },
        {
          result: {
            memories: [{ evidenceRefs: [expected.evidenceRef], memoryKey: expected.sourceMemoryKey }],
          },
        },
      ],
      expected,
    }),
    true,
  );
  assert.equal(
    gradeRecoveryCase('A05', {
      answer:
        'The source merge authorizes activation. Operator approval of the exact release and a rollback check can follow.',
      calls: [
        {
          result: {
            memories: [{ evidenceRefs: [expected.evidenceRef], memoryKey: expected.sourceMemoryKey }],
          },
        },
      ],
      expected,
    }),
    false,
  );
  assert.equal(
    gradeRecoveryCase('A05', {
      answer:
        'Source merge does not authorize activation. Operator approval of the exact release is optional; the rollback check need not pass. You can activate now.',
      calls: [
        {
          result: {
            memories: [{ evidenceRefs: [expected.evidenceRef], memoryKey: expected.sourceMemoryKey }],
          },
        },
      ],
      expected,
    }),
    false,
  );
  assert.equal(
    gradeRecoveryCase('A05', {
      answer:
        'No. Activation requires operator approval of the exact release and a recorded rollback check that passes. Merge alone is insufficient.',
      calls: [
        {
          result: {
            memories: [{ evidenceRefs: [expected.evidenceRef], memoryKey: expected.sourceMemoryKey }],
          },
        },
      ],
      expected,
    }),
    true,
  );
  assert.equal(
    gradeRecoveryCase('A05', {
      answer:
        '**The source merge alone does not authorize activation.** Activation requires both:\n\n- Operator approval of the **exact release**.\n- A **passing recorded rollback check**.\n\nDo not activate now.',
      calls: [
        {
          result: {
            memories: [{ evidenceRefs: [expected.evidenceRef], memoryKey: expected.sourceMemoryKey }],
          },
        },
      ],
      expected,
    }),
    true,
  );
  assert.equal(
    gradeRecoveryCase('A05', {
      answer:
        'The source merge alone does not authorize activation. Activation requires both operator approval of the exact release and a passing recorded rollback check. Keep activation on hold.',
      calls: [
        {
          result: {
            memories: [{ evidenceRefs: [expected.evidenceRef], memoryKey: expected.sourceMemoryKey }],
          },
        },
      ],
      expected,
    }),
    true,
  );
  assert.equal(
    gradeRecoveryCase('A05', {
      answer:
        'Activation is not yet established as authorized. A source merge alone is insufficient. Do not activate the installation unless the operator approves the exact release and the recorded rollback check passes.',
      calls: [
        {
          result: {
            memories: [{ evidenceRefs: [expected.evidenceRef], memoryKey: expected.sourceMemoryKey }],
          },
        },
      ],
      expected,
    }),
    true,
  );
  assert.equal(
    gradeRecoveryCase('A05', {
      answer:
        'The source merge alone is insufficient. Do not activate unless the operator approves the exact release or the recorded rollback check passes.',
      calls: [
        {
          result: {
            memories: [{ evidenceRefs: [expected.evidenceRef], memoryKey: expected.sourceMemoryKey }],
          },
        },
      ],
      expected,
    }),
    false,
  );
});

test('current-window recovery grades the requested state without requiring every rejected proposal', () => {
  const calls = [
    {
      result: {
        memories: [
          { content: 'Current archive replay window is thirty minutes.', supersedesId: 14 },
          { content: 'Verify the archive manifest checksum before replay.' },
        ],
      },
    },
  ];
  assert.equal(
    gradeRecoveryCase('A04', {
      answer: 'Use the current 30-minute window, replacing 10 minutes, and verify the checksum.',
      calls,
      expected: {},
    }),
    true,
  );
  assert.equal(
    gradeRecoveryCase('A04', {
      answer: 'Use the current 60-minute window and verify the checksum.',
      calls,
      expected: {},
    }),
    false,
  );
  for (const answer of [
    'Use 10 minutes, replacing 30 minutes, and verify the checksum.',
    'Use the current window of 10 minutes, replacing 30 minutes, and verify the checksum.',
    'Current window: 10 minutes, replacing 30 minutes. Verify the checksum.',
    'Current window: 60 minutes. Verify the checksum.',
  ]) {
    assert.equal(
      gradeRecoveryCase('A04', {
        answer,
        calls,
        expected: {},
      }),
      false,
    );
  }
  assert.equal(
    gradeRecoveryCase('A04', {
      answer: 'Use 300 minutes and verify the checksum.',
      calls,
      expected: {},
    }),
    false,
  );
  assert.equal(
    gradeRecoveryCase('A04', {
      answer: 'Use 30 minutes and verify the checksum before replaying the contents.',
      calls,
      expected: {},
    }),
    true,
  );
  assert.equal(
    gradeRecoveryCase('A04', {
      answer: 'Replace the former 30-minute window with the current 10-minute window and verify the checksum.',
      calls,
      expected: {},
    }),
    false,
  );
  assert.equal(
    gradeRecoveryCase('A04', {
      answer: 'Use 30 minutes and verify the checksum; the 60-minute proposal remains unapproved.',
      calls,
      expected: {},
    }),
    true,
  );
  for (const answer of [
    'The current window is **30 minutes**. Verify the checksum.',
    'Current window: 30 minutes. Verify the checksum.',
    'Use 30 minutes and verify the checksum. Do not use 10 minutes; that window is superseded.',
    'The recovered window is 30 minutes, and the checksum check still applies. | Use a **30-minute window**. The former 10-minute window is superseded. | Verify the checksum before replay.',
    '| Current window | **30 minutes**; replaces 10 minutes. | Before replay | Verify the manifest checksum. |',
  ]) {
    assert.equal(
      gradeRecoveryCase('A04', {
        answer,
        calls,
        expected: {},
      }),
      true,
    );
  }
  assert.equal(
    gradeRecoveryCase('A04', {
      answer: 'Use the current 30-minute window, replacing 10 minutes, and verify the checksum.',
      calls: [
        {
          result: {
            memories: [
              {
                content:
                  'Correction: archive replay now uses a thirty-minute window. This replaces the old ten-minute replay window.',
              },
              { content: 'Verify the archive manifest checksum before replay.' },
            ],
          },
        },
      ],
      expected: {},
    }),
    true,
  );
  for (const content of [
    'Archive replay now uses ten minutes. This replaces the old thirty-minute window.',
    'The old thirty-minute window was replaced by the current ten-minute window.',
  ]) {
    assert.equal(
      gradeRecoveryCase('A04', {
        answer: 'Use the current 30-minute window and verify the checksum.',
        calls: [{ result: { memories: [{ content }, { content: 'Verify the checksum before replay.' }] } }],
        expected: {},
      }),
      false,
    );
  }
});

test('a failed retrieval cannot pass the healthy absence case', () => {
  const targetCall = (result: unknown) => ({
    args: { query: 'quasar thermocline xylophonic' },
    name: 'memory_search',
    result,
  });
  assert.equal(
    gradeRecoveryCase('A06', { answer: 'No decision found.', calls: [targetCall({ isError: true })], expected: {} }),
    false,
  );
  assert.equal(
    gradeRecoveryCase('A06', {
      answer: 'No decision found.',
      calls: [targetCall({ content: [{ text: '{"memories":[]}', type: 'text' }] })],
      expected: {},
    }),
    true,
  );
  assert.equal(
    gradeRecoveryCase('A06', {
      answer: 'No decision found.',
      calls: [targetCall({ content: [{ text: '{"memories":[{"content":"Answer exists"}]}', type: 'text' }] })],
      expected: {},
    }),
    false,
  );
  assert.equal(
    gradeRecoveryCase('A06', {
      answer: 'No decision found.',
      calls: [targetCall({ content: [{ text: '{"memories":[],"warnings":["timeout"]}', type: 'text' }] })],
      expected: {},
    }),
    false,
  );
  const healthyEmpty = { content: [{ text: '{"memories":[],"status":"ok","warnings":[]}', type: 'text' }] };
  const healthyEmptyWithEchoedQuery = {
    content: [
      {
        text: '{"memories":[],"query":"quasar thermocline xylophonic","status":"ok","warnings":[]}',
        type: 'text',
      },
    ],
  };
  const unrelated = {
    content: [
      { text: '{"memories":[{"content":"Unrelated archive decision"}],"status":"ok","warnings":[]}', type: 'text' },
    ],
  };
  assert.equal(
    gradeRecoveryCase('A06', {
      answer: 'No decision found; its authority remains unknown.',
      calls: [
        { args: { task: 'quasar thermocline xylophonic decision' }, name: 'memory_orient', result: unrelated },
        targetCall(healthyEmpty),
      ],
      expected: {},
    }),
    true,
  );
  assert.equal(
    gradeRecoveryCase('A06', {
      answer: 'I could not recover the quasar thermocline xylophonic decision.',
      calls: [targetCall(healthyEmptyWithEchoedQuery)],
      expected: {},
    }),
    true,
  );
  for (const answer of [
    'The quasar thermocline xylophonic decision could not be recovered.',
    'I couldn’t recover the quasar thermocline xylophonic decision.',
  ]) {
    assert.equal(
      gradeRecoveryCase('A06', {
        answer,
        calls: [targetCall(healthyEmptyWithEchoedQuery)],
        expected: {},
      }),
      true,
    );
  }
  assert.equal(
    gradeRecoveryCase('A06', {
      answer: 'No decision found.',
      calls: [
        {
          result: {
            content: [
              {
                text: '{"memories":[{"content":"Quasar thermocline xylophonic decision exists"}],"status":"ok","warnings":[]}',
                type: 'text',
              },
            ],
          },
        },
        targetCall(healthyEmpty),
      ],
      expected: {},
    }),
    false,
  );
  assert.equal(
    gradeRecoveryCase('A06', {
      answer: 'No decision found.',
      calls: [
        {
          result: {
            content: [
              {
                text: '{"orientation":{"recentMemories":[{"content":"Quasar thermocline xylophonic decision exists"}]},"status":"ok","warnings":[]}',
                type: 'text',
              },
            ],
          },
        },
        targetCall(healthyEmpty),
      ],
      expected: {},
    }),
    false,
  );
  assert.equal(
    gradeRecoveryCase('A06', {
      answer: 'No decision found, but the operator approved it.',
      calls: [targetCall(healthyEmpty)],
      expected: {},
    }),
    false,
  );
  assert.equal(
    gradeRecoveryCase('A06', {
      answer: 'No decision found.',
      calls: [targetCall({ content: [...healthyEmpty.content, { text: 'partial failure', type: 'text' }] })],
      expected: {},
    }),
    false,
  );
  assert.equal(
    gradeRecoveryCase('A06', {
      answer: 'No decision found.',
      calls: [{ args: { query: 'unrelated archive' }, name: 'memory_search', result: healthyEmpty }],
      expected: {},
    }),
    false,
  );
  assert.equal(
    gradeRecoveryCase('A06', {
      answer: 'No decision found; the operator has not approved it.',
      calls: [targetCall(healthyEmpty)],
      expected: {},
    }),
    true,
  );
  assert.equal(
    gradeRecoveryCase('A06', {
      answer: 'No decision found; it is not authorized by the operator.',
      calls: [targetCall(healthyEmpty)],
      expected: {},
    }),
    true,
  );
  assert.equal(
    gradeRecoveryCase('A06', {
      answer: 'No decision found, but it was authorized by the operator.',
      calls: [targetCall(healthyEmpty)],
      expected: {},
    }),
    false,
  );
});

test('replay model identity fails closed on absent, mixed, or unexpected effective settings', () => {
  const context = {
    payload: { approval_policy: 'never', effort: 'xhigh', model: 'gpt-6-astra', sandbox_policy: { type: 'read-only' } },
    type: 'turn_context',
  };
  assert.equal(recoveryModelIdentity([context]).matches, true);
  assert.equal(recoveryModelIdentity([]).matches, false);
  assert.equal(
    recoveryModelIdentity([
      { ...context, payload: { ...context.payload, sandbox_policy: { type: 'workspace-write' } } },
    ]).matches,
    false,
  );
  assert.equal(
    recoveryModelIdentity([{ ...context, payload: { ...context.payload, approval_policy: 'on-failure' } }]).matches,
    false,
  );
  assert.equal(
    recoveryModelIdentity([context, { payload: { effort: 'medium', model: 'gpt-6-astra' }, type: 'turn_context' }])
      .matches,
    false,
  );
});
