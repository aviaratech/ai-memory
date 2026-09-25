import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RECOVERY_TOOLS = [
  'memory_continuity_pack',
  'memory_orient',
  'memory_search',
  'memory_get',
  'memory_session_resume',
] as const;
export const RECOVERY_CASE_IDS = ['A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08'] as const;
export const RECOVERY_AGENT_DURATION_MS = 45_000;
export const RECOVERY_AGENT_CHILD_TIMEOUT_MS = 60_000;
export interface RecoveryCall {
  args: Record<string, unknown>;
  bytes?: number;
  id: number | string;
  latencyMs?: number;
  name: string;
  result?: unknown;
  startedAt: number;
}

export interface RecoveryConfiguration {
  baseline: { root: string; sha: string };
  candidate: { root: string; sha: string };
  caseManifest?: string;
  evidenceRoot: string;
  outputDirectory: string;
  sourceCodexHome: string;
}

export type RecoveryOutcome = 'completed' | 'invalid' | 'timeout';

export interface RecoveryPairRow {
  bytes: number;
  calls: number;
  caseId: string;
  correct: boolean;
  elapsedMs: number;
  firstSuccessfulResponseCorrect: boolean;
  outcome: RecoveryOutcome;
  variant: 'baseline' | 'candidate';
}

export function buildRecoveryEnvironment(inherited: NodeJS.ProcessEnv, target: string): Record<string, string> {
  const url = new URL(target);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hostname !== '127.0.0.1' ||
    url.pathname !== '/ai_memory_replay' ||
    !/^\d+$/u.test(url.port) ||
    url.search ||
    url.hash
  ) {
    throw new Error('Recovery evaluation requires the explicit loopback disposable ai_memory_replay target.');
  }
  const env: Record<string, string> = {
    AI_MEMORY_DATABASE_URL: target,
    AI_MEMORY_EMBEDDING_PROVIDER: 'none',
    DATABASE_URL: target,
  };
  for (const key of ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) {
    const value = inherited[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function createRecoveryTrace(project: string) {
  const calls: RecoveryCall[] = [];
  const pending = new Map<number | string, RecoveryCall>();
  const queries = new Set<string>();
  const violations: string[] = [];
  let bytes = 0;
  let attempts = 0;
  return {
    get attempts() {
      return attempts;
    },
    begin({ args, id, name, now }: { args: Record<string, unknown>; id: number | string; name: string; now: number }) {
      attempts += 1;
      if (!(RECOVERY_TOOLS as readonly string[]).includes(name))
        throw new Error('Recovery tool allowlist rejected call.');
      if (args.project !== project || (args.repoId !== undefined && args.repoId !== project))
        throw new Error('Recovery project scope rejected call.');
      if (args.cwd !== undefined || (name === 'memory_orient' && args.envProbe !== 'none'))
        throw new Error('Recovery requires disabled environment probing and no filesystem scope.');
      if (attempts > 4) throw new Error('Recovery four-call limit exceeded.');
      if (pending.has(id)) throw new Error('Duplicate recovery request ID.');
      if (name === 'memory_search' || name === 'memory_orient') {
        const query = args.query ?? args.task;
        if (typeof query === 'string') {
          const normalized = query.trim().toLowerCase().replace(/\s+/gu, ' ');
          if (!queries.has(normalized) && queries.size >= 2) throw new Error('Recovery one-rewrite limit exceeded.');
          queries.add(normalized);
        }
      }
      const call = { args: structuredClone(args), id, name, startedAt: now };
      calls.push(call);
      pending.set(id, call);
    },
    get bytes() {
      return bytes;
    },
    calls,
    finish(id: number | string, { now, result }: { now: number; result: unknown }) {
      const call = pending.get(id);
      if (call === undefined) return;
      const serialized = JSON.stringify(result);
      const size = Buffer.byteLength(serialized, 'utf8');
      if (bytes + size > 65_536) throw new Error('Recovery delivered-tool-byte limit exceeded.');
      bytes += size;
      call.bytes = size;
      call.latencyMs = now - call.startedAt;
      call.result = structuredClone(result);
      pending.delete(id);
    },
    get incomplete() {
      return pending.size;
    },
    get rewrites() {
      return Math.max(0, queries.size - 1);
    },
    violations,
  };
}

export function isRecoveryRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseRecoveryConfiguration(input: unknown): RecoveryConfiguration {
  if (!isRecoveryRecord(input)) throw new Error('Missing recovery configuration.');
  for (const variant of ['baseline', 'candidate']) {
    const source = input[variant];
    if (
      !isRecoveryRecord(source) ||
      typeof source.root !== 'string' ||
      typeof source.sha !== 'string' ||
      !/^[a-f0-9]{40}$/u.test(source.sha)
    )
      throw new Error('Recovery requires exact source roots and commit SHAs.');
  }
  for (const key of ['evidenceRoot', 'outputDirectory', 'sourceCodexHome'])
    if (typeof input[key] !== 'string' || !input[key]) throw new Error(`Missing recovery ${key}.`);
  if (input.caseManifest !== undefined && (typeof input.caseManifest !== 'string' || !input.caseManifest))
    throw new Error('Invalid recovery caseManifest.');
  return input as unknown as RecoveryConfiguration;
}

export function providerUsageFromEvents(events: unknown[]) {
  const totals: { cachedInput: null | number; input: null | number; output: null | number } = {
    cachedInput: null,
    input: null,
    output: null,
  };
  for (const event of events) {
    if (!isRecoveryRecord(event) || event.type !== 'turn.completed' || !isRecoveryRecord(event.usage)) continue;
    for (const [target, source] of [
      ['input', 'input_tokens'],
      ['cachedInput', 'cached_input_tokens'],
      ['output', 'output_tokens'],
    ] as const) {
      const value = event.usage[source];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
        totals[target] = (totals[target] ?? 0) + value;
    }
  }
  return totals;
}

export function readRecoveryJson(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecoveryRecord(value)) throw new Error(`Expected recovery object: ${path}`);
  return value;
}

export async function runRecoveryChild(
  runtime: string,
  { args, env, logPath, timeout }: { args: string[]; env: Record<string, string>; logPath: string; timeout: number },
): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(process.execPath, [runtime, ...args], {
      detached: true,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const signalGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (!isRecoveryRecord(error) || error.code !== 'ESRCH')
          failure ??= error instanceof Error ? error : new Error(String(error));
      }
    };
    const stop = (message: string) => {
      if (failure !== undefined) return;
      failure = new Error(message);
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => {
        signalGroup('SIGKILL');
      }, 5_000);
    };
    const timer = setTimeout(() => {
      stop('Recovery child deadline exceeded.');
    }, timeout);
    const collect = (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) stop('Recovery child output limit exceeded.');
      else chunks.push(chunk);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', error => {
      failure = error;
    });
    child.on('close', code => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signalGroup('SIGKILL');
      writeFileSync(logPath, Buffer.concat(chunks), { mode: 0o600 });
      if (failure !== undefined || code !== 0)
        reject(failure ?? new Error(`Recovery child exited ${String(code)}; see ${logPath}`));
      else resolveRun();
    });
  });
}

