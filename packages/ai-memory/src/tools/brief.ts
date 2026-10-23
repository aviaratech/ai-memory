import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { DbPool } from '../db/pool.js';
import { createPool } from '../db/pool.js';
import { toMemoryRecord } from '../db/records.js';
import { pool } from '../db/runtime.js';
import { isRecord } from '../db/type-guards.js';
import { loadPluginRuntimeEnv } from './pluginEnv.js';

// Leave space in the existing 8,000-character host envelope for guidance and
// cache provenance. The same item budget applies to CLI and hook output.
export const BRIEF_MAX_CHARS = 7500;
export interface BriefScope {
  project: string;
  host: string;
  role: string;
}
interface CachedBrief {
  text: string;
  generatedAt: string;
}
interface BriefDependencies {
  cacheDir?: string | undefined;
  load?: ((scope: BriefScope) => Promise<Record<string, unknown>[]>) | undefined;
  now?: (() => Date) | undefined;
  onCacheError?: ((error: unknown) => void) | undefined;
}

export function resolveBriefScope(scope: BriefScope): BriefScope {
  if (
    !scope.project.trim() ||
    scope.project.length > 240 ||
    /[\r\n]/u.test(scope.project) ||
    scope.project.includes(String.fromCharCode(0))
  )
    throw new Error('Select a project of at most 240 characters.');
  if (!['claude-code', 'codex'].includes(scope.host)) throw new Error('Select --host claude-code|codex.');
  if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(scope.role))
    throw new Error('Select a role of 1–64 letters, digits, dots, underscores or hyphens.');
  return { project: scope.project.trim(), host: scope.host, role: scope.role };
}

function roleStateKeys(scope: BriefScope): [string, string] {
  return [`${scope.project}:state/${scope.role}`, `state/${scope.role}`];
}

export async function loadBriefMemories(
  scope: BriefScope,
  database: Pick<DbPool, 'query'> = pool,
): Promise<Record<string, unknown>[]> {
  const result = await database.query<Record<string, unknown>>(
    `
    SELECT id, project, category, memory_key, content, pinned, audience, status,
      importance, last_verified_at, updated_at, evidence_refs, expires_at FROM ai_memory_entries
    WHERE project = $1 AND status = 'active' AND (expires_at IS NULL OR expires_at > NOW())
      AND (pinned OR (category = 'state' AND memory_key = ANY($2::text[])))
      AND audience && $3::text[]
  `,
    [scope.project, roleStateKeys(scope), ['all', scope.host, scope.role]],
  );
  return result.rows.map(toMemoryRecord);
}

export function buildBrief(input: BriefScope, memories: readonly Record<string, unknown>[]): string {
  const scope = resolveBriefScope(input);
  const [stateKey, legacyKey] = roleStateKeys(scope);
  const eligible = memories.filter(
    memory =>
      memory.project === scope.project &&
      memory.status === 'active' &&
      typeof memory.memoryKey === 'string' &&
      memory.memoryKey.length > 0 &&
      (memory.pinned === true || (memory.category === 'state' && [stateKey, legacyKey].includes(memory.memoryKey))) &&
      (memory.category !== 'state' || [stateKey, legacyKey].includes(memory.memoryKey)) &&
      (memory.expiresAt == null || Date.parse(String(memory.expiresAt)) > Date.now()) &&
      matchesBriefAudience(memory, scope.host, scope.role),
  );
  const hasCanonicalState = eligible.some(memory => memory.category === 'state' && memory.memoryKey === stateKey);
  const selected = eligible
    .filter(memory => memory.category !== 'state' || memory.memoryKey === stateKey || !hasCanonicalState)
    .sort((a, b) => {
      const state = Number(b.category === 'state') - Number(a.category === 'state');
      const importance = Number(b.importance ?? 0) - Number(a.importance ?? 0);
      const keyA = String(a.memoryKey);
      const keyB = String(b.memoryKey);
      return state || importance || (keyA < keyB ? -1 : keyA > keyB ? 1 : Number(a.id) - Number(b.id));
    });
  const header = `### Project brief: ${scope.project} (${scope.host}, role ${scope.role})`;
  const lines = selected.map(memory => {
    const evidence: unknown = Array.isArray(memory.evidenceRefs) ? memory.evidenceRefs[0] : undefined;
    const source: unknown = isRecord(evidence)
      ? (evidence.url ?? evidence.path ?? evidence.issue ?? evidence.pr)
      : evidence;
    const updated = memory.category === 'state' ? `; updated ${oneLine(memory.updatedAt)}` : '';
    return `- [${oneLine(memory.memoryKey)}] verified ${oneLine(memory.lastVerifiedAt ?? memory.updatedAt)}${updated}; source ${oneLine(source)}: ${oneLine(memory.content)}`;
  });
  let omitted = 0;
  const footer = () =>
    omitted === 0
      ? ''
      : `\n${String(omitted)} items omitted; use memory_search with project ${scope.project} and the missing key or topic.`;
  let length = header.length + lines.reduce((sum, line) => sum + line.length + 1, 0);
  while (lines.length > 0 && length + footer().length > BRIEF_MAX_CHARS) {
    length -= lines.pop()!.length + 1;
    omitted += 1;
  }
  return [header, ...lines].join('\n') + footer();
}

