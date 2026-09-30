import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = join(packageRoot, 'dist/tools/disaster-recovery.js');
const payload = 'synthetic disposable snapshot';

// Only the two former elapsed caps are compressed. The real child still has to
// finish, and cleanup/connection timers keep their production semantics.
const preload = `
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import timers from 'node:timers';
import { pathToFileURL } from 'node:url';
const setTimer = globalThis.setTimeout;
globalThis.setTimeout = timers.setTimeout = (fn, ms, ...args) => setTimer(fn,
  ms === Number(process.env.DR_FORMER_CAP) ? 1 : ms, ...args);
syncBuiltinESMExports();
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'pg') return { url: pathToFileURL(process.env.DR_FAKE_PG).href, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (/\\/(?:smoke-ingest|restore-smoke)\\.js$/.test(url))
      return { format: 'module', source: '', shortCircuit: true };
    return next(url, context);
  },
});
`;

const fakePg = `
import { appendFileSync, writeFileSync } from 'node:fs';
export default { Client: class {
  rejectQuery;
  keepAlive;
  async connect() {}
  async end() {
    appendFileSync(process.env.DR_SQL_LOG, JSON.stringify('CLIENT_END') + '\\n');
    clearInterval(this.keepAlive);
    this.rejectQuery?.(new Error('synthetic disconnect'));
  }
  async query(sql) {
    appendFileSync(process.env.DR_SQL_LOG, JSON.stringify(sql) + '\\n');
    if (process.env.DR_HOLD_QUERY && sql.includes('count(*)')) {
      writeFileSync(process.env.DR_QUERY_READY, 'ready');
      this.keepAlive = setInterval(() => {}, 1000);
      return await new Promise((resolve, reject) => { this.rejectQuery = reject; });
    }
    if (process.env.DR_HOLD_QUERY && sql.includes("c.relkind IN ('r', 'p')"))
      return { rows: [{ schema: 'public', name: 'synthetic_rows' }] };
    if (sql.includes('pg_database_size')) return { rows: [{ size: '1' }] };
    if (sql.includes('pg_export_snapshot')) return { rows: [{ snapshot: 'synthetic-snapshot' }] };
    if (sql === 'SHOW server_version_num') return { rows: [{ server_version_num: '180006' }] };
    if (sql.includes('ai_memory_pgmigrations')) return { rows: JSON.parse(process.env.DR_MIGRATIONS).map(name => ({ name })) };
    if (sql.includes('information_schema.columns')) return { rows: [{ value: false }] };
    return { rows: [], rowCount: 0 };
  }
} };
`;

const fakeAwsPreflight = `#!/usr/bin/env node
const fs = require('node:fs');
const { spawn } = require('node:child_process');
if (process.argv.includes('get-bucket-versioning')) {
  const wait = setInterval(() => {
    if (fs.readdirSync(process.env.DR_READY_DIR).length === 4) {
      clearInterval(wait);
      process.exit(8);
    }
  }, 10);
} else {
  process.on('SIGTERM', () => {});
  process.on('SIGINT', () => {});
  const descendant = spawn(process.execPath, ['-e',
    "process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  descendant.stdout.once('data', () => {
    fs.writeFileSync(process.env.DR_READY_DIR + '/' + process.pid, JSON.stringify([process.pid, descendant.pid]));
  });
  setInterval(() => {}, 1000);
}
`;

