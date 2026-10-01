import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'vitest';

import {
  buildAiMemoryLaunchEnv,
  buildDesiredCodexAiMemoryConfig,
  type CodexMcpRegistration,
  evaluateCodexAiMemoryRegistration,
  isManagedCodexAiMemoryRegistration,
  readCodexAiMemoryRegistration,
  writeCodexAiMemoryRegistration,
} from './codexAiMemoryConfig.js';

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function protectedFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ai-memory-codex-'));
  temporaryDirectories.push(directory);
  const nodeExecPath = join(directory, 'selected-node');
  mkdirSync(join(directory, 'memory-consumers'));
  const protectedLauncherPath = join(directory, 'memory-consumers', 'mcp-launcher.mjs');
  const codexConfigPath = join(directory, 'config.toml');
  symlinkSync(process.execPath, nodeExecPath);
  writeFileSync(protectedLauncherPath, 'throw new Error("diagnosis must never execute the wrapper");\n');
  const desired = buildDesiredCodexAiMemoryConfig({
    codexConfigPath,
    nodeExecPath,
    protectedLauncherPath,
    baseEnv: {},
  });
  return { codexConfigPath, desired, nodeExecPath, protectedLauncherPath };
}

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

test('explicit protected launch preserves the selected Node, one argument, and no inline environment', () => {
  const { desired, nodeExecPath, protectedLauncherPath } = protectedFixture();
  const registration: CodexMcpRegistration = {
    args: [protectedLauncherPath],
    command: nodeExecPath,
    env: {},
    exists: true,
  };
  assert.equal(desired.command, nodeExecPath);
  assert.deepEqual(desired.args, [protectedLauncherPath]);
  assert.deepEqual(desired.env, {});
  assert.equal(evaluateCodexAiMemoryRegistration(registration, desired).ok, true);
  assert.equal(isManagedCodexAiMemoryRegistration(registration), false);
});

test('protected launch requires an explicit absolute Node and launcher identity', () => {
  assert.throws(
    () => buildDesiredCodexAiMemoryConfig({ protectedLauncherPath: '/synthetic/mcp-launcher.mjs' }),
    /absolute Node/u,
  );
  assert.throws(
    () =>
      buildDesiredCodexAiMemoryConfig({ protectedLauncherPath: 'mcp-launcher.mjs', nodeExecPath: process.execPath }),
    /absolute launcher/u,
  );
});

test('protected evaluation rejects a different Node, extra arguments, inline secrets and a missing wrapper without displaying values', () => {
  const { desired, nodeExecPath, protectedLauncherPath } = protectedFixture();
  const secret = 'synthetic-credential-do-not-display';
  const evaluation = evaluateCodexAiMemoryRegistration(
    {
      args: [protectedLauncherPath, secret],
      command: process.execPath,
      env: { PRIVATE_TOKEN: secret },
      exists: true,
    },
    desired,
  );
  assert.deepEqual(evaluation.mismatches, ['command_mismatch', 'args_mismatch', 'inline_env_not_allowed']);
  assert.equal(JSON.stringify(evaluation.mismatches).includes(secret), false);
  rmSync(protectedLauncherPath);
  assert.equal(
    evaluateCodexAiMemoryRegistration(
      { args: [protectedLauncherPath], command: nodeExecPath, env: {}, exists: true },
      desired,
    ).ok,
    false,
  );
});

test('atomic protected repair preserves unrelated host entries and removes inline environment', () => {
  const { codexConfigPath, desired, protectedLauncherPath } = protectedFixture();
  const unrelated = 'model = "example-model"\n\n[mcp_servers.other]\ncommand = "other-service"\nargs = ["unchanged"]\n';
  const original = `${unrelated}\n[mcp_servers.ai-memory]\ncommand = "node"\nargs = [${JSON.stringify(protectedLauncherPath)}]\nstartup_timeout_sec = 40\n\n[mcp_servers.ai-memory.env]\nPRIVATE_TOKEN = "synthetic-credential-do-not-display"\n`;
  writeFileSync(codexConfigPath, original, { mode: 0o600 });
  writeCodexAiMemoryRegistration(desired, original);
  const actual = readFileSync(codexConfigPath, 'utf8');
  assert.ok(actual.startsWith(unrelated));
  assert.ok(actual.includes('startup_timeout_sec = 40'));
  assert.equal(actual.includes('[mcp_servers.ai-memory.env]'), false);
  assert.equal(actual.includes('synthetic-credential-do-not-display'), false);
  assert.equal(evaluateCodexAiMemoryRegistration(readCodexAiMemoryRegistration(codexConfigPath), desired).ok, true);
});

test('atomic repair refuses a changed config and preserves the current recoverable bytes', () => {
  const { codexConfigPath, desired } = protectedFixture();
  const current = '[mcp_servers.other]\ncommand = "changed-concurrently"\n';
  writeFileSync(codexConfigPath, current);
  assert.throws(() => {
    writeCodexAiMemoryRegistration(desired, 'old config');
  }, /changed/u);
  assert.equal(readFileSync(codexConfigPath, 'utf8'), current);
});

test('atomic repair preserves unrelated commented and array table headers after its registration', () => {
  const { codexConfigPath, desired, protectedLauncherPath } = protectedFixture();
  const unrelated =
    '[mcp_servers.other] # keep this entry\ncommand = "other-service"\nargs = ["unchanged"]\n\n[[profiles.example.rules]]\ncommand = "also-unchanged"\n';
  const original = `[mcp_servers.ai-memory]\ncommand = "node"\nargs = [${JSON.stringify(protectedLauncherPath)}]\n\n${unrelated}`;
  writeFileSync(codexConfigPath, original);
  writeCodexAiMemoryRegistration(desired, original);
  assert.ok(readFileSync(codexConfigPath, 'utf8').endsWith(unrelated));
});
