import assert from 'node:assert/strict';
import { test } from 'vitest';

import { buildProjectScopeBackfillPlan, parseBackfillNativeRow } from './project-scope-backfill.js';
import { storeMemoryWithClient } from './memory-store.js';

const selectors = { legacyProject: 'widget', limit: 200, project: 'demo-workshop/widget' };
const identity = { code: 'a'.repeat(64), namespace: 'synthetic/public', schema: 'b'.repeat(64) };
const memory = {
  category: 'architecture',
  content: 'Keep stable identifiers for caller references.',
  dedupe_hash: null,
  id: '1',
  memory_key: 'fact:architecture',
  project: 'widget',
  repo_id: null,
  repo_slug: 'demo-workshop/widget',
  session_id: 'Host-Session',
  source: 'codex',
  status: 'active',
};
const session = {
  agent: 'codex',
  repo_id: 'widget',
  repo_slug: 'demo-workshop/widget',
  session_id: 'Host-Session',
  task_id: 'logical:task',
};
const pack = {
  pack_json: { provenance: { scope: { id: 'logical:task', type: 'task' }, sessionId: 'Host-Session' } },
  project: 'widget',
  scope_key: 'task:widget:logical:task',
  session_id: 'Host-Session',
  source: 'codex',
};

test('native JSON numeric states must survive exact decimal round trips before fingerprinting', () => {
  for (const numeric of ['9007199254740993', '0.10000000000000001', '1e400', '1e-400'])
    assert.throws(
      () => parseBackfillNativeRow(`{"metadata_json":{"counter":${numeric}}}`),
      /native_numeric_precision/u,
    );
  assert.deepEqual(
    parseBackfillNativeRow('{"metadata_json":{"counter":9007199254740992,"confidence":0.9,"scaled":1.000}}'),
    { metadata_json: { counter: 9007199254740992, confidence: 0.9, scaled: 1 } },
  );
});

test('a verified unit moves scope projections while preserving durable keys and native identities', () => {
  const plan = buildProjectScopeBackfillPlan({
    data: { memories: [memory], packs: [pack], sessions: [session] },
    identity,
    selectors,
  });
  assert.equal(plan.status, 'ready');
  assert.deepEqual(
    plan.changes.map(change => [change.table, change.id, change.to]),
    [
      ['memory', '1', { dedupe_hash: null, project: 'demo-workshop/widget' }],
      ['session', 'Host-Session', { repo_id: 'demo-workshop/widget' }],
      [
        'continuity',
        'task:widget:logical:task',
        { project: 'demo-workshop/widget', scope_key: 'task:demo-workshop/widget:logical:task' },
      ],
    ],
  );
  assert.deepEqual(plan.anchor, { id: 'Host-Session', kind: 'session' });
  assert.equal(JSON.stringify(plan).includes(memory.content), false);
  assert.equal(memory.project, 'widget');
  assert.equal(memory.memory_key, 'fact:architecture');
  assert.equal(session.task_id, 'logical:task');
});

test('a bare target selector alone does not verify unknown or foreign same-basename memories', () => {
  const plan = buildProjectScopeBackfillPlan({
    data: {
      memories: [
        { ...memory, repo_slug: null, session_id: null },
        { ...memory, id: '2', repo_slug: 'another/widget', session_id: null },
      ],
      packs: [],
      sessions: [],
    },
    identity,
    selectors,
  });
  assert.equal(plan.status, 'empty');
  assert.deepEqual(plan.changes, []);
  assert.equal(plan.counts.unknown, 1);
  assert.equal(plan.counts.foreign, 1);
});

test('an occupied continuity target refuses the whole unit without choosing a newer payload', () => {
  const plan = buildProjectScopeBackfillPlan({
    data: {
      memories: [memory],
      packs: [pack, { ...pack, project: selectors.project, scope_key: 'task:demo-workshop/widget:logical:task' }],
      sessions: [session],
    },
    identity,
    selectors,
  });
  assert.equal(plan.status, 'refused');
  assert.ok(plan.refusals.some(reason => reason.code === 'continuity_collision'));
});

test('a verified session containing contradictory repository evidence refuses its complete unit', () => {
  const plan = buildProjectScopeBackfillPlan({
    data: {
      memories: [memory, { ...memory, id: '2', repo_slug: 'another/widget' }],
      packs: [],
      sessions: [session],
    },
    identity,
    selectors,
  });
  assert.equal(plan.status, 'refused');
  assert.ok(plan.refusals.some(reason => reason.code === 'session_conflict'));
});

