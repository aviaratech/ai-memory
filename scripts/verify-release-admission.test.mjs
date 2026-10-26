import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { createHash } from 'node:crypto';

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

function releaseSteps(names) {
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const scripts = workflow.split('\n      - name: ').slice(1).flatMap(section => {
    const lines = section.split('\n');
    if (!names.includes(lines[0])) return [];
    const start = lines.indexOf('        run: |');
    assert.notEqual(start, -1);
    const body = [];
    for (const line of lines.slice(start + 1)) {
      if (line && !line.startsWith('          ')) break;
      body.push(line.slice(10));
    }
    return [body.join('\n')];
  });
  assert.equal(scripts.length, names.length);
  return scripts.join('\n');
}

function registryFixture(options = {}) {
  const fixture = mkdtempSync(join(directory, 'registry-'));
  const bin = join(fixture, 'bin');
  const releaseDirectory = join(fixture, 'ai-memory-release');
  mkdirSync(bin);
  mkdirSync(releaseDirectory);
  const integrity = 'sha512-synthetic-reviewed-core';
  const archive = 'aviaratech-ai-memory-plugin-0.2.6.tgz';
  const plugin = 'synthetic reviewed plugin';
  writeFileSync(join(releaseDirectory, 'core-pack.json'), JSON.stringify([{ integrity }]));
  writeFileSync(join(releaseDirectory, archive), plugin);
  const stateFile = join(fixture, 'registry.json');
  const initial = {
    accepted: false, publishes: 0, reads: 0, visibleAfter: 28, integrity,
    tag: source,
    release: { tagName: 'v0.2.6', name: 'ai-memory v0.2.6', body: `Reviewed ai-memory release from ${source}.`, isDraft: true, isPrerelease: false, assets: [] },
    ...options,
  };
  writeFileSync(stateFile, JSON.stringify(initial));
  const executable = (name, script) => {
    writeFileSync(join(bin, name), script);
    chmodSync(join(bin, name), 0o755);
  };
  const prelude = `#!${process.execPath}\nimport fs from 'node:fs';\nconst file = process.env.FAKE_REGISTRY;\nconst state = JSON.parse(fs.readFileSync(file, 'utf8'));\nconst save = () => fs.writeFileSync(file, JSON.stringify(state));\nconst args = process.argv.slice(2);\n`;
  executable('npm', prelude + `
    if (args[0] === 'publish') {
      state.publishes++;
      if (state.accepted) { save(); throw new Error('duplicate publish'); }
      state.accepted = true;
      save();
    } else if (args[0] === 'view') {
      state.reads++;
      save();
      if (state.registryError && (!state.errorAfterPublish || state.accepted)) {
        console.error('npm error code ' + state.registryError);
        process.exit(1);
      }
      if (!state.accepted || state.reads <= state.visibleAfter) {
        console.error('npm error code E404');
        process.exit(1);
      }
      console.log(JSON.stringify(state.integrity));
    } else { throw new Error('unexpected npm invocation'); }
  `);
  executable('git', prelude + `
    if (args[0] !== 'ls-remote') throw new Error('unexpected git invocation');
    console.log(state.tag + '\\trefs/tags/v0.2.6');
  `);
  executable('gh', prelude + `
    if (args[0] !== 'release') throw new Error('unexpected gh invocation');
    if (args[1] === 'view') console.log(JSON.stringify(state.release));
    else if (args[1] === 'upload') {
      state.release.assets.push({ name: '${archive}', state: 'uploaded' });
      save();
    } else if (args[1] === 'download') {
      fs.writeFileSync(args[args.indexOf('--dir') + 1] + '/${archive}', ${JSON.stringify(plugin)});
    } else if (args[1] === 'edit') {
      state.release.isDraft = false;
      save();
    } else { throw new Error('unexpected gh release invocation'); }
  `);
  executable('sleep', `#!/bin/sh\nif [ -f "$FAKE_REGISTRY.cancel" ]; then\n  rm "$FAKE_REGISTRY.cancel"\n  kill -TERM "$PPID"\nfi\n`);
  // macOS sha256sum does not accept GNU --check/--status used by the runner.
  executable('sha256sum', `#!${process.execPath}
    import fs from 'node:fs';
    import assert from 'node:assert/strict';
    import { createHash } from 'node:crypto';
    assert.deepEqual(process.argv.slice(2), ['--check', '--status']);
    for (const line of fs.readFileSync(0, 'utf8').trim().split('\\n')) {
      const [expected, file] = line.split('  ');
      assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), expected);
    }
  `);
  const read = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  const update = patch => writeFileSync(stateFile, JSON.stringify({ ...read(), ...patch }));
  return {
    read, update,
    cancel: () => writeFileSync(`${stateFile}.cancel`, ''),
    run: (environment = {}) => spawnSync('bash', ['-c', releaseSteps([
      'Preflight registry and GitHub release conflicts',
      'Reserve reviewed tag and draft release',
      'Publish checked workspaces with npm OIDC',
      'Complete reviewed plugin release',
    ])], {
      cwd: new URL('../', import.meta.url).pathname,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_REGISTRY: stateFile,
        RUNNER_TEMP: fixture,
        RELEASE_VERSION: '0.2.6',
        SOURCE_SHA: source,
        PLUGIN_SHA256: createHash('sha256').update(plugin).digest('hex'),
        ...environment,
      },
    }),
  };
}

