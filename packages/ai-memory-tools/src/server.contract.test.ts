import { isRecord } from '@aviaratech/ai-memory/internal';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  buildSessionStartHookContextFromPayload,
  memoryContinuityDebugInputSchema,
  memoryContinuityPackInputSchema,
  memoryFlushInputSchema,
  memoryGetInputSchema,
  memoryIngestContextPackInputSchema,
  memoryIngestDeltaInputSchema,
  memoryOrientInputSchema,
  memoryRuntimeDiagnosticsInputSchema,
  memorySearchInputSchema,
  memoryStoreInputSchema,
} from './server.js';

test('session-start hook context accepts provider snake_case session payloads', () => {
  const context = buildSessionStartHookContextFromPayload(
    {
      cwd: '/workspace/ai',
      hook_event_name: 'SessionStart',
      repo_id: 'example/catalog',
      session_id: 'provider-session-123',
    },
    {
      CLAUDE_PROJECT_DIR: '/workspace/from-env',
      PWD: '/workspace/from-pwd',
    },
  );

  assert.deepEqual(context, {
    cwd: '/workspace/ai',
    hookEventName: 'SessionStart',
    repoId: 'example/catalog',
    sessionId: 'provider-session-123',
  });
});

test('session-start hook context uses deterministic provider alias precedence', () => {
  const context = buildSessionStartHookContextFromPayload(
    {
      agent_id: 'agent-snake-fallback',
      agentId: 'agent-camel-fallback',
      event_name: 'EventSnakeFallback',
      eventName: 'EventCamelFallback',
      hook_event_name: 'HookSnakePreferred',
      hookEventName: 'HookCamelFallback',
      repo_id: 'repo-snake-preferred',
      repoId: 'repo-camel-fallback',
      repository: 'repository-fallback',
      session_id: 'session-snake-preferred',
      sessionId: 'session-camel-fallback',
    },
    {
      PWD: '/workspace/from-pwd',
    },
  );

  assert.deepEqual(context, {
    cwd: '/workspace/from-pwd',
    hookEventName: 'HookSnakePreferred',
    repoId: 'repo-snake-preferred',
    sessionId: 'session-snake-preferred',
  });
});

test('session-start hook context omits blank session ids without blocking startup', () => {
  const context = buildSessionStartHookContextFromPayload(
    {
      hookEventName: 'SessionStart',
      session_id: '   ',
    },
    {
      PWD: '/workspace/from-pwd',
    },
  );

  assert.deepEqual(context, {
    cwd: '/workspace/from-pwd',
    hookEventName: 'SessionStart',
  });
});

test('memory_continuity_pack schema accepts project or repoId scope', () => {
  const byProject = memoryContinuityPackInputSchema.parse({
    project: 'example/catalog',
  });
  const byRepoId = memoryContinuityPackInputSchema.parse({
    repoId: 'example/catalog',
  });

  assert.equal(byProject.project, 'example/catalog');
  assert.equal(byRepoId.repoId, 'example/catalog');
});

test('memory_continuity_pack schema accepts one explicit lead, outcome, or task scope', () => {
  assert.deepEqual(memoryContinuityPackInputSchema.parse({ project: 'example/catalog', task: 'issue-2930' }), {
    project: 'example/catalog',
    task: 'issue-2930',
  });
  assert.throws(
    () => memoryContinuityPackInputSchema.parse({ lead: 'tech-lead', outcome: 'restore', project: 'example/catalog' }),
    /exactly one/i,
  );
});

test('memory_continuity_debug schema accepts project or repoId scope', () => {
  const byProject = memoryContinuityDebugInputSchema.parse({
    project: 'example/catalog',
  });
  const byRepoId = memoryContinuityDebugInputSchema.parse({
    repoId: 'example/catalog',
  });

  assert.equal(byProject.project, 'example/catalog');
  assert.equal(byRepoId.repoId, 'example/catalog');
});

test('memory_orient schema accepts project, task, and an explicit session id', () => {
  const parsed = memoryOrientInputSchema.parse({
    project: 'example/catalog',
    sessionId: 'lead-session-2930',
    task: 'implement feature X',
  });
  assert.equal(parsed.project, 'example/catalog');
  assert.equal(parsed.sessionId, 'lead-session-2930');
  assert.equal(parsed.task, 'implement feature X');
});

