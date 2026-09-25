import { spawn } from 'node:child_process';
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface RecoveryCodexOptions {
  codexRestrictedHome: string;
  context: { body: string; heading: string }[];
  env: Record<string, string>;
  maxDurationMs: number;
  mcpConfig: string[];
  model: 'gpt';
  modelId: string;
  onOutputLine: (line: string) => void;
  onRawOutputLine: (line: string) => void;
  options: { sandbox: 'read-only' };
  projectRoot: string;
  signal: AbortSignal;
  streamOutput: false;
  strictMcpConfig: true;
}

export async function writeRestrictedRecoveryCodexHome(options: {
  mcpConfigPaths: string[];
  sourceCodexHome: string;
}): Promise<{ cleanup: () => Promise<void>; codexHome: string }> {
  const codexHome = mkdtempSync(join(tmpdir(), 'ai-memory-replay-codex-'));
  try {
    const configPath = options.mcpConfigPaths[0];
    if (configPath === undefined || options.mcpConfigPaths.length !== 1)
      throw new Error('Recovery replay requires exactly one MCP configuration.');
    const config: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
    if (!isRecord(config) || !isRecord(config.mcpServers) || !isRecord(config.mcpServers.recovery))
      throw new Error('Recovery MCP configuration is invalid.');
    const server = config.mcpServers.recovery;
    if (
      typeof server.command !== 'string' ||
      !Array.isArray(server.args) ||
      !server.args.every(v => typeof v === 'string') ||
      !isRecord(server.env) ||
      !Object.values(server.env).every(v => typeof v === 'string')
    )
      throw new Error('Recovery MCP command or environment is invalid.');
    const lines = [
      '[mcp_servers.recovery]',
      `command = ${JSON.stringify(server.command)}`,
      `args = ${JSON.stringify(server.args)}`,
      '[mcp_servers.recovery.env]',
      ...Object.entries(server.env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`),
    ];
    writeFileSync(join(codexHome, 'config.toml'), `${lines.join('\n')}\n`, { mode: 0o600 });
    for (const name of ['auth.json', 'version.json']) {
      const source = join(options.sourceCodexHome, name);
      if (existsSync(source)) linkSync(source, join(codexHome, name));
    }
    return {
      codexHome,
      cleanup: async () => {
        rmSync(codexHome, { force: true, recursive: true });
      },
    };
  } catch (error) {
    rmSync(codexHome, { force: true, recursive: true });
    throw error;
  }
}

export async function launchRecoveryCodex(options: RecoveryCodexOptions): Promise<{
  cancellation?: { reason: 'external' | 'max_duration' };
  exitCode: number;
  output: string;
  outputFallback?: false;
}> {
  // TypeScript's literal types do not validate values passed by JavaScript callers.
  const runtimeStrictMcpConfig: unknown = options.strictMcpConfig;
  const runtimeStreamOutput: unknown = options.streamOutput;
  if (
    runtimeStrictMcpConfig !== true ||
    options.options.sandbox !== 'read-only' ||
    options.mcpConfig.length !== 1 ||
    !existsSync(options.mcpConfig[0] ?? '') ||
    options.model !== 'gpt' ||
    runtimeStreamOutput !== false
  ) {
    throw new Error('Recovery replay requires strict MCP and read-only Codex execution.');
  }
  const prompt = options.context.map(section => `# ${section.heading}\n${section.body}`).join('\n\n');
  const childEnv: NodeJS.ProcessEnv = { CODEX_HOME: options.codexRestrictedHome };
  for (const key of ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ'] as const) {
    const value = process.env[key];
    if (value !== undefined) childEnv[key] = value;
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(
      'codex',
      ['-C', options.projectRoot, '-s', 'read-only', '-m', options.modelId, 'exec', '--json', '-'],
      {
        cwd: options.projectRoot,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let raw = '';
    let pending = '';
    let stderr = '';
    let cancellation: 'external' | 'max_duration' | undefined;
    const stop = (reason: 'external' | 'max_duration') => {
      if (cancellation !== undefined) return;
      cancellation = reason;
      child.kill('SIGTERM');
    };
    const deadline = setTimeout(() => {
      stop('max_duration');
    }, options.maxDurationMs);
    const onAbort = () => {
      stop('external');
    };
    options.signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      raw += chunk;
      pending += chunk;
      while (pending.includes('\n')) {
        const index = pending.indexOf('\n');
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        options.onRawOutputLine(line);
      }
      if (raw.length > 1_048_576) stop('external');
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8192);
    });
    child.on('error', error => {
      clearTimeout(deadline);
      options.signal.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(deadline);
      options.signal.removeEventListener('abort', onAbort);
      if (pending) options.onRawOutputLine(pending);
      const messages = raw.split('\n').flatMap(line => {
        try {
          const event: unknown = JSON.parse(line);
          return isRecord(event) &&
            event.type === 'item.completed' &&
            isRecord(event.item) &&
            event.item.type === 'agent_message' &&
            typeof event.item.text === 'string'
            ? [event.item.text]
            : [];
        } catch {
          return [];
        }
      });
      resolve({
        ...(cancellation === undefined ? {} : { cancellation: { reason: cancellation } }),
        exitCode: cancellation === 'max_duration' ? 124 : (code ?? 1),
        output: messages.length ? messages.join('\n') : stderr,
      });
    });
    child.stdin.end(prompt);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
