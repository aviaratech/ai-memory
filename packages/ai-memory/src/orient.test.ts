import assert from 'node:assert/strict';
import { test } from 'vitest';

import { probeEnvironment } from './env-probe.js';
import { type MemoryOrientDependencies, orientMemory } from './orient.js';

const DEFAULT_ENVIRONMENT = {
  branch: 'issue/1351',
  detachedHead: false,
  failingChecks: [],
  openPrs: [],
  recentCommits: ['abc123 setup memory_orient'],
  uncommittedFiles: 2,
  workspaceDirty: true,
};
const LEGACY_SESSION_ID = 'session-1';
const SNAPSHOT_ACTIVE_GOAL = 'Ship active goal model simplification';
const TEST_CWD = '/worktree/ai';

test('orientMemory returns ok when all sub-steps succeed', async () => {
  const result = await orientMemory({ envProbe: 'local', task: 'memory orient onboarding' }, createDependencies());

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.warnings, []);
  assert.equal(result.capabilities.search, true);
  assert.equal(result.capabilities.searchAvailable, true);
  assert.equal(result.capabilities.sessionResume, true);
  assert.equal(result.capabilities.embedding, true);
  assert.equal(result.capabilities.envProbe, 'local');
  assert.equal(result.orientation.environmentStatus, 'local');
  assert.equal(result.orientation.activeGoal, null);
  assert.equal(result.orientation.memoryDetail, 'compact');
  assert.equal(result.orientation.fullContentTopN, 0);
  assert.deepEqual(result.orientation.recentMemories, [{ id: 1 }]);
  assert.deepEqual(result.orientation.taskRelevant, [{ id: 2 }]);
  assert.equal(result.orientation.taskSearchStatus, 'ok');
  assert.equal(result.orientation.taskSearchResultCount, 1);
  assert.equal(result.orientation.x_active_goal, null);
  // Regression guard: the removed orient-intervention feature must not resurface
  // on the response.
  assert.ok(!('intervention' in result.orientation), 'orientation must not expose intervention');
  assert.ok(!('riskSignals' in result.orientation), 'orientation must not expose riskSignals');
});

test('orientMemory returns compact previews for rich memory rows by default', async () => {
  const content = 'Reviewer requested a deterministic state transition before merge.';
  const result = await orientMemory(
    { envProbe: 'local', task: 'compact preview check' },
    createDependencies({
      recallMemories: () =>
        Promise.resolve([
          {
            agent: 'codex-cli',
            calibratedConfidence: 0.64,
            category: 'decision',
            confidence: 0.64,
            content,
            createdAt: '2026-02-27T01:02:03.000Z',
            declaredConfidence: 0.9,
            evidenceRefs: [
              { type: 'github_issue', url: 'https://github.com/example/catalog/issues/2930' },
              { type: 'github_pr', url: 'https://github.com/example/catalog/pull/2930' },
              { type: 'session', url: 'codex://session/compact-preview' },
            ],
            id: 42,
            memory_key: 'example/catalog:pr-1550-request-changes',
            memory_type: 'semantic',
            sessionId: 'compact-preview',
            source: 'codex-hook',
            status: 'active',
            tags: ['review', 'request-changes'],
            updatedAt: '2026-02-27T01:05:00.000Z',
          },
        ]),
      searchMemories: () =>
        Promise.resolve([
          {
            category: 'root-cause',
            content: 'Root-cause memory for compact projection check.',
            id: 7,
            memoryType: 'episodic',
            status: 'active',
          },
        ]),
    }),
  );

  assert.equal(result.orientation.memoryDetail, 'compact');
  assert.equal(result.orientation.fullContentTopN, 0);
  assert.deepEqual(result.orientation.recentMemories, [
    {
      agent: 'codex-cli',
      calibratedConfidence: 0.64,
      category: 'decision',
      createdAt: '2026-02-27T01:02:03.000Z',
      declaredConfidence: 0.9,
      evidenceRefs: [
        { type: 'session', url: 'codex://session/compact-preview' },
        { type: 'github_issue', url: 'https://github.com/example/catalog/issues/2930' },
      ],
      excerpt: content,
      id: 42,
      memoryKey: 'example/catalog:pr-1550-request-changes',
      memoryType: 'semantic',
      sessionId: 'compact-preview',
      source: 'codex-hook',
      status: 'active',
      tags: ['review', 'request-changes'],
      updatedAt: '2026-02-27T01:05:00.000Z',
    },
  ]);
  assert.deepEqual(result.orientation.taskRelevant, [
    {
      category: 'root-cause',
      excerpt: 'Root-cause memory for compact projection check.',
      id: 7,
      memoryType: 'episodic',
      status: 'active',
    },
  ]);
});

test('orientMemory uses an explicit session id for direct resume without broadening worker fallback scope', async () => {
  const resumeInputs: unknown[] = [];
  const result = await orientMemory(
    {
      agent: 'issue-worker',
      envProbe: 'none',
      project: 'example/catalog',
      sessionId: 'lead-session-2930',
    },
    createDependencies({
      getSessionResume: input => {
        resumeInputs.push(input);
        return Promise.resolve({
          events: [],
          sessionId: 'lead-session-2930',
          status: 'ok',
        });
      },
    }),
  );

  assert.deepEqual(resumeInputs, [
    {
      agent: 'issue-worker',
      eventLimit: 5,
      project: 'example/catalog',
      sessionId: 'lead-session-2930',
    },
  ]);
  assert.equal(result.orientation.priorSession?.sessionId, 'lead-session-2930');
});

test('orientMemory includes full content for top N compact memories', async () => {
  const firstContent = 'First compact memory content.';
  const secondContent = 'Second compact memory content.';
  const result = await orientMemory(
    { envProbe: 'none', fullContentTopN: 1 },
    createDependencies({
      recallMemories: () =>
        Promise.resolve([
          { content: firstContent, id: 1 },
          { content: secondContent, id: 2 },
        ]),
      searchMemories: () => Promise.resolve([]),
    }),
  );

  assert.equal(result.orientation.memoryDetail, 'compact');
  assert.equal(result.orientation.fullContentTopN, 1);
  assert.deepEqual(result.orientation.recentMemories, [
    { content: firstContent, excerpt: firstContent, id: 1 },
    { excerpt: secondContent, id: 2 },
  ]);
});

test('orientMemory returns full memory payload when memoryDetail is full', async () => {
  const fullMemory = {
    category: 'architecture',
    content: 'Full payload should remain unchanged in full mode.',
    id: 99,
    metadata: { owner: 'ai-memory' },
    status: 'active',
  };
  const result = await orientMemory(
    { envProbe: 'none', memoryDetail: 'full' },
    createDependencies({
      recallMemories: () => Promise.resolve([fullMemory]),
      searchMemories: () => Promise.resolve([]),
    }),
  );

  assert.equal(result.orientation.memoryDetail, 'full');
  assert.equal(result.orientation.fullContentTopN, 0);
  assert.deepEqual(result.orientation.recentMemories, [fullMemory]);
});

