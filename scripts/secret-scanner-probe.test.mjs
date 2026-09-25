import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

function scan(input, path) {
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
      '--set-attr',
      `path=${path}`,
    ],
    { input, encoding: 'utf8', timeout: 35_000 },
  );
  assert.ifError(result.error);
  return result;
}

test('synthetic provider token is found and never printed', () => {
  const token = `github_pat_${randomBytes(41).toString('hex')}`;
  const result = scan(`token = ${token} # betterleaks:allow\n`, 'packages/ai-memory/src/db/admin-api.test.ts');
  assert.equal(result.status, 1, 'scanner must fail on a provider token even inside a filtered test file');
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(token, 'u'));
});

const fixtureUrl = ['postgres:', '//user:pass@', 'localhost:5432/ai_memory_test'].join('');

test('synthetic local fixture and ordinary text do not raise findings', () => {
  const result = scan(
    `${fixtureUrl}\nNo credential is present.\n`,
    'packages/ai-memory/src/db/admin-api.test.ts',
  );
  assert.equal(result.status, 0, 'narrow local test URL exception must be accepted');
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

const recoveryFixtureUrl = [
  'postgresql:',
  '//synthetic:private-password@',
  '127.0.0.1:5432/ai_memory_dr_source',
].join('');

test('synthetic recovery fixture is accepted only in its test file', () => {
  assert.equal(scan(`${recoveryFixtureUrl}\n`, 'packages/ai-memory-tools/src/backup-s3.test.ts').status, 0);
  assert.equal(scan(`${recoveryFixtureUrl}\n`, 'packages/ai-memory-tools/src/disaster-recovery.ts').status, 1);
});

test('new recovery-test password is detected and redacted', () => {
  const password = randomBytes(24).toString('hex');
  const url = `postgresql://synthetic:${password}@127.0.0.1:5432/ai_memory_dr_source`;
  const result = scan(`${url}\n`, 'packages/ai-memory-tools/src/backup-s3.test.ts');
  assert.equal(result.status, 1);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(password, 'u'));
});

test('recovery fixture with a target override is detected', () => {
  const result = scan(
    `${recoveryFixtureUrl}?host=production.example.com\n`,
    'packages/ai-memory-tools/src/backup-s3.test.ts',
  );
  assert.equal(result.status, 1);
});
