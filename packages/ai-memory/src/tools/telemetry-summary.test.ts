import { appendAiMemoryWarningsToTextResult, normalizeMemoryInput } from '@aviaratech/ai-memory/internal';
import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  detectAgentContext,
  mergeDetectedDefaults,
  resolveToolInvocationColumnMetadata,
  resolveToolInvocationResponseStatus,
  summarizeToolPayload,
} from './server.js';
import { extractTimedOutSteps, summarizeToolArgs } from './telemetry-summary.js';

const CANONICAL_PROJECT = 'example/catalog';

// --- project handling in telemetry summary ---

test('summarizeToolArgs preserves non-repo project identifiers without canonicalization', () => {
  const summary = summarizeToolArgs({ project: 'legacy-project' });
  assert.equal(summary.project, 'legacy-project');
});

test('summarizeToolArgs preserves dashed project aliases without canonicalization', () => {
  const summary = summarizeToolArgs({ project: 'consumer-monorepo' });
  assert.equal(summary.project, 'consumer-monorepo');
});

test('summarizeToolArgs trims project values without changing case', () => {
  const summary = summarizeToolArgs({ project: '  LEGACY-PROJECT  ' });
  assert.equal(summary.project, 'LEGACY-PROJECT');
});

test('summarizeToolArgs passes through canonical project identifier unchanged', () => {
  const summary = summarizeToolArgs({ project: CANONICAL_PROJECT });
  assert.equal(summary.project, CANONICAL_PROJECT);
});

test('summarizeToolArgs passes through non-legacy project identifiers unchanged', () => {
  const summary = summarizeToolArgs({ project: 'aviaratech/mobile' });
  assert.equal(summary.project, 'aviaratech/mobile');
});

test('summarizeToolArgs omits project when not provided', () => {
  const summary = summarizeToolArgs({ category: 'decision' });
  assert.equal(summary.project, undefined);
});

test('summarizeToolArgs does not throw for non-string project values', () => {
  assert.doesNotThrow(() => {
    summarizeToolArgs({ project: 42 });
    summarizeToolArgs({ project: true });
    summarizeToolArgs({ project: { nested: 'object' } });
  });
});

test('summarizeToolArgs ignores non-string text field values', () => {
  const summary = summarizeToolArgs({
    category: 42,
    project: true,
    sessionId: 101,
    source: false,
    stage: { name: 'analysis' },
  });

  assert.equal(summary.category, undefined);
  assert.equal(summary.source, undefined);
  assert.equal(summary.stage, undefined);
  assert.equal(summary.session_id, undefined);
  assert.equal(summary.project, undefined);
});

test('summarizeToolArgs omits project for non-string project values', () => {
  const summary = summarizeToolArgs({ project: 42 });
  assert.equal(summary.project, undefined);
});

test('summarizeToolArgs returns empty object for non-object args', () => {
  assert.deepEqual(summarizeToolArgs(null), {});
  assert.deepEqual(summarizeToolArgs(undefined), {});
  assert.deepEqual(summarizeToolArgs('string'), {});
});

test('summarizeToolArgs copies other text fields correctly alongside project', () => {
  const summary = summarizeToolArgs({
    category: 'convention',
    project: 'legacy-project',
    sessionId: 'abc-123',
  });

  assert.equal(summary.project, 'legacy-project');
  assert.equal(summary.category, 'convention');
  assert.equal(summary.session_id, 'abc-123');
});

test('resolveToolInvocationColumnMetadata forwards request provenance to DB columns', () => {
  const summary = summarizeToolArgs({
    category: 'convention',
    project: 'legacy-project',
    sessionId: 'abc-123',
  });

  assert.deepEqual(resolveToolInvocationColumnMetadata(summary), {
    project: 'legacy-project',
    sessionId: 'abc-123',
  });
});

test('resolveToolInvocationColumnMetadata omits non-string request provenance', () => {
  assert.deepEqual(
    resolveToolInvocationColumnMetadata({
      project: 42,
      session_id: 101,
    }),
    {},
  );
});

test('detectAgentContext maps CLAUDECODE=1 to claude-code provenance', () => {
  const detected = detectAgentContext({ CLAUDECODE: '1' });
  assert.deepEqual(detected, { agent: 'claude-code', source: 'claude-code' });
});

test('detectAgentContext maps AI_AGENT_IDENTITY to agent and source', () => {
  const detected = detectAgentContext({ AI_AGENT_IDENTITY: 'gpt-builder' });
  assert.deepEqual(detected, { agent: 'gpt-builder', source: 'gpt-builder' });
});