test('accepted npm publish waits beyond 25 E404 reads and completes the plugin once', () => {
  const fixture = registryFixture();
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  const state = fixture.read();
  assert.ok(state.reads > 25);
  assert.equal(state.publishes, 1);
  assert.equal(state.release.isDraft, false);
  assert.equal(state.release.assets.length, 1);
});

for (const afterPublish of [false, true]) {
  test(`registry integrity mismatch ${afterPublish ? 'after' : 'before'} publish prevents plugin completion`, () => {
    const fixture = registryFixture({ accepted: !afterPublish, visibleAfter: 0, integrity: 'sha512-wrong' });
    const result = fixture.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /integrity mismatch/);
    assert.equal(fixture.read().publishes, afterPublish ? 1 : 0);
    assert.equal(fixture.read().release.isDraft, true);
    assert.deepEqual(fixture.read().release.assets, []);
  });

  test(`non-E404 registry failure ${afterPublish ? 'after' : 'before'} publish prevents plugin completion`, () => {
    const fixture = registryFixture({ registryError: 'E503', errorAfterPublish: afterPublish });
    const result = fixture.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /E503/);
    assert.equal(fixture.read().publishes, afterPublish ? 1 : 0);
    assert.equal(fixture.read().release.isDraft, true);
    assert.deepEqual(fixture.read().release.assets, []);
  });
}

test('interrupted visibility wait retains accepted core and draft; visible recovery never republishes', () => {
  const fixture = registryFixture();
  fixture.cancel();
  const interrupted = fixture.run();
  assert.equal(interrupted.signal, 'SIGTERM');
  const checkpoint = fixture.read();
  assert.equal(checkpoint.accepted, true);
  assert.equal(checkpoint.publishes, 1);
  assert.equal(checkpoint.tag, source);
  assert.equal(checkpoint.release.isDraft, true);
  assert.deepEqual(checkpoint.release.assets, []);

  // Registry processing completes independently while the runner is stopped.
  fixture.update({ visibleAfter: 0 });
  const wrongSource = fixture.run({ SOURCE_SHA: head });
  assert.notEqual(wrongSource.status, 0);
  assert.match(wrongSource.stdout + wrongSource.stderr, /different source/);
  fixture.update({ integrity: 'sha512-changed' });
  assert.notEqual(fixture.run().status, 0);
  assert.equal(fixture.read().publishes, 1);
  assert.deepEqual(fixture.read().release.assets, []);

  fixture.update({ integrity: checkpoint.integrity });
  const resumed = fixture.run();
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(fixture.read().publishes, 1);
  const uninterrupted = registryFixture({ visibleAfter: 0 });
  assert.equal(uninterrupted.run().status, 0);
  assert.deepEqual(fixture.read().release, uninterrupted.read().release);
  assert.equal(fixture.read().tag, uninterrupted.read().tag);
});

test('plugin archive integrity mismatch prevents draft promotion', () => {
  const fixture = registryFixture({ accepted: true, visibleAfter: 0 });
  const result = fixture.run({ PLUGIN_SHA256: '0'.repeat(64) });
  assert.notEqual(result.status, 0);
  assert.equal(fixture.read().publishes, 0);
  assert.equal(fixture.read().release.isDraft, true);
});

test('workflow retains protected main, exact source acceptance and both archive guards', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /environment: public-release/);
  assert.match(workflow, /\[\[ "\$\(git rev-parse HEAD\)" == "\$SOURCE_SHA" \]\]/);
  assert.match(workflow, /node scripts\/verify-release-admission\.mjs[^\n]*\n[^\n]*"\$SOURCE_SHA"[^\n]*"\$REVIEWER_ACTOR"/);
  assert.ok(workflow.indexOf('Require independent acceptance') < workflow.indexOf('Install pinned npm'));
  const pack = releaseSteps(['Pack and verify exact reviewed archives']);
  assert.match(pack, /"\$CORE_SHA256" "\$release_dir\/aviaratech-ai-memory-\$RELEASE_VERSION\.tgz"/);
  assert.match(pack, /"\$PLUGIN_SHA256" "\$release_dir\/aviaratech-ai-memory-plugin-\$RELEASE_VERSION\.tgz"/);
  assert.match(pack, /sha256sum --check --status/);
});

