#!/usr/bin/env node

import { createPool, type DbPool } from '@aviaratech/ai-memory/internal';
import {
  backfillPatchSnapshots,
  closePool,
  getSessionResume,
  ingestContextPack,
  ingestMemoryDelta,
} from '@aviaratech/ai-memory/internal';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type AiMemoryDatabaseTarget, requireAiMemoryCliDatabaseTarget } from './runtimeEnv.js';

const SMOKE_AGENT = 'codex-smoke';
const SMOKE_MODEL = 'gpt-5.3-codex-smoke';
const COUNT_SESSION_SNAPSHOTS_SQL = 'SELECT COUNT(*)::int AS count FROM ai_session_snapshots WHERE session_id = $1';
const FIXTURE_FILE_NAMES = ['context_pack.json', 'memory_delta.json'] as const;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const AI_MEMORY_PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');
export const DEFAULT_SMOKE_FIXTURE_PATH = resolve(
  AI_MEMORY_PACKAGE_ROOT,
  'fixtures',
  'unified-memory-contracts_v0_1',
  'fixtures',
  'feature_work',
);
const INGESTION_SCRIPT_DIR = join(SCRIPT_DIR, 'ingestion');

let verificationPool: DbPool | undefined;

const tempDir = mkdtempSync(join(tmpdir(), 'ai-memory-smoke-'));
const cleanupIds = {
  contextPackIds: new Set<string>(),
  deltaIds: new Set<string>(),
  sessionIds: new Set<string>(),
};

interface BackfillResult {
  candidateSessions?: number;
  sessionsBackfilled?: number;
}

interface CodexIngestScriptOutput {
  result?: {
    deltaId?: string;
  };
}

interface ContractContextPackFixture {
  created_at: string;
  pack_id: string;
  produced_by: {
    agent: string;
    instance_id: string;
  };
  session: {
    recent_events: Record<string, unknown>[];
    session_id: string;
    snapshot: {
      created_at: string;
      snapshot_id: string;
    };
  };
}

interface ContractMemoryDeltaFixture {
  created_at: string;
  delta_id: string;
  produced_by: {
    agent: string;
    model: string;
  };
  session_id: string;
  snapshot: {
    mode: string;
    value: {
      created_at: string;
      snapshot_id: string;
    };
  };
  telemetry: Record<string, unknown>;
  x_durable_memories?: unknown[];
}

interface MemoryDeltaFixtureInput {
  createdAt: string;
  deltaId: string;
  sessionId: string;
  snapshotMode: 'patch' | 'replace';
  snapshotValue: Record<string, unknown>;
}

interface RowCountResult {
  count?: number | string;
}

interface SessionResumeResult {
  snapshot?: {
    snapshotJson?: unknown;
  };
  status?: string;
}

interface SessionSnapshotFixtureInput {
  createdAt: string;
  goal: string;
  nextActions: string[];
  openQuestions: string[];
  snapshotId: string;
}

interface SnapshotRecord extends Record<string, unknown> {
  anchors?: {
    focus_paths?: unknown[];
  };
  goal?: string;
  next_actions?: unknown[];
  open_questions?: unknown[];
  snapshot_id?: string;
}

type VerificationChecks = Record<
  string,
  {
    contextPacks: number;
    memoryDeltas: number;
    memoryEntries: number;
    sessionEvents: number;
    sessions: number;
    sessionSnapshots: number;
  }
>;

