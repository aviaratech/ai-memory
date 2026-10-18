import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { classifyMemoryFragments, type FragmentClassification } from './llm-classify.js';
import { stableJsonHash } from '../db/hashing.js';

const topics = [
  ['architecture', 'Rendering uses isolated scenes with explicit lifecycle ownership.'],
  ['convention', 'Cache entries carry a namespace and invalidate when their source changes.'],
  ['methodology', 'Schema changes are reviewed against migration history before fixture execution.'],
  ['root-cause', 'A missing transaction fence allowed a stale maintenance plan to overwrite new evidence.'],
  ['decision', 'Command application requires reviewed bytes and a separately supplied digest.'],
] as const;

function fiftyFragments() {
  return topics.flatMap(([category, content], topic) =>
    Array.from({ length: 10 }, (_, detail) => ({
      id: String(topic * 10 + detail + 1),
      content: `${content} Supporting detail ${String(detail + 1)} records ${['ownership', 'validation', 'recovery', 'scope', 'lineage'][detail % 5]}.`,
      category,
      confidence: 0.8,
      memoryType: detail % 3 === 0 ? 'procedural' : 'episodic',
    })),
  );
}

function fiveFactResponse(): Omit<FragmentClassification, 'model'> {
  return {
    version: 1 as const,
    facts: topics.map(([category, content], topic) => ({
      category,
      content,
      sourceIds: Array.from({ length: 10 }, (_, detail) => String(topic * 10 + detail + 1)),
    })),
    held: [],
    contradictions: [],
  };
}

async function classifyBatch(fragments: unknown[] = fiftyFragments(), keyedContext: unknown[] = []) {
  return classifyMemoryFragments({ fragments, keyedContext } as Parameters<typeof classifyMemoryFragments>[0]);
}

describe('explicit fragment batch classification', () => {
  const saved = new Map<string, string | undefined>();
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    for (const key of ['AI_MEMORY_CLASSIFY_API_KEY', 'AI_MEMORY_EMBEDDING_API_KEY', 'AI_MEMORY_CLASSIFY_MODEL']) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.AI_MEMORY_CLASSIFY_API_KEY = 'synthetic-classifier-fixture';
    process.env.AI_MEMORY_CLASSIFY_MODEL = 'synthetic-model';
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('synthesizes five facts covering all fifty complementary fragments with explicit source lineage', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(fiveFactResponse()) } }] }));
    const result = (await classifyBatch()) as {
      facts: { sourceIds: string[] }[];
      model: string;
    };
    assert.equal(result.facts.length, 5);
    assert.deepEqual(
      result.facts.map(fact => fact.sourceIds.length),
      [10, 10, 10, 10, 10],
    );
    assert.deepEqual(
      result.facts.flatMap(fact => fact.sourceIds),
      Array.from({ length: 50 }, (_, index) => String(index + 1)),
    );
    assert.equal(result.model, 'synthetic-model');
  });

  it('rejects omitted, duplicated, unknown or keyed source IDs and model-owned scope or key directives', async () => {
    const invalid = [
      { ...fiveFactResponse(), extra: 'sql' },
      { ...fiveFactResponse(), facts: [] },
      { ...fiveFactResponse(), facts: [{ ...fiveFactResponse().facts[0], sourceIds: ['1'] }] },
      { ...fiveFactResponse(), facts: fiveFactResponse().facts.map(fact => ({ ...fact, sourceIds: ['1', '2'] })) },
      { ...fiveFactResponse(), facts: fiveFactResponse().facts.map(fact => ({ ...fact, sourceIds: ['51', '52'] })) },
      {
        ...fiveFactResponse(),
        facts: fiveFactResponse().facts.map(fact => ({ ...fact, memoryKey: 'attack', project: 'foreign/project' })),
      },
      {
        ...fiveFactResponse(),
        facts: fiveFactResponse().facts.map(fact => ({ ...fact, category: 'session-summary' })),
      },
      { ...fiveFactResponse(), held: [{ sourceIds: ['1'], reason: 'invented' }] },
      { ...fiveFactResponse(), contradictions: [{ sourceIds: ['1'], keyedIds: ['999'] }] },
    ];
    for (const response of invalid) {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }));
      assert.equal(await classifyBatch(), null);
    }
  });

  it('retains explicit held coverage and whitelisted contradiction evidence for the host to refuse', async () => {
    const response = fiveFactResponse();
    const body = {
      ...response,
      facts: response.facts.slice(1),
      held: [{ sourceIds: response.facts[0]!.sourceIds, reason: 'keyed_overlap' }],
      contradictions: [{ sourceIds: ['1'], keyedIds: ['100'] }],
    };
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) } }] }));
    const result = await classifyBatch(fiftyFragments(), [
      {
        id: '100',
        category: 'architecture',
        confidence: 0.8,
        content: 'An existing keyed architecture fact remains read-only context.',
      },
    ]);
    assert.deepEqual(result, { ...body, model: 'synthetic-model' });
  });

  it('refuses missing credentials, unsafe IDs, input overflow and oversized content without network access', async () => {
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      throw new Error('Unexpected network access for refused input.');
    };
    delete process.env.AI_MEMORY_CLASSIFY_API_KEY;
    assert.equal(await classifyBatch(), null);
    process.env.AI_MEMORY_CLASSIFY_API_KEY = 'synthetic-classifier-fixture';
    for (const fragments of [
      [...fiftyFragments(), { ...fiftyFragments()[0], id: '51' }],
      [{ ...fiftyFragments()[0], id: '9007199254740993' }, ...fiftyFragments().slice(1)],
      [{ ...fiftyFragments()[0], content: 'x'.repeat(65536) }, ...fiftyFragments().slice(1)],
    ])
      assert.equal(await classifyBatch(fragments), null);
    assert.equal(requests, 0);
  });

  it('returns no applicable classification on malformed, oversized, failed or aborted responses', async () => {
    for (const fetcher of [
      async () => new Response('bad-json'),
      async () => new Response(JSON.stringify({ choices: [{ message: { content: 'bad-json' } }] })),
      async () => new Response('x'.repeat(65537)),
      async () => new Response('{}', { status: 429 }),
      async () => {
        throw new Error('synthetic network failure');
      },
    ]) {
      globalThis.fetch = fetcher;
      assert.equal(await classifyBatch(), null);
    }
  });

  it('cancels a lost classifier response after its per-request limit', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = async (_address, init) => {
      signal = init?.signal;
      return new Promise<Response>(() => {});
    };
    try {
      const pending = classifyBatch();
      await vi.advanceTimersByTimeAsync(30_000);
      assert.equal(await pending, null);
      assert.equal(signal?.aborted, true);
    } finally {
      vi.useRealTimers();
    }
  });
});

