import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { afterEach, beforeEach, describe, it } from 'vitest';

import {
  createAiMemoryWarningCollector,
  listAiMemoryWarningDetails,
  runWithAiMemoryWarningCollector,
} from '../warning-channel.js';
import { getEmbedding, isEmbeddingAvailable, resetEmbeddingProvider } from './embeddings.js';

// ---------------------------------------------------------------------------
// Helpers — save and restore env vars between tests
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'AI_MEMORY_EMBEDDING_PROVIDER',
  'AI_MEMORY_EMBEDDING_API_KEY',
  'AI_MEMORY_EMBEDDING_MODEL',
  'AI_MEMORY_EMBEDDING_TIMEOUT_MS',
  'AI_MEMORY_LOG_DIR',
  'AI_MEMORY_LOG_FILE',
  'AI_MEMORY_LOG_STDERR',
] as const;

type EnvKey = (typeof ENV_KEYS)[number];
type EnvSnapshot = Record<EnvKey, string | undefined>;
type FetchInput = Request | string | URL;

function fakeVector(dim = 1536): number[] {
  return Array.from({ length: dim }, (_, i) => i / dim);
}

function makeMockFetch(responseBody: string, status: number) {
  return () => Promise.resolve(new Response(responseBody, { status }));
}

function openAiSuccessBody(embedding: number[]): string {
  return JSON.stringify({ data: [{ embedding }] });
}

function readJsonLogEvents(logDir: string): Record<string, unknown>[] {
  const raw = readFileSync(join(logDir, 'ai-memory.log'), 'utf8');
  return raw
    .trim()
    .split(/\n/u)
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Fake embedding vector
// ---------------------------------------------------------------------------

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      process.env[key] = '';
      delete process.env[key]; // must actually unset, not just set empty
    } else {
      process.env[key] = value;
    }
  }
}

