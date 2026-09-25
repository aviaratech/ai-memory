import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'vitest';

import { classifyMemoryPair } from './llm-classify.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENV_KEYS = ['AI_MEMORY_CLASSIFY_API_KEY', 'AI_MEMORY_EMBEDDING_API_KEY', 'AI_MEMORY_CLASSIFY_MODEL'] as const;

type EnvKey = (typeof ENV_KEYS)[number];
type EnvSnapshot = Record<EnvKey, string | undefined>;

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function setEnv(overrides: Partial<EnvSnapshot>): void {
  for (const key of ENV_KEYS) {
    if (!(key in overrides)) continue;
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function snapshotEnv(): EnvSnapshot {
  return {
    AI_MEMORY_CLASSIFY_API_KEY: process.env.AI_MEMORY_CLASSIFY_API_KEY,
    AI_MEMORY_CLASSIFY_MODEL: process.env.AI_MEMORY_CLASSIFY_MODEL,
    AI_MEMORY_EMBEDDING_API_KEY: process.env.AI_MEMORY_EMBEDDING_API_KEY,
  };
}

const EXISTING_MEMORY = {
  category: 'decision',
  confidence: 0.8,
  content: 'Zustand stores use the singleton pattern for cross-feature state',
  id: 10,
  similarity: 0.91,
};

const NEW_MEMORY = {
  category: 'decision',
  confidence: 0.7,
  content: 'State management uses Zustand singleton stores across features',
  id: 42,
};

function makeMockFetch(body: string, status: number) {
  return () => Promise.resolve(new Response(body, { status }));
}

function openAiChatBody(relationship: string, rest: { confidenceDelta: number; reasoning: string }): string {
  const { confidenceDelta, reasoning } = rest;
  return JSON.stringify({
    choices: [
      {
        message: {
          content: JSON.stringify({ confidenceDelta, reasoning, relationship }),
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// classifyMemoryPair tests
// ---------------------------------------------------------------------------

describe('classifyMemoryPair', () => {
  let savedEnv: EnvSnapshot;
  let savedFetch: typeof globalThis.fetch;

  beforeEach(() => {
    savedEnv = snapshotEnv();
    savedFetch = globalThis.fetch;
  });

  afterEach(() => {
    restoreEnv(savedEnv);
    globalThis.fetch = savedFetch;
  });

  // --- API key handling ---

  it('returns null when no API key is configured', async () => {
    setEnv({
      AI_MEMORY_CLASSIFY_API_KEY: undefined,
      AI_MEMORY_EMBEDDING_API_KEY: undefined,
    });
    const result = await classifyMemoryPair(NEW_MEMORY, EXISTING_MEMORY);
    assert.equal(result, null);
  });

  it('uses AI_MEMORY_CLASSIFY_API_KEY when set', async () => {
    setEnv({
      AI_MEMORY_CLASSIFY_API_KEY: 'sk-explicit-key',
      AI_MEMORY_EMBEDDING_API_KEY: undefined,
    });
    const calls: { headers: Record<string, string> }[] = [];
    globalThis.fetch = (_url, init) => {
      const headers = init?.headers as Record<string, string>;
      calls.push({ headers });
      return Promise.resolve(
        new Response(
          openAiChatBody('reinforce', {
            confidenceDelta: 0.05,
            reasoning: 'matches',
          }),
          { status: 200 },
        ),
      );
    };

    await classifyMemoryPair(NEW_MEMORY, EXISTING_MEMORY);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.headers.Authorization, 'Bearer sk-explicit-key');
  });

  it('falls back to AI_MEMORY_EMBEDDING_API_KEY when classify key absent', async () => {
    setEnv({
      AI_MEMORY_CLASSIFY_API_KEY: undefined,
      AI_MEMORY_EMBEDDING_API_KEY: 'sk-fallback-key',
    });
    const calls: { headers: Record<string, string> }[] = [];
    globalThis.fetch = (_url, init) => {
      const headers = init?.headers as Record<string, string>;
      calls.push({ headers });
      return Promise.resolve(
        new Response(
          openAiChatBody('unrelated', {
            confidenceDelta: 0,
            reasoning: 'different topic',
          }),
          {
            status: 200,
          },
        ),
      );
    };

    await classifyMemoryPair(NEW_MEMORY, EXISTING_MEMORY);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.headers.Authorization, 'Bearer sk-fallback-key');
  });

  // --- Model selection ---

  it('uses gpt-4o-mini as default model', async () => {
    setEnv({
      AI_MEMORY_CLASSIFY_API_KEY: 'sk-test',
      AI_MEMORY_CLASSIFY_MODEL: undefined,
    });
    const calls: { body: Record<string, unknown> }[] = [];
    globalThis.fetch = (_url, init) => {
      calls.push({
        body: JSON.parse(init?.body as string) as Record<string, unknown>,
      });
      return Promise.resolve(
        new Response(
          openAiChatBody('reinforce', {
            confidenceDelta: 0.05,
            reasoning: 'ok',
          }),
          { status: 200 },
        ),
      );
    };

    await classifyMemoryPair(NEW_MEMORY, EXISTING_MEMORY);
    assert.equal(calls[0]?.body.model, 'gpt-4o-mini');
  });

  it('uses AI_MEMORY_CLASSIFY_MODEL when set', async () => {
    setEnv({
      AI_MEMORY_CLASSIFY_API_KEY: 'sk-test',
      AI_MEMORY_CLASSIFY_MODEL: 'gpt-4o',
    });
    const calls: { body: Record<string, unknown> }[] = [];
    globalThis.fetch = (_url, init) => {
      calls.push({
        body: JSON.parse(init?.body as string) as Record<string, unknown>,
      });
      return Promise.resolve(
        new Response(
          openAiChatBody('reinforce', {
            confidenceDelta: 0.05,
            reasoning: 'ok',
          }),
          { status: 200 },
        ),
      );
    };

    await classifyMemoryPair(NEW_MEMORY, EXISTING_MEMORY);
    assert.equal(calls[0]?.body.model, 'gpt-4o');
  });

  // --- Network failures ---

  it('returns null on network failure', async () => {
    setEnv({ AI_MEMORY_CLASSIFY_API_KEY: 'sk-test' });
    globalThis.fetch = () => Promise.reject(new Error('ECONNREFUSED'));

    const result = await classifyMemoryPair(NEW_MEMORY, EXISTING_MEMORY);
    assert.equal(result, null);
  });

  it('returns null on HTTP 401', async () => {
    setEnv({ AI_MEMORY_CLASSIFY_API_KEY: 'sk-bad' });
    globalThis.fetch = makeMockFetch('unauthorized', 401);

    const result = await classifyMemoryPair(NEW_MEMORY, EXISTING_MEMORY);
    assert.equal(result, null);
  });

  it('returns null on HTTP 429 rate limit', async () => {
    setEnv({ AI_MEMORY_CLASSIFY_API_KEY: 'sk-test' });
    globalThis.fetch = makeMockFetch('rate limited', 429);

    const result = await classifyMemoryPair(NEW_MEMORY, EXISTING_MEMORY);
    assert.equal(result, null);
  });

  it('returns null on malformed JSON response body', async () => {
    setEnv({ AI_MEMORY_CLASSIFY_API_KEY: 'sk-test' });
    globalThis.fetch = makeMockFetch('not json at all', 200);

    const result = await classifyMemoryPair(NEW_MEMORY, EXISTING_MEMORY);
    assert.equal(result, null);
  });

  it('returns null when choices array is missing', async () => {
    setEnv({ AI_MEMORY_CLASSIFY_API_KEY: 'sk-test' });
    globalThis.fetch = makeMockFetch(JSON.stringify({ no_choices: true }), 200);

    const result = await classifyMemoryPair(NEW_MEMORY, EXISTING_MEMORY);
    assert.equal(result, null);
  });

  it('returns null when message content is missing', async () => {
    setEnv({ AI_MEMORY_CLASSIFY_API_KEY: 'sk-test' });
    globalThis.fetch = makeMockFetch(JSON.stringify({ choices: [{ message: {} }] }), 200);

    const result = await classifyMemoryPair(NEW_MEMORY, EXISTING_MEMORY);
    assert.equal(result, null);
  });

  it('returns null when content JSON is malformed', async () => {
    setEnv({ AI_MEMORY_CLASSIFY_API_KEY: 'sk-test' });
    const body = JSON.stringify({
      choices: [{ message: { content: '{bad json' } }],
    });
    globalThis.fetch = makeMockFetch(body, 200);

    const result = await classifyMemoryPair(NEW_MEMORY, EXISTING_MEMORY);
    assert.equal(result, null);
  });

  // --- Relationship validation ---

  it('returns null for unknown relationship value', async () => {
    setEnv({ AI_MEMORY_CLASSIFY_API_KEY: 'sk-test' });
    globalThis.fetch = makeMockFetch(
      openAiChatBody('uncertain', {
        confidenceDelta: 0,
        reasoning: 'not sure',
      }),
      200,
    );

    const result = await classifyMemoryPair(NEW_MEMORY, EXISTING_MEMORY);
    assert.equal(result, null);
  });

  it('returns null for non-string relationship', async () => {
    setEnv({ AI_MEMORY_CLASSIFY_API_KEY: 'sk-test' });
    const body = JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              confidenceDelta: 0,
              reasoning: 'ok',
              relationship: 42,
            }),
          },
        },
      ],
    });
    globalThis.fetch = makeMockFetch(body, 200);

    const result = await classifyMemoryPair(NEW_MEMORY, EXISTING_MEMORY);
    assert.equal(result, null);
  });

  // --- Successful classifications ---

  it('returns reinforce classification with positive delta', async () => {
    setEnv({ AI_MEMORY_CLASSIFY_API_KEY: 'sk-test' });
    globalThis.fetch = makeMockFetch(
      openAiChatBody('reinforce', {
        confidenceDelta: 0.08,
        reasoning: 'New memory confirms the Zustand pattern',
      }),
      200,
    );

    const result = await classifyMemoryPair(NEW_MEMORY, EXISTING_MEMORY);
    assert.ok(result !== null);
    assert.equal(result.relationship, 'reinforce');
    assert.equal(result.confidenceDelta, 0.08);
    assert.equal(result.reasoning, 'New memory confirms the Zustand pattern');
  });

  it('returns contradict classification', async () => {
    setEnv({ AI_MEMORY_CLASSIFY_API_KEY: 'sk-test' });
    globalThis.fetch = makeMockFetch(
      openAiChatBody('contradict', {
        confidenceDelta: -0.05,
        reasoning: 'Conflicts with existing decision',
      }),
      200,
    );

    const result = await classifyMemoryPair(NEW_MEMORY, EXISTING_MEMORY);
    assert.ok(result !== null);
    assert.equal(result.relationship, 'contradict');
    assert.equal(result.confidenceDelta, -0.05);
  });

  it('returns refine classification', async () => {
    setEnv({ AI_MEMORY_CLASSIFY_API_KEY: 'sk-test' });
    globalThis.fetch = makeMockFetch(
      openAiChatBody('refine', {
        confidenceDelta: 0.0,
        reasoning: 'New memory extends existing with more detail',
      }),
      200,
    );

    const result = await classifyMemoryPair(NEW_MEMORY, EXISTING_MEMORY);
    assert.ok(result !== null);
    assert.equal(result.relationship, 'refine');
  });

  it('returns unrelated classification', async () => {
    setEnv({ AI_MEMORY_CLASSIFY_API_KEY: 'sk-test' });
    globalThis.fetch = makeMockFetch(
      openAiChatBody('unrelated', {
        confidenceDelta: 0,
        reasoning: 'Different topic despite similar words',
      }),
      200,
    );

    const result = await classifyMemoryPair(NEW_MEMORY, EXISTING_MEMORY);
    assert.ok(result !== null);
    assert.equal(result.relationship, 'unrelated');
  });

  // --- Confidence delta clamping ---

  it('clamps confidenceDelta above +0.1 to +0.1', async () => {
    setEnv({ AI_MEMORY_CLASSIFY_API_KEY: 'sk-test' });
    globalThis.fetch = makeMockFetch(
      openAiChatBody('reinforce', {
        confidenceDelta: 0.99,
        reasoning: 'way too high',
      }),
      200,
    );

    const result = await classifyMemoryPair(NEW_MEMORY, EXISTING_MEMORY);
    assert.ok(result !== null);
    assert.equal(result.confidenceDelta, 0.1);
  });

  it('clamps confidenceDelta below -0.1 to -0.1', async () => {
    setEnv({ AI_MEMORY_CLASSIFY_API_KEY: 'sk-test' });
    globalThis.fetch = makeMockFetch(
      openAiChatBody('contradict', {
        confidenceDelta: -0.99,
        reasoning: 'way too low',
      }),
      200,
    );

    const result = await classifyMemoryPair(NEW_MEMORY, EXISTING_MEMORY);
    assert.ok(result !== null);
    assert.equal(result.confidenceDelta, -0.1);
  });

  it('allows confidenceDelta of exactly +0.1', async () => {
    setEnv({ AI_MEMORY_CLASSIFY_API_KEY: 'sk-test' });
    globalThis.fetch = makeMockFetch(
      openAiChatBody('reinforce', {
        confidenceDelta: 0.1,
        reasoning: 'at boundary',
      }),
      200,
    );

    const result = await classifyMemoryPair(NEW_MEMORY, EXISTING_MEMORY);
    assert.ok(result !== null);
    assert.equal(result.confidenceDelta, 0.1);
  });

  it('allows confidenceDelta of exactly -0.1', async () => {
    setEnv({ AI_MEMORY_CLASSIFY_API_KEY: 'sk-test' });
    globalThis.fetch = makeMockFetch(
      openAiChatBody('contradict', {
        confidenceDelta: -0.1,
        reasoning: 'at boundary',
      }),
      200,
    );

    const result = await classifyMemoryPair(NEW_MEMORY, EXISTING_MEMORY);
    assert.ok(result !== null);
    assert.equal(result.confidenceDelta, -0.1);
  });

  it('defaults confidenceDelta to 0 when not a number', async () => {
    setEnv({ AI_MEMORY_CLASSIFY_API_KEY: 'sk-test' });
    const body = JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              confidenceDelta: 'not-a-number',
              reasoning: 'ok',
              relationship: 'unrelated',
            }),
          },
        },
      ],
    });
    globalThis.fetch = makeMockFetch(body, 200);

    const result = await classifyMemoryPair(NEW_MEMORY, EXISTING_MEMORY);
    assert.ok(result !== null);
    assert.equal(result.confidenceDelta, 0);
  });

  // --- Reasoning truncation ---

  it('truncates reasoning to 200 characters', async () => {
    setEnv({ AI_MEMORY_CLASSIFY_API_KEY: 'sk-test' });
    const longReasoning = 'a'.repeat(300);
    globalThis.fetch = makeMockFetch(
      openAiChatBody('unrelated', {
        confidenceDelta: 0,
        reasoning: longReasoning,
      }),
      200,
    );

    const result = await classifyMemoryPair(NEW_MEMORY, EXISTING_MEMORY);
    assert.ok(result !== null);
    assert.equal(result.reasoning.length, 200);
  });

  it('preserves reasoning under 200 characters unchanged', async () => {
    setEnv({ AI_MEMORY_CLASSIFY_API_KEY: 'sk-test' });
    const shortReasoning = 'Confirms pattern';
    globalThis.fetch = makeMockFetch(
      openAiChatBody('reinforce', {
        confidenceDelta: 0.05,
        reasoning: shortReasoning,
      }),
      200,
    );

    const result = await classifyMemoryPair(NEW_MEMORY, EXISTING_MEMORY);
    assert.ok(result !== null);
    assert.equal(result.reasoning, shortReasoning);
  });

  it('defaults reasoning to empty string when absent', async () => {
    setEnv({ AI_MEMORY_CLASSIFY_API_KEY: 'sk-test' });
    const body = JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              confidenceDelta: 0,
              relationship: 'unrelated',
            }),
          },
        },
      ],
    });
    globalThis.fetch = makeMockFetch(body, 200);

    const result = await classifyMemoryPair(NEW_MEMORY, EXISTING_MEMORY);
    assert.ok(result !== null);
    assert.equal(result.reasoning, '');
  });

  // --- Request structure ---

  it('sends request to OpenAI chat completions endpoint', async () => {
    setEnv({ AI_MEMORY_CLASSIFY_API_KEY: 'sk-test' });
    const calls: string[] = [];
    globalThis.fetch = url => {
      calls.push(String(url));
      return Promise.resolve(
        new Response(openAiChatBody('unrelated', { confidenceDelta: 0, reasoning: 'ok' }), { status: 200 }),
      );
    };

    await classifyMemoryPair(NEW_MEMORY, EXISTING_MEMORY);
    assert.equal(calls[0], 'https://api.openai.com/v1/chat/completions');
  });

  it('sends temperature: 0 for deterministic output', async () => {
    setEnv({ AI_MEMORY_CLASSIFY_API_KEY: 'sk-test' });
    const calls: { body: Record<string, unknown> }[] = [];
    globalThis.fetch = (_url, init) => {
      calls.push({
        body: JSON.parse(init?.body as string) as Record<string, unknown>,
      });
      return Promise.resolve(
        new Response(openAiChatBody('unrelated', { confidenceDelta: 0, reasoning: 'ok' }), { status: 200 }),
      );
    };

    await classifyMemoryPair(NEW_MEMORY, EXISTING_MEMORY);
    assert.equal(calls[0]?.body.temperature, 0);
  });

  it('requests json_object response format', async () => {
    setEnv({ AI_MEMORY_CLASSIFY_API_KEY: 'sk-test' });
    const calls: { body: Record<string, unknown> }[] = [];
    globalThis.fetch = (_url, init) => {
      calls.push({
        body: JSON.parse(init?.body as string) as Record<string, unknown>,
      });
      return Promise.resolve(
        new Response(openAiChatBody('unrelated', { confidenceDelta: 0, reasoning: 'ok' }), { status: 200 }),
      );
    };

    await classifyMemoryPair(NEW_MEMORY, EXISTING_MEMORY);
    const format = calls[0]?.body.response_format as { type: string };
    assert.equal(format.type, 'json_object');
  });
});
