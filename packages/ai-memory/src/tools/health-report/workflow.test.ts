import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import type { DbPool, DbResult } from '../../db/pool.js';
import { collectWorkflowReport, renderWorkflowReport } from './workflow.js';

const query = {
  projectId: `sha256:${'a'.repeat(64)}`,
  taskId: 'task-1',
  windowStartIso: '2026-01-01T00:00:00.000Z',
  windowEndIso: '2026-01-08T00:00:00.000Z',
  limit: 20,
  timeoutMs: 5000,
};
const metric = (total: string | null, observedSamples = '2', missingSamples = '1') => ({
  total,
  observedSamples,
  missingSamples,
});

function fixture(overrides: Record<string, unknown> = {}) {
  const data = {
    totals: {
      inputTokens: metric('300'),
      cachedInputTokens: metric('130'),
      cacheWriteInputTokens: metric('30'),
      nonReadInputTokens: metric('170'),
      ordinaryInputTokens: metric('140'),
      outputTokens: metric('60'),
      reasoningOutputTokens: metric('15'),
      executionMs: metric('30000', '1', '4'),
      queueMs: metric('5000', '1', '4'),
    },
    groups: [
      {
        dimension: 'stage',
        key: 'verify',
        samples: '2',
        failures: '2',
        metrics: {},
        evidenceIds: ['proof-failure'],
        omittedEvidenceIds: '0',
      },
    ],
    omittedGroups: '0',
    coverage: {
      events: '8',
      usageObservations: '3',
      knownUsageObservations: '2',
      unknownUsageObservations: '1',
      hostObservations: '0',
      invocationOnlyObservations: '0',
      uniqueHostTurns: null,
      observationsWithoutTime: '8',
      ambiguousSessions: '0',
    },
    outcomeReferences: [
      {
        producer: 'fixture',
        eventId: 'accepted-1',
        edge: 'accepted',
        stage: 'verify',
        relatedStage: 'verify',
        relatedEvent: { producer: 'fixture', eventId: 'corrected-1' },
        resolved: true,
        evidenceIds: ['proof-accepted'],
      },
    ],
    omittedOutcomeReferences: '0',
    evidenceIds: ['proof-failure', 'proof-accepted'],
    omittedEvidenceIds: '0',
    ...overrides,
  };
  const canonical = {
    invocations: '0',
    errors: '0',
    durationMs: metric(null, '0', '0'),
    packPayloadChars: metric(null, '0', '0'),
    packProjectionChars: metric(null, '0', '0'),
    projectionTruncation: { observedSamples: '0', missingSamples: '0', truncatedSamples: '0' },
    groups: [],
    omittedGroups: '0',
    invocationIds: [],
    omittedInvocationIds: '0',
    unattributedRows: '0',
  };
  const calls: { sql: string; params: unknown[] }[] = [];
  let released = 0;
  const client = {
    release() {
      released++;
    },
    async query<T>(sql: string, params: unknown[] = []): Promise<DbResult<T>> {
      calls.push({ sql, params });
      return {
        rowCount: 1,
        rows: (sql.includes('WITH target_sessions')
          ? [{ data: sql.includes('ai_tool_invocations') ? canonical : data }]
          : []) as T[],
      };
    },
  };
  const pool: DbPool = {
    connect: async () => client,
    getClient: async () => client,
    query: (sql, params) => client.query(sql, params),
    end: async () => {
      throw new Error('caller-owned');
    },
  };
  return { pool, calls, released: () => released };
}

