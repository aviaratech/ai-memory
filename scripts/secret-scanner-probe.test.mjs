import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

function scan(input, path, extraArgs = []) {
  const result = spawnSync(
    'betterleaks',
    [
      'stdin',
      '--config=.betterleaks.toml',
      '--ignore-gitleaks-allow',
      '--redact=100',
      '--no-banner',
      '--no-color',
      '--timeout=30',
      ...(path === undefined ? [] : ['--set-attr', `path=${path}`]),
      ...extraArgs,
    ],
    { input, encoding: 'utf8', timeout: 35_000 },
  );
  assert.ifError(result.error);
  return result;
}

const reportArgs = [
  '--report-format=template',
  '--report-template=scripts/secret-scan-metadata.tmpl',
  '--report-path=-',
];
const syntheticCommit = '0123456789abcdef0123456789abcdef01234567';

// This assertion reads the fixed Go-quoted text contract, not general JSON.
function metadataRecords(output) {
  if (output === '') return [];
  assert.equal(output.endsWith('\n'), true, 'metadata records must end with a newline');
  return output
    .slice(0, -1)
    .split('\n')
    .map(line => {
      const match =
        /^finding rule="([A-Za-z0-9._-]+)" path="([A-Za-z0-9_./-]+)" start=(UNKNOWN|[1-9][0-9]*) end=(UNKNOWN|[1-9][0-9]*) commit="(UNKNOWN|[a-f0-9]{40}|[a-f0-9]{64})"$/u.exec(
          line,
        );
      assert.ok(match, 'malformed or unexpected metadata record');
      const [, rule, path, start, end, commit] = match;
      return { rule, path, start, end, commit };
    });
}

test('native report emits finding identity without matching text or extra attributes', () => {
  const token = `github_pat_${randomBytes(41).toString('hex')}`;
  const context = 'synthetic-context-canary';
  const result = scan(`${context} = ${token}\n`, 'packages/synthetic-fixture.txt', [
    ...reportArgs,
    '--set-attr',
    `git.sha=${syntheticCommit}`,
    '--set-attr',
    `git.message=${context}`,
  ]);
  assert.equal(result.status, 1, 'reporting must preserve the finding exit');
  assert.deepEqual(metadataRecords(result.stdout), [
    {
      rule: 'github-fine-grained-pat',
      path: 'packages/synthetic-fixture.txt',
      start: '1',
      end: '1',
      commit: syntheticCommit,
    },
  ]);
  assert.equal(`${result.stdout}${result.stderr}`.includes(token), false, 'matched value must stay redacted');
  assert.equal(result.stdout.includes(context), false, 'matching context and extra attributes must not be reported');
});

test('native report marks absent and unsafe source metadata UNKNOWN', () => {
  const token = `github_pat_${randomBytes(41).toString('hex')}`;
  for (const path of [
    undefined,
    '/absolute/fixture',
    '../fixture',
    'safe/../fixture',
    'safe/./fixture',
    'safe//fixture',
    'quote"fixture',
    'line\n::notice::synthetic-canary',
    'unicode-\u2028fixture',
  ]) {
    const result = scan(`${token}\n`, path, [...reportArgs, '--set-attr', 'git.sha=invalid-commit']);
    assert.equal(result.status, 1);
    const records = metadataRecords(result.stdout);
    assert.equal(records.length, 1);
    assert.equal(records[0].path, 'UNKNOWN');
    assert.equal(records[0].commit, 'UNKNOWN');
    assert.equal(result.stdout.includes('::notice::'), false, 'source metadata must not inject log commands');
    assert.equal(`${result.stdout}${result.stderr}`.includes(token), false);
  }
});

test('native report retains relative hidden paths and supports a hexadecimal SHA-256 commit', () => {
  const token = `github_pat_${randomBytes(41).toString('hex')}`;
  const commit = '0123456789abcdef'.repeat(4);
  const result = scan(`ordinary line\n${token}\n`, '.github/synthetic-fixture.txt', [
    ...reportArgs,
    '--set-attr',
    `git.sha=${commit}`,
  ]);
  assert.equal(result.status, 1);
  assert.deepEqual(metadataRecords(result.stdout), [
    {
      rule: 'github-fine-grained-pat',
      path: '.github/synthetic-fixture.txt',
      start: '2',
      end: '2',
      commit,
    },
  ]);
});

test('native report keeps zero findings successful and report errors nonzero', () => {
  const clean = scan('No credential is present.\n', undefined, reportArgs);
  assert.equal(clean.status, 0);
  assert.deepEqual(metadataRecords(clean.stdout), []);
  for (const args of [
    [...reportArgs, '--report-template=scripts/absent-metadata-template'],
    [...reportArgs, '--report-path=scripts/absent-metadata-directory/report.txt'],
  ]) {
    const failed = scan('No credential is present.\n', undefined, args);
    assert.notEqual(failed.status, 0, 'native report setup/write failure must fail the command');
    assert.equal(failed.stdout, '');
  }
});

test('recorded metadata covers six unlocated findings and rejects malformed output', () => {
  const unlocated = 'finding rule="UNKNOWN" path="UNKNOWN" start=UNKNOWN end=UNKNOWN commit="UNKNOWN"\n';
  const records = metadataRecords(unlocated.repeat(6));
  assert.equal(records.length, 6);
  assert.deepEqual(records[0], {
    rule: 'UNKNOWN',
    path: 'UNKNOWN',
    start: 'UNKNOWN',
    end: 'UNKNOWN',
    commit: 'UNKNOWN',
  });
  for (const malformed of [
    unlocated.trimEnd(),
    `${unlocated}unexpected\n`,
    unlocated.replace('start=UNKNOWN', 'start=-1'),
    unlocated.replace(' commit=', ' match="forbidden" commit='),
    unlocated.replace('"UNKNOWN" path=', '"broken\nrecord" path='),
  ]) {
    assert.throws(() => metadataRecords(malformed), { code: 'ERR_ASSERTION' });
  }
});

