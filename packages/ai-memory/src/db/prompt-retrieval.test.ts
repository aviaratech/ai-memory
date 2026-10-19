import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { afterEach, test } from 'vitest';

import {
  armPromptRetrieval,
  buildSummaryJson,
  consumePromptRetrieval,
  recordMemoryConsumption,
} from './tool-invocations.js';
import { mockPoolConnect } from './test-pool-mock.js';

afterEach(() => {
  mock.restoreAll();
});

const identity = { host: 'codex' as const, project: 'example/catalog', sessionId: 'session-a' };

test('use telemetry persists only IDs previously injected into the same identity', async () => {
  const inserts: unknown[][] = [];
  mockPoolConnect((sql, params) => {
    if (sql.includes('INSERT INTO ai_tool_invocations')) inserts.push([...(params ?? [])]);
    return Promise.resolve({
      command: 'SELECT',
      fields: [],
      oid: 0,
      rowCount: 1,
      rows: sql.includes('SELECT')
        ? [{ injected_memory_ids: '[41]', memory_observed_at: '2026-10-18T00:00:00.000Z' }]
        : [],
    });
  });
  await recordMemoryConsumption({
    ...identity,
    kind: 'used',
    memoryIds: [41, 99],
    observation: 'get',
    observedAt: '2026-10-18T01:00:00.000Z',
  });
  assert.equal(inserts.length, 1);
  const summary = JSON.parse(String(inserts[0]?.[13])) as { used_memory_ids: string };
  assert.equal(summary.used_memory_ids, '[41]');
});

test('only the atomic pending-to-consumed result authorizes prompt retrieval', async () => {
  for (const disposition of ['unarmed', 'consumed', undefined]) {
    const queries: { sql: string; params: readonly unknown[] }[] = [];
    mockPoolConnect((sql, params) => {
      queries.push({ params: params ?? [], sql });
      return Promise.resolve({
        command: 'INSERT',
        fields: [],
        oid: 0,
        rowCount: disposition === undefined ? 0 : 1,
        rows: disposition === undefined ? [] : [{ write_disposition: disposition }],
      });
    });
    assert.equal(await consumePromptRetrieval(identity), disposition === 'consumed');
    const query = queries.find(q => q.sql.includes('INSERT INTO ai_tool_invocations'));
    assert.ok(query);
    assert.match(query.sql, /ON CONFLICT \(invocation_id\) WHERE invocation_id IS NOT NULL/u);
    assert.match(query.sql, /write_disposition = 'pending'/u);
    assert.match(query.sql, /RETURNING write_disposition/u);
    assert.ok(!JSON.stringify(query.params).includes('prompt text'));
    mock.restoreAll();
  }
});

test('startup marker insertion never rearms an existing marker', async () => {
  const queries: string[] = [];
  mockPoolConnect(sql => {
    queries.push(sql);
    return Promise.resolve({ command: 'INSERT', fields: [], oid: 0, rowCount: 0, rows: [] });
  });
  await armPromptRetrieval(identity);
  const sql = queries.find(q => q.includes('INSERT INTO ai_tool_invocations'));
  assert.ok(sql);
  assert.match(sql, /DO NOTHING/u);
  assert.ok(!sql.includes('DO UPDATE'));
});

test('consumption metadata validates numeric IDs and finite harness labels at the redaction owner', () => {
  assert.deepEqual(buildSummaryJson({ memory_host: 'codex', injected_memory_ids: '[2,2,5]', used_memory_ids: '[5]' }), {
    memory_host: 'codex',
    injected_memory_ids: '[2,5]',
    used_memory_ids: '[5]',
  });
  for (const bad of ['["private prompt"]', '[0,-1,1.5]', '[9007199254740992]', 'secret']) {
    assert.deepEqual(
      buildSummaryJson({ injected_memory_ids: bad, used_memory_ids: bad, memory_host: 'private-host' }),
      {},
    );
  }
});
