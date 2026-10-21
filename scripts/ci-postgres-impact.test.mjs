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
    env: { ...process.env, GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '', ...env },
    encoding: 'utf8',
  });
const record = (path, status = 'M', before = '100644', after = '100644') =>
  Buffer.from(`:${before} ${after} ${'a'.repeat(40)} ${'b'.repeat(40)} ${status}\0${path}\0`);
const impact = async () => import('./ci-postgres-impact.mjs');

// A wrong event default must never make a missing-evidence run disappear.
test('CLI defaults to complete integration without change evidence', () => {
  const result = invoke(['select']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { run: 'true', reason: 'full-event' });
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
  assert.equal(readFileSync(outputs, 'utf8'), 'run=false\nreason=documentation-only\n');
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
