#!/usr/bin/env node

// The only backup/restore implementation. Secrets and provider errors never enter CLI output.
import { spawn, execFile as execFileCallback } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { Client as PgClient } from 'pg';

type RunOptions = { env?: NodeJS.ProcessEnv; timeout?: number; failure?: string };
type ExtensionIdentity = { extname: string; extversion: string };
type DatabaseFacts = {
  serverMajor: number;
  extensions: ExtensionIdentity[];
  migrations: string[];
  hasEmbeddingColumn: boolean;
  tableNames: string[];
  rowCounts: Record<string, string>;
  sequenceNames: string[];
};
type ArchiveMetadata = DatabaseFacts & {
  format: number;
  backupId: string;
  createdAt: string;
  sourceId: string;
  databaseName: string;
  sourceTargetSha256: string;
  migrationCodeSha256: string;
  dumpSha256: string;
  dumpBytes: number;
};
type BackupManifest = {
  format: number;
  backupId: string;
  createdAt: string;
  archiveSha256: string;
  archiveBytes: number;
  s3?: { key: string; versionId: string };
};
type PendingCheckpoint = {
  manifest: BackupManifest;
  bucket: string;
  prefix: string;
  sourceIdSha256: string;
  sourceTargetSha256: string;
  keySha256: string;
  migrationCodeSha256: string;
  scriptSha256: string;
};
type S3Config = { bucket: string; prefix: string };
type BackupAttempt = { state: string; startedAt: string };
type BackupSuccess = { createdAt: string; mode: string };
type AwsVersioning = { Status?: string };
type AwsLock = {
  ObjectLockConfiguration?: {
    ObjectLockEnabled?: string;
    Rule?: { DefaultRetention?: { Mode?: string; Days?: number; Years?: number } };
  };
};
type AwsPublicAccess = { PublicAccessBlockConfiguration?: Record<string, boolean> };
type AwsEncryption = {
  ServerSideEncryptionConfiguration?: { Rules?: { ApplyServerSideEncryptionByDefault?: { SSEAlgorithm?: string } }[] };
};
type AwsPolicy = { PolicyStatus?: { IsPublic?: boolean } };
type AwsHead = {
  VersionId?: string;
  ContentLength?: number;
  ObjectLockMode?: string;
  ObjectLockRetainUntilDate?: string;
  ServerSideEncryption?: string;
};

function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'UNKNOWN';
}

function isManifest(value: unknown): value is BackupManifest {
  if (!value || typeof value !== 'object') return false;
  const manifest = value as Partial<BackupManifest>;
  return (
    manifest.format === 1 &&
    typeof manifest.backupId === 'string' &&
    /^[a-f0-9-]{36}$/u.test(manifest.backupId) &&
    typeof manifest.createdAt === 'string' &&
    typeof manifest.archiveSha256 === 'string' &&
    /^[a-f0-9]{64}$/u.test(manifest.archiveSha256) &&
    typeof manifest.archiveBytes === 'number' &&
    Number.isSafeInteger(manifest.archiveBytes) &&
    manifest.archiveBytes > 0 &&
    (manifest.s3 === undefined ||
      (manifest.s3 !== null &&
        typeof manifest.s3 === 'object' &&
        typeof manifest.s3.key === 'string' &&
        typeof manifest.s3.versionId === 'string'))
  );
}

const execFile = promisify(execFileCallback);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '../../..');
const MIGRATIONS_DIR = resolve(SCRIPT_DIR, '../../ai-memory/migrations');
const MAGIC = Buffer.from('AIMEMDR1');
const HEADER_BYTES = MAGIC.length + 12;
const TAG_BYTES = 16;
const MAX_METADATA_BYTES = 1024 * 1024;
const REQUIRED_PG_MAJOR = 18;
const DEFAULT_MAX_AGE_HOURS = 36;
const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const URL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}

function log(stage: string, fields: Record<string, unknown> = {}) {
  process.stdout.write(`${JSON.stringify({ stage, ...fields })}\n`);
}

function inside(path: string, parent: string) {
  return path === parent || path.startsWith(`${parent}${sep}`);
}

function validateUrl(value: string | undefined, kind: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value ?? '');
  } catch {
    fail(`${kind}_URL_INVALID`);
  }
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    !URL_HOSTS.has(parsed.hostname.toLowerCase()) ||
    !/^\/[a-z0-9_-]+$/iu.test(parsed.pathname) ||
    (parsed.password && !parsed.username) ||
    [...parsed.searchParams].some(([key, val]) => key !== 'sslmode' || val !== 'disable') ||
    parsed.hash
  )
    fail(`${kind}_URL_TARGET_UNSAFE`);
  return parsed;
}

function sourceTargetDigest(parsed: URL) {
  const target = new URL(parsed);
  target.password = '';
  return createHash('sha256').update(target.href).digest('hex');
}

function requireSourceId() {
  const value = process.env.AI_MEMORY_BACKUP_SOURCE_ID;
  if (!value || !/^[a-z0-9._-]{8,128}$/iu.test(value)) fail('SOURCE_ID_REQUIRED');
  return value;
}

async function secureDirectory() {
  const path = resolve(process.env.AI_MEMORY_BACKUP_DIR ?? join(homedir(), '.local/share/ai-memory/backups'));
  if (inside(path, REPO_ROOT) || path === '/' || path === homedir()) fail('BACKUP_PATH_UNSAFE');
  await fs.mkdir(path, { recursive: true, mode: 0o700 });
  const real = await fs.realpath(path);
  const stat = await fs.stat(real);
  if (!stat.isDirectory() || inside(real, REPO_ROOT) || (stat.mode & 0o077) !== 0) fail('BACKUP_PATH_UNSAFE');
  return real;
}