test('memory_search schema supports compact previews and exact session scope', () => {
  const parsed = memorySearchInputSchema.parse({
    fullContentTopN: 1,
    memoryDetail: 'compact',
    project: 'example/catalog',
    query: 'current lead checkpoint',
    sessionId: 'lead-session-2930',
  });

  assert.equal(parsed.memoryDetail, 'compact');
  assert.equal(parsed.fullContentTopN, 1);
  assert.equal(parsed.sessionId, 'lead-session-2930');
});

test('memory_orient schema accepts stateModel', () => {
  const parsed = memoryOrientInputSchema.parse({
    project: 'example/catalog',
    stateModel: { strategy_confidence: 'high' },
  });
  assert.equal(parsed.stateModel?.strategy_confidence, 'high');
});

test('memory_orient schema allows stateModel to be omitted', () => {
  const parsed = memoryOrientInputSchema.parse({
    project: 'example/catalog',
  });
  assert.equal(parsed.stateModel, undefined);
});

test('memory_store schema accepts numeric confidence as both number and JSON-encoded string', () => {
  const asNumber = memoryStoreInputSchema.parse({
    category: 'decision',
    confidence: 0.9,
    content: 'numeric form',
  });
  assert.equal(asNumber.confidence, 0.9);

  const asString = memoryStoreInputSchema.parse({
    category: 'decision',
    confidence: '0.9',
    content: 'string form',
  });
  assert.equal(asString.confidence, 0.9);
});

test('memory_store schema rejects non-numeric strings for confidence', () => {
  assert.throws(() =>
    memoryStoreInputSchema.parse({
      category: 'decision',
      confidence: 'abc',
      content: 'invalid form',
    }),
  );
});

test('memory_store schema accepts integer fields (importance, supersedesId) as JSON-encoded strings', () => {
  const parsed = memoryStoreInputSchema.parse({
    category: 'decision',
    content: 'string-encoded integers',
    importance: '0.75',
    supersedesId: '42',
  });
  assert.equal(parsed.importance, 0.75);
  assert.equal(parsed.supersedesId, 42);
});

test('memory_flush schema accepts summary and decisions', () => {
  const parsed = memoryFlushInputSchema.parse({
    contextNeeded: ['Review the latest ai-reviewer notes before merging.'],
    decisions: ['use Zod for validation'],
    summary: 'Implemented schema validation for MCP tools.',
  });
  assert.equal(parsed.summary, 'Implemented schema validation for MCP tools.');
  assert.deepEqual(parsed.contextNeeded, ['Review the latest ai-reviewer notes before merging.']);
  assert.deepEqual(parsed.decisions, ['use Zod for validation']);
});

test('memory_flush schema rejects agent writers without nextActions', () => {
  assert.throws(
    () =>
      memoryFlushInputSchema.parse({
        source: 'codex',
        summary: 'Agent writer flush without next actions should fail before any database write.',
      }),
    /nextActions/u,
  );
});

test('memory_flush schema rejects agent writers without openQuestions or assumptions', () => {
  assert.throws(
    () =>
      memoryFlushInputSchema.parse({
        nextActions: ['Continue validation.'],
        source: 'gpt-builder',
        stateModel: { strategy_confidence: 'medium' },
        summary: 'Agent writer flush without unresolved questions or explicit assumptions should fail validation.',
      }),
    /openQuestions.*stateModel\.assumptions/u,
  );
});

test('memory_flush schema accepts agent writers with nextActions and assumptions when openQuestions is empty', () => {
  const parsed = memoryFlushInputSchema.parse({
    nextActions: ['Run package tests.'],
    source: 'claude-reviewer',
    stateModel: {
      assumptions: ['No open questions remain after review.'],
      strategy_confidence: 'medium',
    },
    summary: 'Agent writer flush can declare no open questions by preserving explicit assumptions.',
  });

  assert.deepEqual(parsed.nextActions, ['Run package tests.']);
  assert.deepEqual(parsed.openQuestions, undefined);
});

test('memory_flush schema keeps manual and hook writers unconstrained', () => {
  const manual = memoryFlushInputSchema.parse({
    source: 'manual-flush',
    summary: 'Manual sparse flush remains valid.',
  });
  const hook = memoryFlushInputSchema.parse({
    source: 'codex-hook',
    summary: 'Hook sparse flush remains valid.',
  });

  assert.equal(manual.source, 'manual-flush');
  assert.equal(hook.source, 'codex-hook');
});

