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
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = process.env.AI_MEMORY_DR_PACKAGE_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = join(packageRoot, 'dist', 'tools', 'disaster-recovery.js');
const migrations = join(packageRoot, 'migrations');

function sha(value: Buffer | string) {
  return createHash('sha256').update(value).digest('hex');
}

function codeDigest() {
  const hash = createHash('sha256');
  for (const name of readdirSync(migrations)
    .filter(name => /^\d{3}_.+\.sql$/u.test(name))
    .sort()) {
    hash
      .update(name)
      .update(Buffer.from([0]))
      .update(readFileSync(join(migrations, name)));
  }
  return hash.digest('hex');
}

const fakeAws = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const root = process.env.FAKE_S3_ROOT;
const op = args[2];
const value = flag => args[args.indexOf(flag) + 1];
const output = value => process.stdout.write(JSON.stringify(value) + '\\n');
const objectPath = key => path.join(root, key);
fs.appendFileSync(process.env.FAKE_AWS_LOG, op + '\\n');
if (op === 'get-bucket-versioning' && process.env.FAKE_BARRIER_READY) {
  fs.writeFileSync(process.env.FAKE_BARRIER_READY, 'entered');
  while (!fs.existsSync(process.env.FAKE_BARRIER_RELEASE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
if (args[1] === 's3' && op === 'cp') {
  const source = args[3];
  const destination = args[4];
  const key = destination.replace(/^s3:\\/\\/synthetic-bucket\\//, '');
  if (key.endsWith('/archive.aimdr') && !fs.existsSync(process.env.FAKE_FAIL_ONCE)) {
    fs.writeFileSync(process.env.FAKE_FAIL_ONCE, 'failed once');
    if (process.env.FAKE_INTERRUPT === 'cancellation') {
      process.on('SIGTERM', () => {});
      process.kill(process.ppid, 'SIGTERM');
      setInterval(() => {}, 1000);
      return;
    }
    process.stderr.write('synthetic-private-marker: interrupted upload\\n');
    process.exit(8);
  }
  fs.mkdirSync(path.dirname(objectPath(key)), { recursive: true });
  fs.copyFileSync(source, objectPath(key));
  process.exit(0);
}
if (op === 'get-bucket-versioning') output({ Status: 'Enabled' });
else if (op === 'get-object-lock-configuration') output({ ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled', Rule: { DefaultRetention: { Mode: process.env.FAKE_RETENTION_MODE || 'COMPLIANCE', Days: 30 } } } });
else if (op === 'get-public-access-block') output({ PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } });
else if (op === 'get-bucket-encryption') output({ ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] } });
else if (op === 'get-bucket-policy-status') output({ PolicyStatus: { IsPublic: false } });
else if (op === 'head-object') {
  const file = objectPath(value('--key'));
  if (!fs.existsSync(file)) process.exit(9);
  output({ VersionId: 'version1', ContentLength: fs.statSync(file).size, ObjectLockMode: 'COMPLIANCE',
    ObjectLockRetainUntilDate: new Date(Date.now() + 31 * 86400_000).toISOString(), ServerSideEncryption: 'AES256' });
}
else if (op === 'get-object') {
  fs.copyFileSync(objectPath(value('--key')), args[args.indexOf('--version-id') + 2]);
  output({ VersionId: 'version1' });
}
else if (op === 'delete-object') { process.stderr.write('AccessDenied\\n'); process.exit(13); }
else process.exit(2);
`;

function pendingFixture(root: string, interruption = 'failure', recoveryScript = script) {
  const backups = join(root, 'backups');
  const bin = join(root, 'bin');
  const remote = join(root, 'remote');
  mkdirSync(backups, { mode: 0o700 });
  mkdirSync(bin);
  mkdirSync(remote);
  const aws = join(bin, 'aws');
  writeFileSync(aws, fakeAws, { mode: 0o700 });
  const pgDump = join(bin, 'pg_dump');
  writeFileSync(pgDump, '#!/bin/sh\necho "pg_dump (PostgreSQL) 17.0"\n', { mode: 0o700 });
  const key = randomBytes(32);
  const keyFile = join(root, 'key');
  writeFileSync(keyFile, `${key.toString('base64')}\n`, { mode: 0o600 });
  const dump = join(root, 'synthetic.dump');
  writeFileSync(dump, 'synthetic disposable database archive');
  const backupId = randomUUID();
  const archive = join(backups, `${backupId}.aimdr`);
  const createdAt = new Date().toISOString();
  const metadata = {
    format: 1,
    backupId,
    sourceId: 'synthetic-source-001',
    createdAt,
    databaseName: 'ai_memory_dr_source',
    sourceTargetSha256: sha('postgresql://synthetic@127.0.0.1:5432/ai_memory_dr_source'),
    migrationCodeSha256: codeDigest(),
    dumpSha256: sha(readFileSync(dump)),
    dumpBytes: statSync(dump).size,
  };
  const seal = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'const {encryptArchive}=await import(process.env.DR_MODULE); await encryptArchive(process.env.DR_DUMP,process.env.DR_ARCHIVE,JSON.parse(process.env.DR_METADATA),Buffer.from(process.env.DR_KEY,"base64"));',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        DR_MODULE: pathToFileURL(recoveryScript).href,
        DR_DUMP: dump,
        DR_ARCHIVE: archive,
        DR_METADATA: JSON.stringify(metadata),
        DR_KEY: key.toString('base64'),
      },
    },
  );
  assert.equal(seal.status, 0, seal.stderr);
  const manifest = {
    format: 1,
    backupId,
    createdAt,
    archiveSha256: sha(readFileSync(archive)),
    archiveBytes: statSync(archive).size,
  };
  writeFileSync(
    join(backups, 'pending.json'),
    JSON.stringify({
      manifest,
      bucket: 'synthetic-bucket',
      prefix: 'synthetic',
      sourceIdSha256: sha('synthetic-source-001'),
      keySha256: sha(key),
      sourceTargetSha256: metadata.sourceTargetSha256,
      migrationCodeSha256: metadata.migrationCodeSha256,
      scriptSha256: sha(readFileSync(recoveryScript)),
    }),
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    AI_MEMORY_BACKUP_DIR: backups,
    AI_MEMORY_BACKUP_KEY_FILE: keyFile,
    AI_MEMORY_BACKUP_SOURCE_ID: 'synthetic-source-001',
    AI_MEMORY_DATABASE_URL: 'postgresql://synthetic:private-password@127.0.0.1:5432/ai_memory_dr_source',
    AI_MEMORY_BACKUP_DATABASE_URL_FILE: undefined,
    AI_MEMORY_S3_BUCKET: 'synthetic-bucket',
    AI_MEMORY_S3_PREFIX: 'synthetic',
    FAKE_S3_ROOT: remote,
    FAKE_AWS_LOG: join(root, 'aws.log'),
    FAKE_FAIL_ONCE: join(root, 'fail-once'),
    FAKE_INTERRUPT: interruption,
  };
  return { backups, bin, remote, aws, key, keyFile, backupId, archive, manifest, metadata, env };
}

test.each(['failure', 'cancellation'])(
  '%s during S3 upload retries only authenticated compatible archive and publishes manifest last',
  { timeout: 20_000 },
  interruption => {
    const root = mkdtempSync(join(tmpdir(), 'ai-memory-s3-test-'));
    chmodSync(root, 0o700);
    try {
      const { backups, remote, aws, key, backupId, archive, manifest, metadata, env } = pendingFixture(
        root,
        interruption,
      );
      const command = () => spawnSync(process.execPath, [script, 'backup'], { encoding: 'utf8', env });
      const first = command();
      assert.notEqual(first.status, 0);
      assert.equal(existsSync(join(backups, '.backup-owner.json')), false);
      assert.equal(existsSync(join(backups, '.backup-reclaim.json')), false);
      assert.match(first.stderr, interruption === 'cancellation' ? /COMMAND_CANCELLED/u : /S3_UPLOAD_FAILED/u);
      assert.doesNotMatch(first.stderr, /synthetic-private-marker|private-password/u);
      assert.equal(existsSync(join(backups, `${backupId}.manifest.json`)), false);
      assert.equal(existsSync(join(backups, 'last-success.json')), false);
      assert.equal(
        (JSON.parse(readFileSync(join(backups, 'last-attempt.json'), 'utf8')) as { reason: string }).reason,
        interruption === 'cancellation' ? 'COMMAND_CANCELLED' : 'S3_UPLOAD_FAILED',
      );
      const checkpoint = readFileSync(join(backups, 'pending.json'));
      const second = command();
      assert.equal(second.status, 0, second.stderr);
      assert.equal(existsSync(join(backups, '.backup-owner.json')), false);
      assert.match(second.stdout, /reused_encrypted_archive/u);
      assert.equal(existsSync(join(backups, 'pending.json')), false);
      assert.equal(existsSync(join(backups, `${backupId}.manifest.json`)), true);
      assert.equal(existsSync(join(remote, 'synthetic', backupId, 'manifest.json')), true);
      const controlBackups = join(root, 'control-backups');
      const controlRemote = join(root, 'control-remote');
      mkdirSync(controlBackups, { mode: 0o700 });
      mkdirSync(controlRemote);
      writeFileSync(join(controlBackups, `${backupId}.aimdr`), readFileSync(archive));
      writeFileSync(join(controlBackups, 'pending.json'), checkpoint);
      const uninterrupted = spawnSync(process.execPath, [script, 'backup'], {
        encoding: 'utf8',
        env: { ...env, AI_MEMORY_BACKUP_DIR: controlBackups, FAKE_S3_ROOT: controlRemote },
      });
      assert.equal(uninterrupted.status, 0, uninterrupted.stderr);
      for (const name of ['archive.aimdr', 'manifest.json'])
        assert.deepEqual(
          readFileSync(join(remote, 'synthetic', backupId, name)),
          readFileSync(join(controlRemote, 'synthetic', backupId, name)),
        );
      assert.equal(spawnSync(process.execPath, [script, 'status'], { encoding: 'utf8', env }).status, 0);
      assert.doesNotMatch(readFileSync(join(root, 'aws.log'), 'utf8'), /delete-object/u);
      const denied = spawnSync(
        aws,
        [
          '--no-cli-pager',
          's3api',
          'delete-object',
          '--bucket',
          'synthetic-bucket',
          '--key',
          `synthetic/${backupId}/archive.aimdr`,
          '--version-id',
          'version1',
        ],
        { encoding: 'utf8', env },
      );
      assert.notEqual(denied.status, 0);
      assert.match(denied.stderr, /AccessDenied/u);
      writeFileSync(
        join(backups, 'pending.json'),
        JSON.stringify({
          manifest,
          bucket: 'synthetic-bucket',
          prefix: 'synthetic',
          sourceIdSha256: sha('synthetic-source-001'),
          keySha256: sha(key),
          sourceTargetSha256: metadata.sourceTargetSha256,
          migrationCodeSha256: metadata.migrationCodeSha256,
          scriptSha256: sha(readFileSync(script)),
        }),
      );
      const changedSource = spawnSync(process.execPath, [script, 'backup'], {
        encoding: 'utf8',
        env: {
          ...env,
          AI_MEMORY_DATABASE_URL: 'postgresql://synthetic:private-password@127.0.0.1:5432/ai_memory_other_source',
        },
      });
      assert.notEqual(changedSource.status, 0);
      assert.match(changedSource.stdout, /pending_rejected/u);
      assert.doesNotMatch(changedSource.stdout, /reused_encrypted_archive/u);
      assert.match(changedSource.stderr, /PG_TOOL_VERSION_UNSUPPORTED/u);
      writeFileSync(
        join(backups, 'pending.json'),
        JSON.stringify({
          manifest,
          bucket: 'synthetic-bucket',
          prefix: 'synthetic',
          sourceIdSha256: sha('synthetic-source-001'),
          keySha256: sha(key),
          sourceTargetSha256: sha('postgresql://synthetic@127.0.0.1:5432/ai_memory_other_source'),
          migrationCodeSha256: metadata.migrationCodeSha256,
          scriptSha256: sha(readFileSync(script)),
        }),
      );
      const changedCheckpoint = spawnSync(process.execPath, [script, 'backup'], {
        encoding: 'utf8',
        env: {
          ...env,
          AI_MEMORY_DATABASE_URL: 'postgresql://synthetic:private-password@127.0.0.1:5432/ai_memory_other_source',
        },
      });
      assert.notEqual(changedCheckpoint.status, 0);
      assert.match(changedCheckpoint.stdout, /pending_rejected/u);
      assert.doesNotMatch(changedCheckpoint.stdout, /reused_encrypted_archive/u);
      assert.match(changedCheckpoint.stderr, /PG_TOOL_VERSION_UNSUPPORTED/u);
      writeFileSync(
        join(backups, 'pending.json'),
        JSON.stringify({
          manifest,
          bucket: 'synthetic-bucket',
          prefix: 'synthetic',
          sourceIdSha256: sha('synthetic-source-001'),
          keySha256: sha(key),
          sourceTargetSha256: metadata.sourceTargetSha256,
          migrationCodeSha256: metadata.migrationCodeSha256,
          scriptSha256: 'incompatible-code',
        }),
      );
      const incompatibleCode = command();
      assert.notEqual(incompatibleCode.status, 0);
      assert.match(incompatibleCode.stdout, /pending_rejected/u);
      assert.doesNotMatch(incompatibleCode.stdout, /reused_encrypted_archive/u);
      writeFileSync(
        join(backups, 'pending.json'),
        JSON.stringify({
          manifest,
          bucket: 'synthetic-bucket',
          prefix: 'synthetic',
          sourceIdSha256: sha('synthetic-source-001'),
          keySha256: sha(key),
          sourceTargetSha256: metadata.sourceTargetSha256,
          migrationCodeSha256: metadata.migrationCodeSha256,
          scriptSha256: sha(readFileSync(script)),
        }),
      );
      const corrupt = readFileSync(archive);
      corrupt[24] = (corrupt[24] ?? 0) ^ 1;
      writeFileSync(archive, corrupt);
      const incompatible = command();
      assert.notEqual(incompatible.status, 0);
      assert.match(incompatible.stdout, /pending_rejected/u);
      assert.doesNotMatch(incompatible.stdout, /reused_encrypted_archive/u);
      const unprotected = spawnSync(process.execPath, [script, 'backup'], {
        encoding: 'utf8',
        env: { ...env, FAKE_RETENTION_MODE: 'GOVERNANCE' },
      });
      assert.notEqual(unprotected.status, 0);
      assert.match(unprotected.stderr, /S3_PROTECTION_INCOMPLETE/u);
      assert.doesNotMatch(unprotected.stdout, /upload_and_verify/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

function startBackup(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (bytes: Buffer) => {
    stdout += bytes.toString();
  });
  child.stderr.on('data', (bytes: Buffer) => {
    stderr += bytes.toString();
  });
  const result = new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', status => {
      resolve({ status, stdout, stderr });
    });
  });
  return { child, result };
}

async function barrierReady(path: string) {
  const deadline = Date.now() + 5000;
  while (!existsSync(path)) {
    assert.ok(Date.now() < deadline, 'synthetic provider did not reach its barrier');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function overlap(entry: 'compiled' | 'manual' | 'scheduled' | 'alias') {
  const root = mkdtempSync(join(tmpdir(), 'ai-memory-overlap-test-'));
  chmodSync(root, 0o700);
  const f = pendingFixture(root);
  writeFileSync(f.env.FAKE_FAIL_ONCE, 'allow uploads');
  const ready = join(root, 'owner-ready');
  const release = join(root, 'owner-release');
  const owner = startBackup([script, 'backup'], { ...f.env, FAKE_BARRIER_READY: ready, FAKE_BARRIER_RELEASE: release });
  try {
    await barrierReady(ready);
    const before = new Map(readdirSync(f.backups).map(name => [name, readFileSync(join(f.backups, name))]));
    const alias = join(root, 'alias');
    if (entry === 'alias') symlinkSync(f.backups, alias);
    const contender = spawnSync(
      entry === 'scheduled' ? '/bin/bash' : process.execPath,
      entry === 'scheduled'
        ? [join(packageRoot, 'scripts', 'backup-db.sh')]
        : entry === 'manual'
          ? [join(packageRoot, 'dist', 'tools', 'backup-launchd-agent.js'), 'run-once']
          : [script, 'backup'],
      {
        env: {
          ...f.env,
          AI_MEMORY_BACKUP_DIR: entry === 'alias' ? alias : f.backups,
          FAKE_AWS_LOG: join(root, 'contender-provider.log'),
        },
        encoding: 'utf8',
        timeout: 3000,
      },
    );
    assert.match(
      contender.stderr,
      /BACKUP_BUSY/u,
      JSON.stringify({
        expected: 'bounded ownership refusal',
        status: contender.status,
        stdout: contender.stdout,
        providerEntered: existsSync(join(root, 'contender-provider.log')),
        changedRecoveryFiles: [...before]
          .filter(
            ([name, bytes]) => !existsSync(join(f.backups, name)) || !readFileSync(join(f.backups, name)).equals(bytes),
          )
          .map(([name]) => name),
      }),
    );
    assert.notEqual(contender.status, 0);
    assert.equal(existsSync(join(root, 'contender-provider.log')), false, 'overlap started provider work');
    assert.deepEqual(readdirSync(f.backups).sort(), [...before.keys()].sort());
    for (const [name, bytes] of before) assert.deepEqual(readFileSync(join(f.backups, name)), bytes, name);
  } finally {
    owner.child.kill('SIGTERM');
    try {
      const cancelled = await owner.result;
      assert.notEqual(cancelled.status, 0);
      assert.match(cancelled.stderr, /COMMAND_CANCELLED/u);
      assert.equal(existsSync(join(f.backups, '.backup-owner.json')), false);
      assert.equal(existsSync(join(f.backups, '.backup-reclaim.json')), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

test(
  'an overlapping canonical backup refuses before changing the active owner recovery state',
  { timeout: 15_000 },
  async () => {
    await overlap('compiled');
  },
);
test.each(['manual', 'scheduled', 'alias'] as const)(
  '%s invocation shares canonical ownership',
  { timeout: 15_000 },
  async entry => {
    await overlap(entry);
  },
);
