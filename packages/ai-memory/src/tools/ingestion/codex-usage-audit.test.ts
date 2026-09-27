import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { auditCodexUsage } from './codex-usage-audit.js';

const timestamp = '2026-09-10T10:00:00.000Z';
const usage = { cached_input_tokens: 80, input_tokens: 100, output_tokens: 20, reasoning_output_tokens: 5 };
function response(id: string, thread = 'task-1') {
  return {
    payload: {
      response_id: id,
      thread_id: thread,
      thread_token_usage: { input_tokens: 999999 },
      turn_id: 'turn-1',
      usage,
    },
    timestamp,
    type: 'token_usage_record',
  };
}
function runAudit(entries: unknown[], role?: 'lead' | 'reviewer' | 'worker') {
  const dir = mkdtempSync(join(tmpdir(), 'codex-audit-'));
  try {
    const file = join(dir, 'secret-file-name.jsonl');
    writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n'));
    return auditCodexUsage({
      sessions: [{ file, role }],
      since: '2026-09-10T00:00:00Z',
      until: '2026-09-11T00:00:00Z',
    });
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}
test('audit deduplicates individual response usage and rejects cross-task records rather than summing cumulative counters', () => {
  const report = runAudit(
    [
      { payload: { cli_version: '0.153.4', id: 'task-1' }, type: 'session_meta' },
      { payload: { effort: 'medium', model: 'gpt-6-astra', turn_id: 'turn-1' }, type: 'turn_context' },
      response('r1'),
      response('r1'),
      response('r2'),
      response('other', 'task-2'),
      {
        payload: { info: { total_token_usage: { input_tokens: 999999 } }, type: 'token_count' },
        timestamp,
        type: 'event_msg',
      },
      { payload: { message: 'secret prompt' }, timestamp, type: 'compacted' },
    ],
    'worker',
  );
  assert.deepEqual(report.totals, {
    cachedInput: 160,
    input: 200,
    output: 40,
    reasoningOutput: 10,
    responses: 2,
    uncachedInput: 40,
  });
  assert.equal(report.duplicateResponses, 1);
  assert.equal(report.crossTaskResponses, 1);
  assert.equal(report.compactions, 1);
  assert.ok(report.byAttribution[0]);
  assert.equal(report.byAttribution[0].model, 'gpt-6-astra');
  assert.equal(report.byAttribution[0].effort, 'medium');
  assert.equal(report.byAttribution[0].role, 'worker');
});
test('audit emits aggregates and hashes only even when prompt, output, paths, and metadata contain secrets', () => {
  const report = runAudit([
    {
      payload: {
        base_instructions: 'SECRET_CREDENTIAL',
        cli_version: 'SECRET_CREDENTIAL',
        id: 'task-1',
        model: 'SECRET_CREDENTIAL',
      },
      type: 'session_meta',
    },
    {
      payload: { output: 'SECRET_CREDENTIAL'.repeat(2000), type: 'function_call_output' },
      timestamp,
      type: 'response_item',
    },
    response('SECRET_CREDENTIAL'),
  ]);
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes('SECRET_CREDENTIAL'));
  assert.ok(!serialized.includes('secret-file-name'));
  assert.ok(report.byAttribution[0]);
  assert.equal(report.byAttribution[0].model, 'unknown');
  assert.equal(report.byAttribution[0].role, 'unknown');
  assert.equal(report.byAttribution[0].effort, 'unknown');
  assert.equal(report.toolOutputs.over20000Chars, 1);
  assert.equal(report.queueMs, null);
  assert.equal(report.executionMs, null);
});
test('audit excludes out-of-window and invalid usage, leaving incomplete categories unknown', () => {
  const report = runAudit([
    { payload: { id: 'task-1' }, type: 'session_meta' },
    { ...response('old'), timestamp: '2026-09-09T10:00:00Z' },
    { ...response('end'), timestamp: '2026-09-11T00:00:00Z' },
    {
      payload: { response_id: 'missing', thread_id: 'task-1', usage: { input_tokens: 50, output_tokens: 5 } },
      timestamp,
      type: 'token_usage_record',
    },
  ]);
  assert.equal(report.totals.responses, 1);
  assert.equal(report.totals.cachedInput, null);
  assert.equal(report.totals.uncachedInput, null);
  assert.equal(report.totals.reasoningOutput, null);
});

test('audit preserves recorded metadata when turn fields are absent', () => {
  const report = runAudit([
    { payload: { effort: 'medium', id: 'task-1', requested_model: 'gpt-6-astra' }, type: 'session_meta' },
    { payload: { model: 'gpt-6-astra', turn_id: 'turn-1' }, type: 'turn_context' },
    response('r1'),
  ]);
  assert.ok(report.byAttribution[0]);
  assert.equal(report.byAttribution[0].requestedModel, 'gpt-6-astra');
  assert.equal(report.byAttribution[0].effort, 'medium');
});

test('audit malformed lines never create a persistent log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-audit-log-'));
  const previous = process.env.AI_MEMORY_LOG_FILE;
  try {
    const file = join(dir, 'session.jsonl');
    const log = join(dir, 'audit.log');
    process.env.AI_MEMORY_LOG_FILE = log;
    writeFileSync(file, `not-json\n${JSON.stringify({ payload: { id: 'task-1' }, type: 'session_meta' })}`);
    const report = auditCodexUsage({
      sessions: [{ file }],
      since: '2026-09-10T00:00:00Z',
      until: '2026-09-11T00:00:00Z',
    });
    assert.equal(existsSync(log), false);
    assert.equal(report.malformedLines, 1);
  } finally {
    if (previous === undefined) delete process.env.AI_MEMORY_LOG_FILE;
    else process.env.AI_MEMORY_LOG_FILE = previous;
    rmSync(dir, { force: true, recursive: true });
  }
});