test('orientMemory returns partial when search fails but recall and resume succeed', async () => {
  const result = await orientMemory(
    { envProbe: 'local', task: 'query that fails' },
    createDependencies({
      searchMemories: () => Promise.reject(new Error('search unavailable')),
    }),
  );

  assert.equal(result.status, 'partial');
  assert.deepEqual(result.orientation.recentMemories, [{ id: 1 }]);
  assert.deepEqual(result.orientation.priorSession, {
    events: [],
    sessionId: 'session-1',
    status: 'ok',
  });
  assert.deepEqual(result.orientation.taskRelevant, []);
  assert.equal(result.orientation.x_active_goal, null);
  assert.equal(result.capabilities.search, false);
  assert.equal(result.capabilities.searchAvailable, false);
  assert.equal(result.orientation.taskSearchStatus, 'error');
  assert.equal(result.orientation.taskSearchResultCount, null);
  assert.ok(result.warnings.some(w => w.includes('search direct failed: search unavailable')));
  assert.ok(result.warnings.some(w => w.includes('search implication failed: search unavailable')));
});

test('orientMemory returns degraded when both recall and resume fail', async () => {
  const result = await orientMemory(
    { envProbe: 'none' },
    createDependencies({
      getSessionResume: () => Promise.reject(new Error('resume failed hard')),
      recallMemories: () => Promise.reject(new Error('recall failed hard')),
    }),
  );

  assert.equal(result.status, 'degraded');
  assert.equal(result.orientation.priorSession, null);
  assert.deepEqual(result.orientation.recentMemories, []);
  assert.equal(result.orientation.x_active_goal, null);
  assert.equal(result.capabilities.search, false);
  assert.equal(result.capabilities.searchAvailable, true);
  assert.equal(result.orientation.taskSearchStatus, 'skipped');
  assert.equal(result.orientation.taskSearchResultCount, null);
  assert.ok(result.warnings.includes('recall failed: recall failed hard'));
  assert.ok(result.warnings.includes('resume failed: resume failed hard'));
});

test('orientMemory includes x_active_goal from prior snapshot', async () => {
  const result = await orientMemory(
    { envProbe: 'none' },
    createDependencies({
      getSessionResume: () =>
        Promise.resolve({
          events: [],
          sessionId: LEGACY_SESSION_ID,
          snapshot: {
            snapshotJson: {
              x_active_goal: SNAPSHOT_ACTIVE_GOAL,
            },
          },
          status: 'ok',
        }),
    }),
  );

  assert.equal(result.status, 'ok');
  assert.equal(result.orientation.x_active_goal, SNAPSHOT_ACTIVE_GOAL);
  assert.equal(result.orientation.activeGoal, SNAPSHOT_ACTIVE_GOAL);
});

test('orientMemory returns null environment when envProbe is none', async () => {
  let receivedMode: string | undefined;
  const result = await orientMemory(
    { envProbe: 'none' },
    createDependencies({
      probeEnvironment: mode => {
        receivedMode = mode;
        return { capability: 'none', environment: null, status: 'disabled', warnings: [] };
      },
    }),
  );

  assert.equal(receivedMode, 'none');
  assert.equal(result.orientation.environment, null);
  assert.equal(result.orientation.environmentStatus, 'disabled');
  assert.equal(result.capabilities.envProbe, 'none');
  assert.equal(result.status, 'ok');
  assert.equal(result.capabilities.searchAvailable, true);
  assert.equal(result.orientation.taskSearchStatus, 'skipped');
  assert.equal(result.orientation.taskSearchResultCount, null);
});

test('orientMemory forwards cwd to environment probe', async () => {
  let receivedCwd: string | undefined;
  const result = await orientMemory(
    { cwd: TEST_CWD, envProbe: 'local' },
    createDependencies({
      probeEnvironment: (_mode, options) => {
        receivedCwd = options?.cwd;
        return {
          capability: 'local',
          environment: { ...DEFAULT_ENVIRONMENT },
          status: 'local',
          warnings: [],
        };
      },
    }),
  );

  assert.equal(receivedCwd, TEST_CWD);
  assert.equal(result.status, 'ok');
});

test('orientMemory returns full environment when envProbe full succeeds', async () => {
  const result = await orientMemory(
    { envProbe: 'full' },
    createDependencies({
      probeEnvironment: mode =>
        probeEnvironment(mode, {
          execGh: args => {
            const command = args.join(' ');
            if (command.startsWith('auth status')) {
              return '✓ Logged in to github.com as test-user\n  Active account: true';
            }
            if (command === 'pr list --json number,title,headRefName --limit 10') {
              return '[{"number":77,"title":"Improve env probe","headRefName":"issue-1354"}]';
            }
            if (command === 'run list --limit 5 --json status,conclusion,name') {
              return '[{"status":"completed","conclusion":"failure","name":"ci"}]';
            }
            throw new Error(`unexpected gh args: ${command}`);
          },
          execGit: args => {
            const command = args.join(' ');
            if (command === 'rev-parse --abbrev-ref HEAD') return 'main';
            if (command === 'status --porcelain') return '';
            if (command === 'log --oneline -5') return 'abc123 first\nbcd234 second';
            throw new Error(`unexpected git args: ${command}`);
          },
        }),
    }),
  );

  assert.equal(result.capabilities.envProbe, 'full');
  assert.equal(result.orientation.environmentStatus, 'full');
  assert.notEqual(result.orientation.environment, null);
  if (result.orientation.environment === null) {
    assert.fail('environment should be present for full probe success');
  }
  assert.equal(result.orientation.environment.branch, 'main');
  assert.deepEqual(result.orientation.environment.openPrs, [
    { branch: 'issue-1354', number: 77, title: 'Improve env probe' },
  ]);
  assert.deepEqual(result.orientation.environment.failingChecks, ['ci']);
  assert.deepEqual(result.warnings, []);
});

test('orientMemory downgrades envProbe full to local when gh auth fails', async () => {
  const result = await orientMemory(
    { envProbe: 'full' },
    createDependencies({
      probeEnvironment: mode =>
        probeEnvironment(mode, {
          execGh: args => {
            const command = args.join(' ');
            if (command.startsWith('auth status')) {
              throw new Error('not authenticated');
            }
            throw new Error(`unexpected gh args: ${command}`);
          },
          execGit: args => {
            const command = args.join(' ');
            if (command === 'rev-parse --abbrev-ref HEAD') return 'main';
            if (command === 'status --porcelain') return '';
            if (command === 'log --oneline -5') return 'abc123 first';
            throw new Error(`unexpected git args: ${command}`);
          },
        }),
    }),
  );

  assert.equal(result.capabilities.envProbe, 'local');
  assert.equal(result.orientation.environmentStatus, 'local_fallback');
  assert.equal(result.status, 'ok');
  assert.notEqual(result.orientation.environment, null);
  if (result.orientation.environment === null) {
    assert.fail('environment should be present when full probe downgrades to local');
  }
  assert.deepEqual(result.orientation.environment.openPrs, []);
  assert.deepEqual(result.orientation.environment.failingChecks, []);
  assert.ok(result.warnings.some(warning => warning.includes('gh_auth_no_active_account')));
});

