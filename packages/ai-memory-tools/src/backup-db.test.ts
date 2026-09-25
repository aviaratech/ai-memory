import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'dist', 'disaster-recovery.js');

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ai-memory-dr-test-'));
  chmodSync(directory, 0o700);
  const backups = join(directory, 'backups');
  mkdirSync(backups, { mode: 0o700 });
  const keyFile = join(directory, 'key.txt');
  writeFileSync(keyFile, `${randomBytes(32).toString('base64')}\n`, { mode: 0o600 });
  return {
    directory,
    backups,
    keyFile,
    env: {
      ...process.env,
      AI_MEMORY_BACKUP_DIR: backups,
      AI_MEMORY_BACKUP_KEY_FILE: keyFile,
      AI_MEMORY_BACKUP_SOURCE_ID: 'synthetic-source-001',
    },
  };
}

function cli(command: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [script, command], { encoding: 'utf8', env });
}

test('backup rejects connection target overrides before touching the database', () => {
  const current = fixture();
  try {
    for (const suffix of [
      '?host=remote.example.invalid',
      '?hostaddr=203.0.113.9',
      '?service=remote',
      '?HOST=remote.example.invalid',
      '?sslmode=require',
    ]) {
      const result = cli('backup', {
        ...current.env,
        AI_MEMORY_DATABASE_URL: `postgresql://synthetic:secret@127.0.0.1:5432/ai_memory${suffix}`,
      });
      assert.notEqual(result.status, 0, suffix);
      assert.match(result.stderr, /SOURCE_URL_TARGET_UNSAFE/u);
      assert.doesNotMatch(result.stderr, /secret|remote\.example|203\.0\.113\.9/u);
    }
  } finally {
    rmSync(current.directory, { recursive: true, force: true });
  }
});

test('archive is authenticated, detects corruption and wrong keys, and never exposes plaintext metadata', () => {
  const current = fixture();
  try {
    const dumpPath = join(current.directory, 'synthetic.dump');
    const archivePath = join(current.backups, 'synthetic.aimdr');
    const restoredPath = join(current.directory, 'restored.dump');
    const payload = Buffer.from('synthetic PostgreSQL dump bytes with no real memory content');
    writeFileSync(dumpPath, payload);
    const digest = createHash('sha256').update(payload).digest('hex');
    const probe = `
      import assert from 'node:assert/strict';
      import { readFile, rm, writeFile } from 'node:fs/promises';
      const { encryptArchive, decryptArchive } = await import(process.env.DR_MODULE);
      const key = Buffer.from(process.env.DR_KEY, 'base64');
      const wrong = Buffer.from(key); wrong[0] ^= 1;
      const metadata = { format: 1, sourceId: 'synthetic-source-001', dumpSha256: process.env.DR_SHA, dumpBytes: Number(process.env.DR_BYTES) };
      await encryptArchive(process.env.DR_DUMP, process.env.DR_ARCHIVE, metadata, key);
      const ciphertext = await readFile(process.env.DR_ARCHIVE);
      assert.equal(ciphertext.includes(Buffer.from('synthetic-source-001')), false);
      assert.equal(ciphertext.includes(Buffer.from('synthetic PostgreSQL')), false);
      const opened = await decryptArchive(process.env.DR_ARCHIVE, process.env.DR_RESTORED, key);
      assert.equal(opened.sourceId, 'synthetic-source-001');
      assert.deepEqual(await readFile(process.env.DR_RESTORED), await readFile(process.env.DR_DUMP));
      await rm(process.env.DR_RESTORED);
      await assert.rejects(decryptArchive(process.env.DR_ARCHIVE, process.env.DR_RESTORED, wrong));
      const corrupt = Buffer.from(ciphertext); corrupt[Math.floor(corrupt.length / 2)] ^= 1;
      await writeFile(process.env.DR_ARCHIVE, corrupt);
      await assert.rejects(decryptArchive(process.env.DR_ARCHIVE, process.env.DR_RESTORED, key));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
      encoding: 'utf8',
      env: {
        ...current.env,
        DR_MODULE: `file://${script}`,
        DR_KEY: readFileSync(current.keyFile, 'utf8').trim(),
        DR_DUMP: dumpPath,
        DR_ARCHIVE: archivePath,
        DR_RESTORED: restoredPath,
        DR_SHA: digest,
        DR_BYTES: String(payload.length),
      },
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(current.directory, { recursive: true, force: true });
  }
});

