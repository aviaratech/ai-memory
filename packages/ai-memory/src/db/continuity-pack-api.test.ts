import type { QueryResult, QueryResultRow } from 'pg';

import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { afterEach, describe, it } from 'vitest';

import {
  buildScopedContinuityPackScopeKey,
  getContinuityPack,
  upsertContinuityPack,
  writeAutomaticSessionCheckpoint,
} from './continuity-pack-api.js';
import { mockPoolConnect } from './test-pool-mock.js';

describe('continuity pack read model', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('automatic session checkpoints preserve concurrent writes, including an absent-row race', async () => {
    const queries: string[] = [];
    mockPoolConnect(sql => {
      queries.push(sql);
      return Promise.resolve(
        sql.includes('SELECT session_id FROM ai_sessions')
          ? { ...emptyResult(), rows: [{ session_id: 'session-a' }], rowCount: 1 }
          : emptyResult(),
      );
    });
    const checkpoint = {
      budgetChars: 6000,
      pack: { summary: 'Derived current session state.', provenance: { agent: 'codex' } },
      payloadText: 'Derived current session state.',
      project: 'example/catalog',
      scope: { type: 'task' as const, id: 'session-a' },
      sessionId: 'session-a',
      source: 'pre-compact',
    };
    assert.equal(
      await writeAutomaticSessionCheckpoint({
        checkpoint,
        expected: { status: 'missing', project: 'example/catalog', scopeKey: 'task:example/catalog:session-a' },
      }),
      false,
    );
    assert.ok(queries.some(sql => sql.includes('ON CONFLICT (scope_key) DO NOTHING')));
    queries.length = 0;
    assert.equal(
      await writeAutomaticSessionCheckpoint({
        checkpoint,
        expected: {
          status: 'found',
          pack: {
            budgetChars: 6000,
            pack: { summary: 'Original explicit state' },
            payloadChars: 23,
            project: 'example/catalog',
            scopeKey: 'task:example/catalog:session-a',
            sessionId: 'session-a',
            source: 'manual-flush',
            status: 'fresh',
            createdAt: undefined,
            updatedAt: '2026-10-19T00:00:00.000Z',
            revisionToken: 'exact-database-row-token',
          },
        },
      }),
      false,
    );
    assert.ok(queries.some(sql => sql.includes('row_to_json') && sql.includes('RETURNING scope_key')));
  });

  it('automatic writes reject foreign or unknown producer hosts before touching the database', async () => {
    const queries: string[] = [];
    mockPoolConnect(sql => {
      queries.push(sql);
      return Promise.resolve(emptyResult());
    });
    const checkpoint = {
      budgetChars: 6000,
      pack: { summary: 'Current', provenance: { agent: 'codex' } },
      payloadText: 'Current',
      project: 'example/catalog',
      scope: { type: 'task' as const, id: 'session-a' },
      sessionId: 'session-a',
      source: 'pre-compact',
    };
    for (const agent of ['claude-code', undefined]) {
      assert.equal(
        await writeAutomaticSessionCheckpoint({
          checkpoint,
          expected: {
            status: 'found',
            pack: {
              ...checkpoint,
              scopeKey: 'task:example/catalog:session-a',
              payloadChars: 7,
              createdAt: undefined,
              updatedAt: undefined,
              status: 'fresh',
              revisionToken: 'exact-token',
              pack: { provenance: { agent } },
            },
          },
        }),
        false,
      );
    }
    assert.equal(queries.length, 0);
    await assert.rejects(
      writeAutomaticSessionCheckpoint({
        checkpoint: { ...checkpoint, pack: {} },
        expected: { status: 'missing', project: 'example/catalog', scopeKey: 'task:example/catalog:session-a' },
      }),
      /host/u,
    );
  });

  it('upserts one project-scoped continuity pack with payload budget metadata', async () => {
    const capturedQueries: { params: readonly unknown[]; sql: string }[] = [];
    mockPoolConnect((sql: string, params?: readonly unknown[]) => {
      capturedQueries.push({ params: params ?? [], sql });
      return Promise.resolve(emptyResult());
    });

    const result = await upsertContinuityPack({
      budgetChars: 6000,
      pack: {
        nextActions: ['Continue the work.'],
        summary: 'Current continuity state.',
      },
      payloadText: '### Cross-Chat Continuity\n\nCurrent continuity state.',
      project: 'example/catalog',
      sessionId: 'session-abc',
      source: 'manual-flush',
      updatedAt: '2026-06-28T20:00:00.000Z',
    });

    assert.equal(result.status, 'updated');
    assert.equal(result.scopeKey, 'project:example/catalog');
    assert.equal(result.payloadChars, 52);
    const query = capturedQueries[0];
    assert.ok(query !== undefined, 'expected upsert query');
    assert.match(query.sql, /INSERT INTO ai_continuity_packs/u);
    assert.ok(query.sql.includes('ON CONFLICT (scope_key)'));
    assert.deepEqual(query.params.slice(0, 5), [
      'project:example/catalog',
      'example/catalog',
      'session-abc',
      'manual-flush',
      52,
    ]);
  });

  it('reads the project-scoped pack with a single indexed scope-key lookup', async () => {
    const capturedQueries: { params: readonly unknown[]; sql: string }[] = [];
    mockPoolConnect((sql: string, params?: readonly unknown[]) => {
      capturedQueries.push({ params: params ?? [], sql });
      return Promise.resolve({
        command: 'SELECT',
        fields: [],
        oid: 0,
        rowCount: 1,
        rows: [
          {
            budget_chars: 6000,
            created_at: new Date('2026-06-28T19:00:00.000Z'),
            pack_json: { nextActions: ['Continue implementation.'], summary: 'Continuity summary.' },
            payload_chars: 540,
            project: 'example/catalog',
            scope_key: 'project:example/catalog',
            session_id: 'session-abc',
            source: 'manual-flush',
            updated_at: new Date('2026-06-28T20:00:00.000Z'),
          },
        ],
      });
    });

    const result = await getContinuityPack({ project: 'example/catalog' });

    assert.equal(result.status, 'found');
    assert.equal(
      'revisionToken' in result.pack,
      false,
      'internal concurrency metadata must not change ordinary pack output',
    );
    assert.equal(result.pack.scopeKey, 'project:example/catalog');
    assert.equal(result.pack.payloadChars, 540);
    assert.equal(result.pack.updatedAt, '2026-06-28T20:00:00.000Z');
    const query = capturedQueries[0];
    assert.ok(query !== undefined, 'expected read query');
    assert.match(query.sql, /FROM ai_continuity_packs/u);
    assert.ok(query.sql.includes('WHERE scope_key = $1'));
    assert.deepEqual(query.params, ['project:example/catalog']);
  });

  it('keeps an explicit lead checkpoint separate from the project-latest pack', async () => {
    const capturedQueries: { params: readonly unknown[]; sql: string }[] = [];
    mockPoolConnect((sql: string, params?: readonly unknown[]) => {
      capturedQueries.push({ params: params ?? [], sql });
      return Promise.resolve(emptyResult());
    });

    const scope = { id: 'tech-lead', type: 'lead' } as const;
    const write = await upsertContinuityPack({
      budgetChars: 6000,
      pack: { summary: 'Lead checkpoint is authoritative only for this lead scope.' },
      payloadText: '### Cross-Chat Continuity\n\nLead checkpoint.',
      project: 'example/catalog',
      scope,
      source: 'manual-flush',
    });
    assert.equal(write.scopeKey, 'lead:example/catalog:tech-lead');
    assert.equal(
      buildScopedContinuityPackScopeKey({ project: 'example/catalog', scope }),
      'lead:example/catalog:tech-lead',
    );

    await getContinuityPack({ lead: 'tech-lead', project: 'example/catalog' });
    const writeQuery = capturedQueries[0];
    const readQuery = capturedQueries[1];
    assert.ok(writeQuery !== undefined, 'expected scoped upsert query');
    assert.ok(readQuery !== undefined, 'expected scoped read query');
    assert.deepEqual(writeQuery.params.slice(0, 2), ['lead:example/catalog:tech-lead', 'example/catalog']);
    assert.deepEqual(readQuery.params, ['lead:example/catalog:tech-lead']);
  });
});

function emptyResult(): QueryResult<QueryResultRow> {
  return {
    command: 'INSERT',
    fields: [],
    oid: 0,
    rowCount: 1,
    rows: [],
  };
}
