import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { it } from 'vitest';

import { getPackageVersion } from '../version.js';

const cli = join(dirname(fileURLToPath(import.meta.url)), '../../dist/tools/pluginCli.js');

it('preserves host provenance and the existing agent-writer gate through the protected launcher', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-memory-plugin-provenance-'));
  try {
    const root = join(home, 'plugin/dist');
    mkdirSync(root, { recursive: true });
    mkdirSync(join(home, '.config/ai-memory'), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(home, '.config/ai-memory/plugin.env'),
      'AI_MEMORY_DATABASE_URL=postgresql://runtime:fixture@127.0.0.1/ai_memory\nAI_MEMORY_CLASSIFY_API_KEY=fixture-only\nAI_MEMORY_CLASSIFY_MODEL=fixture-model\n',
      { mode: 0o600 },
    );
    writeFileSync(
      join(root, 'mcp-launcher.js'),
      readFileSync(join(dirname(cli), '../../plugins/ai-memory/dist/mcp-launcher.js')),
    );
    const server = pathToFileURL(join(dirname(cli), 'server.js')).href;
    writeFileSync(
      join(root, 'mcp-server.bundle.js'),
      `import {detectAgentContext,memoryFlushInputSchema,mergeDetectedDefaults} from ${JSON.stringify(server)}; const context=detectAgentContext();console.log(JSON.stringify({context, accepted:memoryFlushInputSchema.safeParse(mergeDetectedDefaults({summary:'fixture'},context)).success,classify:process.env.AI_MEMORY_CLASSIFY_API_KEY,model:process.env.AI_MEMORY_CLASSIFY_MODEL}));`,
    );
    const result = spawnSync(process.execPath, [join(root, 'mcp-launcher.js')], {
      env: { HOME: home, CLAUDECODE: '1', CLAUDE_MODEL: 'fixture-host-model' },
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout) as {
      context: { agent: string; source: string; model: string };
      accepted: boolean;
      classify: string;
      model: string;
    };
    assert.deepEqual(value.context, { agent: 'claude-code', source: 'claude-code', model: 'fixture-host-model' });
    assert.equal(value.accepted, false);
    assert.equal(value.classify, 'fixture-only');
    assert.equal(value.model, 'fixture-model');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'native fixture failed to reach its expected unit');
    await delay(25);
  }
}
const native = `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
if (process.argv.includes('--help')) { console.log('marketplace add remove list'); }
else {
  process.on('SIGTERM', () => {});
  const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"], {stdio:['ignore','pipe','inherit']});
  descendant.stdout.once('data', () => {
    writeFileSync(process.env.PLUGIN_TEST_PIDS, JSON.stringify([process.pid, descendant.pid]));
    if (process.env.PLUGIN_TEST_EXIT === '1') process.exit(8);
  });
  setInterval(()=>{},1000);
}
`;

it('serializes two stale-lock reclaimers and preserves the new live owner', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-memory-plugin-reclaim-'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const binding = JSON.stringify({ host: 'codex', scope: 'user', cwd: null, home, nativeHome: join(home, 'codex') });
  const root = join(home, '.config/ai-memory/plugins', createHash('sha256').update(binding).digest('hex'));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = join(root, 'operation.lock');
  writeFileSync(lock, JSON.stringify({ schema: 1, binding, token: 'stale', pid: 2147483647, groups: [] }), {
    mode: 0o600,
  });
  writeFileSync(join(bin, 'codex'), native, { mode: 0o700 });
  const ready = join(home, 'verified');
  const release = join(home, 'release');
  const pidsPath = join(home, 'pids.json');
  const preload = join(home, 'pause.mjs');
  writeFileSync(
    preload,
    `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const remove=fs.rmSync;let paused=false;fs.rmSync=(path,...args)=>{if(!paused&&String(path).endsWith('/operation.lock')){paused=true;fs.writeFileSync(${JSON.stringify(ready)},'ready');while(!fs.existsSync(${JSON.stringify(release)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}return remove(path,...args);};syncBuiltinESMExports();`,
  );
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    CODEX_HOME: join(home, 'codex'),
    PATH: `${bin}:${dirname(process.execPath)}`,
    NODE_OPTIONS: '--max-old-space-size=512',
    PLUGIN_TEST_PIDS: pidsPath,
  };
  const args = [
    cli,
    'plugin',
    'install',
    '--host',
    'codex',
    '--scope',
    'user',
    '--version',
    getPackageVersion(),
    '--json',
  ];
  const first = spawn(process.execPath, ['--import', preload, ...args], { cwd: home, env, stdio: 'ignore' });
  const firstClosed = new Promise(resolve => first.once('close', resolve));
  let second: ReturnType<typeof spawn> | undefined;
  let secondClosed: Promise<unknown> | undefined;
  let pids: number[] = [];
  try {
    await until(() => existsSync(ready));
    second = spawn(process.execPath, args, { cwd: home, env, stdio: 'ignore' });
    secondClosed = new Promise(resolve => second?.once('close', resolve));
    assert.equal(
      await Promise.race([secondClosed, delay(2000).then(() => 999)]),
      2,
      'another reclaimer entered the mutation instead of preserving exclusive ownership',
    );
    assert.equal((JSON.parse(readFileSync(lock, 'utf8')) as { token: string }).token, 'stale');
    assert.equal(existsSync(pidsPath), false);
    writeFileSync(release, 'continue');
    await until(() => existsSync(pidsPath));
    pids = JSON.parse(readFileSync(pidsPath, 'utf8')) as number[];
    assert.equal((JSON.parse(readFileSync(lock, 'utf8')) as { pid: number }).pid, first.pid);
    first.kill('SIGTERM');
    assert.equal(await firstClosed, 2);
    await until(() => pids.every(pid => !alive(pid)));
  } finally {
    if (existsSync(pidsPath)) pids = JSON.parse(readFileSync(pidsPath, 'utf8')) as number[];
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
    if (first.exitCode === null) first.kill('SIGKILL');
    if (second?.exitCode === null) second.kill('SIGKILL');
    await firstClosed;
    if (secondClosed) await secondClosed;
    rmSync(home, { recursive: true, force: true });
  }
}, 15000);

