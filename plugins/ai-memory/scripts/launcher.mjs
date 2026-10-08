import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadPluginRuntimeEnv } from '../../../packages/ai-memory/dist/tools/pluginEnv.js';

const root = dirname(fileURLToPath(import.meta.url));
let env;
try {
  // Both native hosts use this dedicated protected source. Arbitrary host
  // database/provider variables cannot override what doctor verifies.
  /** @type {NodeJS.ProcessEnv} */
  const inherited = {};
  for (const name of [
    'HOME',
    'LOGNAME',
    'PATH',
    'SHELL',
    'USER',
    'LANG',
    'LC_ALL',
    'TERM',
    'TMPDIR',
    'TZ',
    'NODE_OPTIONS',
    'AI_AGENT_IDENTITY',
    'CLAUDECODE',
    'CODEX',
    'CLAUDE_MODEL',
  ]) {
    if (process.env[name] !== undefined) inherited[name] = process.env[name];
  }
  env = loadPluginRuntimeEnv({ env: inherited }).env;
  if (process.env.AI_MEMORY_PLUGIN_DOCTOR === '1') {
    const configured = new URL(env.AI_MEMORY_DATABASE_URL ?? '');
    const diagnostic = new URL(process.env.AI_MEMORY_DATABASE_URL ?? '');
    configured.searchParams.delete('options');
    const expected = new URL(diagnostic.href);
    expected.searchParams.delete('options');
    if (expected.href !== configured.href) throw new Error('Protected configuration changed during diagnosis.');
    env.AI_MEMORY_DATABASE_URL = diagnostic.href;
    env.AI_MEMORY_PLUGIN_DOCTOR = '1';
  }
} catch {
  process.stderr.write('ai-memory: protect ~/.config/ai-memory/plugin.env (regular owner-owned file, 0600).\n');
  process.exit(1);
}
env.AI_MEMORY_PLUGIN_MIGRATIONS_MODE = 'require_complete';
env.AI_MEMORY_MIGRATIONS_DIR = resolve(root, '../migrations');
env.AI_MEMORY_MCP_AUTO_START_POSTGRES = 'false';
env.AI_MEMORY_MCP_REQUIRE_POSTGRES = 'true';
env.AI_MEMORY_MCP_TRANSPORT = 'stdio';
if (env.AI_MEMORY_PLUGIN_DOCTOR === '1') {
  for (const name of Object.keys(env))
    if (name.startsWith('AI_MEMORY_EMBEDDING_') || name.startsWith('AI_MEMORY_CLASSIFY_')) delete env[name];
}
// Hydrate before importing the existing server entry point. Keeping the server
// in this process lets native stdio close/cancellation own its whole lifetime.
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, env);
const server = resolve(root, 'mcp-server.bundle.js');
process.argv[1] = server;
try {
  await import(pathToFileURL(server).href);
} catch {
  process.stderr.write('ai-memory: matching bundled runtime could not start.\n');
  process.exitCode = 1;
}