import {
  buildFragmentConsolidationPlan,
  validateFragmentConsolidationPlan,
  validateFragmentConsolidationSelectors,
  type FragmentSnapshot,
} from './consolidate-fragments.js';
import * as fragmentOperation from './consolidate-fragments.js';

const selectors = { project: 'demo-workshop/widget', orgId: null, sensitivity: 'public' as const, limit: 50 };
const identity = { code: 'a'.repeat(64), namespace: 'synthetic-fixture', schema: 'b'.repeat(64) };
const classifierIdentity = { model: 'synthetic-model', prompt: 'c'.repeat(64) };
const calibration = {
  calibratedConfidence: 0.8,
  declaredConfidence: 0.8,
  meanDeclaredConfidence: null,
  priorMemoryCount: 0,
  reversalRate: 0,
  scope: 'author x category' as const,
  window: '30d' as const,
};
function snapshot(): FragmentSnapshot {
  return {
    capturedAt: '2026-10-18T00:00:00.000Z',
    capabilities: { hasEmbeddingColumn: true, hasTrigram: true, hasVector: true },
    exclusions: {},
    fragments: fiftyFragments().map(({ id, content, category, confidence, memoryType }, index) => ({
      id,
      content,
      category,
      confidence,
      memory_type: memoryType,
      memory_key: null,
      project: selectors.project,
      org_id: null,
      sensitivity: 'public',
      status: 'active',
      session_id: index % 2 === 0 ? 'Session-A' : 'session-a',
      repo_slug: selectors.project,
      repo_id: null,
      expires_at: '2099-01-01T00:00:00.000Z',
      supersedes_id: null,
      dedupe_hash: index === 0 ? 'flush-session-decision:v1:synthetic' : `synthetic:${id}`,
      evidence_refs: [{ path: `synthetic/topic-${String(Math.floor(index / 10))}.md` }],
      metadata_json: { syntheticDetail: index },
      tags: [],
      source: 'synthetic-fixture',
    })),
    keyedContext: [] as Record<string, unknown>[],
    sessions: ['Session-A', 'session-a'].map(session_id => ({
      session_id,
      repo_id: selectors.project,
      repo_slug: selectors.project,
    })),
    collisions: [] as Record<string, unknown>[],
  };
}
function planInput() {
  return {
    snapshot: snapshot(),
    classification: { ...fiveFactResponse(), model: 'synthetic-model' },
    classifierIdentity,
    identity,
    selectors,
    calibrationBaselines: Array.from({ length: 5 }, () => ({ ...calibration })),
  };
}

