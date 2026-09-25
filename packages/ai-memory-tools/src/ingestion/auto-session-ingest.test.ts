import { assertValidMemoryDelta } from '@aviaratech/ai-memory/internal';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import {
  createAiMemoryWarningCollector,
  listAiMemoryWarningDetails,
  runWithAiMemoryWarningCollector,
} from '../warning-channel.js';
import {
  buildAutoIngestContinuityWarnings,
  buildAutoMemoryDelta,
  EXPLICIT_FLUSH_LOOKUP_LIMIT,
  EXPLICIT_FLUSH_LOOKUP_SQL,
  extractContinuityFromText,
  ingestAutoSessionDelta,
  lookupSessionContinuityFromPool,
  parseCodexSessionSummary,
  resolveRepoIdFromCwd,
} from './auto-session-ingest.js';

const SOURCE_WRAPPER = 'codex-wrapper';
const SOURCE_LAUNCHD = 'codex-launchd';
const SOURCE_CLAUDE = 'claude-session-end';
const DEDUPE_NAMESPACE = 'codex';
const TEST_TEMP_DIR = mkdtempSync(join(tmpdir(), 'ai-memory-ingest-test-'));

const EVIDENCE_URL = 'https://github.com/example/catalog/pull/123';
const EXPECT_DURABLE_MEMORY = 'should have at least one durable memory';
const SAMPLE_CONTEXT_NEEDED = 'Design review approval';
const SAMPLE_EVIDENCE_PATH = join(TEST_TEMP_DIR, 'note.md');
const SAMPLE_MODEL_ID = 'gpt-5.3-codex';
const SAMPLE_MODEL_RESOLUTION_STATUS = 'resolved';
const SAMPLE_NEXT_ACTION = 'Wire up error handling';
const SAMPLE_OPEN_QUESTION = 'Which auth strategy?';
const SAMPLE_REQUESTED_MODEL = 'codex-spark';
const SAMPLE_RESOLVED_MODEL = 'gpt-5.3-codex';
const SAMPLE_SESSION_FILE_PATH = join(TEST_TEMP_DIR, 'session.jsonl');
const SAMPLE_TRANSCRIPT_PATH = join(TEST_TEMP_DIR, 'transcript.jsonl');

const BASE_INPUT = {
  agent: 'codex-cli',
  assistantMessage: 'Done.',
  createdAt: '2026-02-08T12:00:00.000Z',
  cwd: TEST_TEMP_DIR,
  eventReason: 'post-session',
  model: SAMPLE_MODEL_ID,
  repoId: 'example/catalog',
  sessionFilePath: SAMPLE_SESSION_FILE_PATH,
  sessionId: 'test-session-001',
  toolCallCount: 3,
  userMessage: 'Fix the bug.',
};

test('buildAutoMemoryDelta persists requested/resolved model metadata', () => {
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    modelResolutionStatus: SAMPLE_MODEL_RESOLUTION_STATUS,
    requestedModel: SAMPLE_REQUESTED_MODEL,
    resolvedModel: SAMPLE_RESOLVED_MODEL,
    source: SOURCE_WRAPPER,
  });

  assert.equal(delta.produced_by.model, SAMPLE_RESOLVED_MODEL);
  assert.equal(delta.produced_by.x_requested_model, SAMPLE_REQUESTED_MODEL);
  assert.equal(delta.produced_by.x_resolved_model, SAMPLE_RESOLVED_MODEL);
  assert.equal(delta.produced_by.x_model_resolution_status, SAMPLE_MODEL_RESOLUTION_STATUS);

  const artifact = delta.artifacts[0];
  assert.ok(artifact !== undefined, 'should include summary artifact');
  assert.ok(artifact.content_markdown.includes(`requested_model: ${SAMPLE_REQUESTED_MODEL}`));
  assert.ok(artifact.content_markdown.includes(`resolved_model: ${SAMPLE_RESOLVED_MODEL}`));
  assert.ok(artifact.content_markdown.includes(`model_resolution_status: ${SAMPLE_MODEL_RESOLUTION_STATUS}`));
});

test('buildAutoMemoryDelta propagates source into workflow.system', () => {
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    dedupeNamespace: DEDUPE_NAMESPACE,
    source: SOURCE_WRAPPER,
  });
  assert.equal(delta.workflow.system, SOURCE_WRAPPER);
});

test('buildAutoMemoryDelta uses dedupeNamespace for delta_id prefix', () => {
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    dedupeNamespace: DEDUPE_NAMESPACE,
    source: SOURCE_LAUNCHD,
  });
  assert.ok(
    delta.delta_id.startsWith(`${DEDUPE_NAMESPACE}-delta-`),
    `delta_id should start with dedupeNamespace prefix: ${delta.delta_id}`,
  );
});

test('buildAutoMemoryDelta uses dedupeNamespace for snapshot_id prefix', () => {
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    dedupeNamespace: DEDUPE_NAMESPACE,
    source: SOURCE_LAUNCHD,
  });
  assert.ok(
    delta.snapshot.value.snapshot_id.startsWith(`${DEDUPE_NAMESPACE}-snapshot-`),
    `snapshot_id should start with dedupeNamespace prefix: ${delta.snapshot.value.snapshot_id}`,
  );
});

test('same dedupeNamespace with different sources produces same delta_id', () => {
  const wrapperDelta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    dedupeNamespace: DEDUPE_NAMESPACE,
    source: SOURCE_WRAPPER,
  });
  const launchdDelta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    dedupeNamespace: DEDUPE_NAMESPACE,
    source: SOURCE_LAUNCHD,
  });
  assert.equal(
    wrapperDelta.delta_id,
    launchdDelta.delta_id,
    'shared dedupeNamespace should produce identical delta_id',
  );
});

test('different dedupeNamespaces produce different delta_ids', () => {
  const codexDelta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    dedupeNamespace: DEDUPE_NAMESPACE,
    source: SOURCE_WRAPPER,
  });
  const claudeDelta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    source: SOURCE_CLAUDE,
  });
  assert.notEqual(codexDelta.delta_id, claudeDelta.delta_id);
});

test('dedupeNamespace defaults to source when not provided', () => {
  const delta = buildAutoMemoryDelta({ ...BASE_INPUT, source: SOURCE_LAUNCHD });
  assert.ok(
    delta.delta_id.startsWith(`${SOURCE_LAUNCHD}-delta-`),
    `delta_id should use source as default namespace: ${delta.delta_id}`,
  );
});

test('durable memory key uses dedupeNamespace when auto promotion enabled', () => {
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    autoDurablePromotionEnabled: true,
    dedupeNamespace: DEDUPE_NAMESPACE,
    source: SOURCE_LAUNCHD,
  });
  assert.ok(delta.x_durable_memories !== undefined, 'should have durable memories');
  const memory = delta.x_durable_memories[0];
  assert.ok(memory !== undefined, 'should have at least one memory');
  assert.ok(
    memory.memory_key.startsWith(`${DEDUPE_NAMESPACE}:`),
    `memory_key should start with dedupeNamespace: ${memory.memory_key}`,
  );
});

