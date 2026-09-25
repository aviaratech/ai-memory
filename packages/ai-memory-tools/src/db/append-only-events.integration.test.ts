/**
 * Integration test: ai_session_events append-only enforcement.
 *
 * Requires a running PostgreSQL instance with the ai_memory schema. When no
 * database URL is configured, this test is skipped so the normal package test
 * suite remains safe in CI environments without Postgres.
 */

import {
  assertLocalDatabaseUrl,
  closePool,
  ingestContextPack,
  initializeDatabase,
  listIngestionFailures,
} from '@aviaratech/ai-memory/internal';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'vitest';
import { Pool, type QueryResultRow } from 'pg';

const dbUrl = process.env.AI_MEMORY_DATABASE_URL;
const APPEND_ONLY_TRIGGER_PROBE_ENV = 'AI_MEMORY_ALLOW_APPEND_ONLY_TRIGGER_PROBE';

const SELECT_EVENT_SQL = 'SELECT summary FROM ai_session_events WHERE event_id = $1';

interface EventPayload {
  event_id: string;
  summary: string;
  ts?: string;
  type?: string;
}

interface EventSummaryRow extends QueryResultRow {
  payload_json?: unknown;
  summary?: string;
}

interface FailureRecord {
  details?: Record<string, unknown>;
  stage?: string;
}

interface ReadOnlySettingRow extends QueryResultRow {
  default_transaction_read_only: string;
}

function isLocalDatabaseUrl(databaseUrl: string): boolean {
  try {
    assertLocalDatabaseUrl(databaseUrl);
    return true;
  } catch {
    return false;
  }
}

if (dbUrl !== undefined) assertLocalDatabaseUrl(dbUrl);

function shouldRunAppendOnlyTriggerProbe(databaseUrl: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const optIn = env[APPEND_ONLY_TRIGGER_PROBE_ENV]?.trim().toLowerCase();
  if (optIn === '1' || optIn === 'true') {
    return true;
  }

  return isLocalDatabaseUrl(databaseUrl);
}

test('shared database append-only trigger probe requires explicit opt-in', () => {
  assert.equal(
    shouldRunAppendOnlyTriggerProbe('postgres://postgres@aviara-dev-postgres.example:5432/aviara_dev', {}),
    false,
  );
  assert.equal(shouldRunAppendOnlyTriggerProbe('postgres://postgres@localhost:5432/aviara_dev', {}), true);
  assert.equal(
    shouldRunAppendOnlyTriggerProbe('postgres://postgres@localhost/aviara_dev?host=database.example.invalid', {}),
    false,
  );
  assert.equal(
    shouldRunAppendOnlyTriggerProbe('postgres://postgres@aviara-dev-postgres.example:5432/aviara_dev', {
      [APPEND_ONLY_TRIGGER_PROBE_ENV]: '1',
    }),
    true,
  );
});