describe('reviewed fragment plan and complete source lineage', () => {
  it('admits corroborated memory/session basenames while preserving exact project and provenance', () => {
    const input = planInput();
    input.snapshot.fragments[0]!.repo_id = 'widget';
    input.snapshot.sessions[0]!.repo_id = 'widget';
    const before = structuredClone(input.snapshot);
    assert.equal(buildFragmentConsolidationPlan(input).status, 'ready');
    assert.deepEqual(input.snapshot, before);
    input.snapshot.fragments[0]!.repo_slug = 'foreign/widget';
    assert.equal(buildFragmentConsolidationPlan(input).status, 'refused');
  });
  it('uses the existing confidential/restricted sensitivity policy and refuses invented scopes', () => {
    for (const sensitivity of ['public', 'internal', 'confidential', 'restricted']) {
      assert.equal(validateFragmentConsolidationSelectors({ ...selectors, sensitivity }).sensitivity, sensitivity);
    }
    for (const sensitivity of ['private', 'secret'])
      assert.throws(() => validateFragmentConsolidationSelectors({ ...selectors, sensitivity }));
  });
  it('proposes five canonical keyed facts with all fifty source edges while preserving input bytes', () => {
    const input = planInput();
    const before = structuredClone(input);
    const plan = buildFragmentConsolidationPlan(input);
    assert.equal(plan.status, 'ready');
    assert.equal(plan.complete, true);
    assert.equal(plan.facts.length, 5);
    assert.deepEqual(
      plan.facts.flatMap(fact => fact.supersedes),
      Array.from({ length: 50 }, (_, i) => String(i + 1)),
    );
    assert.equal(new Set(plan.facts.map(fact => fact.memoryKey)).size, 5);
    for (const fact of plan.facts) {
      assert.match(fact.memoryKey, /^derived-memory:v1:[a-f0-9]{64}$/u);
      assert.equal(fact.declaredConfidence, 0.8);
    }
    assert.deepEqual(
      plan.facts.map(fact => fact.memoryType),
      ['semantic', 'semantic', 'semantic', 'episodic', 'semantic'],
    );
    assert.deepEqual(input, before);
    assert.deepEqual(validateFragmentConsolidationPlan(JSON.parse(JSON.stringify(plan))), plan);
  });

  it('refuses duplicate canonical target keys across disjoint source groups before application', () => {
    for (const variant of ['identical', 'case-whitespace']) {
      const input = planInput();
      input.classification.facts[1] = {
        ...input.classification.facts[1]!,
        category: 'architecture',
        content: variant === 'identical' ? topics[0][1] : `  ${topics[0][1].toUpperCase().replaceAll(' ', '  ')}  `,
      };
      const plan = buildFragmentConsolidationPlan(input);
      assert.equal(plan.status, 'refused');
      assert.ok(plan.refusals.includes('duplicate_target_key'));
    }
  });

  it('refuses keyed, expired, summary, reflective, low-confidence, unsafe-ID or conflicting-scope source evidence', () => {
    for (const change of [
      { memory_key: 'existing-key' },
      { expires_at: '2020-01-01T00:00:00.000Z' },
      { category: 'session-summary' },
      { memory_type: 'reflective' },
      { confidence: 0.4 },
      { id: '9007199254740993' },
      { repo_slug: 'foreign/widget' },
      { project: 'widget' },
      { memory_type: null, category: 'unrecognized-legacy' },
      { session_id: 'unknown-session' },
    ]) {
      const input = planInput();
      input.snapshot.fragments[0] = { ...input.snapshot.fragments[0]!, ...change };
      assert.equal(buildFragmentConsolidationPlan(input).status, 'refused');
    }
  });

  it('binds canonical keys, complete coverage, calibration and unmodified reviewed bytes', () => {
    const plan = buildFragmentConsolidationPlan(planInput());
    assert.throws(() =>
      validateFragmentConsolidationPlan({ ...plan, selectors: { ...selectors, project: 'foreign/widget' } }),
    );
    const forged = structuredClone(plan);
    forged.facts[0]!.memoryKey = 'attacker-selected-key';
    const { digest: _digest, ...body } = forged;
    forged.digest = stableJsonHash(body);
    assert.throws(() => validateFragmentConsolidationPlan(forged));
    const input = planInput();
    input.classification.facts[0]!.sourceIds.pop();
    assert.equal(buildFragmentConsolidationPlan(input).status, 'refused');
    const uncalibrated = planInput();
    uncalibrated.calibrationBaselines = [];
    assert.equal(buildFragmentConsolidationPlan(uncalibrated).status, 'refused');
  });

  it('rejects unapproved or forged apply intents before opening any database client', async () => {
    let connections = 0;
    const pool = {
      connect: async () => {
        connections++;
        throw new Error('No database access for invalid plans.');
      },
    };
    const apply = Reflect.get(fragmentOperation, 'applyFragmentConsolidation') as
      | ((input: unknown) => Promise<unknown>)
      | undefined;
    assert.ok(apply, 'The reviewed fragment apply operation does not exist.');
    const plan = buildFragmentConsolidationPlan(planInput());
    await assert.rejects(() => apply({ pool, plan, expectedDigest: '0'.repeat(64) }), /unapproved_plan/u);
    const forged = structuredClone(plan);
    forged.facts[1]!.memoryKey = forged.facts[0]!.memoryKey;
    const { digest: _digest, ...body } = forged;
    forged.digest = stableJsonHash(body);
    await assert.rejects(() => apply({ pool, plan: forged, expectedDigest: forged.digest }), /invalid_plan_intent/u);
    await assert.rejects(() => apply({ pool, plan, expectedDigest: plan.digest }), /incompatible_classifier_identity/u);
    assert.equal(connections, 0);
  });
});
