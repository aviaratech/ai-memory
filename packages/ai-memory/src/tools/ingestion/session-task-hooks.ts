import { closePool, initializeDatabase, normalizeProjectScope, searchMemories } from '@aviaratech/ai-memory/internal';
import { open, constants } from 'node:fs/promises';

import { getContinuityPack, writeAutomaticSessionCheckpoint } from '../../db/continuity-pack-api.js';
import { consumePromptRetrieval, type MemoryHookIdentity, recordMemoryConsumption } from '../../db/tool-invocations.js';
import { isRecord } from '../../db/type-guards.js';
import { withTimeout } from '../../timeout-policy.js';
import { ensurePostgresRunning } from '../ensure-postgres.js';
import {
  extractContinuityFromText,
  parseHookTranscript,
  parseJsonlLines,
  resolveRepoIdFromCwd,
  sanitizeMemoryText,
} from './auto-session-ingest.js';
import { buildContinuityPackFromFlush, type CheckpointFieldProvenance } from './continuity-pack.js';
import { parseFlushInput } from './flush-session.js';

export const TASK_PROMPT_CONTEXT_MAX_CHARS = 3200;
export interface TaskHookDependencies {
  closePool: typeof closePool;
  consumePromptRetrieval: typeof consumePromptRetrieval;
  ensurePostgresRunning: (input: { logProgress: boolean; startIfNeeded: boolean }) => Promise<{ ok: boolean }>;
  initializeDatabase: () => Promise<unknown>;
  recordMemoryConsumption: typeof recordMemoryConsumption;
  resolveRepoIdFromCwd: typeof resolveRepoIdFromCwd;
  searchMemories: (input: unknown) => Promise<unknown[]>;
}

const DEFAULT_DEPENDENCIES: TaskHookDependencies = {
  closePool,
  consumePromptRetrieval,
  ensurePostgresRunning,
  initializeDatabase,
  recordMemoryConsumption,
  resolveRepoIdFromCwd,
  searchMemories,
};

export interface TaskHookOutput {
  continue: true;
  hookSpecificOutput?: { additionalContext: string; hookEventName: 'UserPromptSubmit' };
  systemMessage?: string;
}

export function memoryHookHost(env: Record<string, string | undefined>): MemoryHookIdentity['host'] | undefined {
  if (env.CODEX !== undefined || env.PLUGIN_ROOT !== undefined || env.AI_AGENT_IDENTITY === 'codex') return 'codex';
  if (env.CLAUDECODE === '1' || env.CLAUDE_PLUGIN_ROOT !== undefined || env.AI_AGENT_IDENTITY === 'claude-code')
    return 'claude-code';
  return undefined;
}

export interface CheckpointHookDependencies extends TaskHookDependencies {
  getContinuityPack: typeof getContinuityPack;
  readTranscript: (path: string) => Promise<unknown[] | undefined>;
  writeAutomaticSessionCheckpoint: typeof writeAutomaticSessionCheckpoint;
}

async function readBoundedHookTranscript(path: string): Promise<unknown[] | undefined> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 16 * 1024 * 1024) return undefined;
    const bytes = Buffer.alloc(16 * 1024 * 1024 + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 16 * 1024 * 1024) return undefined;
    let malformed = false;
    const entries = parseJsonlLines(path, {
      contents: bytes.subarray(0, bytesRead).toString('utf8'),
      onMalformedLines: count => {
        malformed = count > 0;
      },
    });
    return malformed ? undefined : entries;
  } finally {
    await file.close();
  }
}

const CHECKPOINT_DEPENDENCIES: CheckpointHookDependencies = {
  ...DEFAULT_DEPENDENCIES,
  getContinuityPack: input => getContinuityPack(input, { includeRevisionToken: true }),
  readTranscript: readBoundedHookTranscript,
  writeAutomaticSessionCheckpoint,
};

async function validatedTranscript(
  payload: Record<string, unknown>,
  identity: MemoryHookIdentity,
  dependencies: CheckpointHookDependencies,
) {
  if (typeof payload.transcript_path !== 'string') return undefined;
  const entries = await dependencies.readTranscript(payload.transcript_path);
  if (entries === undefined) return undefined;
  const transcript = parseHookTranscript({ entries, host: identity.host, sessionId: identity.sessionId });
  if (transcript === undefined) return undefined;
  for (const directory of transcript.workingDirectories) {
    if (normalizeProjectScope({ project: await dependencies.resolveRepoIdFromCwd(directory) }) !== identity.project)
      return undefined;
  }
  return transcript;
}