async function secureSecretFile(name: string | undefined, pathRoot: string, label: string) {
  if (!name || !isAbsolute(name)) fail(`${label}_FILE_REQUIRED`);
  const link = await fs.lstat(name).catch(() => fail(`${label}_FILE_UNAVAILABLE`));
  if (!link.isFile() || link.isSymbolicLink() || (link.mode & 0o077) !== 0) fail(`${label}_FILE_UNSAFE`);
  const real = await fs.realpath(name);
  if (inside(real, REPO_ROOT) || inside(real, pathRoot)) fail(`${label}_FILE_UNSAFE`);
  return (await fs.readFile(real, 'utf8')).trim();
}

async function secureKey(pathRoot: string) {
  const content = await secureSecretFile(process.env.AI_MEMORY_BACKUP_KEY_FILE, pathRoot, 'KEY');
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(content)) fail('KEY_FILE_FORMAT');
  const key = Buffer.from(content, 'base64');
  if (key.length !== 32) fail('KEY_FILE_FORMAT');
  return key;
}

async function atomicJson(path: string, value: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temp, path);
}

async function writeAll(handle: FileHandle, buffer: Buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
    if (bytesWritten <= 0) fail('FILE_WRITE_FAILED');
    offset += bytesWritten;
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await fs.readFile(path, 'utf8')) as T;
}

async function digestFile(path: string) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const part of createReadStream(path) as AsyncIterable<Buffer>) {
    hash.update(part);
    bytes += part.length;
  }
  return { sha256: hash.digest('hex'), bytes };
}

async function freeBytes(path: string) {
  const stat = await fs.statfs(path);
  return stat.bavail * stat.bsize;
}

async function run(command: string, args: string[], options: RunOptions = {}) {
  try {
    const result = await execFile(command, args, {
      env: options.env ?? process.env,
      timeout: options.timeout ?? 30 * 60 * 1000,
      maxBuffer: 1024 * 1024,
    });
    return result.stdout.trim();
  } catch {
    return fail(options.failure ?? 'COMMAND_FAILED');
  }
}

async function runDiscard(command: string, args: string[], code: string) {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    child.on('error', () => {
      rejectPromise(new Error(code));
    });
    child.on('close', status => {
      if (status === 0) resolvePromise();
      else rejectPromise(new Error(code));
    });
  }).catch(() => fail(code));
}

function pgEnv(url: string, passFile: string | null): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('PG')) delete env[key];
  const parsed = validateUrl(url, 'PG');
  env.PGHOST = parsed.hostname.replace(/^\[|\]$/gu, '');
  env.PGPORT = parsed.port || '5432';
  env.PGDATABASE = parsed.pathname.slice(1);
  if (parsed.username) env.PGUSER = decodeURIComponent(parsed.username);
  if (passFile) env.PGPASSFILE = passFile;
  env.PGSSLMODE = 'disable';
  env.PGCONNECT_TIMEOUT = '20';
  return env;
}

