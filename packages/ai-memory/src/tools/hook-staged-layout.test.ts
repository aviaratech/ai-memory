import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';

const thisDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(thisDir, '../../../..');
const pluginHooksDir = join(repoRoot, 'plugins/ai-memory/hooks');

/** Stubbed recall JSON that the fake ai-memory-mcp binary emits. */
const STUB_RECALL =
  '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"status: ok\\ntest-data"}}';

/**
 * Stages the hook into a temp directory that mimics the marketplace cache
 * layout: no sibling `packages/` directory exists.
 *
 *   <tmp>/plugin-root/
 *     hooks/session-start
 *     hooks/session-end
 *     skills/memory-lifecycle/SKILL.md   (minimal stub)
 *     dist/mcp-launcher.js               (stub launcher, optional)
 *     bin/ai-memory-mcp                  (stub binary, optional)
 */
function stageTempPlugin(opts?: {
  sessionEndExitCode?: number;
  sessionEndStderr?: string;
  sessionEndStdout?: string;
  stubBinary?: boolean;
  stubBundledRuntime?: boolean;
}): {
  binDir: string;
  cleanup: () => void;
  root: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'ai-memory-hook-test-'));
  const hooksDir = join(root, 'hooks');
  const skillDir = join(root, 'skills/memory-lifecycle');
  const binDir = join(root, 'bin');
  const distDir = join(root, 'dist');

  mkdirSync(hooksDir, { recursive: true });
  mkdirSync(skillDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(distDir, { recursive: true });

  cpSync(join(pluginHooksDir, 'session-start'), join(hooksDir, 'session-start'));
  cpSync(join(pluginHooksDir, 'session-end'), join(hooksDir, 'session-end'));

  // Provide a minimal skill stub so the hook doesn't fail on missing SKILL.md
  writeFileSync(join(skillDir, 'SKILL.md'), '# Memory Lifecycle (test stub)\n');

  const sessionEndExitCode = opts?.sessionEndExitCode ?? 0;
  const sessionEndStderr = opts?.sessionEndStderr ?? '';
  const sessionEndStdout = opts?.sessionEndStdout ?? '';

  if (opts?.stubBinary) {
    // Create a stub ai-memory-mcp that emits known JSON for session-start
    // and exits 0 for session-end.
    const stubScript = `#!/bin/bash
if [ "$1" = "hook:session-start" ]; then
  printf '%s' '${STUB_RECALL}'
elif [ "$1" = "hook:session-end" ]; then
  ${sessionEndStdout.length > 0 ? `printf '%s' ${JSON.stringify(sessionEndStdout)}` : ':'}
  ${sessionEndStderr.length > 0 ? `printf '%s' ${JSON.stringify(sessionEndStderr)} >&2` : ':'}
  exit ${String(sessionEndExitCode)}
else
  echo "unknown subcommand: $1" >&2
  exit 1
fi
`;
    const stubPath = join(binDir, 'ai-memory-mcp');
    writeFileSync(stubPath, stubScript);
    chmodSync(stubPath, 0o755);
  }

  if (opts?.stubBundledRuntime) {
    writeFileSync(
      join(distDir, 'mcp-launcher.js'),
      `#!/usr/bin/env node
if (process.argv[2] === 'hook:session-start') {
  process.stdout.write('${STUB_RECALL}');
} else if (process.argv[2] === 'hook:session-end') {
  process.stdout.write(${JSON.stringify(sessionEndStdout)});
  process.stderr.write(${JSON.stringify(sessionEndStderr)});
  process.exit(${String(sessionEndExitCode)});
} else {
  process.exit(1);
}
`,
    );
    chmodSync(join(distDir, 'mcp-launcher.js'), 0o755);
  }

  return {
    binDir,
    cleanup: () => {
      rmSync(root, { force: true, recursive: true });
    },
    root,
  };
}

