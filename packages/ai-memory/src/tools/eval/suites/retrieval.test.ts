import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'vitest';

import { runRetrievalSuite } from './retrieval.js';

test('runRetrievalSuite returns skip when retrieval fixtures are missing', async () => {
  const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'ai-memory-retrieval-fixtures-missing-'));

  try {
    const report = await runRetrievalSuite({ fixturesRoot: fixtureRoot });
    assert.equal(report.suite, 'retrieval');
    assert.equal(report.failed, 0);
    assert.equal(report.passed, 0);
    assert.equal(report.skipped, 1);
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

test('runRetrievalSuite computes aggregate retrieval metrics for known query results', async () => {
  const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'ai-memory-retrieval-fixtures-known-'));
  const retrievalDir = resolve(fixtureRoot, 'retrieval');
  mkdirSync(retrievalDir, { recursive: true });
  writeFileSync(
    resolve(retrievalDir, 'known.json'),
    JSON.stringify(
      {
        memories: [
          {
            category: 'convention',
            confidence: 0.8,
            content: 'Known fixture memory one for retrieval metrics.',
            memoryKey: 'm1',
            tags: ['t1'],
          },
          {
            category: 'convention',
            confidence: 0.8,
            content: 'Known fixture memory two for retrieval metrics.',
            memoryKey: 'm2',
            tags: ['t2'],
          },
        ],
        queries: [
          {
            expectedEvidenceRefs: ['https://github.com/example/catalog/issues/2930'],
            expectedSource: 'codex-session-end',
            expectedTopK: ['m1'],
            k: 2,
            query: 'query-one',
          },
          {
            expectedTopK: ['m2'],
            k: 2,
            query: 'query-two',
          },
          {
            expectedEvidenceRefs: ['https://github.com/example/catalog/issues/2930'],
            expectedSource: 'codex-session-end',
            expectedTopK: ['m1'],
            k: 2,
            query: 'query-attribution-must-bind',
          },
        ],
      },
      null,
      2,
    ),
  );

  try {
    const report = await runRetrievalSuite({
      dependencies: {
        cleanupProjectEntries: () => Promise.resolve(undefined),
        searchMemories: input => {
          const request = input as { query?: string };
          if (request.query === 'query-one') {
            return Promise.resolve([
              {
                evidenceRefs: ['https://github.com/example/catalog/issues/2930'],
                memoryKey: 'm1',
                source: 'codex-session-end',
              },
              { memoryKey: 'noise' },
            ] as unknown[]);
          }
          if (request.query === 'query-two') {
            return Promise.resolve([{ memoryKey: 'noise' }, { memoryKey: 'm2' }] as unknown[]);
          }
          if (request.query === 'query-attribution-must-bind') {
            return Promise.resolve([
              { memoryKey: 'm1' },
              {
                evidenceRefs: ['https://github.com/example/catalog/issues/2930'],
                memoryKey: 'noise',
                source: 'codex-session-end',
              },
            ] as unknown[]);
          }
          return Promise.resolve([] as unknown[]);
        },
        storeMemory: () => Promise.resolve({ id: 1 }),
      },
      fixturesRoot: fixtureRoot,
    });

    assert.equal(report.suite, 'retrieval');
    assert.equal(
      report.failed,
      1,
      'source correctness must belong to the returned expected memory, not a neighboring result',
    );
    assert.equal(report.metrics.retrievalMeanPrecisionAtK, 0.5);
    assert.equal(report.metrics.retrievalMeanRecallAtK, 1);
    assert.equal(report.metrics.retrievalMrr, 0.8333);
    assert.equal(report.metrics.retrievalQueryCount, 3);
    assert.equal(report.metrics.retrievalSearchCallCount, 3);
    assert.equal(report.metrics.retrievalMeanReturnedSize, 2);
    assert.ok(Number(report.metrics.retrievalMeanCoreResultBytes) > 2);
    const first = report.details[0]?.actual;
    assert.ok(first !== null && typeof first === 'object' && 'coreResultBytes' in first);
    assert.equal(
      first.coreResultBytes,
      Buffer.byteLength(
        JSON.stringify([
          {
            evidenceRefs: ['https://github.com/example/catalog/issues/2930'],
            memoryKey: 'm1',
            source: 'codex-session-end',
          },
          { memoryKey: 'noise' },
        ]),
        'utf8',
      ),
    );
    assert.equal(report.metrics.retrievalSourceCorrectnessPct, 50);
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

test('runRetrievalSuite retains a generated foreign-project control and cleans it up', async () => {
  const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'ai-memory-retrieval-project-control-'));
  const retrievalDir = resolve(fixtureRoot, 'retrieval');
  const storedProjects: string[] = [];
  const cleanedProjects: string[] = [];
  mkdirSync(retrievalDir, { recursive: true });
  writeFileSync(
    resolve(retrievalDir, 'project-control.json'),
    JSON.stringify({
      memories: [
        {
          category: 'convention',
          content: 'Primary project fixture decision.',
          memoryKey: 'primary-project-memory',
        },
        {
          category: 'convention',
          content: 'Foreign project fixture decision must remain isolated.',
          fixtureProjectScope: 'other',
          memoryKey: 'foreign-project-memory',
        },
      ],
      queries: [{ expectedTopK: ['primary-project-memory'], k: 1, query: 'primary project fixture decision' }],
    }),
  );

  try {
    await runRetrievalSuite({
      dependencies: {
        cleanupProjectEntries: project => {
          cleanedProjects.push(project);
          return Promise.resolve(undefined);
        },
        searchMemories: () => Promise.resolve([{ memoryKey: 'primary-project-memory' }]),
        storeMemory: input => {
          const project = (input as { project?: unknown }).project;
          assert.equal(typeof project, 'string');
          storedProjects.push(project as string);
          return Promise.resolve({ id: 1 });
        },
      },
      fixturesRoot: fixtureRoot,
    });

    assert.equal(storedProjects.length, 2);
    assert.notEqual(storedProjects[0], storedProjects[1]);
    assert.ok(storedProjects.some(project => project.endsWith(':other')));
    assert.deepEqual([...cleanedProjects].sort(), [...storedProjects].sort());
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});
