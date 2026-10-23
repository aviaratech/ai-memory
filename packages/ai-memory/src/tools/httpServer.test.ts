import * as memory from '@aviaratech/ai-memory/internal';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { connect } from 'node:net';
import { afterEach, test, vi, type MockInstance } from 'vitest';

let search: () => Promise<unknown[]> = () => Promise.resolve([]);
let audit: () => Promise<void> = () => Promise.resolve();
const searchCalls: unknown[] = [];
vi.doMock('@aviaratech/ai-memory/internal', () => ({
  ...memory,
  logAiMemoryError: () => {},
  logAiMemoryInfo: () => {},
  logAiMemoryWarn: () => {},
  recordIngestionFailure: () => audit(),
  recordToolInvocation: () => Promise.resolve(),
  searchMemories: (args: unknown) => {
    searchCalls.push(args);
    return search();
  },
}));
const { createAiMemoryMcpServer } = await import('./server.js');
const { createAiMemoryHttpServer } = await import('./httpServer.js');
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  search = () => Promise.resolve([]);
  audit = () => Promise.resolve();
  await Promise.all(
    cleanups
      .splice(0)
      .reverse()
      .map(cleanup => cleanup()),
  );
});

async function listener(origins: string[] = []) {
  const instances: ReturnType<typeof createAiMemoryMcpServer>[] = [];
  const closeSpies: MockInstance<() => Promise<void>>[] = [];
  const controller = createAiMemoryHttpServer({
    allowedOrigins: origins,
    idleTimeoutMs: vi.isFakeTimers() ? 100 : 30000,
    createMcpServer: activity => {
      const instance = createAiMemoryMcpServer(activity);
      closeSpies.push(vi.spyOn(instance, 'close'));
      instances.push(instance);
      return instance;
    },
  });
  controller.httpServer.listen(0, '127.0.0.1');
  await once(controller.httpServer, 'listening');
  const address = controller.httpServer.address();
  assert.ok(address !== null && typeof address !== 'string');
  cleanups.push(controller.close);
  return {
    ...controller,
    instances,
    closeSpies,
    port: address.port,
    url: new URL(`http://127.0.0.1:${String(address.port)}/mcp`),
  };
}

async function raw(port: number, headers: string[], method = 'GET', body?: string) {
  return new Promise<{ status: number; body: string; sessionId: string | undefined }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/mcp', method, headers, setHost: false }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        text += chunk;
      });
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          body: text,
          sessionId: typeof res.headers['mcp-session-id'] === 'string' ? res.headers['mcp-session-id'] : undefined,
        });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function client(url: URL) {
  const sdk = new Client({ name: 'synthetic-http-client', version: '1' });
  const transport = new StreamableHTTPClientTransport(url);
  // SDK sessionId includes undefined explicitly, unlike its Transport interface.
  await sdk.connect(transport as Transport);
  cleanups.push(() => sdk.close());
  return { sdk, transport };
}

const initialize = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'synthetic', version: '1' },
  },
});
function initializeHeaders(port: number) {
  return [
    'Host',
    `127.0.0.1:${String(port)}`,
    'Content-Type',
    'application/json',
    'Accept',
    'application/json, text/event-stream',
  ];
}
async function turn() {
  await new Promise<void>(resolve => setImmediate(resolve));
}

test('real listener rejects missing, duplicate, attacker and wrong-port Host before creating a session', async () => {
  const server = await listener();
  for (const headers of [
    [],
    ['Host', 'attacker.example'],
    ['Host', `127.0.0.1:${String(server.port + 1)}`],
    ['Host', `localhost:${String(server.port)}`, 'Host', 'attacker.example'],
  ]) {
    assert.equal((await raw(server.port, headers)).status, 403);
  }
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    assert.equal(
      (await raw(server.port, ['Host', `${host}:${String(server.port)}`, 'mcp-session-id', 'unknown'])).status,
      404,
    );
  }
  assert.equal(server.instances.length, 0);
});

test('default Origin allowlist denies every present Origin and checks original cardinality', async () => {
  const server = await listener();
  for (const origins of [
    ['http://attacker.example'],
    ['null'],
    [''],
    ['http://localhost', 'http://attacker.example'],
  ]) {
    const headers = initializeHeaders(server.port);
    for (const origin of origins) headers.push('Origin', origin);
    assert.equal((await raw(server.port, headers, 'POST', initialize)).status, 403);
  }
  assert.equal(server.instances.length, 0);
});

