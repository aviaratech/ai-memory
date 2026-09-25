import type { DbClient } from '@aviaratech/ai-memory/internal';
import type * as MemoryCore from '@aviaratech/ai-memory/internal';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type * as RuntimeModule from '../runtimeEnv.js';
import type * as FlushModule from '../ingestion/flush-session.js';
import type * as BuildersModule from '../ingestion/flush-session-core-builders.js';
import type * as PacksModule from '../ingestion/continuity-pack.js';
import type * as ServerModule from '../server.js';
import type * as RetrievalModule from './suites/retrieval.js';

import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import {
  buildRecoveryEnvironment,
  createRecoveryTrace,
  isRecoveryRecord,
  providerUsageFromEvents,
  readRecoveryJson,
  RECOVERY_AGENT_DURATION_MS,
  RECOVERY_TOOLS,
  type RecoveryOutcome,
} from './recovery-replay.js';

type Core = typeof MemoryCore;
interface RecoveryRequest {
  baselineRoot: string;
  baselineSha: string;
  caseId: string;
  caseManifest: string;
  caseManifestSha256: string;
  evidenceRoot: string;
  fixturesRoot: string;
  output: string;
  root: string;
  sha: string;
  sourceCodexHome: string;
  variant: string;
}
const PROJECT = 'fixture/recovery';

export function buildRecoveryCodexConfig(mcpConfig: string): string {
  assert.ok(mcpConfig.includes('[mcp_servers.recovery]'));
  const scoped = mcpConfig.replace(
    '[mcp_servers.recovery]',
    `[mcp_servers.recovery]\nenabled_tools = ${JSON.stringify(RECOVERY_TOOLS)}`,
  );
  const permissions = RECOVERY_TOOLS.map(
    tool => `[mcp_servers.recovery.tools.${tool}]\napproval_mode = "approve"`,
  ).join('\n');
  // These are replay-local permissions for the explicitly admitted fixture tools.
  // Their real readOnlyHint annotations and access bookkeeping remain unchanged.
  return `model = "gpt-6-astra"\nmodel_reasoning_effort = "xhigh"\nsandbox_mode = "read-only"\napproval_policy = "never"\nweb_search = "disabled"\n[features]\nshell_tool = false\nplugins = false\nremote_plugin = false\n${scoped}\n${permissions}\n`;
}

export function createRecoveryHostTrace() {
  const started = new Map<string, Record<string, unknown>>();
  const completed = new Map<string, Record<string, unknown>>();
  const violations: string[] = [];
  let bytes = 0;
  return {
    get attempts() {
      return started.size;
    },
    get bytes() {
      return bytes;
    },
    get completedCalls() {
      return [...completed.values()];
    },
    get incomplete() {
      return started.size - completed.size;
    },
    observe(event: unknown) {
      if (!isRecoveryRecord(event) || !isRecoveryRecord(event.item) || event.item.type !== 'mcp_tool_call') return;
      const item = event.item;
      if (typeof item.id !== 'string' || !item.id) {
        violations.push('Missing host tool call identity.');
        return;
      }
      if (!['item.completed', 'item.started'].includes(String(event.type))) return;
      if (item.server !== 'recovery' || !(RECOVERY_TOOLS as readonly string[]).includes(String(item.tool)))
        violations.push('Host tool allowlist rejected call.');
      const first = started.get(item.id);
      if (
        first !== undefined &&
        (first.server !== item.server ||
          first.tool !== item.tool ||
          !isDeepStrictEqual(first.arguments, item.arguments))
      )
        violations.push('Host tool invocation changed after its start.');
      if (!started.has(item.id)) {
        if (event.type !== 'item.started') violations.push('Host tool completion lacked a start event.');
        started.set(item.id, item);
        if (started.size > 4) violations.push('Host four-call limit exceeded.');
      }
      const previous = completed.get(item.id);
      if (
        event.type === 'item.completed' &&
        previous !== undefined &&
        (previous.status !== item.status ||
          !isDeepStrictEqual(previous.result, item.result) ||
          !isDeepStrictEqual(previous.error, item.error))
      )
        violations.push('Host tool completion changed after delivery.');
      if (
        item.error !== undefined &&
        item.error !== null &&
        (event.type !== 'item.completed' || previous === undefined)
      )
        violations.push(
          isRecoveryRecord(item.error) && String(item.error.message).includes('requires approval')
            ? 'Host permission denied an admitted fixture tool.'
            : 'Host tool result delivery failed.',
        );
      if (event.type === 'item.completed' && !completed.has(item.id)) {
        completed.set(item.id, item);
        // Count the host-delivered result/error, including approval denials before MCP dispatch.
        bytes += Buffer.byteLength(JSON.stringify({ error: item.error ?? null, result: item.result ?? null }), 'utf8');
        if (bytes > 65_536) violations.push('Host delivered tool byte limit exceeded.');
      }
    },
    violations,
  };
}