test('durable memory tags include source (not dedupeNamespace) when auto promotion enabled', () => {
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    autoDurablePromotionEnabled: true,
    dedupeNamespace: DEDUPE_NAMESPACE,
    source: SOURCE_LAUNCHD,
  });
  const memory = delta.x_durable_memories?.[0];
  assert.ok(memory !== undefined, 'should have at least one memory');
  assert.ok(memory.tags.includes(SOURCE_LAUNCHD), `tags should contain source: ${JSON.stringify(memory.tags)}`);
});

test('durable history redacts whitespace-delimited credentials', () => {
  const credentialMarker = 'synthetic-value-4821';
  const quotedCredentialMarker = 'quoted-value-7391';
  const quotedMultiwordCredentialMarker = 'quoted phrase-marker-6194';
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    autoDurablePromotionEnabled: true,
    history: [
      {
        content: `Password ${credentialMarker} must not persist.`,
        role: 'user',
        timestamp: '2026-02-08T12:00:00.000Z',
        turnId: 'turn-1',
      },
      {
        content: `Password "${quotedCredentialMarker}" must not persist.`,
        role: 'user',
        timestamp: '2026-02-08T12:01:00.000Z',
        turnId: 'turn-2',
      },
      {
        content: `Password "${quotedMultiwordCredentialMarker}" must not persist.`,
        role: 'user',
        timestamp: '2026-02-08T12:02:00.000Z',
        turnId: 'turn-3',
      },
    ],
    source: SOURCE_LAUNCHD,
  });
  const history = delta.x_durable_memories?.filter(candidate => candidate.tags.includes('session-history')) ?? [];

  assert.equal(history.length, 3, 'should have durable history memories');
  for (const memory of history) {
    assert.doesNotMatch(memory.content, new RegExp(credentialMarker, 'u'));
    assert.doesNotMatch(memory.content, new RegExp(quotedCredentialMarker, 'u'));
    assert.doesNotMatch(memory.content, new RegExp(quotedMultiwordCredentialMarker, 'u'));
    assert.match(memory.content, /\[REDACTED_SECRET_VALUE\]/u);
  }
});

test('durable history redacts quoted JSON credential values without discarding ordinary fields', () => {
  const credentialCases = [
    { key: 'password', value: 'synthetic-json-password phrase' },
    { key: 'api_key', value: 'synthetic-json-api-key' },
    { key: 'authorization', value: 'Bearer synthetic-json-authorization' },
    { key: 'client-secret', value: 'synthetic-json-client-secret "quoted suffix"' },
  ];
  const ordinaryValue = 'ordinary JSON context survives';
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    autoDurablePromotionEnabled: true,
    history: credentialCases.map(({ key, value }, index) => ({
      content: JSON.stringify({ description: ordinaryValue, [key]: value, token: 'synthetic-json-second-value' }),
      role: 'user',
      turnId: `quoted-json-${String(index)}`,
    })),
    source: SOURCE_LAUNCHD,
  });
  const history = delta.x_durable_memories?.filter(memory => memory.tags.includes('session-history')) ?? [];

  assert.equal(history.length, credentialCases.length);
  for (const memory of history) {
    assert.equal(memory.content.includes('synthetic-json-'), false, 'JSON credential material must not persist');
    assert.equal(memory.content.includes('quoted suffix'), false, 'escaped quoted values must be redacted fully');
    assert.ok(memory.content.includes('[REDACTED_SECRET_VALUE]'));
    assert.ok(memory.content.includes(ordinaryValue), 'ordinary JSON fields remain useful');
  }
});

test('append_events summary excludes source to ensure idempotent payloads across ingestion paths', () => {
  const wrapperDelta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    dedupeNamespace: DEDUPE_NAMESPACE,
    source: SOURCE_WRAPPER,
  });
  const launchdDelta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    dedupeNamespace: DEDUPE_NAMESPACE,
    source: SOURCE_LAUNCHD,
  });
  const wrapperCheckpoint = wrapperDelta.append_events.find(e => e.type === 'checkpoint');
  const launchdCheckpoint = launchdDelta.append_events.find(e => e.type === 'checkpoint');
  assert.ok(wrapperCheckpoint !== undefined, 'wrapper should have checkpoint event');
  assert.ok(launchdCheckpoint !== undefined, 'launchd should have checkpoint event');
  assert.equal(
    wrapperCheckpoint.summary,
    launchdCheckpoint.summary,
    'checkpoint summaries must be identical for idempotent event payloads',
  );
});

test('no durable memories when auto promotion disabled', () => {
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    autoDurablePromotionEnabled: false,
    dedupeNamespace: DEDUPE_NAMESPACE,
    source: SOURCE_LAUNCHD,
  });
  assert.equal(delta.x_durable_memories, undefined);
});

test('session-summary ttl_days defaults to 14 when no override provided', () => {
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    autoDurablePromotionEnabled: true,
    dedupeNamespace: DEDUPE_NAMESPACE,
    source: SOURCE_LAUNCHD,
  });
  const memory = delta.x_durable_memories?.[0];
  assert.ok(memory !== undefined, EXPECT_DURABLE_MEMORY);
  assert.equal(memory.ttl_days, 14, 'default ttl_days should be 14');
});

test('session-summary ttl_days respects sessionSummaryTtlDays input override', () => {
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    autoDurablePromotionEnabled: true,
    dedupeNamespace: DEDUPE_NAMESPACE,
    sessionSummaryTtlDays: 7,
    source: SOURCE_LAUNCHD,
  });
  const memory = delta.x_durable_memories?.[0];
  assert.ok(memory !== undefined, EXPECT_DURABLE_MEMORY);
  assert.equal(memory.ttl_days, 7, 'ttl_days should match input override');
});

test('session-summary ttl_days respects AI_MEMORY_RETENTION_SESSION_SUMMARY_DAYS env var', () => {
  const originalEnv = process.env.AI_MEMORY_RETENTION_SESSION_SUMMARY_DAYS;
  try {
    process.env.AI_MEMORY_RETENTION_SESSION_SUMMARY_DAYS = '21';
    const delta = buildAutoMemoryDelta({
      ...BASE_INPUT,
      autoDurablePromotionEnabled: true,
      dedupeNamespace: DEDUPE_NAMESPACE,
      source: SOURCE_LAUNCHD,
    });
    const memory = delta.x_durable_memories?.[0];
    assert.ok(memory !== undefined, EXPECT_DURABLE_MEMORY);
    assert.equal(memory.ttl_days, 21, 'ttl_days should match env var override');
  } finally {
    if (originalEnv === undefined) {
      delete process.env.AI_MEMORY_RETENTION_SESSION_SUMMARY_DAYS;
    } else {
      process.env.AI_MEMORY_RETENTION_SESSION_SUMMARY_DAYS = originalEnv;
    }
  }
});