for (const leaderExit of [false, true]) {
  it(`joins resistant native descendants after ${leaderExit ? 'leader failure' : 'cancellation'} and recovers the pending unit`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'ai-memory-plugin-process-'));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'codex'), native, { mode: 0o700 });
    const pidsPath = join(home, 'pids.json');
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      CODEX_HOME: join(home, 'codex'),
      PATH: `${bin}:${dirname(process.execPath)}`,
      NODE_OPTIONS: '--max-old-space-size=512',
      PLUGIN_TEST_PIDS: pidsPath,
      PLUGIN_TEST_EXIT: leaderExit ? '1' : '0',
    };
    const child = spawn(
      process.execPath,
      [cli, 'plugin', 'install', '--host', 'codex', '--scope', 'user', '--version', getPackageVersion(), '--json'],
      { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    let bytes = 0;
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (data: Buffer) => {
        bytes += data.length;
        if (bytes > 1024 * 1024) child.kill('SIGKILL');
      });
    child.stdout.on('data', (data: Buffer) => {
      if (bytes <= 1024 * 1024) output += data.toString();
    });
    const closed = new Promise<number | null>(resolve => child.once('close', resolve));
    let pids: number[] = [];
    try {
      await until(() => existsSync(pidsPath));
      pids = JSON.parse(readFileSync(pidsPath, 'utf8')) as number[];
      if (!leaderExit) child.kill('SIGTERM');
      assert.equal(await closed, 2);
      await until(() => pids.every(pid => !alive(pid)) && !alive(-(pids[0] ?? 0)));
      assert.equal((JSON.parse(output) as { state: string }).state, 'pending_recovery');
      const roots = join(home, '.config/ai-memory/plugins');
      const root = join(roots, readdirSync(roots)[0] ?? 'missing');
      if (existsSync(join(root, 'operation.lock'))) {
        const lock = JSON.parse(readFileSync(join(root, 'operation.lock'), 'utf8')) as {
          pid: number;
          groups: number[];
        };
        assert.equal(lock.pid, child.pid);
        assert.ok(lock.groups.every(pid => !alive(-pid)));
      }
      const recovered = spawn(
        process.execPath,
        [cli, 'plugin', 'rollback', '--host', 'codex', '--scope', 'user', '--json'],
        { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let result = '';
      recovered.stdout.on('data', (data: Buffer) => {
        result += data.toString();
      });
      assert.equal(await new Promise(resolve => recovered.once('close', resolve)), 0);
      assert.equal((JSON.parse(result) as { state: string }).state, 'removed');
      assert.equal(existsSync(join(root, 'operation.lock')), false);
    } finally {
      for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
      if (child.exitCode === null) child.kill('SIGKILL');
      await closed;
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);
}

it('the protected launcher runs its server in the host-owned process and strips diagnostic providers', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-memory-plugin-launcher-'));
  try {
    const root = join(home, 'plugin/dist');
    mkdirSync(root, { recursive: true });
    mkdirSync(join(home, '.config/ai-memory'), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(home, '.config/ai-memory/plugin.env'),
      'AI_MEMORY_DATABASE_URL=postgresql://runtime:fixture@127.0.0.1/ai_memory\nAI_MEMORY_CLASSIFY_API_KEY=fixture-only\nAI_MEMORY_EMBEDDING_API_KEY=fixture-only\n',
      { mode: 0o600 },
    );
    const built = join(dirname(cli), '../../plugins/ai-memory/dist/mcp-launcher.js');
    writeFileSync(join(root, 'mcp-launcher.js'), readFileSync(built));
    writeFileSync(
      join(root, 'mcp-server.bundle.js'),
      'console.log(JSON.stringify({pid:process.pid, classify:process.env.AI_MEMORY_CLASSIFY_API_KEY,embedding:process.env.AI_MEMORY_EMBEDDING_API_KEY, mode:process.env.AI_MEMORY_PLUGIN_MIGRATIONS_MODE}));',
    );
    const child = spawnSync(process.execPath, [join(root, 'mcp-launcher.js')], {
      env: {
        HOME: home,
        AI_MEMORY_PLUGIN_DOCTOR: '1',
        AI_MEMORY_DATABASE_URL:
          'postgresql://runtime:fixture@127.0.0.1/ai_memory?options=-c%20default_transaction_read_only%3Don',
      },
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    });
    assert.equal(child.status, 0);
    const result = JSON.parse(child.stdout) as { pid: number; classify?: string; embedding?: string; mode: string };
    assert.equal(result.pid, child.pid);
    assert.equal(result.classify, undefined);
    assert.equal(result.embedding, undefined);
    assert.equal(result.mode, 'require_complete');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