if (dbUrl === undefined) {
  test('ai_session_events append-only enforcement', { skip: true }, () => {});
} else {
  test('ai_session_events append-only enforcement', async t => {
    const verificationPool = new Pool({ connectionString: dbUrl });
    const sessionId = `sess-test-append-only-${randomUUID().slice(0, 8)}`;
    const snapshotId = `snap-test-append-only-${randomUUID().slice(0, 8)}`;
    let shouldCleanup = false;

    function buildContextPack(eventPayloads: readonly EventPayload[]) {
      const now = new Date();
      return {
        created_at: now.toISOString(),
        pack_id: `pack-test-${randomUUID().slice(0, 8)}`,
        pinned: { constraints: ['test-only'] },
        produced_by: { agent: 'test-runner', instance_id: 'append-only-test' },
        schema_version: 'context_pack@0.1',
        session: {
          recent_events: eventPayloads.map((payload, i) => ({
            event_id: payload.event_id,
            summary: payload.summary,
            ts: payload.ts ?? new Date(now.getTime() - (eventPayloads.length - i) * 1000).toISOString(),
            type: payload.type ?? 'checkpoint',
          })),
          session_id: sessionId,
          snapshot: {
            anchors: {},
            created_at: now.toISOString(),
            goal: 'Test append-only event enforcement',
            next_actions: [],
            open_questions: [],
            plan: [],
            progress: { blockers: [], completed: [], in_flight: [] },
            snapshot_id: snapshotId,
          },
        },
        task: { type: 'chore' },
        tenancy: { org_id: 'test', repo_id: 'test/ai' },
        working_set: {},
      };
    }

    async function cleanup() {
      const client = await verificationPool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM ai_ingestion_failures WHERE session_id = $1', [sessionId]);
        await client.query('DELETE FROM ai_session_events WHERE session_id = $1', [sessionId]);
        await client.query('DELETE FROM ai_session_snapshots WHERE session_id = $1', [sessionId]);
        await client.query('DELETE FROM ai_context_packs WHERE session_id = $1', [sessionId]);
        await client.query('DELETE FROM ai_sessions WHERE session_id = $1', [sessionId]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }

    async function isDatabaseReadOnly() {
      const result = await verificationPool.query<ReadOnlySettingRow>('SHOW default_transaction_read_only');
      return result.rows.at(0)?.default_transaction_read_only === 'on';
    }

    async function countConflictFailuresForEvent(eventId: string) {
      const failures = (await listIngestionFailures({
        stage: 'event_conflict_mismatch',
      })) as FailureRecord[];
      return failures.filter(failure => {
        const details = failure.details;
        return details !== undefined && typeof details.eventId === 'string' && details.eventId === eventId;
      }).length;
    }

    async function testIdempotentReplay() {
      const eventId = `evt-test-idem-${randomUUID().slice(0, 8)}`;
      const event = {
        event_id: eventId,
        summary: 'Test event alpha',
        type: 'checkpoint',
      };

      await ingestContextPack({ contextPack: buildContextPack([event]) });

      const before = await verificationPool.query<EventSummaryRow>(
        'SELECT summary, payload_json FROM ai_session_events WHERE event_id = $1',
        [eventId],
      );
      assert.equal(before.rows.length, 1);

      await ingestContextPack({ contextPack: buildContextPack([event]) });

      const after = await verificationPool.query<EventSummaryRow>(
        'SELECT summary, payload_json FROM ai_session_events WHERE event_id = $1',
        [eventId],
      );
      assert.equal(after.rows.length, 1);
      assert.equal(after.rows.at(0)?.summary, 'Test event alpha');

      const failureCount = await countConflictFailuresForEvent(eventId);
      assert.equal(failureCount, 0);
    }

    async function testOutOfOrderReplay() {
      const eventId = `evt-test-ooo-${randomUUID().slice(0, 8)}`;
      const original = {
        event_id: eventId,
        summary: 'Out-of-order baseline',
        ts: '2026-02-07T10:00:00.000Z',
        type: 'checkpoint',
      };
      const replay = {
        event_id: eventId,
        summary: 'Out-of-order baseline',
        ts: '2026-02-07T09:59:00.000Z',
        type: 'checkpoint',
      };

      await ingestContextPack({ contextPack: buildContextPack([original]) });
      await ingestContextPack({ contextPack: buildContextPack([replay]) });

      const after = await verificationPool.query<EventSummaryRow>(SELECT_EVENT_SQL, [eventId]);
      assert.equal(after.rows.length, 1);
      assert.equal(after.rows.at(0)?.summary, original.summary);

      const failureCount = await countConflictFailuresForEvent(eventId);
      assert.equal(failureCount, 0);
    }

    async function testMismatchDetection() {
      const eventId = `evt-test-mismatch-${randomUUID().slice(0, 8)}`;
      const original = {
        event_id: eventId,
        summary: 'Original payload',
        type: 'checkpoint',
      };
      const modified = {
        event_id: eventId,
        summary: 'Modified payload',
        type: 'checkpoint',
      };

      await ingestContextPack({ contextPack: buildContextPack([original]) });

      const before = await verificationPool.query<EventSummaryRow>(SELECT_EVENT_SQL, [eventId]);
      assert.equal(before.rows.length, 1);

      await ingestContextPack({ contextPack: buildContextPack([modified]) });
      await ingestContextPack({ contextPack: buildContextPack([modified]) });

      const after = await verificationPool.query<EventSummaryRow>(SELECT_EVENT_SQL, [eventId]);
      assert.equal(after.rows.length, 1);
      assert.equal(after.rows.at(0)?.summary, 'Original payload');

      const failures = (await listIngestionFailures({
        stage: 'event_conflict_mismatch',
      })) as FailureRecord[];
      const matchingFailures = failures.filter(f => {
        const details = f.details;
        return details !== undefined && typeof details.eventId === 'string' && details.eventId === eventId;
      });
      assert.equal(matchingFailures.length, 1);

      const matchingDetails = matchingFailures.at(0)?.details;
      assert.ok(matchingDetails !== undefined);
      const existingHash = matchingDetails.existingHash;
      const incomingHash = matchingDetails.incomingHash;
      assert.ok(typeof existingHash === 'string');
      assert.ok(existingHash.startsWith('sha256:'));
      assert.ok(typeof incomingHash === 'string');
      assert.ok(incomingHash.startsWith('sha256:'));
    }

    async function testUpdateTrigger() {
      const eventId = `evt-test-trigger-${randomUUID().slice(0, 8)}`;
      const event = {
        event_id: eventId,
        summary: 'Trigger test event',
        type: 'checkpoint',
      };

      await ingestContextPack({ contextPack: buildContextPack([event]) });

      await assert.rejects(
        verificationPool.query("UPDATE ai_session_events SET summary = 'hacked' WHERE event_id = $1", [eventId]),
        /append-only/,
      );

      const result = await verificationPool.query<EventSummaryRow>(SELECT_EVENT_SQL, [eventId]);
      assert.equal(result.rows.at(0)?.summary, 'Trigger test event');
    }

    try {
      if (await isDatabaseReadOnly()) {
        t.skip('AI_MEMORY_DATABASE_URL points at a read-only database');
        return;
      }

      shouldCleanup = true;
      await initializeDatabase();

      await testIdempotentReplay();
      await testOutOfOrderReplay();
      await testMismatchDetection();
      if (shouldRunAppendOnlyTriggerProbe(dbUrl)) {
        await testUpdateTrigger();
      }
    } finally {
      try {
        if (shouldCleanup) {
          await cleanup();
        }
      } finally {
        await Promise.allSettled([closePool(), verificationPool.end()]);
      }
    }
  });
}
