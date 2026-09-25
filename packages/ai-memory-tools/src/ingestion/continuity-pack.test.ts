import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  buildContinuityPackDebugPayload,
  buildContinuityPackFromFlush,
  buildScopedContinuityPacksFromFlush,
  formatContinuityPackMarkdown,
} from './continuity-pack.js';
import { parseFlushInput } from './flush-session.js';

const TEST_NOW_ISO = '2026-06-28T20:00:00.000Z';
const TEST_SESSION_ID = 'session-continuity-pack';

test('buildContinuityPackFromFlush preserves curated flush provenance and reflection count', () => {
  const parsed = parseFlushInput({
    agent: 'codex-builder',
    contextNeeded: ['Review the latest ai-reviewer verdict before publishing.'],
    decisions: ['Use one pre-materialized continuity pack instead of session-start fanout.'],
    envModel: { branch: 'codex/ai-memory-continuity', workspaceDirty: false },
    nextActions: ['Wire continuity pack reads into the session-start hook.'],
    openQuestions: ['Should stale packs render a warning in bootstrap text?'],
    project: 'example/catalog',
    source: 'manual-flush',
    stateModel: {
      assumptions: ['Explicit memory_flush payloads are the trusted continuity source.'],
      strategy_confidence: 'medium',
      uncertainty: [],
    },
    summary:
      'Cross-chat continuity should reuse the existing explicit flush and compaction path rather than checkpoint every assistant output.',
  });

  const pack = buildContinuityPackFromFlush({
    budgetChars: 1200,
    nowIso: TEST_NOW_ISO,
    parsed,
    reflectionCount: 2,
    sessionId: TEST_SESSION_ID,
  });

  assert.equal(pack.project, 'example/catalog');
  assert.equal(pack.scopeKey, 'project:example/catalog');
  assert.equal(pack.source, 'manual-flush');
  assert.equal(pack.pack.provenance.sessionId, TEST_SESSION_ID);
  assert.equal(pack.pack.provenance.source, 'manual-flush');
  assert.equal(pack.pack.provenance.continuityFields, 'agent-authored');
  assert.equal(pack.pack.reflection.count, 2);
  assert.deepEqual(pack.pack.nextActions, ['Wire continuity pack reads into the session-start hook.']);
  assert.deepEqual(pack.pack.contextNeeded, ['Review the latest ai-reviewer verdict before publishing.']);

  const markdown = formatContinuityPackMarkdown(pack);
  assert.match(markdown, /Cross-Chat Continuity/u);
  assert.match(markdown, /field provenance: agent-authored/u);
  assert.match(markdown, /pre-materialized continuity pack/u);
  assert.match(markdown, /Wire continuity pack reads/u);
  assert.match(markdown, /Context Needed/u);
  assert.match(markdown, /latest ai-reviewer verdict/u);
});

test('buildScopedContinuityPacksFromFlush retains project startup context without letting it replace lead, outcome, or task checkpoints', () => {
  const parsed = parseFlushInput({
    agent: 'codex-builder',
    lead: 'tech-lead',
    nextActions: ['Resume the current issue checkpoint from its explicit scope.'],
    openQuestions: ['Is the current issue ready for review?'],
    outcome: 'restore-ai-memory-delivery-control',
    project: 'example/catalog',
    stateModel: {
      assumptions: ['Project-latest context is background only.'],
      strategy_confidence: 'medium',
    },
    summary: 'The lead checkpoint must remain distinct after a worker flush updates project startup context.',
    task: 'issue-2930',
  });

  const packs = buildScopedContinuityPacksFromFlush({
    budgetChars: 1200,
    nowIso: TEST_NOW_ISO,
    parsed,
    reflectionCount: 0,
    sessionId: TEST_SESSION_ID,
  });

  assert.deepEqual(
    packs.map(pack => pack.scopeKey),
    [
      'project:example/catalog',
      'lead:example/catalog:tech-lead',
      'outcome:example/catalog:restore-ai-memory-delivery-control',
      'task:example/catalog:issue-2930',
    ],
  );
  const [projectPack, leadPack] = packs;
  assert.ok(projectPack !== undefined);
  assert.ok(leadPack !== undefined);
  assert.match(formatContinuityPackMarkdown(projectPack), /background project context/u);
  assert.match(formatContinuityPackMarkdown(leadPack), /scoped checkpoint/u);
});

