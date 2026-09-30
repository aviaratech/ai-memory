import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';

const directory = mkdtempSync(join(tmpdir(), 'ai-memory-release-admission-'));
after(() => rmSync(directory, { recursive: true, force: true }));
const source = '1'.repeat(40);
const head = '2'.repeat(40);
const tree = '3'.repeat(40);
const repository = 'example/memory';
const reviewer = 'independent-reviewer[bot]';

function evidence() {
  return {
    pullRequests: [{
      number: 21,
      state: 'closed',
      merged_at: '2026-09-30T10:00:00Z',
      merge_commit_sha: source,
      user: { login: 'author' },
      base: { ref: 'main', repo: { full_name: repository } },
      head: { sha: head },
    }],
    headCommit: { sha: head, tree: { sha: tree } },
    reviews: [{
      id: 100,
      user: { login: reviewer, type: 'Bot' },
      state: 'APPROVED',
      commit_id: head,
      submitted_at: '2026-09-30T09:00:00Z',
    }],
    workflowRuns: [{
      id: 200,
      path: '.github/workflows/ci.yml',
      head_sha: source,
      head_branch: 'main',
      event: 'push',
      repository: { full_name: repository },
      status: 'completed',
      conclusion: 'success',
    }],
  };
}

function run(value = evidence()) {
  for (const [name, content] of Object.entries(value)) {
    writeFileSync(join(directory, `${name}.json`), JSON.stringify(content));
  }
  return spawnSync(process.execPath, [
    new URL('./verify-release-admission.mjs', import.meta.url).pathname,
    directory, repository, source, tree, reviewer,
  ], { encoding: 'utf8' });
}

test('admits the exact approved tree when squash merge changes the commit SHA', () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { source, pullRequest: 21, reviewedHead: head, review: 100, ciRun: 200 });
});

const rejected = [
  ['missing merged PR', value => { value.pullRequests = []; }, /one merged main PR/],
  ['ambiguous merged PR', value => { value.pullRequests.push(structuredClone(value.pullRequests[0])); }, /one merged main PR/],
  ['unmerged PR', value => { value.pullRequests[0].merged_at = null; }, /one merged main PR/],
  ['open PR', value => { value.pullRequests[0].state = 'open'; }, /one merged main PR/],
  ['wrong merge source', value => { value.pullRequests[0].merge_commit_sha = head; }, /one merged main PR/],
  ['non-main PR', value => { value.pullRequests[0].base.ref = 'other'; }, /canonical main PR/],
  ['wrong repository PR', value => { value.pullRequests[0].base.repo.full_name = 'other/memory'; }, /canonical main PR/],
  ['missing App review', value => { value.reviews = []; }, /independent App approval/],
  ['wrong review actor', value => { value.reviews[0].user.login = 'other[bot]'; }, /independent App approval/],
  ['non-App actor', value => { value.reviews[0].user.type = 'User'; }, /independent App approval/],
  ['reviewer also authored the PR', value => { value.pullRequests[0].user.login = reviewer; }, /distinct from the PR author/],
  ['stale review head', value => { value.reviews[0].commit_id = source; }, /exact PR head/],
  ['dismissed approval', value => { value.reviews[0].state = 'DISMISSED'; }, /independent App approval/],
  ['changes requested', value => { value.reviews[0].state = 'CHANGES_REQUESTED'; }, /independent App approval/],
  ['newer blocking review', value => { value.reviews.push({ ...value.reviews[0], id: 101, state: 'CHANGES_REQUESTED' }); }, /independent App approval/],
  ['approval submitted after merge', value => { value.reviews[0].submitted_at = '2026-09-30T11:00:00Z'; }, /before merge/],
  ['wrong reviewed commit', value => { value.headCommit.sha = source; }, /reviewed head commit/],
  ['different reviewed tree', value => { value.headCommit.tree.sha = head; }, /reviewed tree differs/],
  ['missing main CI', value => { value.workflowRuns = []; }, /canonical main CI/],
  ['failed main CI', value => { value.workflowRuns[0].conclusion = 'failure'; }, /latest main CI/],
  ['unfinished main CI', value => { value.workflowRuns[0].status = 'in_progress'; }, /latest main CI/],
  ['wrong-source CI', value => { value.workflowRuns[0].head_sha = head; }, /canonical main CI/],
  ['wrong-repository CI', value => { value.workflowRuns[0].repository.full_name = 'other/memory'; }, /canonical main CI/],
  ['wrong-workflow CI', value => { value.workflowRuns[0].path = '.github/workflows/release.yml'; }, /canonical main CI/],
  ['wrong-event CI', value => { value.workflowRuns[0].event = 'pull_request'; }, /canonical main CI/],
  ['non-main CI', value => { value.workflowRuns[0].head_branch = 'other'; }, /canonical main CI/],
  ['newer failed CI after old success', value => { value.workflowRuns.push({ ...value.workflowRuns[0], id: 201, conclusion: 'failure' }); }, /latest main CI/],
  ['malformed evidence', value => { value.reviews = {}; }, /reviews must be an array/],
];

for (const [name, change, message] of rejected) {
  test(`rejects ${name}`, () => {
    const value = evidence();
    change(value);
    const result = run(value);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
  });
}

test('a later comment does not revoke the existing exact-head App approval', () => {
  const value = evidence();
  value.reviews.push({ ...value.reviews[0], id: 101, state: 'COMMENTED' });
  assert.equal(run(value).status, 0);
});

test('uses the newest canonical CI run independently of response order', () => {
  const value = evidence();
  value.workflowRuns.unshift({ ...value.workflowRuns[0], id: 201 });
  const result = run(value);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ciRun, 201);
});

test('the workflow rejects unaccepted source before running any npm command', () => {
  const root = new URL('../', import.meta.url).pathname;
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const selected = new Set([
    'Validate reviewed source and version',
    'Require independent acceptance of the exact release source',
    'Install pinned npm and dependencies',
  ]);
  // Execute the actual shell steps in workflow order, replacing only external tools.
  const scripts = workflow.split('\n      - name: ').slice(1).flatMap(section => {
    const lines = section.split('\n');
    if (!selected.has(lines[0])) return [];
    const start = lines.indexOf('        run: |');
    assert.notEqual(start, -1);
    const body = [];
    for (const line of lines.slice(start + 1)) {
      if (line && !line.startsWith('          ')) break;
      body.push(line.slice(10));
    }
    return [body.join('\n')];
  });
  assert.equal(scripts.length, 3);
  const bin = join(directory, 'workflow-bin');
  mkdirSync(bin);
  const marker = join(directory, 'npm-executed');
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nprintf "[]\\n"\n');
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\ntouch "$NPM_EXECUTION_MARKER"\n');
  for (const name of ['gh', 'npm']) chmodSync(join(bin, name), 0o755);
  const checkedOut = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  const result = spawnSync('bash', ['-c', scripts.join('\n')], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: directory,
      RELEASE_VERSION: '0.2.0',
      SOURCE_SHA: checkedOut,
      CORE_SHA256: '1'.repeat(64),
      PLUGIN_SHA256: '2'.repeat(64),
      GITHUB_REPOSITORY: repository,
      REVIEWER_ACTOR: reviewer,
      NPM_EXECUTION_MARKER: marker,
    },
  });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(marker), false, 'unaccepted source executed npm');
});