test('orientMemory keeps healthy memory lanes ok when environment probing is unavailable', async () => {
  const result = await orientMemory(
    { envProbe: 'local' },
    createDependencies({
      probeEnvironment: () => {
        throw new Error('git executable unavailable');
      },
    }),
  );

  assert.equal(result.status, 'ok');
  assert.equal(result.capabilities.envProbe, 'local');
  assert.equal(result.orientation.environmentStatus, 'unavailable');
  assert.equal(result.orientation.environment, null);
  assert.deepEqual(result.warnings, ['environment probe failed: git executable unavailable']);
});

test('orientMemory passes memoryType through recall/search sub-steps', async () => {
  let recallInput: unknown;
  let searchInput: unknown;

  await orientMemory(
    { memoryType: 'semantic', task: 'memory type passthrough' },
    createDependencies({
      recallMemories: input => {
        recallInput = input;
        return Promise.resolve([{ id: 1 }]);
      },
      searchMemories: input => {
        searchInput = input;
        return Promise.resolve([{ id: 2 }]);
      },
    }),
  );

  assert.ok(isRecord(recallInput));
  assert.equal(recallInput.memoryType, 'semantic');
  assert.ok(isRecord(searchInput));
  assert.equal(searchInput.memoryType, 'semantic');
});

test('orientMemory stays unscoped when project is omitted', async () => {
  let recallInput: unknown;
  let resumeInput: unknown;
  let searchInput: unknown;
  let contestedCalls = 0;

  const result = await orientMemory(
    { envProbe: 'none', task: 'verify unscoped orient behavior' },
    createDependencies({
      countContestedMemories: () => {
        contestedCalls += 1;
        return Promise.resolve(99);
      },
      getSessionResume: input => {
        resumeInput = input;
        return Promise.resolve({
          events: [],
          sessionId: LEGACY_SESSION_ID,
          status: 'ok',
        });
      },
      recallMemories: input => {
        recallInput = input;
        return Promise.resolve([{ id: 1 }]);
      },
      searchMemories: input => {
        searchInput = input;
        return Promise.resolve([{ id: 2 }]);
      },
    }),
  );

  assert.ok(isRecord(recallInput));
  assert.equal('project' in recallInput, false);
  assert.ok(isRecord(resumeInput));
  assert.equal('project' in resumeInput, false);
  assert.ok(isRecord(searchInput));
  assert.equal('project' in searchInput, false);
  assert.equal(contestedCalls, 0);
  assert.equal(result.orientation.contested, 0);
});

test('orientMemory forwards explicit project to project-scoped steps', async () => {
  let recallInput: unknown;
  let resumeInput: unknown;
  let searchInput: unknown;
  let contestedInput: unknown;

  const result = await orientMemory(
    {
      envProbe: 'none',
      project: 'example/catalog',
      task: 'verify explicit project passthrough',
    },
    createDependencies({
      countContestedMemories: input => {
        contestedInput = input;
        return Promise.resolve(2);
      },
      getSessionResume: input => {
        resumeInput = input;
        return Promise.resolve({
          events: [],
          sessionId: LEGACY_SESSION_ID,
          status: 'ok',
        });
      },
      recallMemories: input => {
        recallInput = input;
        return Promise.resolve([{ id: 1 }]);
      },
      searchMemories: input => {
        searchInput = input;
        return Promise.resolve([{ id: 2 }]);
      },
    }),
  );

  assert.ok(isRecord(recallInput));
  assert.equal(recallInput.project, 'example/catalog');
  assert.ok(isRecord(resumeInput));
  assert.equal(resumeInput.project, 'example/catalog');
  assert.ok(isRecord(searchInput));
  assert.equal(searchInput.project, 'example/catalog');
  assert.ok(isRecord(contestedInput));
  assert.equal(contestedInput.project, 'example/catalog');
  assert.equal(result.orientation.contested, 2);
});

test('orientMemory rejects invalid memoryType with accepted values and correction hint', async () => {
  await assert.rejects(
    orientMemory({ memoryType: 'unknown-type' }, createDependencies()),
    /memoryType must be one of: episodic, semantic, procedural, reflective\..*omit memoryType to include all memory types\./u,
  );
});

test('orientMemory rejects invalid envProbe with accepted values and correction hint', async () => {
  await assert.rejects(
    orientMemory({ envProbe: 'remote' }, createDependencies()),
    /envProbe must be one of: none, local, full\..*omit envProbe to use 'local'\./u,
  );
});

test('orientMemory rejects invalid memoryDetail with accepted values and correction hint', async () => {
  await assert.rejects(
    orientMemory({ memoryDetail: 'preview' }, createDependencies()),
    /memoryDetail must be one of: compact, full\..*omit memoryDetail to use 'compact'\./u,
  );
});

test('orientMemory rejects invalid fullContentTopN values', async () => {
  await assert.rejects(
    orientMemory({ fullContentTopN: 6 }, createDependencies()),
    /fullContentTopN must be an integer between 0 and 5\./u,
  );
});

test('orientMemory forwards activeGoal to search when provided', async () => {
  let searchInput: unknown;

  await orientMemory(
    {
      activeGoal: 'Improve retrieval precision for active issue',
      task: 'active goal passthrough',
    },
    createDependencies({
      searchMemories: input => {
        searchInput = input;
        return Promise.resolve([{ id: 2 }]);
      },
    }),
  );

  assert.ok(isRecord(searchInput));
  assert.equal(searchInput.activeGoal, 'Improve retrieval precision for active issue');
});

test('orientMemory task-conditions recall ranking when task tokens match lower-ranked memories', async () => {
  const result = await orientMemory(
    { task: 'document processing accuracy' },
    createDependencies({
      // Deliberately place unrelated memory first to verify re-ranking.
      recallMemories: () =>
        Promise.resolve([
          {
            category: 'decision',
            content: 'issue-cli PR publish workflow hardening',
            id: 1,
            tags: ['issue-cli'],
          },
          {
            category: 'root-cause',
            content: 'document processing lock instability root cause',
            id: 2,
            tags: ['document'],
          },
        ]),
      searchMemories: () => Promise.resolve([]),
    }),
  );

  assert.deepEqual(
    result.orientation.recentMemories.map(memory => (isRecord(memory) ? memory.id : undefined)),
    [2, 1],
  );
});

test('orientMemory activeGoal-conditions recall ranking when task is absent', async () => {
  const result = await orientMemory(
    { activeGoal: 'stabilize measurement export pipeline' },
    createDependencies({
      recallMemories: () =>
        Promise.resolve([
          {
            category: 'decision',
            content: 'issue-cli publish fallback retries',
            id: 1,
            tags: ['issue-cli'],
          },
          {
            category: 'root-cause',
            content: 'measurement export pipeline dropped artifact rows',
            id: 2,
            tags: ['document'],
          },
        ]),
    }),
  );

  assert.deepEqual(
    result.orientation.recentMemories.map(memory => (isRecord(memory) ? memory.id : undefined)),
    [2, 1],
  );
});

