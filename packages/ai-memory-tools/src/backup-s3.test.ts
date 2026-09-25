import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(packageRoot, 'dist', 'disaster-recovery.js');
const migrations = join(packageRoot, '..', 'ai-memory', 'migrations');

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
if (args[1] === 's3' && op === 'cp') {
  const source = args[3];
  const destination = args[4];
  const key = destination.replace(/^s3:\\/\\/synthetic-bucket\\//, '');
  if (key.endsWith('/archive.aimdr') && !fs.existsSync(process.env.FAKE_FAIL_ONCE)) {
    fs.writeFileSync(process.env.FAKE_FAIL_ONCE, 'failed once');
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

test('interrupted S3 upload retries only authenticated compatible archive and publishes manifest last', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-memory-s3-test-'));
  chmodSync(root, 0o700);
  try {
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
          DR_MODULE: pathToFileURL(script).href,
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
        scriptSha256: sha(readFileSync(script)),
      }),
    );
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      AI_MEMORY_BACKUP_DIR: backups,
      AI_MEMORY_BACKUP_KEY_FILE: keyFile,
      AI_MEMORY_BACKUP_SOURCE_ID: 'synthetic-source-001',
      AI_MEMORY_DATABASE_URL: 'postgresql://synthetic:private-password@127.0.0.1:5432/ai_memory_dr_source',
      AI_MEMORY_S3_BUCKET: 'synthetic-bucket',
      AI_MEMORY_S3_PREFIX: 'synthetic',
      FAKE_S3_ROOT: remote,
      FAKE_AWS_LOG: join(root, 'aws.log'),
      FAKE_FAIL_ONCE: join(root, 'fail-once'),
    };
    const command = () => spawnSync(process.execPath, [script, 'backup'], { encoding: 'utf8', env });
    const first = command();
    assert.notEqual(first.status, 0);
    assert.match(first.stderr, /S3_UPLOAD_FAILED/u);
    assert.doesNotMatch(first.stderr, /synthetic-private-marker|private-password/u);
    assert.equal(existsSync(join(backups, `${backupId}.manifest.json`)), false);
    assert.equal(existsSync(join(backups, 'last-success.json')), false);
    assert.equal(
      (JSON.parse(readFileSync(join(backups, 'last-attempt.json'), 'utf8')) as { reason: string }).reason,
      'S3_UPLOAD_FAILED',
    );
    const second = command();
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /reused_encrypted_archive/u);
    assert.equal(existsSync(join(backups, 'pending.json')), false);
    assert.equal(existsSync(join(backups, `${backupId}.manifest.json`)), true);
    assert.equal(existsSync(join(remote, 'synthetic', backupId, 'manifest.json')), true);
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
});
