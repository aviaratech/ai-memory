import assert from 'node:assert/strict';
import { test } from 'vitest';

import { probeEnvironment, probeGitHub } from './env-probe.js';

interface GitHubCommandStep {
  command: string;
  error?: string;
  output?: string;
}

interface ProbeGitHubFixture {
  expected: {
    calls: string[];
    capability: 'full' | 'local';
    failingChecks: string[];
    openPrs: { branch: string; number: number; title: string }[];
    warnings: string[];
  };
  name: string;
  steps: GitHubCommandStep[];
}

test('probeEnvironment local returns detached HEAD with null branch when no inference source', () => {
  const originalEnv = process.env.GITHUB_HEAD_REF;
  delete process.env.GITHUB_HEAD_REF;
  try {
    const calls: string[] = [];
    const result = probeEnvironment('local', {
      execGit: args => {
        const command = args.join(' ');
        calls.push(command);
        if (command === 'rev-parse --abbrev-ref HEAD') return 'HEAD';
        if (command === 'worktree list --porcelain') throw new Error('not in a worktree');
        if (command === 'branch --points-at HEAD --format=%(refname:short)') return '';
        if (command === 'status --porcelain') return 'M package.json\n?? new-file.ts';
        if (command === 'log --oneline -5') return 'abc123 commit one\nbcd234 commit two';
        throw new Error(`unexpected command: ${command}`);
      },
    });

    assert.equal(result.capability, 'local');
    assert.equal(result.status, 'local');
    assert.deepEqual(result.warnings, []);
    const environment = result.environment;
    if (environment === null) {
      assert.fail('environment should be present for successful local probe');
    }
    assert.equal(environment.detachedHead, true);
    assert.equal(environment.branch, null);
    assert.equal(environment.workspaceDirty, true);
    assert.equal(environment.uncommittedFiles, 2);
    assert.deepEqual(environment.openPrs, []);
    assert.deepEqual(environment.failingChecks, []);
    assert.deepEqual(environment.recentCommits, ['abc123 commit one', 'bcd234 commit two']);
    assert.deepEqual(calls, [
      'rev-parse --abbrev-ref HEAD',
      'status --porcelain',
      'log --oneline -5',
      'worktree list --porcelain',
      'branch --points-at HEAD --format=%(refname:short)',
    ]);
  } finally {
    if (originalEnv !== undefined) {
      process.env.GITHUB_HEAD_REF = originalEnv;
    }
  }
});

test('probeEnvironment infers branch from GITHUB_HEAD_REF in detached HEAD', () => {
  const originalEnv = process.env.GITHUB_HEAD_REF;
  process.env.GITHUB_HEAD_REF = 'feature/my-branch';
  try {
    const result = probeEnvironment('local', {
      execGit: args => {
        const command = args.join(' ');
        if (command === 'rev-parse --abbrev-ref HEAD') return 'HEAD';
        if (command === 'status --porcelain') return '';
        if (command === 'log --oneline -5') return 'abc123 commit one';
        throw new Error(`unexpected command: ${command}`);
      },
    });

    const environment = result.environment;
    if (environment === null) {
      assert.fail('environment should be present');
    }
    assert.equal(environment.detachedHead, true);
    assert.equal(environment.branch, 'feature/my-branch');
  } finally {
    if (originalEnv !== undefined) {
      process.env.GITHUB_HEAD_REF = originalEnv;
    } else {
      delete process.env.GITHUB_HEAD_REF;
    }
  }
});

test('probeEnvironment infers branch from detached worktree by correlating HEAD with sibling', () => {
  const originalEnv = process.env.GITHUB_HEAD_REF;
  delete process.env.GITHUB_HEAD_REF;
  const cwd = process.cwd();
  try {
    // Real detached worktree: current block has `detached`, sibling has same HEAD + branch
    const worktreeOutput = [
      `worktree /main/repo`,
      `HEAD abc1234`,
      `branch refs/heads/main`,
      ``,
      `worktree /source/worktree`,
      `HEAD def5678`,
      `branch refs/heads/issue/143`,
      ``,
      `worktree ${cwd}`,
      `HEAD def5678`,
      `detached`,
    ].join('\n');

    const result = probeEnvironment('local', {
      cwd,
      execGit: args => {
        const command = args.join(' ');
        if (command === 'rev-parse --abbrev-ref HEAD') return 'HEAD';
        if (command === 'worktree list --porcelain') return worktreeOutput;
        if (command === 'status --porcelain') return '';
        if (command === 'log --oneline -5') return 'def5678 commit one';
        throw new Error(`unexpected command: ${command}`);
      },
    });

    const environment = result.environment;
    if (environment === null) {
      assert.fail('environment should be present');
    }
    assert.equal(environment.detachedHead, true);
    assert.equal(environment.branch, 'issue/143');
  } finally {
    if (originalEnv !== undefined) {
      process.env.GITHUB_HEAD_REF = originalEnv;
    }
  }
});