test('detectAgentContext prioritizes AI_AGENT_IDENTITY over CLAUDECODE', () => {
  const detected = detectAgentContext({
    AI_AGENT_IDENTITY: 'gpt-builder',
    CLAUDECODE: '1',
  });
  assert.deepEqual(detected, { agent: 'gpt-builder', source: 'gpt-builder' });
});

test('detectAgentContext returns empty defaults when no agent env vars are present', () => {
  const detected = detectAgentContext({});
  assert.deepEqual(detected, {});
});

test('mergeDetectedDefaults preserves explicit caller provenance', () => {
  const merged = mergeDetectedDefaults(
    { agent: 'custom-agent', category: 'decision', source: 'custom-source' },
    { agent: 'codex', source: 'codex' },
  );
  assert.equal(merged.agent, 'custom-agent');
  assert.equal(merged.source, 'custom-source');
});

test('mergeDetectedDefaults filters undefined input fields', () => {
  const merged = mergeDetectedDefaults(
    { agent: undefined, model: undefined, source: undefined },
    { agent: 'codex', model: 'gpt-5-codex', source: 'codex' },
  );
  assert.equal(merged.agent, 'codex');
  assert.equal(merged.model, 'gpt-5-codex');
  assert.equal(merged.source, 'codex');
});

test('extractTimedOutSteps returns deduplicated phase names from timed-out warning messages', () => {
  const steps = extractTimedOutSteps([
    'memory_orient.search.direct timed out after 5000ms',
    'memory_orient.session_resume timed out after 5000ms',
    'memory_orient.search.direct timed out after 5000ms',
    'non-timeout warning: connection reset',
  ]);
  assert.deepEqual(steps, ['memory_orient.search.direct', 'memory_orient.session_resume']);
});

test('extractTimedOutSteps preserves first-seen order and trims whitespace', () => {
  const steps = extractTimedOutSteps([
    '  db.read.search_memories timed out after 5000ms  ',
    'db.read.search_memories.reversal_penalty timed out after 5000ms',
  ]);
  assert.deepEqual(steps, ['db.read.search_memories', 'db.read.search_memories.reversal_penalty']);
});

test('extractTimedOutSteps returns empty array when no warnings include timeout phrasing', () => {
  const steps = extractTimedOutSteps(['no timeouts here', 'connection reset by peer']);
  assert.deepEqual(steps, []);
});

test('extractTimedOutSteps falls back gracefully when value is not an array of strings', () => {
  assert.deepEqual(extractTimedOutSteps(null), []);
  assert.deepEqual(extractTimedOutSteps(undefined), []);
  assert.deepEqual(extractTimedOutSteps([42, true, { not: 'a string' }]), []);
});

test('summarizeToolArgs captures continuity completeness fields for memory_flush', () => {
  const summary = summarizeToolArgs({
    contextNeeded: ['Wait for reviewer approval.'],
    detectedSource: 'gpt-builder',
    nextActions: ['Run tests.'],
    openQuestions: [],
    stateModel: { assumptions: ['No open questions remain.'] },
  });

  assert.equal(summary.detected_source, 'gpt-builder');
  assert.equal(summary.context_needed_count, 1);
  assert.equal(summary.next_actions_count, 1);
  assert.equal(summary.open_questions_count, undefined);
  assert.equal(summary.state_model_assumptions_count, 1);
  assert.equal(summary.continuity_complete, 1);
});

test('summarizeToolArgs marks incomplete continuity when agent fields are partial', () => {
  const summary = summarizeToolArgs({
    detectedSource: 'codex',
    nextActions: ['Run tests.'],
    stateModel: { assumptions: [] },
  });

  assert.equal(summary.continuity_complete, 0);
});

test('summarizeToolArgs counts JSON-stringified continuity arrays', () => {
  const summary = summarizeToolArgs({
    contextNeeded: '["Capture reviewer notes."]',
    nextActions: '["Run tests."]',
    openQuestions: '["Publish once checks pass."]',
  });

  assert.equal(summary.context_needed_count, 1);
  assert.equal(summary.next_actions_count, 1);
  assert.equal(summary.open_questions_count, 1);
  assert.equal(summary.continuity_complete, 1);
});

// --- runTool warning ordering: collector → payload → summary ---
// These tests pin the contract that DB/embedding-layer warnings recorded via the
// AsyncLocalStorage collector reach `summary_json.timed_out_steps` on
// `ai_tool_invocations` — i.e. the warning must be merged into the response
// payload BEFORE the summary is extracted, so phase attribution survives into
// the health report.

