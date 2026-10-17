import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, vi } from 'vitest';
import { promises as fileFs, lstatSync } from 'node:fs';
import type { acquireBackupOwnership } from './disaster-recovery.js';
type OwnershipModule = { acquireBackupOwnership: typeof acquireBackupOwnership };

const packageRoot = process.env.AI_MEMORY_DR_PACKAGE_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = join(packageRoot, 'dist', 'tools', 'disaster-recovery.js');
const moduleUrl = pathToFileURL(script).href;
const ownerName = '.backup-owner.json';
const gateName = '.backup-reclaim.json';

async function fixture(run: (root: string, dir: string, module: OwnershipModule) => Promise<void>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ai-memory-owner-test-')));
  chmodSync(root, 0o700);
  const dir = join(root, 'backups');
  mkdirSync(dir, { mode: 0o700 });
  try {
    await run(root, dir, (await import(moduleUrl)) as OwnershipModule);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function stoppedOwner(dir: string, phase: string) {
  const probe = `
    import { readFile, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    const { acquireBackupOwnership } = await import(process.env.DR_MODULE);
    const owner = await acquireBackupOwnership(process.env.DR_DIR);
    if (process.env.DR_PHASE !== 'pre-work') await owner.beginWork();
    if (process.env.DR_PHASE === 'quiescent') {
      const file = join(process.env.DR_DIR, '.backup-owner.json');
      const value = JSON.parse(await readFile(file, 'utf8'));
      value.phase = 'quiescent';
      await writeFile(file, JSON.stringify(value) + '\\n');
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    encoding: 'utf8',
    env: { ...process.env, DR_MODULE: moduleUrl, DR_DIR: dir, DR_PHASE: phase },
  });
  assert.equal(result.status, 0, result.stderr);
}

test('ownership excludes the same directory while independent directories remain usable', async () => {
  await fixture(async (root, dir, module) => {
    const owner = await module.acquireBackupOwnership(dir);
    await owner.beginWork();
    const bytes = readFileSync(join(dir, ownerName));
    await assert.rejects(module.acquireBackupOwnership(dir), /BACKUP_BUSY/u);
    assert.deepEqual(readFileSync(join(dir, ownerName)), bytes);
    const otherDir = join(root, 'other');
    mkdirSync(otherDir, { mode: 0o700 });
    const other = await module.acquireBackupOwnership(otherDir);
    await other.release(true);
    await owner.release(true);
    assert.equal(existsSync(join(dir, ownerName)), false);
    assert.equal(existsSync(join(otherDir, ownerName)), false);
    assert.equal(existsSync(join(dir, gateName)), false);
  });
});

test.each(['pre-work', 'quiescent'])(
  'verified stopped %s ownership is reclaimed without changing recovery bytes',
  async phase => {
    await fixture(async (_root, dir, module) => {
      stoppedOwner(dir, phase);
      const checkpoint = Buffer.from('compatible synthetic pending checkpoint');
      writeFileSync(join(dir, 'pending.json'), checkpoint);
      const prior = readFileSync(join(dir, ownerName));
      const owner = await module.acquireBackupOwnership(dir);
      assert.notDeepEqual(readFileSync(join(dir, ownerName)), prior);
      assert.deepEqual(readFileSync(join(dir, 'pending.json')), checkpoint);
      await owner.release(true);
    });
  },
);

test('an active stopped owner and unconfirmed resource drain fail closed', async () => {
  await fixture(async (_root, dir, module) => {
    stoppedOwner(dir, 'active');
    const before = readFileSync(join(dir, ownerName));
    await assert.rejects(module.acquireBackupOwnership(dir), /BACKUP_OWNER_UNCERTAIN/u);
    assert.deepEqual(readFileSync(join(dir, ownerName)), before);
    rmSync(join(dir, ownerName));
    const owner = await module.acquireBackupOwnership(dir);
    await owner.beginWork();
    await assert.rejects(owner.release(false), /BACKUP_OWNER_UNCERTAIN/u);
    assert.equal(existsSync(join(dir, ownerName)), true);
  });
});

test.each(['reused-birth', 'foreign-host', 'malformed', 'schema', 'permissions', 'hard-link', 'symlink', 'reclaim'])(
  'uncertain %s state never removes peer ownership',
  async kind => {
    await fixture(async (root, dir, module) => {
      const owner = await module.acquireBackupOwnership(dir);
      const path = join(dir, ownerName);
      const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      if (kind === 'reused-birth') {
        record.birth = 'different process birth';
        writeFileSync(path, JSON.stringify(record));
      }
      if (kind === 'foreign-host') {
        record.host = 'foreign-synthetic-host';
        writeFileSync(path, JSON.stringify(record));
      }
      if (kind === 'schema') {
        record.schema = 999;
        writeFileSync(path, JSON.stringify(record));
      }
      if (kind === 'malformed') writeFileSync(path, 'incomplete');
      if (kind === 'permissions') chmodSync(path, 0o644);
      if (kind === 'hard-link') linkSync(path, join(root, 'peer-link'));
      if (kind === 'symlink') {
        renameSync(path, join(root, 'peer-owner'));
        symlinkSync(join(root, 'peer-owner'), path);
      }
      if (kind === 'reclaim') writeFileSync(join(dir, gateName), 'interrupted gate', { mode: 0o600 });
      const before = readFileSync(path);
      await assert.rejects(module.acquireBackupOwnership(dir), /BACKUP_(?:BUSY|OWNER_UNCERTAIN)/u);
      assert.deepEqual(readFileSync(path), before);
      if (kind === 'reclaim') assert.equal(readFileSync(join(dir, gateName), 'utf8'), 'interrupted gate');
      if (kind === 'permissions') chmodSync(path, 0o600);
      // This fixture owns every file; a failed acquisition has no release capability.
      void owner;
    });
  },
);

test.each(['nonce', 'inode', 'directory'])('release preserves a replaced peer %s', async kind => {
  await fixture(async (root, dir, module) => {
    const owner = await module.acquireBackupOwnership(dir);
    const path = join(dir, ownerName);
    const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (kind === 'directory') {
      renameSync(dir, join(root, 'original'));
      mkdirSync(dir, { mode: 0o700 });
    } else if (kind === 'inode') renameSync(path, join(root, 'original-owner'));
    record.token = randomUUID();
    writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
    const peer = readFileSync(path);
    await assert.rejects(owner.release(true), /BACKUP_OWNER_UNCERTAIN/u);
    assert.deepEqual(readFileSync(path), peer);
  });
});

test.each(['begin', 'release'] as const)(
  'the verified owner tolerates a transient gate collision during %s',
  async transition => {
    await fixture(async (_root, dir, module) => {
      const owner = await module.acquireBackupOwnership(dir);
      if (transition === 'release') await owner.beginWork();
      const gate = join(dir, gateName);
      writeFileSync(gate, 'a contender owns this short gate', { mode: 0o600 });
      let collided = () => {};
      let resume = () => {};
      const collision = new Promise<void>(resolve => {
        collided = resolve;
      });
      const proceed = new Promise<void>(resolve => {
        resume = resolve;
      });
      const nativeOpen = fileFs.open.bind(fileFs);
      let intercepted = false;
      const spy = vi.spyOn(fileFs, 'open').mockImplementation(async (...args: Parameters<typeof fileFs.open>) => {
        try {
          return await nativeOpen(...args);
        } catch (error) {
          if (args[0] === gate && (error as NodeJS.ErrnoException).code === 'EEXIST' && !intercepted) {
            intercepted = true;
            collided();
            await proceed;
          }
          throw error;
        }
      });
      try {
        const result = (transition === 'begin' ? owner.beginWork() : owner.release(true)).then(
          () => null,
          (error: unknown) => error,
        );
        await collision;
        // Release the real contender's gate after the owner's exclusive create has
        // already failed. The owner must retry, not abandon its own valid lock.
        rmSync(gate);
        resume();
        assert.equal(await result, null);
        if (transition === 'begin') await owner.release(true);
        assert.equal(existsSync(join(dir, ownerName)), false);
      } finally {
        resume();
        spy.mockRestore();
      }
    });
  },
);

test('unsafe FIFO ownership refuses within the acquisition budget and preserves the FIFO', async () => {
  await fixture(async (_root, dir) => {
    const path = join(dir, ownerName);
    const made = spawnSync('/usr/bin/mkfifo', ['-m', '600', path], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    const before = lstatSync(path);
    const result = spawnSync(process.execPath, [script, 'backup'], {
      encoding: 'utf8',
      timeout: 2000,
      killSignal: 'SIGKILL',
      env: {
        ...process.env,
        AI_MEMORY_BACKUP_DIR: dir,
        AI_MEMORY_BACKUP_DATABASE_URL_FILE: undefined,
        AI_MEMORY_DATABASE_URL: 'postgresql://synthetic@127.0.0.1:5432/ai_memory_synthetic',
      },
    });
    assert.equal(result.error, undefined, 'ownership acquisition did not complete within its bounded request');
    assert.match(result.stderr, /BACKUP_OWNER_UNCERTAIN/u);
    const after = lstatSync(path);
    assert.equal(after.isFIFO(), true);
    assert.equal(after.ino, before.ino);
    assert.equal(existsSync(join(dir, gateName)), false);
    assert.equal(existsSync(join(dir, 'last-attempt.json')), false);
  });
});

test('an interrupted gate has a bounded owner transition refusal and remains untouched', async () => {
  await fixture(async (_root, dir, module) => {
    const owner = await module.acquireBackupOwnership(dir);
    await owner.beginWork();
    const path = join(dir, ownerName);
    const before = readFileSync(path);
    const gate = join(dir, gateName);
    writeFileSync(gate, 'interrupted owner gate', { mode: 0o600 });
    await assert.rejects(owner.release(true), /BACKUP_OWNER_UNCERTAIN/u);
    assert.deepEqual(readFileSync(path), before);
    assert.equal(readFileSync(gate, 'utf8'), 'interrupted owner gate');
  });
});
