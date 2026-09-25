import assert from 'node:assert/strict';
import { test } from 'vitest';

import type { MemoryDeltaV01 } from './types.js';

import { assertValidMemoryDelta } from '../db/schema-validation.js';
import { MEMORY_DELTA_TOP_LEVEL_EXTENSION_SURFACES } from './extension-policy.js';

const TEST_NOW = '2026-02-23T00:00:00.000Z';
const TEST_SESSION_ID = 'session-1380';
const MEMORY_FLUSH_AGENT = 'memory-flush';

function createPatchMemoryDelta(): MemoryDeltaV01 {
  return {
    artifacts: [],
    created_at: TEST_NOW,
    delta_id: 'delta-patch-1380',
    produced_by: { agent: MEMORY_FLUSH_AGENT },
    schema_version: 'memory_delta@0.1',
    session_id: TEST_SESSION_ID,
    snapshot: {
      mode: 'patch',
      value: {
        ops: [{ op: 'set', path: '/goal', value: 'Patched contract policy goal' }],
      },
    },
    tenancy: {},
  };
}

function createReplaceMemoryDelta(): MemoryDeltaV01 {
  return {
    artifacts: [],
    created_at: TEST_NOW,
    delta_id: 'delta-replace-1380',
    produced_by: { agent: MEMORY_FLUSH_AGENT },
    schema_version: 'memory_delta@0.1',
    session_id: TEST_SESSION_ID,
    snapshot: {
      mode: 'replace',
      value: {
        anchors: {
          focus_paths: [],
          related_links: [],
        },
        context_needed: [],
        created_at: TEST_NOW,
        goal: 'Contract policy coverage',
        next_actions: [],
        open_questions: [],
        plan: [],
        progress: {
          blockers: [],
          completed: [],
          in_flight: [],
        },
        snapshot_id: 'snapshot-replace-1380',
      },
    },
    tenancy: {},
  };
}

test('memory_delta extension surfaces remain explicitly documented', () => {
  assert.deepEqual(MEMORY_DELTA_TOP_LEVEL_EXTENSION_SURFACES, [
    'root',
    'snapshot',
    'produced_by',
    'tenancy',
    'telemetry',
    'workflow',
    'append_events[*]',
    'artifacts[*]',
  ]);
});

test('replace snapshots accept x_ fields across policy surfaces (A0 regression class)', () => {
  const base = createReplaceMemoryDelta();
  const replaceWithExtensions = {
    ...base,
    append_events: [{ summary: 'checkpoint', type: 'checkpoint', x_event_trace: 'evt-1380' }],
    artifacts: [
      {
        content_markdown: 'Contract policy test',
        kind: 'note',
        title: 'Policy',
        x_artifact_scope: 'test',
      },
    ],
    produced_by: { ...base.produced_by, x_agent_role: 'builder' },
    snapshot: {
      ...base.snapshot,
      mode: 'replace',
      value: {
        anchors: {
          focus_paths: [],
          related_links: [],
        },
        context_needed: [],
        created_at: TEST_NOW,
        goal: 'Contract policy replace coverage',
        next_actions: [],
        open_questions: [],
        plan: [],
        progress: {
          blockers: [],
          completed: [],
          in_flight: [],
        },
        snapshot_id: 'snapshot-replace-1380-with-x',
        x_state_model: {
          assumptions: ['replace snapshots should remain extension-compatible'],
          strategy_confidence: 'high',
        },
      },
      x_snapshot_source: 'extension-policy-test',
    },
    telemetry: { x_latency_bucket: 'p50' },
    tenancy: { x_repo_alias: 'example/catalog' },
    workflow: {
      entity_id: TEST_SESSION_ID,
      entity_type: 'agent_session',
      system: MEMORY_FLUSH_AGENT,
      x_workflow_stage: 'contract-test',
    },
    x_trace_id: 'trace-1380',
  };

  assert.doesNotThrow(() => {
    assertValidMemoryDelta(replaceWithExtensions);
  });
});

test('non-policy extras fail while core validation remains strict', () => {
  const base = createReplaceMemoryDelta();
  const withUnexpectedRootField = {
    ...base,
    unexpected_root_field: true,
  };

  assert.throws(
    () => {
      assertValidMemoryDelta(withUnexpectedRootField);
    },
    /must NOT have additional properties/u,
    'non-x extra root fields should fail strict validation',
  );

  const withUnexpectedSnapshotField = {
    ...base,
    snapshot: {
      ...base.snapshot,
      value: {
        ...base.snapshot.value,
        unexpected_snapshot_field: true,
      },
    },
  };

  assert.throws(
    () => {
      assertValidMemoryDelta(withUnexpectedSnapshotField);
    },
    /must NOT have additional properties/u,
    'replace snapshot values should reject non-x extras',
  );
});

test('patch snapshots require ops payloads', () => {
  const base = createPatchMemoryDelta();
  const missingOps = {
    ...base,
    snapshot: {
      ...base.snapshot,
      value: {
        x_patch_note: 'ops omitted on purpose',
      },
    },
  };

  assert.throws(
    () => {
      assertValidMemoryDelta(missingOps);
    },
    /required property 'ops'|must have required property 'ops'|must match exactly one schema/u,
    'patch snapshots must enforce ops array presence',
  );
});

test('patch snapshots accept x_ extension fields while enforcing mode semantics', () => {
  const base = createPatchMemoryDelta();
  const patchWithExtensions = {
    ...base,
    append_events: [
      {
        summary: 'patched',
        type: 'checkpoint',
        x_event_trace: 'evt-patch-1380',
      },
    ],
    artifacts: [
      {
        content_markdown: 'Patch extension policy test',
        kind: 'note',
        title: 'Patch Policy',
        x_artifact_scope: 'test',
      },
    ],
    produced_by: { ...base.produced_by, x_agent_role: 'builder' },
    snapshot: {
      ...base.snapshot,
      value: {
        ops: [
          {
            op: 'set',
            path: '/goal',
            value: 'Patched contract policy goal v2',
          },
          { op: 'add', path: '/x_patch_marker', value: 'applied' },
        ],
        x_patch_note: 'patch payload extensions are allowed',
      },
      x_snapshot_source: 'extension-policy-test',
    },
    telemetry: { x_latency_bucket: 'p75' },
    tenancy: { x_repo_alias: 'example/catalog' },
    workflow: {
      entity_id: TEST_SESSION_ID,
      entity_type: 'agent_session',
      system: MEMORY_FLUSH_AGENT,
      x_workflow_stage: 'contract-test',
    },
    x_trace_id: 'trace-patch-1380',
  };

  assert.doesNotThrow(() => {
    assertValidMemoryDelta(patchWithExtensions);
  });
});
