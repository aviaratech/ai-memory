import assert from 'node:assert/strict';
import { test } from 'vitest';

import { bootstrapAiMemoryCliRuntimeEnv, bootstrapAiMemoryRuntimeEnv, loadAiMemoryMcpEnvConfig } from './runtimeEnv.js';

test('MCP startup does not start a local database unless requested', () => {
  assert.equal(loadAiMemoryMcpEnvConfig({ env: {} }).autoStartPostgres, false);
  assert.equal(loadAiMemoryMcpEnvConfig({ env: { AI_MEMORY_MCP_AUTO_START_POSTGRES: '1' } }).autoStartPostgres, true);
});

test('canonical local AI_MEMORY_DATABASE_URL is the only accepted database source', () => {
  const env: NodeJS.ProcessEnv = {
    AI_MEMORY_DATABASE_URL: 'postgresql://localhost:5432/ai_memory',
    DATABASE_URL: 'postgresql://localhost:5432/other',
  };

  const result = bootstrapAiMemoryRuntimeEnv({ env });
  assert.strictEqual(result.databaseUrl, 'postgresql://localhost:5432/ai_memory');
  assert.strictEqual(result.resolvedKey, 'AI_MEMORY_DATABASE_URL');
  assert.strictEqual(result.resolvedSource, 'canonical');
  assert.strictEqual(result.resolvedVia, 'process_env');
});

test('does not resolve legacy URL aliases when canonical local URL is absent', () => {
  const env: NodeJS.ProcessEnv = {
    AVIARA_MEMORY_DATABASE_URL: 'postgresql://localhost:5432/ai_memory',
    CLAUDE_PLUGIN_OPTION_DATABASE_URL: 'postgresql://localhost:5432/ai_memory',
    DATABASE_URL: 'postgresql://localhost:5432/ai_memory',
  };

  const result = bootstrapAiMemoryRuntimeEnv({ env });
  assert.strictEqual(result.status, 'missing');
  assert.strictEqual(result.databaseUrl, undefined);
  assert.strictEqual(env.AI_MEMORY_DATABASE_URL, undefined);
});

test('resolves database url from process env when present', () => {
  const env: NodeJS.ProcessEnv = {
    AI_MEMORY_DATABASE_URL: 'postgresql://localhost:5432/ai_memory',
  };

  const result = bootstrapAiMemoryRuntimeEnv({ env });
  assert.strictEqual(result.databaseUrl, 'postgresql://localhost:5432/ai_memory');
  assert.strictEqual(result.resolvedSource, 'canonical');
  assert.strictEqual(result.resolvedVia, 'process_env');
});

test('returns missing status when no database url is available', () => {
  const env: NodeJS.ProcessEnv = {};

  const result = bootstrapAiMemoryRuntimeEnv({ env, globalEnv: {} });
  assert.strictEqual(result.status, 'missing');
  assert.strictEqual(result.databaseUrl, undefined);
});

test('does not resolve shared RDS IAM env when canonical local URL is absent', () => {
  const env: NodeJS.ProcessEnv = {
    AWS_REGION: 'us-west-2',
    DB_HOST: 'db.example.invalid',
    DB_NAME: 'aviara_dev',
    DB_PORT: '5432',
    DB_USER: 'aviara_app',
  };

  const result = bootstrapAiMemoryRuntimeEnv({ env, globalEnv: {} });

  assert.strictEqual(result.status, 'missing');
  assert.strictEqual(result.authMode, undefined);
  assert.strictEqual(result.databaseUrl, undefined);
  assert.strictEqual(result.databaseUrlPresent, false);
  assert.strictEqual(result.resolvedKey, undefined);
  assert.strictEqual(result.resolvedSource, undefined);
  assert.strictEqual(result.resolvedVia, undefined);
});

test('rejects a remote canonical URL instead of silently using it', () => {
  const env: NodeJS.ProcessEnv = {};

  const result = bootstrapAiMemoryCliRuntimeEnv({
    env,
    globalEnv: { AI_MEMORY_DATABASE_URL: 'postgresql://memory:secret@rds.example:5432/ai_memory' },
  });

  assert.strictEqual(result.status, 'invalid');
  assert.match((result as { validationError?: string }).validationError ?? '', /loopback/u);
  assert.strictEqual(env.AI_MEMORY_DATABASE_URL, undefined);
});

test('rejects connection-target overrides in a loopback canonical URL', () => {
  const result = bootstrapAiMemoryRuntimeEnv({
    env: { AI_MEMORY_DATABASE_URL: 'postgresql://localhost/ai_memory?host=rds.example' },
    globalEnv: {},
  });

  assert.equal(result.status, 'invalid');
  assert.equal(result.databaseUrl, undefined);
  assert.match(result.validationError ?? '', /connection-target/u);
});

