import * as memory from '@aviaratech/ai-memory/internal';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, vi } from 'vitest';

// Mock before importing the MCP server: this fixture exercises the registered
// handler, warnings, telemetry and drilldown without a database or provider call.
const fixture: unknown = JSON.parse(
  readFileSync(new URL('./eval/fixtures/retrieval/core-retrieval.json', import.meta.url), 'utf8'),
);
assert.ok(memory.isRecord(fixture) && Array.isArray(fixture.memories));
const ranked = fixture.memories.filter(memory.isRecord).map((row, index) => ({
  ...row,
  content: `${String(row.content)}\n${'"\\\u0000🧠'.repeat(10000)}`,
  id: index + 1,
}));
const invocations: memory.ToolInvocationInput[] = [];
let receivedSearchArgs: unknown;
let searchFailure: Error | undefined;
let emptySearch = false;
let emitWarnings = true;
vi.doMock('@aviaratech/ai-memory/internal', () => ({
  ...memory,
  getMemoryEntries: (args: unknown) => {
    assert.ok(memory.isRecord(args));
    return Promise.resolve(ranked.filter(row => row.id === args.id));
  },
  logAiMemoryError: () => {},
  logAiMemoryInfo: () => {},
  logAiMemoryWarn: () => {},
  recordIngestionFailure: () => Promise.resolve(),
  recordToolInvocation: (input: memory.ToolInvocationInput) => {
    invocations.push(input);
    return Promise.resolve();
  },
  searchMemories: (args: unknown) => {
    receivedSearchArgs = args;
    if (searchFailure !== undefined) throw searchFailure;
    if (emitWarnings) {
      memory.recordAiMemoryWarningDetail({
        code: 'fixture.timeout',
        message: 'db.read.search_memories timed out after 10ms',
      });
    }
    return Promise.resolve(emptySearch ? [] : ranked);
  },
}));
const { SEARCH_RESPONSE_BUDGET_BYTES, server } = await import('./server.js');

