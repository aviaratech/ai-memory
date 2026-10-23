import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { createGithubEvidenceLookup, findStaleMemories, runStaleCli } from './stale.js';

const now = new Date('2026-10-22T12:00:00.000Z');
const memory = {
  id: 1,
  project: 'example/catalog',
  memoryKey: 'example/catalog:rule',
  status: 'active',
  lastVerifiedAt: '2026-10-01T00:00:00.000Z',
  evidenceRefs: ['https://github.com/example/catalog/issues/12'],
};

test('only active keyed memories are flagged, with closure strictly after verification and exact project scope', async () => {
  const rows = await findStaleMemories(
    [
      { ...memory, lastVerifiedAt: '2026-09-22T12:00:00.000Z' },
      { ...memory, id: 2, memoryKey: 'example/catalog:closed' },
      { ...memory, id: 3, memoryKey: 'example/catalog:equal', lastVerifiedAt: '2026-10-15T00:00:00.000Z' },
      { ...memory, id: 4, status: 'archived' },
      { ...memory, id: 5, memoryKey: null },
      { ...memory, id: 6, project: 'other/catalog' },
      { ...memory, id: 7, expiresAt: '2026-10-21T00:00:00.000Z' },
    ],
    { now, project: 'example/catalog', lookupClosure: () => Promise.resolve('2026-10-15T00:00:00.000Z') },
  );
  assert.deepEqual(
    rows.map(row => ({ key: row.memoryKey, reasons: row.reasons })),
    [
      { key: 'example/catalog:rule', reasons: ['unverified_30d', 'evidence_closed'] },
      { key: 'example/catalog:closed', reasons: ['evidence_closed'] },
    ],
  );
});

test('unscoped keyed memories remain visible in the global stale report without entering a project report', async () => {
  const rows = [{ ...memory, project: null, lastVerifiedAt: '2026-01-01T00:00:00.000Z' }];
  assert.equal((await findStaleMemories(rows, { now }))[0]?.project, null);
  assert.deepEqual(await findStaleMemories(rows, { now, project: 'example/catalog' }), []);
});

test('GitHub issue/PR reads use a persistent 24-hour project-qualified cache and reject other evidence hosts', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'stale-evidence-'));
  const requests: { url: string; method: string | undefined }[] = [];
  const fetcher: typeof fetch = (input, options) => {
    requests.push({ url: String(input), method: options?.method });
    return Promise.resolve(new Response(JSON.stringify({ closed_at: '2026-10-15T00:00:00Z' })));
  };
  try {
    const lookup = createGithubEvidenceLookup({ token: 'synthetic', cacheDir, now: () => now, fetch: fetcher });
    assert.equal(await lookup('example/catalog', memory.evidenceRefs[0]!), '2026-10-15T00:00:00.000Z');
    const cached = createGithubEvidenceLookup({
      token: 'synthetic',
      cacheDir,
      now: () => new Date(now.getTime() + 86399999),
      fetch: fetcher,
    });
    assert.equal(await cached('example/catalog', memory.evidenceRefs[0]!), '2026-10-15T00:00:00.000Z');
    assert.equal(requests.length, 1);
    const expired = createGithubEvidenceLookup({
      token: 'synthetic',
      cacheDir,
      now: () => new Date(now.getTime() + 86400000),
      fetch: fetcher,
    });
    await expired('example/catalog', memory.evidenceRefs[0]!);
    await lookup('other/catalog', { url: 'https://github.com/example/catalog/pull/13#discussion' });
    assert.deepEqual(requests, [
      { url: 'https://api.github.com/repos/example/catalog/issues/12', method: 'GET' },
      { url: 'https://api.github.com/repos/example/catalog/issues/12', method: 'GET' },
      { url: 'https://api.github.com/repos/example/catalog/pulls/13', method: 'GET' },
    ]);
    const credentialed = new URL('https://github.com/example/catalog/issues/12');
    credentialed.username = randomUUID();
    const passwordOnly = new URL('https://github.com/example/catalog/issues/12');
    passwordOnly.password = randomUUID();
    for (const ref of [
      'https://github.com.evil.test/example/catalog/issues/12',
      'https://example.com/12',
      credentialed.toString(),
      passwordOnly.toString(),
    ]) {
      assert.equal(await lookup('example/catalog', ref), undefined);
    }
    assert.equal(requests.length, 3);
    const offline = createGithubEvidenceLookup({ cacheDir, cacheOnly: true, now: () => now });
    assert.equal(
      await offline('example/catalog', memory.evidenceRefs[0]!),
      undefined,
      'future cache timestamps are not reusable',
    );
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('no token still prints age flags, one warning and succeeds in both CLI formats', async () => {
  for (const json of [false, true]) {
    const warnings: string[] = [];
    let output = '';
    await runStaleCli(['--project', memory.project, ...(json ? ['--json'] : [])], {
      now: () => now,
      env: {},
      load: () =>
        Promise.resolve([
          { ...memory, lastVerifiedAt: '2026-08-01T00:00:00.000Z' },
          { ...memory, memoryKey: 'example/catalog:second', lastVerifiedAt: '2026-08-01T00:00:00.000Z' },
        ]),
      lookupClosure: () => Promise.resolve(undefined),
      write: value => {
        output += value;
      },
      warn: value => {
        warnings.push(value);
      },
    });
    assert.equal(warnings.length, 1);
    assert.match(output, /unverified_30d/u);
    if (json) assert.equal((JSON.parse(output) as unknown[]).length, 2);
  }
});

test('GitHub errors keep age flags and produce one advisory without caching a failed read', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'stale-failure-'));
  let calls = 0;
  try {
    const warnings: string[] = [];
    const lookup = createGithubEvidenceLookup({
      token: 'synthetic',
      cacheDir,
      now: () => now,
      fetch: () => {
        calls++;
        return Promise.resolve(new Response('{}', { status: 403 }));
      },
      warn: value => {
        warnings.push(value);
      },
    });
    const result = await findStaleMemories([{ ...memory, lastVerifiedAt: '2026-08-01T00:00:00.000Z' }], {
      now,
      lookupClosure: lookup,
    });
    assert.deepEqual(result[0]?.reasons, ['unverified_30d']);
    assert.equal(warnings.length, 1);
    assert.equal(calls, 1);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});