test('synthetic provider token is found and never printed', () => {
  const token = `github_pat_${randomBytes(41).toString('hex')}`;
  const result = scan(`token = ${token} # betterleaks:allow\n`, 'packages/ai-memory/src/db/admin-api.test.ts');
  assert.equal(result.status, 1, 'scanner must fail on a provider token even inside a filtered test file');
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(token, 'u'));
});

const fixtureUrl = ['postgres:', '//user:pass@', 'localhost:5432/ai_memory_test'].join('');

test('synthetic local fixtures in current and historical paths do not raise findings', () => {
  for (const path of [
    'packages/ai-memory/src/db/admin-api.test.ts',
    'packages/ai-memory/src/tools/backup-db.test.ts',
    'packages/ai-memory-tools/src/backup-db.test.ts',
  ]) {
    const result = scan(`${fixtureUrl}\nNo credential is present.\n`, path);
    assert.equal(result.status, 0, `narrow local test URL exception must be accepted in ${path}`);
  }
});

test('the local fixture exception does not extend to an unrelated path', () => {
  const result = scan(`${fixtureUrl}\n`, 'packages/ai-memory/src/db/pool.ts');
  assert.equal(result.status, 1, 'the same credential URI outside the fixture files must be detected');
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(fixtureUrl, 'u'));
});

test('a new password in a test file is not an accepted placeholder', () => {
  const password = randomBytes(24).toString('hex');
  const url = `postgresql://fixture:${password}@127.0.0.1:5432/ai_memory_test`;
  const result = scan(`${url}\n`, 'packages/ai-memory/src/db/admin-api.test.ts');
  assert.equal(result.status, 1, 'fresh credentials in tests must be detected');
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(password, 'u'));
});

test('a placeholder URL with a connection-target override is detected', () => {
  const url = ['postgresql:', '//test:test@', '127.0.0.1:5432/ai_memory?host=production.example.com'].join('');
  const result = scan(`${url}\n`, 'packages/ai-memory/src/db/admin-api.test.ts');
  assert.equal(result.status, 1, 'a target override must not be treated as a local fixture');
});

const recoveryFixtureUrl = ['postgresql:', '//synthetic:private-password@', '127.0.0.1:5432/ai_memory_dr_source'].join(
  '',
);

test('synthetic recovery fixture is accepted only in current and historical test files', () => {
  for (const path of [
    'packages/ai-memory/src/tools/backup-s3.test.ts',
    'packages/ai-memory-tools/src/backup-s3.test.ts',
  ]) {
    assert.equal(scan(`${recoveryFixtureUrl}\n`, path).status, 0);
  }
  assert.equal(scan(`${recoveryFixtureUrl}\n`, 'packages/ai-memory/src/tools/disaster-recovery.ts').status, 1);
});

test('new recovery-test password is detected and redacted', () => {
  const password = randomBytes(24).toString('hex');
  const url = `postgresql://synthetic:${password}@127.0.0.1:5432/ai_memory_dr_source`;
  const result = scan(`${url}\n`, 'packages/ai-memory/src/tools/backup-s3.test.ts');
  assert.equal(result.status, 1);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(password, 'u'));
});

test('recovery fixture with a target override is detected', () => {
  const result = scan(
    `${recoveryFixtureUrl}?host=production.example.com\n`,
    'packages/ai-memory/src/tools/backup-s3.test.ts',
  );
  assert.equal(result.status, 1);
});

const pluginFixtureUris = [
  [
    'packages/ai-memory/src/tools/pluginEnv.test.ts',
    ['postgresql:', '//runtime:synthetic-secret@', '127.0.0.1/ai_memory'].join(''),
  ],
  [
    'packages/ai-memory/src/tools/pluginEnv.test.ts',
    ['postgresql:', '//user:do-not-print@', 'localhost/ai_memory'].join(''),
  ],
  [
    'packages/ai-memory/src/tools/pluginDoctor.test.ts',
    ['postgresql:', '//admin:do-not-print@', '127.0.0.1/ai_memory'].join(''),
  ],
  [
    'packages/ai-memory/src/tools/plugin-process.test.ts',
    ['postgresql:', '//runtime:fixture@', '127.0.0.1/ai_memory'].join(''),
  ],
];

test('only exact local plugin fixture credentials are accepted', () => {
  for (const [path, url] of pluginFixtureUris) {
    assert.equal(scan(`${url}\n`, path).status, 0);
    assert.equal(scan(`${url}?host=production.example.com\n`, path).status, 1);
    assert.equal(scan(`${url}\n`, 'packages/ai-memory/src/tools/pluginInstallation.ts').status, 1);
    const password = randomBytes(24).toString('hex');
    assert.equal(scan(`${url.replace(/:[^:@]+@/u, `:${password}@`)}\n`, path).status, 1);
    const token = `github_pat_${randomBytes(41).toString('hex')}`;
    const provider = scan(`token = ${token}\n`, path);
    assert.equal(provider.status, 1);
    assert.doesNotMatch(`${provider.stdout}${provider.stderr}`, new RegExp(token, 'u'));
  }
});