test('buildContinuityPackFromFlush enforces the bootstrap budget at write time', () => {
  const parsed = parseFlushInput({
    decisions: Array.from({ length: 8 }, (_, index) => `Decision ${String(index)}: ${'important context '.repeat(10)}`),
    nextActions: ['Continue with the bounded continuity-pack implementation.'],
    openQuestions: ['How much detail can fit without bloating startup context?'],
    project: 'example/catalog',
    stateModel: {
      assumptions: ['The pack builder can truncate lower-priority detail deterministically.'],
      strategy_confidence: 'medium',
    },
    summary: `Long continuity summary. ${'The agent should see the durable goal without receiving raw transcript text. '.repeat(20)}`,
  });

  const pack = buildContinuityPackFromFlush({
    budgetChars: 420,
    nowIso: TEST_NOW_ISO,
    parsed,
    reflectionCount: 0,
    sessionId: TEST_SESSION_ID,
  });

  assert.equal(pack.budgetChars, 420);
  assert.ok(pack.payloadChars <= 420, `payload should fit budget, got ${String(pack.payloadChars)} chars`);
  assert.equal(pack.pack.budgets.truncated, true);
  assert.match(formatContinuityPackMarkdown(pack), /truncated/u);
});

test('buildContinuityPackFromFlush hard-caps unusually tiny budgets', () => {
  const parsed = parseFlushInput({
    nextActions: ['Continue with the bounded continuity-pack implementation.'],
    openQuestions: ['How much detail can fit without bloating startup context?'],
    project: 'example/catalog',
    stateModel: {
      assumptions: ['The pack builder can truncate lower-priority detail deterministically.'],
      strategy_confidence: 'medium',
    },
    summary:
      'The continuity pack should always respect the configured character budget, even when the caller sets a tiny budget.',
  });

  const pack = buildContinuityPackFromFlush({
    budgetChars: 80,
    nowIso: TEST_NOW_ISO,
    parsed,
    reflectionCount: 0,
    sessionId: TEST_SESSION_ID,
  });

  assert.ok(pack.payloadChars <= 80, `payload should fit budget, got ${String(pack.payloadChars)} chars`);
  assert.ok(formatContinuityPackMarkdown(pack).length <= 80);
  assert.equal(pack.pack.budgets.truncated, true);
});

test('buildContinuityPackFromFlush keeps unrendered structured models out of the read pack', () => {
  const parsed = parseFlushInput({
    activeGoal: 'Do not echo raw goal context into the project continuity pack.',
    envModel: {
      shellHistory: 'raw terminal output '.repeat(500),
      workspaceDirty: true,
    },
    nextActions: ['Continue with safe continuity-pack refresh.'],
    openQuestions: ['Should structured environment detail remain in flush snapshots only?'],
    project: 'example/catalog',
    stateModel: {
      assumptions: ['raw transcript line '.repeat(500)],
      strategy_confidence: 'medium',
    },
    summary:
      'The continuity pack is an allowlisted handoff surface. Rich state and environment models remain available through existing flush snapshot storage.',
  });

  const pack = buildContinuityPackFromFlush({
    budgetChars: 1200,
    nowIso: TEST_NOW_ISO,
    parsed,
    reflectionCount: 1,
    sessionId: TEST_SESSION_ID,
  });
  const packJson = JSON.stringify(pack.pack);

  assert.equal('activeGoal' in pack.pack, false);
  assert.equal('envModel' in pack.pack, false);
  assert.equal('stateModel' in pack.pack, false);
  assert.doesNotMatch(packJson, /raw terminal output/u);
  assert.doesNotMatch(packJson, /raw transcript line/u);
  assert.ok(packJson.length <= 1200, `pack JSON should stay bounded, got ${String(packJson.length)} chars`);
});

