import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'vitest';

const hooks = fileURLToPath(new URL('../../../../plugins/ai-memory/hooks/', import.meta.url));

test('telemetry CLI rejects malformed input and its advisory hook emits one fixed envelope', () => {
  const server = fileURLToPath(new URL('../../dist/tools/server.js', import.meta.url));
  for (const [command, expected] of [
    ['hook:telemetry', { continue: true }],
    ['telemetry:ingest', { status: 'rejected', code: 'invalid_event' }],
  ] as const) {
    const result = spawnSync(process.execPath, [server, command], {
      input: 'PRIVATE_SENTINEL',
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
      timeout: 5000,
    });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), expected);
    assert.equal(result.stderr.includes('PRIVATE_SENTINEL'), false);
  }
});

test('telemetry input bounds fail open and never echo host content', () => {
  const server = fileURLToPath(new URL('../../dist/tools/server.js', import.meta.url));
  for (const [command, bytes, expected] of [
    ['telemetry:ingest', 16385, { status: 'rejected', code: 'oversized' }],
    ['hook:telemetry', 65537, { continue: true }],
  ] as const) {
    const result = spawnSync(process.execPath, [server, command], {
      input: 'x'.repeat(bytes),
      encoding: 'utf8',
      env: { PATH: process.env.PATH, CODEX: '1' },
      timeout: 5000,
    });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), expected);
    assert.equal(result.stderr, '');
  }
});

test('telemetry hook bounds a host that leaves stdin open', { timeout: 6000 }, async () => {
  const server = fileURLToPath(new URL('../../dist/tools/server.js', import.meta.url));
  const child = spawn(process.execPath, [server, 'hook:telemetry'], {
    env: { PATH: process.env.PATH },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (bytes: Buffer) => {
    stdout += bytes.toString();
  });
  child.stderr?.on('data', (bytes: Buffer) => {
    stderr += bytes.toString();
  });
  try {
    await once(child, 'close');
    assert.equal(child.exitCode, 0);
    assert.deepEqual(JSON.parse(stdout), { continue: true });
    assert.equal(stderr, '');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
});

test(
  'cancelling staged telemetry joins its owned child and suppresses successful private output',
  { timeout: 10000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-memory-telemetry-cancel-'));
    let child: ReturnType<typeof spawn> | undefined;
    try {
      mkdirSync(join(root, 'hooks'));
      mkdirSync(join(root, 'dist'));
      cpSync(join(hooks, 'telemetry'), join(root, 'hooks', 'telemetry'));
      chmodSync(join(root, 'hooks', 'telemetry'), 0o755);
      const pidFile = join(root, 'synthetic-child.pid');
      writeFileSync(
        join(root, 'dist', 'mcp-launcher.js'),
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); process.stdout.write('PRIVATE_SENTINEL');setInterval(()=>{},1000);`,
      );
      child = spawn(join(root, 'hooks', 'telemetry'), [], {
        env: { PATH: process.env.PATH },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
      child.stdin?.end('{}');
      const deadline = Date.now() + 5000;
      while (!existsSync(pidFile) && Date.now() < deadline) await delay(10);
      assert.ok(existsSync(pidFile), 'synthetic child did not become ready');
      const pid = Number(readFileSync(pidFile, 'utf8'));
      const closed = once(child, 'close');
      child.kill('SIGTERM');
      await closed;
      assert.equal(child.exitCode, 0);
      assert.deepEqual(JSON.parse(stdout), { continue: true });
      assert.equal(stderr, '');
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    } finally {
      if (child?.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close');
        child.kill('SIGTERM');
        await closed;
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);

for (const [name, command, event] of [
  ['user-prompt-submit', 'hook:user-prompt-submit', 'UserPromptSubmit'],
  ['pre-compact', 'hook:pre-compact', 'PreCompact'],
  ['memory-used', 'hook:memory-used', 'PostToolUse'],
  ['telemetry', 'hook:telemetry', 'Stop'],
] as const) {
  test(`staged ${name} forwards documented event to bundled owner and fails open without output leakage`, () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-memory-task-hook-'));
    try {
      mkdirSync(join(root, 'hooks'));
      mkdirSync(join(root, 'dist'));
      cpSync(join(hooks, name), join(root, 'hooks', name));
      chmodSync(join(root, 'hooks', name), 0o755);
      writeFileSync(
        join(root, 'dist', 'mcp-launcher.js'),
        `process.stdin.resume(); process.stdin.on('end', () => { if (process.argv[2] !== ${JSON.stringify(command)}) process.exit(1); process.stdout.write(JSON.stringify({continue:true})); });`,
      );
      const payload = JSON.stringify({ hook_event_name: event, session_id: 'synthetic-session' });
      const result = spawnSync(join(root, 'hooks', name), {
        input: payload,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, CLAUDE_PLUGIN_ROOT: root },
      });
      assert.equal(result.status, 0);
      assert.equal((JSON.parse(result.stdout) as { continue: boolean }).continue, true);
      writeFileSync(
        join(root, 'dist', 'mcp-launcher.js'),
        "process.stdout.write('private partial output');process.stderr.write('private error');process.exit(1);",
      );
      const failed = spawnSync(join(root, 'hooks', name), {
        input: payload,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, CLAUDE_PLUGIN_ROOT: root },
      });
      assert.equal(failed.status, 0);
      assert.equal((JSON.parse(failed.stdout) as { continue: boolean }).continue, true);
      assert.ok(!failed.stdout.includes('private'));
      assert.ok(!failed.stderr.includes('private'));
      if (name === 'telemetry') {
        writeFileSync(
          join(root, 'dist', 'mcp-launcher.js'),
          "process.stdout.write('private success');process.stderr.write('private success error');",
        );
        const success = spawnSync(join(root, 'hooks', name), {
          input: payload,
          encoding: 'utf8',
          env: { PATH: process.env.PATH },
        });
        assert.equal(success.status, 0);
        assert.deepEqual(JSON.parse(success.stdout), { continue: true });
        assert.equal(success.stderr, '');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('public manifest registers first-prompt, precompact, and only ai-memory get observation hooks', () => {
  const config = JSON.parse(readFileSync(join(hooks, 'hooks.json'), 'utf8')) as {
    hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
  };
  assert.ok(config.hooks.UserPromptSubmit?.length);
  assert.ok(config.hooks.PreCompact?.length);
  const matcher = config.hooks.PostToolUse?.[0]?.matcher;
  assert.ok(matcher);
  assert.ok(new RegExp(matcher).test('mcp__ai_memory__memory_get'));
  assert.ok(!new RegExp(matcher).test('mcp__other__memory_get'));
});