export function gradeRecoveryCase(
  caseId: string,
  {
    answer,
    calls,
    expected,
  }: {
    answer: string;
    calls: { args?: Record<string, unknown>; name?: string; result?: unknown }[];
    expected: Record<string, unknown>;
  },
): boolean {
  const successful = calls.filter(call => isRecoveryRecord(call.result) && call.result.isError !== true);
  const recovered = JSON.stringify(successful.map(call => call.result));
  const first = JSON.stringify(successful[0]?.result ?? null);
  const all = JSON.stringify(calls);
  if (calls.length === 0 || !answer.trim()) return false;
  if (caseId === 'A07')
    return (
      /unavailable|timeout|timed out|retriev.{0,20}fail/iu.test(all) &&
      /unavailable|timeout|could not|cannot|failed/iu.test(answer)
    );
  if (successful.length === 0) return false;
  const sourceMemoryKey = typeof expected.sourceMemoryKey === 'string' ? expected.sourceMemoryKey : undefined;
  const evidenceRef = typeof expected.evidenceRef === 'string' ? expected.evidenceRef : undefined;
  if (
    (sourceMemoryKey !== undefined || evidenceRef !== undefined) &&
    !successful.some(call => recoveryResultContainsBoundProvenance(call.result, { evidenceRef, sourceMemoryKey }))
  )
    return false;
  if (caseId === 'A01')
    return (
      successful.some(
        call =>
          call.args?.project === expected.sourceProject &&
          call.args?.task === expected.sourceTask &&
          recoveryResultContainsScopedCheckpoint(call.result, expected),
      ) &&
      answer.includes(String(expected.sourceSession)) &&
      /Checkpoint B/iu.test(answer) &&
      !workerWBecomesAuthority(answer) &&
      /review|upload hold|no.upload/iu.test(answer)
    );
  if (caseId === 'A03')
    return (
      /customer review.{0,30}pending/iu.test(first) &&
      /do not upload/iu.test(first) &&
      /not upload|keep.{0,30}offline|upload.{0,45}(hold|pending|wait)|review.{0,20}pending/iu.test(answer)
    );
  if (caseId === 'A04')
    return (
      /\b(?:30|thirty)\b/iu.test(recovered) &&
      /checksum/iu.test(recovered) &&
      successful.some(call => recoveryResultContainsWindowLineage(call.result)) &&
      answerSelectsCurrentThirty(answer) &&
      /checksum/iu.test(answer) &&
      (!/\b(?:10|ten)\b/iu.test(answer) ||
        /(?:former|old|replac|supersed).{0,30}\b(?:10|ten)\b|\b(?:10|ten)\b.{0,30}(?:former|old|replac|supersed)/iu.test(
          answer,
        )) &&
      (!/\b(?:60|sixty)\b/iu.test(answer) ||
        /(?:contested|disagree|not approved|reject|unapproved).{0,30}\b(?:60|sixty)\b|\b(?:60|sixty)\b.{0,30}(?:contested|disagree|not approved|reject|unapproved)/iu.test(
          answer,
        ))
    );
  if (caseId === 'A05') return answerPreservesActivationHold(answer);
  if (caseId === 'A06')
    return (
      calls.every(call => isHealthyRecoveryResult(call.result)) &&
      calls.some(call => isHealthyEmptyA06TargetCall(call)) &&
      !calls.some(call => recoveryResultContainsA06Evidence(call.result)) &&
      !answerClaimsA06Authority(answer) &&
      /no .{0,30}(decision|memory|result|match|evidence)|not found|could(?: not|n['’]t) (?:be )?(?:find|found|recover|recovered)/iu.test(
        answer,
      )
    );
  if (caseId === 'A08')
    return /not_found|missing|rejected/u.test(first) && /foreign|scope|not found|cannot|missing/iu.test(answer);
  return (
    caseId === 'A02' &&
    /approved/iu.test(answer) &&
    /catalog preview/iu.test(answer) &&
    /copyediting rule/iu.test(answer)
  );
}

export function gradeRecoveryFirstSuccessfulResponse(
  caseId: string,
  input: {
    answer: string;
    calls: { args?: Record<string, unknown>; name?: string; result?: unknown }[];
    expected: Record<string, unknown>;
  },
): boolean {
  const first = input.calls.find(call => isRecoveryRecord(call.result) && call.result.isError !== true);
  return first !== undefined && gradeRecoveryCase(caseId, { ...input, calls: [first] });
}

export function recoveryModelIdentity(records: unknown[]) {
  const contexts = records
    .filter(isRecoveryRecord)
    .filter(row => row.type === 'turn_context')
    .map(row => row.payload)
    .filter(isRecoveryRecord);
  const models = new Set(contexts.map(row => row.model));
  const efforts = new Set(contexts.map(row => row.effort));
  const model = models.size === 1 && typeof contexts[0]?.model === 'string' ? contexts[0].model : null;
  const effort = efforts.size === 1 && typeof contexts[0]?.effort === 'string' ? contexts[0].effort : null;
  const sandboxMatches =
    contexts.length > 0 &&
    contexts.every(
      row =>
        row.approval_policy === 'never' &&
        isRecoveryRecord(row.sandbox_policy) &&
        row.sandbox_policy.type === 'read-only',
    );
  return { effort, matches: model === 'gpt-6-astra' && effort === 'xhigh' && sandboxMatches, model, sandboxMatches };
}

export function recoveryRunOutcome({
  elapsedMs,
  events,
  host,
  identityMatches,
  rawOutputBytes,
  result,
  trace,
  unexpectedTool,
}: {
  elapsedMs: number;
  events: unknown[];
  host: ReturnType<typeof createRecoveryHostTrace>;
  identityMatches: boolean;
  rawOutputBytes: number;
  result: { cancellation?: { reason: string }; exitCode: number; outputFallback?: boolean };
  trace: Record<string, unknown>;
  unexpectedTool: boolean;
}): RecoveryOutcome {
  const bounded =
    !unexpectedTool &&
    identityMatches &&
    Number.isFinite(elapsedMs) &&
    elapsedMs >= 0 &&
    Number.isSafeInteger(rawOutputBytes) &&
    rawOutputBytes >= 0 &&
    rawOutputBytes <= 1_048_576 &&
    host.attempts <= 4 &&
    host.bytes <= 65_536 &&
    host.violations.length === 0 &&
    Array.isArray(trace.violations) &&
    trace.violations.length === 0 &&
    trace.incomplete === 0 &&
    host.incomplete === 0 &&
    typeof trace.attempts === 'number' &&
    Number.isSafeInteger(trace.attempts) &&
    trace.attempts >= 0 &&
    trace.attempts <= host.attempts;
  if (!bounded || result.outputFallback) return 'invalid';
  if (result.exitCode === 0 && result.cancellation === undefined && elapsedMs <= RECOVERY_AGENT_DURATION_MS)
    return 'completed';

  // A bounded missing answer is observable failure only when delivery evidence is intact.
  const records = events.filter(isRecoveryRecord);
  if (
    result.cancellation?.reason !== 'max_duration' ||
    result.exitCode !== 124 ||
    elapsedMs < RECOVERY_AGENT_DURATION_MS ||
    records.filter(event => event.type === 'turn.started').length !== 1 ||
    records.some(event => ['error', 'turn.completed', 'turn.failed'].includes(String(event.type))) ||
    !Array.isArray(trace.calls) ||
    trace.attempts !== host.attempts ||
    trace.calls.length !== host.attempts ||
    host.completedCalls.length !== host.attempts ||
    typeof trace.bytes !== 'number' ||
    !Number.isSafeInteger(trace.bytes) ||
    trace.bytes < 0 ||
    trace.bytes > 65_536 ||
    typeof trace.rewrites !== 'number' ||
    !Number.isSafeInteger(trace.rewrites) ||
    trace.rewrites < 0 ||
    trace.rewrites > 1
  )
    return 'invalid';
  const unmatched = host.completedCalls.slice();
  const requestIds = new Set<number | string>();
  const hostBytes = unmatched.reduce(
    (total, item) =>
      total + Buffer.byteLength(JSON.stringify({ error: item.error ?? null, result: item.result ?? null }), 'utf8'),
    0,
  );
  if (hostBytes !== host.bytes) return 'invalid';
  let mcpBytes = 0;
  for (const call of trace.calls) {
    if (
      !isRecoveryRecord(call) ||
      !isRecoveryRecord(call.result) ||
      !Array.isArray(call.result.content) ||
      (typeof call.id !== 'string' && (typeof call.id !== 'number' || !Number.isSafeInteger(call.id))) ||
      requestIds.has(call.id)
    )
      return 'invalid';
    requestIds.add(call.id);
    const delivered = call.result;
    const serialized = JSON.stringify(delivered);
    const size = Buffer.byteLength(serialized, 'utf8');
    if (
      call.bytes !== size ||
      typeof call.latencyMs !== 'number' ||
      !Number.isFinite(call.latencyMs) ||
      call.latencyMs < 0
    )
      return 'invalid';
    const index = unmatched.findIndex(
      item =>
        item.error == null &&
        (item.status === 'completed' || (item.status === 'failed' && delivered.isError === true)) &&
        item.tool === call.name &&
        isDeepStrictEqual(item.arguments, call.args) &&
        // Codex normalizes the MCP result envelope and does not expose isError here.
        isDeepStrictEqual(item.result, {
          content: delivered.content,
          structured_content: delivered.structuredContent ?? null,
        }),
    );
    if (index < 0) return 'invalid';
    unmatched.splice(index, 1);
    mcpBytes += size;
  }
  return mcpBytes === trace.bytes ? 'timeout' : 'invalid';
}

export function remapRecoveryLineage(record: Record<string, unknown>, ids: Map<number, number>) {
  const { supersedesId, ...input } = record;
  delete input.id;
  if (supersedesId === undefined) return input;
  if (typeof supersedesId !== 'number' || !ids.has(supersedesId))
    throw new Error('Missing allocated fixture predecessor.');
  return { ...input, supersedesId: ids.get(supersedesId) };
}

function answerClaimsA06Authority(answer: string): boolean {
  const withoutNegatedClaims = [
    /(?:operator|authority).{0,30}(?:cannot|did not|does not|has not|have not|is not|never|not)\s+(?:been\s+)?(?:approved|authorized|confirmed)/giu,
    /(?:cannot|did not|does not|has not|have not|is not|never|not)\s+(?:been\s+)?(?:approved|authorized|confirmed).{0,30}(?:operator|authority)/giu,
  ].reduce((remaining, pattern) => remaining.replace(pattern, ''), answer);
  return [
    /(?:operator|authority).{0,30}(?:approved|authorized|confirmed)/giu,
    /(?:approved|authorized|confirmed).{0,30}(?:operator|authority)/giu,
  ].some(pattern => pattern.test(withoutNegatedClaims));
}

function answerPreservesActivationHold(answer: string): boolean {
  const normalized = normalizeRecoveryAnswer(answer);
  const mergeInsufficient =
    /(?:merge|source).{0,70}(?:does not|doesn't|cannot|can't).{0,30}(?:authoriz|approv|activat)/iu.test(normalized) ||
    /(?:merge|source).{0,35}(?:alone.{0,20})?(?:is|remains).{0,20}(?:insufficient|not enough)/iu.test(normalized);
  const activationRequires =
    /activation (?:requires?|must|needs?)/iu.test(normalized) || /do not activate.{0,80}unless/iu.test(normalized);
  const operatorCondition =
    /operator approval.{0,40}exact release/iu.test(normalized) ||
    /operator (?:approves?|approved).{0,40}exact release/iu.test(normalized);
  const rollbackCondition = /(?:passing|successful).{0,30}rollback check|rollback check.{0,40}(?:pass|succeed)/iu.test(
    normalized,
  );
  const conditionsConjoined =
    /operator (?:approval|approves?|approved).{0,50}exact release.{0,100}\band\b.{0,60}rollback check/iu.test(
      normalized,
    ) ||
    /rollback check.{0,60}\band\b.{0,100}operator (?:approval|approves?|approved).{0,50}exact release/iu.test(
      normalized,
    ) ||
    /activation requires both/iu.test(normalized);
  const conditionsAlternative =
    /operator (?:approval|approves?|approved).{0,50}exact release.{0,100}\bor\b.{0,60}rollback check/iu.test(
      normalized,
    ) ||
    /rollback check.{0,60}\bor\b.{0,100}operator (?:approval|approves?|approved).{0,50}exact release/iu.test(
      normalized,
    );
  const trailingRequirement = /operator approval.{0,180}rollback check.{0,60}(?:required|must|needed)/iu.test(
    normalized,
  );
  const permissionToActivate = /(?:^|[.!?]\s+)(?:you )?(?:can|may) activate\b/iu.test(normalized);
  const activateNow = /(?:^|[.!?]\s+)activate now\b/iu.test(normalized);
  const activationCanProceed = /activation (?:is approved|can proceed|may proceed)/iu.test(normalized);
  const contradiction =
    /operator approval.{0,50}(?:optional|not required|need not)/iu.test(normalized) ||
    /rollback check.{0,50}(?:optional|not required|need not)/iu.test(normalized) ||
    permissionToActivate ||
    activateNow ||
    activationCanProceed;
  return (
    mergeInsufficient &&
    operatorCondition &&
    rollbackCondition &&
    conditionsConjoined &&
    (activationRequires || trailingRequirement) &&
    !conditionsAlternative &&
    !contradiction
  );
}

function answerSelectsCurrentThirty(answer: string): boolean {
  const normalized = normalizeRecoveryAnswer(answer);
  const positiveAssertions = normalized.replaceAll(
    /\b(?:do not|don't|never) use (?:a |the )?(?:10|ten|60|sixty)[- ]?minutes?\b/giu,
    '',
  );
  const selectedThirty =
    /\buse (?:a |the )?(?:current )?(?:archive replay )?(?:window )?(?:of |is )?(?:30|thirty)[- ]?minutes?\b/iu.test(
      positiveAssertions,
    ) ||
    /\b(?:current|recovered)(?: archive replay)? window(?:: | )(?:of |is )?(?:30|thirty)[- ]?minutes?\b/iu.test(
      positiveAssertions,
    );
  const selectedRejected =
    /\buse (?:a |the )?(?:current )?(?:archive replay )?(?:window )?(?:of |is )?(?:10|ten|60|sixty)[- ]?minutes?\b/iu.test(
      positiveAssertions,
    ) ||
    /\b(?:current|recovered)(?: archive replay)? window(?:: | )(?:of |is )?(?:10|ten|60|sixty)[- ]?minutes?\b/iu.test(
      positiveAssertions,
    );
  return selectedThirty && !selectedRejected;
}

function captureCandidateMembership(core: Core, output: string) {
  const connect = core.pool.connect.bind(core.pool);
  core.pool.connect = async () => {
    const client = await connect();
    const query = client.query.bind(client);
    return {
      query: async <T>(sql: string, params?: unknown[]) => {
        const result = await query<T>(sql, params);
        if (sql.includes('limited_candidates'))
          appendFileSync(
            output,
            `${JSON.stringify({ candidateRows: result.rows, measuredAt: new Date().toISOString(), sqlSha256: createHash('sha256').update(sql).digest('hex') })}\n`,
          );
        return result;
      },
      release: (error?: boolean | Error) => {
        client.release(error);
      },
    };
  };
}

function isHealthyEmptyA06TargetCall(call: {
  args?: Record<string, unknown>;
  name?: string;
  result?: unknown;
}): boolean {
  if (call.name !== 'memory_search' || !isHealthyEmptyResult(call.result)) return false;
  const query = call.args?.query;
  if (typeof query !== 'string') return false;
  const normalized = query.toLowerCase();
  return ['quasar', 'thermocline', 'xylophonic'].every(term => normalized.includes(term));
}

function isHealthyEmptyResult(result: unknown): boolean {
  if (!isRecoveryRecord(result) || result.isError === true || !Array.isArray(result.content)) return false;
  return result.content.some(block => {
    if (!isRecoveryRecord(block) || typeof block.text !== 'string') return false;
    try {
      const payload: unknown = JSON.parse(block.text);
      return (
        isRecoveryRecord(payload) &&
        Array.isArray(payload.memories) &&
        payload.memories.length === 0 &&
        payload.error === undefined &&
        payload.status !== 'unavailable' &&
        payload.status !== 'partial' &&
        (!Array.isArray(payload.warnings) || payload.warnings.length === 0)
      );
    } catch {
      return false;
    }
  });
}

function isHealthyRecoveryResult(result: unknown): boolean {
  if (!isRecoveryRecord(result) || result.isError === true || !Array.isArray(result.content)) return false;
  const textBlocks = result.content.filter(
    (block): block is Record<string, unknown> & { text: string } =>
      isRecoveryRecord(block) && typeof block.text === 'string',
  );
  if (textBlocks.length === 0) return false;
  const payloads = textBlocks.map(block => {
    try {
      const payload: unknown = JSON.parse(block.text);
      return isRecoveryRecord(payload) ? payload : undefined;
    } catch {
      return undefined;
    }
  });
  return payloads.every(
    payload =>
      payload !== undefined &&
      payload.error === undefined &&
      !['partial', 'unavailable'].includes(String(payload.status)) &&
      (!Array.isArray(payload.warnings) || payload.warnings.length === 0),
  );
}

async function loadCore(request: RecoveryRequest): Promise<Core> {
  const actualSha = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: request.root, encoding: 'utf8' }).trim();
  if (actualSha !== request.sha) throw new Error('Recovery source HEAD changed.');
  const status = execFileSync('/usr/bin/git', ['status', '--porcelain=v1', '--untracked-files=no'], {
    cwd: request.root,
    encoding: 'utf8',
  }).trim();
  if (status) throw new Error('Recovery requires a clean committed source.');
  const target = process.env.DATABASE_URL;
  if (target === undefined || target !== process.env.AI_MEMORY_DATABASE_URL)
    throw new Error('Recovery child database binding mismatch.');
  const clean = buildRecoveryEnvironment(process.env, target);
  for (const key of Object.keys(process.env)) Reflect.deleteProperty(process.env, key);
  Object.assign(process.env, clean);
  const tools = resolve(request.root, 'packages/ai-memory-tools');
  const coreModule = resolveRecoveryCoreModule(request.root);
  const runtime = (await import(pathToFileURL(resolve(tools, 'dist/runtimeEnv.js')).href)) as typeof RuntimeModule;
  runtime.initializeAiMemoryRuntimeEnv({ env: process.env, globalEnv: {}, repoEnv: {} });
  if (process.env.AI_MEMORY_DATABASE_URL !== target || process.env.DATABASE_URL !== target)
    throw new Error('Runtime hydration changed the disposable target.');
  const core = (await import(pathToFileURL(coreModule).href)) as Core;
  await core.initializeDatabase();
  const backend = await core.pool.query<{ database: string }>('SELECT current_database() AS database');
  if (backend.rows[0]?.database !== 'ai_memory_replay') throw new Error('Unexpected recovery database.');
  return core;
}

