import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';

import {
  buildRecoveryEnvironment,
  createRecoveryTrace,
  providerUsageFromEvents,
  readRecoveryJson,
  RECOVERY_AGENT_CHILD_TIMEOUT_MS,
  RECOVERY_CASE_IDS,
  runRecoveryChild,
  runRecoveryReplay,
  summarizeRecoveryPairs,
} from './recovery-replay.js';

test('synthetic replay bundle covers all cases and binds A02 to fictional catalog evidence', () => {
  const bundle = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'recovery');
  const manifest = readRecoveryJson(join(bundle, 'agent-replay-cases.json'));
  const input = readRecoveryJson(join(bundle, 'inputs', 'retrieval', 'current-task-recovery.json'));
  const boundary = readRecoveryJson(join(bundle, 'boundary-inputs.json'));
  const cases = Array.isArray(manifest.cases) ? manifest.cases : [];
  assert.deepEqual(
    cases.map(row => (row as { id: string }).id),
    [...RECOVERY_CASE_IDS],
  );
  const catalog = cases.find(row => (row as { id: string }).id === 'A02') as {
    expected: { evidenceRef: string; sourceMemoryKey: string };
    firstSearchArgs: { query: string };
  };
  const memories = Array.isArray(input.memories) ? input.memories : [];
  assert.ok(
    memories.some(row => {
      const memory = row as { evidenceRefs?: string[]; memoryKey?: string };
      return (
        memory.memoryKey === catalog.expected.sourceMemoryKey &&
        memory.evidenceRefs?.includes(catalog.expected.evidenceRef)
      );
    }),
  );
  assert.match(catalog.firstSearchArgs.query, /catalog preview/u);
  assert.ok(Array.isArray(boundary.identity));
  assert.ok(Array.isArray(boundary.failureCases));
});

