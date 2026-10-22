import * as memory from '@aviaratech/ai-memory/internal';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import assert from 'node:assert/strict';
import { test, vi } from 'vitest';

const requests: unknown[] = [];
vi.doMock('@aviaratech/ai-memory/internal', () => ({
  ...memory,
  orientMemory: (args: unknown) => {
    requests.push(args);
    return Promise.resolve({ status: 'ok', orientation: { priorSession: null }, warnings: [] });
  },
  logAiMemoryInfo: () => {},
  logAiMemoryWarn: () => {},
  logAiMemoryError: () => {},
  recordToolInvocation: () => Promise.resolve(),
  recordIngestionFailure: () => Promise.resolve(),
}));
const previous = process.env.AI_AGENT_IDENTITY;
process.env.AI_AGENT_IDENTITY = 'fixture-shared-service-codex';
const { server } = await import('./server.js');
if (previous === undefined) delete process.env.AI_AGENT_IDENTITY;
else process.env.AI_AGENT_IDENTITY = previous;

test('registered orientation never supplies the shared service identity as the caller', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fixture-claude-caller', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    for (const args of [
      { project: 'example/catalog', task: 'orchard inventory', envProbe: 'none' },
      {
        project: 'example/catalog',
        task: 'orchard inventory',
        envProbe: 'none',
        agent: 'fixture-claude-worker',
        sessionId: 'fixture-claude-session',
      },
    ]) {
      const response = await client.callTool({ name: 'memory_orient', arguments: args });
      assert.ok(!response.isError);
      assert.deepEqual(requests.at(-1), args);
    }
  } finally {
    await client.close();
    await server.close();
  }
});