test('probeEnvironment infers branch via git branch --points-at when worktree has no sibling match', () => {
  const originalEnv = process.env.GITHUB_HEAD_REF;
  delete process.env.GITHUB_HEAD_REF;
  const cwd = process.cwd();
  try {
    // Detached worktree with no sibling sharing same HEAD — falls through to git branch --points-at
    const worktreeOutput = [
      `worktree /main/repo`,
      `HEAD abc1234`,
      `branch refs/heads/main`,
      ``,
      `worktree ${cwd}`,
      `HEAD def5678`,
      `detached`,
    ].join('\n');

    const calls: string[] = [];
    const result = probeEnvironment('local', {
      cwd,
      execGit: args => {
        const command = args.join(' ');
        calls.push(command);
        if (command === 'rev-parse --abbrev-ref HEAD') return 'HEAD';
        if (command === 'worktree list --porcelain') return worktreeOutput;
        if (command === 'branch --points-at HEAD --format=%(refname:short)') return 'issue/143';
        if (command === 'status --porcelain') return '';
        if (command === 'log --oneline -5') return 'def5678 commit one';
        throw new Error(`unexpected command: ${command}`);
      },
    });

    const environment = result.environment;
    if (environment === null) {
      assert.fail('environment should be present');
    }
    assert.equal(environment.detachedHead, true);
    assert.equal(environment.branch, 'issue/143');
    assert.ok(calls.includes('branch --points-at HEAD --format=%(refname:short)'));
  } finally {
    if (originalEnv !== undefined) {
      process.env.GITHUB_HEAD_REF = originalEnv;
    }
  }
});

test('probeEnvironment local returns null environment when git times out', () => {
  const result = probeEnvironment('local', {
    execGit: () => {
      throw new Error('timed out after 3000ms');
    },
  });

  assert.equal(result.capability, 'local');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.environment, null);
  assert.equal(result.warnings[0], 'git probe failed: timed out after 3000ms');
});

const PRS_COMMAND = 'pr list --json number,title,headRefName --limit 10';
const RUNS_COMMAND = 'run list --limit 5 --json status,conclusion,name';