test('recovery deadline terminates a resistant child and its descendant', { timeout: 20_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'memory-recovery-cleanup-'));
  const runtime = join(directory, 'worker.mjs');
  const pidsPath = join(directory, 'pids.json');
  writeFileSync(
    runtime,
    `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; process.on('SIGTERM',()=>{}); const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'}); writeFileSync(process.argv[2],JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`,
  );
  try {
    await assert.rejects(
      runRecoveryChild(runtime, { args: [pidsPath], env: {}, logPath: join(directory, 'output.log'), timeout: 500 }),
      /deadline/i,
    );
    const pids: unknown = JSON.parse(readFileSync(pidsPath, 'utf8'));
    assert.ok(Array.isArray(pids));
    const remaining = new Set(
      pids.map((pid: unknown) => {
        assert.ok(typeof pid === 'number');
        return pid;
      }),
    );
    const deadline = Date.now() + 1_000;
    // The direct child's close can precede OS reaping of its killed descendants.
    while (remaining.size > 0) {
      for (const pid of remaining) {
        try {
          process.kill(pid, 0);
        } catch (error) {
          assert.ok(error instanceof Error && 'code' in error && error.code === 'ESRCH', String(error));
          remaining.delete(pid);
        }
      }
      if (remaining.size === 0) break;
      if (Date.now() >= deadline) {
        assert.fail(`Recovery PIDs still observable after 1,000ms: ${[...remaining].join(',')}`);
      }
      await delay(10);
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('recovery child environment cannot inherit operational database or provider credentials', () => {
  const env = buildRecoveryEnvironment(
    {
      AI_MEMORY_DATABASE_URL: 'postgres://production/memory',
      AWS_ACCESS_KEY_ID: 'secret',
      DATABASE_URL: 'postgres://production/other-service',
      DB_HOST: 'production',
      HOME: '/operator',
      NODE_OPTIONS: '--import unwanted.js',
      OPENAI_API_KEY: 'secret',
      PATH: '/bin',
      PGHOST: 'production',
    },
    'postgresql://postgres:postgres@127.0.0.1:55490/ai_memory_replay',
  );
  assert.deepEqual(env, {
    AI_MEMORY_DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:55490/ai_memory_replay',
    AI_MEMORY_EMBEDDING_PROVIDER: 'none',
    DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:55490/ai_memory_replay',
    PATH: '/bin',
  });
  assert.throws(() => buildRecoveryEnvironment({}, 'postgres://operator@remote/ai_memory_replay'), /disposable/i);
  assert.throws(() => buildRecoveryEnvironment({}, 'postgres://operator@127.0.0.1/ai_memory'), /disposable/i);
});

test('recovery trace counts actual result envelopes and rejects excess or foreign-scope calls', () => {
  const trace = createRecoveryTrace('fixture/recovery');
  trace.begin({ args: { project: 'fixture/recovery', query: 'archive' }, id: 1, name: 'memory_search', now: 10 });
  const result = { content: [{ text: 'é', type: 'text' }], isError: false };
  trace.finish(1, { now: 15, result: result });
  const firstCall = trace.calls[0];
  assert.ok(firstCall);
  assert.equal(firstCall.bytes, 57);
  assert.equal(firstCall.latencyMs, 5);
  assert.deepEqual(firstCall.result, result);
  assert.throws(() => {
    trace.begin({ args: { project: 'fixture/recovery' }, id: 2, name: 'memory_store', now: 20 });
  }, /allowlist/i);
  assert.throws(() => {
    trace.begin({ args: { project: 'foreign' }, id: 3, name: 'memory_get', now: 20 });
  }, /scope/i);
  assert.equal(trace.attempts, 3);
  trace.begin({
    args: { project: 'fixture/recovery', query: 'archive current' },
    id: 4,
    name: 'memory_search',
    now: 20,
  });
  assert.throws(() => {
    trace.begin({
      args: { project: 'fixture/recovery', query: 'archive latest' },
      id: 5,
      name: 'memory_search',
      now: 20,
    });
  }, /four-call/i);
  assert.equal(trace.attempts, 5);
  assert.equal(trace.calls.length, 2);
});

test('recovery trace enforces one rewrite and the delivered result byte ceiling', () => {
  const trace = createRecoveryTrace('fixture/recovery');
  trace.begin({ args: { project: 'fixture/recovery', query: 'archive' }, id: 1, name: 'memory_search', now: 0 });
  trace.begin({
    args: { project: 'fixture/recovery', query: 'archive current' },
    id: 2,
    name: 'memory_search',
    now: 0,
  });
  assert.throws(() => {
    trace.begin({
      args: { project: 'fixture/recovery', query: 'archive latest' },
      id: 3,
      name: 'memory_search',
      now: 0,
    });
  }, /rewrite/i);
  assert.throws(() => {
    trace.finish(1, { now: 1, result: { content: 'x'.repeat(65_536) } });
  }, /byte limit/i);
  assert.equal(trace.bytes, 0);
  assert.equal(trace.incomplete, 2);
});

test('recovery rejects filesystem scope and external environment probes before dispatch', () => {
  for (const args of [
    { project: 'fixture/recovery' },
    { envProbe: 'full', project: 'fixture/recovery' },
    { cwd: '/external', envProbe: 'none', project: 'fixture/recovery' },
  ]) {
    const trace = createRecoveryTrace('fixture/recovery');
    assert.throws(() => {
      trace.begin({ args, id: 1, name: 'memory_orient', now: 0 });
    }, /environment probing/iu);
    assert.equal(trace.calls.length, 0);
  }
  const trace = createRecoveryTrace('fixture/recovery');
  trace.begin({ args: { envProbe: 'none', project: 'fixture/recovery' }, id: 1, name: 'memory_orient', now: 0 });
  assert.equal(trace.calls.length, 1);
});

test('recovery measurement leaves absent provider token fields unknown', () => {
  assert.deepEqual(providerUsageFromEvents([]), { cachedInput: null, input: null, output: null });
  assert.deepEqual(
    providerUsageFromEvents([{ type: 'turn.completed', usage: { input_tokens: 80, output_tokens: 12 } }]),
    {
      cachedInput: null,
      input: 80,
      output: 12,
    },
  );
});

test('paired recovery rejects missing cases and never credits savings on incorrect answers', () => {
  const row = {
    bytes: 100,
    calls: 2,
    caseId: 'A01',
    correct: true,
    elapsedMs: 10_000,
    firstSuccessfulResponseCorrect: true,
    outcome: 'completed' as const,
    variant: 'baseline' as const,
  };
  assert.equal(summarizeRecoveryPairs([row]).complete, false);
  const pairs = ['A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08'].flatMap(caseId => [
    { ...row, caseId },
    { ...row, bytes: 50, calls: 1, caseId, variant: 'candidate' as const },
  ]);
  assert.equal(summarizeRecoveryPairs(pairs).passed, true);
  const firstCandidate = pairs[1];
  assert.ok(firstCandidate);
  pairs[1] = { ...firstCandidate, correct: false };
  assert.equal(summarizeRecoveryPairs(pairs).passed, false);
});

test('paired recovery retains censored observations and excludes both arms from savings and completion latency', () => {
  const rows = RECOVERY_CASE_IDS.flatMap(caseId => [
    {
      bytes: 100,
      calls: 2,
      caseId,
      correct: true,
      elapsedMs: 10_000,
      firstSuccessfulResponseCorrect: true,
      outcome: 'completed' as const,
      variant: 'baseline' as const,
    },
    {
      bytes: 50,
      calls: 1,
      caseId,
      correct: true,
      elapsedMs: 8_000,
      firstSuccessfulResponseCorrect: true,
      outcome: 'completed' as const,
      variant: 'candidate' as const,
    },
  ]);
  const first = rows[0];
  assert.ok(first);
  const timeout = { ...first, bytes: 65_000, correct: false, elapsedMs: 45_022, outcome: 'timeout' as const };
  const report = summarizeRecoveryPairs([timeout, ...rows.slice(1)]);
  assert.equal(report.passed, true);
  assert.equal(report.pairedCorrect, 7);
  assert.equal(report.excludedPairs, 1);
  assert.equal(report.baselineBytes, 700);
  assert.equal(report.candidateBytes, 350);
  assert.equal(report.baselineCalls, 14);
  assert.equal(report.candidateCalls, 7);
  assert.deepEqual(report.baselineLatency, { medianMs: 10_000, sampleCount: 7 });
  assert.deepEqual(report.candidateLatency, { medianMs: 8_000, sampleCount: 7 });
  assert.equal(report.baselineElapsed.sampleCount, 8);
  assert.equal(report.baselineTimeouts, 1);
  assert.equal(report.timeoutCensoredAtMs, 45_000);
  const noneEligible = summarizeRecoveryPairs(
    rows.map(row =>
      row.variant === 'baseline' ? { ...row, correct: false, elapsedMs: 45_022, outcome: 'timeout' as const } : row,
    ),
  );
  assert.equal(noneEligible.correctness, true);
  assert.equal(noneEligible.cost, false);
  assert.equal(noneEligible.passed, false);
  assert.deepEqual(noneEligible.baselineLatency, { medianMs: null, sampleCount: 0 });
  assert.equal(summarizeRecoveryPairs(rows.map(row => ({ ...row, bytes: 100, calls: 2 }))).cost, false);
  assert.equal(
    summarizeRecoveryPairs(rows.map(row => (row.variant === 'candidate' ? { ...row, calls: 3 } : row))).cost,
    false,
  );
});

test('replay continues after contained timeouts only after cleanup, and preserves every other graph stop', async () => {
  const inheritedTarget = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:55490/ai_memory_replay';
  try {
    for (const scenario of [
      'baseline-timeout',
      'candidate-timeout',
      'invalid',
      'forged-timeout',
      'source-mismatch',
      'cleanup-failure',
      'setup-failure',
    ]) {
      const directory = mkdtempSync(join(tmpdir(), 'memory-recovery-replay-'));
      const steps: string[] = [];
      const caseManifest = join(directory, 'agent-replay-cases-prospective.json');
      writeFileSync(caseManifest, '{"cases":[]}\n');
      const config = {
        baseline: { root: join(directory, 'baseline'), sha: 'a'.repeat(40) },
        candidate: { root: join(directory, 'candidate'), sha: 'b'.repeat(40) },
        caseManifest,
        evidenceRoot: directory,
        outputDirectory: join(directory, 'output'),
        sourceCodexHome: directory,
      };
      const runChild: typeof runRecoveryChild = async (_runtime, { args, timeout }) => {
        const [mode, requestPath] = args;
        assert.ok(requestPath);
        const request = readRecoveryJson(requestPath);
        const { caseId, output, sha, variant } = request;
        assert.equal(request.caseManifest, caseManifest);
        assert.match(String(request.caseManifestSha256), /^[a-f0-9]{64}$/u);
        assert.equal(typeof output, 'string');
        const expectedTimeout = {
          agent: RECOVERY_AGENT_CHILD_TIMEOUT_MS,
          cleanup: 30_000,
          retrieval: 120_000,
          setup: 120_000,
        }[String(mode)];
        assert.equal(timeout, expectedTimeout);
        steps.push(`${String(caseId)}:${String(variant)}:${String(mode)}`);
        const target = caseId === 'A01' && variant === (scenario === 'candidate-timeout' ? 'candidate' : 'baseline');
        if (target && scenario === 'cleanup-failure' && mode === 'cleanup') throw new Error('Fixture cleanup failed.');
        if (target && scenario === 'setup-failure' && mode === 'setup') throw new Error('Fixture setup failed.');
        if (mode === 'setup' || mode === 'cleanup') return;
        if (mode === 'retrieval') {
          await writeFile(`${String(output)}-result.json`, JSON.stringify({ passed: true, variant }));
          return;
        }
        const failedOutcome = scenario === 'invalid' ? 'invalid' : 'timeout';
        const outcome = target ? failedOutcome : 'completed';
        const elapsedMs = outcome === 'completed' ? 8_000 : 45_022;
        await writeFile(
          `${String(output)}-result.json`,
          JSON.stringify({
            answer: outcome === 'timeout' ? '' : 'Recovered fixture answer.',
            bytes: variant === 'baseline' ? 100 : 50,
            calls: variant === 'baseline' ? 2 : 1,
            cancellationReason: outcome === 'completed' ? null : 'max_duration',
            caseId,
            correct: outcome === 'completed' || (target && scenario === 'forged-timeout'),
            elapsedMs,
            exitCode: outcome === 'completed' ? 0 : 124,
            firstSuccessfulResponseCorrect: outcome === 'completed',
            outcome,
            runtimeValid: outcome === 'completed',
            sourceSha: target && scenario === 'source-mismatch' ? 'c'.repeat(40) : sha,
            timeToAnswerCensoredAtMs: outcome === 'timeout' ? 45_000 : null,
            timeToAnswerMs: outcome === 'completed' ? elapsedMs : null,
            variant,
          }),
        );
      };
      try {
        if (['cleanup-failure', 'forged-timeout', 'setup-failure', 'source-mismatch'].includes(scenario)) {
          await assert.rejects(runRecoveryReplay(config, runChild), /measurements|cleanup failed|setup failed/iu);
          assert.equal(steps.at(-1), 'A01:baseline:cleanup');
          assert.ok(!steps.includes('A01:candidate:setup'));
          assert.equal(steps.length, scenario === 'setup-failure' ? 8 : 9);
        } else {
          const report = await runRecoveryReplay(config, runChild);
          if (scenario === 'invalid') {
            assert.equal(report.status, 'fail');
            assert.equal(report.results.length, 1);
            assert.equal(steps.length, 9);
            assert.equal(steps.at(-1), 'A01:baseline:cleanup');
          } else {
            assert.equal(report.results.length, 16);
            assert.equal(report.firstSuccessfulResponseCorrectness.denominatorPerVariant, 8);
            assert.equal(report.firstSuccessfulResponseCorrectness.baseline, scenario === 'baseline-timeout' ? 7 : 8);
            assert.equal(report.firstSuccessfulResponseCorrectness.candidate, scenario === 'candidate-timeout' ? 7 : 8);
            assert.equal(report.paired.pairedCorrect, 7);
            assert.equal(report.status, scenario === 'baseline-timeout' ? 'needs-review' : 'fail');
            const timeout = report.results.find(row => row.outcome === 'timeout');
            assert.ok(timeout);
            assert.equal(timeout.correct, false);
            assert.equal(timeout.elapsedMs, 45_022);
            assert.deepEqual(
              steps,
              ['retrieval', ...RECOVERY_CASE_IDS].flatMap(caseId =>
                ['baseline', 'candidate'].flatMap(variant =>
                  ['setup', caseId === 'retrieval' ? 'retrieval' : 'agent', 'cleanup'].map(
                    mode => `${caseId}:${variant}:${mode}`,
                  ),
                ),
              ),
            );
          }
        }
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    }
  } finally {
    if (inheritedTarget === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = inheritedTarget;
  }
});
