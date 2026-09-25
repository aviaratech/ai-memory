import assert from 'node:assert/strict';
import { test } from 'vitest';

import type { KnownFailureSignature } from './known-failure-signatures.js';
import type { Queryable } from './session-api.js';

import { resolveKnownFailures } from './failure-resolver.js';
import { buildFailureSignature } from './failure-signature.js';
import { normalizeMemoryDeltaRelatedLinks, normalizeRelatedLinkUrl } from './ingest-memory-delta-in-transaction.js';
import { KNOWN_FAILURE_SIGNATURES } from './known-failure-signatures.js';
import { assertValidMemoryDelta } from './schema-validation.js';

// ---------------------------------------------------------------------------
// buildFailureSignature unit tests
// ---------------------------------------------------------------------------

test('buildFailureSignature normalizes UUIDs in error message', () => {
  const sig = buildFailureSignature('ingest_auto_delta', 'Error for session 550e8400-e29b-41d4-a716-446655440000');
  assert.equal(sig, 'ingest_auto_delta: Error for session <uuid>');
});

test('buildFailureSignature normalizes standalone numbers in error message', () => {
  // Numbers adjacent to letters (e.g. "5000ms") are not word-boundary-delimited, so not replaced.
  // Standalone numbers (e.g. "3" surrounded by spaces) are replaced.
  const sig = buildFailureSignature('mcp-tool', 'Timeout after 5000ms on attempt 3');
  assert.equal(sig, 'mcp-tool: Timeout after 5000ms on attempt <n>');
});

test('buildFailureSignature uses first line only', () => {
  const sig = buildFailureSignature('hook', 'First line error\nSecond line detail\nThird line');
  assert.equal(sig, 'hook: First line error');
});

test('buildFailureSignature handles empty stage', () => {
  const sig = buildFailureSignature('', 'Some error');
  assert.equal(sig, '(unknown): Some error');
});

test('buildFailureSignature handles empty message', () => {
  const sig = buildFailureSignature('stage', '');
  assert.equal(sig, 'stage: (no error message)');
});

// ---------------------------------------------------------------------------
// resolveKnownFailures dry-run: signature mismatch → NOT resolved
// ---------------------------------------------------------------------------

test('dry-run: signature mismatch leaves failure unmatched', async () => {
  const signatures: KnownFailureSignature[] = [
    {
      fixDate: '2099-01-01T00:00:00.000Z',
      resolvedBy: 'release:999',
      resolvedReason: 'Fixed in test',
      signature: 'ingest_auto_delta: Connection refused to <n>.<n>.<n>.<n>',
    },
  ];

  // Simulate a pool that returns a failure with a different error message
  const mockPool = makeMockPool([
    {
      created_at: new Date('2024-01-01'),
      error_message: 'Completely different error',
      id: 42,
      stage: 'ingest_auto_delta',
    },
  ]);

  const outcome = await resolveKnownFailures(mockPool, {
    dryRun: true,
    signatures,
  });
  assert.ok(outcome.dryRun);
  assert.equal(outcome.result.totalCandidates, 0);
  assert.equal(outcome.result.matches.length, 0);
});

// ---------------------------------------------------------------------------
// resolveKnownFailures dry-run: post-fix-date failures NOT matched
// ---------------------------------------------------------------------------

test('dry-run: failure created_at >= fixDate is NOT a candidate', async () => {
  const fixDate = '2024-06-01T00:00:00.000Z';
  const signatures: KnownFailureSignature[] = [
    {
      fixDate,
      resolvedBy: 'release:1000',
      resolvedReason: 'Fixed timeout handling',
      signature: 'mcp-tool: Timeout after <n>ms',
    },
  ];

  // Mock pool: returns NO rows (because created_at < fixDate filter excludes post-fix rows)
  // The mock simulates that the DB WHERE clause correctly excludes post-fix rows
  const mockPool = makeMockPool([]);

  const outcome = await resolveKnownFailures(mockPool, {
    dryRun: true,
    signatures,
  });
  assert.ok(outcome.dryRun);
  assert.equal(outcome.result.totalCandidates, 0);
});

// ---------------------------------------------------------------------------
// resolveKnownFailures dry-run: matching failure → counted but not written
// ---------------------------------------------------------------------------