test('registered search preserves candidates and scope, accounts for appended warnings, and gets original full content', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'search-fixture', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const before = JSON.stringify(ranked);
  try {
    for (const options of [{ memoryDetail: 'compact' }, { memoryDetail: 'full' }, { fullContentTopN: 5 }]) {
      const args = {
        includeInactive: true,
        limit: 8,
        project: 'fixture',
        query: 'architecture',
        sessionId: 'known-session',
        ...options,
      };
      const response = await client.callTool({ arguments: args, name: 'memory_search' });
      assert.deepEqual(receivedSearchArgs, args);
      const bytes = Buffer.byteLength(JSON.stringify(response));
      assert.ok(bytes <= SEARCH_RESPONSE_BUDGET_BYTES);
      assert.ok(Array.isArray(response.content));
      const first: unknown = response.content[0];
      assert.ok(memory.isRecord(first) && typeof first.text === 'string');
      const payload: unknown = JSON.parse(first.text);
      assert.ok(memory.isRecord(payload) && Array.isArray(payload.memories));
      const returned = payload.memories.filter(memory.isRecord);
      assert.equal(payload.candidateCount, ranked.length);
      assert.deepEqual(
        returned.map(row => row.id),
        ranked.slice(0, returned.length).map(row => row.id),
      );
      assert.deepEqual(payload.warnings, ['db.read.search_memories timed out after 10ms']);
      const invocation = invocations.at(-1);
      assert.equal(invocation?.summaryFields.search_response_bytes, bytes);
      assert.equal(invocation.summaryFields.search_returned_count, returned.length);
      assert.ok(!JSON.stringify(invocation.summaryFields).includes('architecture'));
      const full = await client.callTool({ arguments: { id: returned[0]?.id }, name: 'memory_get' });
      assert.ok(Array.isArray(full.content));
      const fullFirst: unknown = full.content[0];
      assert.ok(memory.isRecord(fullFirst) && typeof fullFirst.text === 'string');
      const fullPayload: unknown = JSON.parse(fullFirst.text);
      assert.ok(memory.isRecord(fullPayload) && Array.isArray(fullPayload.memories));
      assert.deepEqual(fullPayload.memories[0], ranked[0]);
      const oldPayload = {
        count: ranked.length,
        memories: memory.formatMemoryPayload({
          fullContentTopN: options.fullContentTopN ?? 0,
          memories: ranked,
          memoryDetail: options.memoryDetail === 'full' ? 'full' : 'compact',
        }),
      };
      const oldResponse = memory.appendAiMemoryWarningsToTextResult(
        { content: [{ text: JSON.stringify(oldPayload, null, 2), type: 'text' as const }] },
        [{ code: 'fixture.timeout', message: 'db.read.search_memories timed out after 10ms' }],
      );
      const oldBytes = Buffer.byteLength(JSON.stringify(oldResponse));
      assert.ok(bytes < oldBytes, `same fixture ${JSON.stringify(options)} should reduce serialized response bytes`);
    }
    assert.equal(JSON.stringify(ranked), before);
    emitWarnings = false;
    const healthy = await client.callTool({ arguments: { query: 'fixture' }, name: 'memory_search' });
    assert.ok(Array.isArray(healthy.content));
    const healthyFirst: unknown = healthy.content[0];
    assert.ok(memory.isRecord(healthyFirst) && typeof healthyFirst.text === 'string');
    const healthyPayload: unknown = JSON.parse(healthyFirst.text);
    assert.ok(memory.isRecord(healthyPayload));
    assert.equal(healthyPayload.status, 'ok');
    assert.equal(healthyPayload.warnings, undefined);
    assert.equal(invocations.at(-1)?.timeoutWarningCount, 0);
    emptySearch = true;
    const empty = await client.callTool({ arguments: { query: 'fixture' }, name: 'memory_search' });
    assert.ok(Array.isArray(empty.content));
    const emptyFirst: unknown = empty.content[0];
    assert.ok(memory.isRecord(emptyFirst) && typeof emptyFirst.text === 'string');
    const emptyPayload: unknown = JSON.parse(emptyFirst.text);
    assert.ok(memory.isRecord(emptyPayload));
    assert.equal(empty.isError, undefined);
    assert.equal(emptyPayload.status, 'ok');
    assert.equal(emptyPayload.candidateCount, 0);
    assert.equal(emptyPayload.count, 0);
    assert.equal(emptyPayload.warnings, undefined);
    assert.equal(invocations.at(-1)?.warningCount, 0);
    assert.equal(invocations.at(-1)?.timeoutWarningCount, 0);
    emptySearch = false;

    for (const phase of [
      'db.read.search_memories',
      'db.read.search_memories.reversal_penalty',
      'db.read.search_memories.fallback',
      'db.read.search_memories.fallback_reversal_penalty',
    ]) {
      searchFailure = new memory.TimeoutError(phase, 5000);
      searchFailure.message = 'SECRET_DATABASE_URL private fixture query';
      const timeout = await client.callTool({ arguments: { query: 'fixture' }, name: 'memory_search' });
      assert.ok(Array.isArray(timeout.content));
      const timeoutFirst: unknown = timeout.content[0];
      assert.ok(memory.isRecord(timeoutFirst) && typeof timeoutFirst.text === 'string');
      const timeoutPayload: unknown = JSON.parse(timeoutFirst.text);
      assert.ok(memory.isRecord(timeoutPayload));
      assert.equal(timeout.isError, true);
      assert.equal(timeoutPayload.status, 'error');
      assert.equal(timeoutPayload.error, 'memory_search_failed');
      assert.deepEqual(timeoutPayload.warnings, [`${phase} timed out after 5000ms`]);
      assert.deepEqual(timeoutPayload.warningDetails, [
        { code: 'mcp.tool_timeout', message: `${phase} timed out after 5000ms` },
      ]);
      assert.ok(Buffer.byteLength(JSON.stringify(timeout)) <= SEARCH_RESPONSE_BUDGET_BYTES);
      assert.ok(!JSON.stringify(timeout).includes('SECRET_DATABASE_URL'));
      const invocation = invocations.at(-1);
      assert.equal(invocation?.status, 'error');
      assert.equal(invocation.warningCount, 1);
      assert.equal(invocation.timeoutWarningCount, 1);
      assert.equal(invocation.summaryFields.timed_out_steps, phase);
      assert.equal(invocation.summaryFields.warning_count, 1);
      assert.equal(invocation.summaryFields.timeout_warning_count, 1);
      assert.ok(!JSON.stringify(invocation.summaryFields).includes('private fixture query'));
    }
    searchFailure = new memory.TimeoutError('SECRET_DATABASE_URL private fixture query', 5000);
    const unsafePhase = await client.callTool({ arguments: { query: 'fixture' }, name: 'memory_search' });
    assert.ok(Array.isArray(unsafePhase.content));
    const unsafeFirst: unknown = unsafePhase.content[0];
    assert.ok(memory.isRecord(unsafeFirst) && typeof unsafeFirst.text === 'string');
    const unsafePayload: unknown = JSON.parse(unsafeFirst.text);
    assert.ok(memory.isRecord(unsafePayload));
    assert.deepEqual(unsafePayload.warnings, ['memory_search timed out after 5000ms']);
    assert.ok(!JSON.stringify(unsafePhase).includes('SECRET_DATABASE_URL'));
    assert.ok(!JSON.stringify(invocations.at(-1)?.summaryFields).includes('private fixture query'));
    searchFailure = new Error('SECRET_DATABASE_URL'.repeat(10000));
    const error = await client.callTool({ arguments: { query: 'fixture' }, name: 'memory_search' });
    assert.equal(error.isError, true);
    assert.ok(Buffer.byteLength(JSON.stringify(error)) <= SEARCH_RESPONSE_BUDGET_BYTES);
    assert.ok(!JSON.stringify(error).includes('SECRET_DATABASE_URL'));
    assert.equal(invocations.at(-1)?.summaryFields.search_response_bytes, Buffer.byteLength(JSON.stringify(error)));
    // SDK input rejection precedes invocation; its fixed schema diagnostics are
    // also bounded and must not echo arbitrary invalid values or secret text.
    const invalid = await client.callTool({
      arguments: { memoryDetail: 'SECRET'.repeat(10000), query: [] },
      name: 'memory_search',
    });
    assert.equal(invalid.isError, true);
    assert.ok(Buffer.byteLength(JSON.stringify(invalid)) <= SEARCH_RESPONSE_BUDGET_BYTES);
    assert.ok(!JSON.stringify(invalid).includes('SECRET'));
  } finally {
    await client.close();
    await server.close();
  }
});