test('buildContinuityPackDebugPayload renders the exact startup pack with budget metadata', () => {
  const parsed = parseFlushInput({
    contextNeeded: ['Review health-report continuity quality output.'],
    decisions: ['Keep vectors out of startup continuity.'],
    nextActions: ['Use the debug surface to inspect the startup pack.'],
    openQuestions: ['Should the pack be refreshed before the next chat?'],
    project: 'example/catalog',
    stateModel: {
      assumptions: ['The debug path is read-only.'],
      strategy_confidence: 'medium',
    },
    summary: 'Continuity debug should show exactly what startup would inject, plus bounded budget metadata.',
  });
  const built = buildContinuityPackFromFlush({
    budgetChars: 1200,
    nowIso: TEST_NOW_ISO,
    parsed,
    reflectionCount: 1,
    sessionId: TEST_SESSION_ID,
  });

  const payload = buildContinuityPackDebugPayload({
    pack: {
      budgetChars: built.budgetChars,
      createdAt: TEST_NOW_ISO,
      pack: built.pack,
      payloadChars: built.payloadChars,
      project: built.project,
      scopeKey: built.scopeKey,
      sessionId: TEST_SESSION_ID,
      source: built.source,
      status: 'fresh',
      updatedAt: TEST_NOW_ISO,
    },
    status: 'found',
  });

  assert.equal(payload.status, 'found');
  assert.equal(payload.project, 'example/catalog');
  assert.equal(payload.scopeKey, 'project:example/catalog');
  assert.equal(payload.renderedText, formatContinuityPackMarkdown(built));
  assert.equal(payload.budget.budgetChars, 1200);
  assert.equal(payload.budget.payloadChars, built.payloadChars);
  assert.equal(payload.budget.truncated, false);
  assert.ok(payload.budget.pressurePct > 0);
});

test('reconnected and cross-harness checkpoints retain logical task state after another task flush', () => {
  const latest = new Map<string, ReturnType<typeof buildContinuityPackFromFlush>>();
  const writes = [
    {
      agent: 'codex',
      sessionId: 'fixture-codex-a',
      summary: 'Checkpoint A: keep the archive offline.',
      task: 'fixture-export-task',
    },
    {
      agent: 'codex',
      sessionId: 'fixture-codex-a',
      summary: 'Checkpoint A2: checksum passed; customer review remains pending.',
      task: 'fixture-export-task',
    },
    {
      agent: 'claude-code',
      sessionId: 'fixture-claude-b',
      summary: 'Checkpoint B: preserve the no-upload condition across harnesses.',
      task: 'fixture-export-task',
    },
    {
      agent: 'grok-build',
      sessionId: 'fixture-worker-w',
      summary: 'Worker W: unrelated documentation index completed.',
      task: 'fixture-other-task',
    },
  ];
  for (const write of writes) {
    const parsed = parseFlushInput({
      ...write,
      contextNeeded: ['A project flush does not replace task authority.'],
      nextActions: ['Verify the original customer review before uploading.'],
      project: 'fixture/recovery',
    });
    for (const pack of buildScopedContinuityPacksFromFlush({
      nowIso: TEST_NOW_ISO,
      parsed,
      reflectionCount: 0,
      sessionId: write.sessionId,
    }))
      latest.set(pack.scopeKey, pack);
  }
  const task = latest.get('task:fixture/recovery:fixture-export-task');
  assert.ok(task !== undefined);
  assert.equal(task.pack.summary, writes[2]?.summary);
  assert.equal(task.pack.provenance.sessionId, 'fixture-claude-b');
  assert.equal(task.pack.provenance.agent, 'claude-code');
  assert.equal(task.pack.provenance.scope.id, 'fixture-export-task');
  assert.deepEqual(task.pack.nextActions, ['Verify the original customer review before uploading.']);
  assert.equal(latest.get('project:fixture/recovery')?.pack.summary, writes[3]?.summary);
  assert.equal(latest.get('task:fixture/foreign:fixture-export-task'), undefined);
});