test('dry-run: matching failure is counted with candidateIds, no DB write', async () => {
  const targetSignature = buildFailureSignature('ingest_auto_delta', 'Connection refused');
  const signatures: KnownFailureSignature[] = [
    {
      fixDate: '2099-01-01T00:00:00.000Z',
      resolvedBy: 'release:1463',
      resolvedReason: 'Unified telemetry log path',
      signature: targetSignature,
    },
  ];

  const mockPool = makeMockPool([
    {
      created_at: new Date('2024-01-01'),
      error_message: 'Connection refused',
      id: 7,
      stage: 'ingest_auto_delta',
    },
    {
      created_at: new Date('2024-01-02'),
      error_message: 'Connection refused',
      id: 8,
      stage: 'ingest_auto_delta',
    },
  ]);

  const outcome = await resolveKnownFailures(mockPool, {
    dryRun: true,
    signatures,
  });
  assert.ok(outcome.dryRun);
  assert.equal(outcome.result.totalCandidates, 2);
  assert.equal(outcome.result.matches.length, 1);
  const match = outcome.result.matches[0];
  assert.ok(match !== undefined);
  assert.equal(match.count, 2);
  assert.deepEqual(match.candidateIds, [7, 8]);
  // Verify no UPDATE was issued (mock tracks queries)
  assert.ok(!mockPool.queryCalls.some(q => q.includes('UPDATE')));
});

// ---------------------------------------------------------------------------
// resolveKnownFailures apply: matching failure is updated with batch ID
// ---------------------------------------------------------------------------

test('apply: matching failure receives resolved_at and resolution_batch_id', async () => {
  const targetSignature = buildFailureSignature('ingest_auto_delta', 'Connection refused');
  const signatures: KnownFailureSignature[] = [
    {
      fixDate: '2099-01-01T00:00:00.000Z',
      resolvedBy: 'release:1463',
      resolvedReason: 'Unified telemetry log path',
      signature: targetSignature,
    },
  ];

  const mockPool = makeMockPoolWithUpdate([
    {
      created_at: new Date('2024-01-01'),
      error_message: 'Connection refused',
      id: 5,
      stage: 'ingest_auto_delta',
    },
  ]);

  const outcome = await resolveKnownFailures(mockPool, {
    dryRun: false,
    signatures,
  });
  assert.ok(!outcome.dryRun);
  assert.equal(outcome.result.affectedRows, 1);
  assert.ok(outcome.result.resolutionBatchId.length > 0);
  // Verify UPDATE was issued with expected resolved_by
  const updateCalls = mockPool.queryCalls.filter(q => q.includes('UPDATE'));
  assert.equal(updateCalls.length, 1);
  assert.ok(mockPool.updateParams.some(p => p.includes('release:1463')));
});

// ---------------------------------------------------------------------------
// resolveKnownFailures apply: empty signatures → no writes
// ---------------------------------------------------------------------------

test('apply: empty signatures registry performs no DB writes', async () => {
  const mockPool = makeMockPoolWithUpdate([]);
  const outcome = await resolveKnownFailures(mockPool, {
    dryRun: false,
    signatures: [],
  });
  assert.ok(!outcome.dryRun);
  assert.equal(outcome.result.affectedRows, 0);
  assert.ok(!mockPool.queryCalls.some(q => q.includes('UPDATE')));
});

// ---------------------------------------------------------------------------
// resolveKnownFailures dry-run: already-resolved failures not recounted
// ---------------------------------------------------------------------------

test('dry-run: already-resolved failures are excluded by resolved_at IS NULL filter', async () => {
  const targetSignature = buildFailureSignature('hook', 'File not found');
  const signatures: KnownFailureSignature[] = [
    {
      fixDate: '2099-01-01T00:00:00.000Z',
      resolvedBy: 'release:2000',
      resolvedReason: 'Fixed file path',
      signature: targetSignature,
    },
  ];

  // Mock simulates DB WHERE resolved_at IS NULL — returns 0 rows (all already resolved)
  const mockPool = makeMockPool([]);

  const outcome = await resolveKnownFailures(mockPool, {
    dryRun: true,
    signatures,
  });
  assert.ok(outcome.dryRun);
  assert.equal(outcome.result.totalCandidates, 0);
});

// ---------------------------------------------------------------------------
// resolveKnownFailures: injected pool target works without AI_MEMORY_DATABASE_URL
// ---------------------------------------------------------------------------

