import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, globSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('./ci-postgres-impact.mjs', import.meta.url));
const invoke = (args = [], env = {}, cwd = undefined) =>
  spawnSync(process.execPath, [script, ...args], {
    cwd,
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: '',
      PR_BASE_SHA: '',
      PR_HEAD_SHA: '',
      GITHUB_OUTPUT: '',
      GITHUB_STEP_SUMMARY: '',
      GITHUB_EVENT_PATH: '',
      GH_TOKEN: '',
      ...env,
    },
    encoding: 'utf8',
  });
const record = (path, status = 'M', before = '100644', after = '100644') =>
  Buffer.from(`:${before} ${after} ${'a'.repeat(40)} ${'b'.repeat(40)} ${status}\0${path}\0`);
const impact = async () => import('./ci-postgres-impact.mjs');

// A wrong event default must never make a missing-evidence run disappear.
test('CLI defaults to complete integration without change evidence', () => {
  const result = invoke(['select']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { run: 'true', reason: 'full-event', validation: 'full' });
});

test('only a complete ordinary documentation diff can skip integration', async () => {
  const { classifyDiff } = await impact();
  for (const path of ['README.md', 'CONTRIBUTING.md', 'LICENSE', 'docs/operations.md', 'docs/nested/a b\nc.md'])
    assert.deepEqual(classifyDiff(record(path)), { run: 'false', reason: 'documentation-only' });
  assert.equal(classifyDiff(record('docs/new.md', 'A', '000000')).run, 'false');
  assert.equal(classifyDiff(record('docs/old.md', 'D', '100644', '000000')).run, 'false');
});

test('all integration, transitive, packaged, toolchain and unknown paths require the complete suite', async () => {
  const { classifyDiff } = await impact();
  for (const path of [
    ...globSync('packages/**/*.integration.test.ts', { cwd: fileURLToPath(new URL('../', import.meta.url)) }),
    'packages/ai-memory/src/db/pool.ts',
    'packages/ai-memory/migrations/009_workflow_telemetry.sql',
    'packages/ai-memory/src/retention/retentionConfig.ts',
    'packages/ai-memory/src/tools/ingestion/flush-session.ts',
    'packages/ai-memory/src/telemetry/event.ts',
    'packages/ai-memory/src/tools/health-report/workflow.ts',
    'packages/ai-memory/src/contracts/types.ts',
    'plugins/ai-memory/hooks/telemetry',
    'plugins/ai-memory/scripts/bundle.mjs',
    'packages/ai-memory/scripts/stage-assets.mjs',
    'packages/ai-memory/package.json',
    'plugins/ai-memory/README.md',
    'package-lock.json',
    'package.json',
    '.node-version',
    'tsconfig.base.json',
    'vitest.integration.config.ts',
    '.github/workflows/ci.yml',
    'scripts/ci-postgres-impact.mjs',
    'unrecognized/path',
  ])
    assert.equal(classifyDiff(Buffer.concat([record('README.md'), record(path)])).run, 'true', path);
});

test('empty, malformed, nonregular and unsupported diff evidence runs integration', async () => {
  const { classifyDiff } = await impact();
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.from('garbage'),
    record('docs/a.md').subarray(0, -1),
    record('docs/a.md', 'R100'),
    record('docs/a.md', 'T'),
    record('docs/a.md', 'M', '120000', '100644'),
    record('docs/a.md', 'M', '100644', '100755'),
    record('docs/a.md', 'M', '160000', '160000'),
    record('../README.md'),
    record('docs/../README.md'),
    record('docs//a.md'),
    record('/README.md'),
    record('docs/a.md', 'M', '000000'),
    record('docs/a.md', 'A', '100644'),
    Buffer.concat([record('README.md'), Buffer.from([0xff, 0])]),
  ])
    assert.equal(classifyDiff(bytes).run, 'true', bytes.toString());
});