test('rejects a non-Postgres canonical URL', () => {
  const env: NodeJS.ProcessEnv = {
    AI_MEMORY_DATABASE_URL: 'mysql://localhost:3306/ai_memory',
  };

  const result = bootstrapAiMemoryRuntimeEnv({ env, globalEnv: {} });

  assert.strictEqual(result.status, 'invalid');
  assert.match((result as { validationError?: string }).validationError ?? '', /PostgreSQL/u);
  assert.strictEqual(result.databaseUrl, undefined);
});

test('rejects database pathnames with encoded conninfo or multiple path components', () => {
  for (const name of ['host%3D192.0.2.44%20dbname%3Dforeign', 'name%2Fother', 'one/two', 'name%00']) {
    const result = bootstrapAiMemoryRuntimeEnv({
      env: { AI_MEMORY_DATABASE_URL: `postgresql://localhost/${name}` },
      globalEnv: {},
    });
    assert.equal(result.status, 'invalid', name);
    assert.match(result.validationError ?? '', /database name/u);
  }
});

test('requireAiMemoryCliDatabaseTarget rejects shared RDS IAM configuration', async () => {
  const runtimeEnv = (await import('./runtimeEnv.js')) as Record<string, unknown>;
  const requireAiMemoryCliDatabaseTarget = runtimeEnv.requireAiMemoryCliDatabaseTarget;
  assert.equal(typeof requireAiMemoryCliDatabaseTarget, 'function');

  assert.throws(
    () =>
      (
        requireAiMemoryCliDatabaseTarget as (input: {
          env: NodeJS.ProcessEnv;
          globalEnv: NodeJS.ProcessEnv;
          repoEnv: NodeJS.ProcessEnv;
        }) => unknown
      )({
        env: {},
        globalEnv: {},
        repoEnv: {
          AWS_REGION: 'us-west-2',
          DB_HOST: 'db.example.invalid',
          DB_NAME: 'aviara_dev',
          DB_PORT: '5432',
          DB_USER: 'aviara_app',
        },
      }),
    /AI_MEMORY_DATABASE_URL/u,
  );
});

test('launcher metadata marks values that came from the machine-global plugins env', () => {
  const env = {
    AI_MEMORY_DATABASE_URL: 'postgresql://localhost:5432/ai_memory',
    AVIARA_PLUGIN_ENV_SOURCE_AI_MEMORY_DATABASE_URL: 'global_plugins_env',
  };

  const result = bootstrapAiMemoryRuntimeEnv({ env });

  assert.strictEqual(result.databaseUrl, 'postgresql://localhost:5432/ai_memory');
  assert.strictEqual(result.resolvedSource, 'canonical');
  assert.strictEqual(result.resolvedVia, 'global_plugins_env');
});

test('direct CLI bootstrap falls back to machine-global plugins env before repo .env', () => {
  const env: NodeJS.ProcessEnv = {};

  const result = bootstrapAiMemoryCliRuntimeEnv({
    env,
    globalEnv: {
      AI_MEMORY_DATABASE_URL: 'postgresql://localhost:5432/from-global',
    },
    repoEnv: {
      AI_MEMORY_DATABASE_URL: 'postgresql://localhost:5432/from-repo',
    },
  });

  assert.strictEqual(result.databaseUrl, 'postgresql://localhost:5432/from-global');
  assert.strictEqual(result.resolvedKey, 'AI_MEMORY_DATABASE_URL');
  assert.strictEqual(result.resolvedSource, 'canonical');
  assert.strictEqual(result.resolvedVia, 'global_plugins_env');
  assert.strictEqual(env.AI_MEMORY_DATABASE_URL, 'postgresql://localhost:5432/from-global');
});

test('runtime bootstrap hydrates embedding configuration from machine-global plugins env', () => {
  const env: NodeJS.ProcessEnv = {};

  const result = bootstrapAiMemoryRuntimeEnv({
    env,
    globalEnv: {
      AI_MEMORY_DATABASE_URL: 'postgresql://localhost:5432/from-global',
      AI_MEMORY_EMBEDDING_API_KEY: 'sk-global',
      AI_MEMORY_EMBEDDING_MODEL: 'text-embedding-3-small',
      AI_MEMORY_EMBEDDING_PROVIDER: 'openai',
    },
  });

  assert.strictEqual(result.databaseUrl, 'postgresql://localhost:5432/from-global');
  assert.strictEqual(result.resolvedVia, 'global_plugins_env');
  assert.strictEqual(env.AI_MEMORY_EMBEDDING_API_KEY, 'sk-global');
  assert.strictEqual(env.AI_MEMORY_EMBEDDING_MODEL, 'text-embedding-3-small');
  assert.strictEqual(env.AI_MEMORY_EMBEDDING_PROVIDER, 'openai');
  assert.strictEqual(env.AVIARA_PLUGIN_ENV_SOURCE_AI_MEMORY_EMBEDDING_PROVIDER, 'global_plugins_env');
});