function releaseState(body, tag = 'v0.3.0') {
  const file = join(directory, 'release-state.json');
  const archive = `aviaratech-ai-memory-plugin-${tag.slice(1)}.tgz`;
  writeFileSync(file, JSON.stringify({
    tagName: tag, name: `ai-memory ${tag}`, body,
    isDraft: false, isPrerelease: false,
    assets: [{ name: archive, state: 'uploaded' }],
  }));
  return spawnSync(process.execPath, [
    new URL('./verify-release-state.mjs', import.meta.url).pathname,
    file, tag, source, archive, 'final',
  ], { encoding: 'utf8' });
}

test('0.3.0 release notes include cleanup, migration 010 and index-first search', () => {
  const notes = spawnSync(process.execPath, [
    new URL('./verify-release-state.mjs', import.meta.url).pathname, '--notes', 'v0.3.0', source,
  ], { encoding: 'utf8' });
  assert.equal(notes.status, 0, notes.stderr);
  assert.match(notes.stdout, new RegExp(`^Reviewed ai-memory release from ${source}\\.`));
  assert.match(notes.stdout, /cleanup/);
  assert.match(notes.stdout, /010/);
  assert.match(notes.stdout, /[Ii]ndex-first search/);
  assert.equal(releaseState(notes.stdout).status, 0);
  for (const body of [
    `Reviewed ai-memory release from ${source}.`,
    notes.stdout.replace('cleanup', 'removed-topic'),
    notes.stdout.replace(source, head),
    `${notes.stdout}Unreviewed addition.`,
  ]) assert.notEqual(releaseState(body).status, 0);
});

test('historical releases retain exact generic notes without repair', () => {
  assert.equal(releaseState(`Reviewed ai-memory release from ${source}.`, 'v0.2.8').status, 0);
  assert.notEqual(releaseState(`Reviewed ai-memory release from ${head}.`, 'v0.2.8').status, 0);
});

test('0.3.1 release notes cover the direct 0.2.8 upgrade and every intervening change', () => {
  const notes = spawnSync(process.execPath, [
    new URL('./verify-release-state.mjs', import.meta.url).pathname, '--notes', 'v0.3.1', source,
  ], { encoding: 'utf8' });
  assert.equal(notes.status, 0, notes.stderr);
  for (const topic of [
    '0.2.8', '010_index_first_search', '011_pinned_brief', 'AI_MEMORY_ROLE',
    'AI_MEMORY_MCP_HTTP_ALLOWED_ORIGINS', '#75', '#76', '#77', '#79', '#80', '#81', '#84',
    'checkpoint', 'tag', 'secret-scan', 'cleanup', '0.3.0 can be skipped',
  ]) assert.ok(notes.stdout.toLowerCase().includes(topic.toLowerCase()), `missing release topic: ${topic}`);
  assert.equal(releaseState(notes.stdout, 'v0.3.1').status, 0);
  assert.notEqual(releaseState(`Reviewed ai-memory release from ${source}.`, 'v0.3.1').status, 0);
  assert.notEqual(releaseState(`${notes.stdout}Unreviewed addition.`, 'v0.3.1').status, 0);
});

test('0.3.2 release generation and validation retain the loaded detailed notes', () => {
  const details = readFileSync(new URL('../docs/releases/0.3.2.md', import.meta.url), 'utf8').trim();
  const notes = spawnSync(process.execPath, [
    new URL('./verify-release-state.mjs', import.meta.url).pathname, '--notes', 'v0.3.2', source,
  ], { encoding: 'utf8' });
  assert.equal(notes.status, 0, notes.stderr);
  assert.equal(notes.stdout.trimEnd(), `Reviewed ai-memory release from ${source}.\n\n${details}`);
  assert.equal(releaseState(notes.stdout, 'v0.3.2').status, 0);
  assert.notEqual(releaseState(`Reviewed ai-memory release from ${source}.`, 'v0.3.2').status, 0);
});

test('workflow creates a draft from the same notes that its verifier accepts', () => {
  const reserve = releaseSteps(['Reserve reviewed tag and draft release']);
  assert.match(reserve, /node scripts\/verify-release-state\.mjs --notes "\$tag" "\$SOURCE_SHA"/);
  assert.match(reserve, /--notes-file "\$release_dir\/release-notes\.md"/);
});