function setEnv(overrides: Partial<EnvSnapshot>): void {
  for (const key of ENV_KEYS) {
    if (!(key in overrides)) {
      continue;
    }
    const value = overrides[key];
    if (value === undefined) {
      process.env[key] = '';
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function snapshotEnv(): EnvSnapshot {
  const snap: EnvSnapshot = {
    AI_MEMORY_EMBEDDING_API_KEY: process.env.AI_MEMORY_EMBEDDING_API_KEY,
    AI_MEMORY_EMBEDDING_MODEL: process.env.AI_MEMORY_EMBEDDING_MODEL,
    AI_MEMORY_EMBEDDING_PROVIDER: process.env.AI_MEMORY_EMBEDDING_PROVIDER,
    AI_MEMORY_EMBEDDING_TIMEOUT_MS: process.env.AI_MEMORY_EMBEDDING_TIMEOUT_MS,
    AI_MEMORY_LOG_DIR: process.env.AI_MEMORY_LOG_DIR,
    AI_MEMORY_LOG_FILE: process.env.AI_MEMORY_LOG_FILE,
    AI_MEMORY_LOG_STDERR: process.env.AI_MEMORY_LOG_STDERR,
  };
  return snap;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('isEmbeddingAvailable', () => {
  let saved: EnvSnapshot;

  beforeEach(() => {
    saved = snapshotEnv();
    resetEmbeddingProvider();
  });

  afterEach(() => {
    restoreEnv(saved);
    resetEmbeddingProvider();
  });

  it('returns false when AI_MEMORY_EMBEDDING_PROVIDER is unset', () => {
    setEnv({
      AI_MEMORY_EMBEDDING_API_KEY: undefined,
      AI_MEMORY_EMBEDDING_PROVIDER: undefined,
    });
    assert.equal(isEmbeddingAvailable(), false);
  });

  it('returns false when AI_MEMORY_EMBEDDING_PROVIDER is "none"', () => {
    setEnv({ AI_MEMORY_EMBEDDING_PROVIDER: 'none' });
    assert.equal(isEmbeddingAvailable(), false);
  });

  it('returns false when AI_MEMORY_EMBEDDING_PROVIDER is empty string', () => {
    setEnv({ AI_MEMORY_EMBEDDING_PROVIDER: '' });
    assert.equal(isEmbeddingAvailable(), false);
  });

  it('returns false when provider is openai but API key is missing', () => {
    setEnv({
      AI_MEMORY_EMBEDDING_API_KEY: undefined,
      AI_MEMORY_EMBEDDING_PROVIDER: 'openai',
    });
    assert.equal(isEmbeddingAvailable(), false);
  });

  it('returns false when provider is openai but API key is empty', () => {
    setEnv({
      AI_MEMORY_EMBEDDING_API_KEY: '  ',
      AI_MEMORY_EMBEDDING_PROVIDER: 'openai',
    });
    assert.equal(isEmbeddingAvailable(), false);
  });

  it('returns true when provider is openai with valid API key', () => {
    setEnv({
      AI_MEMORY_EMBEDDING_API_KEY: 'sk-test-key',
      AI_MEMORY_EMBEDDING_PROVIDER: 'openai',
    });
    assert.equal(isEmbeddingAvailable(), true);
  });

  it('logs why embedding provider resolution is unavailable', () => {
    const logDir = mkdtempSync(join(tmpdir(), 'ai-memory-embedding-logs-'));
    setEnv({
      AI_MEMORY_EMBEDDING_API_KEY: undefined,
      AI_MEMORY_EMBEDDING_PROVIDER: undefined,
      AI_MEMORY_LOG_DIR: logDir,
      AI_MEMORY_LOG_FILE: undefined,
      AI_MEMORY_LOG_STDERR: '0',
    });

    assert.equal(isEmbeddingAvailable(), false);

    const events = readJsonLogEvents(logDir);
    assert.ok(
      events.some(
        event =>
          event.event === 'embedding.provider_unavailable' &&
          event.level === 'warn' &&
          event.reason === 'provider_not_configured',
      ),
    );
  });

  it('is case-insensitive for provider name', () => {
    setEnv({
      AI_MEMORY_EMBEDDING_API_KEY: 'sk-test-key',
      AI_MEMORY_EMBEDDING_PROVIDER: 'OpenAI',
    });
    assert.equal(isEmbeddingAvailable(), true);
  });
});

describe('getEmbedding', () => {
  let saved: EnvSnapshot;
  let savedFetch: typeof globalThis.fetch;

  beforeEach(() => {
    saved = snapshotEnv();
    savedFetch = globalThis.fetch;
    resetEmbeddingProvider();
  });

  afterEach(() => {
    restoreEnv(saved);
    globalThis.fetch = savedFetch;
    resetEmbeddingProvider();
    mock.restoreAll();
  });

  it('returns null when provider is not configured', async () => {
    setEnv({
      AI_MEMORY_EMBEDDING_API_KEY: undefined,
      AI_MEMORY_EMBEDDING_PROVIDER: undefined,
    });
    const result = await getEmbedding('test text');
    assert.equal(result, null);
  });

  it('returns null for empty text', async () => {
    setEnv({
      AI_MEMORY_EMBEDDING_API_KEY: 'sk-test',
      AI_MEMORY_EMBEDDING_PROVIDER: 'openai',
    });
    const result = await getEmbedding('   ');
    assert.equal(result, null);
  });

  it('returns null for session-summary category (cost control)', async () => {
    setEnv({
      AI_MEMORY_EMBEDDING_API_KEY: 'sk-test',
      AI_MEMORY_EMBEDDING_PROVIDER: 'openai',
    });
    const result = await getEmbedding('some text', 'session-summary');
    assert.equal(result, null);
  });

  it('skips session-summary case-insensitively', async () => {
    setEnv({
      AI_MEMORY_EMBEDDING_API_KEY: 'sk-test',
      AI_MEMORY_EMBEDDING_PROVIDER: 'openai',
    });
    const result = await getEmbedding('some text', 'Session-Summary');
    assert.equal(result, null);
  });

  it('returns embedding vector on successful API call', async () => {
    setEnv({
      AI_MEMORY_EMBEDDING_API_KEY: 'sk-test',
      AI_MEMORY_EMBEDDING_PROVIDER: 'openai',
    });

    const expected = fakeVector();
    globalThis.fetch = mock.fn(makeMockFetch(openAiSuccessBody(expected), 200));

    const result = await getEmbedding('architecture decision about state management');
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 1536);
    assert.equal(result[0], expected[0]);
  });

  it('logs embedding provider resolution without exposing the API key', async () => {
    const logDir = mkdtempSync(join(tmpdir(), 'ai-memory-embedding-logs-'));
    setEnv({
      AI_MEMORY_EMBEDDING_API_KEY: 'sk-test-secret-value',
      AI_MEMORY_EMBEDDING_MODEL: 'text-embedding-3-small',
      AI_MEMORY_EMBEDDING_PROVIDER: 'openai',
      AI_MEMORY_LOG_DIR: logDir,
      AI_MEMORY_LOG_FILE: undefined,
      AI_MEMORY_LOG_STDERR: '0',
    });
    globalThis.fetch = mock.fn(makeMockFetch(openAiSuccessBody(fakeVector()), 200));

    const result = await getEmbedding('architecture decision about provider logging');

    assert.ok(Array.isArray(result));
    const events = readJsonLogEvents(logDir);
    const providerEvent = events.find(event => event.event === 'embedding.provider_resolved');
    assert.ok(providerEvent !== undefined, 'expected provider resolution log event');
    assert.equal(providerEvent.level, 'info');
    assert.equal(providerEvent.provider, 'openai');
    assert.equal(providerEvent.model, 'text-embedding-3-small');
    assert.equal(JSON.stringify(providerEvent).includes('sk-test-secret-value'), false);
  });

  it('sends correct request to OpenAI API', async () => {
    setEnv({
      AI_MEMORY_EMBEDDING_API_KEY: 'sk-my-key',
      AI_MEMORY_EMBEDDING_MODEL: 'text-embedding-3-large',
      AI_MEMORY_EMBEDDING_PROVIDER: 'openai',
    });

    const expected = fakeVector();
    const calls: { options: RequestInit; url: string }[] = [];
    globalThis.fetch = mock.fn((url: FetchInput, init?: RequestInit) => {
      calls.push({ options: init ?? {}, url: String(url) });
      return Promise.resolve(new Response(openAiSuccessBody(expected), { status: 200 }));
    });

    await getEmbedding('test input');

    assert.equal(calls.length, 1);
    const captured = calls[0];
    assert.ok(captured !== undefined);
    assert.equal(captured.url, 'https://api.openai.com/v1/embeddings');
    assert.equal(captured.options.method, 'POST');
    assert.ok(captured.options.signal instanceof AbortSignal);

    const headers = captured.options.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer sk-my-key');
    assert.equal(headers['Content-Type'], 'application/json');

    const body = JSON.parse(captured.options.body as string) as {
      input: string;
      model: string;
    };
    assert.equal(body.input, 'test input');
    assert.equal(body.model, 'text-embedding-3-large');
  });

  it('returns null on HTTP error (e.g., 429 rate limit)', async () => {
    setEnv({
      AI_MEMORY_EMBEDDING_API_KEY: 'sk-test',
      AI_MEMORY_EMBEDDING_PROVIDER: 'openai',
    });

    globalThis.fetch = mock.fn(makeMockFetch('rate limited', 429));

    const result = await getEmbedding('test text');
    assert.equal(result, null);
  });

  it('returns null on HTTP 401 (invalid key)', async () => {
    setEnv({
      AI_MEMORY_EMBEDDING_API_KEY: 'sk-bad',
      AI_MEMORY_EMBEDDING_PROVIDER: 'openai',
    });

    globalThis.fetch = mock.fn(makeMockFetch('unauthorized', 401));

    const result = await getEmbedding('test text');
    assert.equal(result, null);
  });

  it('returns null on network failure', async () => {
    setEnv({
      AI_MEMORY_EMBEDDING_API_KEY: 'sk-test',
      AI_MEMORY_EMBEDDING_PROVIDER: 'openai',
    });

    globalThis.fetch = mock.fn(() => {
      return Promise.reject(new Error('ECONNREFUSED'));
    });

    const result = await getEmbedding('test text');
    assert.equal(result, null);
  });

  it('returns null when request times out and aborts fetch', async () => {
    setEnv({
      AI_MEMORY_EMBEDDING_API_KEY: 'sk-timeout',
      AI_MEMORY_EMBEDDING_PROVIDER: 'openai',
      AI_MEMORY_EMBEDDING_TIMEOUT_MS: '10',
    });

    let observedAbort = false;
    globalThis.fetch = mock.fn((_url: FetchInput, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise((_resolve, reject) => {
        if (signal instanceof AbortSignal) {
          signal.addEventListener(
            'abort',
            () => {
              observedAbort = true;
              const reason: unknown = signal.reason as unknown;
              const abortError = reason instanceof Error ? reason : new Error('request aborted');
              if (abortError.name !== 'AbortError' && abortError.name !== 'TimeoutError') {
                abortError.name = 'AbortError';
              }
              reject(abortError);
            },
            { once: true },
          );
        }
      });
    });

    // AbortSignal.timeout() creates an unref'd timer; hold the event loop open
    // with a ref'd guard timer so the timeout actually fires inside the test.
    const guard = setTimeout(() => {}, 1_000);
    try {
      const result = await getEmbedding('slow embedding request');
      assert.equal(result, null);
      assert.equal(observedAbort, true);
    } finally {
      clearTimeout(guard);
    }
  });

  it('records a phase-attributed warning detail when embedding request times out', async () => {
    setEnv({
      AI_MEMORY_EMBEDDING_API_KEY: 'sk-timeout',
      AI_MEMORY_EMBEDDING_PROVIDER: 'openai',
      AI_MEMORY_EMBEDDING_TIMEOUT_MS: '10',
    });

    globalThis.fetch = mock.fn((_url: FetchInput, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise((_resolve, reject) => {
        if (signal instanceof AbortSignal) {
          signal.addEventListener(
            'abort',
            () => {
              const reason: unknown = signal.reason as unknown;
              const abortError = reason instanceof Error ? reason : new Error('request aborted');
              if (abortError.name !== 'AbortError' && abortError.name !== 'TimeoutError') {
                abortError.name = 'AbortError';
              }
              reject(abortError);
            },
            { once: true },
          );
        }
      });
    });

    const collector = createAiMemoryWarningCollector();
    const guard = setTimeout(() => {}, 1_000);
    try {
      const result = await runWithAiMemoryWarningCollector(collector, () =>
        getEmbedding('search query text', { operation: 'search_memories' }),
      );
      assert.equal(result, null, 'embedding should return null on timeout');
    } finally {
      clearTimeout(guard);
    }

    const details = listAiMemoryWarningDetails(collector);
    assert.ok(
      details.some(
        d => d.code === 'embedding.timeout' && /embedding\.search_memories timed out after \d+ms/u.test(d.message),
      ),
      `expected a phase-attributed embedding.search_memories timeout warning; got: ${JSON.stringify(details)}`,
    );
  });

  it('embedding timeout warning includes the caller operation phase (store_memory)', async () => {
    setEnv({
      AI_MEMORY_EMBEDDING_API_KEY: 'sk-timeout',
      AI_MEMORY_EMBEDDING_PROVIDER: 'openai',
      AI_MEMORY_EMBEDDING_TIMEOUT_MS: '10',
    });

    globalThis.fetch = mock.fn((_url: FetchInput, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise((_resolve, reject) => {
        if (signal instanceof AbortSignal) {
          signal.addEventListener(
            'abort',
            () => {
              const reason: unknown = signal.reason as unknown;
              const abortError = reason instanceof Error ? reason : new Error('request aborted');
              if (abortError.name !== 'AbortError' && abortError.name !== 'TimeoutError') {
                abortError.name = 'AbortError';
              }
              reject(abortError);
            },
            { once: true },
          );
        }
      });
    });

    const collector = createAiMemoryWarningCollector();
    const guard = setTimeout(() => {}, 1_000);
    try {
      await runWithAiMemoryWarningCollector(collector, () =>
        getEmbedding('memory content for storage', { category: 'decision', operation: 'store_memory' }),
      );
    } finally {
      clearTimeout(guard);
    }

    const messages = listAiMemoryWarningDetails(collector).map(d => d.message);
    assert.ok(
      messages.some(m => /embedding\.store_memory timed out after \d+ms/u.test(m)),
      `expected embedding.store_memory phase in warning; got: ${JSON.stringify(messages)}`,
    );
  });

  it('returns null on malformed JSON response', async () => {
    setEnv({
      AI_MEMORY_EMBEDDING_API_KEY: 'sk-test',
      AI_MEMORY_EMBEDDING_PROVIDER: 'openai',
    });

    globalThis.fetch = mock.fn(makeMockFetch('not json', 200));

    const result = await getEmbedding('test text');
    assert.equal(result, null);
  });

  it('returns null when response has empty data array', async () => {
    setEnv({
      AI_MEMORY_EMBEDDING_API_KEY: 'sk-test',
      AI_MEMORY_EMBEDDING_PROVIDER: 'openai',
    });

    globalThis.fetch = mock.fn(makeMockFetch(JSON.stringify({ data: [] }), 200));

    const result = await getEmbedding('test text');
    assert.equal(result, null);
  });

  it('returns null when response has no embedding field', async () => {
    setEnv({
      AI_MEMORY_EMBEDDING_API_KEY: 'sk-test',
      AI_MEMORY_EMBEDDING_PROVIDER: 'openai',
    });

    globalThis.fetch = mock.fn(makeMockFetch(JSON.stringify({ data: [{}] }), 200));

    const result = await getEmbedding('test text');
    assert.equal(result, null);
  });

  it('uses default model text-embedding-3-small when not specified', async () => {
    setEnv({
      AI_MEMORY_EMBEDDING_API_KEY: 'sk-test',
      AI_MEMORY_EMBEDDING_MODEL: undefined,
      AI_MEMORY_EMBEDDING_PROVIDER: 'openai',
    });

    const calls: { options: RequestInit }[] = [];
    globalThis.fetch = mock.fn((_url: FetchInput, init?: RequestInit) => {
      calls.push({ options: init ?? {} });
      return Promise.resolve(new Response(openAiSuccessBody(fakeVector()), { status: 200 }));
    });

    await getEmbedding('test');

    assert.equal(calls.length, 1);
    const captured = calls[0];
    assert.ok(captured !== undefined);
    const body = JSON.parse(captured.options.body as string) as {
      model: string;
    };
    assert.equal(body.model, 'text-embedding-3-small');
  });

  it('does not skip non-session-summary categories', async () => {
    setEnv({
      AI_MEMORY_EMBEDDING_API_KEY: 'sk-test',
      AI_MEMORY_EMBEDDING_PROVIDER: 'openai',
    });

    const expected = fakeVector();
    globalThis.fetch = mock.fn(makeMockFetch(openAiSuccessBody(expected), 200));

    const result = await getEmbedding('convention text', 'convention');
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 1536);
  });

  it('handles null category without skipping', async () => {
    setEnv({
      AI_MEMORY_EMBEDDING_API_KEY: 'sk-test',
      AI_MEMORY_EMBEDDING_PROVIDER: 'openai',
    });

    const expected = fakeVector();
    globalThis.fetch = mock.fn(makeMockFetch(openAiSuccessBody(expected), 200));

    const result = await getEmbedding('some text', null);
    assert.ok(Array.isArray(result));
  });
});