describe('session hooks in staged layout (no sibling packages/)', () => {
  test('session-start: no repo-relative path math in hook source', () => {
    const hookSource = readFileSync(join(pluginHooksDir, 'session-start'), 'utf8');
    assert.ok(!hookSource.includes('REPO_ROOT'), 'session-start must not contain REPO_ROOT variable');
    // Must not shell to a repo-relative server.js path (the original bug)
    assert.ok(
      !hookSource.includes('packages/ai-memory/dist/tools/server.js'),
      'session-start must not shell to packages/ai-memory/dist/tools/server.js',
    );
  });

  test('session-start: hook timeout allows orient fanout retrieval', () => {
    const hookConfig = JSON.parse(readFileSync(join(pluginHooksDir, 'hooks.json'), 'utf8')) as {
      hooks?: { SessionStart?: { hooks?: { timeout?: unknown }[] }[] };
    };
    const sessionStart = hookConfig.hooks?.SessionStart?.[0]?.hooks?.[0];
    assert.equal(sessionStart?.timeout, 30, 'SessionStart hook timeout should be 30s for orient fanout');
  });

  test('session-end: no repo-relative path math in hook source', () => {
    const hookSource = readFileSync(join(pluginHooksDir, 'session-end'), 'utf8');
    assert.ok(!hookSource.includes('REPO_ROOT'), 'session-end must not contain REPO_ROOT variable');
    assert.ok(
      !hookSource.includes('packages/ai-memory/dist/tools/server.js'),
      'session-end must not shell to packages/ai-memory/dist/tools/server.js',
    );
  });

  test('session-start: binary-missing branch emits specific warning', () => {
    const staged = stageTempPlugin();
    try {
      const output = execFileSync('/bin/bash', [`${staged.root}/hooks/session-start`], {
        encoding: 'utf8',
        env: {
          CLAUDE_PLUGIN_ROOT: staged.root,
          HOME: process.env.HOME ?? '',
          PATH: '/usr/bin:/bin',
        },
        timeout: 10_000,
      });

      const parsed: unknown = JSON.parse(output);
      assert.ok(typeof parsed === 'object' && parsed !== null, 'output must be valid JSON object');

      // The recall_output embedded in the context should contain the missing-binary warning
      assert.ok(output.includes('not on PATH'), 'binary-missing warning must mention "not on PATH"');
      assert.ok(
        !output.includes('connection failed'),
        'must not use generic "connection failed" message for missing binary',
      );
    } finally {
      staged.cleanup();
    }
  });

  test('session-end: binary-missing branch emits warning on stderr and exits cleanly', () => {
    const staged = stageTempPlugin();
    try {
      const result = spawnSync('/bin/bash', [`${staged.root}/hooks/session-end`], {
        encoding: 'utf8',
        env: {
          HOME: process.env.HOME ?? '',
          PATH: '/usr/bin:/bin',
        },
        timeout: 10_000,
      });
      assert.equal(result.status, 0, 'session-end must exit 0');
      assert.deepEqual(JSON.parse(result.stdout), { continue: true, suppressOutput: true });
      assert.ok(
        result.stderr.includes('no bundled MCP server and ai-memory-mcp not on PATH'),
        'session-end should surface the missing-binary warning on stderr',
      );
    } finally {
      staged.cleanup();
    }
  });

  test('session-end: binary-missing warning is distinguishable from hook-failed warning', () => {
    const staged = stageTempPlugin();
    try {
      const result = spawnSync('/bin/bash', [`${staged.root}/hooks/session-end`], {
        encoding: 'utf8',
        env: {
          HOME: process.env.HOME ?? '',
          PATH: '/usr/bin:/bin',
        },
        timeout: 10_000,
      });
      assert.equal(result.status, 0, 'session-end must exit 0');
      assert.ok(result.stderr.includes('not on PATH'), 'missing-binary warning must mention "not on PATH"');
      assert.ok(
        !result.stderr.includes('hook failed'),
        'missing-binary warning must stay distinguishable from a hook-failed warning',
      );
    } finally {
      staged.cleanup();
    }
  });

  test('session-start: hermetic success path with stub binary returns status ok', () => {
    const staged = stageTempPlugin({ stubBinary: true });
    try {
      // Use a controlled PATH that includes only the stub binary dir and system bins
      const output = execFileSync('/bin/bash', [`${staged.root}/hooks/session-start`], {
        encoding: 'utf8',
        env: {
          CLAUDE_PLUGIN_ROOT: staged.root,
          HOME: process.env.HOME ?? '',
          PATH: `${staged.binDir}:/usr/bin:/bin`,
          TMPDIR: tmpdir(),
        },
        timeout: 10_000,
      });

      const parsed: unknown = JSON.parse(output);
      assert.ok(typeof parsed === 'object' && parsed !== null, 'output must be valid JSON object');

      // Must NOT contain the missing-binary or hook-failed warnings
      assert.ok(!output.includes('not on PATH'), 'should not emit missing-binary warning');
      assert.ok(!output.includes('hook failed'), 'should not emit hook-failed warning');
      assert.ok(!output.includes('connection failed'), 'should not emit connection-failed warning');

      // Must contain the stubbed recall data proving the hook ran the binary
      assert.ok(output.includes('test-data'), 'output must contain the stub recall data');
      assert.ok(
        output.includes('"status":"ok"') || output.includes('"status\\": \\"ok\\"') || output.includes('status'),
        'output must reflect status ok from stub',
      );
    } finally {
      staged.cleanup();
    }
  });

  test('session-end: hermetic success path with stub binary exits cleanly', () => {
    const staged = stageTempPlugin({ stubBinary: true });
    try {
      const result = spawnSync('/bin/bash', [`${staged.root}/hooks/session-end`], {
        encoding: 'utf8',
        env: {
          HOME: process.env.HOME ?? '',
          PATH: `${staged.binDir}:/usr/bin:/bin`,
        },
        timeout: 10_000,
      });

      assert.equal(result.status, 0, 'session-end must exit 0');
      assert.deepEqual(JSON.parse(result.stdout), { continue: true, suppressOutput: true });
      // With the stub binary available, session-end should not emit any warning
      assert.ok(
        !result.stderr.includes('not on PATH'),
        'should not emit missing-binary warning when binary is available',
      );
      assert.ok(!result.stderr.includes('hook failed'), 'should not emit hook-failed warning when binary succeeds');
    } finally {
      staged.cleanup();
    }
  });

  test('session-end: Stop hook keeps stdout JSON-only even when child emits stdout', () => {
    const staged = stageTempPlugin({
      sessionEndStdout: '[ai-memory][warn] bundled runtime warning\n',
      stubBundledRuntime: true,
    });
    try {
      const result = spawnSync('/bin/bash', [`${staged.root}/hooks/session-end`], {
        encoding: 'utf8',
        env: {
          HOME: process.env.HOME ?? '',
          PATH: `${process.execPath.slice(0, process.execPath.lastIndexOf('/'))}:/usr/bin:/bin`,
        },
        input: '{"hook_event_name":"Stop","session_id":"test-session","transcript_path":"/tmp/missing"}',
        timeout: 10_000,
      });

      assert.equal(result.status, 0, 'session-end must exit 0');
      assert.deepEqual(JSON.parse(result.stdout), { continue: true, suppressOutput: true });
      assert.ok(
        result.stderr.includes('bundled runtime warning'),
        'child stdout must be forwarded to stderr so Stop-hook stdout stays valid JSON',
      );
    } finally {
      staged.cleanup();
    }
  });

  test('session-start: bundled runtime path works even when ai-memory-mcp is unavailable on PATH', () => {
    const staged = stageTempPlugin({ stubBundledRuntime: true });
    try {
      const output = execFileSync('/bin/bash', [`${staged.root}/hooks/session-start`], {
        encoding: 'utf8',
        env: {
          CLAUDE_PLUGIN_ROOT: staged.root,
          HOME: process.env.HOME ?? '',
          PATH: `${process.execPath.slice(0, process.execPath.lastIndexOf('/'))}:/usr/bin:/bin`,
          TMPDIR: tmpdir(),
        },
        timeout: 10_000,
      });

      assert.ok(output.includes('test-data'), 'bundled runtime should provide recall data');
      assert.ok(!output.includes('not on PATH'), 'bundled runtime should avoid PATH warnings');
    } finally {
      staged.cleanup();
    }
  });
});

