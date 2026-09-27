import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'vitest';

import {
  buildAiMemoryLaunchEnv,
  buildDesiredCodexAiMemoryConfig,
  type CodexMcpRegistration,
  isManagedCodexAiMemoryRegistration,
} from './codexAiMemoryConfig.js';

test('buildAiMemoryLaunchEnv falls back to machine-global plugins env', () => {
  const env = buildAiMemoryLaunchEnv({
    baseEnv: {},
    existingEnv: {},
    globalEnv: {
      AI_MEMORY_DATABASE_URL: 'postgresql://localhost:5432/from-global',
    },
  });

  assert.equal(env.AI_MEMORY_DATABASE_URL, 'postgresql://localhost:5432/from-global');
});

test('buildAiMemoryLaunchEnv defaults the required Postgres major for the local target', () => {
  const env = buildAiMemoryLaunchEnv({
    baseEnv: {},
    existingEnv: {},
    globalEnv: {
      AI_MEMORY_DATABASE_URL: 'postgresql://localhost:5432/from-global',
    },
  });

  assert.equal(env.AI_MEMORY_POSTGRES_REQUIRED_MAJOR, '18');
});

test('buildAiMemoryLaunchEnv rejects unrelated database configuration without a local URL', () => {
  assert.throws(
    () =>
      buildAiMemoryLaunchEnv({
        baseEnv: {},
        existingEnv: {},
        globalEnv: { DB_HOST: 'unrelated.example.invalid' },
      }),
    /AI_MEMORY_DATABASE_URL/u,
  );
});

test('buildAiMemoryLaunchEnv carries embedding env from machine-global plugins env', () => {
  const env = buildAiMemoryLaunchEnv({
    baseEnv: {},
    existingEnv: {},
    globalEnv: {
      AI_MEMORY_DATABASE_URL: 'postgresql://localhost:5432/from-global',
      AI_MEMORY_EMBEDDING_API_KEY: 'sk-global',
      AI_MEMORY_EMBEDDING_MODEL: 'text-embedding-3-small',
      AI_MEMORY_EMBEDDING_PROVIDER: 'openai',
      AI_MEMORY_EMBEDDING_TIMEOUT_MS: '7000',
    },
  });

  assert.equal(env.AI_MEMORY_DATABASE_URL, 'postgresql://localhost:5432/from-global');
  assert.equal(env.AI_MEMORY_EMBEDDING_API_KEY, 'sk-global');
  assert.equal(env.AI_MEMORY_EMBEDDING_MODEL, 'text-embedding-3-small');
  assert.equal(env.AI_MEMORY_EMBEDDING_PROVIDER, 'openai');
  assert.equal(env.AI_MEMORY_EMBEDDING_TIMEOUT_MS, '7000');
});

test('managed staged ai-memory launcher registration is a healthy Codex registration', () => {
  const currentPath = '/Users/test/.local/share/aviaratech-ai/current';
  const registration: CodexMcpRegistration = {
    args: [join(currentPath, 'plugins', 'ai-memory', 'dist', 'mcp-launcher.js')],
    command: process.execPath,
    env: {},
    exists: true,
  };

  assert.equal(isManagedCodexAiMemoryRegistration(registration, { currentPath }), true);
});

test('legacy bare-node staged ai-memory launcher registration is stale', () => {
  const currentPath = '/Users/test/.local/share/aviaratech-ai/current';
  const registration: CodexMcpRegistration = {
    args: [join(currentPath, 'plugins', 'ai-memory', 'dist', 'mcp-launcher.js')],
    command: 'node',
    env: {},
    exists: true,
  };

  assert.equal(isManagedCodexAiMemoryRegistration(registration, { currentPath }), false);
});

test('desired Codex ai-memory config pins the current Node executable', () => {
  const desired = buildDesiredCodexAiMemoryConfig({
    baseEnv: {
      AI_MEMORY_DATABASE_URL: 'postgresql://localhost:5432/test',
    },
  });

  assert.equal(desired.command, process.execPath);
});