test('report renders observed token subsets with missing coverage and producer-reported outcome evidence', async () => {
  const f = fixture();
  const report = await collectWorkflowReport(query, f.pool);
  const text = renderWorkflowReport(report);
  assert.match(text, /inputTokens: 300 \(2 observed, 1 missing\)/u);
  assert.match(text, /cachedInputTokens: 130/u);
  assert.match(text, /nonReadInputTokens: 170/u);
  assert.match(text, /ordinaryInputTokens: 140/u);
  assert.match(text, /reasoningOutputTokens: 15/u);
  assert.match(text, /executionMs: 30000/u);
  assert.match(text, /queueMs: 5000/u);
  assert.match(text, /producer-reported/u);
  assert.match(text, /proof-accepted/u);
  assert.match(text, /incomplete/u);
  assert.ok(report.hypotheses.length > 0);
  assert.deepEqual(report.hypotheses[0]?.evidenceIds, ['proof-failure']);
  assert.equal(f.calls.filter(c => c.sql === 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY').length, 1);
  assert.equal(f.calls.at(-1)?.sql, 'COMMIT');
  for (const call of f.calls.filter(c => c.sql.includes('WITH target_sessions')))
    assert.deepEqual(call.params.slice(0, 4), [
      query.projectId,
      query.taskId,
      query.windowStartIso,
      query.windowEndIso,
    ]);
  assert.equal(f.released(), 1);
});

test('stage hypotheses never attach unrelated stage outcomes', async () => {
  const f = fixture({
    outcomeReferences: [
      {
        producer: 'fixture',
        eventId: 'unrelated-accepted',
        edge: 'accepted',
        stage: 'other',
        relatedStage: 'other',
        relatedEvent: { producer: 'fixture', eventId: 'other-correction' },
        resolved: true,
        evidenceIds: ['other-proof'],
      },
    ],
  });
  assert.deepEqual((await collectWorkflowReport(query, f.pool)).hypotheses[0]?.outcomeEventIds, []);
});

test('rendering preserves exact large decimal totals and known zero separately from UNKNOWN', async () => {
  const f = fixture({
    totals: {
      inputTokens: metric('90071992547409930'),
      cachedInputTokens: metric('0', '1', '2'),
      ordinaryInputTokens: metric(null, '0', '3'),
    },
  });
  const text = renderWorkflowReport(await collectWorkflowReport(query, f.pool));
  assert.match(text, /90071992547409930/u);
  assert.match(text, /cachedInputTokens: 0 \(1 observed, 2 missing\)/u);
  assert.match(text, /ordinaryInputTokens: UNKNOWN \(0 observed, 3 missing\)/u);
});

test('bounded report exposes omitted groups/evidence and rejects oversized serialization with a fixed error', async () => {
  const f = fixture({ omittedGroups: '4', omittedEvidenceIds: '7' });
  const report = await collectWorkflowReport(query, f.pool);
  assert.match(renderWorkflowReport(report), /omitted groups: 4/u);
  assert.match(renderWorkflowReport(report), /omitted evidence IDs: 7/u);
  assert.throws(() => renderWorkflowReport({ ...report, evidenceIds: ['x'.repeat(256 * 1024)] }), /report_oversized/u);
});

test('health workflow dispatch validates scope before legacy collectors or database configuration', async () => {
  const legacy = await import('./data.js');
  const collector = vi.spyOn(legacy, 'collectOrchestrationMetrics').mockImplementation(() => {
    throw new Error('legacy collector called');
  });
  const database = vi.spyOn(legacy, 'collectDatabaseMetrics').mockImplementation(() => {
    throw new Error('legacy database collector called');
  });
  const previousExitCode = process.exitCode;
  let stderr = '';
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
    stderr += String(chunk);
    return true;
  });
  try {
    const { main } = await import('../health-report.js');
    await main(['--workflow', '--project', 'invalid', '--task', 'task-1', '--json']);
    assert.equal(stderr, 'invalid_workflow_scope\n');
    assert.equal(process.exitCode, 1);
    assert.equal(collector.mock.calls.length, 0);
    assert.equal(database.mock.calls.length, 0);
  } finally {
    collector.mockRestore();
    database.mockRestore();
    write.mockRestore();
    process.exitCode = previousExitCode;
  }
});