test('session-start wrapper never injects an installed lifecycle skill', () => {
  const staged = stageTempPlugin({ stubBinary: true });
  try {
    writeFileSync(join(staged.root, 'skills/memory-lifecycle/SKILL.md'), 'FULL_SKILL_SENTINEL'.repeat(2000));
    const output = execFileSync('/bin/bash', [join(staged.root, 'hooks/session-start')], {
      encoding: 'utf8',
      env: { CLAUDE_PLUGIN_ROOT: staged.root, PATH: `${staged.binDir}:/usr/bin:/bin` },
    });
    assert.ok(!output.includes('FULL_SKILL_SENTINEL'));
  } finally {
    staged.cleanup();
  }
});

for (const host of ['codex', 'claude', 'cursor', 'cursor-with-claude']) {
  for (const runtime of ['healthy', 'failed', 'missing'] as const) {
    test(`session-start: ${host} ${runtime} staged envelope`, () => {
      const staged = stageTempPlugin();
      try {
        if (runtime !== 'missing') {
          const serializerUrl = new URL('../../dist/tools/ingestion/session-start-hook.js', import.meta.url).href;
          writeFileSync(
            join(staged.root, 'dist/mcp-launcher.js'),
            runtime === 'failed'
              ? 'process.stdout.write("partial-output"); process.exit(1);'
              : `import { serializeSessionStartHook } from ${JSON.stringify(serializerUrl)};
process.stdout.write(serializeSessionStartHook({
  bootstrapText: 'source: prior-session\\nnext action: test-data',
  continue: true, status: 'ok', suppressOutput: true
}));`,
          );
        }
        const cursor = host.startsWith('cursor');
        for (const source of ['startup', 'clear', 'compact']) {
          const result = spawnSync('/bin/bash', [join(staged.root, 'hooks/session-start')], {
            encoding: 'utf8',
            env: {
              ...(cursor ? { CURSOR_PLUGIN_ROOT: staged.root } : {}),
              ...(host === 'claude' || host === 'cursor-with-claude' ? { CLAUDE_PLUGIN_ROOT: staged.root } : {}),
              AI_MEMORY_LOG_FILE: '/dev/null',
              AI_MEMORY_LOG_STDERR: '0',
              PATH: `${process.execPath.slice(0, process.execPath.lastIndexOf('/'))}:/usr/bin:/bin`,
            },
            input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'test-session', source }),
            timeout: 10_000,
          });
          assert.equal(result.status, 0);
          const envelope = JSON.parse(result.stdout) as {
            additional_context?: string;
            hookSpecificOutput?: { additionalContext: string; hookEventName: string };
          };
          assert.deepEqual(Object.keys(envelope), [cursor ? 'additional_context' : 'hookSpecificOutput']);
          if (!cursor) {
            assert.equal(envelope.hookSpecificOutput?.hookEventName, 'SessionStart');
            assert.deepEqual(Object.keys(envelope.hookSpecificOutput ?? {}).sort(), [
              'additionalContext',
              'hookEventName',
            ]);
          }
          const context = cursor ? envelope.additional_context : envelope.hookSpecificOutput?.additionalContext;
          assert.ok(context !== undefined && context.length <= 8000);
          assert.match(
            context,
            { failed: /hook failed/u, healthy: /prior-session\nnext action: test-data/u, missing: /not on PATH/u }[
              runtime
            ],
          );
          assert.ok(!result.stdout.includes('partial-output'));
        }
      } finally {
        staged.cleanup();
      }
    });
  }
}