/** Derived, session-only checkpoint. No reflection, durable promotion or session-end writes. */
export async function runPreCompactHook(
  payload: Record<string, unknown>,
  dependencies = CHECKPOINT_DEPENDENCIES,
  env: Record<string, string | undefined> = process.env,
): Promise<TaskHookOutput> {
  try {
    if (payload.hook_event_name !== 'PreCompact') return { continue: true };
    const identity = await resolveHookIdentity(payload, dependencies, env);
    if (identity === undefined) return { continue: true };
    const transcript = await validatedTranscript(payload, identity, dependencies);
    const summary = sanitizeMemoryText(transcript?.lastAssistantMessage ?? transcript?.sessionSummary);
    if (transcript === undefined || summary === undefined)
      return { continue: true, systemMessage: 'ai-memory: session checkpoint unavailable for this transcript.' };
    if (!(await dependencies.ensurePostgresRunning({ logProgress: false, startIfNeeded: false })).ok)
      return { continue: true };
    await dependencies.initializeDatabase();
    const expected = await dependencies.getContinuityPack({ project: identity.project, task: identity.sessionId });
    const scopeKey = `task:${identity.project}:${identity.sessionId}`;
    if (
      expected.status === 'found' &&
      (expected.pack.scopeKey !== scopeKey ||
        expected.pack.project !== identity.project ||
        expected.pack.sessionId !== identity.sessionId ||
        (expected.pack.source === 'pre-compact' &&
          (!isRecord(expected.pack.pack.provenance) || expected.pack.pack.provenance.agent !== identity.host)))
    )
      return { continue: true };
    const derived = extractContinuityFromText(summary);
    const fieldProvenance: CheckpointFieldProvenance = { summary: 'derived' };
    const lists: Record<string, string[]> = {};
    for (const key of ['nextActions', 'contextNeeded', 'openQuestions', 'decisions'] as const) {
      const prior: unknown = expected.status === 'found' ? expected.pack.pack[key] : undefined;
      const provenance = expected.status === 'found' ? expected.pack.pack.provenance : undefined;
      const fields = isRecord(provenance) && isRecord(provenance.fields) ? provenance.fields : undefined;
      const origin = fields?.[key] ?? (isRecord(provenance) ? provenance.continuityFields : undefined);
      const explicitlyAuthored = origin === 'agent-authored' || origin === 'carry-forward';
      const carried =
        explicitlyAuthored && Array.isArray(prior)
          ? prior
              .filter((item): item is string => typeof item === 'string')
              .map(item => sanitizeMemoryText(item))
              .filter((item): item is string => item !== undefined)
              .slice(0, 5)
          : [];
      lists[key] = carried.length > 0 ? carried : key === 'decisions' ? [] : (derived[key] ?? []);
      fieldProvenance[key] = carried.length > 0 ? 'carry-forward' : 'derived';
    }
    const nowIso = new Date().toISOString();
    const checkpoint = buildContinuityPackFromFlush({
      fieldProvenance,
      nowIso,
      reflectionCount: 0,
      sessionId: identity.sessionId,
      scope: { type: 'task', id: identity.sessionId },
      parsed: parseFlushInput({ ...identity, ...lists, summary, source: 'pre-compact', agent: identity.host }),
    });
    await dependencies.writeAutomaticSessionCheckpoint({
      checkpoint: { ...checkpoint, sessionId: identity.sessionId, updatedAt: nowIso },
      expected,
    });
    return { continue: true };
  } catch {
    return { continue: true, systemMessage: 'ai-memory: session checkpoint unavailable.' };
  } finally {
    await dependencies.closePool().catch(() => {});
  }
}

/** Exact configured ai-memory server names only; no generic memory_get suffix matching. */
export const MEMORY_GET_HOOK_PATTERN =
  '^(mcp__ai_memory__memory_get|mcp__ai-memory__memory_get|mcp__plugin_ai-memory_ai-memory__memory_get)$';

export async function runMemoryUsedHook(
  payload: Record<string, unknown>,
  dependencies = DEFAULT_DEPENDENCIES,
  env: Record<string, string | undefined> = process.env,
): Promise<TaskHookOutput> {
  try {
    if (
      payload.hook_event_name !== 'PostToolUse' ||
      typeof payload.tool_name !== 'string' ||
      !new RegExp(MEMORY_GET_HOOK_PATTERN, 'u').test(payload.tool_name)
    )
      return { continue: true };
    const response = payload.tool_response;
    if (typeof response !== 'object' || response === null || Array.isArray(response)) return { continue: true };
    const envelope = response as Record<string, unknown>;
    if (envelope.isError === true || !Array.isArray(envelope.content) || envelope.content.length !== 1)
      return { continue: true };
    const block: unknown = envelope.content[0];
    if (
      typeof block !== 'object' ||
      block === null ||
      !('type' in block) ||
      block.type !== 'text' ||
      !('text' in block) ||
      typeof block.text !== 'string' ||
      block.text.length > 256_000
    )
      return { continue: true };
    const result: unknown = JSON.parse(block.text);
    if (
      typeof result !== 'object' ||
      result === null ||
      !('memories' in result) ||
      !Array.isArray(result.memories) ||
      result.memories.length > 100 ||
      !('count' in result) ||
      result.count !== result.memories.length
    )
      return { continue: true };
    const identity = await resolveHookIdentity(payload, dependencies, env);
    if (identity === undefined) return { continue: true };
    const memoryIds = result.memories.flatMap((memory: unknown) => {
      if (
        typeof memory !== 'object' ||
        memory === null ||
        !('id' in memory) ||
        typeof memory.id !== 'number' ||
        !Number.isSafeInteger(memory.id) ||
        memory.id <= 0 ||
        !('project' in memory) ||
        memory.project !== identity.project
      )
        return [];
      return [memory.id];
    });
    if (memoryIds.length === 0) return { continue: true };
    if (!(await dependencies.ensurePostgresRunning({ logProgress: false, startIfNeeded: false })).ok)
      return { continue: true };
    await dependencies.initializeDatabase();
    await dependencies.recordMemoryConsumption({
      ...identity,
      kind: 'used',
      memoryIds: [...new Set(memoryIds)],
      observation: 'get',
    });
    return { continue: true };
  } catch {
    return { continue: true };
  } finally {
    await dependencies.closePool().catch(() => {});
  }
}

