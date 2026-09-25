import { formatError, isRecord } from '@aviaratech/ai-memory/internal';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export { formatError };

export interface EnvironmentFixture {
  expected: {
    branch: null | string;
    recentCommitsLength: number;
    uncommittedFiles: number;
    workspaceDirty: boolean;
  };
  scenario: {
    branch: string;
    commitMessages: string[];
    detachedHead: boolean;
    stagedFiles: number;
    unstagedFiles: number;
  };
}

export interface EnvironmentObservation {
  branch: null | string;
  recentCommitsLength: number;
  uncommittedFiles: number;
  workspaceDirty: boolean;
}

export function createTempRepoDirectory(): string {
  return resolve(mkdtempSync(join(tmpdir(), 'ai-memory-environment-suite-')));
}

export function parseEnvironmentFixture(rawFixture: string): EnvironmentFixture {
  const parsed: unknown = JSON.parse(rawFixture);
  if (!isRecord(parsed)) {
    throw new Error('environment fixture must be a JSON object');
  }
  if (!isRecord(parsed.scenario)) {
    throw new Error('environment fixture must include a "scenario" object');
  }
  if (!isRecord(parsed.expected)) {
    throw new Error('environment fixture must include an "expected" object');
  }

  const branch = typeof parsed.scenario.branch === 'string' ? parsed.scenario.branch.trim() : '';
  if (branch.length === 0) {
    throw new Error('environment fixture scenario.branch must be a non-empty string');
  }
  const commitMessages = parseCommitMessages(parsed.scenario.commitMessages);

  return {
    expected: {
      branch:
        typeof parsed.expected.branch === 'string' && parsed.expected.branch.trim().length > 0
          ? parsed.expected.branch.trim()
          : null,
      recentCommitsLength:
        typeof parsed.expected.recentCommitsLength === 'number' ? parsed.expected.recentCommitsLength : 0,
      uncommittedFiles: typeof parsed.expected.uncommittedFiles === 'number' ? parsed.expected.uncommittedFiles : 0,
      workspaceDirty: parsed.expected.workspaceDirty === true,
    },
    scenario: {
      branch,
      commitMessages,
      detachedHead: parsed.scenario.detachedHead === true,
      stagedFiles: typeof parsed.scenario.stagedFiles === 'number' ? parsed.scenario.stagedFiles : 0,
      unstagedFiles: typeof parsed.scenario.unstagedFiles === 'number' ? parsed.scenario.unstagedFiles : 0,
    },
  };
}

export function readEnvironmentObservation(orientResult: unknown): EnvironmentObservation {
  const root = isRecord(orientResult) ? orientResult : null;
  const orientation = root !== null && isRecord(root.orientation) ? root.orientation : null;
  const environment = orientation !== null && isRecord(orientation.environment) ? orientation.environment : null;

  return {
    branch: readEnvironmentBranch(environment),
    recentCommitsLength: readEnvironmentRecentCommitLength(environment),
    uncommittedFiles: readEnvironmentUncommittedFiles(environment),
    workspaceDirty: readEnvironmentWorkspaceDirty(environment),
  };
}

export function readFixtureFiles(fixtureDirectory: string): string[] {
  if (!existsSync(fixtureDirectory)) {
    return [];
  }
  return readdirSync(fixtureDirectory)
    .filter(fileName => fileName.endsWith('.json'))
    .map(fileName => resolve(fixtureDirectory, fileName))
    .sort((left, right) => left.localeCompare(right));
}

export function setupFixtureRepository(input: { fixture: EnvironmentFixture; repoDirectory: string }): void {
  const { fixture, repoDirectory } = input;
  initializeGitRepository({ branch: fixture.scenario.branch, repoDirectory });

  for (const [index, message] of fixture.scenario.commitMessages.entries()) {
    const trackedFile = resolve(repoDirectory, 'tracked-memory.txt');
    const existingContents = existsSync(trackedFile) ? readFileSync(trackedFile, 'utf8') : '';
    writeFileSync(trackedFile, `${existingContents}commit-${String(index + 1)}:${message}\n`);
    runGit(repoDirectory, ['add', basename(trackedFile)]);
    runGit(repoDirectory, ['commit', '-m', message]);
  }

  for (let index = 0; index < fixture.scenario.stagedFiles; index += 1) {
    const stagedFile = resolve(repoDirectory, `staged-${String(index + 1)}.txt`);
    writeFileSync(stagedFile, `staged file ${String(index + 1)}\n`);
    runGit(repoDirectory, ['add', basename(stagedFile)]);
  }

  for (let index = 0; index < fixture.scenario.unstagedFiles; index += 1) {
    const unstagedFile = resolve(repoDirectory, `unstaged-${String(index + 1)}.txt`);
    writeFileSync(unstagedFile, `unstaged file ${String(index + 1)}\n`);
  }

  if (fixture.scenario.detachedHead) {
    if (fixture.scenario.commitMessages.length < 2) {
      throw new Error('detachedHead fixtures require at least 2 commits');
    }
    runGit(repoDirectory, ['checkout', 'HEAD~1']);
  }
}

function initializeGitRepository(input: { branch: string; repoDirectory: string }): void {
  try {
    runGit(input.repoDirectory, ['init', '-b', input.branch]);
  } catch {
    runGit(input.repoDirectory, ['init']);
    runGit(input.repoDirectory, ['checkout', '-b', input.branch]);
  }

  runGit(input.repoDirectory, ['config', 'user.email', 'ai-memory-eval@aviaratech.local']);
  runGit(input.repoDirectory, ['config', 'user.name', 'AI Memory Eval']);
}

function parseCommitMessages(input: unknown): string[] {
  const commitMessages: string[] = [];
  if (Array.isArray(input)) {
    for (const value of input) {
      if (typeof value === 'string' && value.trim().length > 0) {
        commitMessages.push(value.trim());
      }
    }
  }
  if (commitMessages.length === 0) {
    throw new Error('environment fixture scenario.commitMessages must include at least one message');
  }
  return commitMessages;
}

function readEnvironmentBranch(environment: null | Record<string, unknown>): null | string {
  if (environment === null) {
    return null;
  }
  return typeof environment.branch === 'string' ? environment.branch : null;
}

function readEnvironmentRecentCommitLength(environment: null | Record<string, unknown>): number {
  if (environment === null || !Array.isArray(environment.recentCommits)) {
    return 0;
  }
  return environment.recentCommits.length;
}

function readEnvironmentUncommittedFiles(environment: null | Record<string, unknown>): number {
  if (environment === null || typeof environment.uncommittedFiles !== 'number') {
    return 0;
  }
  return environment.uncommittedFiles;
}

function readEnvironmentWorkspaceDirty(environment: null | Record<string, unknown>): boolean {
  if (environment === null) {
    return false;
  }
  return environment.workspaceDirty === true;
}

function runGit(repoDirectory: string, args: string[]): string {
  return execFileSync('/usr/bin/git', args, {
    cwd: repoDirectory,
    encoding: 'utf8',
  }).trim();
}