test('one memory assertion never becomes session authority for an unknown sibling or pack', () => {
  const plan = buildProjectScopeBackfillPlan({
    data: {
      memories: [memory, { ...memory, id: '2', memory_key: 'fact:unknown', repo_slug: null }],
      packs: [pack],
      sessions: [{ ...session, repo_slug: null }],
    },
    identity,
    selectors,
  });
  assert.equal(plan.status, 'ready');
  assert.deepEqual(
    plan.changes.map(change => [change.table, change.id]),
    [['memory', '1']],
  );
  assert.equal(plan.counts.unknown, 2);
  assert.deepEqual(plan.anchor, { id: '1', kind: 'memory' });
});

test('mixed sessionless repository claims refuse a unit instead of being skipped as foreign', () => {
  const plan = buildProjectScopeBackfillPlan({
    data: {
      memories: [
        { ...memory, session_id: null },
        { ...memory, id: '2', repo_id: 'foreign.example/other/widget', session_id: null },
      ],
      packs: [],
      sessions: [],
    },
    identity,
    selectors,
  });
  assert.equal(plan.status, 'refused');
  assert.ok(plan.refusals.some(reason => reason.code === 'repository_conflict'));
});

test('a contradictory continuity project in the exact session refuses all projected changes', () => {
  const plan = buildProjectScopeBackfillPlan({
    data: {
      memories: [memory],
      packs: [{ ...pack, project: 'other/widget', scope_key: 'task:other/widget:logical:task' }],
      sessions: [session],
    },
    identity,
    selectors,
  });
  assert.equal(plan.status, 'refused');
  assert.ok(plan.refusals.some(reason => reason.code === 'session_conflict'));
});

test('exact-session planning never admits another session as a mutation candidate', () => {
  const plan = buildProjectScopeBackfillPlan({
    data: {
      memories: [memory, { ...memory, id: '2', session_id: 'Other-Session' }],
      packs: [pack, { ...pack, scope_key: 'task:widget:other', session_id: 'Other-Session' }],
      sessions: [session, { ...session, session_id: 'Other-Session' }],
    },
    identity,
    selectors: { ...selectors, sessionId: 'Host-Session' },
  });
  assert.equal(plan.status, 'ready');
  assert.deepEqual(
    plan.changes.map(change => change.id),
    ['1', 'Host-Session', pack.scope_key],
  );
  assert.equal(plan.observations.length, 6);
});

test('collision-only observations remain ineligible while still refusing an occupied canonical key', () => {
  const candidate = { ...memory, id: '2', session_id: null };
  const initial = buildProjectScopeBackfillPlan({
    data: { memories: [memory], packs: [], sessions: [] },
    identity,
    selectors,
  });
  const occupiedKey = initial.changes[0]!.prospectiveKey;
  const data = {
    memories: [memory, candidate],
    packs: [],
    sessions: [],
    collisionOnly: { memoryIds: ['2'], packKeys: [] },
  };
  const ready = buildProjectScopeBackfillPlan({ data, identity, selectors });
  assert.deepEqual(
    ready.changes.map(change => change.id),
    ['1'],
  );
  const refused = buildProjectScopeBackfillPlan({
    data: { ...data, memories: [memory, { ...candidate, memory_key: occupiedKey }] },
    identity,
    selectors,
  });
  assert.equal(refused.status, 'refused');
  assert.ok(refused.refusals.some(reason => reason.code === 'key_collision'));
});

test('session-assisted store refuses each foreign raw claim before attempting a memory write', async () => {
  for (const claims of [
    { repoId: 'foreign.example/other/widget' },
    { repoSlug: 'foreign.example/other/widget' },
    { repoId: 'opaque-native-id', repoSlug: 'foreign.example/other/widget' },
  ]) {
    let writes = 0;
    const client: Parameters<typeof storeMemoryWithClient>[0] = {
      async query(sql: string) {
        if (sql.includes('SELECT repo_id, repo_slug FROM ai_sessions'))
          return { rowCount: 1, rows: [{ repo_id: 'demo-workshop/widget', repo_slug: null }] as never[] };
        if (/^\s*(INSERT|UPDATE|DELETE)\b/u.test(sql)) {
          writes++;
          throw new Error('Unexpected memory write before repository conflict refusal');
        }
        return { rowCount: 0, rows: [] };
      },
    };
    await assert.rejects(
      () =>
        storeMemoryWithClient(client, {
          ...claims,
          category: 'decision',
          content: 'Preserve the original foreign repository assertion.',
          memoryKey: 'fact:foreign',
          project: 'widget',
          sessionId: 'Host-Session',
        }),
      /Conflicting repository/u,
    );
    assert.equal(writes, 0);
  }
});
