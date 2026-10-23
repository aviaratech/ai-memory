import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DbPool } from '../db/pool.js';
import { createPool } from '../db/pool.js';
import { toMemoryRecord } from '../db/records.js';
import { isRecord } from '../db/type-guards.js';
import { loadPluginRuntimeEnv } from './pluginEnv.js';

const DAY_MS = 86400000;
export type StaleReason = 'unverified_30d' | 'evidence_closed';
type ClosureLookup = (project: string | null, evidence: unknown) => Promise<string | undefined>;
export interface StaleMemory {
  project: string | null;
  memoryKey: string;
  lastVerifiedAt: string | null;
  reasons: StaleReason[];
}

export function verificationReasons(memory: Record<string, unknown>, now = new Date()): StaleReason[] {
  const verified = Date.parse(String(memory.lastVerifiedAt ?? ''));
  return !Number.isFinite(verified) || now.getTime() - verified >= 30 * DAY_MS ? ['unverified_30d'] : [];
}

export async function findStaleMemories(
  memories: readonly Record<string, unknown>[],
  options: { now?: Date; project?: string; lookupClosure?: ClosureLookup } = {},
): Promise<StaleMemory[]> {
  const now = options.now ?? new Date();
  const result: StaleMemory[] = [];
  for (const memory of memories) {
    if (
      memory.status !== 'active' ||
      (memory.project !== null && typeof memory.project !== 'string') ||
      typeof memory.memoryKey !== 'string' ||
      !memory.memoryKey ||
      (options.project !== undefined && memory.project !== options.project) ||
      (memory.expiresAt != null && !(Date.parse(String(memory.expiresAt)) > now.getTime()))
    )
      continue;
    const reasons = verificationReasons(memory, now);
    const verified = Date.parse(String(memory.lastVerifiedAt ?? ''));
    for (const evidence of Array.isArray(memory.evidenceRefs) ? memory.evidenceRefs : []) {
      const closed = await options.lookupClosure?.(memory.project, evidence);
      if (closed !== undefined && Date.parse(closed) > verified && Date.parse(closed) <= now.getTime()) {
        reasons.push('evidence_closed');
        break;
      }
    }
    if (reasons.length > 0)
      result.push({
        project: memory.project,
        memoryKey: memory.memoryKey,
        lastVerifiedAt: Number.isFinite(verified) ? new Date(verified).toISOString() : null,
        reasons,
      });
  }
  return result;
}

function githubReference(evidence: unknown): { url: string; api: string } | undefined {
  const value = isRecord(evidence) ? (evidence.url ?? evidence.issue ?? evidence.pr) : evidence;
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.host !== 'github.com' || url.username || url.password) return undefined;
    const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(issues|pull)\/([1-9][0-9]*)\/?$/u.exec(url.pathname);
    if (match === null) return undefined;
    const [, owner, repo, kind, number] = match;
    const path = `${owner}/${repo}/${kind}/${number}`;
    return {
      url: `https://github.com/${path}`,
      api: `https://api.github.com/repos/${owner}/${repo}/${kind === 'pull' ? 'pulls' : 'issues'}/${number}`,
    };
  } catch {
    return undefined;
  }
}