test('session-summary ttl_days input override takes precedence over env var', () => {
  const originalEnv = process.env.AI_MEMORY_RETENTION_SESSION_SUMMARY_DAYS;
  try {
    process.env.AI_MEMORY_RETENTION_SESSION_SUMMARY_DAYS = '21';
    const delta = buildAutoMemoryDelta({
      ...BASE_INPUT,
      autoDurablePromotionEnabled: true,
      dedupeNamespace: DEDUPE_NAMESPACE,
      sessionSummaryTtlDays: 5,
      source: SOURCE_LAUNCHD,
    });
    const memory = delta.x_durable_memories?.[0];
    assert.ok(memory !== undefined, EXPECT_DURABLE_MEMORY);
    assert.equal(memory.ttl_days, 5, 'input override should take precedence over env var');
  } finally {
    if (originalEnv === undefined) {
      delete process.env.AI_MEMORY_RETENTION_SESSION_SUMMARY_DAYS;
    } else {
      process.env.AI_MEMORY_RETENTION_SESSION_SUMMARY_DAYS = originalEnv;
    }
  }
});

test('malformed TTL env does not throw when durable promotion is disabled', () => {
  const originalEnv = process.env.AI_MEMORY_RETENTION_SESSION_SUMMARY_DAYS;
  try {
    process.env.AI_MEMORY_RETENTION_SESSION_SUMMARY_DAYS = 'not-a-number';
    const delta = buildAutoMemoryDelta({
      ...BASE_INPUT,
      autoDurablePromotionEnabled: false,
      dedupeNamespace: DEDUPE_NAMESPACE,
      source: SOURCE_LAUNCHD,
    });
    assert.equal(delta.x_durable_memories, undefined);
  } finally {
    if (originalEnv === undefined) {
      delete process.env.AI_MEMORY_RETENTION_SESSION_SUMMARY_DAYS;
    } else {
      process.env.AI_MEMORY_RETENTION_SESSION_SUMMARY_DAYS = originalEnv;
    }
  }
});

test('malformed unrelated retention env does not throw when durable promotion is disabled', () => {
  const originalBatch = process.env.AI_MEMORY_RETENTION_BATCH_SIZE;
  try {
    process.env.AI_MEMORY_RETENTION_BATCH_SIZE = 'invalid';
    const delta = buildAutoMemoryDelta({
      ...BASE_INPUT,
      autoDurablePromotionEnabled: false,
      dedupeNamespace: DEDUPE_NAMESPACE,
      source: SOURCE_LAUNCHD,
    });
    assert.equal(delta.x_durable_memories, undefined);
  } finally {
    if (originalBatch === undefined) {
      delete process.env.AI_MEMORY_RETENTION_BATCH_SIZE;
    } else {
      process.env.AI_MEMORY_RETENTION_BATCH_SIZE = originalBatch;
    }
  }
});

// --- Continuity fields ---

test('snapshot populates next_actions when provided', () => {
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    nextActions: ['Run final integration tests', 'Publish PR'],
    source: SOURCE_CLAUDE,
  });
  assert.deepEqual(delta.snapshot.value.next_actions, ['Run final integration tests', 'Publish PR']);
});

test('snapshot populates context_needed when provided', () => {
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    contextNeeded: ['PR review feedback on #90004'],
    source: SOURCE_CLAUDE,
  });
  assert.deepEqual(delta.snapshot.value.context_needed, ['PR review feedback on #90004']);
});

test('snapshot populates open_questions when provided', () => {
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    openQuestions: ['Should we use singleton or context for state?'],
    source: SOURCE_CLAUDE,
  });
  assert.deepEqual(delta.snapshot.value.open_questions, ['Should we use singleton or context for state?']);
});

test('snapshot continuity fields default to empty arrays when not provided', () => {
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    source: SOURCE_CLAUDE,
  });
  assert.deepEqual(delta.snapshot.value.next_actions, []);
  assert.deepEqual(delta.snapshot.value.context_needed, []);
  assert.deepEqual(delta.snapshot.value.open_questions, []);
});

test('snapshot related_links converts transcript path to file:// URI', () => {
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    source: SOURCE_CLAUDE,
    transcriptPath: SAMPLE_TRANSCRIPT_PATH,
  });
  const links = delta.snapshot.value.anchors.related_links;
  const transcriptLink = links.find(l => l.label === 'transcript');
  assert.ok(transcriptLink !== undefined, 'should include transcript link');
  assert.ok(transcriptLink.url.startsWith('file:///'), `transcript url should be a file:// URI: ${transcriptLink.url}`);
  assert.ok(transcriptLink.url.includes('transcript.jsonl'), 'transcript url should contain the filename');
});

test('snapshot related_links converts session file path to file:// URI', () => {
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    source: SOURCE_CLAUDE,
  });
  const links = delta.snapshot.value.anchors.related_links;
  const sessionLink = links.find(l => l.label === 'session_file');
  assert.ok(sessionLink !== undefined, 'should include session_file link');
  assert.ok(sessionLink.url.startsWith('file:///'), `session_file url should be a file:// URI: ${sessionLink.url}`);
});

test('snapshot related_links preserves valid URL evidence refs', () => {
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    evidenceRefs: [EVIDENCE_URL],
    source: SOURCE_CLAUDE,
  });
  const links = delta.snapshot.value.anchors.related_links;
  assert.ok(
    links.some(l => l.label === 'evidence' && l.url === EVIDENCE_URL),
    'should include evidence ref link with original URL',
  );
});

test('snapshot related_links converts path evidence refs to file:// URI', () => {
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    evidenceRefs: [SAMPLE_EVIDENCE_PATH],
    source: SOURCE_CLAUDE,
  });
  const links = delta.snapshot.value.anchors.related_links;
  const evidenceLink = links.find(l => l.label === 'evidence');
  assert.ok(evidenceLink !== undefined, 'should include evidence link');
  assert.ok(
    evidenceLink.url.startsWith('file:///'),
    `evidence url should be a file:// URI for paths: ${evidenceLink.url}`,
  );
});

test('artifact markdown includes continuity sections when populated', () => {
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    contextNeeded: [SAMPLE_CONTEXT_NEEDED],
    nextActions: [SAMPLE_NEXT_ACTION],
    openQuestions: [SAMPLE_OPEN_QUESTION],
    source: SOURCE_CLAUDE,
  });
  const artifact = delta.artifacts[0];
  assert.ok(artifact !== undefined, 'should have artifact');
  assert.ok(artifact.content_markdown.includes('## Next Actions'), 'should include next actions heading');
  assert.ok(artifact.content_markdown.includes(SAMPLE_NEXT_ACTION), 'should include next action text');
  assert.ok(artifact.content_markdown.includes('## Context Needed'), 'should include context needed heading');
  assert.ok(artifact.content_markdown.includes(SAMPLE_CONTEXT_NEEDED), 'should include context text');
  assert.ok(artifact.content_markdown.includes('## Open Questions'), 'should include open questions heading');
  assert.ok(artifact.content_markdown.includes(SAMPLE_OPEN_QUESTION), 'should include question text');
});