test('memory_flush schema accepts near-miss confidence_history values', () => {
  const parsed = memoryFlushInputSchema.parse({
    stateModel: {
      confidence_history: [{ reason: 'recalibrated', value: 'medium-high' }],
      strategy_confidence: 'high',
    },
    summary: 'Near-miss confidence_history value should pass schema.',
  });
  const entry = parsed.stateModel?.confidence_history?.[0];
  if (entry === undefined) {
    assert.fail('expected confidence_history entry');
  }
  assert.equal(entry.value, 'medium-high', 'schema should pass through the raw string for downstream normalization');
});

test('memory_flush schema accepts valid confidence_history values', () => {
  const parsed = memoryFlushInputSchema.parse({
    stateModel: {
      confidence_history: [{ reason: 'initial', value: 'high' }],
      strategy_confidence: 'low',
    },
    summary: 'Valid confidence_history value.',
  });
  const entry = parsed.stateModel?.confidence_history?.[0];
  if (entry === undefined) {
    assert.fail('expected confidence_history entry');
  }
  assert.equal(entry.value, 'high');
});

test('memory_flush schema accepts JSON-stringified structured params', () => {
  const parsed = memoryFlushInputSchema.parse({
    decisions: '["use Zod preprocessors"]',
    envModel: '{"branch":"issue/596","workspaceDirty":false}',
    nextActions: '["run package tests","finalize the issue"]',
    openQuestions: '["Should malformed JSON keep failing validation?"]',
    rootCauses: '["Claude Code transport stringifies structured values"]',
    stateModel:
      '{"strategy_confidence":"low","assumptions":["MCP transports may stringify nested values"],"uncertainty":["Need boundary coercion only"]}',
    summary: 'Structured params should parse even when the transport sends them as JSON strings.',
  });
  assert.deepEqual(parsed.decisions, ['use Zod preprocessors']);
  assert.deepEqual(parsed.nextActions, ['run package tests', 'finalize the issue']);
  assert.deepEqual(parsed.openQuestions, ['Should malformed JSON keep failing validation?']);
  assert.deepEqual(parsed.rootCauses, ['Claude Code transport stringifies structured values']);
  assert.deepEqual(parsed.envModel, { branch: 'issue/596', workspaceDirty: false });
  if (parsed.stateModel === undefined) {
    assert.fail('expected stateModel to be defined');
  }
  assert.equal(parsed.stateModel.strategy_confidence, 'low');
  assert.deepEqual(parsed.stateModel.assumptions, ['MCP transports may stringify nested values']);
});

test('memory_flush schema rejects confidence_history with missing value', () => {
  assert.throws(
    () =>
      memoryFlushInputSchema.parse({
        stateModel: {
          confidence_history: [{ reason: 'no value field' }],
          strategy_confidence: 'high',
        },
        summary: 'Missing value field.',
      }),
    /invalid_type|required/i,
  );
});

test('memory_orient schema accepts JSON-stringified stateModel', () => {
  const parsed = memoryOrientInputSchema.parse({
    project: 'example/catalog',
    stateModel:
      '{"strategy_confidence":"medium","assumptions":["Read the issue spec first"],"constraints":["Keep the fix at the schema boundary"]}',
  });
  if (parsed.stateModel === undefined) {
    assert.fail('expected stateModel to be defined');
  }
  assert.equal(parsed.stateModel.strategy_confidence, 'medium');
  assert.deepEqual(parsed.stateModel.assumptions, ['Read the issue spec first']);
  assert.deepEqual(parsed.stateModel.constraints, ['Keep the fix at the schema boundary']);
});

test('memory_flush schema rejects malformed JSON-stringified arrays', () => {
  assert.throws(
    () =>
      memoryFlushInputSchema.parse({
        decisions: '["unterminated"',
        summary: 'Malformed JSON should stay invalid.',
      }),
    /invalid_type/i,
  );
});