/** Bounded existing history supplies only observed citations, not exhaustive transcript coverage. */
export async function recordSessionCitationObservations(
  payload: Record<string, unknown>,
  dependencies = CHECKPOINT_DEPENDENCIES,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const identity = await resolveHookIdentity(payload, dependencies, env);
  if (identity === undefined) return;
  const transcript = await validatedTranscript(payload, identity, dependencies);
  if (transcript === undefined) return;
  for (const turn of transcript.history) {
    if (turn.role !== 'assistant' || turn.timestamp === undefined) continue;
    const memoryIds = [
      ...new Set(
        [...turn.content.matchAll(/\[memory:(\d+)\]/gu)]
          .map(match => Number(match[1]))
          .filter(id => Number.isSafeInteger(id) && id > 0),
      ),
    ].slice(0, 100);
    if (memoryIds.length > 0)
      await dependencies.recordMemoryConsumption({
        ...identity,
        kind: 'used',
        memoryIds,
        observation: 'citation',
        observedAt: turn.timestamp,
      });
  }
}

async function resolveHookIdentity(
  payload: Record<string, unknown>,
  dependencies: TaskHookDependencies,
  env: Record<string, string | undefined>,
): Promise<MemoryHookIdentity | undefined> {
  const host = memoryHookHost(env);
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id.trim() : '';
  if (host === undefined || sessionId.length === 0 || sessionId.length > 256 || typeof payload.cwd !== 'string')
    return undefined;
  const project = normalizeProjectScope({ project: await dependencies.resolveRepoIdFromCwd(payload.cwd) });
  return project === undefined ? undefined : { host, project, sessionId };
}

/** Runs only after a startup marker is atomically consumed; no raw task text is persisted. */
export async function runUserPromptSubmitHook(
  payload: Record<string, unknown>,
  dependencies = DEFAULT_DEPENDENCIES,
  env: Record<string, string | undefined> = process.env,
): Promise<TaskHookOutput> {
  try {
    const prompt = payload.prompt;
    if (payload.hook_event_name !== 'UserPromptSubmit' || typeof prompt !== 'string' || prompt.trim().length === 0)
      return { continue: true };
    const identity = await resolveHookIdentity(payload, dependencies, env);
    if (identity === undefined) return { continue: true };
    const available = await dependencies.ensurePostgresRunning({ logProgress: false, startIfNeeded: false });
    if (!available.ok) return { continue: true, systemMessage: 'ai-memory: prompt retrieval unavailable.' };
    await dependencies.initializeDatabase();
    if (!(await dependencies.consumePromptRetrieval(identity))) return { continue: true };
    const memories = await withTimeout({
      operation: 'hook.prompt_retrieval',
      timeoutMs: 5000,
      task: () =>
        dependencies.searchMemories({ query: prompt.trim().slice(0, 2000), project: identity.project, limit: 8 }),
    });
    const lines: string[] = [];
    const memoryIds: number[] = [];
    for (const memory of memories) {
      if (typeof memory !== 'object' || memory === null) continue;
      const item = memory as Record<string, unknown>;
      if (
        typeof item.id !== 'number' ||
        !Number.isSafeInteger(item.id) ||
        item.id <= 0 ||
        memoryIds.includes(item.id) ||
        item.project !== identity.project ||
        typeof item.content !== 'string'
      )
        continue;
      const line = JSON.stringify({
        id: item.id,
        category: String(item.category ?? '').slice(0, 80),
        date: String(item.createdAt ?? '').slice(0, 32),
        excerpt: item.content.slice(0, 600),
      });
      if ([...lines, line].join('\n').length > TASK_PROMPT_CONTEXT_MAX_CHARS) break;
      lines.push(line);
      memoryIds.push(item.id);
    }
    if (memoryIds.length === 0) return { continue: true };
    await dependencies.recordMemoryConsumption({ ...identity, kind: 'injected', memoryIds, observation: 'prompt' });
    return {
      continue: true,
      hookSpecificOutput: { additionalContext: lines.join('\n'), hookEventName: 'UserPromptSubmit' },
    };
  } catch {
    return { continue: true, systemMessage: 'ai-memory: prompt retrieval unavailable; use scoped memory tools.' };
  } finally {
    await dependencies.closePool().catch(() => {});
  }
}