test('orientMemory applies per-sub-step timeout without blocking full response', async () => {
  const previousEmbeddingTimeout = process.env.AI_MEMORY_EMBEDDING_TIMEOUT_MS;
  const previousStepTimeout = process.env.AI_MEMORY_ORIENT_STEP_TIMEOUT_MS;
  process.env.AI_MEMORY_EMBEDDING_TIMEOUT_MS = '20';
  process.env.AI_MEMORY_ORIENT_STEP_TIMEOUT_MS = '20';

  try {
    const result = await orientMemory(
      { envProbe: 'none', task: 'timeout exercise' },
      createDependencies({
        searchMemories: () => new Promise(() => undefined),
      }),
    );

    assert.equal(result.status, 'partial');
    assert.equal(result.capabilities.search, false);
    assert.equal(result.capabilities.searchAvailable, false);
    assert.deepEqual(result.orientation.recentMemories, [{ id: 1 }]);
    assert.deepEqual(result.orientation.priorSession, {
      events: [],
      sessionId: 'session-1',
      status: 'ok',
    });
    assert.equal(result.orientation.taskSearchStatus, 'error');
    assert.equal(result.orientation.taskSearchResultCount, null);
    assert.ok(
      result.warnings.some(warning => warning.includes('search direct failed:')),
      `expected direct lane timeout warning, got: ${JSON.stringify(result.warnings)}`,
    );
  } finally {
    if (previousEmbeddingTimeout === undefined) {
      process.env.AI_MEMORY_EMBEDDING_TIMEOUT_MS = '';
    } else {
      process.env.AI_MEMORY_EMBEDDING_TIMEOUT_MS = previousEmbeddingTimeout;
    }
    if (previousStepTimeout === undefined) {
      process.env.AI_MEMORY_ORIENT_STEP_TIMEOUT_MS = '';
    } else {
      process.env.AI_MEMORY_ORIENT_STEP_TIMEOUT_MS = previousStepTimeout;
    }
  }
});

test('orientMemory overlaps independent recovery reads after resolving session scope', async () => {
  const started = new Set<string>();
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const blocked = <T>(name: string, value: T) => {
    started.add(name);
    return gate.then(() => value);
  };
  const resultPromise = orientMemory(
    { envProbe: 'none', project: 'fixture/recovery', task: 'current archive task requirements' },
    createDependencies({
      countContestedMemories: () => blocked('contested', 0),
      recallMemories: () => blocked('recall', []),
      searchMemories: () => blocked('search', []),
      searchTemporalMemories: () => blocked('temporal', []),
    }),
  );

  for (let attempt = 0; attempt < 20 && started.size < 4; attempt += 1)
    await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual([...started].sort(), ['contested', 'recall', 'search', 'temporal']);
  assert.ok(release);
  release();
  const result = await resultPromise;
  assert.equal(result.status, 'ok');
});

test('orientMemory settles healthy memory reads before a synchronous environment probe', async () => {
  const previousStepTimeout = process.env.AI_MEMORY_ORIENT_STEP_TIMEOUT_MS;
  process.env.AI_MEMORY_ORIENT_STEP_TIMEOUT_MS = '20';

  try {
    const result = await orientMemory(
      { envProbe: 'local' },
      createDependencies({
        probeEnvironment: () => {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
          return {
            capability: 'local',
            environment: { ...DEFAULT_ENVIRONMENT },
            status: 'local',
            warnings: [],
          };
        },
        recallMemories: () =>
          new Promise(resolve => {
            setImmediate(() => {
              setTimeout(() => {
                resolve([{ id: 1 }]);
              }, 1);
            });
          }),
      }),
    );

    assert.equal(result.status, 'ok');
    assert.deepEqual(result.orientation.recentMemories, [{ id: 1 }]);
    assert.ok(!result.warnings.some(warning => warning.includes('recall')));
  } finally {
    if (previousStepTimeout === undefined) delete process.env.AI_MEMORY_ORIENT_STEP_TIMEOUT_MS;
    else process.env.AI_MEMORY_ORIENT_STEP_TIMEOUT_MS = previousStepTimeout;
  }
});

test('orientMemory lets direct search complete after its bounded embedding phase before timing out', async () => {
  const previousEmbeddingTimeout = process.env.AI_MEMORY_EMBEDDING_TIMEOUT_MS;
  const previousStepTimeout = process.env.AI_MEMORY_ORIENT_STEP_TIMEOUT_MS;
  process.env.AI_MEMORY_EMBEDDING_TIMEOUT_MS = '80';
  process.env.AI_MEMORY_ORIENT_STEP_TIMEOUT_MS = '20';

  try {
    const result = await orientMemory(
      { envProbe: 'none', task: 'direct search remains available after embedding work' },
      createDependencies({
        searchMemories: input => {
          const request = isRecord(input) ? input : {};
          if (request.includeEmbedding === true) {
            return new Promise(resolve => {
              setTimeout(() => {
                resolve([{ id: 77 }]);
              }, 30);
            });
          }
          return Promise.resolve([{ id: 88 }]);
        },
        searchTemporalMemories: () => Promise.resolve([]),
      }),
    );

    assert.equal(result.status, 'ok');
    assert.equal(result.orientation.taskSearchStatus, 'ok');
    assert.deepEqual(
      result.orientation.taskRelevant.map(memory => (isRecord(memory) ? memory.id : undefined)),
      [77, 88],
    );
  } finally {
    if (previousEmbeddingTimeout === undefined) {
      process.env.AI_MEMORY_EMBEDDING_TIMEOUT_MS = '';
    } else {
      process.env.AI_MEMORY_EMBEDDING_TIMEOUT_MS = previousEmbeddingTimeout;
    }
    if (previousStepTimeout === undefined) {
      process.env.AI_MEMORY_ORIENT_STEP_TIMEOUT_MS = '';
    } else {
      process.env.AI_MEMORY_ORIENT_STEP_TIMEOUT_MS = previousStepTimeout;
    }
  }
});