const fakeTool = `#!/usr/bin/env node
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');
const args = process.argv.slice(2);
const phase = args.includes('--version') ? 'version' : args.includes('--list') ? 'list'
  : path.basename(process.argv[1]) === 'pg_dump' ? 'dump' : 'restore';
fs.appendFileSync(process.env.DR_TOOL_LOG, JSON.stringify({ phase, args, connectTimeout: process.env.PGCONNECT_TIMEOUT }) + '\\n');
const complete = () => {
  if (phase === 'version') console.log('PostgreSQL 18.6');
  if (phase === 'dump') process.stdout.write('synthetic disposable snapshot');
};
if (phase === process.env.DR_HOLD_PHASE) {
  process.on('SIGTERM', () => {});
  process.on('SIGINT', () => {});
  const descendant = spawn(process.execPath, ['-e',
    "process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  descendant.stdout.once('data', () => {
    fs.writeFileSync(process.env.DR_PIDS, JSON.stringify([process.pid, descendant.pid]));
    if (process.env.DR_OVERFLOW) process.stdout.write('synthetic-private-marker'.repeat(100000));
    if (process.env.DR_FAIL_EXIT) process.exit(8);
  });
  setInterval(() => {}, 1000);
} else if (phase === process.env.DR_SLOW_PHASE) setTimeout(complete, 100);
else complete();
`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ai-memory-dr-process-'));
  chmodSync(root, 0o700);
  const backups = join(root, 'backups');
  const bin = join(root, 'bin');
  mkdirSync(backups, { mode: 0o700 });
  mkdirSync(bin);
  const key = randomBytes(32);
  const keyFile = join(root, 'key');
  writeFileSync(keyFile, key.toString('base64'), { mode: 0o600 });
  writeFileSync(join(root, 'preload.mjs'), preload);
  writeFileSync(join(root, 'pg.mjs'), fakePg);
  for (const tool of ['pg_dump', 'pg_restore']) writeFileSync(join(bin, tool), fakeTool, { mode: 0o700 });
  const migrations = readdirSync(join(packageRoot, 'migrations'))
    .filter(name => /^\d{3}_.+\.sql$/u.test(name))
    .sort();
  const hash = createHash('sha256');
  for (const name of migrations)
    hash
      .update(name)
      .update(Buffer.from([0]))
      .update(readFileSync(join(packageRoot, 'migrations', name)));
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
    NODE_OPTIONS: `--import=${join(root, 'preload.mjs')}`,
    AI_MEMORY_DATABASE_URL: 'postgresql://synthetic@127.0.0.1:5432/ai_memory_process',
    AI_MEMORY_BACKUP_DIR: backups,
    AI_MEMORY_BACKUP_KEY_FILE: keyFile,
    AI_MEMORY_BACKUP_SOURCE_ID: 'synthetic-source-001',
    AI_MEMORY_RESTORE_ADMIN_URL: 'postgresql://synthetic@127.0.0.1:5432/postgres',
    AI_MEMORY_RESTORE_TARGET_NAME: 'ai_memory_restore_process_001',
    AI_MEMORY_RESTORE_EXPECT_SOURCE_ID: 'synthetic-source-001',
    AI_MEMORY_RESTORE_EXPECT_DATABASE: 'ai_memory_process',
    DR_FAKE_PG: join(root, 'pg.mjs'),
    DR_SQL_LOG: join(root, 'sql.log'),
    DR_TOOL_LOG: join(root, 'tools.log'),
    DR_PIDS: join(root, 'pids.json'),
    DR_MIGRATIONS: JSON.stringify(migrations.map(name => name.slice(0, -4))),
  };
  return { root, backups, key, env, migrationDigest: hash.digest('hex') };
}

async function restoreFixture(current: ReturnType<typeof fixture>) {
  const backupId = randomUUID();
  const dumpPath = join(current.root, 'snapshot.dump');
  const archivePath = join(current.backups, `${backupId}.aimdr`);
  writeFileSync(dumpPath, payload);
  const { encryptArchive } = await import('./disaster-recovery.js');
  await encryptArchive(
    dumpPath,
    archivePath,
    {
      format: 1,
      backupId,
      sourceId: 'synthetic-source-001',
      databaseName: 'ai_memory_process',
      serverMajor: 18,
      extensions: [],
      migrations: JSON.parse(current.env.DR_MIGRATIONS ?? '[]') as string[],
      hasEmbeddingColumn: false,
      tableNames: [],
      rowCounts: {},
      sequenceNames: [],
      migrationCodeSha256: current.migrationDigest,
      dumpSha256: createHash('sha256').update(payload).digest('hex'),
      dumpBytes: Buffer.byteLength(payload),
    },
    current.key,
  );
  const archive = readFileSync(archivePath);
  const manifestPath = join(current.backups, `${backupId}.manifest.json`);
  writeFileSync(
    manifestPath,
    JSON.stringify({
      format: 1,
      backupId,
      createdAt: new Date().toISOString(),
      archiveSha256: createHash('sha256').update(archive).digest('hex'),
      archiveBytes: archive.length,
    }),
  );
  current.env.AI_MEMORY_RESTORE_MANIFEST_FILE = manifestPath;
}