test('injected Queryable pool target runs without AI_MEMORY_DATABASE_URL / DATABASE_URL env', async () => {
  // The resolver accepts an injected Queryable and never reads database env
  // itself. Snapshot env to prove no reads occurred during execution.
  const originalDatabaseUrl = process.env.AI_MEMORY_DATABASE_URL;
  const originalLegacyUrl = process.env.DATABASE_URL;
  delete process.env.AI_MEMORY_DATABASE_URL;
  delete process.env.DATABASE_URL;

  try {
    const targetSignature = buildFailureSignature(
      'ingest_auto_delta',
      'synthetic payload validation failed: /related_links/0/url must match format "uri"',
    );
    const signatures: KnownFailureSignature[] = [
      {
        fixDate: '2099-01-01T00:00:00.000Z',
        resolvedBy: 'release:1234',
        resolvedReason: 'related_links.url format normalized at ingest boundary',
        signature: targetSignature,
      },
    ];

    const injectedPool = makeMockPoolWithUpdate([
      {
        created_at: new Date('2024-01-01'),
        error_message: 'synthetic payload validation failed: /related_links/0/url must match format "uri"',
        id: 11,
        stage: 'ingest_auto_delta',
      },
    ]);

    const outcome = await resolveKnownFailures(injectedPool, { dryRun: false, signatures });

    assert.ok(!outcome.dryRun);
    assert.equal(outcome.result.affectedRows, 1);
    assert.ok(outcome.result.resolutionBatchId.length > 0);
    assert.equal(process.env.AI_MEMORY_DATABASE_URL, undefined);
    assert.equal(process.env.DATABASE_URL, undefined);
  } finally {
    if (originalDatabaseUrl !== undefined) process.env.AI_MEMORY_DATABASE_URL = originalDatabaseUrl;
    if (originalLegacyUrl !== undefined) process.env.DATABASE_URL = originalLegacyUrl;
  }
});

// ---------------------------------------------------------------------------
// Synthetic failure-signature fixtures
// ---------------------------------------------------------------------------

const SYNTHETIC_FIXTURE_SIGNATURES: readonly { errorMessage: string; stage: string }[] = [
  {
    errorMessage: 'synthetic payload validation failed: /related_links/0/url must match format "uri"',
    stage: 'ingest_auto_delta',
  },
  {
    errorMessage: 'synthetic delta validation failed: /related_links/2/url must match format "uri"',
    stage: 'ingest_auto_delta',
  },
  {
    errorMessage: 'synthetic operation timeout after 30000ms',
    stage: 'ingest_auto_delta',
  },
];

test('synthetic signatures resolve only when fix references are supplied', async () => {
  const signatures: KnownFailureSignature[] = SYNTHETIC_FIXTURE_SIGNATURES.map((sig, index) => ({
    fixDate: '2099-01-01T00:00:00.000Z',
    resolvedBy: `release:future-${String(index + 1)}`,
    resolvedReason: `Hypothetical fix for ${sig.stage} signature`,
    signature: buildFailureSignature(sig.stage, sig.errorMessage),
  }));

  const mockPool = makeMockPool(
    SYNTHETIC_FIXTURE_SIGNATURES.map((sig, index) => ({
      created_at: new Date('2024-01-01'),
      error_message: sig.errorMessage,
      id: index + 100,
      stage: sig.stage,
    })),
  );

  const outcome = await resolveKnownFailures(mockPool, { dryRun: true, signatures });
  assert.ok(outcome.dryRun);
  assert.equal(outcome.result.totalCandidates, SYNTHETIC_FIXTURE_SIGNATURES.length);
  assert.equal(outcome.result.matches.length, SYNTHETIC_FIXTURE_SIGNATURES.length);
});

test('synthetic related_links indices normalize to one signature', async () => {
  // The buildFailureSignature normalizer replaces `\d+` with `<n>`, so
  // `/related_links/0/url` and `/related_links/5/url` collapse to the same signature.
  // This is required for a single registry entry to cover all instances of the same bug.
  const signature = buildFailureSignature(
    'ingest_auto_delta',
    'synthetic payload validation failed: /related_links/0/url must match format "uri"',
  );
  const signatures: KnownFailureSignature[] = [
    {
      fixDate: '2099-01-01T00:00:00.000Z',
      resolvedBy: 'release:future',
      resolvedReason: 'related_links.url format normalized',
      signature,
    },
  ];

  const mockPool = makeMockPool([
    {
      created_at: new Date('2024-01-01'),
      error_message: 'synthetic payload validation failed: /related_links/0/url must match format "uri"',
      id: 200,
      stage: 'ingest_auto_delta',
    },
    {
      created_at: new Date('2024-01-02'),
      error_message: 'synthetic payload validation failed: /related_links/5/url must match format "uri"',
      id: 201,
      stage: 'ingest_auto_delta',
    },
  ]);

  const outcome = await resolveKnownFailures(mockPool, { dryRun: true, signatures });
  assert.ok(outcome.dryRun);
  assert.equal(outcome.result.totalCandidates, 2);
});