test('orientMemory exposes explicit task search capability and outcome fields across scenarios', async () => {
  const scenarios = [
    {
      args: { envProbe: 'none' },
      expected: {
        capabilitiesSearch: false,
        capabilitiesSearchAvailable: true,
        status: 'ok',
        taskRelevantLength: 0,
        taskSearchResultCount: null,
        taskSearchStatus: 'skipped',
      },
      name: 'no task + search available',
    },
    {
      args: { envProbe: 'local', task: 'task with zero results' },
      expected: {
        capabilitiesSearch: true,
        capabilitiesSearchAvailable: true,
        status: 'ok',
        taskRelevantLength: 0,
        taskSearchResultCount: 0,
        taskSearchStatus: 'ok',
      },
      name: 'task with zero results',
      overrides: {
        searchMemories: () => Promise.resolve([]),
      },
    },
    {
      args: { envProbe: 'local', task: 'task with results' },
      expected: {
        capabilitiesSearch: true,
        capabilitiesSearchAvailable: true,
        status: 'ok',
        taskRelevantLength: 1,
        taskSearchResultCount: 1,
        taskSearchStatus: 'ok',
      },
      name: 'task with >0 results',
    },
    {
      args: { envProbe: 'local', task: 'task with search error' },
      expected: {
        capabilitiesSearch: false,
        capabilitiesSearchAvailable: false,
        status: 'partial',
        taskRelevantLength: 0,
        taskSearchResultCount: null,
        taskSearchStatus: 'error',
      },
      name: 'task with search error',
      overrides: {
        searchMemories: () => Promise.reject(new Error('search error')),
      },
    },
    {
      args: { envProbe: 'local', task: 'search unavailable' },
      expected: {
        capabilitiesSearch: false,
        capabilitiesSearchAvailable: false,
        status: 'partial',
        taskRelevantLength: 0,
        taskSearchResultCount: null,
        taskSearchStatus: 'error',
      },
      name: 'search unavailable',
      overrides: {
        searchMemories: () => Promise.reject(new Error('search unavailable')),
      },
    },
  ];

  for (const scenario of scenarios) {
    const result = await orientMemory(scenario.args, createDependencies(scenario.overrides ?? {}));

    assert.equal(result.capabilities.search, scenario.expected.capabilitiesSearch, scenario.name);
    assert.equal(result.capabilities.searchAvailable, scenario.expected.capabilitiesSearchAvailable, scenario.name);
    assert.equal(result.status, scenario.expected.status, scenario.name);
    assert.equal(result.orientation.taskSearchStatus, scenario.expected.taskSearchStatus, scenario.name);
    assert.equal(result.orientation.taskSearchResultCount, scenario.expected.taskSearchResultCount, scenario.name);
    assert.equal(result.orientation.taskRelevant.length, scenario.expected.taskRelevantLength, scenario.name);
  }
});

test('orientMemory hard-caps oversized non-session payloads and reports truncated sections', async () => {
  const previousBudget = process.env.AI_MEMORY_ORIENT_PAYLOAD_BUDGET_CHARS;
  process.env.AI_MEMORY_ORIENT_PAYLOAD_BUDGET_CHARS = '2000';

  try {
    const oversizedMemories = Array.from({ length: 18 }, (_, i) => ({
      category: i % 2 === 0 ? 'architecture' : 'decision',
      content: 'architectural context '.repeat(80),
      id: i + 1,
      importance: i === 0 ? 0.95 : 0.4,
      memoryKey: `budget-key-${String(i + 1)}`,
      memoryType: 'semantic',
      status: 'active',
      tags: ['ai-memory', 'payload-budget'],
    }));

    const result = await orientMemory(
      { envProbe: 'none', memoryDetail: 'full', task: 'hard cap non-session payload' },
      createDependencies({
        getSessionResume: () =>
          Promise.resolve({
            events: Array.from({ length: 20 }, (_, i) => ({
              payloadJson: { detail: 'prior session event detail '.repeat(40) },
              summary: `prior session event ${String(i)}`,
            })),
            sessionId: LEGACY_SESSION_ID,
            snapshot: {
              snapshotJson: {
                goal: 'Preserve a very long prior session snapshot.'.repeat(50),
                next_actions: ['Continue the implementation.'],
                open_questions: ['Which section should truncate first?'],
              },
            },
            status: 'ok',
          }),
        recallMemories: () => Promise.resolve(oversizedMemories),
        searchMemories: () => Promise.resolve(oversizedMemories),
      }),
    );

    assert.ok(
      result.orientation.memoryPayloadChars <= result.orientation.memoryPayloadBudgetChars * 1.05,
      `payload chars ${String(result.orientation.memoryPayloadChars)} should stay within 5% example of budget ${String(
        result.orientation.memoryPayloadBudgetChars,
      )}`,
    );
    assert.equal(result.orientation.memoryPayloadBudgetExceeded, false);
    assert.ok(
      (result.orientation.truncatedSections?.length ?? 0) > 0,
      'budget pressure should report truncated sections',
    );
    assert.ok(
      result.orientation.truncatedSections?.includes('priorSession'),
      'prior session details are the lowest-priority truncation target',
    );
  } finally {
    if (previousBudget === undefined) {
      delete process.env.AI_MEMORY_ORIENT_PAYLOAD_BUDGET_CHARS;
    } else {
      process.env.AI_MEMORY_ORIENT_PAYLOAD_BUDGET_CHARS = previousBudget;
    }
  }
});

// --- Fanout v1 tests ---

test('fanout v1: keeps embedding retrieval in direct search and disables it for implication search', async () => {
  const requests: Record<string, unknown>[] = [];

  await orientMemory(
    { envProbe: 'none', task: 'retrieve task context with active goal' },
    createDependencies({
      searchMemories: input => {
        if (isRecord(input)) {
          requests.push(input);
        }
        return Promise.resolve([]);
      },
      searchTemporalMemories: () => Promise.resolve([]),
    }),
  );

  const directRequest = requests.find(request => request.query === 'retrieve task context with active goal');
  const implicationRequest = requests.find(
    request => typeof request.query === 'string' && request.query.includes(' OR '),
  );

  assert.ok(directRequest !== undefined, 'expected direct task search request');
  assert.equal(directRequest.includeEmbedding, true);
  assert.ok(implicationRequest !== undefined, 'expected implication search request');
  assert.equal(implicationRequest.includeEmbedding, false);
});

test('fanout v1: preserves direct order and appends unique temporal results', async () => {
  const result = await orientMemory(
    { envProbe: 'none', task: 'memory orient onboarding' },
    createDependencies({
      searchMemories: (input: unknown) => {
        const request = input as { query?: string };
        if (typeof request.query === 'string' && request.query.includes(' OR ')) {
          return Promise.resolve([{ id: 2 }, { category: 'workflow', id: 5 }]);
        }
        return Promise.resolve([
          { category: 'decision', id: 2 },
          { category: 'root-cause', id: 3 },
        ]);
      },
      searchTemporalMemories: () =>
        Promise.resolve([
          { category: 'root-cause', id: 3, status: 'contested' },
          { category: 'decision', id: 4, status: 'contested' },
        ]),
    }),
  );

  const ids = result.orientation.taskRelevant.map(m => (isRecord(m) ? m.id : undefined));
  // direct: [2, 3], temporal unique: [4], implication unique: [5]
  assert.deepEqual(ids, [2, 3, 4, 5]);
  assert.equal(result.orientation.retrievalDiagnostics?.strategy, 'fanout_v1');
});

test('fanout v1: compact output preserves correction lineage, contested status, and valid historical constraints', async () => {
  const current = {
    content: 'Correction: archive replay now uses thirty minutes; this replaces the old ten-minute replay window.',
    id: 8101,
    status: 'active',
    supersedesId: 8100,
  };
  const contested = {
    content: 'Contested proposal: archive replay should use sixty minutes, but no approval exists.',
    id: 8102,
    status: 'contested',
    supersedesId: 8101,
  };
  const historical = {
    content: 'The historical manifest checksum requirement remains valid before archive replay.',
    id: 8103,
    status: 'active',
  };
  const result = await orientMemory(
    { envProbe: 'none', task: 'Prepare the archive replay with the accepted window and required checks' },
    createDependencies({
      searchMemories: input =>
        Promise.resolve(
          isRecord(input) && typeof input.query === 'string' && input.query.includes(' OR ') ? [historical] : [current],
        ),
      searchTemporalMemories: () => Promise.resolve([current, contested]),
    }),
  );
  assert.deepEqual(result.orientation.taskRelevant, [
    { excerpt: current.content, id: 8101, status: 'active', supersedesId: 8100 },
    { excerpt: contested.content, id: 8102, status: 'contested', supersedesId: 8101 },
    { excerpt: historical.content, id: 8103, status: 'active' },
  ]);
  assert.equal(result.orientation.taskSearchStatus, 'ok');
});

