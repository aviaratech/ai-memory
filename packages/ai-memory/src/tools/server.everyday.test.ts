import * as memory from '@aviaratech/ai-memory/internal';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import assert from 'node:assert/strict';
import type * as fs from 'node:fs';
import { expect, test, vi } from 'vitest';
import * as z from 'zod/v4';

const manifest = vi.hoisted(() => ({ value: '{"name":"@aviaratech/ai-memory","version":"9.8.7"}' as string | Error }));
vi.mock('node:fs', async importOriginal => ({
  ...(await importOriginal<typeof fs>()),
  readFileSync: (path: unknown) => {
    if (!(path instanceof URL) || path.href !== new URL('../../package.json', import.meta.url).href) {
      throw new Error('Unexpected fixture file read.');
    }
    if (manifest.value instanceof Error) throw manifest.value;
    return manifest.value;
  },
}));

let legacyRecalls = 0;
let receivedTopic: unknown;
const capturedTelemetry: unknown[] = [];
vi.doMock('@aviaratech/ai-memory/internal', () => ({
  ...memory,
  logAiMemoryError: (_event: string, fields: unknown) => {
    capturedTelemetry.push(fields);
  },
  logAiMemoryInfo: (_event: string, fields: unknown) => {
    capturedTelemetry.push(fields);
  },
  logAiMemoryWarn: (_event: string, fields: unknown) => {
    capturedTelemetry.push(fields);
  },
  recordIngestionFailure: (input: unknown) => {
    capturedTelemetry.push(input);
    return Promise.resolve();
  },
  recordToolInvocation: (input: unknown) => {
    capturedTelemetry.push(input);
    return Promise.resolve();
  },
  countContestedMemories: () => Promise.resolve(0),
  recallMemories: () => {
    legacyRecalls += 1;
    return Promise.resolve([]);
  },
  storeMemory: (input: unknown) => {
    assert.ok(memory.isRecord(input));
    memory.assertDurableWriteGate(input);
    memory.normalizeMemoryInput(input);
    return Promise.resolve({ id: 1 });
  },
}));
vi.doMock('./topic-recall.js', () => ({
  recallTopic: (input: unknown) => {
    receivedTopic = input;
    return Promise.resolve({ status: 'degraded', brief: 'Scoped fixture brief.', memories: [], count: 0 });
  },
}));
const { server, createAiMemoryMcpServer, memoryGetInputSchema, memoryStoreInputSchema } = await import('./server.js');

