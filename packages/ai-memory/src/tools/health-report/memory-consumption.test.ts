import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildMemoryConsumptionMetrics } from './data.js';

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