// Exercise the real dispatch and bundled launcher with a writable that requires
// completion across turns, so process.exit cannot silently discard the tail.
async function withHookPipeFixture(
  run: (fixture: { root: string; plugin: string; env: NodeJS.ProcessEnv }) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), 'ai-memory-hook-pipe-'));
  const server = createServer(socket => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address !== null && typeof address !== 'string');
    const databaseUrl = `postgresql://synthetic:synthetic@127.0.0.1:${String(address.port)}/synthetic`;
    const home = join(root, 'home');
    mkdirSync(join(home, '.config/ai-memory'), { recursive: true, mode: 0o700 });
    const config = join(home, '.config/ai-memory/plugin.env');
    writeFileSync(config, `AI_MEMORY_DATABASE_URL=${databaseUrl}\n`);
    chmodSync(config, 0o600);
    const plugin = join(root, 'plugin');
    cpSync(join(repoRoot, 'plugins/ai-memory'), plugin, { recursive: true });
    const preload = join(root, 'pipe.mjs');
    writeFileSync(
      preload,
      `
const write = process.stdout.write.bind(process.stdout);
const mode = process.env.SYNTHETIC_PIPE_MODE;
setInterval(() => {}, 60_000); // Intentional exit must still quiesce live handles.
process.stdout.write = (chunk, encoding, callback) => {
  const done = typeof encoding === 'function' ? encoding : callback;
  if (mode === 'error') {
    queueMicrotask(() => {
      const error = Object.assign(new Error('PRIVATE_WRITER_FAILURE'), { code: 'EPIPE' });
      process.stdout.emit('error', error);
      done?.(error);
    });
    return false;
  }
  const bytes = Buffer.from(chunk);
  const split = Math.min(512, Math.max(1, Math.floor(bytes.length / 2)));
  write(bytes.subarray(0, split), error => {
    if (error) { done?.(error); return; }
    if (mode !== 'hold') setImmediate(() => write(bytes.subarray(split), done));
  });
  return false;
};
`,
    );
    await run({
      root,
      plugin,
      env: {
        HOME: home,
        PATH: `${process.execPath.slice(0, process.execPath.lastIndexOf('/'))}:/usr/bin:/bin`,
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
        AI_MEMORY_DATABASE_URL: databaseUrl,
        AI_MEMORY_LOG_FILE: '/dev/null',
        AI_MEMORY_LOG_STDERR: '0',
        CODEX: '1',
      },
    });
  } finally {
    if (server.listening)
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error) reject(error);
          else resolve();
        });
      });
    rmSync(root, { force: true, recursive: true });
  }
}