test('memory_store schema accepts JSON-stringified array and object params', () => {
  const parsed = memoryStoreInputSchema.parse({
    category: 'decision',
    content: 'Accept stringified structured params at the boundary.',
    evidenceRefs: '["packages/ai-memory-tools/src/server.ts",{"issue":"#90005"}]',
    metadata: '{"path":"packages/ai-memory-tools/src/server.ts","shape":"boundary-coercion"}',
    tags: '["ai-memory","issue-596"]',
  });
  assert.deepEqual(parsed.evidenceRefs, ['packages/ai-memory-tools/src/server.ts', { issue: '#90005' }]);
  assert.deepEqual(parsed.metadata, {
    path: 'packages/ai-memory-tools/src/server.ts',
    shape: 'boundary-coercion',
  });
  assert.deepEqual(parsed.tags, ['ai-memory', 'issue-596']);
});

test('memory_get schema accepts JSON-stringified ids', () => {
  const parsed = memoryGetInputSchema.parse({
    ids: '[101,102,103]',
  });
  assert.deepEqual(parsed.ids, [101, 102, 103]);
});

test('memory_ingest_context_pack schema accepts a JSON-stringified payload', () => {
  const parsed = memoryIngestContextPackInputSchema.parse({
    contextPack: '{"schema_version":"context_pack@0.1","session":{"id":"session-123"}}',
  });
  assert.deepEqual(parsed.contextPack, {
    schema_version: 'context_pack@0.1',
    session: { id: 'session-123' },
  });
});

test('memory_ingest_delta schema accepts a JSON-stringified payload', () => {
  const parsed = memoryIngestDeltaInputSchema.parse({
    memoryDelta: '{"schema_version":"memory_delta@0.1","events":[]}',
  });
  assert.deepEqual(parsed.memoryDelta, {
    events: [],
    schema_version: 'memory_delta@0.1',
  });
});

test('memory_runtime_diagnostics schema accepts an empty object', () => {
  const parsed = memoryRuntimeDiagnosticsInputSchema.parse({});
  assert.deepStrictEqual(parsed, {});
});

test('final search response includes its escaped MCP envelope in the byte budget for every detail mode', async () => {
  const { finalizeSearchResponse, SEARCH_RESPONSE_BUDGET_BYTES } = await import('./server.js');
  const content = '\\"\n\u0000🧠'.repeat(10000);
  const memories = Array.from({ length: 25 }, (_, index) => ({
    content,
    evidenceRefs: ['url'.repeat(3000)],
    id: index + 1,
    signals: { huge: 's'.repeat(3000) },
    source: 'source'.repeat(2000),
    tags: ['tag'.repeat(3000)],
  }));
  const original = JSON.stringify(memories);
  for (const args of [{}, { memoryDetail: 'full' }, { fullContentTopN: 5 }]) {
    const response = finalizeSearchResponse(
      {
        content: [{ text: JSON.stringify({ count: 25, memories, warnings: ['warning'.repeat(10000)] }), type: 'text' }],
      },
      { limit: 25, query: 'fixture', ...args },
    );
    assert.ok(Buffer.byteLength(JSON.stringify(response)) <= SEARCH_RESPONSE_BUDGET_BYTES);
    const payload = readSearchPayload(response);
    assert.equal(payload.candidateCount, 25);
    assert.equal(payload.count, payload.memories.length);
    assert.ok(payload.truncated);
    assert.ok(payload.warningsTruncated);
    assert.equal(payload.memories[0]?.id, 1);
    assert.deepEqual(
      payload.memories.map(memory => memory.id),
      memories.slice(0, payload.memories.length).map(memory => memory.id),
    );
    assert.equal(payload.memories[0].content, undefined);
    assert.equal(payload.memories[0].detail, 'compact');
    assert.equal(JSON.stringify(memories), original);
  }
});

test('full search returns whole records when they fit and explicitly downgrades oversized full content', async () => {
  const { finalizeSearchResponse } = await import('./server.js');
  const memories = [{ content: 'complete content', extra: 'preserved', id: 1 }];
  const response = finalizeSearchResponse(
    { content: [{ text: JSON.stringify({ memories }), type: 'text' }] },
    { memoryDetail: 'full', query: 'fixture' },
  );
  const payload = readSearchPayload(response);
  assert.deepEqual(payload.memories, [{ ...memories[0], detail: 'full' }]);
  assert.equal(payload.truncated, false);
  assert.equal(payload.candidateCount, 1);
  const topN = finalizeSearchResponse(
    { content: [{ text: JSON.stringify({ memories }), type: 'text' }] },
    { fullContentTopN: 1, query: 'fixture' },
  );
  const topNPayload = readSearchPayload(topN);
  assert.ok(topNPayload.memories[0] !== undefined);
  assert.equal(topNPayload.memories[0].content, memories[0]?.content);
  assert.equal(topNPayload.memories[0].extra, undefined);
  assert.equal(topNPayload.memories[0].detail, 'full');
});