test('artifact markdown omits empty continuity sections', () => {
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    source: SOURCE_CLAUDE,
  });
  const artifact = delta.artifacts[0];
  assert.ok(artifact !== undefined, 'should have artifact');
  assert.ok(!artifact.content_markdown.includes('## Next Actions'), 'should not include empty next actions');
  assert.ok(!artifact.content_markdown.includes('## Context Needed'), 'should not include empty context needed');
  assert.ok(!artifact.content_markdown.includes('## Open Questions'), 'should not include empty open questions');
});

test('continuity fields ignore non-string array items', () => {
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    nextActions: ['Valid action', 42, null, '', 'Another valid'],
    source: SOURCE_CLAUDE,
  });
  assert.deepEqual(delta.snapshot.value.next_actions, ['Valid action', 'Another valid']);
});

test('continuity fields return empty array for non-array input', () => {
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    nextActions: 'not an array',
    source: SOURCE_CLAUDE,
  });
  assert.deepEqual(delta.snapshot.value.next_actions, []);
});

// --- Schema validation ---

test('generated delta with path-based transcript passes schema validation', () => {
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    source: SOURCE_CLAUDE,
    transcriptPath: SAMPLE_TRANSCRIPT_PATH,
  });
  assert.doesNotThrow(() => {
    assertValidMemoryDelta(delta);
  }, 'delta with path-based transcript should pass memory_delta schema validation');
});

test('generated delta with path-based evidence refs passes schema validation', () => {
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    evidenceRefs: [SAMPLE_EVIDENCE_PATH, EVIDENCE_URL],
    source: SOURCE_CLAUDE,
  });
  assert.doesNotThrow(() => {
    assertValidMemoryDelta(delta);
  }, 'delta with mixed path/URL evidence refs should pass memory_delta schema validation');
});

test('generated delta with all continuity fields passes schema validation', () => {
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    contextNeeded: [SAMPLE_CONTEXT_NEEDED],
    evidenceRefs: [SAMPLE_EVIDENCE_PATH],
    nextActions: [SAMPLE_NEXT_ACTION],
    openQuestions: [SAMPLE_OPEN_QUESTION],
    source: SOURCE_CLAUDE,
    transcriptPath: SAMPLE_TRANSCRIPT_PATH,
  });
  assert.doesNotThrow(() => {
    assertValidMemoryDelta(delta);
  }, 'delta with all continuity fields should pass memory_delta schema validation');
});

test('malformed TTL env falls back to default when durable promotion is enabled', () => {
  const originalEnv = process.env.AI_MEMORY_RETENTION_SESSION_SUMMARY_DAYS;
  try {
    process.env.AI_MEMORY_RETENTION_SESSION_SUMMARY_DAYS = 'garbage';
    const delta = buildAutoMemoryDelta({
      ...BASE_INPUT,
      autoDurablePromotionEnabled: true,
      dedupeNamespace: DEDUPE_NAMESPACE,
      source: SOURCE_LAUNCHD,
    });
    const memory = delta.x_durable_memories?.[0];
    assert.ok(memory !== undefined, EXPECT_DURABLE_MEMORY);
    assert.equal(memory.ttl_days, 14, 'malformed env should fall back to default 14');
  } finally {
    if (originalEnv === undefined) {
      delete process.env.AI_MEMORY_RETENTION_SESSION_SUMMARY_DAYS;
    } else {
      process.env.AI_MEMORY_RETENTION_SESSION_SUMMARY_DAYS = originalEnv;
    }
  }
});

test('parseCodexSessionSummary uses model from turn_context when session_meta lacks model', () => {
  const sessionDir = mkdtempSync(join(tmpdir(), 'codex-session-summary-'));
  const sessionFile = join(sessionDir, 'session.jsonl');
  const lines = [
    JSON.stringify({
      payload: { id: 'session-001', model_provider: 'openai' },
      type: 'session_meta',
    }),
    JSON.stringify({
      payload: { model: SAMPLE_MODEL_ID },
      type: 'turn_context',
    }),
  ].join('\n');

  try {
    writeFileSync(sessionFile, lines);
    const parsed = parseCodexSessionSummary(sessionFile);
    assert.equal(parsed.sessionId, 'session-001');
    assert.equal(parsed.model, SAMPLE_MODEL_ID);
  } finally {
    rmSync(sessionDir, { force: true, recursive: true });
  }
});

test('parseCodexSessionSummary captures requested/resolved model metadata from session_meta', () => {
  const sessionDir = mkdtempSync(join(tmpdir(), 'codex-session-summary-metadata-'));
  const sessionFile = join(sessionDir, 'session.jsonl');
  const lines = [
    JSON.stringify({
      payload: {
        id: 'session-002',
        model: SAMPLE_MODEL_ID,
        model_resolution_status: SAMPLE_MODEL_RESOLUTION_STATUS,
        requested_model: SAMPLE_REQUESTED_MODEL,
        resolved_model: SAMPLE_RESOLVED_MODEL,
      },
      type: 'session_meta',
    }),
  ].join('\n');

  try {
    writeFileSync(sessionFile, lines);
    const parsed = parseCodexSessionSummary(sessionFile);
    assert.equal(parsed.sessionId, 'session-002');
    assert.equal(parsed.requestedModel, SAMPLE_REQUESTED_MODEL);
    assert.equal(parsed.resolvedModel, SAMPLE_RESOLVED_MODEL);
    assert.equal(parsed.modelResolutionStatus, SAMPLE_MODEL_RESOLUTION_STATUS);
    assert.equal(parsed.model, SAMPLE_RESOLVED_MODEL);
  } finally {
    rmSync(sessionDir, { force: true, recursive: true });
  }
});

test('parseCodexSessionSummary records warning details when malformed JSONL lines are skipped', async () => {
  const sessionDir = mkdtempSync(join(tmpdir(), 'codex-session-summary-malformed-'));
  const sessionFile = join(sessionDir, 'session.jsonl');
  const lines = ['{"type":"session_meta","payload":{"id":"session-003","model":"gpt-5.4"}}', '{not valid json'].join(
    '\n',
  );

  try {
    writeFileSync(sessionFile, lines);
    const collector = createAiMemoryWarningCollector();
    const parsed = await runWithAiMemoryWarningCollector(collector, () =>
      Promise.resolve(parseCodexSessionSummary(sessionFile)),
    );
    assert.equal(parsed.sessionId, 'session-003');
    assert.ok(
      listAiMemoryWarningDetails(collector).some(detail => detail.code === 'ingest.jsonl_line_parse_failed'),
      'should capture malformed JSONL line warning',
    );
  } finally {
    rmSync(sessionDir, { force: true, recursive: true });
  }
});

test('resolveRepoIdFromCwd records warning details when git lookup fails', async () => {
  const missingCwd = join(TEST_TEMP_DIR, 'missing-repo-dir');
  const collector = createAiMemoryWarningCollector();
  const repoId = await runWithAiMemoryWarningCollector(collector, async () => await resolveRepoIdFromCwd(missingCwd));

  assert.equal(repoId, undefined);
  assert.ok(
    listAiMemoryWarningDetails(collector).some(detail => detail.code === 'ingest.repo_id_resolution_failed'),
    'should capture repo id resolution warning',
  );
});