test('summarizeToolPayload captures timed_out_steps when warnings are present in payload', () => {
  const responseWithWarnings = {
    content: [
      {
        text: JSON.stringify({
          memories: [],
          status: 'ok',
          warnings: ['db.read.search_memories timed out after 5000ms'],
        }),
        type: 'text' as const,
      },
    ],
  };

  const summary = summarizeToolPayload(responseWithWarnings, 'memory_search');
  assert.equal(summary.warning_count, 1);
  assert.equal(summary.timeout_warning_count, 1);
  assert.equal(summary.timed_out_steps, 'db.read.search_memories');
});

test('resolveToolInvocationResponseStatus forwards payload status to DB telemetry input', () => {
  const response = {
    content: [{ text: JSON.stringify({ status: 'missing' }), type: 'text' as const }],
  };

  const summary = summarizeToolPayload(response, 'memory_continuity_pack');

  assert.equal(summary.response_status, 'missing');
  assert.equal(resolveToolInvocationResponseStatus(summary), 'missing');
});

test('summarizeToolPayload records memory-orient environment status separately from response status', () => {
  const response = {
    content: [
      {
        text: JSON.stringify({
          orientation: { environmentStatus: 'local_fallback' },
          status: 'ok',
          warnings: [
            'gh auth unavailable: no active authenticated github.com account (reason: gh_auth_no_active_account)',
          ],
        }),
        type: 'text' as const,
      },
    ],
  };

  const summary = summarizeToolPayload(response, 'memory_orient');
  assert.equal(summary.response_status, 'ok');
  assert.equal(summary.environment_status, 'local_fallback');
  assert.equal(summary.warning_count, 1);
});

test('summarizeToolPayload reports zero timed_out_steps when payload has no warnings', () => {
  const cleanResponse = {
    content: [{ text: JSON.stringify({ memories: [], status: 'ok' }), type: 'text' as const }],
  };

  const summary = summarizeToolPayload(cleanResponse, 'memory_search');
  assert.equal(summary.warning_count, undefined);
  assert.equal(summary.timed_out_steps, undefined);
});

test('appendAiMemoryWarningsToTextResult followed by summarizeToolPayload yields timed_out_steps (runTool ordering invariant)', () => {
  // Simulate the order runTool now uses: handler returns a clean payload, the
  // collector recorded an embedding/DB timeout warning, runTool merges the
  // collector into the payload, then summarizes. Reversing the order — as the
  // previous implementation did — would drop these warnings from
  // summary_json.timed_out_steps.
  const handlerResponse = {
    content: [{ text: JSON.stringify({ memories: [], status: 'ok' }), type: 'text' as const }],
  };

  const merged = appendAiMemoryWarningsToTextResult(handlerResponse, [
    {
      code: 'embedding.search_memories.timeout',
      message: 'embedding.search_memories timed out after 5000ms',
    },
    {
      code: 'db.write.memory_flush.actionable.timeout',
      message: 'db.write.memory_flush.actionable timed out after 8000ms',
    },
  ]);

  const summary = summarizeToolPayload(merged, 'memory_search');
  assert.equal(summary.warning_count, 2);
  assert.equal(summary.timeout_warning_count, 2);
  const steps = typeof summary.timed_out_steps === 'string' ? summary.timed_out_steps.split(',') : [];
  assert.deepEqual(new Set(steps), new Set(['db.write.memory_flush.actionable', 'embedding.search_memories']));
});

test('normalizeMemoryInput falls back to detectedSource before manual', () => {
  const normalized = normalizeMemoryInput({
    category: 'decision',
    content: 'Use detected source when explicit source is missing.',
    detectedSource: 'codex',
  });
  assert.equal(normalized.source, 'codex');
});

test('search summary measures the final serialized result with content-free budget metadata', async () => {
  const { finalizeSearchResponse } = await import('./server.js');
  const response = finalizeSearchResponse(
    {
      content: [
        { text: JSON.stringify({ memories: [{ content: 'private body'.repeat(10000), id: 1 }] }), type: 'text' },
      ],
    },
    { limit: 5, memoryDetail: 'full', query: 'private query' },
  );
  const summary = summarizeToolPayload(response, 'memory_search');
  assert.equal(summary.search_response_bytes, Buffer.byteLength(JSON.stringify(response)));
  assert.equal(summary.search_detail, 'full');
  assert.equal(summary.search_requested_count, 5);
  assert.equal(summary.search_returned_count, 1);
  assert.equal(summary.search_candidate_count, 1);
  assert.equal(summary.search_budget_exceeded, 1);
  assert.equal(summary.search_truncated, 1);
  assert.ok(!JSON.stringify(summary).includes('private'));
});