test('fanout v1: healthy absence is distinguishable from failure in every search lane', async () => {
  const empty = await orientMemory(
    { envProbe: 'none', task: 'fixture with no recorded answer' },
    createDependencies({
      searchMemories: () => Promise.resolve([]),
      searchTemporalMemories: () => Promise.resolve([]),
    }),
  );
  assert.equal(empty.orientation.taskSearchStatus, 'ok');
  assert.deepEqual(empty.orientation.taskRelevant, []);
  assert.deepEqual(empty.warnings, []);
  const failed = await orientMemory(
    { envProbe: 'none', task: 'fixture with no recorded answer' },
    createDependencies({
      searchMemories: () => Promise.reject(new Error('fixture retrieval failure')),
      searchTemporalMemories: () => Promise.reject(new Error('fixture retrieval failure')),
    }),
  );
  assert.equal(failed.orientation.taskSearchStatus, 'error');
  assert.deepEqual(failed.orientation.taskRelevant, []);
  for (const lane of ['direct', 'temporal', 'implication'])
    assert.ok(failed.warnings.some(warning => warning.includes(`search ${lane} failed`)));
});

test('fanout v1: direct-only output matches baseline when aux lanes empty', async () => {
  const result = await orientMemory(
    { envProbe: 'none', task: 'baseline check' },
    createDependencies({
      searchMemories: () => Promise.resolve([{ id: 10 }, { id: 11 }]),
      searchTemporalMemories: () => Promise.resolve([]),
    }),
  );

  const ids = result.orientation.taskRelevant.map(m => (isRecord(m) ? m.id : undefined));
  assert.deepEqual(ids, [10, 11]);
  if (result.orientation.retrievalDiagnostics === undefined) {
    assert.fail('expected retrievalDiagnostics');
  }
  assert.equal(result.orientation.retrievalDiagnostics.strategy, 'fanout_v1');
  assert.equal(result.orientation.retrievalDiagnostics.intents.temporal.hitCount, 0);
});

test('fanout v1: applies reversal penalty before lane reconciliation and keeps result diagnostics', async () => {
  const result = await orientMemory(
    { envProbe: 'none', task: 'reversal-aware retrieval ranking' },
    createDependencies({
      searchMemories: (input: unknown) => {
        const request = input as { query?: string };
        if (typeof request.query === 'string' && request.query.includes(' OR ')) {
          return Promise.resolve([]);
        }
        return Promise.resolve([
          {
            id: 61,
            relevance: 0.9,
            signals: {
              priorMemoryCount: 18,
              reversalPenalty: 0.5,
              reversalRate: 0.5,
              scope: 'author x category',
              window: '30d',
            },
          },
          { id: 62, relevance: 0.8 },
        ]);
      },
      searchTemporalMemories: () => Promise.resolve([]),
    }),
  );

  const ids = result.orientation.taskRelevant.map(m => (isRecord(m) ? m.id : undefined));
  assert.deepEqual(ids, [62, 61]);
  const penalized = result.orientation.taskRelevant.find(m => isRecord(m) && m.id === 61);
  assert.ok(isRecord(penalized));
  assert.deepEqual(penalized.signals, {
    priorMemoryCount: 18,
    reversalPenalty: 0.5,
    reversalRate: 0.5,
    scope: 'author x category',
    window: '30d',
  });
  const diagnostics = result.orientation.retrievalDiagnostics;
  assert.ok(diagnostics !== undefined);
  const penaltyDecision = diagnostics.merge.decisions[1];
  assert.ok(penaltyDecision !== undefined);
  assert.equal(penaltyDecision.memoryId, 61);
  assert.equal(penaltyDecision.reason, 'direct_baseline');
});

test('fanout v1: implication fills remaining budget with unique coverage', async () => {
  const result = await orientMemory(
    { envProbe: 'none', task: 'coverage check' },
    createDependencies({
      searchMemories: (input: unknown) => {
        const request = input as { query?: string };
        if (typeof request.query === 'string' && request.query.includes(' OR ')) {
          return Promise.resolve([{ id: 20 }, { category: 'workflow', id: 21 }, { category: 'convention', id: 22 }]);
        }
        return Promise.resolve([{ id: 20 }]);
      },
      searchTemporalMemories: () => Promise.resolve([]),
    }),
  );

  const ids = result.orientation.taskRelevant.map(m => (isRecord(m) ? m.id : undefined));
  // direct: [20], implication unique: [21, 22]
  assert.deepEqual(ids, [20, 21, 22]);
});

test('fanout v1: zero-direct fallback from auxiliary lanes', async () => {
  const result = await orientMemory(
    { envProbe: 'none', task: 'zero direct recovery' },
    createDependencies({
      searchMemories: (input: unknown) => {
        const request = input as { query?: string };
        if (typeof request.query === 'string' && request.query.includes(' OR ')) {
          return Promise.resolve([{ category: 'convention', id: 30 }]);
        }
        return Promise.resolve([]);
      },
      searchTemporalMemories: () => Promise.resolve([{ id: 31, status: 'contested' }]),
    }),
  );

  const ids = result.orientation.taskRelevant.map(m => (isRecord(m) ? m.id : undefined));
  assert.deepEqual(ids, [31, 30]);
  assert.equal(result.orientation.taskSearchStatus, 'ok');
});

test('fanout v1: merged result cap is 8', async () => {
  const result = await orientMemory(
    { envProbe: 'none', task: 'budget cap test' },
    createDependencies({
      searchMemories: (input: unknown) => {
        const request = input as { query?: string };
        if (typeof request.query === 'string' && request.query.includes(' OR ')) {
          return Promise.resolve([{ id: 106 }, { id: 107 }, { id: 108 }, { id: 109 }, { id: 110 }]);
        }
        return Promise.resolve([{ id: 101 }, { id: 102 }, { id: 103 }, { id: 104 }, { id: 105 }]);
      },
      searchTemporalMemories: () =>
        Promise.resolve([
          { id: 106, status: 'contested' },
          { id: 111, status: 'contested' },
        ]),
    }),
  );

  assert.ok(result.orientation.taskRelevant.length <= 8, 'merged result should be capped at 8');
  // direct: [101-105], temporal unique: [111], implication unique: [107,108,109,110] — but cap at 8
  const ids = result.orientation.taskRelevant.map(m => (isRecord(m) ? m.id : undefined));
  assert.equal(ids.length, 8);
  // first 5 are direct
  assert.deepEqual(ids.slice(0, 5), [101, 102, 103, 104, 105]);
});