test('parent workspace startup remains unknown while its repository resolves from the actual cwd', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'ai-memory-parent-workspace-'));
  const repository = join(parent, 'ai');
  try {
    mkdirSync(join(repository, '.git', 'objects'), { recursive: true });
    mkdirSync(join(repository, '.git', 'refs'));
    writeFileSync(join(repository, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(
      join(repository, '.git', 'config'),
      '[remote "origin"]\nurl = https://github.com/example/catalog.git\n',
    );
    assert.equal(await resolveRepoIdFromCwd(parent), undefined);
    assert.equal(await resolveRepoIdFromCwd(repository), 'example/catalog');
    writeFileSync(join(repository, '.git', 'config'), '[remote "origin"]\nurl = git@github.com:other/ai.git\n');
    assert.equal(await resolveRepoIdFromCwd(repository), 'other/ai');
  } finally {
    rmSync(parent, { force: true, recursive: true });
  }
});

// --- extractContinuityFromText ---

// Fixture corpus: 10 representative session summary texts.
// Acceptance contract: >=6 of 10 yield next_actions, >=4 of 10 yield open_questions.
const CONTINUITY_FIXTURES: { label: string; text: string }[] = [
  {
    label: 'standard next actions and open questions',
    text: `## Summary\nImplemented the feature.\n\n## Next Actions\n- Run tests\n- Open PR\n\n## Open Questions\n- Should we cache results?`,
  },
  {
    label: 'next steps heading variant',
    text: `## What I did\nFoo.\n\n## Next Steps\n- Deploy to staging\n- Monitor logs\n\n## Questions\n- Is the DB schema final?`,
  },
  {
    label: 'action items heading variant',
    text: `## Action Items\n- Write migration\n- Update docs\n\n## Unknowns\n- Which branch to target?`,
  },
  {
    label: 'todos heading variant',
    text: `## TODOs\n1. Fix the flaky test\n2. Update changelog\n\n## Open Questions\n- Should we bump the version?`,
  },
  {
    label: 'numbered next steps',
    text: `## Next Steps\n1. Run pnpm test\n2. Check CI\n3. Merge PR\n\n## Unresolved\n- Performance impact unclear`,
  },
  {
    label: 'h1 headings',
    text: `# Next Actions\n- Review PR feedback\n\n# Open Questions\n- Auth strategy still TBD`,
  },
  {
    label: 'h3 headings',
    text: `### Next Actions\n- Finalize types\n\n### Open Questions\n- Will this break production?`,
  },
  {
    label: 'only next actions no questions',
    text: `## Next Actions\n- Write unit tests\n- Publish package`,
  },
  {
    label: 'only open questions no next actions',
    text: `## Open Questions\n- Which service owns this?\n- Is there a timeout policy?`,
  },
  {
    label: 'empty text yields nothing',
    text: '',
  },
];

test('extractContinuityFromText: fixture corpus meets coverage targets (>=6 next_actions, >=4 open_questions)', () => {
  const totalFixtures = CONTINUITY_FIXTURES.length;
  let nextActionsHits = 0;
  let openQuestionsHits = 0;

  for (const fixture of CONTINUITY_FIXTURES) {
    const result = extractContinuityFromText(fixture.text);
    if (result.nextActions.length > 0) nextActionsHits++;
    if (result.openQuestions.length > 0) openQuestionsHits++;
  }

  assert.ok(
    nextActionsHits >= 6,
    `next_actions coverage: ${String(nextActionsHits)}/${String(totalFixtures)} fixtures (need >=6)`,
  );
  assert.ok(
    openQuestionsHits >= 4,
    `open_questions coverage: ${String(openQuestionsHits)}/${String(totalFixtures)} fixtures (need >=4)`,
  );
});

test('extractContinuityFromText: empty string returns empty arrays', () => {
  const result = extractContinuityFromText('');
  assert.deepEqual(result.nextActions, []);
  assert.deepEqual(result.openQuestions, []);
});

test('extractContinuityFromText: extracts from ## Next Actions heading', () => {
  const text = '## Next Actions\n- Deploy to staging\n- Monitor logs';
  const result = extractContinuityFromText(text);
  assert.deepEqual(result.nextActions, ['Deploy to staging', 'Monitor logs']);
  assert.deepEqual(result.openQuestions, []);
});

test('extractContinuityFromText: extracts from ## Open Questions heading', () => {
  const text = '## Open Questions\n- Is the DB schema final?\n- Who owns this service?';
  const result = extractContinuityFromText(text);
  assert.deepEqual(result.nextActions, []);
  assert.deepEqual(result.openQuestions, ['Is the DB schema final?', 'Who owns this service?']);
});

test('extractContinuityFromText: heading mismatch yields nothing', () => {
  const text = '## Summary\n- Some item\n## Background\n- Another item';
  const result = extractContinuityFromText(text);
  assert.deepEqual(result.nextActions, []);
  assert.deepEqual(result.openQuestions, []);
});

test('extractContinuityFromText: caps items at 10 per section', () => {
  const items = Array.from({ length: 15 }, (_, i) => `- Item ${String(i + 1)}`).join('\n');
  const text = `## Next Actions\n${items}`;
  const result = extractContinuityFromText(text);
  assert.equal(result.nextActions.length, 10);
});

test('extractContinuityFromText: numbered list items are extracted', () => {
  const text = '## Next Steps\n1. Run tests\n2. Open PR';
  const result = extractContinuityFromText(text);
  assert.deepEqual(result.nextActions, ['Run tests', 'Open PR']);
});

test('extractContinuityFromText: explicit label lines extract continuity without markdown headings', () => {
  const text = `Done. Here is the handoff.

Next steps:
- Deploy the refreshed ai-memory plugin bundle
- Re-run health after the next session-end hook

Context needed:
- Confirm whether Claude Desktop was reloaded after plugin refresh

Open questions:
- Should the canary window be 24h or 48h?
`;

  const result = extractContinuityFromText(text);
  assert.deepEqual(result.nextActions, [
    'Deploy the refreshed ai-memory plugin bundle',
    'Re-run health after the next session-end hook',
  ]);
  assert.deepEqual(result.contextNeeded, ['Confirm whether Claude Desktop was reloaded after plugin refresh']);
  assert.deepEqual(result.openQuestions, ['Should the canary window be 24h or 48h?']);
});

test('extractContinuityFromText: bold labels with colon inside markers extract continuity', () => {
  const text = `Done. Here is the handoff.

**Next steps:**
- Ship the continuity health polish

**Context needed:**
- Use the exact startup continuity pack for debug output

**Open questions:**
- Should the debug tool include budget pressure metadata?`;

  const result = extractContinuityFromText(text);

  assert.deepEqual(result.nextActions, ['Ship the continuity health polish']);
  assert.deepEqual(result.contextNeeded, ['Use the exact startup continuity pack for debug output']);
  assert.deepEqual(result.openQuestions, ['Should the debug tool include budget pressure metadata?']);
});

// --- buildAutoMemoryDelta envModel ---

test('buildAutoMemoryDelta sets x_env_model when envModel is a plain object', () => {
  const envModel = { branch: 'main', workspaceDirty: false };
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    envModel,
    source: SOURCE_CLAUDE,
  });
  assert.deepEqual(delta.snapshot.value.x_env_model, envModel);
});