test('real Git endpoint histories retain both rename endpoints, deletions and earlier commits', async t => {
  const { selectPostgres } = await impact();
  const cwd = mkdtempSync(join(tmpdir(), 'memory-impact-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const put = (path, text) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  };
  git('init', '-q');
  git('config', 'user.name', 'Synthetic Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  put('README.md', 'initial');
  put('docs/old.md', 'docs');
  put('packages/db.ts', 'db');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  const decide = () => selectPostgres({ event: 'pull_request', base, head: git('rev-parse', 'HEAD'), cwd });
  put('docs/nested/a b\nc.md', 'docs');
  git('add', '.');
  git('commit', '-qm', 'docs');
  assert.equal(decide().run, 'false');
  const outputs = join(cwd, 'output');
  const summary = join(cwd, 'summary');
  const cli = invoke(
    ['select'],
    {
      GITHUB_EVENT_NAME: 'pull_request',
      PR_BASE_SHA: base,
      PR_HEAD_SHA: git('rev-parse', 'HEAD'),
      GITHUB_OUTPUT: outputs,
      GITHUB_STEP_SUMMARY: summary,
    },
    cwd,
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(readFileSync(outputs, 'utf8'), 'run=false\nreason=documentation-only\nvalidation=full\n');
  assert.match(readFileSync(summary, 'utf8'), /intentionally skipped/);
  rmSync(outputs);
  rmSync(summary);
  git('mv', 'docs/old.md', 'docs/renamed.md');
  git('commit', '-qm', 'rename docs');
  assert.equal(decide().run, 'false');
  git('mv', 'packages/db.ts', 'docs/moved.md');
  git('commit', '-qm', 'db to docs');
  assert.equal(decide().run, 'true');
  put('README.md', 'later docs');
  git('add', '.');
  git('commit', '-qm', 'later docs');
  assert.equal(decide().run, 'true');
  git('reset', '--hard', base);
  git('mv', 'docs/old.md', 'packages/new.ts');
  git('commit', '-qm', 'docs to db');
  assert.equal(decide().run, 'true');
  git('reset', '--hard', base);
  git('rm', 'packages/db.ts');
  git('commit', '-qm', 'delete db');
  assert.equal(decide().run, 'true');
  git('reset', '--hard', base);
  git('rm', 'docs/old.md');
  git('commit', '-qm', 'delete docs');
  assert.equal(decide().run, 'false');
  git('reset', '--hard', base);
  symlinkSync('../packages/db.ts', join(cwd, 'docs/link.md'));
  git('add', '.');
  git('commit', '-qm', 'symlink');
  assert.equal(decide().run, 'true');
  git('reset', '--hard', base);
  put('packages/base-drift.ts', 'new base');
  git('add', '.');
  git('commit', '-qm', 'base drift');
  const movedBase = git('rev-parse', 'HEAD');
  git('reset', '--hard', base);
  put('README.md', 'head docs');
  git('add', '.');
  git('commit', '-qm', 'head docs');
  assert.equal(
    selectPostgres({ event: 'pull_request', base: movedBase, head: git('rev-parse', 'HEAD'), cwd }).run,
    'true',
  );
  assert.equal(selectPostgres({ event: 'push', base, head: base, cwd }).run, 'true');
  for (const missing of ['', '0'.repeat(40), 'f'.repeat(40), 'main', '--help'])
    assert.equal(selectPostgres({ event: 'pull_request', base: missing, head: base, cwd }).run, 'true');
  assert.equal(selectPostgres({ event: 'pull_request', base, head: base, cwd }).run, 'true');
  assert.equal(selectPostgres({ event: 'pull_request', base, head: base, cwd: join(cwd, 'missing') }).run, 'true');
});

const good = {
  LINUX_RESULT: 'success',
  MACOS_RESULT: 'success',
  PACKAGE_RESULT: 'success',
  SELECTION_RESULT: 'success',
  POSTGRES_RESULT: 'success',
  POSTGRES_RUN: 'true',
  POSTGRES_REASON: 'impact-or-unknown',
};
test('aggregate accepts required PG proof or an explicit successful documentation selection', () => {
  assert.equal(invoke(['aggregate'], good).status, 0);
  assert.equal(
    invoke(['aggregate'], {
      ...good,
      POSTGRES_RUN: 'false',
      POSTGRES_REASON: 'documentation-only',
      POSTGRES_RESULT: 'skipped',
    }).status,
    0,
  );
});
test('aggregate rejects missing, failed, cancelled and inconsistent required proof', () => {
  for (const lane of ['LINUX_RESULT', 'MACOS_RESULT', 'PACKAGE_RESULT', 'SELECTION_RESULT', 'POSTGRES_RESULT'])
    for (const state of ['', 'failure', 'cancelled', 'skipped'])
      assert.notEqual(invoke(['aggregate'], { ...good, [lane]: state }).status, 0, `${lane}:${state}`);
  for (const delta of [
    { POSTGRES_RUN: '' },
    { POSTGRES_RUN: 'false' },
    { POSTGRES_REASON: '' },
    { POSTGRES_REASON: 'untrusted' },
    { POSTGRES_RUN: 'false', POSTGRES_REASON: 'documentation-only' },
    { POSTGRES_RUN: 'true', POSTGRES_REASON: 'documentation-only' },
  ])
    assert.notEqual(invoke(['aggregate'], { ...good, ...delta }).status, 0, JSON.stringify(delta));
});

const sourceSha = 'a'.repeat(40);
const baseSha = 'b'.repeat(40);
const metadataName = 'PR metadata (no source validation)';
const eventFixture = () => ({
  action: 'edited',
  number: 82,
  repository: { id: 20, full_name: 'fixture/memory' },
  changes: { body: { from: null } },
  pull_request: {
    number: 82,
    head: { sha: sourceSha, repo: { id: 30 } },
    base: { sha: baseSha, ref: 'main', repo: { id: 20 } },
  },
});
const runFixture = (id = 90, action = 'synchronize') => ({
  id,
  run_number: id,
  workflow_id: 7,
  path: '.github/workflows/ci.yml',
  event: 'pull_request',
  repository: { id: 20 },
  head_repository: { id: 30 },
  head_sha: sourceSha,
  display_title: `am-ci-v1 82 30 20 main ${sourceSha} ${baseSha} ${action}`,
  run_attempt: 1,
  status: 'completed',
  conclusion: 'success',
});
const jobsFixture = (id = 90) =>
  ['selection', 'linux', 'macos', 'package', 'postgres', 'checks'].map((name, index) => ({
    id: id * 10 + index,
    run_id: id,
    head_sha: sourceSha,
    name,
    status: 'completed',
    conclusion: 'success',
  }));
const runnerEnv = {
  GITHUB_REPOSITORY: 'fixture/memory',
  GITHUB_RUN_ID: '100',
  GITHUB_RUN_ATTEMPT: '1',
  GH_TOKEN: 'fixture-only',
};

// Only the external HTTP boundary is substituted. The selector parses the real
// Response objects, native run identities, attempts, ordering and job results.
async function preserve(options = {}) {
  const { preserveValidation } = await impact();
  assert.equal(typeof preserveValidation, 'function', 'native validation preservation is implemented');
  const event = options.event ?? eventFixture();
  const runs = options.runs ?? [runFixture()];
  const current = runFixture(100, event.action);
  current.display_title = `am-ci-v1 82 30 20 ${event.pull_request?.base?.ref} ${event.pull_request?.head?.sha} ${event.pull_request?.base?.sha} ${event.action}`;
  const fetchImpl =
    options.fetchImpl ??
    (async (url, init) => {
      assert.equal(init.method, 'GET');
      const parsed = new URL(url);
      assert.equal(parsed.origin, 'https://api.github.com');
      if (parsed.pathname.endsWith('/runs/100')) return Response.json(current);
      if (parsed.pathname.endsWith('/workflows/7/runs')) {
        assert.equal(parsed.searchParams.get('head_sha'), event.pull_request.head.sha);
        return Response.json({ total_count: options.totalCount ?? runs.length, workflow_runs: runs });
      }
      const jobs = /\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/.exec(parsed.pathname);
      if (jobs)
        return Response.json({
          total_count: (options.jobs?.[jobs[1]] ?? jobsFixture(Number(jobs[1]))).length,
          jobs: options.jobs?.[jobs[1]] ?? jobsFixture(Number(jobs[1])),
        });
      const run = /\/runs\/(\d+)$/.exec(parsed.pathname);
      if (run) return Response.json(options.readback ?? runs.find(item => item.id === Number(run[1])));
      throw new Error(`Unexpected fixture request: ${parsed.pathname}`);
    });
  return preserveValidation({
    eventName: options.eventName ?? 'pull_request',
    event,
    env: options.env ?? runnerEnv,
    postgres: options.postgres ?? { run: 'true', reason: 'impact-or-unknown' },
    fetchImpl,
  });
}

test('metadata preserves only exact successful full validation, including nullable previous body', async () => {
  for (const changes of [
    { title: { from: 'old' } },
    { body: { from: null } },
    { title: { from: 'old' }, body: { from: '' } },
  ]) {
    const event = eventFixture();
    event.changes = changes;
    assert.deepEqual(await preserve({ event }), { validation: 'metadata', validationRun: 90 });
  }
  assert.deepEqual(await preserve({ runs: [runFixture(90, 'edited')] }), { validation: 'metadata', validationRun: 90 });
});

test('base-tip advancement without a base edit cannot preserve proof at the old base', async () => {
  const event = eventFixture();
  event.pull_request.base.sha = 'c'.repeat(40);
  assert.equal((await preserve({ event })).validation, 'full');
  event.pull_request.base.sha = baseSha;
  event.pull_request.base.ref = 'release';
  assert.equal((await preserve({ event })).validation, 'full');
});

test('source/base/reopen/ready and malformed metadata evidence always retain full validation', async () => {
  for (const change of [
    e => {
      e.action = 'synchronize';
    },
    e => {
      e.action = 'reopened';
    },
    e => {
      e.action = 'ready_for_review';
    },
    e => {
      e.changes.base = { ref: { from: 'old' } };
    },
    e => {
      e.changes = {};
    },
    e => {
      e.changes = { unknown: { from: 'x' } };
    },
    e => {
      e.changes = { title: {} };
    },
    e => {
      e.changes = { title: { from: null } };
    },
    e => {
      e.changes.body.from = 42;
    },
    e => {
      delete e.pull_request.head;
    },
    e => {
      e.pull_request.head.sha = '0'.repeat(40);
    },
    e => {
      e.pull_request.base.repo.id = 99;
    },
    e => {
      e.number = 83;
    },
  ]) {
    const event = eventFixture();
    change(event);
    assert.equal(
      (
        await preserve({
          event,
          fetchImpl: () => {
            throw new Error('unneeded network');
          },
        })
      ).validation,
      'full',
    );
  }
  assert.equal((await preserve({ eventName: 'push' })).validation, 'full');
  assert.equal((await preserve({ env: {} })).validation, 'full');
});

test('positively identified queued/running source work stays responsible for its own result', async () => {
  for (const action of ['opened', 'synchronize', 'reopened', 'ready_for_review']) {
    for (const status of ['queued', 'pending', 'in_progress', 'waiting', 'requested']) {
      const run = { ...runFixture(90, action), status, conclusion: null };
      assert.deepEqual(await preserve({ runs: [run], jobs: { 90: [] } }), {
        validation: 'metadata',
        validationRun: 90,
      });
    }
  }
});

test('unfinished edited candidates cannot certify one another without full-branch job evidence', async () => {
  const run = { ...runFixture(90, 'edited'), status: 'in_progress', conclusion: null };
  assert.equal((await preserve({ runs: [run], jobs: { 90: [] } })).validation, 'full');
  const jobs = jobsFixture()
    .filter(job => job.name !== 'checks')
    .map(job => (job.name === 'selection' ? job : { ...job, status: 'queued', conclusion: null }));
  assert.deepEqual(await preserve({ runs: [run], jobs: { 90: jobs } }), { validation: 'metadata', validationRun: 90 });
  jobs.find(job => job.name === 'linux').conclusion = 'failure';
  jobs.find(job => job.name === 'linux').status = 'completed';
  assert.equal((await preserve({ runs: [run], jobs: { 90: jobs } })).validation, 'full');
});

test('completed metadata-only runs do not hide the actual full validation', async () => {
  const metadata = runFixture(95, 'edited');
  const jobs = jobsFixture(95)
    .filter(job => job.name !== 'checks')
    .map(job => (job.name === 'selection' ? job : { ...job, conclusion: 'skipped' }));
  jobs.push({ ...jobsFixture(95)[0], id: 999, name: metadataName });
  assert.deepEqual(await preserve({ runs: [metadata, runFixture()], jobs: { 95: jobs } }), {
    validation: 'metadata',
    validationRun: 90,
  });
});

test('newer failure or uncertainty never selects an older green run', async () => {
  for (const conclusion of ['failure', 'cancelled', 'neutral', 'skipped', 'timed_out', 'stale', null]) {
    const latest = { ...runFixture(95), conclusion };
    assert.equal((await preserve({ runs: [runFixture(), latest] })).validation, 'full', String(conclusion));
  }
  const latest = runFixture(95);
  delete latest.display_title;
  assert.equal((await preserve({ runs: [latest, runFixture()] })).validation, 'full');
});

test('native identities and actual complete lane results are required', async () => {
  for (const delta of [
    { workflow_id: 8 },
    { path: 'other.yml' },
    { event: 'push' },
    { repository: { id: 99 } },
    { head_repository: { id: 99 } },
    { head_sha: 'c'.repeat(40) },
    { display_title: 'ordinary PR title' },
    { display_title: runFixture().display_title.replace(' 82 ', ' 83 ') },
  ])
    assert.equal((await preserve({ runs: [{ ...runFixture(), ...delta }] })).validation, 'full');
  for (const name of ['selection', 'linux', 'macos', 'package', 'postgres', 'checks']) {
    for (const conclusion of ['failure', 'cancelled', 'skipped', null]) {
      const jobs = jobsFixture().map(job => (job.name === name ? { ...job, conclusion } : job));
      assert.equal((await preserve({ jobs: { 90: jobs } })).validation, 'full', `${name}:${conclusion}`);
    }
  }
  const docsJobs = jobsFixture().map(job => (job.name === 'postgres' ? { ...job, conclusion: 'skipped' } : job));
  assert.deepEqual(
    await preserve({ jobs: { 90: docsJobs }, postgres: { run: 'false', reason: 'documentation-only' } }),
    { validation: 'metadata', validationRun: 90 },
  );
});

test('rerun/cancellation readback, missing history and incomplete pagination fail closed', async () => {
  for (const delta of [
    { run_attempt: 2 },
    { run_number: 91 },
    { display_title: runFixture(90, 'edited').display_title },
    { status: 'completed', conclusion: 'cancelled' },
    { head_sha: 'c'.repeat(40) },
  ])
    assert.equal((await preserve({ readback: { ...runFixture(), ...delta } })).validation, 'full');
  assert.equal((await preserve({ runs: [] })).validation, 'full');
  assert.equal((await preserve({ totalCount: 10000 })).validation, 'full');
});

test('unknown run ordering and inconsistent pending or metadata job states cannot hide newer uncertainty', async () => {
  const unknown = runFixture(95);
  delete unknown.run_number;
  assert.equal((await preserve({ runs: [runFixture(), unknown] })).validation, 'full');
  const pending = { ...runFixture(), status: 'in_progress', conclusion: null };
  for (const job of [
    { ...jobsFixture()[0], status: 'unknown' },
    { ...jobsFixture()[0], status: 'queued', conclusion: 'failure' },
  ])
    assert.equal((await preserve({ runs: [pending], jobs: { 90: [job] } })).validation, 'full');
  const metadata = runFixture(95, 'edited');
  const jobs = jobsFixture(95)
    .filter(job => job.name !== 'checks')
    .map(job => (job.name === 'selection' ? job : { ...job, conclusion: 'skipped' }));
  jobs.push({ ...jobsFixture(95)[0], id: 999, name: metadataName, status: 'in_progress' });
  assert.equal((await preserve({ runs: [metadata, runFixture()], jobs: { 95: jobs } })).validation, 'full');
});

test('API refusal/malformed/oversized evidence recovers idempotently without changing native state', async () => {
  for (const fetchImpl of [
    async () => {
      throw new Error('unavailable');
    },
    async () => new Response('', { status: 403 }),
    async () => new Response('{broken'),
    async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)),
  ])
    assert.equal((await preserve({ fetchImpl })).validation, 'full');
  assert.deepEqual(await preserve(), { validation: 'metadata', validationRun: 90 });
  assert.deepEqual(await preserve(), { validation: 'metadata', validationRun: 90 });
});

// Evaluate the scalar expressions actually emitted at this workflow's boundary.
// This is deliberately not an Actions engine: native PR-event checks below the
// synthetic layer remain required to establish GitHub's check-suite behavior.
function workflowScalar(block, field, github, needs = {}) {
  const lines = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8').split('\n');
  let scope = lines;
  let indent = 0;
  if (block) {
    const start = lines.findIndex(line => line.trim() === `${block}:`);
    assert.ok(start >= 0, `workflow block ${block}`);
    const parentIndent = lines[start].search(/\S/);
    const end = lines.findIndex((line, index) => index > start && line.trim() && line.search(/\S/) <= parentIndent);
    scope = lines.slice(start + 1, end < 0 ? undefined : end);
    indent = parentIndent + 2;
  }
  const line = scope.find(item => item.startsWith(`${' '.repeat(indent)}${field}: `));
  assert.ok(line, `workflow ${block ?? 'root'}.${field} is configured`);
  const scalar = line.trim().slice(field.length + 2);
  return scalar.replace(/\$\{\{(.*?)\}\}/g, (_, expression) =>
    Function('github', 'needs', `return (${expression});`)(github, needs),
  );
}

test('workflow isolates every edited run while source/reopen/ready retain source cancellation', () => {
  const github = {
    workflow: 'Quality checks',
    event_name: 'pull_request',
    event: eventFixture(),
    ref: 'refs/pull/82/merge',
    run_id: 100,
    run_attempt: 1,
  };
  const first = workflowScalar('concurrency', 'group', github);
  assert.notEqual(first, workflowScalar('concurrency', 'group', { ...github, run_id: 101 }));
  assert.notEqual(first, workflowScalar('concurrency', 'group', { ...github, run_attempt: 2 }));
  assert.equal(workflowScalar('concurrency', 'cancel-in-progress', github), 'false');
  const sourceGroups = sourceActionsForTest().map(action => {
    const source = { ...github, event: { ...github.event, action } };
    assert.equal(workflowScalar('concurrency', 'cancel-in-progress', source), 'true');
    return workflowScalar('concurrency', 'group', source);
  });
  assert.equal(new Set(sourceGroups).size, 1);
  assert.notEqual(first, sourceGroups[0]);
  assert.equal(workflowScalar(null, 'run-name', github), `am-ci-v1 82 30 20 main ${sourceSha} ${baseSha} edited`);
});
const sourceActionsForTest = () => ['opened', 'synchronize', 'reopened', 'ready_for_review'];

test('workflow never emits the required checks name for positively selected metadata', () => {
  for (const result of ['success', 'failure', 'cancelled', 'skipped', '']) {
    for (const validation of ['metadata', 'full', 'unknown', '']) {
      const needs = { selection: { result, outputs: { validation, run: 'true' } } };
      const metadata = result === 'success' && validation === 'metadata';
      assert.equal(workflowScalar('checks', 'name', {}, needs), metadata ? metadataName : 'checks');
      if (result === 'success') {
        for (const lane of ['linux', 'macos', 'package', 'postgres'])
          assert.equal(workflowScalar(lane, 'if', {}, needs), String(!metadata), `${lane}:${validation}`);
      }
    }
  }
});
