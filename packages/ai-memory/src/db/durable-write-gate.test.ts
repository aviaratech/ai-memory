import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  assertDurableContent,
  assertDurableWriteGate,
  DurableWriteGateError,
  findCompressedWord,
} from './durable-write-gate.js';

// Wraps a gate call so assert.throws/doesNotThrow receive a block statement.
const gate = (input: Parameters<typeof assertDurableWriteGate>[0]) => () => {
  assertDurableWriteGate(input);
};

// Fake credentials are joined at runtime so the repository's secret scanner never sees a literal.
const joined = (...parts: string[]) => parts.join('');
const FAKE_AWS_KEY = joined('AKIA', 'ABCDEFGHIJKLMNOP');
const FAKE_GITHUB_TOKEN = joined('ghp', '_abcdefghijklmnopqrstuvwxyz0123456789');

const VALID = {
  category: 'convention',
  content: 'Integration tests run only against a disposable PostgreSQL database.',
  evidenceRefs: ['CONTRIBUTING.md'],
  memoryKey: 'example/catalog:integration-test-database',
  tags: ['testing'],
};

test('a fixture agent applies all field-specific fixes and passes on its second call', () => {
  const input: Record<string, unknown> = {
    category: 'convention',
    content: 'Short note.',
    confidence: 0.2,
    evidenceRefs: [],
  };
  let calls = 0;
  const attempt = () => {
    calls += 1;
    assertDurableWriteGate(input);
  };
  try {
    attempt();
    assert.fail('fixture must be rejected');
  } catch (error) {
    assert.ok(error instanceof DurableWriteGateError);
    assert.deepEqual(
      new Set(error.problems.map(problem => problem.field)),
      new Set(['memoryKey', 'evidenceRefs', 'content', 'confidence']),
    );
    const repairs: Record<string, unknown> = { ...VALID, confidence: 0.8 };
    for (const problem of error.problems) {
      assert.ok(problem.reason.length > 0 && problem.fix.length > 15);
      input[problem.field] = repairs[problem.field];
    }
  }
  attempt();
  assert.equal(calls, 2);
});

test('structured fixes never echo rejected sensitive values', () => {
  try {
    assertDurableWriteGate({ ...VALID, metadata: { owner: 'someone@example.com' } });
    assert.fail('fixture must be rejected');
  } catch (error) {
    assert.ok(error instanceof DurableWriteGateError);
    assert.equal(error.problems[0]?.field, 'metadata');
    assert.ok(!JSON.stringify(error.problems).includes('someone'));
    assert.match(error.problems[0]?.fix ?? '', /Remove/u);
  }
});

test('a keyed, evidenced, plain-language memory passes the gate', () => {
  assert.doesNotThrow(gate(VALID));
  assert.doesNotThrow(gate({ ...VALID, evidenceRefs: [{ issue: 33 }, { url: 'https://example.com/pr/1' }] }));
  assert.doesNotThrow(
    gate({
      ...VALID,
      content: 'Clone with git@github.com:example/catalog.git and pin react@18.3.1 for the fixture.',
    }),
  );
});

test('the gate requires a caller-chosen key and auditable evidence', () => {
  assert.throws(gate({ ...VALID, memoryKey: undefined }), /memoryKey is required/u);
  assert.throws(gate({ ...VALID, memoryKey: '  ' }), /memoryKey is required/u);
  assert.throws(gate({ ...VALID, memoryKey: 'derived-memory:v1:abc' }), /reserved "derived-memory:" prefix/u);
  for (const evidenceRefs of [undefined, [], [''], [{ kind: 'fixture' }], 'CONTRIBUTING.md']) {
    assert.throws(gate({ ...VALID, evidenceRefs }), /evidenceRefs needs at least one/u);
  }
});

test('session summaries belong in memory_flush', () => {
  assert.throws(gate({ ...VALID, category: 'session-summary' }), /memory_flush/u);
});

test('the gate rejects shorthand and run-together words', () => {
  assert.throws(gate({ ...VALID, content: 'Use disposable databases.' }), /at least 4 words/u);
  assert.throws(
    gate({
      ...VALID,
      content: 'Always run releaseverificationandfinalownedcleanup before merging.',
    }),
    /without spaces/u,
  );
  assert.equal(findCompressedWord('Paths like packages/ai-memory/src/db/durable-write-gate.ts are fine.'), undefined);
  assert.equal(findCompressedWord('A digest abcdefabcdefabcdefabcdefabcdefabcdef is fine.'), undefined);
  assert.equal(
    findCompressedWord('releaseverificationandfinalownedcleanup'),
    'releaseverificationandfinalownedcleanup',
  );
});