export function matchesBriefAudience(memory: Record<string, unknown>, host: string | undefined, role: string): boolean {
  const audience: unknown[] = Array.isArray(memory.audience) ? memory.audience : ['all'];
  return audience.some(tag => tag === 'all' || tag === host || tag === role);
}

function oneLine(value: unknown): string {
  return String(value ?? 'unknown')
    .replace(/[\r\n\t]+/gu, ' ')
    .trim();
}

function cacheDirectory(): string {
  const directory = process.env.AI_MEMORY_BRIEF_CACHE_DIR?.trim();
  return directory === undefined || directory.length === 0
    ? join(homedir(), '.cache', 'ai-memory', 'briefs')
    : directory;
}

export function briefCachePath(input: BriefScope, directory = cacheDirectory()): string {
  const scope = resolveBriefScope(input);
  const key = createHash('sha256').update(JSON.stringify(scope)).digest('hex');
  return join(directory, `${key}.json`);
}

export async function readCachedBrief(input: BriefScope, directory?: string): Promise<CachedBrief | undefined> {
  const scope = resolveBriefScope(input);
  try {
    const file = await open(briefCachePath(scope, directory), constants.O_RDONLY | constants.O_NOFOLLOW);
    let contents: string;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 64000) return undefined;
      const buffer = Buffer.alloc(64001);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 64000) return undefined;
      contents = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await file.close();
    }
    const value: unknown = JSON.parse(contents);
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      JSON.stringify(value.scope) !== JSON.stringify(scope) ||
      typeof value.text !== 'string' ||
      value.text.length > BRIEF_MAX_CHARS ||
      typeof value.generatedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.generatedAt))
    )
      return undefined;
    return { text: value.text, generatedAt: value.generatedAt };
  } catch {
    return undefined;
  }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function refreshBrief(input: BriefScope, dependencies: BriefDependencies = {}): Promise<string> {
  const scope = resolveBriefScope(input);
  const text = buildBrief(scope, await (dependencies.load ?? loadBriefMemories)(scope));
  try {
    await atomicWrite(
      briefCachePath(scope, dependencies.cacheDir),
      JSON.stringify({
        version: 1,
        scope,
        text,
        generatedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
      }),
    );
  } catch (error) {
    dependencies.onCacheError?.(error);
  }
  return text;
}

export function parseBriefArguments(args: readonly string[]): BriefScope & { out?: string } {
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (
      flag === undefined ||
      !['--project', '--host', '--role', '--out'].includes(flag) ||
      values[flag] !== undefined ||
      !value ||
      value.startsWith('--')
    ) {
      throw new Error('Usage: ai-memory brief --project <p> --host claude-code|codex --role <r> [--out <file>]');
    }
    values[flag] = value;
  }
  const scope = resolveBriefScope({
    project: values['--project'] ?? '',
    host: values['--host'] ?? '',
    role: values['--role'] ?? '',
  });
  return { ...scope, ...(values['--out'] === undefined ? {} : { out: values['--out'] }) };
}

export async function runBriefCli(
  args: readonly string[],
  dependencies?: { refresh: (scope: BriefScope) => Promise<string>; write: (text: string) => void },
): Promise<void> {
  const { out, ...scope } = parseBriefArguments(args);
  let database: DbPool | undefined;
  let cacheDir: string | undefined;
  try {
    if (dependencies === undefined) {
      const configuration = loadPluginRuntimeEnv();
      const target = configuration.runtime.databaseTarget;
      if (target === undefined) throw new Error('Configure the protected loopback database before generating a brief.');
      cacheDir = configuration.env.AI_MEMORY_BRIEF_CACHE_DIR;
      database = createPool({ connectionString: target.databaseUrl, max: 1, statementTimeoutMs: 1000 });
    }
    const text = await (
      dependencies?.refresh ??
      ((request: BriefScope) => refreshBrief(request, { cacheDir, load: scope => loadBriefMemories(scope, database) }))
    )(scope);
    if (out !== undefined) await atomicWrite(out, `${text}\n`);
    else
      (
        dependencies?.write ??
        (value => {
          process.stdout.write(value);
        })
      )(`${text}\n`);
  } finally {
    await database?.end();
  }
}
