import type { PluginResult } from './pluginInstallation.js';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { dirname, resolve } from 'node:path';

import { probeCapabilities } from '../db/capabilities.js';
import { createPool } from '../db/pool.js';
import { runAiMemoryMigrations } from '../db/run-migrations.js';
import { loadPluginRuntimeEnv } from './pluginEnv.js';

interface Input {
  home: string;
  env: NodeJS.ProcessEnv;
  launcher: string;
  version: string;
}
interface Probes {
  databaseProbe?: (env: NodeJS.ProcessEnv, migrationsDir: string) => Promise<string>;
  mcpProbe?: (env: NodeJS.ProcessEnv, launcher: string, version: string) => Promise<boolean>;
}

export async function diagnosePluginRuntime(
  diagnostic: PluginResult,
  input: Input,
  probes: Probes = {},
): Promise<PluginResult> {
  // Native Codex stdio intentionally clears arbitrary host environment. Diagnose
  // the same dedicated protected configuration that its packaged launcher reads.
  const baseEnv: NodeJS.ProcessEnv = {};
  for (const key of ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ', 'NODE_OPTIONS']) {
    if (input.env[key] !== undefined) baseEnv[key] = input.env[key];
  }
  baseEnv.HOME = input.home;
  let configuration: ReturnType<typeof loadPluginRuntimeEnv>;
  try {
    configuration = loadPluginRuntimeEnv({ home: input.home, env: baseEnv });
  } catch {
    diagnostic.message =
      'Protect ~/.config/ai-memory/plugin.env: regular owner-owned file (0600), protected directory (0700).';
    diagnostic.state = 'configuration_required';
    return diagnostic;
  }
  if (
    configuration.fileState !== 'protected' ||
    configuration.runtime.status !== 'ok' ||
    configuration.runtime.databaseUrl === undefined
  ) {
    diagnostic.state = 'configuration_required';
    diagnostic.message =
      'Configure a loopback AI_MEMORY_DATABASE_URL in the protected dedicated plugin.env file. No database or service was changed.';
    return diagnostic;
  }
  const env = configuration.env;
  for (const key of Object.keys(env))
    if (key.startsWith('AI_MEMORY_EMBEDDING_') || key.startsWith('AI_MEMORY_CLASSIFY_')) delete env[key];
  const url = new URL(configuration.runtime.databaseUrl);
  url.searchParams.set(
    'options',
    `${url.searchParams.get('options') ?? ''} -c default_transaction_read_only=on -c statement_timeout=5000 -c idle_in_transaction_session_timeout=5000`.trim(),
  );
  env.AI_MEMORY_DATABASE_URL = url.href;
  env.AI_MEMORY_PLUGIN_DOCTOR = '1';
  env.AI_MEMORY_PLUGIN_MIGRATIONS_MODE = 'require_complete';
  env.AI_MEMORY_MCP_AUTO_START_POSTGRES = 'false';
  env.AI_MEMORY_MCP_REQUIRE_POSTGRES = 'true';
  env.AI_MEMORY_MCP_TRANSPORT = 'stdio';
  try {
    diagnostic.database.state = await (probes.databaseProbe ?? probeDatabase)(
      env,
      resolve(dirname(input.launcher), '../migrations'),
    );
  } catch {
    diagnostic.database.state = 'unavailable';
  }
  if (diagnostic.database.state !== 'ready') {
    diagnostic.state = 'database_required';
    diagnostic.message =
      'Matching complete migrations, local PostgreSQL 18 and pgvector are required. Apply matching package initialization separately with administrator authority.';
    return diagnostic;
  }
  let connected = false;
  try {
    connected = await (probes.mcpProbe ?? probeMcp)(env, input.launcher, input.version);
  } catch {
    /* Report bounded state; never return launcher stderr or credentials. */
  }
  diagnostic.mcp.state = connected ? 'connected' : 'failed';
  diagnostic.state = connected ? 'runtime_verified' : 'mcp_required';
  diagnostic.ok = connected;
  diagnostic.message = connected
    ? 'Native registration, selected plugin bytes, MCP handshake/tools and matching read-only schema checks passed.'
    : 'Configured native launcher did not complete the matching MCP handshake and tool inventory.';
  diagnostic.actions.push(
    'Reload/restart the native host and review/trust its current hooks explicitly. Hook trust and in-session loading are separate from this runtime probe.',
  );
  return diagnostic;
}

async function probeDatabase(env: NodeJS.ProcessEnv, migrationsDir: string): Promise<string> {
  const connectionString = env.AI_MEMORY_DATABASE_URL;
  if (connectionString === undefined) return 'not_checked';
  const pool = createPool({
    connectionString,
    connectionTimeoutMillis: 3_000,
    max: 1,
    statementTimeoutMs: 5_000,
    idleInTransactionTimeoutMs: 5_000,
  });
  try {
    await runAiMemoryMigrations(pool, { readOnly: true, migrationsDir });
    const client = await pool.connect();
    try {
      const version = await client.query<{ version: number }>(
        "SELECT current_setting('server_version_num')::int AS version",
      );
      const capabilities = await probeCapabilities(client);
      return Math.floor((version.rows[0]?.version ?? 0) / 10_000) === 18 &&
        capabilities.hasVector &&
        capabilities.hasEmbeddingColumn
        ? 'ready'
        : 'prerequisite_missing';
    } finally {
      client.release();
    }
  } catch (error) {
    return error instanceof Error && error.message.includes('canonical migrations')
      ? 'administrator_required'
      : 'unavailable';
  } finally {
    await pool.end();
  }
}

async function probeMcp(env: NodeJS.ProcessEnv, launcher: string, version: string): Promise<boolean> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) environment[key] = value;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [launcher],
    env: environment,
    stderr: 'pipe',
    maxBufferSize: 1024 * 1024,
  });
  const client = new Client({ name: 'ai-memory-plugin-doctor', version: '1.0.0' });
  let stderrBytes = 0;
  let exceeded = false;
  transport.stderr?.on('data', (data: Buffer) => {
    stderrBytes += data.length;
    if (stderrBytes > 1024 * 1024) {
      exceeded = true;
      void transport.close();
    }
  });
  try {
    await client.connect(transport, { timeout: 10_000 });
    const tools = await client.listTools({}, { timeout: 5_000 });
    return (
      !exceeded &&
      client.getServerVersion()?.name === 'ai-memory' &&
      client.getServerVersion()?.version === version &&
      ['memory_store', 'memory_search', 'memory_flush'].every(name => tools.tools.some(tool => tool.name === name))
    );
  } finally {
    await client.close();
    await transport.close();
  }
}