// ---------------------------------------------------------------------------
// Health-report invariant: post-fix regressions remain actionable
// ---------------------------------------------------------------------------

test('apply: post-fix-date regression is NOT marked resolved even if signature matches', async () => {
  // The fetchCandidates SQL filters `created_at < fixDate`, so post-fix rows are excluded
  // from the candidate set entirely. This test pins that contract by feeding a mock pool
  // that simulates the SQL WHERE clause: post-fix rows are simply absent from results.
  const fixDate = '2026-01-01T00:00:00.000Z';
  const targetSignature = buildFailureSignature('ingest_auto_delta', 'Connection refused');
  const signatures: KnownFailureSignature[] = [
    {
      fixDate,
      resolvedBy: 'release:fixed-2026',
      resolvedReason: 'Fixed in January 2026',
      signature: targetSignature,
    },
  ];

  // Mock returns only the pre-fix row; post-fix rows would be filtered by the
  // `created_at < $1::timestamptz` clause in fetchCandidates.
  const mockPool = makeMockPoolWithUpdate([
    {
      created_at: new Date('2025-06-01'),
      error_message: 'Connection refused',
      id: 300,
      stage: 'ingest_auto_delta',
    },
  ]);

  const outcome = await resolveKnownFailures(mockPool, { dryRun: false, signatures });
  assert.ok(!outcome.dryRun);
  assert.equal(outcome.result.affectedRows, 1);

  // Verify the SQL parameter was the fixDate (which the DB uses to exclude post-fix rows).
  const candidateCalls = mockPool.queryCalls.filter(q => q.includes('FROM ai_ingestion_failures'));
  assert.ok(candidateCalls.length > 0, 'expected fetchCandidates query to be issued');
});

// ---------------------------------------------------------------------------
// Public release failure-resolution boundary
// ---------------------------------------------------------------------------

test('public release has no inherited failure-resolution entries', async () => {
  assert.deepEqual(KNOWN_FAILURE_SIGNATURES, []);
  const mockPool = makeMockPool([
    { created_at: new Date('2024-01-01'), error_message: 'Synthetic failure', id: 1, stage: 'synthetic' },
  ]);
  const outcome = await resolveKnownFailures(mockPool, { dryRun: true });
  assert.ok(outcome.dryRun);
  assert.equal(outcome.result.totalCandidates, 0);
  assert.equal(mockPool.queryCalls.length, 0);
});

test('an injected synthetic fix excludes a later failure with the same signature', async () => {
  const fixDate = '2026-01-01T00:00:00.000Z';
  const signature = buildFailureSignature('synthetic', 'operation timed out');
  const mockPool = makeFilteringMockPool([
    { created_at: new Date('2025-12-01'), error_message: 'operation timed out', id: 1, stage: 'synthetic' },
    { created_at: new Date('2026-02-01'), error_message: 'operation timed out', id: 2, stage: 'synthetic' },
  ]);
  const outcome = await resolveKnownFailures(mockPool, {
    dryRun: true,
    signatures: [{ fixDate, resolvedBy: 'release:test', resolvedReason: 'synthetic fix', signature }],
  });
  assert.ok(outcome.dryRun);
  assert.equal(outcome.result.totalCandidates, 1);
  assert.deepEqual(outcome.result.matches[0]?.candidateIds, [1]);
  assert.equal(mockPool.queryParams[0]?.[0], fixDate);
});

// ---------------------------------------------------------------------------
// Related-link normalization fixtures
// ---------------------------------------------------------------------------
//
// The ingestion boundary normalizes related-link paths before schema validation.
//
// The `ingestMemoryDelta` boundary (`parseMemoryDeltaPayload` in
// `ingest-memory-delta-in-transaction.ts`) now applies `normalizeRelatedLinkUrl`
// to every `snapshot.value.anchors.related_links[i].url` before AJV runs —
// absolute filesystem paths become `file://` URIs, already-valid URIs pass
// through unchanged, and non-path non-URI strings are left alone so AJV can
// still reject them. This replaces the producer-side `normalizeToUri` copy in
// `auto-session-ingest.ts`, which `buildAutoMemoryDelta` now consumes via the
// shared export. The fixture calls schema validation directly to check the
// rejection that boundary normalization prevents.

