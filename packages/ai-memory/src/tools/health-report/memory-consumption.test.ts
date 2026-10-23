import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildMemoryConsumptionMetrics, collectMemoryConsumptionMetrics } from './data.js';
import type { DbPool } from '../../db/pool.js';

const end = '2026-10-19T12:00:00.000Z';
const injection = {
  tool_name: 'memory_injected',
  created_at: '2026-10-18T00:00:00.000Z',
  memory_observed_at: '2026-10-18T00:00:00.000Z',
  session_id: 'session-a',
  project: 'example/catalog',
  memory_host: 'codex',
  injected_memory_ids: '[41,42]',
  used_memory_ids: '',
  memory_observation: 'prompt',
};
const use = {
  ...injection,
  tool_name: 'memory_used',
  created_at: '2026-10-18T01:00:00.000Z',
  memory_observed_at: '2026-10-18T01:00:00.000Z',
  injected_memory_ids: '',
  used_memory_ids: '[41]',
  memory_observation: 'get',
};

test('seven-day per-host cohort deduplicates injections and intersects later use in the exact session/project/host', () => {
  const report = buildMemoryConsumptionMetrics(
    [
      injection,
      injection,
      use,
      use,
      { ...use, session_id: 'foreign', used_memory_ids: '[42]' },
      { ...use, project: 'other/catalog', used_memory_ids: '[42]' },
      { ...use, memory_host: 'claude-code', used_memory_ids: '[42]' },
      { ...use, memory_observed_at: '2026-10-17T01:00:00.000Z', used_memory_ids: '[42]' },
      { ...use, memory_observed_at: '2026-10-20T01:00:00.000Z', used_memory_ids: '[42]' },
      { ...injection, memory_observed_at: '2026-10-01T00:00:00.000Z', injected_memory_ids: '[43]' },
    ],
    end,
  );
  assert.deepEqual(report.hosts, [
    { host: 'codex', injectedCount: 2, usedCount: 1, useRatePct: 50, coverage: 'partial' },
  ]);
  assert.equal(report.window.days, 7);
  assert.equal(report.status, 'partial');
});

test('missing use observations do not become a measured zero-use rate; zero denominator and database failure remain explicit', () => {
  const report = buildMemoryConsumptionMetrics([injection], end);
  assert.equal(report.hosts[0]?.useRatePct, null);
  assert.equal(report.hosts[0]?.coverage, 'unobserved');
  assert.deepEqual(buildMemoryConsumptionMetrics([], end).hosts, []);
  assert.equal(buildMemoryConsumptionMetrics(undefined, end).status, 'unavailable');
});

test('historical or timestamp-free citations are not re-dated by ingestion time', () => {
  for (const memory_observed_at of ['', '2026-10-01T00:00:00.000Z']) {
    const report = buildMemoryConsumptionMetrics(
      [injection, { ...use, memory_observation: 'citation', memory_observed_at }],
      end,
    );
    assert.equal(report.hosts[0]?.usedCount, 0);
    assert.equal(report.hosts[0]?.useRatePct, null);
  }
});

test('use recorded before injection does not establish later observation coverage', () => {
  const report = buildMemoryConsumptionMetrics(
    [injection, { ...use, memory_observed_at: '2026-10-17T01:00:00.000Z' }],
    end,
  );
  assert.equal(report.hosts[0]?.useRatePct, null);
});

test('per-key 7/30 day cohorts preserve project identity, last use and zero-use pinned candidates', () => {
  const report = buildMemoryConsumptionMetrics(
    [
      injection,
      injection,
      use,
      use,
      {
        ...injection,
        session_id: 'older',
        created_at: '2026-10-01T00:00:00.000Z',
        memory_observed_at: '2026-10-01T00:00:00.000Z',
        injected_memory_ids: '[41]',
      },
      {
        ...use,
        session_id: 'older',
        created_at: '2026-10-02T00:00:00.000Z',
        memory_observed_at: '2026-10-02T00:00:00.000Z',
      },
      { ...use, project: 'other/catalog', used_memory_ids: '[42]' },
      { ...use, memory_observed_at: '', used_memory_ids: '[42]' },
    ],
    end,
    [
      { id: 41, project: 'example/catalog', memoryKey: 'example/catalog:rule', pinned: true },
      { id: 42, project: 'example/catalog', memoryKey: 'example/catalog:unused', pinned: true },
      { id: 43, project: 'other/catalog', memoryKey: 'other/catalog:unused', pinned: true },
      { id: 44, project: 'example/catalog', memoryKey: 'example/catalog:ordinary', pinned: false },
    ],
  );
  const item = report.items.find(row => row.memoryKey === 'example/catalog:rule');
  assert.deepEqual(item?.windows, [
    { days: 7, injectedCount: 1, usedCount: 1, lastUsedAt: '2026-10-18T01:00:00.000Z' },
    { days: 30, injectedCount: 2, usedCount: 2, lastUsedAt: '2026-10-18T01:00:00.000Z' },
  ]);
  assert.deepEqual(report.pruneCandidates, [
    { project: 'example/catalog', memoryKey: 'example/catalog:unused' },
    { project: 'other/catalog', memoryKey: 'other/catalog:unused' },
  ]);
  assert.equal(buildMemoryConsumptionMetrics(undefined, end).pruneCandidates.length, 0);
});

test('a repeated injection in the same session enters each window independently', () => {
  const report = buildMemoryConsumptionMetrics(
    [
      { ...injection, created_at: '2026-10-01T00:00:00.000Z', memory_observed_at: '2026-10-01T00:00:00.000Z' },
      injection,
      use,
    ],
    end,
    [{ id: 41, project: 'example/catalog', memoryKey: 'example/catalog:rule', pinned: true }],
  );
  assert.deepEqual(report.items[0]?.windows, [
    { days: 7, injectedCount: 1, usedCount: 1, lastUsedAt: '2026-10-18T01:00:00.000Z' },
    { days: 30, injectedCount: 1, usedCount: 1, lastUsedAt: '2026-10-18T01:00:00.000Z' },
  ]);
});

test('the collector resolves PostgreSQL bigint IDs and requests the full 30-day telemetry window', async () => {
  const pool = {
    query: (sql: string, parameters: string[]) => {
      if (sql.includes('FROM ai_tool_invocations')) {
        assert.deepEqual(parameters, ['2026-09-19T12:00:00.000Z', end]);
        return Promise.resolve({ rows: [injection, use] });
      }
      assert.deepEqual(parameters, [end]);
      return Promise.resolve({
        rows: [{ id: '41', project: 'example/catalog', memory_key: 'example/catalog:rule', pinned: true }],
      });
    },
  } as unknown as DbPool;
  const report = await collectMemoryConsumptionMetrics({ pool, windowEndIso: end });
  assert.equal(report.status, 'partial');
  assert.deepEqual(report.items[0]?.windows, [
    { days: 7, injectedCount: 1, usedCount: 1, lastUsedAt: '2026-10-18T01:00:00.000Z' },
    { days: 30, injectedCount: 1, usedCount: 1, lastUsedAt: '2026-10-18T01:00:00.000Z' },
  ]);
  assert.deepEqual(report.pruneCandidates, []);
});