test('debug env resolution logger writes through stderr instead of console.error', () => {
  const env: NodeJS.ProcessEnv = {
    AI_MEMORY_DATABASE_URL: 'postgresql://localhost:5432/ai_memory',
    AVIARA_PLUGIN_DEBUG_ENV: '1',
  };
  const stderrLines: string[] = [];
  const originalConsoleError = console.error;
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  console.error = () => {
    throw new Error('debug runtime env logging must not use console.error');
  };
  process.stderr.write = (
    ...args: [
      chunk: string | Uint8Array,
      encodingOrCallback?: ((err?: Error) => void) | BufferEncoding,
      callback?: (err?: Error) => void,
    ]
  ) => {
    const [chunk, encodingOrCallback, callback] = args;
    stderrLines.push(String(chunk));
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    done?.();
    return true;
  };

  try {
    bootstrapAiMemoryRuntimeEnv({ env, globalEnv: {} });
  } finally {
    console.error = originalConsoleError;
    process.stderr.write = originalStderrWrite;
  }

  assert.match(stderrLines.join(''), /resolved AI_MEMORY_DATABASE_URL/u);
});

test('direct CLI bootstrap hydrates embedding configuration from repo env when global env omits it', () => {
  const env: NodeJS.ProcessEnv = {};

  const result = bootstrapAiMemoryCliRuntimeEnv({
    env,
    globalEnv: {
      AI_MEMORY_DATABASE_URL: 'postgresql://localhost:5432/from-global',
    },
    repoEnv: {
      AI_MEMORY_DATABASE_URL: 'postgresql://localhost:5432/from-repo',
      AI_MEMORY_EMBEDDING_API_KEY: 'sk-repo',
      AI_MEMORY_EMBEDDING_PROVIDER: 'openai',
      AI_MEMORY_EMBEDDING_TIMEOUT_MS: '7000',
    },
  });

  assert.strictEqual(result.databaseUrl, 'postgresql://localhost:5432/from-global');
  assert.strictEqual(env.AI_MEMORY_EMBEDDING_API_KEY, 'sk-repo');
  assert.strictEqual(env.AI_MEMORY_EMBEDDING_PROVIDER, 'openai');
  assert.strictEqual(env.AI_MEMORY_EMBEDDING_TIMEOUT_MS, '7000');
});

test('direct CLI bootstrap still prefers explicit process env over machine-global plugins env', () => {
  const env: NodeJS.ProcessEnv = {
    AI_MEMORY_DATABASE_URL: 'postgresql://localhost:5432/from-process',
  };

  const result = bootstrapAiMemoryCliRuntimeEnv({
    env,
    globalEnv: {
      AI_MEMORY_DATABASE_URL: 'postgresql://localhost:5432/from-global',
    },
    repoEnv: {
      AI_MEMORY_DATABASE_URL: 'postgresql://localhost:5432/from-repo',
    },
  });

  assert.strictEqual(result.databaseUrl, 'postgresql://localhost:5432/from-process');
  assert.strictEqual(result.resolvedKey, 'AI_MEMORY_DATABASE_URL');
  assert.strictEqual(result.resolvedSource, 'canonical');
  assert.strictEqual(result.resolvedVia, 'process_env');
});

test('MCP env config rejects invalid HTTP ports with an actionable env name', async () => {
  const runtimeEnvModule = (await import('./runtimeEnv.js')) as Record<string, unknown>;
  const loadAiMemoryMcpEnvConfig = runtimeEnvModule.loadAiMemoryMcpEnvConfig;
  assert.equal(typeof loadAiMemoryMcpEnvConfig, 'function');

  assert.throws(
    () =>
      (loadAiMemoryMcpEnvConfig as (input: { env: NodeJS.ProcessEnv }) => unknown)({
        env: {
          AI_MEMORY_MCP_HTTP_PORT: 'not-a-port',
          AI_MEMORY_MCP_TRANSPORT: 'http',
        },
      }),
    /AI_MEMORY_MCP_HTTP_PORT must be an integer from 0 to 65535/u,
  );
});

test('Postgres env config rejects invalid required major values', async () => {
  const runtimeEnvModule = (await import('./runtimeEnv.js')) as Record<string, unknown>;
  const loadAiMemoryPostgresEnvConfig = runtimeEnvModule.loadAiMemoryPostgresEnvConfig;
  assert.equal(typeof loadAiMemoryPostgresEnvConfig, 'function');

  assert.throws(
    () =>
      (loadAiMemoryPostgresEnvConfig as (input: { env: NodeJS.ProcessEnv }) => unknown)({
        env: {
          AI_MEMORY_POSTGRES_REQUIRED_MAJOR: 'eighteen',
        },
      }),
    /AI_MEMORY_POSTGRES_REQUIRED_MAJOR must be a positive integer/u,
  );
});