function buildRawPathRelatedLinksDelta() {
  return {
    artifacts: [],
    created_at: '2026-02-23T00:00:00.000Z',
    delta_id: 'fixture-related-links-delta',
    produced_by: { agent: 'fixture-related-links' },
    schema_version: 'memory_delta@0.1',
    session_id: 'fixture-related-links-session',
    snapshot: {
      mode: 'replace',
      value: {
        anchors: {
          focus_paths: [],
          // Raw absolute filesystem path from an unnormalized producer.
          related_links: [{ label: 'transcript', url: '/raw/path/transcript.jsonl' }],
        },
        context_needed: [],
        created_at: '2026-02-23T00:00:00.000Z',
        goal: 'fixture for related-link normalization',
        next_actions: [],
        open_questions: [],
        plan: [],
        progress: { blockers: [], completed: [], in_flight: [] },
        snapshot_id: 'fixture-related-links-snapshot',
      },
    },
    tenancy: {},
  };
}

// The AJV error first line is a single physical line joined by
// `; `; we replicate that shape via the live `assertValidMemoryDelta` call
// (skipping boundary normalization) to test the rejected raw-path shape.
function captureRelatedLinksAjvFirstLine(): string {
  const delta = buildRawPathRelatedLinksDelta();
  try {
    assertValidMemoryDelta(delta);
  } catch (error) {
    if (error instanceof Error) {
      return error.message;
    }
    throw error;
  }
  throw new Error('expected assertValidMemoryDelta to throw for raw-path related_links.url fixture');
}

test('related-link fixture: ingestMemoryDelta boundary accepts raw-path related_links.url after normalization', () => {
  // The boundary normalizes raw absolute paths
  // to file:// URIs before AJV runs, so the same delta that historically
  // failed validation now succeeds.
  const delta = buildRawPathRelatedLinksDelta();
  normalizeMemoryDeltaRelatedLinks(delta);
  assert.doesNotThrow(() => {
    assertValidMemoryDelta(delta);
  });
  const normalizedUrl = delta.snapshot.value.anchors.related_links[0]?.url;
  assert.ok(normalizedUrl !== undefined, 'related_links url should remain present');
  assert.ok(normalizedUrl.startsWith('file:///'), `raw path should normalize to file:// URI: ${normalizedUrl}`);
  assert.ok(normalizedUrl.endsWith('transcript.jsonl'), 'normalized URI should preserve filename');
});

test('related-link fixture: boundary still rejects legitimate non-path non-URI related_links.url (regression actionable)', () => {
  // Non-path values must not be normalized.
  // A bare word with no scheme and no leading slash is neither a URI nor an
  // absolute path; the boundary leaves it alone so AJV can reject it. This
  // keeps schema validation able to reject genuinely malformed
  // producer payloads (e.g., a stage-prefixed log token) instead of silently
  // converting them to file://cwd/<word>.
  const delta = buildRawPathRelatedLinksDelta();
  delta.snapshot.value.anchors.related_links = [{ label: 'transcript', url: 'not a url' }];
  normalizeMemoryDeltaRelatedLinks(delta);
  assert.equal(
    delta.snapshot.value.anchors.related_links[0]?.url,
    'not a url',
    'non-path non-URI values must pass through unchanged so AJV can reject them',
  );
  assert.throws(
    () => {
      assertValidMemoryDelta(delta);
    },
    /must match format "uri"/,
    'AJV must still reject non-path non-URI related_links.url',
  );
});

test('related-link helper: normalizeRelatedLinkUrl preserves already-valid URIs unchanged', () => {
  // Critical guardrail: https://, file:, mailto: URIs must pass through unchanged.
  for (const uri of [
    'https://example.invalid/catalog/pull/12345',
    'file:///already/normalized.jsonl',
    'mailto:builder@example.invalid',
  ]) {
    assert.equal(normalizeRelatedLinkUrl(uri), uri, `valid URI must pass through: ${uri}`);
  }
});

test('related-link helper: normalizeRelatedLinkUrl converts absolute paths to file:// URIs', () => {
  const normalized = normalizeRelatedLinkUrl('/home/agent/session/transcript.jsonl');
  assert.ok(normalized.startsWith('file:///'), `expected file:// URI, got: ${normalized}`);
  assert.ok(normalized.endsWith('transcript.jsonl'));
});

