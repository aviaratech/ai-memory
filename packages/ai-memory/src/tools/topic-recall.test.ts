import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import type { DbClient, DbPool, DbResult } from '../db/pool.js';
import { refreshBrief } from './brief.js';
import { recallTopic } from './topic-recall.js';

const project = 'example/catalog';
const context = { host: 'codex', role: 'owner' };
function database(query: DbClient['query']): DbPool {
  const client = { query, release() {} };
  return {
    connect: () => Promise.resolve(client),
    getClient: () => Promise.resolve(client),
    query,
    end: () => Promise.resolve(),
  };
}
const row = (id: number, rank: number) => ({
  id,
  project,
  status: 'active',
  memory_key: `rule/${String(id)}`,
  category: 'convention',
  content: `Use the catalog release rules for every verified change ${String(id)}.`,
  semantic_relevance: rank,
  or_semantic_relevance: rank,
  confidence: 0.9,
  evidence_refs: ['CONTRIBUTING.md'],
  last_verified_at: new Date('2026-10-22T00:00:00Z'),
});

test('topic recall uses the index path, ranks synthetic rows and caps active keyed results at five', async () => {
  const queries: { sql: string; params: unknown[] | undefined }[] = [];
  const db = database(async <T>(sql: string, params?: unknown[]): Promise<DbResult<T>> => {
    queries.push({ sql, params });
    const rows = sql.includes('candidate_features')
      ? [row(1, 0.01), ...Array.from({ length: 6 }, (_, i) => row(i + 2, 1))]
      : [];
    return { rows: rows as T[], rowCount: rows.length };
  });
  const result = await recallTopic(
    { project, topic: 'catalog release rules', limit: 50 },
    { ...context, database: db },
  );
  assert.equal(result.status, 'ok');
  assert.equal(result.memories.length, 5);
  assert.ok(!result.memories.some(memory => memory.id === 1));
  assert.equal(result.memories[0]?.lastVerifiedAt, '2026-10-22T00:00:00.000Z');
  assert.deepEqual(result.memories[0]?.evidenceRefs, ['CONTRIBUTING.md']);
  assert.match(result.memories[0]?.excerpt ?? '', /catalog release rules/u);
  assert.equal(result.memories[0]?.key, `rule/${String(result.memories[0]?.id)}`);
  const statement = queries.find(query => query.sql.includes('candidate_features'));
  assert.ok(statement);
  assert.ok(statement.sql.includes("status = 'active'"));
  assert.ok(statement.sql.includes('memory_key IS NOT NULL'));
  assert.ok(statement.params?.includes(project));
});

test('topic recall fails closed on missing project before any database access', async () => {
  let accessed = false;
  const db = database(() => {
    accessed = true;
    throw new Error('must not query');
  });
  await assert.rejects(recallTopic({ topic: 'release' }, { ...context, database: db }), /project.*required/u);
  assert.equal(accessed, false);
});

test('a failed or slow pool returns only the exact project, host and role cached brief', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'topic-brief-'));
  try {
    const scope = { project, ...context };
    const text = await refreshBrief(scope, {
      cacheDir,
      load: () =>
        Promise.resolve([
          {
            ...row(9, 1),
            memoryKey: 'rule/9',
            pinned: true,
            audience: ['owner'],
            content: 'Use the scoped catalog rule for every verified change.',
          },
        ]),
    });
    for (const slow of [false, true]) {
      let released = false;
      const db = database(() => (slow ? new Promise(() => {}) : Promise.reject(new Error('private database failure'))));
      db.connect = async () => ({
        query: <T>(sql: string, params?: unknown[]) => db.query<T>(sql, params),
        release: error => {
          released = error === true;
        },
      });
      const started = Date.now();
      const result = await recallTopic({ project, topic: 'release' }, { ...context, database: db, cacheDir });
      assert.equal(result.status, 'degraded');
      assert.equal(result.brief, text);
      assert.deepEqual(result.memories, []);
      assert.ok(Date.now() - started < 1500);
      assert.ok(!JSON.stringify(result).includes('private database failure'));
      if (slow) assert.equal(released, true);
    }
    for (const other of [
      { project: 'other/catalog', ...context },
      { project, ...context, role: 'lead' },
      { project, ...context, host: 'claude-code' },
    ]) {
      const result = await recallTopic(
        { project: other.project, topic: 'release' },
        { ...other, database: database(() => Promise.reject(new Error('down'))), cacheDir },
      );
      assert.equal(result.status, 'degraded');
      assert.ok(!result.brief.includes('Use the scoped catalog rule'));
    }
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});