test('buildAutoMemoryDelta omits x_env_model when envModel is undefined', () => {
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    source: SOURCE_CLAUDE,
  });
  assert.equal(delta.snapshot.value.x_env_model, undefined);
});

test('buildAutoMemoryDelta omits x_env_model when envModel is null', () => {
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    envModel: null,
    source: SOURCE_CLAUDE,
  });
  assert.equal(delta.snapshot.value.x_env_model, undefined);
});

// --- buildAutoIngestContinuityWarnings ---

test('buildAutoIngestContinuityWarnings emits x_state_model warning when stateModel is absent', () => {
  const delta = buildAutoMemoryDelta({ ...BASE_INPUT, source: SOURCE_CLAUDE });
  const warnings = buildAutoIngestContinuityWarnings(delta);
  assert.ok(warnings.includes('x_state_model is missing'), 'should warn when x_state_model is absent');
});

test('buildAutoIngestContinuityWarnings does not warn about x_state_model when stateModel has a documented provenance', () => {
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    source: SOURCE_CLAUDE,
    stateModel: { assumptions: ['test'], strategy_confidence: 'medium' },
    stateModelProvenance: 'agent-authored',
  });
  const warnings = buildAutoIngestContinuityWarnings(delta);
  assert.ok(!warnings.includes('x_state_model is missing'), 'should not warn when x_state_model is a valid object');
});

test('buildAutoIngestContinuityWarnings still warns when stateModel arrived without a provenance value', () => {
  // Auto-channel snapshots drop unprovenanced state models, so the continuity warning
  // surface stays accurate: from the snapshot perspective, x_state_model is missing.
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    source: SOURCE_CLAUDE,
    stateModel: { assumptions: ['caller-supplied'], strategy_confidence: 'medium' },
  });
  const warnings = buildAutoIngestContinuityWarnings(delta);
  assert.ok(
    warnings.includes('x_state_model is missing'),
    'should warn when provenance is absent and stateModel is dropped',
  );
});

test('buildAutoIngestContinuityWarnings emits x_env_model warning when envModel is absent', () => {
  const delta = buildAutoMemoryDelta({ ...BASE_INPUT, source: SOURCE_CLAUDE });
  const warnings = buildAutoIngestContinuityWarnings(delta);
  assert.ok(warnings.includes('x_env_model is missing'), 'should warn when x_env_model is absent');
});

test('buildAutoIngestContinuityWarnings does not warn about x_env_model when envModel is a plain object', () => {
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    envModel: { branch: 'main' },
    source: SOURCE_CLAUDE,
  });
  const warnings = buildAutoIngestContinuityWarnings(delta);
  assert.ok(!warnings.includes('x_env_model is missing'), 'should not warn when x_env_model is a valid object');
});

// --- ingestAutoSessionDelta overwrite guardrail ---

test('ingestAutoSessionDelta: overwrite guardrail invokes lookupContinuity with the session id', async () => {
  const capturedSessionIds: string[] = [];
  const mockLookup = (sessionId: string) => {
    capturedSessionIds.push(sessionId);
    return Promise.resolve({ nextActions: [], openQuestions: [] });
  };

  await ingestAutoSessionDelta(
    { ...BASE_INPUT, source: SOURCE_CLAUDE },
    {
      ingestMemoryDelta: () =>
        Promise.resolve({
          deltaId: 'delta-test',
          durableMemoriesStored: 0,
          eventsIngested: 0,
          sessionId: BASE_INPUT.sessionId,
        }),
      lookupContinuity: mockLookup,
    },
  );

  assert.equal(capturedSessionIds.length, 1, 'lookupContinuity should have been called once');
  assert.equal(capturedSessionIds[0], BASE_INPUT.sessionId, 'lookupContinuity should receive the session id');
});

// --- Reproduce the low-adoption shape ---

test('low-adoption shape: auto-ingest snapshot without prior flush has no x_state_model', () => {
  // Most sessions never call memory_flush, so the auto-ingest channel cannot carry
  // forward a state model. The snapshot should omit x_state_model entirely rather
  // than fabricate one.
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    source: SOURCE_CLAUDE,
  });
  assert.equal(delta.snapshot.value.x_state_model, undefined);
  assert.equal(delta.snapshot.value.x_state_model_provenance, undefined);
  assert.deepEqual(delta.snapshot.value.next_actions, []);
  assert.deepEqual(delta.snapshot.value.open_questions, []);
});

test('low-adoption shape: agent flush snapshot remains complete while auto-only snapshot is incomplete', () => {
  // Both snapshots belong to the same session, but they originate from different
  // channels: the flush snapshot is complete; the auto snapshot has nothing to
  // carry forward yet (lookup returns empty).
  const flushDelta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    nextActions: ['Run tests'],
    openQuestions: ['Should we cache?'],
    source: 'manual-flush',
    stateModel: { assumptions: ['flush'], strategy_confidence: 'high' },
    stateModelProvenance: 'agent-authored',
  });
  const autoDelta = buildAutoMemoryDelta({ ...BASE_INPUT, source: SOURCE_CLAUDE });

  // Flush snapshot is complete on all three continuity fields.
  assert.deepEqual(flushDelta.snapshot.value.next_actions, ['Run tests']);
  assert.deepEqual(flushDelta.snapshot.value.open_questions, ['Should we cache?']);
  assert.deepEqual(flushDelta.snapshot.value.x_state_model, {
    assumptions: ['flush'],
    strategy_confidence: 'high',
  });
  assert.equal(flushDelta.snapshot.value.x_state_model_provenance, 'agent-authored');

  // Auto-only snapshot is missing all three.
  assert.deepEqual(autoDelta.snapshot.value.next_actions, []);
  assert.deepEqual(autoDelta.snapshot.value.open_questions, []);
  assert.equal(autoDelta.snapshot.value.x_state_model, undefined);
  assert.equal(autoDelta.snapshot.value.x_state_model_provenance, undefined);

  // The auto delta still emits warnings so operators see the gap.
  const warnings = buildAutoIngestContinuityWarnings(autoDelta);
  assert.ok(warnings.includes('next_actions is empty'));
  assert.ok(warnings.includes('open_questions is empty'));
  assert.ok(warnings.includes('x_state_model is missing'));
});

// --- ingestAutoSessionDelta carry-forward + provenance ---