test('status fails for missing, stale, and failed backups without reporting private identifiers', () => {
  const current = fixture();
  try {
    const missing = cli('status', current.env);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stdout, /"state":"missing"/u);
    const old = new Date(Date.now() - 48 * 3600_000).toISOString();
    writeFileSync(
      join(current.backups, 'last-success.json'),
      JSON.stringify({
        createdAt: old,
        completedAt: old,
        backupId: 'private-synthetic-id',
        mode: 's3',
      }),
    );
    const stale = cli('status', current.env);
    assert.notEqual(stale.status, 0);
    assert.match(stale.stdout, /"state":"stale"/u);
    assert.doesNotMatch(stale.stdout, /private-synthetic-id/u);
    writeFileSync(join(current.backups, 'last-attempt.json'), JSON.stringify({ state: 'failed', stage: 'upload' }));
    const failed = cli('status', current.env);
    assert.notEqual(failed.status, 0);
    assert.match(failed.stdout, /"state":"failed"/u);
  } finally {
    rmSync(current.directory, { recursive: true, force: true });
  }
});

test('restore refuses a production or test target name before reading any archive', () => {
  const current = fixture();
  try {
    for (const target of ['ai_memory', 'ai_memory_test', 'postgres']) {
      const result = cli('restore', {
        ...current.env,
        AI_MEMORY_RESTORE_ADMIN_URL: 'postgresql://synthetic:secret@127.0.0.1:5432/postgres',
        AI_MEMORY_RESTORE_EXPECT_SOURCE_ID: 'synthetic-source-001',
        AI_MEMORY_RESTORE_TARGET_NAME: target,
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /RESTORE_TARGET_UNSAFE/u);
      assert.doesNotMatch(result.stderr, /secret/u);
    }
  } finally {
    rmSync(current.directory, { recursive: true, force: true });
  }
});

test('restore rejects an uncalled sequence that would reuse the highest restored row ID', () => {
  const probe = `
    import assert from 'node:assert/strict';
    const { checkSequences } = await import(process.env.DR_MODULE);
    const name = 'public.ai_memory_entries_id_seq';
    let state = { value: '5', is_called: false };
    const client = { query: async sql => {
      if (sql.includes('FROM pg_class seq')) return { rows: [{
        schema: 'public', name: 'ai_memory_entries_id_seq', table_schema: 'public',
        table_name: 'ai_memory_entries', column_name: 'id',
      }] };
      if (sql.startsWith('SELECT last_value')) return { rows: [state] };
      if (sql.startsWith('SELECT max')) return { rows: [{ value: '5' }] };
      throw new Error('unexpected query');
    } };
    await assert.rejects(checkSequences(client, [name]), /SEQUENCE_BEHIND_DATA/);
    state = { value: '5', is_called: true };
    await checkSequences(client, [name]);
    state = { value: '6', is_called: false };
    await checkSequences(client, [name]);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    encoding: 'utf8',
    env: { ...process.env, DR_MODULE: `file://${script}` },
  });
  assert.equal(result.status, 0, result.stderr);
});