/** Offline evaluation only. The caller owns PostgreSQL/model admission and the disposable container. */
export async function runRecoveryReplay(
  config: RecoveryConfiguration,
  runChild: typeof runRecoveryChild = runRecoveryChild,
) {
  const target = process.env.DATABASE_URL;
  if (target === undefined)
    throw new Error('Run recovery evaluation inside the existing admitted ephemeral PostgreSQL wrapper.');
  const env = buildRecoveryEnvironment(process.env, target);
  const runtime = resolve(dirname(fileURLToPath(import.meta.url)), 'recovery-replay-runtime.js');
  const output = resolve(config.outputDirectory);
  const caseManifest = resolve(config.caseManifest ?? resolve(config.evidenceRoot, 'agent-replay-cases.json'));
  const caseManifestSha256 = createHash('sha256').update(readFileSync(caseManifest)).digest('hex');
  mkdirSync(output, { recursive: true });
  const results: RecoveryPairRow[] = [];
  const suites: Record<string, unknown>[] = [];
  // No baseline reuse after a read: each case starts with fresh canonical fixtures.
  replay: for (const caseId of ['retrieval', ...RECOVERY_CASE_IDS]) {
    for (const variant of ['baseline', 'candidate'] as const) {
      const source = config[variant];
      const stem = resolve(output, `${variant}-${caseId}`);
      const request = {
        baselineRoot: resolve(config.baseline.root),
        baselineSha: config.baseline.sha,
        caseId,
        caseManifest,
        caseManifestSha256,
        evidenceRoot: resolve(config.evidenceRoot),
        fixturesRoot: resolve(config.candidate.root, 'packages/ai-memory-tools/src/eval/fixtures'),
        output: stem,
        root: resolve(source.root),
        sha: source.sha,
        sourceCodexHome: resolve(config.sourceCodexHome),
        variant,
      };
      const requestPath = `${stem}-request.json`;
      writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 });
      try {
        await runChild(runtime, {
          args: ['setup', requestPath],
          env: env,
          logPath: `${stem}-setup.log`,
          timeout: 120_000,
        });
        await runChild(runtime, {
          args: [caseId === 'retrieval' ? 'retrieval' : 'agent', requestPath],
          env: env,
          logPath: `${stem}-execution.log`,
          timeout: caseId === 'retrieval' ? 120_000 : RECOVERY_AGENT_CHILD_TIMEOUT_MS,
        });
        const result = readRecoveryJson(`${stem}-result.json`);
        if (caseId === 'retrieval') {
          suites.push(result);
          // Establish the candidate's database behavior before consuming model variants.
          if (variant === 'candidate' && result.passed !== true) break replay;
        } else {
          if (
            typeof result.bytes !== 'number' ||
            !Number.isSafeInteger(result.bytes) ||
            result.bytes < 0 ||
            typeof result.calls !== 'number' ||
            !Number.isSafeInteger(result.calls) ||
            result.calls < 0 ||
            typeof result.correct !== 'boolean' ||
            typeof result.firstSuccessfulResponseCorrect !== 'boolean' ||
            typeof result.elapsedMs !== 'number' ||
            !Number.isFinite(result.elapsedMs) ||
            result.elapsedMs < 0 ||
            !['completed', 'invalid', 'timeout'].includes(String(result.outcome)) ||
            result.runtimeValid !== (result.outcome === 'completed') ||
            (result.correct && result.outcome !== 'completed') ||
            result.sourceSha !== source.sha ||
            result.caseId !== caseId ||
            result.variant !== variant ||
            (result.outcome === 'completed' &&
              (result.exitCode !== 0 ||
                result.cancellationReason !== null ||
                result.elapsedMs > RECOVERY_AGENT_DURATION_MS ||
                result.timeToAnswerMs !== result.elapsedMs ||
                result.timeToAnswerCensoredAtMs !== null)) ||
            (result.outcome === 'timeout' &&
              (result.exitCode !== 124 ||
                result.cancellationReason !== 'max_duration' ||
                result.elapsedMs < RECOVERY_AGENT_DURATION_MS ||
                result.timeToAnswerMs !== null ||
                result.timeToAnswerCensoredAtMs !== RECOVERY_AGENT_DURATION_MS ||
                result.answer !== '')) ||
            (result.outcome !== 'invalid' && (result.calls > 4 || result.bytes > 65_536))
          )
            throw new Error('Missing actual recovery measurements.');
          results.push({
            bytes: result.bytes,
            calls: result.calls,
            caseId,
            correct: result.correct,
            elapsedMs: result.elapsedMs,
            firstSuccessfulResponseCorrect: result.firstSuccessfulResponseCorrect,
            outcome: result.outcome as RecoveryOutcome,
            variant,
          });
          if (result.outcome === 'invalid') break replay;
        }
      } finally {
        await runChild(runtime, {
          args: ['cleanup', requestPath],
          env: env,
          logPath: `${stem}-cleanup.log`,
          timeout: 30_000,
        });
      }
    }
  }
  const paired = summarizeRecoveryPairs(results);
  const candidateSuite = suites.find(suite => suite.variant === 'candidate');
  // Machine checks cannot establish that the agent's answer preserves authority.
  // The owning independent reviewer must assess the retained answers and traces.
  const report = {
    caseManifest: { path: caseManifest, sha256: caseManifestSha256 },
    firstSuccessfulResponseCorrectness: {
      baseline: results.filter(row => row.variant === 'baseline' && row.firstSuccessfulResponseCorrect).length,
      candidate: results.filter(row => row.variant === 'candidate' && row.firstSuccessfulResponseCorrect).length,
      denominatorPerVariant: RECOVERY_CASE_IDS.length,
    },
    paired,
    results,
    semanticReviewRequired: true,
    status: paired.passed && suites.length === 2 && candidateSuite?.passed === true ? 'needs-review' : 'fail',
    suites,
  };
  writeFileSync(resolve(output, 'recovery-comparison.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export function summarizeRecoveryPairs(rows: RecoveryPairRow[]) {
  const complete =
    rows.length === 16 &&
    RECOVERY_CASE_IDS.every(id =>
      ['baseline', 'candidate'].every(
        variant => rows.filter(row => row.caseId === id && row.variant === variant).length === 1,
      ),
    );
  let baselineBytes = 0;
  let candidateBytes = 0;
  let baselineCalls = 0;
  let candidateCalls = 0;
  let pairedCorrect = 0;
  const eligible: RecoveryPairRow[] = [];
  for (const id of RECOVERY_CASE_IDS) {
    const base = rows.find(row => row.caseId === id && row.variant === 'baseline');
    const candidate = rows.find(row => row.caseId === id && row.variant === 'candidate');
    if (base?.correct && candidate?.correct && base.outcome === 'completed' && candidate.outcome === 'completed') {
      eligible.push(base, candidate);
      pairedCorrect += 1;
      baselineBytes += base.bytes;
      candidateBytes += candidate.bytes;
      baselineCalls += base.calls;
      candidateCalls += candidate.calls;
    }
  }
  const correctness =
    complete &&
    rows.filter(row => row.variant === 'candidate').every(row => row.correct && row.outcome === 'completed');
  const cost =
    pairedCorrect > 0 &&
    candidateBytes <= baselineBytes &&
    candidateCalls <= baselineCalls &&
    (candidateBytes < baselineBytes || candidateCalls < baselineCalls);
  const latency = (cohort: RecoveryPairRow[], variant: string) => {
    const values = cohort
      .filter(row => row.variant === variant)
      .map(row => row.elapsedMs)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
      .sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    let median: null | number = null;
    if (values.length > 0)
      median =
        values.length % 2 === 1 ? (values[middle] ?? null) : ((values[middle - 1] ?? 0) + (values[middle] ?? 0)) / 2;
    return { medianMs: median, sampleCount: values.length };
  };
  return {
    baselineBytes,
    baselineCalls,
    baselineElapsed: latency(rows, 'baseline'),
    baselineLatency: latency(eligible, 'baseline'),
    baselineTimeouts: rows.filter(row => row.variant === 'baseline' && row.outcome === 'timeout').length,
    candidateBytes,
    candidateCalls,
    candidateElapsed: latency(rows, 'candidate'),
    candidateLatency: latency(eligible, 'candidate'),
    candidateTimeouts: rows.filter(row => row.variant === 'candidate' && row.outcome === 'timeout').length,
    complete,
    correctness,
    cost,
    costAndLatencyCohort:
      'Pairs where both arms completed with correct recovery; elapsed resource time retains every observation.',
    excludedPairs: RECOVERY_CASE_IDS.length - pairedCorrect,
    pairedCorrect,
    passed: correctness && cost,
    timeoutCensoredAtMs: RECOVERY_AGENT_DURATION_MS,
  };
}