function runHookPipe(input: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  payload: string;
  cancel?: boolean;
}): Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; pid: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, { env: input.env, detached: input.cancel === true });
    const pid = child.pid;
    assert.ok(pid !== undefined);
    let stdout = '',
      stderr = '';
    const stall = setTimeout(() => {
      if (input.cancel) process.kill(-pid, 'SIGKILL');
      else child.kill('SIGKILL');
      reject(new Error('Hook failed to quiesce after its output completed.'));
    }, 10_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (input.cancel) {
        try {
          process.kill(-pid, 'SIGTERM');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', error => {
      clearTimeout(stall);
      reject(error);
    });
    child.once('close', (status, signal) => {
      clearTimeout(stall);
      resolve({ status, signal, stdout, stderr, pid });
    });
    child.stdin.end(input.payload);
  });
}

for (const entry of ['core', 'codex-bundle', 'claude-bundle'] as const) {
  test(`real ${entry} SessionStart completes its JSON pipe before intentional exit`, async () => {
    await withHookPipeFixture(async ({ env, plugin }) => {
      const bundled = entry.endsWith('bundle');
      const childEnv: NodeJS.ProcessEnv = {
        ...env,
        ...(entry === 'claude-bundle' ? { CLAUDECODE: '1', CLAUDE_PLUGIN_ROOT: plugin } : { PLUGIN_ROOT: plugin }),
      };
      if (entry === 'claude-bundle') delete childEnv.CODEX;
      const result = await runHookPipe({
        command: bundled ? '/bin/bash' : process.execPath,
        args: bundled
          ? [join(plugin, 'hooks/session-start')]
          : [join(repoRoot, 'packages/ai-memory/dist/tools/server.js'), 'hook:session-start'],
        env: childEnv,
        payload: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'synthetic-pipe' }),
      });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(Buffer.byteLength(result.stdout) > 512);
      const envelope = JSON.parse(result.stdout) as {
        hookSpecificOutput: { hookEventName: string; additionalContext: string };
      };
      assert.equal(envelope.hookSpecificOutput.hookEventName, 'SessionStart');
      assert.ok(envelope.hookSpecificOutput.additionalContext.length <= 8000);
      assert.equal(result.stdout, JSON.stringify(envelope) + '\n');
    });
  });
}

for (const malformed of [false, true]) {
  test(`real task hook ${malformed ? 'sanitized fallback' : 'normal output'} completes the pipe`, async () => {
    await withHookPipeFixture(async ({ env }) => {
      const result = await runHookPipe({
        command: process.execPath,
        args: [join(repoRoot, 'packages/ai-memory/dist/tools/server.js'), 'hook:user-prompt-submit'],
        env,
        payload: malformed ? 'PRIVATE_INPUT{' : JSON.stringify({ hook_event_name: 'UserPromptSubmit' }),
      });
      assert.equal(result.status, 0, result.stderr);
      const envelope = JSON.parse(result.stdout) as { continue: boolean; systemMessage?: string };
      assert.equal(envelope.continue, true);
      assert.equal(result.stdout, JSON.stringify(envelope) + '\n');
      assert.ok(!(result.stdout + result.stderr).includes('PRIVATE_INPUT'));
      if (malformed) assert.equal(envelope.systemMessage, 'ai-memory: hook unavailable.');
    });
  });
}

test('closed hook writer fails open without leaking its error or retaining handles', async () => {
  await withHookPipeFixture(async ({ env }) => {
    const result = await runHookPipe({
      command: process.execPath,
      args: [join(repoRoot, 'packages/ai-memory/dist/tools/server.js'), 'hook:user-prompt-submit'],
      env: { ...env, SYNTHETIC_PIPE_MODE: 'error' },
      payload: '{}',
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes('PRIVATE_WRITER_FAILURE'));
  });
});

test('cancelling a hook under stdout backpressure drains the owned child', async () => {
  await withHookPipeFixture(async ({ env }) => {
    const result = await runHookPipe({
      command: process.execPath,
      args: [join(repoRoot, 'packages/ai-memory/dist/tools/server.js'), 'hook:user-prompt-submit'],
      env: { ...env, SYNTHETIC_PIPE_MODE: 'hold' },
      payload: '{}',
      cancel: true,
    });
    assert.ok(result.signal === 'SIGTERM' || result.status === 0);
    assert.throws(() => process.kill(-result.pid, 0), { code: 'ESRCH' });
  });
});