test('registered everyday tool descriptions and one-call contracts', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'everyday-fixture', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const payload = (response: Awaited<ReturnType<typeof client.callTool>>) => {
    assert.ok(Array.isArray(response.content));
    const first: unknown = response.content[0];
    assert.ok(memory.isRecord(first) && typeof first.text === 'string');
    const value: unknown = JSON.parse(first.text);
    assert.ok(memory.isRecord(value));
    return value;
  };
  try {
    const diagnostics = payload(
      await client.callTool({ name: 'memory_runtime_diagnostics', arguments: { packageVersion: '0.0.0' } }),
    );
    assert.equal(diagnostics.packageVersion, client.getServerVersion()?.version);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.find(tool => tool.name === 'memory_store')?.inputSchema,
      z.toJSONSchema(memoryStoreInputSchema, { io: 'input', target: 'draft-7' }),
    );
    const descriptions = Object.fromEntries(
      ['memory_store', 'memory_get', 'memory_recall', 'memory_search'].map(name => [
        name,
        tools.tools.find(tool => tool.name === name)?.description,
      ]),
    );
    expect(descriptions).toMatchInlineSnapshot(`
      {
        "memory_get": "Fetch full memories by id or by project-scoped key (up to 25 keys). Key lookups default to active rows and return found:false for missing keys. Example: {"project":"example/catalog","key":"rule/merge-slot"}",
        "memory_recall": "Recall up to five active keyed memories about a project topic, with the scoped brief as a degraded fallback. Omit topic for recent-memory recall. Example: {"project":"example/catalog","topic":"release rules"}",
        "memory_search": "Search durable knowledge by text and filters, returning source-linked previews within a 16384-byte result budget. Use memory_get for full records or sessionId for exact session history. Example: {"project":"example/catalog","query":"release rules"}",
        "memory_store": "Store reusable knowledge with a stable memoryKey, auditable evidenceRefs and plain sentences free of secrets or personal data. Rejections return field, reason and fix in problems; session state belongs in memory_flush. Example: {"category":"convention","memoryKey":"rule/tests","content":"Run integration tests on disposable databases.","evidenceRefs":["CONTRIBUTING.md"]}",
      }
    `);
    assert.equal(
      memoryGetInputSchema.parse({ project: 'example/catalog', key: 'rule/merge-slot' }).key,
      'rule/merge-slot',
    );
    const topicArgs = { project: 'example/catalog', topic: 'release rules' };
    const recalled = payload(await client.callTool({ name: 'memory_recall', arguments: topicArgs }));
    assert.deepEqual(receivedTopic, topicArgs);
    assert.equal(recalled.status, 'degraded');
    assert.equal(recalled.brief, 'Scoped fixture brief.');
    assert.equal(legacyRecalls, 0);
    const legacy = payload(await client.callTool({ name: 'memory_recall', arguments: { project: 'example/catalog' } }));
    assert.equal(legacyRecalls, 1);
    assert.deepEqual(legacy, { count: 0, memories: [] });
    const input: Record<string, unknown> = {
      category: 'convention',
      evidenceRefs: [],
      content: 'Short note.',
      confidence: 0.2,
      expiresAt: 'not-a-date',
      repoId: 'example/catalog',
      repoSlug: 'other/catalog',
    };
    const rejected = await client.callTool({
      name: 'memory_store',
      arguments: input,
    });
    assert.equal(rejected.isError, true);
    const problems = payload(rejected).problems;
    assert.ok(Array.isArray(problems) && problems.length >= 4);
    assert.ok(
      problems.every(
        problem =>
          memory.isRecord(problem) &&
          typeof problem.field === 'string' &&
          typeof problem.reason === 'string' &&
          typeof problem.fix === 'string',
      ),
    );
    const repairs: Record<string, unknown> = {
      memoryKey: 'rule/tests',
      evidenceRefs: ['CONTRIBUTING.md'],
      content: 'Run integration tests on disposable databases.',
      confidence: 0.8,
      expiresAt: '2099-01-01T00:00:00.000Z',
      repoId: 'other/catalog',
    };
    for (const problem of problems) {
      assert.ok(memory.isRecord(problem) && typeof problem.field === 'string');
      input[problem.field] = repairs[problem.field];
    }
    const retried = await client.callTool({ name: 'memory_store', arguments: input });
    assert.equal(retried.isError, undefined);
    assert.equal(payload(retried).status, 'ok');
    const encoded = await client.callTool({
      name: 'memory_store',
      arguments: {
        ...input,
        evidenceRefs: '["CONTRIBUTING.md"]',
        confidence: '0.8',
      },
    });
    assert.equal(encoded.isError, undefined);
    assert.equal(payload(encoded).status, 'ok');
    const malformed = payload(await client.callTool({ name: 'memory_store', arguments: { ...input, tags: 17 } }));
    assert.ok(Array.isArray(malformed.problems));
    assert.ok(
      malformed.problems.some(
        problem => memory.isRecord(problem) && problem.field === 'tags' && typeof problem.fix === 'string',
      ),
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test('discarded and rejected sensitive input never reaches logs or audit persistence', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'store-privacy-fixture', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const input = {
    category: 'convention',
    memoryKey: 'rule/privacy',
    content: 'Run integration tests on disposable databases.',
    evidenceRefs: ['CONTRIBUTING.md'],
    confidence: 0.8,
  };
  const canary = ['pass', 'word=', 'synthetic_review_canary_12345'].join('');
  try {
    const discarded = await client.callTool({
      name: 'memory_store',
      arguments: { ...input, detectedSource: 'someone@example.com', stage: canary },
    });
    assert.equal(discarded.isError, undefined);
    const sensitive = await client.callTool({
      name: 'memory_store',
      arguments: { ...input, project: 'someone@example.com', detectedSource: 'someone@example.com', stage: canary },
    });
    assert.equal(sensitive.isError, true);
    assert.ok(!JSON.stringify(capturedTelemetry).includes(canary));
    assert.ok(!JSON.stringify(capturedTelemetry).includes('someone@example.com'));
  } finally {
    await client.close();
    await server.close();
  }
});

test('MCP server construction preserves invalid and missing manifest failures', () => {
  const original = manifest.value;
  const cases: [string | Error, RegExp][] = [
    [
      '{"name":"@aviaratech/ai-memory","version":"invalid"}',
      /Restore the matching released ai-memory package manifest/u,
    ],
    [Object.assign(new Error('Synthetic missing manifest.'), { code: 'ENOENT' }), /Synthetic missing manifest/u],
  ];
  try {
    for (const [value, error] of cases) {
      manifest.value = value;
      assert.throws(() => createAiMemoryMcpServer(), error);
    }
  } finally {
    manifest.value = original;
  }
});
