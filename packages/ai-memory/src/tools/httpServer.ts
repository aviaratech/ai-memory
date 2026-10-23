import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { formatError, logAiMemoryError } from '@aviaratech/ai-memory/internal';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const SESSION_IDLE_MS = 30 * 60 * 1000;

export interface HttpToolActivity {
  onToolStart: () => void;
  onToolEnd: () => void;
}

interface HttpSession {
  activeTools: number;
  closed: boolean;
  initialized: boolean;
  server: McpServer;
  timer: ReturnType<typeof setTimeout> | undefined;
  transport: StreamableHTTPServerTransport;
}

export function createAiMemoryHttpServer(input: {
  allowedOrigins: readonly string[];
  createMcpServer: (activity: HttpToolActivity) => McpServer;
  idleTimeoutMs?: number;
}) {
  const sessions = new Map<string, HttpSession>();
  // Includes provisional transports that have not finished reading initialize.
  const owned = new Set<HttpSession>();
  const closing = new Set<Promise<void>>();
  let stopping = false;
  let closePromise: Promise<void> | undefined;

  function closeSession(session: HttpSession): Promise<void> {
    if (session.closed) return Promise.resolve();
    session.closed = true;
    clearTimeout(session.timer);
    if (session.transport.sessionId !== undefined) sessions.delete(session.transport.sessionId);
    owned.delete(session);
    const pending = session.server.close().finally(() => {
      closing.delete(pending);
    });
    closing.add(pending);
    return pending;
  }

  function touch(session: HttpSession) {
    clearTimeout(session.timer);
    if (session.closed || session.activeTools > 0) return;
    session.timer = setTimeout(() => {
      void closeSession(session).catch(logTransportError);
    }, input.idleTimeoutMs ?? SESSION_IDLE_MS);
    session.timer.unref();
  }

  function createSession() {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: id => {
        sessions.set(id, session);
      },
      onsessionclosed: () => closeSession(session),
    });
    const session: HttpSession = {
      activeTools: 0,
      closed: false,
      initialized: false,
      timer: undefined,
      transport,
      server: input.createMcpServer({
        onToolStart: () => {
          session.activeTools += 1;
          clearTimeout(session.timer);
        },
        onToolEnd: () => {
          session.activeTools -= 1;
          touch(session);
        },
      }),
    };
    transport.onclose = () => {
      session.closed = true;
      clearTimeout(session.timer);
      if (transport.sessionId !== undefined) sessions.delete(transport.sessionId);
      owned.delete(session);
    };
    owned.add(session);
    return session;
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse) {
    const ids = req.headersDistinct['mcp-session-id'];
    if (ids !== undefined && (ids.length !== 1 || ids[0]?.length === 0)) {
      reply(res, 400, 'Invalid MCP session header.');
      return;
    }
    const id = ids?.[0];
    if (id !== undefined && !sessions.has(id)) {
      reply(res, 404, 'Session not found.');
      return;
    }
    if (id === undefined && req.method !== 'POST') {
      reply(res, 400, 'Initialize a session with POST first.');
      return;
    }
    const session = id === undefined ? createSession() : sessions.get(id);
    if (session === undefined) return;
    const provisional = id === undefined;
    if (provisional) {
      // The SDK assigns an id before it sends the initialize response. An id
      // alone must not retain a pair whose response was aborted or rejected.
      res.once('finish', () => {
        session.initialized = res.statusCode === 200 && session.transport.sessionId !== undefined;
        if (session.initialized) touch(session);
        else void closeSession(session).catch(logTransportError);
      });
      res.once('close', () => {
        if (!session.initialized) void closeSession(session).catch(logTransportError);
      });
    } else {
      touch(session);
    }
    try {
      if (provisional) await session.server.connect(session.transport as Transport);
      await session.transport.handleRequest(req, res);
    } catch (error) {
      if (!res.headersSent && !res.destroyed) reply(res, 500, 'Internal server error processing MCP request.');
      logTransportError(error);
      if (provisional) await closeSession(session);
    }
  }

  const httpServer = createServer({ requireHostHeader: false }, (req, res) => {
    const hosts = req.headersDistinct.host;
    const origins = req.headersDistinct.origin;
    const port = req.socket.localPort;
    if (
      hosts?.length !== 1 ||
      !['127.0.0.1', 'localhost', '[::1]'].some(host => hosts[0] === `${host}:${String(port)}`) ||
      (origins !== undefined && (origins.length !== 1 || !input.allowedOrigins.includes(origins[0] ?? '')))
    ) {
      reply(res, 403, 'Forbidden Host or Origin.');
      return;
    }
    if (stopping) {
      reply(res, 503, 'Server is shutting down.');
      return;
    }
    const url = req.url ?? '/';
    if (url === '/mcp' || url.startsWith('/mcp?') || url.startsWith('/mcp/')) {
      void handleMcp(req, res).catch((error: unknown) => {
        if (!res.headersSent && !res.destroyed) reply(res, 500, 'Internal server error processing MCP request.');
        logTransportError(error);
      });
    } else if (url === '/' || url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: 'ai-memory', status: 'ok', transport: 'http' }));
    } else reply(res, 404, 'Not found. MCP endpoint is at /mcp');
  });

  function close(): Promise<void> {
    if (closePromise !== undefined) return closePromise;
    stopping = true;
    closePromise = (async () => {
      const listenerClosed = new Promise<void>((resolve, reject) => {
        httpServer.close(error => {
          if (error !== undefined && (!('code' in error) || error.code !== 'ERR_SERVER_NOT_RUNNING')) reject(error);
          else resolve();
        });
      });
      const results = await Promise.allSettled([...owned].map(closeSession));
      httpServer.closeAllConnections();
      await listenerClosed;
      const pending = await Promise.allSettled([...closing]);
      const failed = [...results, ...pending].find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    })();
    return closePromise;
  }
  return { httpServer, close };
}

function reply(res: ServerResponse, status: number, error: string) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error }));
}

function logTransportError(error: unknown) {
  logAiMemoryError('mcp.http_transport_error', {
    error: formatError(error),
    message: 'Failed to handle MCP HTTP transport.',
    transport: 'http',
  });
}
