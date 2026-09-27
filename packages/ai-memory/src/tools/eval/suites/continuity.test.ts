import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  assertValidMemoryDelta,
  isRecord,
  toSessionRecord,
  toSessionSnapshotRecord,
} from '@aviaratech/ai-memory/internal';
import { buildScopedContinuityPacksFromFlush, type BuiltContinuityPack } from '../../ingestion/continuity-pack.js';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'vitest';

import { runContinuitySuite } from './continuity.js';

test('runContinuitySuite returns skip when continuity fixtures are missing', async () => {
  const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'ai-memory-continuity-fixtures-missing-'));

  try {
    const report = await runContinuitySuite({ fixturesRoot: fixtureRoot });
    assert.equal(report.suite, 'continuity');
    assert.equal(report.failed, 0);
    assert.equal(report.passed, 0);
    assert.equal(report.skipped, 1);
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});

for (const loseStoredProject of [false, true])
  test(`continuity evaluator exercises canonical flush and scoped recovery (lost project: ${String(loseStoredProject)})`, async () => {
    const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'ai-memory-continuity-identity-'));
    mkdirSync(resolve(fixtureRoot, 'continuity'));
    copyFileSync(
      fileURLToPath(new URL('../fixtures/continuity/explicit-checkpoint.json', import.meta.url)),
      resolve(fixtureRoot, 'continuity', 'explicit-checkpoint.json'),
    );
    const deltas = new Map<string, Record<string, unknown>>();
    const packs = new Map<string, { built: BuiltContinuityPack; sessionId: string }>();
    const resumeInputs: unknown[] = [];
    const producedSessions: string[] = [];
    const cleaned: string[] = [];
    try {
      const report = await runContinuitySuite({
        dependencies: {
          cleanupSessionArtifacts: sessionId => {
            cleaned.push(sessionId);
            return Promise.resolve();
          },
          countContestedMemories: () => Promise.resolve(0),
          getCapabilities: () => ({ hasEmbeddingColumn: false, hasTrigram: false, hasVector: false }),
          getContinuityPack: input => {
            assert.ok(isRecord(input));
            const scopeKey =
              input.task === undefined
                ? `project:${String(input.project)}`
                : `task:${String(input.project)}:${String(input.task)}`;
            const found = packs.get(scopeKey);
            return Promise.resolve(
              found === undefined
                ? { project: String(input.project), scopeKey, status: 'missing' }
                : {
                    pack: {
                      ...found.built,
                      createdAt: undefined,
                      sessionId: found.sessionId,
                      status: 'fresh',
                      updatedAt: undefined,
                    },
                    status: 'found',
                  },
            );
          },
          getSessionResume: input => {
            resumeInputs.push(input);
            assert.ok(isRecord(input));
            const sessionId = String(input.sessionId);
            const delta = deltas.get(sessionId);
            const missing = {
              contextPackId: undefined,
              deltaId: undefined,
              events: [],
              resolvedVia: 'not_found' as const,
              session: undefined,
              sessionId,
              snapshot: undefined,
              status: 'not_found',
            };
            if (delta === undefined || input.project !== 'fixture/recovery' || input.agent !== 'codex')
              return Promise.resolve(missing);
            assert.ok(isRecord(delta.snapshot));
            return Promise.resolve({
              ...missing,
              contextPackCreatedAt: undefined,
              deltaCreatedAt: undefined,
              resolvedVia: 'direct' as const,
              session: toSessionRecord({
                agent: 'codex',
                repo_id: loseStoredProject ? null : 'fixture/recovery',
                session_id: sessionId,
              }),
              snapshot: toSessionSnapshotRecord({ session_id: sessionId, snapshot_json: delta.snapshot.value }),
              status: 'ok',
            });
          },
          ingestMemoryDelta: input => {
            assert.ok(isRecord(input));
            assertValidMemoryDelta(input.memoryDelta);
            const delta = input.memoryDelta;
            assert.ok(isRecord(delta));
            assert.equal(typeof delta.session_id, 'string');
            assert.ok(isRecord(delta.snapshot) && isRecord(delta.snapshot.value));
            assert.deepEqual(delta.produced_by, { agent: 'codex' });
            assert.deepEqual(delta.tenancy, { repo_id: 'fixture/recovery' });
            assert.deepEqual(delta.snapshot.value.context_needed, [
              'Customer review is pending; original approval evidence remains authoritative.',
            ]);
            const sessionId = String(delta.session_id);
            producedSessions.push(sessionId);
            deltas.set(sessionId, delta);
            return Promise.resolve({});
          },
          recallMemories: () => Promise.resolve([]),
          refreshContinuityPack: input => {
            for (const built of buildScopedContinuityPacksFromFlush({ ...input, nowIso: '2026-01-01T00:00:00Z' }))
              packs.set(built.scopeKey, { built, sessionId: input.sessionId });
            return Promise.resolve({
              budgetChars: 6000,
              payloadChars: 0,
              scopeKey: 'project:fixture/recovery',
              status: 'updated',
              truncated: false,
            });
          },
          searchMemories: () => Promise.resolve([]),
        },
        fixturesRoot: fixtureRoot,
      });
      assert.equal(producedSessions[0], 'fixture-codex-session-a', 'fixture host identity must not be replaced');
      assert.deepEqual(resumeInputs[0], {
        agent: 'codex',
        eventLimit: 25,
        project: 'fixture/recovery',
        sessionId: 'fixture-codex-session-a',
      });
      assert.equal(report.failed, loseStoredProject ? 1 : 0);
      if (!loseStoredProject) {
        assert.equal(report.passed, 1);
        assert.equal(producedSessions.length, 2, 'another task must overwrite project background');
        assert.equal(cleaned.length, 2);
      }
    } finally {
      rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });
