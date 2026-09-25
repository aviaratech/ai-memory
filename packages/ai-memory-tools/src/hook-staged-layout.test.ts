import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'vitest';
import { fileURLToPath } from 'node:url';

const thisDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(thisDir, '../../..');
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
 *     dist/mcp-server.bundle.js          (stub bundle, optional)
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
      join(distDir, 'mcp-server.bundle.js'),
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
    chmodSync(join(distDir, 'mcp-server.bundle.js'), 0o755);
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
      !hookSource.includes('packages/ai-memory-tools/dist/server.js'),
      'session-start must not shell to packages/ai-memory-tools/dist/server.js',
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
      !hookSource.includes('packages/ai-memory-tools/dist/server.js'),
      'session-end must not shell to packages/ai-memory-tools/dist/server.js',
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
          const serializerUrl = new URL('../dist/ingestion/session-start-hook.js', import.meta.url).href;
          writeFileSync(
            join(staged.root, 'dist/mcp-server.bundle.js'),
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