test('fanout v1: per-lane failure isolation — temporal fails, direct succeeds', async () => {
  const result = await orientMemory(
    { envProbe: 'none', task: 'partial failure' },
    createDependencies({
      searchMemories: () => Promise.resolve([{ id: 40 }]),
      searchTemporalMemories: () => Promise.reject(new Error('temporal db error')),
    }),
  );

  assert.equal(result.orientation.taskSearchStatus, 'ok');
  assert.ok(result.warnings.some(w => w.includes('search temporal failed:')));
  const ids = result.orientation.taskRelevant.map(m => (isRecord(m) ? m.id : undefined));
  assert.ok(ids.includes(40));
  assert.equal(result.orientation.retrievalDiagnostics?.intents.temporal.status, 'error');
});

test('fanout v1: diagnostics Jaccard overlap is correct', async () => {
  const result = await orientMemory(
    { envProbe: 'none', task: 'overlap test' },
    createDependencies({
      searchMemories: (input: unknown) => {
        const request = input as { query?: string };
        if (typeof request.query === 'string' && request.query.includes(' OR ')) {
          return Promise.resolve([{ id: 50 }, { id: 51 }]);
        }
        return Promise.resolve([{ id: 50 }, { id: 52 }]);
      },
      searchTemporalMemories: () => Promise.resolve([{ id: 50, status: 'contested' }]),
    }),
  );

  const diag = result.orientation.retrievalDiagnostics;
  if (diag === undefined) {
    assert.fail('expected retrievalDiagnostics to be present');
  }
  assert.equal(diag.overlap.metric, 'jaccard');
  // direct: {50, 52}, temporal: {50}, implication: {50, 51}
  // directTemporal: intersection {50} / union {50,52} = 1/2 = 0.5
  assert.equal(diag.overlap.directTemporal, 0.5);
  // directImplication: intersection {50} / union {50, 51, 52} = 1/3
  assert.ok(Math.abs(diag.overlap.directImplication - 1 / 3) < 0.01);
  // temporalImplication: intersection {50} / union {50, 51} = 1/2
  assert.equal(diag.overlap.temporalImplication, 0.5);
});

test('fanout v1: decisionSampleTruncated when decisions exceed limit', async () => {
  // Create enough unique memories to exceed the 20-decision sample limit
  const directIds = Array.from({ length: 5 }, (_, i) => ({ id: i + 1 }));
  const temporalIds = Array.from({ length: 5 }, (_, i) => ({ id: i + 100, status: 'contested' }));
  const implicationIds = Array.from({ length: 15 }, (_, i) => ({ category: 'misc', id: i + 200 }));

  const result = await orientMemory(
    { envProbe: 'none', task: 'truncation test' },
    createDependencies({
      searchMemories: (input: unknown) => {
        const request = input as { query?: string };
        if (typeof request.query === 'string' && request.query.includes(' OR ')) {
          return Promise.resolve(implicationIds);
        }
        return Promise.resolve(directIds);
      },
      searchTemporalMemories: () => Promise.resolve(temporalIds),
    }),
  );

  const diag = result.orientation.retrievalDiagnostics;
  // 5 direct + 5 temporal + 15 implication = 25 decisions, but some trimmed by budget cap
  // The total candidate count is 25, but merged is capped at 8
  assert.ok(diag !== undefined);
  assert.ok(diag.merge.decisions.length <= 20);
});

test('orientMemory prunes session-summary memories when payload exceeds budget', async () => {
  // Create enough memories to exceed the 8000 char budget in compact format
  const recallMemories = [
    makeBudgetTestMemory(1, 'architecture'),
    ...Array.from({ length: 10 }, (_, i) => makeBudgetTestMemory(100 + i, 'session-summary')),
  ];
  const searchMemories = [
    makeBudgetTestMemory(2, 'root-cause'),
    ...Array.from({ length: 10 }, (_, i) => makeBudgetTestMemory(200 + i, 'session-summary')),
  ];

  const result = await orientMemory(
    { envProbe: 'none', task: 'prune test' },
    createDependencies({
      recallMemories: () => Promise.resolve(recallMemories),
      searchMemories: () => Promise.resolve(searchMemories),
    }),
  );

  const recentIds = result.orientation.recentMemories
    .map(m => (isRecord(m) ? m.id : undefined))
    .filter(id => id !== undefined);
  const taskIds = result.orientation.taskRelevant
    .map(m => (isRecord(m) ? m.id : undefined))
    .filter(id => id !== undefined);

  assert.ok(recentIds.includes(1), 'architecture memory preserved in recentMemories');
  assert.ok(
    !recentIds.some(id => typeof id === 'number' && id >= 100 && id < 200),
    'session-summaries pruned from recentMemories',
  );
  assert.ok(taskIds.includes(2), 'root-cause memory preserved in taskRelevant');
  assert.ok(!taskIds.some(id => typeof id === 'number' && id >= 200), 'session-summaries pruned from taskRelevant');
  assert.equal(result.orientation.memoryPayloadBudgetExceeded, false, 'budget no longer exceeded after pruning');
});

test('orientMemory does not prune session-summaries when payload is within budget', async () => {
  const shortContent = 'short content';
  const architectureMemory = { category: 'architecture', content: shortContent, id: 1, memoryType: 'semantic' };
  const sessionSummary = { category: 'session-summary', content: shortContent, id: 2, memoryType: 'episodic' };

  const result = await orientMemory(
    { envProbe: 'none', task: 'no prune test' },
    createDependencies({
      recallMemories: () => Promise.resolve([architectureMemory, sessionSummary]),
      searchMemories: () => Promise.resolve([]),
    }),
  );

  const recentIds = result.orientation.recentMemories
    .map(m => (isRecord(m) ? m.id : undefined))
    .filter(id => id !== undefined);

  assert.ok(recentIds.includes(1), 'architecture memory preserved');
  assert.ok(recentIds.includes(2), 'session-summary preserved when within budget');
  assert.equal(result.orientation.memoryPayloadBudgetExceeded, false);
});

test('orientMemory truncates non-session-summary memories when they still exceed budget after pruning', async () => {
  const longContent = 'y'.repeat(500);
  const makeMemory = (id: number) => ({
    category: 'architecture',
    content: longContent,
    id,
    memoryKey: `arch-key-${String(id)}`,
    memoryType: 'semantic',
    status: 'active',
    tags: ['tag-a', 'tag-b', 'tag-c'],
  });
  // All architecture memories (no session-summaries to prune), but enough to exceed budget
  const manyArchMemories = Array.from({ length: 20 }, (_, i) => makeMemory(i + 1));

  const result = await orientMemory(
    { envProbe: 'none', task: 'still exceeds test' },
    createDependencies({
      recallMemories: () => Promise.resolve(manyArchMemories),
      searchMemories: () => Promise.resolve(manyArchMemories),
    }),
  );

  assert.equal(result.orientation.memoryPayloadBudgetExceeded, false, 'hard cap should prevent over-budget payloads');
  assert.ok(
    result.orientation.memoryPayloadChars <= result.orientation.memoryPayloadBudgetChars * 1.05,
    'payload stays within 5% example after truncating non-session memories',
  );
  assert.ok(
    result.orientation.truncatedSections?.some(section => section === 'recentMemories' || section === 'taskRelevant'),
    'memory section truncation should be reported',
  );
});