test('exact allowed Origin and no-Origin clients initialize; suffix/path variations fail', async () => {
  const server = await listener(['https://client.example']);
  for (const origin of [
    'https://client.example.attacker.invalid',
    'https://client.example/',
    'http://client.example',
  ]) {
    assert.equal(
      (await raw(server.port, [...initializeHeaders(server.port), 'Origin', origin], 'POST', initialize)).status,
      403,
    );
  }
  const result = await raw(
    server.port,
    [...initializeHeaders(server.port), 'Origin', 'https://client.example'],
    'POST',
    initialize,
  );
  assert.equal(result.status, 200);
  assert.ok(result.sessionId);
  await client(server.url);
});

test('concurrent clients search independently, DELETE isolates sessions and unknown ids get404', async () => {
  const server = await listener();
  const [one, two] = await Promise.all([client(server.url), client(server.url)]);
  assert.ok(one.transport.sessionId && two.transport.sessionId);
  assert.notEqual(one.transport.sessionId, two.transport.sessionId);
  const before = searchCalls.length;
  const results = await Promise.all(
    [one, two].map(c => c.sdk.callTool({ name: 'memory_search', arguments: { query: 'synthetic' } })),
  );
  assert.ok(results.every(result => result.isError !== true));
  assert.equal(searchCalls.length, before + 2);
  await one.transport.terminateSession();
  assert.equal(
    (await raw(server.port, ['Host', server.url.host, 'mcp-session-id', one.transport.sessionId ?? 'deleted'])).status,
    404,
  );
  assert.equal(
    (await two.sdk.callTool({ name: 'memory_search', arguments: { query: 'still alive' } })).isError,
    undefined,
  );
  assert.equal((await raw(server.port, ['Host', server.url.host, 'mcp-session-id', 'unknown'])).status, 404);
});

test('idle expiry resets on use and closes an idle session despite its open GET SSE stream', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const server = await listener();
  const c = await client(server.url);
  await vi.advanceTimersByTimeAsync(80);
  await c.sdk.callTool({ name: 'memory_search', arguments: { query: 'refresh' } });
  await vi.advanceTimersByTimeAsync(80);
  assert.equal(server.closeSpies[0]?.mock.calls.length, 0);
  await vi.advanceTimersByTimeAsync(21);
  assert.equal(server.closeSpies[0]?.mock.calls.length, 1);
  assert.equal(
    (await raw(server.port, ['Host', server.url.host, 'mcp-session-id', c.transport.sessionId ?? 'expired'])).status,
    404,
  );
});

test('overlapping backend calls protect the session until the last complete tool promise settles', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const releases: (() => void)[] = [];
  search = () =>
    new Promise(resolve => {
      releases.push(() => {
        resolve([]);
      });
    });
  const server = await listener();
  const c = await client(server.url);
  const pending = [
    c.sdk.callTool({ name: 'memory_search', arguments: { query: 'one' } }),
    c.sdk.callTool({ name: 'memory_search', arguments: { query: 'two' } }),
  ];
  while (releases.length < 2) await turn();
  await vi.advanceTimersByTimeAsync(500);
  assert.equal(server.closeSpies[0]?.mock.calls.length, 0);
  releases[0]?.();
  await pending[0];
  await vi.advanceTimersByTimeAsync(500);
  assert.equal(server.closeSpies[0]?.mock.calls.length, 0);
  releases[1]?.();
  await pending[1];
  await vi.advanceTimersByTimeAsync(101);
  assert.equal(server.closeSpies[0]?.mock.calls.length, 1);
});

test('response disconnect does not turn a running backend tool into an idle session', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  let release: (() => void) | undefined;
  search = () =>
    new Promise(resolve => {
      release = () => {
        resolve([]);
      };
    });
  const server = await listener();
  const c = await client(server.url);
  const abort = new AbortController();
  const response = fetch(server.url, {
    method: 'POST',
    signal: abort.signal,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': c.transport.sessionId ?? '',
      'mcp-protocol-version': '2025-11-25',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'memory_search', arguments: { query: 'disconnect' } },
    }),
  }).catch(() => undefined);
  while (release === undefined) await turn();
  abort.abort();
  await response;
  await vi.advanceTimersByTimeAsync(500);
  assert.equal(server.closeSpies[0]?.mock.calls.length, 0);
  release();
  await turn();
  await turn();
  await vi.advanceTimersByTimeAsync(101);
  assert.equal(server.closeSpies[0]?.mock.calls.length, 1);
});