test('backup subprocess completes beyond the former 30-minute cap', () => {
  const current = fixture();
  try {
    const result = spawnSync(process.execPath, [script, 'backup'], {
      encoding: 'utf8',
      env: { ...current.env, DR_FORMER_CAP: '1800000', DR_SLOW_PHASE: 'version' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"stage":"complete"/u);
    assert.ok(existsSync(join(current.backups, 'last-success.json')));
  } finally {
    rmSync(current.root, { recursive: true, force: true });
  }
});

test('atomic restore completes beyond the former one-hour cap', async () => {
  const current = fixture();
  try {
    await restoreFixture(current);
    const result = spawnSync(process.execPath, [script, 'restore'], {
      encoding: 'utf8',
      env: { ...current.env, DR_FORMER_CAP: '3600000', DR_SLOW_PHASE: 'restore' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /restore_verified/u);
    const tools = readFileSync(current.env.DR_TOOL_LOG ?? '', 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { phase: string; args: string[]; connectTimeout?: string });
    const restore = tools.find(tool => tool.phase === 'restore');
    assert.ok(restore);
    assert.ok(restore.args.includes('--single-transaction'));
    assert.ok(restore.args.includes('--exit-on-error'));
    assert.equal(restore.connectTimeout, '20');
    assert.doesNotMatch(readFileSync(current.env.DR_SQL_LOG ?? '', 'utf8'), /DROP DATABASE/u);
  } finally {
    rmSync(current.root, { recursive: true, force: true });
  }
});

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    assert.ok(error instanceof Error && 'code' in error && error.code === 'ESRCH');
    return false;
  }
}

function observe(child: ReturnType<typeof spawn>) {
  let stdout = '',
    stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.once('close', () => {
      resolve();
    });
    child.once('error', reject);
  });
  return { closed, output: () => ({ stdout, stderr }) };
}

async function waitUntil(predicate: () => boolean, timeout: number, message: string) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await delay(10);
  assert.ok(predicate(), message);
}