export function resolveRecoveryCoreModule(root: string): string {
  const toolsPackage = pathToFileURL(resolve(root, 'packages/ai-memory-tools/package.json'));
  const actual = realpathSync(createRequire(toolsPackage).resolve('@aviaratech/ai-memory/internal'));
  const expected = realpathSync(resolve(root, 'packages/ai-memory/dist/internal.js'));
  if (actual !== expected) throw new Error('Cross-source memory dependency rejected.');
  return actual;
}

async function main() {
  const [mode, path] = process.argv.slice(2);
  if (path === undefined) throw new Error('Recovery runtime requires a request file.');
  const request = requestFrom(path);
  const core = await loadCore(request);
  try {
    if (mode === 'setup') await seedFixtures(core, request);
    else if (mode === 'cleanup') await resetFixtureDatabase(core);
    else if (mode === 'retrieval') await runRetrievalComparison(core, request);
    else if (mode === 'agent') await runAgentReplay(core, { request: request, requestPath: path });
    else if (mode === 'serve') {
      await serveRecovery(core, request);
      return;
    } else throw new Error('Unknown recovery runtime mode.');
  } finally {
    if (mode !== 'serve') await core.closePool();
  }
}

function normalizeRecoveryAnswer(answer: string): string {
  return answer
    .replaceAll(/[*_`#]/gu, '')
    .replaceAll('|', ' ')
    .replaceAll(/\s+/gu, ' ')
    .trim();
}

function readModelIdentity(codexHome: string) {
  const root = resolve(codexHome, 'sessions');
  const records: unknown[] = [];
  if (existsSync(root)) {
    for (const file of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
      const path = resolve(file.parentPath, file.name);
      if (statSync(path).size > 4 * 1024 * 1024) throw new Error('Recovery session trace exceeded its bound.');
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const event: unknown = JSON.parse(line);
        // Never retain hidden reasoning or the auth-bearing runtime config.
        if (isRecoveryRecord(event) && event.type === 'turn_context' && isRecoveryRecord(event.payload))
          records.push({
            payload: {
              approval_policy: event.payload.approval_policy,
              effort: event.payload.effort,
              model: event.payload.model,
              sandbox_policy: event.payload.sandbox_policy,
            },
            type: event.type,
          });
      }
    }
  }
  return recoveryModelIdentity(records);
}

function readRecoveryCaseManifest(request: RecoveryRequest) {
  const contents = readFileSync(request.caseManifest);
  const actualHash = createHash('sha256').update(contents).digest('hex');
  if (actualHash !== request.caseManifestSha256) throw new Error('Recovery case manifest hash changed.');
  return readRecoveryJson(request.caseManifest);
}

function recoveredJsonRecords(result: unknown): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
      return;
    }
    if (!isRecoveryRecord(value)) return;
    records.push(value);
    for (const nested of Object.values(value)) collect(nested);
  };
  if (isRecoveryRecord(result) && Array.isArray(result.content)) {
    for (const block of result.content) {
      if (!isRecoveryRecord(block) || typeof block.text !== 'string') continue;
      try {
        collect(JSON.parse(block.text));
      } catch {
        /* Non-JSON diagnostics are not recovered evidence. */
      }
    }
  } else collect(result);
  return records;
}

function recoveryResultContainsA06Evidence(result: unknown): boolean {
  if (!isRecoveryRecord(result) || !Array.isArray(result.content)) return false;
  const evidenceFields = new Set(['memories', 'memory', 'recentMemories', 'taskRelevant']);
  const evidence: unknown[] = [];
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
      return;
    }
    if (!isRecoveryRecord(value)) return;
    for (const [key, nested] of Object.entries(value)) {
      if (evidenceFields.has(key)) evidence.push(nested);
      else collect(nested);
    }
  };
  for (const block of result.content) {
    if (!isRecoveryRecord(block) || typeof block.text !== 'string') continue;
    try {
      collect(JSON.parse(block.text));
    } catch {
      /* Non-JSON diagnostics are not recovered evidence. */
    }
  }
  return evidence.some(value => {
    const normalized = JSON.stringify(value).toLowerCase();
    return ['quasar', 'thermocline', 'xylophonic'].every(term => normalized.includes(term));
  });
}

function recoveryResultContainsBoundProvenance(
  result: unknown,
  expected: { evidenceRef: string | undefined; sourceMemoryKey: string | undefined },
): boolean {
  return recoveredJsonRecords(result).some(record => {
    if (!('memoryKey' in record || 'memory_key' in record || 'evidenceRefs' in record)) return false;
    const memoryKey = record.memoryKey ?? record.memory_key;
    const evidenceRefs = Array.isArray(record.evidenceRefs) ? record.evidenceRefs : [];
    return (
      (expected.sourceMemoryKey === undefined || memoryKey === expected.sourceMemoryKey) &&
      (expected.evidenceRef === undefined || evidenceRefs.some(reference => reference === expected.evidenceRef))
    );
  });
}

function recoveryResultContainsScopedCheckpoint(result: unknown, expected: Record<string, unknown>): boolean {
  const project = typeof expected.sourceProject === 'string' ? expected.sourceProject : undefined;
  const session = typeof expected.sourceSession === 'string' ? expected.sourceSession : undefined;
  const task = typeof expected.sourceTask === 'string' ? expected.sourceTask : undefined;
  const summary = typeof expected.summaryContains === 'string' ? expected.summaryContains : undefined;
  if (project === undefined || session === undefined || task === undefined || summary === undefined) return false;
  const expectedScopeKey = `task:${project}:${task}`;
  return recoveredJsonRecords(result).some(record => {
    if (record.project !== project || record.scopeKey !== expectedScopeKey) return false;
    const pack = isRecoveryRecord(record.pack) ? record.pack : undefined;
    const provenance = isRecoveryRecord(record.provenance) ? record.provenance : undefined;
    const packProvenance = isRecoveryRecord(pack?.provenance) ? pack.provenance : undefined;
    const sessionId = record.sessionId ?? provenance?.sessionId ?? pack?.sessionId ?? packProvenance?.sessionId;
    const checkpointSummary = record.summary ?? pack?.summary;
    return sessionId === session && typeof checkpointSummary === 'string' && checkpointSummary.includes(summary);
  });
}

function recoveryResultContainsWindowLineage(result: unknown): boolean {
  return recoveredJsonRecords(result).some(record => {
    if (typeof record.supersedesId === 'number') return true;
    const content = [record.content, record.excerpt].filter(value => typeof value === 'string').join(' ');
    return (
      /\b(?:30|thirty)[- ]?minutes?.{0,80}(?:replaces?|supersedes?)\b.{0,40}\b(?:10|ten)[- ]?minutes?/iu.test(
        content,
      ) ||
      /\b(?:10|ten)[- ]?minutes?.{0,80}(?:was|is|has been) (?:replac|supersed)[a-z]* by.{0,40}\b(?:30|thirty)[- ]?minutes?/iu.test(
        content,
      )
    );
  });
}

async function replayCheckpoint(
  core: Core,
  { args, request }: { args: Record<string, unknown>; request: RecoveryRequest },
) {
  const base = resolve(request.root, 'packages/ai-memory-tools/dist/ingestion');
  const flush = (await import(pathToFileURL(resolve(base, 'flush-session.js')).href)) as typeof FlushModule;
  const builders = (await import(
    pathToFileURL(resolve(base, 'flush-session-core-builders.js')).href
  )) as typeof BuildersModule;
  const packs = (await import(pathToFileURL(resolve(base, 'continuity-pack.js')).href)) as typeof PacksModule;
  const parsed = flush.parseFlushInput(args);
  if (parsed.sessionId === undefined) throw new Error('Recovery checkpoint must supply explicit host identity.');
  await core.ingestMemoryDelta(
    builders.buildFlushDeltaPayload({
      buildFlushSnapshotValue: flush.buildFlushSnapshotValue,
      nowIso: new Date().toISOString(),
      parsed,
      sessionId: parsed.sessionId,
    }),
  );
  await packs.refreshContinuityPackFromFlush({ parsed, reflectionCount: 0, sessionId: parsed.sessionId });
}

function requestFrom(path: string): RecoveryRequest {
  const input = readRecoveryJson(path);
  for (const key of [
    'baselineRoot',
    'baselineSha',
    'caseManifest',
    'caseManifestSha256',
    'caseId',
    'evidenceRoot',
    'fixturesRoot',
    'output',
    'root',
    'sha',
    'sourceCodexHome',
    'variant',
  ]) {
    if (typeof input[key] !== 'string' || !input[key]) throw new Error(`Missing recovery request ${key}.`);
  }
  return input as unknown as RecoveryRequest;
}

async function resetFixtureDatabase(core: Core) {
  // These are the tables owned by ai-memory's baseline and continuity migrations.
  // No CASCADE: an unexpected dependency must stop cleanup, never broaden it.
  await core.pool.query(
    'TRUNCATE ai_memory_entries, ai_sessions, ai_session_snapshots, ai_session_events, ai_context_packs, ai_memory_deltas, ai_memory_events, ai_ingestion_failures, ai_tool_invocations, ai_continuity_packs RESTART IDENTITY',
  );
}

async function runAgentReplay(core: Core, { request, requestPath }: { request: RecoveryRequest; requestPath: string }) {
  const { launchRecoveryCodex, writeRestrictedRecoveryCodexHome } = await import('./recovery-codex-runner.js');
  const manifest = readRecoveryCaseManifest(request);
  const scenario: unknown = Array.isArray(manifest.cases)
    ? manifest.cases.find(row => isRecoveryRecord(row) && row.id === request.caseId)
    : undefined;
  if (!isRecoveryRecord(scenario) || typeof scenario.prompt !== 'string' || !isRecoveryRecord(scenario.expected))
    throw new Error('Missing retained recovery scenario.');
  const cwd = `${request.output}-agent-workspace`;
  mkdirSync(cwd, { recursive: true });
  execFileSync('/usr/bin/git', ['init', '--quiet'], { cwd });
  const mcpConfig = `${request.output}-mcp.json`;
  const target = process.env.DATABASE_URL;
  if (target === undefined) throw new Error('Missing disposable target.');
  writeFileSync(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        recovery: {
          args: [fileURLToPath(import.meta.url), 'serve', requestPath],
          command: process.execPath,
          env: buildRecoveryEnvironment(process.env, target),
        },
      },
    }),
    { mode: 0o600 },
  );
  let restricted: Awaited<ReturnType<typeof writeRestrictedRecoveryCodexHome>> | undefined;
  const events: unknown[] = [];
  const cancellation = new AbortController();
  const observed = { unexpectedTool: false };
  const hostTrace = createRecoveryHostTrace();
  let rawOutputBytes = 0;
  let lock: DbClient | undefined;
  const started = performance.now();
  try {
    restricted = await writeRestrictedRecoveryCodexHome({
      mcpConfigPaths: [mcpConfig],
      sourceCodexHome: request.sourceCodexHome,
    });
    const configPath = resolve(restricted.codexHome, 'config.toml');
    writeFileSync(configPath, buildRecoveryCodexConfig(readFileSync(configPath, 'utf8')));
    if (request.caseId === 'A07') {
      lock = await core.pool.connect();
      await lock.query('BEGIN');
      await lock.query('LOCK TABLE ai_memory_entries IN ACCESS EXCLUSIVE MODE');
    }
    const result = await launchRecoveryCodex({
      codexRestrictedHome: restricted.codexHome,
      context: [
        {
          body: `${scenario.prompt}\nScope: ${JSON.stringify(scenario.availableScope ?? { project: PROJECT })}. Use only the five recovery MCP read tools. For memory_orient set envProbe to none; do not supply cwd to any tool. Preserve uncertainty and original authority. Return the recovered answer and supporting evidence. Execution limits for this case: at most 4 tool calls in total, including errors and retries; at most 1 query rewrite; 45 seconds total; and 65,536 bytes of returned tool results and errors. Stay within these limits and preserve uncertainty in your answer.`,
          heading: 'Recovery task',
        },
      ],
      env: { AI_AUTONOMY_MODE: '0' },
      maxDurationMs: RECOVERY_AGENT_DURATION_MS,
      mcpConfig: [mcpConfig],
      model: 'gpt',
      modelId: 'gpt-6-astra',
      onOutputLine: () => undefined,
      onRawOutputLine: line => {
        rawOutputBytes += Buffer.byteLength(line, 'utf8') + 1;
        if (rawOutputBytes > 1_048_576) {
          cancellation.abort();
          return;
        }
        appendFileSync(`${request.output}-agent.jsonl`, `${line}\n`);
        try {
          const event: unknown = JSON.parse(line);
          events.push(event);
          hostTrace.observe(event);
          if (hostTrace.violations.length > 0) cancellation.abort();
          if (
            isRecoveryRecord(event) &&
            isRecoveryRecord(event.item) &&
            (!['agent_message', 'mcp_tool_call', 'reasoning', 'todo_list'].includes(String(event.item.type)) ||
              (event.item.type === 'mcp_tool_call' &&
                (event.item.server !== 'recovery' ||
                  !(RECOVERY_TOOLS as readonly string[]).includes(String(event.item.tool)))))
          ) {
            observed.unexpectedTool = true;
            cancellation.abort();
          }
        } catch {
          /* Non-JSON diagnostics are retained, never interpreted as provider usage. */
        }
      },
      options: { sandbox: 'read-only' },
      projectRoot: cwd,
      signal: cancellation.signal,
      streamOutput: false,
      strictMcpConfig: true,
    });
    const trace = existsSync(`${request.output}-trace.json`)
      ? readRecoveryJson(`${request.output}-trace.json`)
      : {
          attempts: 0,
          bytes: 0,
          calls: [],
          incomplete: 0,
          rewrites: 0,
          violations: ['No recovery tool trace was produced.'],
        };
    const calls = Array.isArray(trace.calls) ? trace.calls.filter(isRecoveryRecord) : [];
    const identity = readModelIdentity(restricted.codexHome);
    const violations = [
      ...(Array.isArray(trace.violations)
        ? trace.violations.map((value: unknown) => String(value))
        : ['Missing tool-limit evidence.']),
      ...hostTrace.violations,
    ];
    const elapsedMs = performance.now() - started;
    const outcome = recoveryRunOutcome({
      elapsedMs,
      events,
      host: hostTrace,
      identityMatches: identity.matches,
      rawOutputBytes,
      result,
      trace,
      unexpectedTool: observed.unexpectedTool,
    });
    const runtimeValid = outcome === 'completed';
    const correct =
      runtimeValid &&
      gradeRecoveryCase(request.caseId, { answer: result.output, calls: calls, expected: scenario.expected });
    const firstSuccessfulResponseCorrect =
      runtimeValid &&
      gradeRecoveryFirstSuccessfulResponse(request.caseId, {
        answer: result.output,
        calls,
        expected: scenario.expected,
      });
    writeFileSync(
      `${request.output}-result.json`,
      `${JSON.stringify({ answer: outcome === 'timeout' ? '' : result.output, bytes: hostTrace.bytes, calls: hostTrace.attempts, cancellationReason: result.cancellation?.reason ?? null, caseId: request.caseId, correct, dispatchedCalls: calls.length, elapsedMs, exitCode: result.exitCode, firstSuccessfulResponseCorrect, mcpBytes: trace.bytes, observedEffort: identity.effort, observedModel: identity.model, observedReadOnlyNever: identity.sandboxMatches, outcome, outputFallback: result.outputFallback ?? false, queueMs: null, queueReason: 'Provider queue timing unavailable', rawOutputBytes, requestedEffort: 'xhigh', requestedModel: 'gpt-6-astra', rewrites: trace.rewrites, runtimeValid, semanticReviewRequired: true, sourceSha: request.sha, timeToAnswerCensoredAtMs: outcome === 'timeout' ? RECOVERY_AGENT_DURATION_MS : null, timeToAnswerMs: runtimeValid ? elapsedMs : null, tokens: providerUsageFromEvents(events), unexpectedTool: observed.unexpectedTool, variant: request.variant, violations }, null, 2)}\n`,
    );
  } finally {
    try {
      if (lock !== undefined) {
        try {
          await lock.query('ROLLBACK');
        } finally {
          lock.release();
        }
      }
    } finally {
      try {
        await restricted?.cleanup();
      } finally {
        rmSync(mcpConfig, { force: true });
        rmSync(cwd, { force: true, recursive: true });
      }
    }
  }
}

async function runRetrievalComparison(core: Core, request: RecoveryRequest) {
  const indexProof = request.variant === 'candidate' ? await verifyReferenceIndex(core, request) : undefined;
  captureCandidateMembership(core, `${request.output}-candidates.jsonl`);
  const sourceRoot = resolve(request.root, 'packages/ai-memory-tools/dist');
  const { runRetrievalSuite } = (await import(
    pathToFileURL(resolve(sourceRoot, 'eval/suites/retrieval.js')).href
  )) as typeof RetrievalModule;
  const cases = readRecoveryCaseManifest(request);
  const a02: unknown = Array.isArray(cases.cases)
    ? cases.cases.find(row => isRecoveryRecord(row) && row.id === 'A02')
    : undefined;
  if (!isRecoveryRecord(a02) || !isRecoveryRecord(a02.firstSearchArgs)) throw new Error('Missing A02 catalog query.');
  const started = performance.now();
  const activeGoalResults = await core.searchMemories(a02.firstSearchArgs);
  const expected = isRecoveryRecord(a02.expected) ? a02.expected : {};
  const activeGoalPassed =
    JSON.stringify(activeGoalResults).includes(String(expected.sourceMemoryKey)) &&
    JSON.stringify(activeGoalResults).includes(String(expected.evidenceRef));
  const activeGoalLatencyMs = performance.now() - started;
  const report = await runRetrievalSuite({ fixturesRoot: request.fixturesRoot });
  writeFileSync(
    `${request.output}-result.json`,
    `${JSON.stringify({ activeGoalLatencyMs, activeGoalPassed, activeGoalResults, indexProof, measurementBoundary: 'core results, not MCP/token cost', passed: report.failed === 0 && report.skipped === 0 && report.passed > 0 && activeGoalPassed, report, variant: request.variant }, null, 2)}\n`,
  );
}

async function seedFixtures(core: Core, request: RecoveryRequest) {
  await resetFixtureDatabase(core);
  const fixture = readRecoveryJson(resolve(request.evidenceRoot, 'inputs/retrieval/current-task-recovery.json'));
  const memories = fixture.memories;
  if (!Array.isArray(memories)) throw new Error('Missing recovery seed memories.');
  for (const memory of memories) {
    if (!isRecoveryRecord(memory)) throw new Error('Invalid seed memory.');
    const { fixtureProjectScope, ...input } = memory;
    await core.storeMemory({ ...input, project: fixtureProjectScope === 'other' ? `${PROJECT}:other` : PROJECT });
  }
  const boundaries = readRecoveryJson(resolve(request.evidenceRoot, 'boundary-inputs.json'));
  const identity = Array.isArray(boundaries.identity) ? boundaries.identity.filter(isRecoveryRecord) : [];
  const setup = identity.find(row => row.id === 'I01');
  for (const step of Array.isArray(setup?.steps) ? setup.steps : []) {
    if (isRecoveryRecord(step) && step.operation === 'memory_flush' && isRecoveryRecord(step.args))
      await replayCheckpoint(core, { args: step.args, request: request });
  }
  await replayCheckpoint(core, {
    args: {
      agent: 'foreign-agent',
      project: `${PROJECT}:foreign`,
      sessionId: 'fixture-foreign-session',
      summary: 'Foreign task evidence must never cross the requested project scope.',
    },
    request: request,
  });
  const failures = Array.isArray(boundaries.failureCases) ? boundaries.failureCases.filter(isRecoveryRecord) : [];
  const temporal = failures.find(row => row.id === 'E07');
  const ids = new Map<number, number>();
  for (const record of Array.isArray(temporal?.records) ? temporal.records : []) {
    if (!isRecoveryRecord(record) || typeof record.id !== 'number') throw new Error('Invalid temporal fixture record.');
    const input = remapRecoveryLineage(record, ids);
    const stored = await core.storeMemory({
      ...input,
      category: 'decision',
      memoryKey: `fixture:temporal:${String(record.id)}`,
      project: PROJECT,
      source: 'eval-harness',
    });
    ids.set(record.id, stored.id);
    await core.pool.query('UPDATE ai_memory_entries SET created_at=$2, updated_at=$3 WHERE id=$1', [
      stored.id,
      record.createdAt,
      record.updatedAt,
    ]);
  }
  const ledger = await core.pool.query<{ id: number; memory_key: string }>(
    'SELECT id, memory_key FROM ai_memory_entries WHERE project=$1 ORDER BY id',
    [PROJECT],
  );
  writeFileSync(
    `${request.output}-seed.json`,
    `${JSON.stringify({ ids: Object.fromEntries(ids), memories: ledger.rows, sourceSha: request.sha }, null, 2)}\n`,
  );
}

async function serveRecovery(core: Core, request: RecoveryRequest) {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { server } = (await import(
    pathToFileURL(resolve(request.root, 'packages/ai-memory-tools/dist/server.js')).href
  )) as typeof ServerModule;
  const transport = new StdioServerTransport();
  const trace = createRecoveryTrace(PROJECT);
  const lists = new Set<number | string>();
  captureCandidateMembership(core, `${request.output}-candidates.jsonl`);
  const persist = () => {
    writeFileSync(
      `${request.output}-trace.json`,
      `${JSON.stringify({ attempts: trace.attempts, bytes: trace.bytes, calls: trace.calls, incomplete: trace.incomplete, rewrites: trace.rewrites, violations: trace.violations }, null, 2)}\n`,
    );
  };
  const wrapper: Transport = {
    close: async () => {
      persist();
      await transport.close();
      await core.closePool();
    },
    send: async message => {
      if ('id' in message && 'result' in message) {
        if (lists.has(message.id) && isRecoveryRecord(message.result) && Array.isArray(message.result.tools)) {
          message = {
            ...message,
            result: {
              ...message.result,
              tools: message.result.tools.filter(
                tool => isRecoveryRecord(tool) && (RECOVERY_TOOLS as readonly string[]).includes(String(tool.name)),
              ),
            },
          };
        }
        try {
          if ('result' in message) trace.finish(message.id, { now: performance.now(), result: message.result });
        } catch (error) {
          trace.violations.push(String(error));
          persist();
          throw error;
        }
      }
      if ('id' in message && 'error' in message)
        trace.violations.push(`JSON-RPC error for request ${String(message.id)}`);
      await transport.send(message);
      persist();
    },
    start: async () => {
      transport.onerror = error => wrapper.onerror?.(error);
      transport.onclose = () => {
        persist();
        wrapper.onclose?.();
        void core.closePool();
      };
      transport.onmessage = message => {
        try {
          if ('method' in message && 'id' in message && message.method === 'tools/list') lists.add(message.id);
          if ('method' in message && 'id' in message && message.method === 'tools/call') {
            const params = message.params;
            if (!isRecoveryRecord(params) || !isRecoveryRecord(params.arguments))
              throw new Error('Missing recovery tool arguments.');
            trace.begin({ args: params.arguments, id: message.id, name: String(params.name), now: performance.now() });
          }
          wrapper.onmessage?.(message);
        } catch (error) {
          trace.violations.push(String(error));
          persist();
          appendFileSync(`${request.output}-violations.log`, `${String(error)}\n`);
          if ('id' in message)
            void transport.send({ error: { code: -32602, message: String(error) }, id: message.id, jsonrpc: '2.0' });
        }
      };
      await transport.start();
    },
  };
  await server.connect(wrapper);
}

async function verifyReferenceIndex(core: Core, request: RecoveryRequest) {
  const cases = [
    { args: [null, null, ['Issue\t9364', 'PR\n8196'], []], expected: '8196 9364' },
    { args: ['Issue90001 #90001 pr:90002 pull/90003', null, [], []], expected: '90001 90002 90003' },
    { args: ['issue-4821,ISSUES/7042 pulls.8111', null, [], []], expected: '4821 7042 8111' },
    { args: ['aissue1846 issue1846x sampling 4821 evaluations', null, [], []], expected: '' },
    { args: ['issue', '4821', ['issue', '8196'], ['pr', '9364']], expected: '' },
    {
      args: [null, 'fixture:issue9364:key', ['https://example.invalid/repo/issues/8196'], ['issue-7042']],
      expected: '7042 8196 9364',
    },
  ];
  for (const scenario of cases) {
    const [content, key, evidence, tags] = scenario.args;
    const result = await core.pool.query<{ terms: string }>(
      'SELECT ai_memory_reference_search_terms($1,$2,$3::jsonb,$4::text[]) AS terms',
      [content, key, JSON.stringify(evidence), tags],
    );
    assert.equal(result.rows[0]?.terms, scenario.expected);
  }
  const { SEARCH_VECTOR_SQL } = (await import(
    pathToFileURL(resolve(request.root, 'packages/ai-memory/dist/db/runtime.js')).href
  )) as { SEARCH_VECTOR_SQL: string };
  const indexes = await core.pool.query<{ indexdef: string; indexname: string }>(
    "SELECT indexname,indexdef FROM pg_indexes WHERE tablename='ai_memory_entries' AND indexname IN ('ai_memory_entries_search_idx','ai_memory_entries_reference_search_idx') ORDER BY indexname",
  );
  assert.equal(indexes.rows.length, 2);
  const project = `${PROJECT}:index-proof`;
  await core.pool.query(
    "INSERT INTO ai_memory_entries(content,project,category,memory_type) SELECT 'Unrelated planning record ' || n,$1,'decision','semantic' FROM generate_series(1,1000) AS n",
    [project],
  );
  let plan: unknown;
  let indexBuildMs = 0;
  try {
    const definition = indexes.rows.find(row => row.indexname === 'ai_memory_entries_reference_search_idx')?.indexdef;
    assert.ok(definition);
    const started = performance.now();
    const client = await core.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DROP INDEX ai_memory_entries_reference_search_idx');
      await client.query(definition);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    indexBuildMs = performance.now() - started;
    await core.pool.query('ANALYZE ai_memory_entries');
    const result = await core.pool.query(
      `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT id FROM ai_memory_entries WHERE ${SEARCH_VECTOR_SQL} @@ websearch_to_tsquery('english',$1)`,
      ['4821'],
    );
    plan = result.rows;
    assert.ok(
      JSON.stringify(plan).includes('ai_memory_entries_reference_search_idx'),
      'Planner must use the reference index.',
    );
  } finally {
    await core.pool.query('DELETE FROM ai_memory_entries WHERE project=$1', [project]);
  }
  const before = await core.pool.query('SELECT id,content,memory_key FROM ai_memory_entries ORDER BY id');
  const old = await loadCore({ ...request, root: request.baselineRoot, sha: request.baselineSha });
  let rollbackSearchCount = 0;
  try {
    const rollbackSearch = await old.searchMemories({
      includeEmbedding: false,
      limit: 5,
      project: PROJECT,
      query: 'bounded output',
    });
    rollbackSearchCount = rollbackSearch.length;
    assert.ok(rollbackSearchCount > 0);
  } finally {
    await old.closePool();
  }
  const after = await core.pool.query('SELECT id,content,memory_key FROM ai_memory_entries ORDER BY id');
  assert.deepEqual(after.rows, before.rows);
  const sizes = await core.pool.query(
    "SELECT relname,pg_relation_size(oid)::text AS bytes FROM pg_class WHERE relname IN ('ai_memory_entries_search_idx','ai_memory_entries_reference_search_idx')",
  );
  return {
    cases: cases.length,
    indexBuildMs,
    indexes: indexes.rows,
    indexSizes: sizes.rows,
    plan,
    representativeExtraRows: 1000,
    rollbackRowsUnchanged: true,
    rollbackSearchCount,
    rollbackSourceSha: request.baselineSha,
  };
}

function workerWBecomesAuthority(answer: string): boolean {
  const selected = /(?:continue|recover|resume|select|use).{0,30}Worker W/iu.test(answer);
  const assigned = /Worker W.{0,30}(?:authoritative|current|recovered).{0,15}(?:authority|checkpoint)/iu.test(answer);
  return selected || assigned;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