test('restore rejects missing/wrong key, corrupted archive, and wrong source before target creation', () => {
  const current = fixture();
  try {
    const backupId = randomUUID();
    const dump = join(current.directory, 'synthetic.dump');
    const archive = join(current.backups, `${backupId}.aimdr`);
    const manifest = join(current.backups, `${backupId}.manifest.json`);
    writeFileSync(dump, 'synthetic PostgreSQL data only');
    const bytes = readFileSync(dump);
    const metadata = {
      format: 1,
      backupId,
      sourceId: 'synthetic-source-001',
      databaseName: 'ai_memory_dr_source',
      serverMajor: 18,
      dumpSha256: createHash('sha256').update(bytes).digest('hex'),
      dumpBytes: bytes.length,
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
          ...current.env,
          DR_MODULE: `file://${script}`,
          DR_DUMP: dump,
          DR_ARCHIVE: archive,
          DR_METADATA: JSON.stringify(metadata),
          DR_KEY: readFileSync(current.keyFile, 'utf8').trim(),
        },
      },
    );
    assert.equal(seal.status, 0, seal.stderr);
    const archiveBytes = readFileSync(archive);
    writeFileSync(
      manifest,
      JSON.stringify({
        format: 1,
        backupId,
        createdAt: new Date().toISOString(),
        archiveSha256: createHash('sha256').update(archiveBytes).digest('hex'),
        archiveBytes: archiveBytes.length,
      }),
    );
    const env = {
      ...current.env,
      AI_MEMORY_RESTORE_EXPECT_SOURCE_ID: 'synthetic-source-001',
      AI_MEMORY_RESTORE_EXPECT_DATABASE: 'ai_memory_dr_source',
      AI_MEMORY_RESTORE_ADMIN_URL: 'postgresql://synthetic:private-password@127.0.0.1:5432/postgres',
      AI_MEMORY_RESTORE_TARGET_NAME: 'ai_memory_restore_synthetic_001',
      AI_MEMORY_RESTORE_MANIFEST_FILE: manifest,
    };
    const missing = cli('restore', { ...env, AI_MEMORY_BACKUP_KEY_FILE: join(current.directory, 'missing-key') });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /KEY_FILE_UNAVAILABLE/u);
    const wrongKey = join(current.directory, 'wrong-key');
    writeFileSync(wrongKey, `${randomBytes(32).toString('base64')}\n`, { mode: 0o600 });
    const wrong = cli('restore', { ...env, AI_MEMORY_BACKUP_KEY_FILE: wrongKey });
    assert.notEqual(wrong.status, 0);
    assert.match(wrong.stderr, /ARCHIVE_AUTHENTICATION_FAILED/u);
    const wrongSource = cli('restore', { ...env, AI_MEMORY_RESTORE_EXPECT_SOURCE_ID: 'other-source-001' });
    assert.notEqual(wrongSource.status, 0);
    assert.match(wrongSource.stderr, /BACKUP_IDENTITY_MISMATCH/u);
    const damaged = Buffer.from(archiveBytes);
    damaged[24] = (damaged[24] ?? 0) ^ 1;
    writeFileSync(archive, damaged);
    const corrupt = cli('restore', env);
    assert.notEqual(corrupt.status, 0);
    assert.match(corrupt.stderr, /ARCHIVE_INTEGRITY_FAILED/u);
    for (const result of [missing, wrong, wrongSource, corrupt]) {
      assert.doesNotMatch(result.stderr, /private-password|synthetic-source-001/u);
      assert.doesNotMatch(result.stdout, /restore_created_empty_target/u);
    }
    assert.equal(statSync(current.backups).isDirectory(), true);
  } finally {
    rmSync(current.directory, { recursive: true, force: true });
  }
});

test(
  'backup launchd dry-run keeps the database password out of its plist',
  { skip: process.platform !== 'darwin' },
  () => {
    const current = fixture();
    try {
      const databaseUrlFile = join(current.directory, 'database-url');
      writeFileSync(databaseUrlFile, 'postgresql://synthetic:private-password@127.0.0.1:5432/ai_memory\n', {
        mode: 0o600,
      });
      const result = spawnSync(
        process.execPath,
        [join(root, 'dist', 'backup-launchd-agent.js'), 'install', '--dry-run'],
        {
          encoding: 'utf8',
          env: {
            ...current.env,
            AI_MEMORY_BACKUP_DATABASE_URL_FILE: databaseUrlFile,
            AI_MEMORY_DATABASE_URL: 'postgresql://synthetic:private-password@127.0.0.1:5432/ai_memory',
          },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /AI_MEMORY_BACKUP_DATABASE_URL_FILE/u);
      assert.doesNotMatch(result.stdout, /private-password/u);
      assert.doesNotMatch(result.stdout, /synthetic-source-001|synthetic-bucket|ai-memory-dr-test-/u);
    } finally {
      rmSync(current.directory, { recursive: true, force: true });
    }
  },
);