test('the gate rejects secrets and personal data in every stored text field without echoing them', () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [
      { content: 'Ask the owner at someone@example.com before retrying the job.' },
      /content appears to contain an email address/u,
    ],
    [
      { evidenceRefs: ['/Users/someone/repos/catalog/notes.md'] },
      /evidenceRefs appears to contain a home-folder path/u,
    ],
    [{ evidenceRefs: [{ path: '/home/someone/catalog/notes.md' }] }, /home-folder path/u],
    [{ tags: ['C:\\Users\\someone\\notes'] }, /tags appears to contain a home-folder path/u],
    [{ content: `The key ${FAKE_AWS_KEY} was rotated after the incident.` }, /an AWS access key/u],
    [{ content: `The token ${FAKE_GITHUB_TOKEN} was revoked yesterday.` }, /a GitHub token/u],
    [
      {
        content: `Connect with ${joined('postgres:', '//admin:', 'hunter22', '@localhost:5432/catalog')} for the fixture.`,
      },
      /a URL with a password/u,
    ],
    [
      { content: `Set ${joined('pass', 'word=correct-horse-9battery')} in the synthetic config file.` },
      /a password or secret value/u,
    ],
    [{ memoryKey: 'catalog:someone@example.com' }, /memoryKey appears to contain an email address/u],
  ];
  for (const [override, reason] of cases) {
    assert.throws(
      gate({ ...VALID, ...override }),
      (error: unknown) =>
        error instanceof Error &&
        reason.test(error.message) &&
        ![FAKE_AWS_KEY, FAKE_GITHUB_TOKEN, 'someone', 'hunter22', 'correct-horse'].some(secret =>
          error.message.includes(secret),
        ),
    );
  }
});

test('the gate reports every problem at once', () => {
  assert.throws(
    gate({ category: 'decision', content: 'Short note.', evidenceRefs: [] }),
    (error: unknown) =>
      error instanceof Error &&
      /memoryKey is required/u.test(error.message) &&
      /evidenceRefs needs at least one/u.test(error.message) &&
      /at least 4 words/u.test(error.message),
  );
});

test('the gate scans every text field and rejects the flush-reserved sources', () => {
  assert.throws(gate({ ...VALID, source: 'manual-flush' }), /source "manual-flush" is reserved/u);
  assert.throws(gate({ ...VALID, source: 'Memory-Flush' }), /reserved/u);
  assert.throws(
    gate({ ...VALID, metadata: { owner: 'someone@example.com' } }),
    /metadata appears to contain an email/u,
  );
  assert.throws(gate({ ...VALID, userId: 'someone@example.com' }), /userId appears to contain an email/u);
  assert.doesNotThrow(gate({ ...VALID, confidence: 0.9, embedding: [0.1, 0.2], source: 'claude-code' }));
});

test('home-folder paths match only as whole paths', () => {
  for (const content of [
    'Templates live in app/views/home/index.html.erb for this fixture.',
    'The docs page https://example.com/home/guide explains the fixture.',
    'The endpoint /api/Users/1 returns the synthetic user record.',
  ]) {
    assert.doesNotThrow(gate({ ...VALID, content }), content);
  }
  for (const content of [
    '/Users/someone/repos holds the fixture checkout today.',
    'Open file:///home/someone/fixture.txt to read the synthetic file.',
    'The checkout is at "C:\\Users\\someone\\fixture" on the synthetic host.',
  ]) {
    assert.throws(gate({ ...VALID, content }), /home-folder path/u, content);
  }
});

test('secret assignments are caught by name, while variable references and plain words pass', () => {
  for (const content of [
    'The workflow reads secret: NPM_TOKEN from the repository settings.',
    'Export api_key=$OPENAI_API_KEY before running the synthetic fixture.',
    'The login form marks password: required for every synthetic account.',
    'The page labels secret: confidential above the synthetic form.',
  ]) {
    assert.doesNotThrow(gate({ ...VALID, content }), content);
  }
  for (const content of [
    `The fixture used ${joined('DB_PASS', 'WORD=fixture-pass-123')} before the rotation.`,
    `Running ${joined('PGPASS', 'WORD=fixture987pass')} psql opened the synthetic database.`,
    `It exported ${joined('AWS_SECRET_', 'ACCESS_KEY=abcd1234EFGH5678ijkl')} for the synthetic job.`,
    `The fixture used ${joined('pass', 'word=correcthorsebattery')} before the rotation.`,
    `The fixture used ${joined('pass', 'wd=fixtureSecretWord')} before the rotation.`,
  ]) {
    assert.throws(gate({ ...VALID, content }), /a password or secret value/u, content);
  }
  for (const content of [
    `The fixture key ${joined('sk_', 'live_abcdefghijklmnop1234')} was revoked yesterday.`,
    `The token ${joined('npm', '_abcdefghijklmnopqrstuvwxyz0123456789')} was revoked yesterday.`,
    `The key ${joined('AIza', 'SyA1234567890abcdefghijklmnopqrstuv')} was revoked yesterday.`,
  ]) {
    assert.throws(gate({ ...VALID, content }), /an API key/u, content);
  }
});

test('assertDurableContent applies the content rules to merged text', () => {
  assert.doesNotThrow(() => {
    assertDurableContent('Both synthetic rules now say the same thing.', 'mergedContent');
  });
  assert.throws(() => {
    assertDurableContent('Too short.', 'mergedContent');
  }, /mergedContent was rejected: content must be plain sentences/u);
  assert.throws(() => {
    assertDurableContent('Ask the synthetic owner at someone@example.com first.', 'mergedContent');
  }, /mergedContent appears to contain an email address/u);
});