export function getSmokeContractFixturePath(argv: readonly string[] = process.argv): string {
  const requestedPath =
    getSmokeFixturePathArg(argv) ?? process.env.AI_MEMORY_SMOKE_FIXTURE_PATH ?? DEFAULT_SMOKE_FIXTURE_PATH;
  const fixturePath = resolve(process.cwd(), requestedPath);
  validateSmokeFixturePath(fixturePath);

  return fixturePath;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void (async () => {
    try {
      await main();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[ai-memory] smoke failed: ${message}\n`);
      process.exitCode = 1;
    } finally {
      try {
        await cleanupSmokeData();
      } finally {
        rmSync(tempDir, { force: true, recursive: true });
        await Promise.allSettled([closePool(), ...(verificationPool !== undefined ? [verificationPool.end()] : [])]);
      }
    }
  })();
}

function assertCondition(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function cleanupSmokeData() {
  const sessionIds = [...cleanupIds.sessionIds];
  const contextPackIds = [...cleanupIds.contextPackIds];
  const deltaIds = [...cleanupIds.deltaIds];

  if (sessionIds.length === 0 && contextPackIds.length === 0 && deltaIds.length === 0) {
    return;
  }

  const client = await getVerificationPool().connect();
  try {
    await client.query('BEGIN');

    if (contextPackIds.length > 0) {
      await client.query('DELETE FROM ai_context_packs WHERE pack_id = ANY($1::text[])', [contextPackIds]);
    }

    if (deltaIds.length > 0) {
      await client.query('DELETE FROM ai_memory_deltas WHERE delta_id = ANY($1::text[])', [deltaIds]);
    }

    if (sessionIds.length > 0) {
      await client.query(
        'DELETE FROM ai_memory_events WHERE memory_id = ANY(SELECT id FROM ai_memory_entries WHERE session_id = ANY($1::text[]))',
        [sessionIds],
      );
      await client.query('DELETE FROM ai_memory_entries WHERE session_id = ANY($1::text[])', [sessionIds]);
      await client.query('DELETE FROM ai_session_events WHERE session_id = ANY($1::text[])', [sessionIds]);
      await client.query('DELETE FROM ai_session_snapshots WHERE session_id = ANY($1::text[])', [sessionIds]);
      await client.query('DELETE FROM ai_ingestion_failures WHERE session_id = ANY($1::text[])', [sessionIds]);
      await client.query('DELETE FROM ai_sessions WHERE session_id = ANY($1::text[])', [sessionIds]);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function collectVerification(): Promise<VerificationChecks> {
  const sessions = [...cleanupIds.sessionIds];

  const checks: VerificationChecks = {};
  for (const sessionId of sessions) {
    checks[sessionId] = {
      contextPacks: await countRows('SELECT COUNT(*)::int AS count FROM ai_context_packs WHERE session_id = $1', [
        sessionId,
      ]),
      memoryDeltas: await countRows('SELECT COUNT(*)::int AS count FROM ai_memory_deltas WHERE session_id = $1', [
        sessionId,
      ]),
      memoryEntries: await countRows('SELECT COUNT(*)::int AS count FROM ai_memory_entries WHERE session_id = $1', [
        sessionId,
      ]),
      sessionEvents: await countRows('SELECT COUNT(*)::int AS count FROM ai_session_events WHERE session_id = $1', [
        sessionId,
      ]),
      sessions: await countRows('SELECT COUNT(*)::int AS count FROM ai_sessions WHERE session_id = $1', [sessionId]),
      sessionSnapshots: await countRows(COUNT_SESSION_SNAPSHOTS_SQL, [sessionId]),
    };
  }

  return checks;
}

async function countRows(sql: string, params: readonly unknown[]): Promise<number> {
  const result = await getVerificationPool().query<RowCountResult>(sql, [...params]);
  return Number(result.rows.at(0)?.count ?? 0);
}

function createMemoryDeltaFixture(input: MemoryDeltaFixtureInput) {
  return {
    append_events: [],
    artifacts: [],
    created_at: input.createdAt,
    delta_id: input.deltaId,
    produced_by: {
      agent: 'smoke-runner',
      model: SMOKE_MODEL,
    },
    schema_version: 'memory_delta@0.1',
    session_id: input.sessionId,
    snapshot: {
      mode: input.snapshotMode,
      value: input.snapshotValue,
    },
    telemetry: {},
    tenancy: {
      org_id: 'smoke-org',
      repo_id: 'example/catalog',
      user_id: 'smoke-user',
    },
  };
}

function createSessionSnapshotFixture(input: SessionSnapshotFixtureInput) {
  return {
    anchors: {},
    created_at: input.createdAt,
    goal: input.goal,
    next_actions: input.nextActions,
    open_questions: input.openQuestions,
    plan: [],
    progress: {
      blockers: [],
      completed: [],
      in_flight: [],
    },
    snapshot_id: input.snapshotId,
  };
}

function createSmokeSuffix(now: Date): string {
  return `${toCompactTimestamp(now)}-${randomUUID().slice(0, 8)}`;
}

function getSmokeFixturePathArg(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (typeof arg !== 'string') {
      continue;
    }

    if (arg === '--fixture-path') {
      return argv[index + 1];
    }

    if (arg.startsWith('--fixture-path=')) {
      return arg.slice('--fixture-path='.length);
    }
  }

  return undefined;
}

function getVerificationPool(): DbPool {
  const databaseTarget = resolveSmokeDatabaseTarget();
  verificationPool ??= createPool({ connectionString: databaseTarget.databaseUrl });
  return verificationPool;
}

async function main() {
  resolveSmokeDatabaseTarget();
  const contractFixturePath = getSmokeContractFixturePath(process.argv);
  const contract = await runContractIngestionSmoke(contractFixturePath);
  const patchMaterialization = await runPatchMaterializationSmoke();
  const claudeHook = runClaudeHookSmoke();
  const codexWrapper = runCodexSessionSmoke();

  const verification = await collectVerification();

  process.stdout.write(
    `${JSON.stringify(
      {
        claudeHook,
        codexWrapper,
        contract,
        patchMaterialization,
        status: 'ok',
        verification,
      },
      null,
      2,
    )}\n`,
  );
}

function parseJsonOrThrow(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Unable to parse ${label}: ${value}`);
  }
}

function resolveSmokeDatabaseTarget(): AiMemoryDatabaseTarget {
  return requireAiMemoryCliDatabaseTarget();
}

function runClaudeHookSmoke() {
  const now = new Date();
  const suffix = createSmokeSuffix(now);

  const sessionId = `sess-smoke-claude-${suffix}`;
  const transcriptPath = join(tempDir, `claude-transcript-${suffix}.jsonl`);

  const transcriptLines = [
    JSON.stringify({
      message: {
        content: [
          {
            text: 'Please standardize on Zod for API validation.',
            type: 'text',
          },
        ],
        role: 'user',
      },
      type: 'user',
    }),
    JSON.stringify({
      message: {
        content: [
          {
            text: 'Done. We will use Zod for API validation conventions.',
            type: 'text',
          },
        ],
        role: 'assistant',
      },
      type: 'assistant',
    }),
    JSON.stringify({
      summary: 'Chose Zod validation convention for future work.',
      type: 'summary',
    }),
  ];

  writeFileSync(transcriptPath, `${transcriptLines.join('\n')}\n`, 'utf8');

  const hookPayload = {
    cwd: process.cwd(),
    hook_event_name: 'SessionEnd',
    reason: 'smoke-test',
    session_id: sessionId,
    transcript_path: transcriptPath,
  };

  const run = spawnSync(process.execPath, [join(INGESTION_SCRIPT_DIR, 'ingest-claude-session-end-hook.js')], {
    cwd: process.cwd(),
    encoding: 'utf8',
    input: JSON.stringify(hookPayload),
  });

  if (run.status !== 0) {
    throw new Error(`Claude hook smoke failed: ${run.stderr || run.stdout}`);
  }

  const hookOutput = parseJsonOrThrow(run.stdout.trim(), 'claude hook output') as Record<string, unknown>;
  cleanupIds.sessionIds.add(sessionId);

  return {
    hookOutput,
    sessionId,
  };
}

function runCodexSessionSmoke() {
  const now = new Date();
  const suffix = createSmokeSuffix(now);

  const sessionId = `sess-smoke-codex-${suffix}`;
  const sessionPath = join(tempDir, `codex-session-${suffix}.jsonl`);

  const lines = [
    JSON.stringify({
      payload: {
        cwd: process.cwd(),
        git: {
          repository_url: 'https://github.com/example/catalog.git',
        },
        id: sessionId,
        model: SMOKE_MODEL,
        timestamp: now.toISOString(),
      },
      timestamp: now.toISOString(),
      type: 'session_meta',
    }),
    JSON.stringify({
      payload: {
        images: [],
        local_images: [],
        message: 'Please keep using Zod validation patterns in this repo.',
        text_elements: [],
        type: 'user_message',
      },
      timestamp: new Date(now.getTime() + 1_000).toISOString(),
      type: 'event_msg',
    }),
    JSON.stringify({
      payload: {
        message: 'Implemented and standardized Zod validation in the updated flow.',
        type: 'agent_message',
      },
      timestamp: new Date(now.getTime() + 2_000).toISOString(),
      type: 'event_msg',
    }),
    JSON.stringify({
      payload: {
        arguments: '{"cmd":"echo smoke"}',
        call_id: 'call-smoke',
        name: 'exec_command',
        type: 'function_call',
      },
      timestamp: new Date(now.getTime() + 3_000).toISOString(),
      type: 'response_item',
    }),
  ];

  writeFileSync(sessionPath, `${lines.join('\n')}\n`, 'utf8');

  const run = spawnSync(
    process.execPath,
    [join(INGESTION_SCRIPT_DIR, 'ingest-codex-session.js'), '--session-file', sessionPath],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  );

  if (run.status !== 0) {
    throw new Error(`Codex wrapper smoke failed: ${run.stderr || run.stdout}`);
  }

  const output = parseJsonOrThrow(run.stdout.trim(), 'codex ingest output') as CodexIngestScriptOutput;

  cleanupIds.sessionIds.add(sessionId);
  const outputDeltaId = output.result?.deltaId;
  if (typeof outputDeltaId === 'string' && outputDeltaId.length > 0) {
    cleanupIds.deltaIds.add(outputDeltaId);
  }

  return {
    output,
    sessionId,
  };
}

async function runContractIngestionSmoke(fixturePath: string) {
  const now = new Date();
  const suffix = createSmokeSuffix(now);

  const contextPack = parseJsonOrThrow(
    readFileSync(join(fixturePath, 'context_pack.json'), 'utf8'),
    'context_pack fixture',
  ) as ContractContextPackFixture;
  const memoryDelta = parseJsonOrThrow(
    readFileSync(join(fixturePath, 'memory_delta.json'), 'utf8'),
    'memory_delta fixture',
  ) as ContractMemoryDeltaFixture;

  const sessionId = `sess-smoke-contract-${suffix}`;
  const packId = `pack-smoke-contract-${suffix}`;
  const deltaId = `delta-smoke-contract-${suffix}`;
  const snapshotId = `snap-smoke-contract-${suffix}`;

  const createdAt = new Date(now.getTime() - 60_000).toISOString();
  const deltaCreatedAt = now.toISOString();

  contextPack.pack_id = packId;
  contextPack.created_at = createdAt;
  contextPack.produced_by.agent = SMOKE_AGENT;
  contextPack.produced_by.instance_id = 'smoke-runner';
  contextPack.session.session_id = sessionId;
  contextPack.session.snapshot.snapshot_id = snapshotId;
  contextPack.session.snapshot.created_at = createdAt;
  contextPack.session.recent_events = [
    {
      event_id: `evt-smoke-contract-${suffix}-01`,
      summary: 'Contract smoke context event 1',
      ts: createdAt,
      type: 'checkpoint',
    },
    {
      event_id: `evt-smoke-contract-${suffix}-02`,
      summary: 'Contract smoke context event 2',
      ts: new Date(now.getTime() - 30_000).toISOString(),
      type: 'plan_updated',
    },
  ];

  memoryDelta.delta_id = deltaId;
  memoryDelta.created_at = deltaCreatedAt;
  memoryDelta.produced_by.agent = SMOKE_AGENT;
  memoryDelta.produced_by.model = SMOKE_MODEL;
  memoryDelta.session_id = sessionId;
  memoryDelta.snapshot.mode = 'replace';
  memoryDelta.snapshot.value.snapshot_id = snapshotId;
  memoryDelta.snapshot.value.created_at = deltaCreatedAt;
  memoryDelta.telemetry.pack_used_id = packId;
  memoryDelta.x_durable_memories = [
    {
      category: 'convention',
      confidence: 0.93,
      content: 'Contract smoke: use ai-memory contract ingestion for shared context.',
      evidence_refs: [{ id: deltaId, kind: 'fixture' }],
      project: 'example/catalog',
      sensitivity: 'internal',
      tags: ['ai-memory', 'smoke-test'],
      ttl_days: 14,
    },
  ];

  const contextResult = (await ingestContextPack({ contextPack })) as Record<string, unknown>;
  const deltaResult = (await ingestMemoryDelta({ memoryDelta })) as Record<string, unknown>;

  cleanupIds.contextPackIds.add(packId);
  cleanupIds.deltaIds.add(deltaId);
  cleanupIds.sessionIds.add(sessionId);

  return {
    contextResult,
    deltaResult,
    ids: {
      deltaId,
      packId,
      sessionId,
      snapshotId,
    },
  };
}

async function runPatchMaterializationSmoke() {
  const now = new Date();
  const suffix = createSmokeSuffix(now);

  const sequenceSessionId = `sess-smoke-patch-seq-${suffix}`;
  const sequenceSnapshotId = `snap-smoke-patch-seq-${suffix}`;
  const sequenceDeltaReplaceId = `delta-smoke-patch-seq-replace-${suffix}`;
  const sequenceDeltaPatchOneId = `delta-smoke-patch-seq-patch-1-${suffix}`;
  const sequenceDeltaPatchTwoId = `delta-smoke-patch-seq-patch-2-${suffix}`;

  const sequenceReplaceAt = new Date(now.getTime() - 90_000).toISOString();
  const sequencePatchOneAt = new Date(now.getTime() - 80_000).toISOString();
  const sequencePatchTwoAt = new Date(now.getTime() - 70_000).toISOString();

  const sequenceReplaceDelta = createMemoryDeltaFixture({
    createdAt: sequenceReplaceAt,
    deltaId: sequenceDeltaReplaceId,
    sessionId: sequenceSessionId,
    snapshotMode: 'replace',
    snapshotValue: createSessionSnapshotFixture({
      createdAt: sequenceReplaceAt,
      goal: 'Baseline replace goal',
      nextActions: ['baseline-action'],
      openQuestions: ['baseline-open-question'],
      snapshotId: sequenceSnapshotId,
    }),
  });

  const sequencePatchOneDelta = createMemoryDeltaFixture({
    createdAt: sequencePatchOneAt,
    deltaId: sequenceDeltaPatchOneId,
    sessionId: sequenceSessionId,
    snapshotMode: 'patch',
    snapshotValue: {
      ops: [
        { op: 'set', path: '/goal', value: 'Patched goal v1' },
        { op: 'add', path: '/next_actions/0', value: 'ship patch flow' },
        {
          op: 'add',
          path: '/progress/completed/0',
          value: 'replace-materialized',
        },
      ],
    },
  });

  const sequencePatchTwoDelta = createMemoryDeltaFixture({
    createdAt: sequencePatchTwoAt,
    deltaId: sequenceDeltaPatchTwoId,
    sessionId: sequenceSessionId,
    snapshotMode: 'patch',
    snapshotValue: {
      ops: [
        { op: 'set', path: '/goal', value: 'Patched goal v2' },
        { op: 'remove', path: '/open_questions/0' },
        {
          op: 'add',
          path: '/anchors/focus_paths/0',
          value: 'packages/ai-memory/src/db.ts',
        },
      ],
    },
  });

  cleanupIds.sessionIds.add(sequenceSessionId);
  cleanupIds.deltaIds.add(sequenceDeltaReplaceId);
  cleanupIds.deltaIds.add(sequenceDeltaPatchOneId);
  cleanupIds.deltaIds.add(sequenceDeltaPatchTwoId);

  await ingestMemoryDelta({ memoryDelta: sequenceReplaceDelta });
  await ingestMemoryDelta({ memoryDelta: sequencePatchOneDelta });
  await ingestMemoryDelta({ memoryDelta: sequencePatchTwoDelta });

  const sequenceResume = (await getSessionResume({
    sessionId: sequenceSessionId,
  })) as SessionResumeResult;
  assertCondition(sequenceResume.status === 'ok', 'Patch sequence resume lookup failed.');
  const sequenceSnapshot = toSnapshotRecord(sequenceResume.snapshot?.snapshotJson);
  assertCondition(sequenceSnapshot !== undefined, 'Patch sequence snapshot missing.');
  assertCondition(sequenceSnapshot.goal === 'Patched goal v2', 'Final patch did not update goal.');
  const sequenceNextActions = toStringArray(sequenceSnapshot.next_actions);
  assertCondition(sequenceNextActions?.[0] === 'ship patch flow', 'Patch add op did not insert expected next action.');
  const sequenceOpenQuestions = toStringArray(sequenceSnapshot.open_questions);
  assertCondition(sequenceOpenQuestions?.length === 0, 'Patch remove op did not remove open question.');
  const sequenceFocusPaths = toStringArray(sequenceSnapshot.anchors?.focus_paths);
  assertCondition(
    sequenceFocusPaths?.[0] === 'packages/ai-memory/src/db.ts',
    'Patch add op did not create nested focus path.',
  );

  const snapshotBeforeReplay = JSON.stringify(sequenceSnapshot);
  await ingestMemoryDelta({ memoryDelta: sequencePatchTwoDelta });
  const replayResume = (await getSessionResume({
    sessionId: sequenceSessionId,
  })) as SessionResumeResult;
  const snapshotAfterReplay = JSON.stringify(toSnapshotRecord(replayResume.snapshot?.snapshotJson));
  assertCondition(snapshotBeforeReplay === snapshotAfterReplay, 'Replay idempotency failed for patch delta.');

  const patchOnlySessionId = `sess-smoke-patch-only-${suffix}`;
  const patchOnlyDeltaId = `delta-smoke-patch-only-${suffix}`;
  const patchOnlySnapshotId = `snap-smoke-patch-only-${suffix}`;
  const patchOnlyCreatedAt = new Date(now.getTime() - 60_000).toISOString();

  const patchOnlyDelta = createMemoryDeltaFixture({
    createdAt: patchOnlyCreatedAt,
    deltaId: patchOnlyDeltaId,
    sessionId: patchOnlySessionId,
    snapshotMode: 'patch',
    snapshotValue: {
      ops: [
        { op: 'add', path: '/snapshot_id', value: patchOnlySnapshotId },
        { op: 'add', path: '/created_at', value: patchOnlyCreatedAt },
        { op: 'set', path: '/goal', value: 'Patch-only bootstrap goal' },
        { op: 'set', path: '/plan', value: [] },
        {
          op: 'set',
          path: '/progress',
          value: { blockers: [], completed: [], in_flight: [] },
        },
        { op: 'set', path: '/open_questions', value: [] },
        { op: 'set', path: '/next_actions', value: ['patch-only-action'] },
        { op: 'set', path: '/anchors', value: { focus_paths: ['patch-only'] } },
      ],
    },
  });

  cleanupIds.sessionIds.add(patchOnlySessionId);
  cleanupIds.deltaIds.add(patchOnlyDeltaId);

  await ingestMemoryDelta({ memoryDelta: patchOnlyDelta });
  const patchOnlyResume = (await getSessionResume({
    sessionId: patchOnlySessionId,
  })) as SessionResumeResult;
  const patchOnlySnapshot = toSnapshotRecord(patchOnlyResume.snapshot?.snapshotJson);
  assertCondition(patchOnlyResume.status === 'ok', 'Patch-only session resume failed.');
  assertCondition(patchOnlySnapshot?.goal === 'Patch-only bootstrap goal', 'Patch-only snapshot goal mismatch.');
  assertCondition(
    patchOnlySnapshot.snapshot_id === patchOnlySnapshotId,
    'Patch-only snapshot id was not materialized from empty base.',
  );

  const outOfOrderSessionId = `sess-smoke-patch-ooo-${suffix}`;
  const outOfOrderReplaceId = `delta-smoke-patch-ooo-replace-${suffix}`;
  const outOfOrderPatchId = `delta-smoke-patch-ooo-patch-${suffix}`;
  const outOfOrderSnapshotId = `snap-smoke-patch-ooo-${suffix}`;

  const outOfOrderPatchAt = new Date(now.getTime() - 50_000).toISOString();
  const outOfOrderReplaceAt = new Date(now.getTime() - 40_000).toISOString();

  const outOfOrderReplaceDelta = createMemoryDeltaFixture({
    createdAt: outOfOrderReplaceAt,
    deltaId: outOfOrderReplaceId,
    sessionId: outOfOrderSessionId,
    snapshotMode: 'replace',
    snapshotValue: createSessionSnapshotFixture({
      createdAt: outOfOrderReplaceAt,
      goal: 'Out-of-order base goal',
      nextActions: ['out-of-order-base'],
      openQuestions: [],
      snapshotId: outOfOrderSnapshotId,
    }),
  });

  const outOfOrderPatchDelta = createMemoryDeltaFixture({
    createdAt: outOfOrderPatchAt,
    deltaId: outOfOrderPatchId,
    sessionId: outOfOrderSessionId,
    snapshotMode: 'patch',
    snapshotValue: {
      ops: [{ op: 'set', path: '/goal', value: 'SHOULD_NOT_APPLY' }],
    },
  });

  cleanupIds.sessionIds.add(outOfOrderSessionId);
  cleanupIds.deltaIds.add(outOfOrderReplaceId);
  cleanupIds.deltaIds.add(outOfOrderPatchId);

  await ingestMemoryDelta({ memoryDelta: outOfOrderReplaceDelta });
  await ingestMemoryDelta({ memoryDelta: outOfOrderPatchDelta });

  const outOfOrderResume = (await getSessionResume({
    sessionId: outOfOrderSessionId,
  })) as SessionResumeResult;
  const outOfOrderSnapshot = toSnapshotRecord(outOfOrderResume.snapshot?.snapshotJson);
  assertCondition(
    outOfOrderSnapshot?.goal === 'Out-of-order base goal',
    'Out-of-order patch unexpectedly mutated the latest snapshot.',
  );

  const outOfOrderFailureCount = await countRows(
    `
      SELECT COUNT(*)::int AS count
      FROM ai_ingestion_failures
      WHERE session_id = $1
        AND stage = $2
    `,
    [outOfOrderSessionId, 'ingest_memory_delta_patch_out_of_order'],
  );
  assertCondition(outOfOrderFailureCount >= 1, 'Out-of-order patch was not logged to ai_ingestion_failures.');

  const backfillSessionId = `sess-smoke-patch-backfill-${suffix}`;
  const backfillReplaceDeltaId = `delta-smoke-patch-backfill-replace-${suffix}`;
  const backfillPatchDeltaId = `delta-smoke-patch-backfill-patch-${suffix}`;
  const backfillReplaceSnapshotId = `snap-smoke-patch-backfill-replace-${suffix}`;
  const backfillPatchSnapshotId = `snap-smoke-patch-backfill-patch-${suffix}`;
  const backfillReplaceAt = new Date(now.getTime() - 30_000).toISOString();
  const backfillPatchAt = new Date(now.getTime() - 20_000).toISOString();
  const backfillPatchedGoal = 'Backfill patch goal';

  const backfillReplaceDelta = createMemoryDeltaFixture({
    createdAt: backfillReplaceAt,
    deltaId: backfillReplaceDeltaId,
    sessionId: backfillSessionId,
    snapshotMode: 'replace',
    snapshotValue: createSessionSnapshotFixture({
      createdAt: backfillReplaceAt,
      goal: 'Backfill replace goal',
      nextActions: [],
      openQuestions: [],
      snapshotId: backfillReplaceSnapshotId,
    }),
  });

  const backfillPatchDelta = createMemoryDeltaFixture({
    createdAt: backfillPatchAt,
    deltaId: backfillPatchDeltaId,
    sessionId: backfillSessionId,
    snapshotMode: 'patch',
    snapshotValue: {
      ops: [
        { op: 'set', path: '/snapshot_id', value: backfillPatchSnapshotId },
        { op: 'set', path: '/created_at', value: backfillPatchAt },
        { op: 'set', path: '/goal', value: backfillPatchedGoal },
      ],
    },
  });

  cleanupIds.sessionIds.add(backfillSessionId);
  cleanupIds.deltaIds.add(backfillReplaceDeltaId);
  cleanupIds.deltaIds.add(backfillPatchDeltaId);

  await ingestMemoryDelta({ memoryDelta: backfillReplaceDelta });
  await ingestMemoryDelta({ memoryDelta: backfillPatchDelta });

  await getVerificationPool().query('DELETE FROM ai_session_snapshots WHERE session_id = $1 AND source_delta_id = $2', [
    backfillSessionId,
    backfillPatchDeltaId,
  ]);

  const snapshotsAfterPatchDelete = await countRows(COUNT_SESSION_SNAPSHOTS_SQL, [backfillSessionId]);
  assertCondition(
    snapshotsAfterPatchDelete === 1,
    `Expected replace snapshot to remain after deleting patch-derived snapshot, found ${String(snapshotsAfterPatchDelete)}.`,
  );

  const backfillResult = (await backfillPatchSnapshots({
    dryRun: false,
    limit: 50,
    sessionId: backfillSessionId,
  })) as BackfillResult;

  assertCondition(
    backfillResult.candidateSessions === 1,
    `Backfill expected one candidate session, got ${String(backfillResult.candidateSessions)}.`,
  );
  assertCondition(
    backfillResult.sessionsBackfilled === 1,
    `Backfill expected one session, got ${String(backfillResult.sessionsBackfilled)}.`,
  );

  const snapshotsAfterBackfill = await countRows(COUNT_SESSION_SNAPSHOTS_SQL, [backfillSessionId]);
  assertCondition(
    snapshotsAfterBackfill === 2,
    `Expected replace + patch snapshots after backfill, found ${String(snapshotsAfterBackfill)}.`,
  );

  const backfillResume = (await getSessionResume({
    sessionId: backfillSessionId,
  })) as SessionResumeResult;
  const backfillSnapshot = toSnapshotRecord(backfillResume.snapshot?.snapshotJson);
  assertCondition(backfillSnapshot?.goal === backfillPatchedGoal, 'Backfill did not materialize patch.');

  return {
    backfillResult,
    outOfOrderFailureCount,
    sessions: {
      backfillSessionId,
      outOfOrderSessionId,
      patchOnlySessionId,
      sequenceSessionId,
    },
    status: 'ok',
  };
}

function toCompactTimestamp(value: Date): string {
  return value
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14);
}

function toSnapshotRecord(value: unknown): SnapshotRecord | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as SnapshotRecord;
  }

  return undefined;
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    return undefined;
  }

  return value;
}

function validateSmokeFixturePath(fixturePath: string) {
  let fixtureStats: ReturnType<typeof statSync>;
  try {
    fixtureStats = statSync(fixturePath);
  } catch {
    throw new Error(
      `Smoke fixture directory is missing or inaccessible at ${fixturePath}. ` +
        'Use --fixture-path or AI_MEMORY_SMOKE_FIXTURE_PATH to point to a folder containing context_pack.json and memory_delta.json.',
    );
  }

  if (!fixtureStats.isDirectory()) {
    throw new Error(`Smoke fixture path is not a directory: ${fixturePath}.`);
  }

  for (const fixtureFile of FIXTURE_FILE_NAMES) {
    const filePath = join(fixturePath, fixtureFile);
    if (!existsSync(filePath)) {
      throw new Error(
        `Smoke fixture file missing at ${filePath}. ` +
          `Expected both context_pack.json and memory_delta.json in ${fixturePath}. ` +
          'Use --fixture-path or AI_MEMORY_SMOKE_FIXTURE_PATH.',
      );
    }
  }
}