/** Reuses the brief's private cache directory and atomic, bounded file pattern; no database cache or service. */
export function createGithubEvidenceLookup(
  options: {
    token?: string;
    cacheDir?: string;
    cacheOnly?: boolean;
    now?: () => Date;
    fetch?: typeof fetch;
    warn?: (message: string) => void;
  } = {},
): ClosureLookup {
  const configuredDirectory = process.env.AI_MEMORY_BRIEF_CACHE_DIR?.trim();
  const directory =
    options.cacheDir ??
    (configuredDirectory === undefined || configuredDirectory.length === 0
      ? join(homedir(), '.cache', 'ai-memory', 'briefs')
      : configuredDirectory);
  const pending = new Map<string, Promise<string | undefined>>();
  let warned = false;
  return (project, evidence) => {
    const reference = githubReference(evidence);
    if (reference === undefined) return Promise.resolve(undefined);
    const identity = JSON.stringify([project, reference.url]);
    let result = pending.get(identity);
    if (result === undefined) {
      result = lookup(project, reference, identity);
      pending.set(identity, result);
    }
    return result;
  };
  async function lookup(
    project: string | null,
    reference: { url: string; api: string },
    identity: string,
  ): Promise<string | undefined> {
    const path = join(directory, `evidence-${createHash('sha256').update(identity).digest('hex')}.json`);
    const now = (options.now ?? (() => new Date()))();
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let cached: unknown;
      try {
        const buffer = Buffer.alloc(8193);
        if (!(await file.stat()).isFile()) return undefined;
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead <= 8192) cached = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      } finally {
        await file.close();
      }
      if (
        isRecord(cached) &&
        cached.version === 1 &&
        cached.project === project &&
        cached.url === reference.url &&
        typeof cached.fetchedAt === 'string' &&
        Date.parse(cached.fetchedAt) <= now.getTime() &&
        now.getTime() - Date.parse(cached.fetchedAt) < DAY_MS &&
        (cached.closedAt === null ||
          (typeof cached.closedAt === 'string' && Number.isFinite(Date.parse(cached.closedAt))))
      ) {
        return typeof cached.closedAt === 'string' ? cached.closedAt : undefined;
      }
    } catch {
      /* Cache misses and malformed files never suppress age checks. */
    }
    if (options.cacheOnly === true || !options.token?.trim()) return undefined;
    try {
      const response = await (options.fetch ?? fetch)(reference.api, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${options.token}`,
          'X-GitHub-Api-Version': '2026-03-10',
        },
      });
      if (!response.ok) throw new Error('github_evidence_unavailable');
      const value: unknown = await response.json();
      if (
        !isRecord(value) ||
        (value.closed_at !== null &&
          (typeof value.closed_at !== 'string' || !Number.isFinite(Date.parse(value.closed_at))))
      )
        throw new Error('github_evidence_invalid');
      const closedAt = typeof value.closed_at === 'string' ? new Date(value.closed_at).toISOString() : null;
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(
          temporary,
          JSON.stringify({ version: 1, project, url: reference.url, fetchedAt: now.toISOString(), closedAt }),
          { mode: 0o600, flag: 'wx' },
        );
        await rename(temporary, path);
      } catch {
        /* Read results remain usable if the private cache is unwritable. */
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
      }
      return closedAt ?? undefined;
    } catch {
      if (!warned) {
        warned = true;
        options.warn?.('GitHub evidence checks unavailable; verification-age checks still apply.');
      }
      return undefined;
    }
  }
}

export async function loadStaleMemories(
  project: string | undefined,
  database: Pick<DbPool, 'query'>,
): Promise<Record<string, unknown>[]> {
  const result = await database.query<Record<string, unknown>>(
    `
    SELECT id, project, memory_key, status, last_verified_at, evidence_refs, expires_at
    FROM ai_memory_entries WHERE status='active' AND memory_key IS NOT NULL
      AND (expires_at IS NULL OR expires_at > NOW()) AND ($1::text IS NULL OR project=$1)
    ORDER BY project, memory_key, id`,
    [project ?? null],
  );
  return result.rows.map(toMemoryRecord);
}

export async function runStaleCli(
  args: readonly string[],
  dependencies: {
    load?: (project: string | undefined) => Promise<Record<string, unknown>[]>;
    lookupClosure?: ClosureLookup;
    now?: () => Date;
    env?: NodeJS.ProcessEnv;
    write?: (text: string) => void;
    warn?: (text: string) => void;
  } = {},
): Promise<void> {
  let project: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--project' && project === undefined) {
      project = args[++i]?.trim();
      if (
        !project ||
        project.startsWith('--') ||
        project.length > 240 ||
        /[\r\n]/u.test(project) ||
        project.includes(String.fromCharCode(0))
      )
        throw new Error('Select --project <p>.');
    } else throw new Error('Usage: ai-memory stale [--project <p>] [--json]');
  }
  let database: DbPool | undefined;
  try {
    const configuration = dependencies.load === undefined ? loadPluginRuntimeEnv() : undefined;
    if (configuration !== undefined) {
      const target = configuration.runtime.databaseTarget;
      if (target === undefined)
        throw new Error('Configure the protected loopback database before checking stale memories.');
      database = createPool({ connectionString: target.databaseUrl, max: 1, statementTimeoutMs: 5000 });
    }
    const env = dependencies.env ?? process.env;
    const primaryToken = env.GH_TOKEN?.trim();
    const token = primaryToken === undefined || primaryToken.length === 0 ? env.GITHUB_TOKEN?.trim() : primaryToken;
    const warn =
      dependencies.warn ??
      (text => {
        process.stderr.write(`[ai-memory:stale] ${text}\n`);
      });
    if (!token) warn('No GitHub token; using cached evidence and verification-age checks only.');
    const lookupClosure =
      dependencies.lookupClosure ??
      createGithubEvidenceLookup({
        ...(token ? { token } : {}),
        ...(configuration?.env.AI_MEMORY_BRIEF_CACHE_DIR
          ? { cacheDir: configuration.env.AI_MEMORY_BRIEF_CACHE_DIR }
          : {}),
        ...(dependencies.now ? { now: dependencies.now } : {}),
        warn,
      });
    const rows = await (dependencies.load ?? (scope => loadStaleMemories(scope, database!)))(project);
    const stale = await findStaleMemories(rows, {
      ...(project ? { project } : {}),
      now: (dependencies.now ?? (() => new Date()))(),
      lookupClosure,
    });
    const output = json
      ? JSON.stringify(stale, null, 2)
      : stale
          .map(
            item =>
              `${item.project}\t${item.memoryKey}\t${item.lastVerifiedAt ?? 'unknown'}\t${item.reasons.join(', ')}`,
          )
          .join('\n') || 'No stale keyed memories.';
    (
      dependencies.write ??
      (text => {
        process.stdout.write(text);
      })
    )(`${output}\n`);
  } finally {
    await database?.end();
  }
}