for (const [command, signal] of [
  ['backup', 'SIGINT'],
  ['restore', 'SIGTERM'],
] as const) {
  test(`${signal} disconnects a blocked ${command} verification query`, { timeout: 10_000 }, async () => {
    const current = fixture();
    let child: ReturnType<typeof spawn> | undefined;
    let observed: ReturnType<typeof observe> | undefined;
    try {
      if (command === 'restore') await restoreFixture(current);
      const ready = join(current.root, 'query-ready');
      child = spawn(process.execPath, [script, command], {
        env: { ...current.env, DR_HOLD_QUERY: '1', DR_QUERY_READY: ready },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      observed = observe(child);
      await waitUntil(() => existsSync(ready), 5_000, 'query never became active');
      child.kill(signal);
      await waitUntil(() => child?.exitCode !== null, 2_000, 'cancelled query kept CLI alive');
      await observed.closed;
      assert.equal(child.exitCode, signal === 'SIGINT' ? 130 : 143);
      assert.match(observed.output().stderr, /COMMAND_CANCELLED/u);
      const sql = readFileSync(current.env.DR_SQL_LOG ?? '', 'utf8');
      assert.match(sql, /count\(\*\)/u);
      assert.ok(sql.trimEnd().endsWith('"CLIENT_END"'));
      assert.doesNotMatch(sql, /ROLLBACK|DROP DATABASE/u);
      assert.ok(readdirSync(current.backups).every(name => !/^\.(backup|restore)-/u.test(name)));
      assert.doesNotMatch(observed.output().stdout, /restore_verified|"stage":"complete"/u);
      if (command === 'restore') assert.match(observed.output().stdout, /restore_target_preserved_for_inspection/u);
      else
        assert.equal(
          (JSON.parse(readFileSync(join(current.backups, 'last-attempt.json'), 'utf8')) as { reason: string }).reason,
          'COMMAND_CANCELLED',
        );
    } finally {
      child?.kill('SIGKILL');
      await observed?.closed;
      rmSync(current.root, { recursive: true, force: true });
    }
  });
}

test('failed parallel S3 preflight closes resistant siblings and preserves peers', { timeout: 15_000 }, async () => {
  const current = fixture();
  const ready = join(current.root, 'ready');
  mkdirSync(ready);
  writeFileSync(join(current.root, 'bin', 'aws'), fakeAwsPreflight, { mode: 0o700 });
  const peer = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const peerObserved = observe(peer);
  let child: ReturnType<typeof spawn> | undefined;
  let observed: ReturnType<typeof observe> | undefined;
  let owned: number[] = [];
  try {
    child = spawn(process.execPath, [script, 'backup'], {
      env: { ...current.env, DR_READY_DIR: ready, AI_MEMORY_S3_BUCKET: 'synthetic-bucket' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    observed = observe(child);
    await waitUntil(() => readdirSync(ready).length === 4, 5_000, 'parallel siblings never became active');
    owned = readdirSync(ready).flatMap(name => JSON.parse(readFileSync(join(ready, name), 'utf8')) as number[]);
    await waitUntil(() => child?.exitCode !== null, 7_000, 'failed preflight kept siblings alive');
    await observed.closed;
    assert.equal(child.exitCode, 1);
    assert.match(observed.output().stderr, /S3_PREFLIGHT_FAILED/u);
    await waitUntil(() => owned.every(pid => !alive(pid)), 1_000, 'preflight descendants remained alive');
    assert.ok(peer.pid !== undefined && alive(peer.pid));
    assert.doesNotMatch(observed.output().stdout, /"stage":"complete"/u);
    assert.ok(!existsSync(join(current.backups, 'last-success.json')));
  } finally {
    child?.kill('SIGKILL');
    await observed?.closed;
    // Also recover identities if a readiness assertion failed partway through.
    owned = readdirSync(ready).flatMap(name => JSON.parse(readFileSync(join(ready, name), 'utf8')) as number[]);
    for (const pid of owned) if (alive(pid)) process.kill(pid, 'SIGKILL');
    peer.kill('SIGKILL');
    await peerObserved.closed;
    rmSync(current.root, { recursive: true, force: true });
  }
});

for (const [phase, stop] of [
  ['version', 'SIGINT'],
  ['list', 'SIGTERM'],
  ['dump', 'SIGTERM'],
  ['restore', 'SIGTERM'],
  ['version', 'overflow'],
  ['version', 'failure'],
] as const) {
  test(`${stop} closes resistant ${phase} process tree and preserves peers`, { timeout: 20_000 }, async () => {
    const current = fixture();
    const peer = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    const peerClosed = new Promise<void>(resolve => {
      peer.once('close', () => {
        resolve();
      });
    });
    let child: ReturnType<typeof spawn> | undefined;
    let owned: number[] = [];
    try {
      if (phase === 'list' || phase === 'restore') await restoreFixture(current);
      child = spawn(process.execPath, [script, phase === 'list' || phase === 'restore' ? 'restore' : 'backup'], {
        env: {
          ...current.env,
          DR_HOLD_PHASE: phase,
          ...(stop === 'overflow' ? { DR_OVERFLOW: '1' } : {}),
          ...(stop === 'failure' ? { DR_FAIL_EXIT: '1' } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '',
        stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const closed = new Promise<void>((resolve, reject) => {
        child?.once('close', () => {
          resolve();
        });
        child?.once('error', reject);
      });
      const deadline = Date.now() + 5_000;
      while (!existsSync(current.env.DR_PIDS ?? '') && Date.now() < deadline) await delay(10);
      assert.ok(existsSync(current.env.DR_PIDS ?? ''), stderr);
      owned = JSON.parse(readFileSync(current.env.DR_PIDS ?? '', 'utf8')) as number[];
      if (stop === 'SIGINT' || stop === 'SIGTERM') child.kill(stop);
      await closed;
      assert.match(stderr, stop === 'SIGINT' || stop === 'SIGTERM' ? /COMMAND_CANCELLED/u : /PG_TOOL_UNAVAILABLE/u);
      assert.equal(child.exitCode, stop === 'SIGINT' ? 130 : stop === 'SIGTERM' ? 143 : 1);
      const reaped = Date.now() + 1_000;
      while (owned.some(alive) && Date.now() < reaped) await delay(10);
      assert.ok(owned.every(pid => !alive(pid)));
      assert.ok(peer.pid !== undefined && alive(peer.pid));
      assert.ok(
        readdirSync(current.backups).every(name => !name.startsWith('.backup-') && !name.startsWith('.restore-')),
      );
      if (phase === 'restore') assert.match(stdout, /restore_target_preserved_for_inspection/u);
      else assert.doesNotMatch(stdout, /restore_verified|"stage":"complete"/u);
      assert.doesNotMatch(stderr, /private-password|synthetic-private-marker/u);
    } finally {
      child?.kill('SIGKILL');
      for (const pid of owned) if (alive(pid)) process.kill(pid, 'SIGKILL');
      peer.kill('SIGKILL');
      await peerClosed;
      rmSync(current.root, { recursive: true, force: true });
    }
  });
}