const probeGitHubFixtures: ProbeGitHubFixture[] = [
  {
    expected: {
      calls: ['auth status --active::3000', `${PRS_COMMAND}::5000`, `${RUNS_COMMAND}::5000`],
      capability: 'full',
      failingChecks: [],
      openPrs: [],
      warnings: [],
    },
    name: 'single active account keeps full probe',
    steps: [
      {
        command: 'auth status --active',
        output: '✓ Logged in to github.com as ci-bot',
      },
      { command: PRS_COMMAND, output: '[]' },
      { command: RUNS_COMMAND, output: '[]' },
    ],
  },
  {
    expected: {
      calls: ['auth status --active::3000', `${PRS_COMMAND}::5000`, `${RUNS_COMMAND}::5000`],
      capability: 'full',
      failingChecks: [],
      openPrs: [],
      warnings: [],
    },
    name: 'active + stale accounts still keeps full probe',
    steps: [
      {
        command: 'auth status --active',
        output: '✓ Logged in to github.com as active-user\nx Logged in to github.com as stale-user (inactive)',
      },
      { command: PRS_COMMAND, output: '[]' },
      { command: RUNS_COMMAND, output: '[]' },
    ],
  },
  {
    expected: {
      calls: ['auth status --active::3000', 'auth status::3000', `${PRS_COMMAND}::5000`, `${RUNS_COMMAND}::5000`],
      capability: 'full',
      failingChecks: ['build'],
      openPrs: [{ branch: 'issue-1354', number: 101, title: 'Add env probe' }],
      warnings: [],
    },
    name: 'unsupported --active path falls back to full auth status',
    steps: [
      { command: 'auth status --active', error: 'unknown flag: --active' },
      {
        command: 'auth status',
        output: '✓ Logged in to github.com as fallback-bot',
      },
      {
        command: PRS_COMMAND,
        output: '[{"number":101,"title":"Add env probe","headRefName":"issue-1354"}]',
      },
      {
        command: RUNS_COMMAND,
        output:
          '[{"status":"completed","conclusion":"failure","name":"build"},{"status":"completed","conclusion":"success","name":"lint"}]',
      },
    ],
  },
  {
    expected: {
      calls: ['auth status --active::3000', 'auth status::3000'],
      capability: 'local',
      failingChecks: [],
      openPrs: [],
      warnings: ['gh auth unavailable: no active authenticated github.com account (reason: gh_auth_no_active_account)'],
    },
    name: 'fallback auth status honors explicit inactive markers',
    steps: [
      { command: 'auth status --active', error: 'unknown flag: --active' },
      {
        command: 'auth status',
        output:
          'github.com\n' +
          '✓ Logged in to github.com account stale-bot\n' +
          '- Active account: false\n' +
          '✓ Logged in to github.com account still-stale\n' +
          '- Active account: no',
      },
    ],
  },
  {
    expected: {
      calls: ['auth status --active::3000', 'auth status::3000', `${PRS_COMMAND}::5000`, `${RUNS_COMMAND}::5000`],
      capability: 'full',
      failingChecks: [],
      openPrs: [],
      warnings: [],
    },
    name: 'fallback auth status keeps full probe when one account is explicitly active',
    steps: [
      { command: 'auth status --active', error: 'unknown flag: --active' },
      {
        command: 'auth status',
        output:
          'github.com\n' +
          '✓ Logged in to github.com account active-user\n' +
          '- Active account: true\n' +
          '✓ Logged in to github.com account stale-user\n' +
          '- Active account: false',
      },
      { command: PRS_COMMAND, output: '[]' },
      { command: RUNS_COMMAND, output: '[]' },
    ],
  },
  {
    expected: {
      calls: ['auth status --active::3000', 'auth status::3000'],
      capability: 'local',
      failingChecks: [],
      openPrs: [],
      warnings: ['gh auth unavailable: unable to parse gh auth status output (reason: gh_auth_parse_error)'],
    },
    name: 'parse error in auth output downgrades with parse warning',
    steps: [
      { command: 'auth status --active', output: 'unexpected status payload' },
      { command: 'auth status', output: 'parse failed payload' },
    ],
  },
  {
    expected: {
      calls: ['auth status --active::3000'],
      capability: 'local',
      failingChecks: [],
      openPrs: [],
      warnings: ['gh auth unavailable: timed out after 3000ms (reason: gh_auth_timeout)'],
    },
    name: 'gh auth timeout downgrades and preserves timeout constant usage',
    steps: [{ command: 'auth status --active', error: 'timed out after 3000ms' }],
  },
  {
    expected: {
      calls: ['auth status --active::3000'],
      capability: 'local',
      failingChecks: [],
      openPrs: [],
      warnings: ['gh auth unavailable: no active authenticated github.com account (reason: gh_auth_no_active_account)'],
    },
    name: 'only stale/inactive accounts downgrade to local',
    steps: [
      {
        command: 'auth status --active',
        output: 'x Logged in to github.com account stale-user (inactive)',
      },
    ],
  },
  {
    expected: {
      calls: ['auth status --active::3000', `${PRS_COMMAND}::5000`, `${RUNS_COMMAND}::5000`],
      capability: 'local',
      failingChecks: ['build'],
      openPrs: [],
      warnings: ['gh pr list timed out'],
    },
    name: 'pr list timeout still keeps failing checks and downgrades',
    steps: [
      {
        command: 'auth status --active',
        output: '✓ Logged in to github.com as ci-bot',
      },
      { command: PRS_COMMAND, error: 'timed out after 5000ms' },
      {
        command: RUNS_COMMAND,
        output: '[{"status":"completed","conclusion":"failure","name":"build"}]',
      },
    ],
  },
  {
    expected: {
      calls: ['auth status --active::3000', `${PRS_COMMAND}::5000`, `${RUNS_COMMAND}::5000`],
      capability: 'full',
      failingChecks: ['test'],
      openPrs: [{ branch: 'issue-1354', number: 101, title: 'Add env probe' }],
      warnings: [],
    },
    name: 'parses open PRs and failing checks from JSON output',
    steps: [
      {
        command: 'auth status --active',
        output: '✓ Logged in to github.com as ci-bot',
      },
      {
        command: PRS_COMMAND,
        output: '[{"number":101,"title":"Add env probe","headRefName":"issue-1354"}]',
      },
      {
        command: RUNS_COMMAND,
        output:
          '[' +
          '{"status":"completed","conclusion":"failure","name":"test"},' +
          '{"status":"completed","conclusion":"success","name":"lint"}' +
          ']',
      },
    ],
  },
];

for (const fixture of probeGitHubFixtures) {
  test(`probeGitHub fixture: ${fixture.name}`, () => {
    const result = runProbeGitHubFixture(fixture);
    assert.equal(result.capability, fixture.expected.capability);
    assert.deepEqual(result.openPrs, fixture.expected.openPrs);
    assert.deepEqual(result.failingChecks, fixture.expected.failingChecks);
    assert.deepEqual(result.warnings, fixture.expected.warnings);
    assert.deepEqual(result.calls, fixture.expected.calls);
  });
}

function runProbeGitHubFixture(fixture: ProbeGitHubFixture): {
  calls: string[];
  capability: 'full' | 'local';
  failingChecks: string[];
  openPrs: { branch: string; number: number; title: string }[];
  warnings: string[];
} {
  const calls: string[] = [];
  const steps = [...fixture.steps];
  const result = probeGitHub({
    execGh: (args, timeoutMs) => {
      const command = args.join(' ');
      const next = steps.shift();
      if (next?.command !== command) {
        throw new Error(`unexpected command: ${command}`);
      }
      calls.push(`${command}::${String(timeoutMs)}`);
      if (next.error !== undefined) {
        throw new Error(next.error);
      }
      if (next.output === undefined) {
        throw new Error(`missing output for command: ${command}`);
      }
      return next.output;
    },
  });

  return {
    calls,
    capability: result.capability,
    failingChecks: result.failingChecks,
    openPrs: result.openPrs,
    warnings: result.warnings,
  };
}