test('ingestAutoSessionDelta: carry-forward marks state_model with carry-forward provenance', async () => {
  const carriedStateModel = { assumptions: ['from prior flush'], strategy_confidence: 'medium' };
  let capturedDelta:
    | undefined
    | {
        snapshot: {
          value: {
            context_needed?: unknown;
            next_actions?: unknown;
            open_questions?: unknown;
            x_context_needed_provenance?: unknown;
            x_next_actions_provenance?: unknown;
            x_open_questions_provenance?: unknown;
            x_state_model?: unknown;
            x_state_model_provenance?: unknown;
          };
        };
      };

  await ingestAutoSessionDelta(
    { ...BASE_INPUT, source: SOURCE_CLAUDE },
    {
      ingestMemoryDelta: ({ memoryDelta }) => {
        capturedDelta = memoryDelta;
        return Promise.resolve({
          deltaId: 'delta-test',
          durableMemoriesStored: 0,
          eventsIngested: 0,
          sessionId: BASE_INPUT.sessionId,
        });
      },
      lookupContinuity: () =>
        Promise.resolve({
          contextNeeded: ['Carry this context too'],
          nextActions: ['Carry me forward'],
          openQuestions: ['And me too?'],
          stateModel: carriedStateModel,
        }),
    },
  );

  assert.ok(capturedDelta !== undefined, 'ingestMemoryDelta should be invoked');
  assert.deepEqual(capturedDelta.snapshot.value.next_actions, ['Carry me forward']);
  assert.deepEqual(capturedDelta.snapshot.value.context_needed, ['Carry this context too']);
  assert.deepEqual(capturedDelta.snapshot.value.open_questions, ['And me too?']);
  assert.equal(capturedDelta.snapshot.value.x_next_actions_provenance, 'carry-forward');
  assert.equal(capturedDelta.snapshot.value.x_context_needed_provenance, 'carry-forward');
  assert.equal(capturedDelta.snapshot.value.x_open_questions_provenance, 'carry-forward');
  assert.deepEqual(capturedDelta.snapshot.value.x_state_model, carriedStateModel);
  assert.equal(capturedDelta.snapshot.value.x_state_model_provenance, 'carry-forward');
});

test('buildAutoMemoryDelta: derived continuity fields carry derived provenance', () => {
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    contextNeeded: ['Operator must reload the plugin bundle'],
    continuityFieldProvenance: 'derived',
    nextActions: ['Run the health report after the next hook fires'],
    openQuestions: ['Did the startup hook emit continuity-pack telemetry?'],
    source: SOURCE_CLAUDE,
  });

  assert.deepEqual(delta.snapshot.value.next_actions, ['Run the health report after the next hook fires']);
  assert.deepEqual(delta.snapshot.value.context_needed, ['Operator must reload the plugin bundle']);
  assert.deepEqual(delta.snapshot.value.open_questions, ['Did the startup hook emit continuity-pack telemetry?']);
  assert.equal(delta.snapshot.value.x_next_actions_provenance, 'derived');
  assert.equal(delta.snapshot.value.x_context_needed_provenance, 'derived');
  assert.equal(delta.snapshot.value.x_open_questions_provenance, 'derived');
});

test('buildAutoMemoryDelta: derives missing continuity fields from assistant handoff sections', () => {
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    assistantMessage: `Done.

Next steps:
- Re-run the Codex launchd ingest after plugin refresh

Context needed:
- Claude auth has been refreshed for the reviewer retry

Open questions:
- Should the PR wait for a live hook sample?`,
    source: SOURCE_WRAPPER,
  });

  assert.deepEqual(delta.snapshot.value.next_actions, ['Re-run the Codex launchd ingest after plugin refresh']);
  assert.deepEqual(delta.snapshot.value.context_needed, ['Claude auth has been refreshed for the reviewer retry']);
  assert.deepEqual(delta.snapshot.value.open_questions, ['Should the PR wait for a live hook sample?']);
  assert.equal(delta.snapshot.value.x_next_actions_provenance, 'derived');
  assert.equal(delta.snapshot.value.x_context_needed_provenance, 'derived');
  assert.equal(delta.snapshot.value.x_open_questions_provenance, 'derived');
});

for (const source of [SOURCE_WRAPPER, SOURCE_LAUNCHD, SOURCE_CLAUDE]) {
  test(`ingestAutoSessionDelta: ${source} derives assistant handoff continuity`, async () => {
    let capturedDelta:
      | undefined
      | {
          snapshot: {
            value: {
              context_needed?: unknown;
              next_actions?: unknown;
              open_questions?: unknown;
              x_context_needed_provenance?: unknown;
              x_next_actions_provenance?: unknown;
              x_open_questions_provenance?: unknown;
            };
          };
        };

    await ingestAutoSessionDelta(
      {
        ...BASE_INPUT,
        assistantMessage: `Done.

## Next Steps
- Keep startup continuity on the bounded pack read

## Context Needed
- Operator re-authenticated Claude before reviewer retry

## Open Questions
- Should vector recall remain task-conditioned?`,
        source,
      },
      {
        ingestMemoryDelta: ({ memoryDelta }) => {
          capturedDelta = memoryDelta;
          return Promise.resolve({
            deltaId: 'delta-test',
            durableMemoriesStored: 0,
            eventsIngested: 0,
            sessionId: BASE_INPUT.sessionId,
          });
        },
        lookupContinuity: () => Promise.resolve({ nextActions: [], openQuestions: [] }),
      },
    );

    assert.ok(capturedDelta !== undefined, 'ingestMemoryDelta should be invoked');
    assert.deepEqual(capturedDelta.snapshot.value.next_actions, ['Keep startup continuity on the bounded pack read']);
    assert.deepEqual(capturedDelta.snapshot.value.context_needed, [
      'Operator re-authenticated Claude before reviewer retry',
    ]);
    assert.deepEqual(capturedDelta.snapshot.value.open_questions, ['Should vector recall remain task-conditioned?']);
    assert.equal(capturedDelta.snapshot.value.x_next_actions_provenance, 'derived');
    assert.equal(capturedDelta.snapshot.value.x_context_needed_provenance, 'derived');
    assert.equal(capturedDelta.snapshot.value.x_open_questions_provenance, 'derived');
  });
}

test('ingestAutoSessionDelta: no prior flush leaves state_model absent and provenance unset', async () => {
  let capturedDelta:
    | undefined
    | {
        snapshot: { value: { x_state_model?: unknown; x_state_model_provenance?: unknown } };
      };

  await ingestAutoSessionDelta(
    { ...BASE_INPUT, source: SOURCE_CLAUDE },
    {
      ingestMemoryDelta: ({ memoryDelta }) => {
        capturedDelta = memoryDelta;
        return Promise.resolve({
          deltaId: 'delta-test',
          durableMemoriesStored: 0,
          eventsIngested: 0,
          sessionId: BASE_INPUT.sessionId,
        });
      },
      lookupContinuity: () => Promise.resolve({ nextActions: [], openQuestions: [] }),
    },
  );

  assert.ok(capturedDelta !== undefined);
  assert.equal(capturedDelta.snapshot.value.x_state_model, undefined);
  assert.equal(capturedDelta.snapshot.value.x_state_model_provenance, undefined);
});

test('buildAutoMemoryDelta: invalid stateModelProvenance drops both x_state_model and provenance', () => {
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    source: SOURCE_CLAUDE,
    stateModel: { assumptions: [], strategy_confidence: 'medium' },
    stateModelProvenance: 'fabricated',
  });
  // Automatic-channel snapshots may never emit `x_state_model` without a documented
  // provenance value, so both fields are dropped together when the provenance is
  // missing or invalid. This prevents an unprovenanced state model from looking like
  // a fresh agent-authored confidence signal to downstream readers.
  assert.equal(delta.snapshot.value.x_state_model, undefined);
  assert.equal(delta.snapshot.value.x_state_model_provenance, undefined);
});

