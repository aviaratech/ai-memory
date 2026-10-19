import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const hooks = fileURLToPath(new URL('../../../../plugins/ai-memory/hooks/', import.meta.url));

for (const [name, command, event] of [
  ['user-prompt-submit', 'hook:user-prompt-submit', 'UserPromptSubmit'],
  ['pre-compact', 'hook:pre-compact', 'PreCompact'],
  ['memory-used', 'hook:memory-used', 'PostToolUse'],
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