test('failure auditing remains part of the active tool lifetime', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  search = () => Promise.reject(new Error('Synthetic search failure'));
  let release: (() => void) | undefined;
  audit = () =>
    new Promise(resolve => {
      release = resolve;
    });
  const server = await listener();
  const c = await client(server.url);
  const pending = c.sdk.callTool({ name: 'memory_search', arguments: { query: 'audit' } });
  while (release === undefined) await turn();
  await vi.advanceTimersByTimeAsync(500);
  assert.equal(server.closeSpies[0]?.mock.calls.length, 0);
  release();
  assert.equal((await pending).isError, true);
  await vi.advanceTimersByTimeAsync(101);
  assert.equal(server.closeSpies[0]?.mock.calls.length, 1);
});

test('initialization aborted after session id assignment closes and forgets the provisional pair', async () => {
  const instances: ReturnType<typeof createAiMemoryMcpServer>[] = [];
  const closeSpies: MockInstance<() => Promise<void>>[] = [];
  let assignedId: string | undefined;
  let release: (() => void) | undefined;
  const controller = createAiMemoryHttpServer({
    allowedOrigins: [],
    createMcpServer: activity => {
      const instance = createAiMemoryMcpServer(activity);
      instances.push(instance);
      closeSpies.push(vi.spyOn(instance, 'close'));
      const originalConnect = instance.connect.bind(instance);
      vi.spyOn(instance, 'connect').mockImplementation(async transport => {
        const originalSend = transport.send.bind(transport);
        transport.send = async (message, options) => {
          if ('result' in message) {
            assignedId = transport.sessionId;
            await new Promise<void>(resolve => {
              release = resolve;
            });
          }
          await originalSend(message, options);
        };
        await originalConnect(transport);
      });
      return instance;
    },
  });
  controller.httpServer.listen(0, '127.0.0.1');
  await once(controller.httpServer, 'listening');
  const address = controller.httpServer.address();
  assert.ok(address !== null && typeof address !== 'string');
  cleanups.push(controller.close);
  const abort = new AbortController();
  const response = fetch(`http://127.0.0.1:${String(address.port)}/mcp`, {
    method: 'POST',
    signal: abort.signal,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: initialize,
  }).catch(() => undefined);
  while (release === undefined) await turn();
  assert.ok(assignedId);
  abort.abort();
  await response;
  while (closeSpies[0]?.mock.calls.length === 0) await turn();
  assert.equal(
    (await raw(address.port, ['Host', `127.0.0.1:${String(address.port)}`, 'mcp-session-id', assignedId])).status,
    404,
  );
  release();
  await controller.close();
  assert.equal(closeSpies[0]?.mock.calls.length, 1);
});

test('invalid initialization and shutdown close provisional and established pairs exactly once', async () => {
  const server = await listener();
  const bad = await raw(server.port, initializeHeaders(server.port), 'POST', '{}');
  assert.equal(bad.status, 400);
  assert.equal(server.closeSpies[0]?.mock.calls.length, 1);
  await client(server.url);
  const socket = connect(server.port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(
    `POST /mcp HTTP/1.1\r\nHost: ${server.url.host}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\nAccept: application/json, text/event-stream\r\n\r\n{`,
  );
  while (server.instances.length < 3) await turn();
  await server.close();
  assert.ok(server.closeSpies.every(spy => spy.mock.calls.length === 1));
  assert.equal(server.httpServer.listening, false);
  socket.destroy();
  await server.close();
});

test('packaged startup rejects a forbidden HTTP bind before touching PostgreSQL', () => {
  let failure: unknown;
  try {
    execFileSync(process.execPath, [new URL('../../dist/tools/server.js', import.meta.url).pathname], {
      env: { PATH: process.env.PATH, AI_MEMORY_MCP_TRANSPORT: 'http', AI_MEMORY_MCP_HTTP_HOST: '0.0.0.0' },
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 10000,
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure !== null && typeof failure === 'object' && 'stderr' in failure);
  assert.match(String(failure.stderr), /AI_MEMORY_MCP_HTTP_ALLOW_NON_LOOPBACK/u);
  assert.doesNotMatch(String(failure.stderr), /mcp\.postgres_unavailable|mcp\.starting/u);
});
