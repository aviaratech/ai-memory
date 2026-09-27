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
let failSearch = false;
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
    if (failSearch) throw new Error('SECRET_DATABASE_URL'.repeat(10000));
    memory.recordAiMemoryWarningDetail({
      code: 'fixture.timeout',
      message: 'db.read.search_memories timed out after 10ms',
    });
    return Promise.resolve(ranked);
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
    failSearch = true;
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