async function createPgPass(url: string, directory: string) {
  const parsed = validateUrl(url, 'PG');
  if (!parsed.password) return null;
  const escape = (value: string) => value.replaceAll('\\', '\\\\').replaceAll(':', '\\:');
  const host = parsed.hostname.replace(/^\[|\]$/gu, '');
  const fields = [
    host,
    parsed.port || '5432',
    parsed.pathname.slice(1),
    decodeURIComponent(parsed.username),
    decodeURIComponent(parsed.password),
  ];
  const path = join(directory, `pgpass-${randomUUID()}`);
  const handle = await fs.open(path, 'wx', 0o600);
  try {
    await handle.writeFile(`${fields.map(escape).join(':')}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return path;
}

async function pgCommandVersion(command: string) {
  const output = await run(command, ['--version'], { failure: 'PG_TOOL_UNAVAILABLE' });
  const major = Number(output.match(/\b(\d+)\.\d+\b/u)?.[1]);
  if (major !== REQUIRED_PG_MAJOR) fail('PG_TOOL_VERSION_UNSUPPORTED');
}

async function runPgToFile(
  command: string,
  args: string[],
  url: string,
  path: string,
  passFile: string | null,
  code: string,
) {
  const output = await fs.open(path, 'wx', 0o600);
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn(command, args, { env: pgEnv(url, passFile), stdio: ['ignore', output.fd, 'pipe'] });
      let errorBytes = 0;
      child.stderr?.on('data', (chunk: Buffer) => {
        errorBytes += chunk.length;
      });
      child.on('error', () => {
        rejectPromise(new Error(code));
      });
      child.on('close', status => {
        if (status === 0 && errorBytes === 0) resolvePromise();
        else rejectPromise(new Error(code));
      });
    });
    await output.sync();
  } catch {
    fail(code);
  } finally {
    await output.close();
  }
}

async function migrationDigest() {
  const names = (await fs.readdir(MIGRATIONS_DIR)).filter(name => /^\d{3}_.+\.sql$/u.test(name)).sort();
  if (names.length === 0) fail('MIGRATIONS_UNAVAILABLE');
  const hash = createHash('sha256');
  for (const name of names) {
    hash.update(name);
    hash.update(Buffer.from([0]));
    hash.update(await fs.readFile(join(MIGRATIONS_DIR, name)));
  }
  return { digest: hash.digest('hex'), names: names.map(name => name.slice(0, -4)) };
}

function quote(name: string) {
  return `"${name.replaceAll('"', '""')}"`;
}

async function connect(url: string): Promise<PgClient> {
  const { default: pg } = await import('pg');
  const parsed = validateUrl(url, 'PG');
  const client = new pg.Client({
    host: parsed.hostname.replace(/^\[|\]$/gu, ''),
    port: Number(parsed.port || 5432),
    database: parsed.pathname.slice(1),
    user: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    ssl: false,
    connectionTimeoutMillis: 20_000,
  });
  try {
    await client.connect();
    return client;
  } catch {
    return fail('DATABASE_UNAVAILABLE');
  }
}

async function databaseFacts(client: PgClient, countRows: boolean): Promise<DatabaseFacts> {
  const server = (await client.query<{ server_version_num: string }>('SHOW server_version_num')).rows[0]
    ?.server_version_num;
  const extensions = (
    await client.query<ExtensionIdentity>(
      "SELECT extname, extversion FROM pg_extension WHERE extname <> 'plpgsql' ORDER BY extname",
    )
  ).rows;
  const migrations = (
    await client.query<{ name: string }>('SELECT name FROM public.ai_memory_pgmigrations ORDER BY id')
  ).rows.map(row => row.name);
  const hasEmbeddingColumn = (
    await client.query<{ value: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = 'ai_memory_entries' AND column_name = 'embedding'
  ) AS value`)
  ).rows[0]?.value;
  if (hasEmbeddingColumn === undefined) fail('SOURCE_SCHEMA_INCOMPLETE');
  if ((hasEmbeddingColumn && !extensions.some(row => row.extname === 'vector')) || migrations.length === 0)
    fail('SOURCE_SCHEMA_INCOMPLETE');
  const tables = (
    await client.query<{ schema: string; name: string }>(`
    SELECT n.nspname AS schema, c.relname AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_%' ORDER BY 1, 2`)
  ).rows;
  const rowCounts: Record<string, string> = {};
  if (countRows)
    for (const table of tables) {
      const key = `${table.schema}.${table.name}`;
      const count = (
        await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${quote(table.schema)}.${quote(table.name)}`,
        )
      ).rows[0]?.count;
      if (count === undefined) fail('SOURCE_SCHEMA_INCOMPLETE');
      rowCounts[key] = count;
    }
  const sequences = (
    await client.query<{ schema: string; name: string }>(`
    SELECT n.nspname AS schema, c.relname AS name FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'S' AND n.nspname NOT LIKE 'pg_%' ORDER BY 1, 2`)
  ).rows;
  return {
    serverMajor: Math.floor(Number(server) / 10000),
    extensions,
    migrations,
    hasEmbeddingColumn,
    tableNames: tables.map(t => `${t.schema}.${t.name}`),
    rowCounts,
    sequenceNames: sequences.map(s => `${s.schema}.${s.name}`),
  };
}

async function sourceSnapshot(url: string, sourceId: string, dumpPath: string, passFile: string | null) {
  const client = await connect(url);
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = (await client.query<{ snapshot: string }>('SELECT pg_export_snapshot() AS snapshot')).rows[0]
      ?.snapshot;
    if (!snapshot) fail('SNAPSHOT_UNAVAILABLE');
    const facts = await databaseFacts(client, true);
    if (facts.serverMajor !== REQUIRED_PG_MAJOR) fail('SOURCE_PG_VERSION_UNSUPPORTED');
    const code = await migrationDigest();
    if (facts.migrations.some(name => !code.names.includes(name))) fail('SOURCE_MIGRATION_UNKNOWN');
    await runPgToFile(
      'pg_dump',
      ['--format=custom', '--no-owner', '--no-acl', '--snapshot', snapshot],
      url,
      dumpPath,
      passFile,
      'PG_DUMP_FAILED',
    );
    await client.query('COMMIT');
    await runDiscard('pg_restore', ['--list', dumpPath], 'DUMP_INVALID');
    return {
      ...facts,
      sourceId,
      databaseName: validateUrl(url, 'SOURCE').pathname.slice(1),
      sourceTargetSha256: sourceTargetDigest(validateUrl(url, 'SOURCE')),
      migrationCodeSha256: code.digest,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

export async function encryptArchive(dumpPath: string, archivePath: string, metadata: unknown, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encoded = Buffer.from(JSON.stringify(metadata));
  if (encoded.length > MAX_METADATA_BYTES) fail('METADATA_TOO_LARGE');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(encoded.length);
  const temp = `${archivePath}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    await writeAll(handle, Buffer.concat([MAGIC, iv]));
    await writeAll(handle, cipher.update(Buffer.concat([length, encoded])));
    for await (const chunk of createReadStream(dumpPath) as AsyncIterable<Buffer>)
      await writeAll(handle, cipher.update(chunk));
    await writeAll(handle, cipher.final());
    await writeAll(handle, cipher.getAuthTag());
    await handle.sync();
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  } finally {
    await handle.close();
  }
  await fs.rename(temp, archivePath);
}

export async function decryptArchive(archivePath: string, dumpPath: string, key: Buffer): Promise<ArchiveMetadata> {
  const stat = await fs.stat(archivePath);
  if (!stat.isFile() || stat.size < HEADER_BYTES + TAG_BYTES + 4) fail('ARCHIVE_INVALID');
  const input = await fs.open(archivePath, 'r');
  const header = Buffer.alloc(HEADER_BYTES);
  const tag = Buffer.alloc(TAG_BYTES);
  try {
    if (
      (await input.read(header, 0, header.length, 0)).bytesRead !== header.length ||
      (await input.read(tag, 0, tag.length, stat.size - TAG_BYTES)).bytesRead !== tag.length
    )
      fail('ARCHIVE_INVALID');
  } finally {
    await input.close();
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) fail('ARCHIVE_FORMAT_UNSUPPORTED');
  const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(MAGIC.length));
  decipher.setAuthTag(tag);
  const output = await fs.open(dumpPath, 'wx', 0o600);
  let prefix = Buffer.alloc(0);
  let metadata: ArchiveMetadata | undefined;
  const hash = createHash('sha256');
  let bytes = 0;
  const consume = async (chunk: Buffer) => {
    if (!metadata) {
      prefix = Buffer.concat([prefix, chunk]);
      if (prefix.length < 4) return;
      const length = prefix.readUInt32BE(0);
      if (length === 0 || length > MAX_METADATA_BYTES) fail('ARCHIVE_METADATA_INVALID');
      if (prefix.length < length + 4) return;
      try {
        const parsed: unknown = JSON.parse(prefix.subarray(4, length + 4).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('ARCHIVE_METADATA_INVALID');
        metadata = parsed as ArchiveMetadata;
      } catch {
        fail('ARCHIVE_METADATA_INVALID');
      }
      chunk = prefix.subarray(length + 4);
      prefix = Buffer.alloc(0);
    }
    if (chunk.length) {
      await writeAll(output, chunk);
      hash.update(chunk);
      bytes += chunk.length;
    }
  };
  try {
    for await (const part of createReadStream(archivePath, {
      start: HEADER_BYTES,
      end: stat.size - TAG_BYTES - 1,
    }) as AsyncIterable<Buffer>) {
      await consume(decipher.update(part));
    }
    await consume(decipher.final());
    await output.sync();
    const verified = metadata;
    if (!verified || verified.dumpSha256 !== hash.digest('hex') || verified.dumpBytes !== bytes)
      fail('DUMP_INTEGRITY_FAILED');
    return verified;
  } catch (error) {
    await output.close();
    await fs.rm(dumpPath, { force: true });
    if (['DUMP_INTEGRITY_FAILED', 'FILE_WRITE_FAILED'].includes((error as { code?: string })?.code ?? '')) throw error;
    return fail('ARCHIVE_AUTHENTICATION_FAILED');
  } finally {
    await output.close().catch(() => {});
  }
}

function s3Config() {
  const bucket = process.env.AI_MEMORY_S3_BUCKET;
  if (!bucket) return null;
  const prefix = process.env.AI_MEMORY_S3_PREFIX ?? 'ai-memory';
  if (
    !/^[a-z0-9][a-z0-9.-]{2,62}$/u.test(bucket) ||
    !/^[a-z0-9][a-z0-9/_-]{0,100}$/u.test(prefix) ||
    prefix.includes('..')
  )
    fail('S3_CONFIG_INVALID');
  return { bucket, prefix: prefix.replace(/\/$/u, '') };
}

async function awsJson<T>(args: string[], code: string): Promise<T> {
  const output = await run('aws', ['--no-cli-pager', 's3api', ...args, '--output', 'json'], { failure: code });
  try {
    return JSON.parse(output) as T;
  } catch {
    return fail(code);
  }
}

async function s3Preflight(config: S3Config) {
  const bucket = ['--bucket', config.bucket];
  const [versioning, lock, publicAccess, encryption, policy] = await Promise.all([
    awsJson<AwsVersioning>(['get-bucket-versioning', ...bucket], 'S3_PREFLIGHT_FAILED'),
    awsJson<AwsLock>(['get-object-lock-configuration', ...bucket], 'S3_PREFLIGHT_FAILED'),
    awsJson<AwsPublicAccess>(['get-public-access-block', ...bucket], 'S3_PREFLIGHT_FAILED'),
    awsJson<AwsEncryption>(['get-bucket-encryption', ...bucket], 'S3_PREFLIGHT_FAILED'),
    awsJson<AwsPolicy>(['get-bucket-policy-status', ...bucket], 'S3_PREFLIGHT_FAILED'),
  ]);
  const lockConfiguration = lock.ObjectLockConfiguration;
  const retention = lockConfiguration?.Rule?.DefaultRetention;
  const privateFlags = Object.values(publicAccess.PublicAccessBlockConfiguration ?? {});
  if (
    versioning.Status !== 'Enabled' ||
    lockConfiguration?.ObjectLockEnabled !== 'Enabled' ||
    retention?.Mode !== 'COMPLIANCE' ||
    !((retention.Days ?? 0) >= 30 || (retention.Years ?? 0) >= 1) ||
    privateFlags.length !== 4 ||
    privateFlags.some(value => !value) ||
    policy.PolicyStatus?.IsPublic !== false ||
    !encryption.ServerSideEncryptionConfiguration?.Rules?.some(rule =>
      ['AES256', 'aws:kms'].includes(rule.ApplyServerSideEncryptionByDefault?.SSEAlgorithm ?? ''),
    )
  )
    fail('S3_PROTECTION_INCOMPLETE');
}

async function headProtected(config: S3Config, key: string, expectedBytes: number) {
  const head = await awsJson<AwsHead>(['head-object', '--bucket', config.bucket, '--key', key], 'S3_HEAD_FAILED');
  const retainUntil = Date.parse(head.ObjectLockRetainUntilDate ?? '');
  if (
    !head.VersionId ||
    head.VersionId === 'null' ||
    head.ContentLength !== expectedBytes ||
    head.ObjectLockMode !== 'COMPLIANCE' ||
    !Number.isFinite(retainUntil) ||
    retainUntil < Date.now() + 29 * 86400_000 ||
    !['AES256', 'aws:kms'].includes(head.ServerSideEncryption ?? '')
  )
    fail('S3_OBJECT_UNPROTECTED');
  return head.VersionId;
}

async function s3Download(config: S3Config, key: string, versionId: string, path: string) {
  if (!versionId || !/^[A-Za-z0-9._~+/=-]{1,256}$/u.test(versionId)) fail('S3_VERSION_INVALID');
  await run(
    'aws',
    [
      '--no-cli-pager',
      's3api',
      'get-object',
      '--bucket',
      config.bucket,
      '--key',
      key,
      '--version-id',
      versionId,
      path,
      '--output',
      'json',
    ],
    { failure: 'S3_DOWNLOAD_FAILED' },
  );
}

async function upload(
  config: S3Config,
  archivePath: string,
  manifest: BackupManifest,
  dir: string,
): Promise<BackupManifest> {
  const key = `${config.prefix}/${manifest.backupId}/archive.aimdr`;
  await run(
    'aws',
    [
      '--no-cli-pager',
      's3',
      'cp',
      archivePath,
      `s3://${config.bucket}/${key}`,
      '--only-show-errors',
      '--no-progress',
      '--checksum-algorithm',
      'SHA256',
    ],
    { failure: 'S3_UPLOAD_FAILED' },
  );
  const versionId = await headProtected(config, key, manifest.archiveBytes);
  const verification = join(dir, `.download-verification-${randomUUID()}`);
  try {
    await s3Download(config, key, versionId, verification);
    const actual = await digestFile(verification);
    if (actual.sha256 !== manifest.archiveSha256 || actual.bytes !== manifest.archiveBytes) fail('S3_VERIFY_FAILED');
  } finally {
    await fs.rm(verification, { force: true });
  }
  const completed = { ...manifest, s3: { key, versionId } };
  const manifestPath = join(dir, `.manifest-pending-${manifest.backupId}.json`);
  await atomicJson(manifestPath, completed);
  const manifestKey = `${config.prefix}/${manifest.backupId}/manifest.json`;
  await run(
    'aws',
    [
      '--no-cli-pager',
      's3',
      'cp',
      manifestPath,
      `s3://${config.bucket}/${manifestKey}`,
      '--only-show-errors',
      '--no-progress',
      '--checksum-algorithm',
      'SHA256',
    ],
    { failure: 'S3_MANIFEST_UPLOAD_FAILED' },
  );
  const manifestVersion = await headProtected(config, manifestKey, (await fs.stat(manifestPath)).size);
  const manifestCheck = join(dir, `.manifest-verification-${randomUUID()}`);
  try {
    await s3Download(config, manifestKey, manifestVersion, manifestCheck);
    if ((await digestFile(manifestCheck)).sha256 !== (await digestFile(manifestPath)).sha256)
      fail('S3_MANIFEST_VERIFY_FAILED');
  } finally {
    await fs.rm(manifestCheck, { force: true });
  }
  await fs.rename(manifestPath, join(dir, `${manifest.backupId}.manifest.json`));
  return completed;
}

async function pendingCandidate(
  dir: string,
  config: S3Config,
  sourceId: string,
  sourceTarget: URL,
  key: Buffer,
): Promise<{ archivePath: string; manifest: BackupManifest } | null> {
  const path = join(dir, 'pending.json');
  let pending: PendingCheckpoint;
  try {
    pending = await readJson<PendingCheckpoint>(path);
  } catch {
    if (await fs.stat(path).catch(() => null)) {
      await fs.rename(path, join(dir, `.pending-rejected-${randomUUID()}.json`));
      log('pending_rejected', { reason: 'unreadable' });
    }
    return null;
  }
  if (!pending || !isManifest(pending.manifest)) {
    await fs.rename(path, join(dir, `.pending-rejected-${randomUUID()}.json`));
    log('pending_rejected', { reason: 'incompatible_or_corrupt' });
    return null;
  }
  const archivePath = join(dir, `${pending.manifest.backupId}.aimdr`);
  const expected = pending.manifest;
  const code = await migrationDigest();
  const script = await digestFile(fileURLToPath(import.meta.url));
  let valid =
    pending.bucket === config.bucket &&
    pending.prefix === config.prefix &&
    pending.sourceIdSha256 === createHash('sha256').update(sourceId).digest('hex') &&
    pending.sourceTargetSha256 === sourceTargetDigest(sourceTarget) &&
    pending.keySha256 === createHash('sha256').update(key).digest('hex') &&
    pending.migrationCodeSha256 === code.digest &&
    pending.scriptSha256 === script.sha256 &&
    Date.now() - Date.parse(expected?.createdAt) <= PENDING_MAX_AGE_MS &&
    /^[a-f0-9-]{36}$/u.test(expected?.backupId ?? '');
  if (valid) {
    const actual = await digestFile(archivePath).catch(() => null);
    valid = actual?.sha256 === expected.archiveSha256 && actual?.bytes === expected.archiveBytes;
  }
  if (valid) {
    const probe = join(dir, `.pending-decrypt-${randomUUID()}`);
    try {
      const metadata = await decryptArchive(archivePath, probe, key);
      valid =
        metadata.backupId === expected.backupId &&
        metadata.sourceId === sourceId &&
        metadata.databaseName === sourceTarget.pathname.slice(1) &&
        metadata.sourceTargetSha256 === sourceTargetDigest(sourceTarget) &&
        metadata.migrationCodeSha256 === code.digest;
    } catch {
      valid = false;
    } finally {
      await fs.rm(probe, { force: true });
    }
  }
  if (valid) return { archivePath, manifest: expected };
  await fs.rename(path, join(dir, `.pending-rejected-${randomUUID()}.json`));
  log('pending_rejected', { reason: 'incompatible_or_corrupt' });
  return null;
}

async function backup() {
  const started = Date.now();
  const dir = await secureDirectory();
  let key: Buffer | undefined;
  const attemptPath = join(dir, 'last-attempt.json');
  let stage = 'preflight';
  const enterStage = async (name: string, fields: Record<string, unknown> = {}) => {
    stage = name;
    await atomicJson(attemptPath, { state: 'running', stage, startedAt: new Date(started).toISOString() });
    log(stage, { elapsedMs: Date.now() - started, ...fields });
  };
  try {
    await enterStage('preflight');
    const url = process.env.AI_MEMORY_BACKUP_DATABASE_URL_FILE
      ? await secureSecretFile(process.env.AI_MEMORY_BACKUP_DATABASE_URL_FILE, dir, 'DATABASE_URL')
      : process.env.AI_MEMORY_DATABASE_URL;
    const sourceTarget = validateUrl(url, 'SOURCE');
    const sourceUrl = sourceTarget.toString();
    if (
      !/^ai_memory(?:_[a-z0-9_]+)?$/u.test(sourceTarget.pathname.slice(1)) ||
      sourceTarget.pathname.includes('_restore_')
    )
      fail('SOURCE_DATABASE_UNSAFE');
    const sourceId = requireSourceId();
    key = await secureKey(dir);
    const config = s3Config();
    if (config) await s3Preflight(config);
    let candidate = config ? await pendingCandidate(dir, config, sourceId, sourceTarget, key) : null;
    if (!candidate) {
      await pgCommandVersion('pg_dump');
      await pgCommandVersion('pg_restore');
      const backupId = randomUUID();
      const work = await fs.mkdtemp(join(dir, '.backup-'));
      await fs.chmod(work, 0o700);
      try {
        const dumpPath = join(work, 'database.dump');
        const client = await connect(sourceUrl);
        const size = Number(
          (await client.query<{ size: string }>('SELECT pg_database_size(current_database())::text AS size')).rows[0]
            ?.size,
        );
        await client.end();
        const available = await freeBytes(dir);
        if (available < size * 2 + 128 * 1024 * 1024) fail('DISK_CAPACITY_LOW');
        await enterStage('snapshot', { estimatedBytes: size, availableBytes: available, reused: 0 });
        const passFile = await createPgPass(sourceUrl, work);
        const facts = await sourceSnapshot(sourceUrl, sourceId, dumpPath, passFile);
        const dump = await digestFile(dumpPath);
        await enterStage('encrypt', { dumpBytes: dump.bytes, completedUnits: 1, remainingUnits: config ? 3 : 1 });
        const metadata: ArchiveMetadata = {
          format: 1,
          backupId,
          createdAt: new Date().toISOString(),
          ...facts,
          dumpSha256: dump.sha256,
          dumpBytes: dump.bytes,
        };
        const archivePath = join(dir, `${backupId}.aimdr`);
        await encryptArchive(dumpPath, archivePath, metadata, key);
        const archive = await digestFile(archivePath);
        const manifest: BackupManifest = {
          format: 1,
          backupId,
          createdAt: metadata.createdAt,
          archiveSha256: archive.sha256,
          archiveBytes: archive.bytes,
        };
        candidate = { archivePath, manifest };
        if (config) {
          const script = await digestFile(fileURLToPath(import.meta.url));
          await atomicJson(join(dir, 'pending.json'), {
            manifest,
            bucket: config.bucket,
            prefix: config.prefix,
            sourceIdSha256: createHash('sha256').update(sourceId).digest('hex'),
            sourceTargetSha256: sourceTargetDigest(sourceTarget),
            keySha256: createHash('sha256').update(key).digest('hex'),
            migrationCodeSha256: metadata.migrationCodeSha256,
            scriptSha256: script.sha256,
          });
        }
      } finally {
        await fs.rm(work, { recursive: true, force: true });
      }
    } else log('reused_encrypted_archive', { elapsedMs: Date.now() - started, bytes: candidate.manifest.archiveBytes });
    await enterStage(config ? 'upload_and_verify' : 'local_publish', {
      archiveBytes: candidate.manifest.archiveBytes,
      reused: candidate.manifest.createdAt < new Date(started).toISOString() ? 1 : 0,
    });
    const completed = config
      ? await upload(config, candidate.archivePath, candidate.manifest, dir)
      : candidate.manifest;
    if (!config) await atomicJson(join(dir, `${completed.backupId}.manifest.json`), completed);
    await atomicJson(join(dir, 'last-success.json'), {
      completedAt: new Date().toISOString(),
      createdAt: completed.createdAt,
      backupId: completed.backupId,
      mode: config ? 's3' : 'local',
    });
    await atomicJson(attemptPath, {
      state: 'success',
      stage: 'complete',
      startedAt: new Date(started).toISOString(),
      endedAt: new Date().toISOString(),
    });
    if (config) await fs.rm(join(dir, 'pending.json'), { force: true });
    log('complete', {
      elapsedMs: Date.now() - started,
      archiveBytes: completed.archiveBytes,
      throughputBytesPerSec: Math.round(completed.archiveBytes / Math.max(1, (Date.now() - started) / 1000)),
      mode: config ? 's3' : 'local',
    });
  } catch (error) {
    await atomicJson(attemptPath, {
      state: 'failed',
      stage,
      startedAt: new Date(started).toISOString(),
      endedAt: new Date().toISOString(),
      reason: errorCode(error),
    });
    throw error;
  } finally {
    key?.fill(0);
  }
}

async function status() {
  const dir = await secureDirectory();
  const attempt = await readJson<BackupAttempt>(join(dir, 'last-attempt.json')).catch(() => null);
  const success = await readJson<BackupSuccess>(join(dir, 'last-success.json')).catch(() => null);
  const maxHours = Number(process.env.AI_MEMORY_BACKUP_MAX_AGE_HOURS ?? DEFAULT_MAX_AGE_HOURS);
  if (!Number.isFinite(maxHours) || maxHours <= 0 || maxHours > 720) fail('FRESHNESS_CONFIG_INVALID');
  const ageHours = success ? (Date.now() - Date.parse(success.createdAt)) / 3600_000 : null;
  const stalled = attempt?.state === 'running' && Date.now() - Date.parse(attempt.startedAt) > 2 * 3600_000;
  const state =
    attempt?.state === 'failed'
      ? 'failed'
      : !success
        ? 'missing'
        : stalled
          ? 'stalled'
          : ageHours === null || !Number.isFinite(ageHours) || ageHours < 0
            ? 'invalid'
            : ageHours > maxHours
              ? 'stale'
              : 'healthy';
  log('status', {
    state,
    ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
    maxHours,
    lastAttempt: attempt?.state ?? 'missing',
    mode: success?.mode ?? null,
  });
  if (state !== 'healthy') fail(`BACKUP_${state.toUpperCase()}`);
}

export async function checkSequences(client: PgClient, expectedNames: string[]) {
  const rows = (
    await client.query<{
      schema: string;
      name: string;
      table_schema: string | null;
      table_name: string | null;
      column_name: string | null;
    }>(`
    SELECT ns.nspname AS schema, seq.relname AS name, nt.nspname AS table_schema,
      tab.relname AS table_name, att.attname AS column_name
    FROM pg_class seq JOIN pg_namespace ns ON ns.oid = seq.relnamespace
    LEFT JOIN pg_depend dep ON dep.objid = seq.oid AND dep.deptype IN ('a', 'i')
    LEFT JOIN pg_class tab ON tab.oid = dep.refobjid
    LEFT JOIN pg_namespace nt ON nt.oid = tab.relnamespace
    LEFT JOIN pg_attribute att ON att.attrelid = tab.oid AND att.attnum = dep.refobjsubid
    WHERE seq.relkind = 'S' AND ns.nspname NOT LIKE 'pg_%' ORDER BY 1, 2`)
  ).rows;
  const names = rows.map(row => `${row.schema}.${row.name}`).sort();
  if (JSON.stringify(names) !== JSON.stringify([...expectedNames].sort())) fail('SEQUENCE_SET_MISMATCH');
  for (const row of rows) {
    const state = (
      await client.query<{ value: string; is_called: boolean }>(
        `SELECT last_value::text AS value, is_called FROM ${quote(row.schema)}.${quote(row.name)}`,
      )
    ).rows[0];
    if (!state) fail('SEQUENCE_STATE_MISSING');
    if (!row.table_schema || !row.table_name || !row.column_name) continue;
    const maximum = (
      await client.query<{ value: string | null }>(
        `SELECT max(${quote(row.column_name)})::text AS value FROM ${quote(row.table_schema)}.${quote(row.table_name)}`,
      )
    ).rows[0]?.value;
    if (
      maximum !== null &&
      maximum !== undefined &&
      (BigInt(state.value) < BigInt(maximum) || (BigInt(state.value) === BigInt(maximum) && !state.is_called))
    )
      fail('SEQUENCE_BEHIND_DATA');
  }
}

async function restore() {
  const started = Date.now();
  const dir = await secureDirectory();
  const key = await secureKey(dir);
  const expectedSource = process.env.AI_MEMORY_RESTORE_EXPECT_SOURCE_ID;
  if (!expectedSource || !/^[a-z0-9._-]{8,128}$/iu.test(expectedSource)) fail('EXPECTED_SOURCE_REQUIRED');
  const adminUrl = process.env.AI_MEMORY_RESTORE_ADMIN_URL;
  const adminParsed = validateUrl(adminUrl, 'RESTORE_ADMIN');
  if (adminParsed.pathname !== '/postgres') fail('RESTORE_ADMIN_TARGET_UNSAFE');
  const targetName =
    process.env.AI_MEMORY_RESTORE_TARGET_NAME ??
    `ai_memory_restore_${new Date().toISOString().replace(/\D/gu, '').slice(0, 14)}_${randomBytes(3).toString('hex')}`;
  if (!/^ai_memory_restore_[a-z0-9_]{8,64}$/u.test(targetName)) fail('RESTORE_TARGET_UNSAFE');
  const targetUrl = new URL(adminParsed);
  targetUrl.pathname = `/${targetName}`;
  const work = await fs.mkdtemp(join(dir, '.restore-'));
  await fs.chmod(work, 0o700);
  let created = false;
  try {
    const config = s3Config();
    let manifest: BackupManifest;
    let archivePath: string;
    if (process.env.AI_MEMORY_RESTORE_MANIFEST_FILE) {
      const path = resolve(process.env.AI_MEMORY_RESTORE_MANIFEST_FILE);
      const real = await fs.realpath(path);
      if (inside(real, REPO_ROOT) || (await fs.lstat(path)).isSymbolicLink()) fail('RESTORE_PATH_UNSAFE');
      const parsed = await readJson<unknown>(real);
      if (!isManifest(parsed)) fail('MANIFEST_INVALID');
      manifest = parsed;
      archivePath = join(dirname(real), `${manifest.backupId}.aimdr`);
      const archiveLink = await fs.lstat(archivePath).catch(() => fail('RESTORE_PATH_UNSAFE'));
      if (!archiveLink.isFile() || archiveLink.isSymbolicLink() || inside(await fs.realpath(archivePath), REPO_ROOT))
        fail('RESTORE_PATH_UNSAFE');
    } else {
      if (!config || !process.env.AI_MEMORY_RESTORE_MANIFEST_KEY || !process.env.AI_MEMORY_RESTORE_MANIFEST_VERSION)
        fail('RESTORE_SOURCE_REQUIRED');
      const keyName = process.env.AI_MEMORY_RESTORE_MANIFEST_KEY;
      if (!keyName.startsWith(`${config.prefix}/`) || !keyName.endsWith('/manifest.json') || keyName.includes('..'))
        fail('RESTORE_SOURCE_UNSAFE');
      const manifestPath = join(work, 'manifest.json');
      await s3Download(config, keyName, process.env.AI_MEMORY_RESTORE_MANIFEST_VERSION, manifestPath);
      const parsed = await readJson<unknown>(manifestPath);
      if (!isManifest(parsed) || keyName !== `${config.prefix}/${parsed.backupId}/manifest.json`)
        fail('MANIFEST_INVALID');
      manifest = parsed;
      archivePath = join(work, 'archive.aimdr');
      if (manifest.s3?.key !== `${config.prefix}/${manifest.backupId}/archive.aimdr`) fail('RESTORE_SOURCE_UNSAFE');
      await s3Download(config, manifest.s3.key, manifest.s3.versionId, archivePath);
    }
    if (manifest.format !== 1 || !/^[a-f0-9-]{36}$/u.test(manifest.backupId ?? '')) fail('MANIFEST_INVALID');
    const archive = await digestFile(archivePath);
    if (archive.sha256 !== manifest.archiveSha256 || archive.bytes !== manifest.archiveBytes)
      fail('ARCHIVE_INTEGRITY_FAILED');
    if ((await freeBytes(dir)) < archive.bytes * 2 + 128 * 1024 * 1024) fail('DISK_CAPACITY_LOW');
    const dumpPath = join(work, 'database.dump');
    const metadata = await decryptArchive(archivePath, dumpPath, key);
    const expectedDatabase = process.env.AI_MEMORY_RESTORE_EXPECT_DATABASE;
    if (!expectedDatabase || !/^ai_memory(?:_[a-z0-9_]+)?$/u.test(expectedDatabase)) fail('EXPECTED_DATABASE_REQUIRED');
    if (
      metadata.format !== 1 ||
      metadata.backupId !== manifest.backupId ||
      metadata.sourceId !== expectedSource ||
      metadata.databaseName !== expectedDatabase ||
      metadata.serverMajor !== REQUIRED_PG_MAJOR
    )
      fail('BACKUP_IDENTITY_MISMATCH');
    const code = await migrationDigest();
    if (metadata.migrationCodeSha256 !== code.digest || metadata.migrations.some(name => !code.names.includes(name)))
      fail('MIGRATION_CODE_MISMATCH');
    await pgCommandVersion('pg_restore');
    await runDiscard('pg_restore', ['--list', dumpPath], 'DUMP_INVALID');
    const admin = await connect(adminParsed.toString());
    try {
      const server = Number(
        (await admin.query<{ server_version_num: string }>('SHOW server_version_num')).rows[0]?.server_version_num,
      );
      if (Math.floor(server / 10000) !== metadata.serverMajor) fail('TARGET_PG_VERSION_MISMATCH');
      const available = (
        await admin.query<{ name: string; version: string }>(
          'SELECT name, version FROM pg_available_extension_versions',
        )
      ).rows;
      if (
        metadata.extensions.some(
          extension => !available.some(row => row.name === extension.extname && row.version === extension.extversion),
        )
      )
        fail('TARGET_EXTENSION_UNAVAILABLE');
      const existing = (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [targetName])).rowCount;
      if (existing) fail('RESTORE_TARGET_EXISTS');
      await admin.query(`CREATE DATABASE ${quote(targetName)}`);
      created = true;
    } finally {
      await admin.end();
    }
    log('restore_created_empty_target', { elapsedMs: Date.now() - started });
    const passFile = await createPgPass(targetUrl.toString(), work);
    await run(
      'pg_restore',
      ['--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', '--dbname', targetName, dumpPath],
      { env: pgEnv(targetUrl.toString(), passFile), failure: 'PG_RESTORE_FAILED', timeout: 60 * 60 * 1000 },
    );
    const target = await connect(targetUrl.toString());
    try {
      const actual = await databaseFacts(target, true);
      if (
        actual.serverMajor !== metadata.serverMajor ||
        actual.hasEmbeddingColumn !== metadata.hasEmbeddingColumn ||
        JSON.stringify(actual.extensions) !== JSON.stringify(metadata.extensions) ||
        JSON.stringify(actual.migrations) !== JSON.stringify(metadata.migrations) ||
        JSON.stringify(actual.tableNames) !== JSON.stringify(metadata.tableNames) ||
        JSON.stringify(actual.rowCounts) !== JSON.stringify(metadata.rowCounts)
      )
        fail('RESTORE_DATA_MISMATCH');
      await checkSequences(target, metadata.sequenceNames);
    } finally {
      await target.end();
    }
    await run(process.execPath, [resolve(SCRIPT_DIR, '../dist/smoke-ingest.js')], {
      env: { ...process.env, AI_MEMORY_DATABASE_URL: targetUrl.toString() },
      failure: 'RESTORE_SMOKE_FAILED',
    });
    await run(process.execPath, [resolve(SCRIPT_DIR, '../dist/restore-smoke.js')], {
      env: { ...process.env, AI_MEMORY_DATABASE_URL: targetUrl.toString() },
      failure: 'RESTORE_SMOKE_FAILED',
    });
    log('restore_verified', {
      elapsedMs: Date.now() - started,
      tables: metadata.tableNames.length,
      sequences: metadata.sequenceNames.length,
    });
  } catch (error) {
    if (created) log('restore_target_preserved_for_inspection');
    throw error;
  } finally {
    key.fill(0);
    await fs.rm(work, { recursive: true, force: true });
  }
}

async function main() {
  const command = process.argv[2];
  try {
    if (command === 'backup') await backup();
    else if (command === 'status') await status();
    else if (command === 'restore') await restore();
    else fail('USAGE_BACKUP_STATUS_RESTORE');
  } catch (error) {
    process.stderr.write(`[ai-memory-dr] ${command ?? 'command'} failed: ${errorCode(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main();