test('orientMemory forces compact formatting on budget-pressure retry even when memoryDetail is full', async () => {
  const recallMemories = [
    makeBudgetTestMemory(1, 'architecture'),
    ...Array.from({ length: 10 }, (_, i) => makeBudgetTestMemory(100 + i, 'session-summary')),
  ];
  const searchMemories = [
    makeBudgetTestMemory(2, 'root-cause'),
    ...Array.from({ length: 10 }, (_, i) => makeBudgetTestMemory(200 + i, 'session-summary')),
  ];

  const result = await orientMemory(
    { envProbe: 'none', memoryDetail: 'full', task: 'full detail prune test' },
    createDependencies({
      recallMemories: () => Promise.resolve(recallMemories),
      searchMemories: () => Promise.resolve(searchMemories),
    }),
  );

  // After pruning under budget pressure, remaining memories should be compacted (excerpt, no full content)
  const firstRecent = result.orientation.recentMemories[0];
  assert.ok(isRecord(firstRecent), 'recentMemories has at least one entry');
  assert.ok('excerpt' in firstRecent, 'budget-pressure retry forced compact formatting (has excerpt)');
  assert.ok(!('content' in firstRecent), 'budget-pressure retry forced compact formatting (no full content)');
  assert.equal(result.orientation.memoryPayloadBudgetExceeded, false, 'budget resolved after compact + prune');

  // Metadata must reflect post-prune state
  assert.equal(
    result.orientation.taskSearchResultCount,
    result.orientation.taskRelevant.length,
    'taskSearchResultCount matches post-prune taskRelevant length',
  );
});

test('orientMemory backfills non-session-summary memories into taskRelevant slots after pruning', async () => {
  // Direct results: 8 session-summaries fill all merge slots, blocking implication architecture memories
  const directSessionSummaries = Array.from({ length: 8 }, (_, i) => makeBudgetTestMemory(100 + i, 'session-summary'));
  const implicationArchitectures = Array.from({ length: 5 }, (_, i) => makeBudgetTestMemory(200 + i, 'architecture'));
  // searchMemories returns direct results; second call returns implication results
  let callCount = 0;
  const searchMemories = () => {
    callCount += 1;
    // First call = direct lane, second call = implication lane
    return Promise.resolve(callCount === 1 ? directSessionSummaries : implicationArchitectures);
  };
  // Enough recall memories to push payload over budget
  const recallMemories = [
    makeBudgetTestMemory(1, 'architecture'),
    ...Array.from({ length: 15 }, (_, i) => makeBudgetTestMemory(50 + i, 'session-summary')),
  ];

  const result = await orientMemory(
    { envProbe: 'none', task: 'backfill test' },
    createDependencies({
      recallMemories: () => Promise.resolve(recallMemories),
      searchMemories,
    }),
  );

  const taskIds = result.orientation.taskRelevant
    .map(m => (isRecord(m) ? m.id : undefined))
    .filter(id => id !== undefined);

  // After pruning, implication architecture memories should be present (backfilled into freed slots)
  assert.ok(
    taskIds.some(id => typeof id === 'number' && id >= 200),
    'implication architecture memories backfilled into taskRelevant after session-summary pruning',
  );
  // Session-summaries should be gone
  assert.ok(
    !taskIds.some(id => typeof id === 'number' && id >= 100 && id < 200),
    'session-summaries removed from taskRelevant',
  );

  // Metadata must reflect post-prune state
  assert.equal(
    result.orientation.taskSearchResultCount,
    result.orientation.taskRelevant.length,
    'taskSearchResultCount matches post-prune taskRelevant length',
  );
  const diag = result.orientation.retrievalDiagnostics;
  assert.ok(diag !== undefined, 'retrievalDiagnostics present after re-merge');
  assert.equal(diag.merge.selectedCount, result.orientation.taskRelevant.length, 'diagnostics selectedCount matches');
  // All decision memoryIds in diagnostics should be in the final taskRelevant
  for (const decision of diag.merge.decisions) {
    assert.ok(
      taskIds.includes(decision.memoryId),
      `diagnostics decision memoryId ${String(decision.memoryId)} is in final taskRelevant`,
    );
  }
});

test('orientMemory preserves lane failure status in diagnostics after budget-pressure retry', async () => {
  const recallMemories = [
    makeBudgetTestMemory(1, 'architecture'),
    ...Array.from({ length: 15 }, (_, i) => makeBudgetTestMemory(50 + i, 'session-summary')),
  ];
  let searchCallCount = 0;
  const searchMemories = () => {
    searchCallCount += 1;
    return Promise.resolve(
      Array.from({ length: 5 }, (_, i) =>
        makeBudgetTestMemory(searchCallCount === 1 ? 100 + i : 200 + i, 'architecture'),
      ),
    );
  };

  const result = await orientMemory(
    { envProbe: 'none', task: 'lane failure retention test' },
    createDependencies({
      recallMemories: () => Promise.resolve(recallMemories),
      searchMemories,
      searchTemporalMemories: () => Promise.reject(new Error('temporal db error')),
    }),
  );

  // Budget pressure should have triggered the retry path
  const diag = result.orientation.retrievalDiagnostics;
  assert.ok(diag !== undefined, 'retrievalDiagnostics present after retry');
  // The temporal lane failed — diagnostics must preserve that error status, not report ok
  assert.equal(diag.intents.temporal.status, 'error', 'temporal lane failure status preserved after retry');
  assert.ok(diag.intents.temporal.durationMs >= 0, 'temporal lane timing is non-negative');
  // Direct and implication lanes succeeded — their status should remain ok
  assert.equal(diag.intents.direct.status, 'ok', 'direct lane status preserved');
  assert.equal(diag.intents.implication.status, 'ok', 'implication lane status preserved');
});

function createDependencies(overrides: Partial<MemoryOrientDependencies> = {}): MemoryOrientDependencies {
  return {
    countContestedMemories: () => Promise.resolve(2),
    getCapabilities: () => ({
      hasEmbeddingColumn: true,
      hasTrigram: false,
      hasVector: true,
    }),
    getSessionResume: () =>
      Promise.resolve({
        events: [],
        sessionId: LEGACY_SESSION_ID,
        status: 'ok',
      }),
    probeEnvironment: () => ({
      capability: 'local',
      environment: { ...DEFAULT_ENVIRONMENT },
      status: 'local',
      warnings: [],
    }),
    recallMemories: () => Promise.resolve([{ id: 1 }]),
    searchMemories: () => Promise.resolve([{ id: 2 }]),
    ...overrides,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function makeBudgetTestMemory(id: number, category: string) {
  return {
    category,
    content: 'x'.repeat(500),
    id,
    memoryKey: `key-${String(id)}`,
    memoryType: category === 'session-summary' ? 'episodic' : 'semantic',
    status: 'active',
    tags: ['tag-a', 'tag-b', 'tag-c'],
  };
}
