import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import {
  buildBrief,
  briefCachePath,
  readCachedBrief,
  refreshBrief,
  parseBriefArguments,
  runBriefCli,
} from './brief.js';

const scope = { project: 'example/catalog', host: 'claude-code', role: 'lead' };
const verified = '2026-10-01T12:00:00.000Z';
const fixture = (index: number, audience = ['all']) => ({
  id: index,
  project: scope.project,
  memoryKey: `rule/${String(index).padStart(2, '0')}`,
  content: `Synthetic standing rule number ${String(index)}.`,
  category: 'convention',
  pinned: true,
  audience,
  status: 'active',
  importance: index / 100,
  lastVerifiedAt: verified,
  updatedAt: verified,
  evidenceRefs: [`https://example.com/rules/${String(index)}`],
});

test('40 pinned fixtures select exact project and matching audiences in stable priority order with role state first', () => {
  const memories = Array.from({ length: 40 }, (_, i) =>
    fixture(i, [['all'], ['lead'], ['claude-code'], ['worker'], ['codex']][i % 5]),
  );
  memories.push({ ...fixture(99), memoryKey: 'state/lead', category: 'state', pinned: false });
  memories.push({ ...fixture(98), project: 'other/catalog' }, { ...fixture(97), status: 'archived' });
  const text = buildBrief(scope, memories);
  assert.equal(text, buildBrief(scope, [...memories].reverse()));
  assert.ok(text.length <= 7500);
  const lines = text.split('\n').filter(line => line.startsWith('- '));
  assert.match(lines[0]!, /state\/lead.*updated 2026-10-01T12:00:00.000Z/u);
  for (let i = 0; i < 40; i += 1) {
    const key = `rule/${String(i).padStart(2, '0')}`;
    assert.equal(text.includes(`[${key}]`), i % 5 < 3);
  }
  assert.match(text, /verified 2026-10-01T12:00:00.000Z.*https:\/\/example.com\/rules\//u);
  assert.doesNotMatch(text, /rule\/9[78]/u);
});

test('budget drops complete low priority items and reports searchable omissions, including one oversized item', () => {
  const text = buildBrief(scope, [{ ...fixture(1), content: 'LOW'.repeat(3000) }, fixture(2), fixture(3)]);
  assert.ok(text.length <= 7500);
  assert.doesNotMatch(text, /LOW/u);
  assert.match(text, /rule\/03/u);
  assert.match(text, /1 items omitted.*memory_search/u);
});

test('cache is atomic, isolated by project/host/role and retains generation time on a failed database refresh', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brief-cache-'));
  try {
    const now = () => new Date(verified);
    const text = await refreshBrief(scope, { cacheDir: directory, now, load: () => Promise.resolve([fixture(1)]) });
    const cached = await readCachedBrief(scope, directory);
    assert.equal(cached?.text, text);
    assert.equal(cached?.generatedAt, verified);
    for (const other of [
      { ...scope, role: 'worker' },
      { ...scope, host: 'codex' },
      { ...scope, project: 'other/catalog' },
    ]) {
      assert.equal(await readCachedBrief(other, directory), undefined);
      assert.notEqual(briefCachePath(scope, directory), briefCachePath(other, directory));
    }
    await assert.rejects(
      refreshBrief(scope, { cacheDir: directory, load: () => Promise.reject(new Error('database down')) }),
    );
    assert.deepEqual(await readCachedBrief(scope, directory), cached);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI prints or writes the same brief and rejects incomplete or ambiguous scopes', async () => {
  assert.deepEqual(
    parseBriefArguments(['--project', scope.project, '--host', scope.host, '--role', scope.role]),
    scope,
  );
  for (const args of [
    [],
    ['--project', scope.project],
    ['--project', scope.project, '--host', 'unknown', '--role', 'lead'],
  ]) {
    assert.throws(() => parseBriefArguments(args));
  }
  const directory = await mkdtemp(join(tmpdir(), 'brief-cli-'));
  try {
    const out = join(directory, 'brief.md');
    let stdout = '';
    const text = buildBrief(scope, [fixture(1)]);
    const dependencies = {
      refresh: () => Promise.resolve(text),
      write: (value: string) => {
        stdout += value;
      },
    };
    const args = ['--project', scope.project, '--host', scope.host, '--role', scope.role];
    await runBriefCli(args, dependencies);
    assert.equal(stdout, `${text}\n`);
    await runBriefCli([...args, '--out', out], dependencies);
    assert.equal(await readFile(out, 'utf8'), `${text}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('project-qualified role state wins over legacy state and stays isolated between projects', () => {
  const projectA = { ...scope, project: 'synthetic/a' };
  const projectB = { ...scope, project: 'synthetic/b' };
  const states = [
    {
      ...fixture(1),
      project: projectA.project,
      category: 'state',
      pinned: false,
      memoryKey: 'synthetic/a:state/lead',
      content: 'Canonical project A state.',
    },
    {
      ...fixture(2),
      project: projectB.project,
      category: 'state',
      pinned: false,
      memoryKey: 'synthetic/b:state/lead',
      content: 'Canonical project B state.',
    },
    {
      ...fixture(3),
      project: projectA.project,
      category: 'state',
      pinned: false,
      memoryKey: 'state/lead',
      content: 'Old legacy state.',
    },
  ];
  const textA = buildBrief(projectA, states);
  assert.match(textA, /Canonical project A state\./u);
  assert.doesNotMatch(textA, /Canonical project B|Old legacy/u);
  assert.match(buildBrief(projectB, states), /Canonical project B state\./u);
  assert.match(buildBrief(projectA, [states[2]!]), /Old legacy state\./u);
});