test('empty and error search responses remain bounded and errors expose no raw diagnostic body', async () => {
  const { finalizeSearchResponse, SEARCH_RESPONSE_BUDGET_BYTES } = await import('./server.js');
  for (const response of [
    { content: [{ text: '{"memories":[]}', type: 'text' as const }] },
    { content: [{ text: 'SECRET'.repeat(100000), type: 'text' as const }], isError: true as const },
  ]) {
    const result = finalizeSearchResponse(response, { query: 'SECRET' });
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= SEARCH_RESPONSE_BUDGET_BYTES);
    assert.ok(!JSON.stringify(result).includes('SECRET'));
    const payload = readSearchPayload(result);
    assert.equal(payload.count, 0);
    assert.equal(payload.candidateCount, 0);
    if (response.isError) assert.equal(result.isError, true);
  }
});

test('tools/list publishes side-effect annotations for every registered memory operation', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { server } = await import('./server.js');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'annotation-fixture', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    // readOnly, destructive, idempotent, openWorld. Domain effects, excluding
    // shared invocation/failure telemetry. Reads that boost importance are writes.
    const expected: Record<string, boolean[]> = {
      memory_continuity_debug: [true, false, true, false],
      memory_continuity_pack: [true, false, true, false],
      memory_flush: [false, true, false, true],
      memory_get: [true, false, true, false],
      memory_ingest_context_pack: [false, true, false, false],
      memory_ingest_delta: [false, true, false, false],
      memory_ingestion_failures: [true, false, true, false],
      memory_orient: [false, true, false, true],
      memory_recall: [false, true, false, false],
      memory_resolve_contested: [false, true, false, false],
      memory_runtime_diagnostics: [false, true, false, false],
      memory_search: [false, true, false, true],
      memory_session_resume: [true, false, true, false],
      memory_session_tail: [true, false, true, false],
      memory_store: [false, true, false, true],
    };
    assert.deepEqual(tools.map(tool => tool.name).sort(), Object.keys(expected).sort());
    for (const tool of tools) {
      assert.deepEqual(
        [
          tool.annotations?.readOnlyHint,
          tool.annotations?.destructiveHint,
          tool.annotations?.idempotentHint,
          tool.annotations?.openWorldHint,
        ],
        expected[tool.name],
        tool.name,
      );
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test('escaped warnings alone cannot overflow empty, degraded or error search results', async () => {
  const { finalizeSearchResponse, SEARCH_RESPONSE_BUDGET_BYTES } = await import('./server.js');
  for (const isError of [false, true]) {
    const response = finalizeSearchResponse(
      {
        content: [
          {
            text: JSON.stringify({
              memories: [],
              status: 'degraded',
              warningDetails: Array(10).fill({ code: '\u0000'.repeat(10000), message: '\u0000'.repeat(10000) }),
              warnings: Array(10).fill('\u0000'.repeat(10000)),
            }),
            type: 'text',
          },
        ],
        ...(isError ? { isError: true as const } : {}),
      },
      { query: 'fixture' },
    );
    assert.ok(Buffer.byteLength(JSON.stringify(response)) <= SEARCH_RESPONSE_BUDGET_BYTES);
    const payload = readSearchPayload(response);
    assert.equal(payload.warningsTruncated, true);
    assert.equal(payload.status, isError ? 'error' : 'degraded');
  }
});

function readSearchPayload(response: {
  content: { text: string }[];
}): Record<string, unknown> & { memories: Record<string, unknown>[] } {
  const payload: unknown = JSON.parse(response.content[0]?.text ?? '{}');
  assert.ok(isRecord(payload));
  assert.ok(Array.isArray(payload.memories) && payload.memories.every(isRecord));
  return { ...payload, memories: payload.memories };
}