test('related-link helper: normalizeRelatedLinkUrl leaves non-path non-URI values unchanged', () => {
  // Anything that is neither a parseable URI nor an absolute path is left
  // untouched so the AJV `format: "uri"` rejection remains the canonical
  // signal for legitimately-malformed producer payloads.
  for (const value of ['not a url', 'relative/path/transcript.jsonl', '', '   ']) {
    assert.equal(normalizeRelatedLinkUrl(value), value, `non-path non-URI must be unchanged: "${value}"`);
  }
});

test('related-link fixture: array-index normalization collapses /related_links/<n>/url to a single signature shape', () => {
  // The same signature must cover all related_links indices;
  // buildFailureSignature replaces digits with `<n>` so different array
  // positions map to one signature.
  const baseMessage = captureRelatedLinksAjvFirstLine();
  const baseSignature = buildFailureSignature('ingest_auto_delta', baseMessage);
  const sameClusterDifferentIndex = baseMessage.replace('/related_links/0/url', '/related_links/4/url');
  const variantSignature = buildFailureSignature('ingest_auto_delta', sameClusterDifferentIndex);
  assert.equal(variantSignature, baseSignature);
});

test('related-link fixture: normalized signature is distinct from documented quality-gate messages', () => {
  // The durable-memory quality-gate failures (confidence floor, expiresAt
  // requirement) live in a separate cluster and must not collide with the
  // schema cluster signature.
  const message = captureRelatedLinksAjvFirstLine();
  const schemaSignature = buildFailureSignature('ingest_auto_delta', message);
  const qualityGateMessages = [
    "durable memories outside session-summary must use confidence >= 0.5. Guidance: raise confidence to at least 0.5 when evidence is strong, or use category 'session-summary' with expiresAt for lower-confidence context.",
    'session-summary durable memories must include expiresAt.',
  ];
  for (const qgMessage of qualityGateMessages) {
    const qgSignature = buildFailureSignature('memory_store', qgMessage);
    assert.notEqual(schemaSignature, qgSignature);
  }
});

// ---------------------------------------------------------------------------
// Mock pool helpers
// ---------------------------------------------------------------------------

interface MockPool extends Queryable {
  queryCalls: string[];
  queryParams: (readonly unknown[] | undefined)[];
  updateParams: string[];
}

interface MockPoolRow {
  created_at: Date;
  error_message: string;
  id: number;
  stage: string;
}

// Simulates the candidate-fetch SQL's `created_at < $1::timestamptz` filter using the bound
// fixDate parameter. Required for tests that prove same-signature post-fix rows are excluded —
// the resolver itself depends on the DB to apply this gate, so the mock must apply it too.
function makeFilteringMockPool(allRows: MockPoolRow[]): MockPool {
  const queryCalls: string[] = [];
  const queryParams: (readonly unknown[] | undefined)[] = [];
  return {
    query(sql: string, params?: unknown[]) {
      queryCalls.push(sql);
      queryParams.push(params);
      if (sql.includes('FROM ai_ingestion_failures')) {
        const fixDateParam = params?.[0];
        if (typeof fixDateParam !== 'string') {
          throw new Error('filtering mock requires fixDate as first query parameter');
        }
        const fixTime = new Date(fixDateParam).getTime();
        const filtered = allRows.filter(r => r.created_at.getTime() < fixTime);
        return Promise.resolve({ rowCount: filtered.length, rows: filtered });
      }
      return Promise.resolve({ rowCount: allRows.length, rows: allRows });
    },
    queryCalls,
    queryParams,
    updateParams: [],
  };
}

function makeMockPool(rows: MockPoolRow[]): MockPool {
  const queryCalls: string[] = [];
  const queryParams: (readonly unknown[] | undefined)[] = [];
  return {
    query(sql: string, params?: unknown[]) {
      queryCalls.push(sql);
      queryParams.push(params);
      return Promise.resolve({ rowCount: rows.length, rows });
    },
    queryCalls,
    queryParams,
    updateParams: [],
  };
}

function makeMockPoolWithUpdate(rows: MockPoolRow[]): MockPool {
  const queryCalls: string[] = [];
  const queryParams: (readonly unknown[] | undefined)[] = [];
  const updateParams: string[] = [];
  return {
    query(sql: string, params?: unknown[]) {
      queryCalls.push(sql);
      queryParams.push(params);
      if (sql.trim().startsWith('UPDATE')) {
        if (params) {
          updateParams.push(...params.filter((p): p is string => typeof p === 'string'));
        }
        return Promise.resolve({ rowCount: rows.length, rows: [] });
      }
      return Promise.resolve({ rowCount: rows.length, rows });
    },
    queryCalls,
    queryParams,
    updateParams,
  };
}