test('buildAutoMemoryDelta: missing stateModelProvenance drops x_state_model entirely', () => {
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    source: SOURCE_CLAUDE,
    stateModel: { assumptions: ['caller-supplied'], strategy_confidence: 'medium' },
  });
  assert.equal(delta.snapshot.value.x_state_model, undefined);
  assert.equal(delta.snapshot.value.x_state_model_provenance, undefined);
});

test('buildAutoMemoryDelta: stateModel paired with agent-authored provenance is preserved', () => {
  const delta = buildAutoMemoryDelta({
    ...BASE_INPUT,
    source: SOURCE_CLAUDE,
    stateModel: { assumptions: ['agent-authored'], strategy_confidence: 'high' },
    stateModelProvenance: 'agent-authored',
  });
  assert.deepEqual(delta.snapshot.value.x_state_model, {
    assumptions: ['agent-authored'],
    strategy_confidence: 'high',
  });
  assert.equal(delta.snapshot.value.x_state_model_provenance, 'agent-authored');
});

// --- extractContinuityFromText fixture cases for Codex / Claude session-end text ---

test('extractContinuityFromText: Codex-style agent summary with Next Steps + Open Questions', () => {
  // Sourced from the Codex agent_message shape used at session end; we extract only
  // the deterministic heading sections and never invent items beyond them.
  const text = `Done.

## Summary

Implemented the new flag and verified the regression with two unit tests.

## Next Steps

- Re-run the live ingest after the next deploy
- Notify the on-call channel before flipping the gate

## Open Questions

- Should we backfill historic rows now or wait?
- Is the rollout window 24h enough for canary?
`;

  const result = extractContinuityFromText(text);
  assert.deepEqual(result.nextActions, [
    'Re-run the live ingest after the next deploy',
    'Notify the on-call channel before flipping the gate',
  ]);
  assert.deepEqual(result.openQuestions, [
    'Should we backfill historic rows now or wait?',
    'Is the rollout window 24h enough for canary?',
  ]);
});

test('extractContinuityFromText: Claude session-end summary with TODOs + Unknowns', () => {
  // Sourced from a Claude session-end transcript summary.
  const text = `## What I did

Wired the warning collector through the auto-ingest path.

## TODOs

1. Surface warnings on the orient response
2. Add the per-channel breakdown to the health-report

## Unknowns

- How should the gate threshold be tuned post-merge?
`;

  const result = extractContinuityFromText(text);
  assert.deepEqual(result.nextActions, [
    'Surface warnings on the orient response',
    'Add the per-channel breakdown to the health-report',
  ]);
  assert.deepEqual(result.openQuestions, ['How should the gate threshold be tuned post-merge?']);
});

// --- lookupSessionContinuityFromPool: explicit-flush source scope ---

test('lookupSessionContinuityFromPool: SQL filters to explicit-flush source snapshots', () => {
  // The SQL must JOIN the deltas table and filter on the documented explicit-flush
  // workflow.system values. The cap is a structural safety only — the join already
  // excludes newer auto snapshots, so the cap can never push the latest explicit flush
  // out of the lookup window.
  assert.ok(EXPLICIT_FLUSH_LOOKUP_SQL.includes('JOIN ai_memory_deltas'));
  assert.ok(
    EXPLICIT_FLUSH_LOOKUP_SQL.includes(`'memory-flush', 'manual', 'manual-flush'`),
    'SQL must filter source via the explicit-flush workflow.system set',
  );
  assert.equal(EXPLICIT_FLUSH_LOOKUP_LIMIT, 50);
});

test('lookupSessionContinuityFromPool: carries forward from explicit flush even when many auto snapshots are newer', async () => {
  // The query function returns only the rows the new SQL would return — i.e. the
  // explicit flush — even though the caller scenario has hundreds of newer auto
  // snapshots in the session. The test guards the AC requirement that auto-only
  // newer activity cannot evict the explicit-flush continuity from carry-forward.
  let capturedSql: string | undefined;
  let capturedParams: [string, number] | undefined;
  const queryFn = (sql: string, params: [string, number]) => {
    capturedSql = sql;
    capturedParams = params;
    return Promise.resolve({
      rows: [
        {
          snapshot_json: {
            next_actions: ['Carry me forward'],
            open_questions: ['Carry this too?'],
            x_state_model: { assumptions: ['from prior flush'], strategy_confidence: 'medium' },
          },
        },
      ],
    });
  };

  const result = await lookupSessionContinuityFromPool('session-with-many-auto-snapshots', queryFn);

  assert.deepEqual(result.nextActions, ['Carry me forward']);
  assert.deepEqual(result.openQuestions, ['Carry this too?']);
  assert.deepEqual(result.stateModel, { assumptions: ['from prior flush'], strategy_confidence: 'medium' });
  assert.equal(capturedSql, EXPLICIT_FLUSH_LOOKUP_SQL, 'query must use the explicit-flush-scoped SQL');
  assert.deepEqual(capturedParams, ['session-with-many-auto-snapshots', EXPLICIT_FLUSH_LOOKUP_LIMIT]);
});

test('lookupSessionContinuityFromPool: scans multiple explicit flushes for the first non-empty value per field', async () => {
  // When the latest explicit flush is missing one of the fields (e.g. open_questions),
  // the lookup walks older explicit-flush rows to find the first non-empty value, but
  // only across the explicit-flush source set.
  const queryFn = () =>
    Promise.resolve({
      rows: [
        {
          snapshot_json: {
            next_actions: ['Newest flush actions'],
            open_questions: [],
            x_state_model: { strategy_confidence: 'high' },
          },
        },
        {
          snapshot_json: {
            next_actions: [],
            open_questions: ['Older flush question'],
          },
        },
      ],
    });

  const result = await lookupSessionContinuityFromPool('session-with-mixed-completeness', queryFn);

  assert.deepEqual(result.nextActions, ['Newest flush actions']);
  assert.deepEqual(result.openQuestions, ['Older flush question']);
  assert.deepEqual(result.stateModel, { strategy_confidence: 'high' });
});

test('lookupSessionContinuityFromPool: empty explicit-flush set yields empty result, not a fabricated state model', async () => {
  const queryFn = () => Promise.resolve({ rows: [] });
  const result = await lookupSessionContinuityFromPool('session-without-explicit-flush', queryFn);
  assert.deepEqual(result.nextActions, []);
  assert.deepEqual(result.openQuestions, []);
  assert.equal(result.stateModel, undefined);
});

test('extractContinuityFromText: never fabricates from prose without explicit headings', () => {
  // The text mentions next steps and open questions conversationally but never under
  // recognized headings. Deterministic extraction must yield nothing.
  const text = `We will work on a refactor next and also wonder whether the schema needs to change.`;
  const result = extractContinuityFromText(text);
  assert.deepEqual(result.nextActions, []);
  assert.deepEqual(result.openQuestions, []);
});
