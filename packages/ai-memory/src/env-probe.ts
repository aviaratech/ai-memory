import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { formatError, isRecord } from './db/type-guards.js';

export type EnvProbeMode = 'full' | 'local' | 'none';
export interface EnvProbeResult {
  capability: 'full' | 'local' | 'none';
  environment: LocalEnvironment | null;
  status: EnvProbeStatus;
  warnings: string[];
}

export type EnvProbeStatus = 'disabled' | 'full' | 'local' | 'local_fallback' | 'unavailable';

export interface GitHubPullRequest {
  branch: string;
  number: number;
  title: string;
}

export interface LocalEnvironment {
  branch: null | string;
  detachedHead: boolean;
  failingChecks: string[];
  openPrs: GitHubPullRequest[];
  recentCommits: string[];
  uncommittedFiles: number;
  workspaceDirty: boolean;
}

interface ProbeEnvironmentOptions {
  cwd?: string;
  execGh?: (args: string[], timeoutMs: number) => string;
  execGit?: (args: string[]) => string;
  ghAuthTimeoutMs?: number;
  ghTimeoutMs?: number;
  timeoutMs?: number;
}

interface ProbeFailingChecksResult {
  failingChecks: string[];
  succeeded: boolean;
}

interface ProbeGitHubOptions {
  cwd?: string;
  execGh?: (args: string[], timeoutMs: number) => string;
  ghAuthTimeoutMs?: number;
  ghTimeoutMs?: number;
}

interface ProbeOpenPrsResult {
  openPrs: GitHubPullRequest[];
  succeeded: boolean;
}

const GH_AUTH_TIMEOUT_MS = 3000;
const GH_COMMAND_TIMEOUT_MS = 5000;
const FALLBACK_COMMAND_PATHS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const FALLBACK_GIT_COMMAND = '/usr/bin/git';
const FALLBACK_GH_COMMAND = '/usr/bin/gh';
const GIT_TIMEOUT_MS = 3000;
const GIT_BINARY = resolveCommand('git');
const GH_BINARY = resolveCommand('gh');

export interface ProbeGitHubResult {
  capability: 'full' | 'local';
  failingChecks: string[];
  openPrs: GitHubPullRequest[];
  warnings: string[];
}

type GhAuthWarningReasonCode = 'gh_auth_no_active_account' | 'gh_auth_parse_error' | 'gh_auth_timeout';

interface GitHubAuthEntry {
  detailLines: string[];
  loginLine: string;
}

class GhAuthProbeError extends Error {
  readonly reasonCode: GhAuthWarningReasonCode;

  constructor(reasonCode: GhAuthWarningReasonCode, details: string) {
    super(details);
    this.reasonCode = reasonCode;
  }
}

export function probeEnvironment(mode: EnvProbeMode, options: ProbeEnvironmentOptions = {}): EnvProbeResult {
  const warnings: string[] = [];
  if (mode === 'none') {
    return { capability: 'none', environment: null, status: 'disabled', warnings };
  }

  const execGit = options.execGit ?? createGitExecutor(options);
  try {
    const branchName = execGit(['rev-parse', '--abbrev-ref', 'HEAD']);
    const statusOutput = execGit(['status', '--porcelain']);
    const logOutput = execGit(['log', '--oneline', '-5']);

    const detachedHead = branchName === 'HEAD';
    const effectiveCwd = options.cwd ?? process.cwd();
    const inferredBranch = detachedHead ? inferBranchFromDetachedHead(execGit, effectiveCwd) : branchName;
    const uncommittedFiles = toNonEmptyLines(statusOutput).length;
    const localEnvironment: LocalEnvironment = {
      branch: inferredBranch,
      detachedHead,
      failingChecks: [],
      openPrs: [],
      recentCommits: toNonEmptyLines(logOutput),
      uncommittedFiles,
      workspaceDirty: uncommittedFiles > 0,
    };
    return {
      environment: localEnvironment,
      ...(mode === 'local'
        ? {
            capability: 'local' as const,
            status: 'local' as const,
            warnings,
          }
        : mergeLocalAndGitHub({
            environment: localEnvironment,
            github: probeGitHub(createProbeGitHubOptions(options)),
            warnings,
          })),
    };
  } catch (error: unknown) {
    warnings.push(`git probe failed: ${formatError(error)}`);
    return { capability: 'local', environment: null, status: 'unavailable', warnings };
  }
}

export function probeGitHub(options: ProbeGitHubOptions = {}): ProbeGitHubResult {
  const warnings: string[] = [];
  const execGh = options.execGh ?? createGhExecutor(options);
  const ghAuthTimeoutMs = options.ghAuthTimeoutMs ?? GH_AUTH_TIMEOUT_MS;
  const ghTimeoutMs = options.ghTimeoutMs ?? GH_COMMAND_TIMEOUT_MS;

  try {
    const activeAuthenticatedGithubDotComCount = getActiveAuthenticatedGithubAccountCount({
      execGh,
      timeoutMs: ghAuthTimeoutMs,
    });

    if (activeAuthenticatedGithubDotComCount === 0) {
      warnings.push(formatAuthWarning('gh_auth_no_active_account', 'no active authenticated github.com account'));
      return { capability: 'local', failingChecks: [], openPrs: [], warnings };
    }
  } catch (error: unknown) {
    if (error instanceof GhAuthProbeError) {
      warnings.push(formatAuthWarning(error.reasonCode, error.message));
    } else {
      warnings.push(`gh auth unavailable: ${formatError(error)} (reason: gh_auth_parse_error)`);
    }
    return { capability: 'local', failingChecks: [], openPrs: [], warnings };
  }

  const prs = probeOpenPrs({ execGh, timeoutMs: ghTimeoutMs, warnings });
  const checks = probeFailingChecks({
    execGh,
    timeoutMs: ghTimeoutMs,
    warnings,
  });

  return {
    capability: prs.succeeded && checks.succeeded ? 'full' : 'local',
    failingChecks: checks.failingChecks,
    openPrs: prs.openPrs,
    warnings,
  };
}

function commandPaths(): string[] {
  const envPath = process.env.PATH ?? '';
  return [...new Set([...envPath.split(delimiter).filter(Boolean), ...FALLBACK_COMMAND_PATHS])];
}

function createGhExecutor(options: ProbeGitHubOptions): (args: string[], timeoutMs: number) => string {
  const cwd = options.cwd ?? process.cwd();
  return (args: string[], timeoutMs: number) =>
    execFileSync(GH_BINARY, args, { cwd, encoding: 'utf8', timeout: timeoutMs }).trim().replace(/\r/g, '');
}

function createGitExecutor(options: ProbeEnvironmentOptions): (args: string[]) => string {
  const cwd = options.cwd ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  return (args: string[]) =>
    execFileSync(GIT_BINARY, args, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
    })
      .trim()
      .replace(/\r/g, '');
}

function createProbeGitHubOptions(options: ProbeEnvironmentOptions): ProbeGitHubOptions {
  const githubOptions: ProbeGitHubOptions = {};
  if (options.cwd !== undefined) {
    githubOptions.cwd = options.cwd;
  }
  if (options.execGh !== undefined) {
    githubOptions.execGh = options.execGh;
  }
  if (options.ghAuthTimeoutMs !== undefined) {
    githubOptions.ghAuthTimeoutMs = options.ghAuthTimeoutMs;
  }
  if (options.ghTimeoutMs !== undefined) {
    githubOptions.ghTimeoutMs = options.ghTimeoutMs;
  }
  return githubOptions;
}

function formatAuthWarning(reasonCode: GhAuthWarningReasonCode, details: string): string {
  return `gh auth unavailable: ${details} (reason: ${reasonCode})`;
}

function getActiveAuthenticatedGithubAccountCount(input: {
  execGh: (args: string[], timeoutMs: number) => string;
  timeoutMs: number;
}): number {
  try {
    const authOutput = input.execGh(['auth', 'status', '--active'], input.timeoutMs);
    return parseActiveAuthenticatedGithubAccountCount(authOutput);
  } catch (error: unknown) {
    if (isTimeoutError(error)) {
      throw new GhAuthProbeError('gh_auth_timeout', `timed out after ${String(input.timeoutMs)}ms`);
    }

    if (isNoActiveAuthError(error)) {
      return 0;
    }

    return getActiveAuthenticatedGithubAccountCountFromFallback(input);
  }
}

function getActiveAuthenticatedGithubAccountCountFromFallback(input: {
  execGh: (args: string[], timeoutMs: number) => string;
  timeoutMs: number;
}): number {
  try {
    const authStatusOutput = input.execGh(['auth', 'status'], input.timeoutMs);
    return parseActiveAuthenticatedGithubAccountCount(authStatusOutput);
  } catch (error: unknown) {
    if (isTimeoutError(error)) {
      throw new GhAuthProbeError('gh_auth_timeout', `timed out after ${String(input.timeoutMs)}ms`);
    }
    if (isNoActiveAuthError(error)) {
      return 0;
    }
    throw new GhAuthProbeError('gh_auth_parse_error', formatError(error));
  }
}

function hasGithubReference(lines: string[]): boolean {
  return lines.some(line => /\bgithub\.com\b/i.test(line));
}

function inferBranchFromDetachedHead(execGit: (args: string[]) => string, cwd: string): null | string {
  const headRef = process.env.GITHUB_HEAD_REF;
  if (headRef !== undefined && headRef.length > 0) {
    return headRef;
  }

  try {
    const worktreeOutput = execGit(['worktree', 'list', '--porcelain']);
    const branch = parseWorktreeBranch(worktreeOutput, cwd);
    if (branch !== null) {
      return branch;
    }
  } catch {
    // worktree list failed — fall through
  }

  try {
    const pointsAt = execGit(['branch', '--points-at', 'HEAD', '--format=%(refname:short)']);
    const branches = toNonEmptyLines(pointsAt);
    const first = branches[0];
    if (first !== undefined) {
      return first;
    }
  } catch {
    // branch --points-at failed — fall through
  }

  return null;
}

function isActiveGithubAuthenticationLine(line: string): boolean {
  const lowerLine = line.toLowerCase();
  if (!/\bgithub\.com\b/.test(lowerLine)) {
    return false;
  }

  if (!/[✓*]/.test(line)) {
    return false;
  }

  if (!lowerLine.includes('logged in')) {
    return false;
  }

  return !/(inactive|expired|not.*active|not.*logged in)/.test(lowerLine);
}

function isActiveGitHubAuthEntry(entry: GitHubAuthEntry): boolean {
  const explicitActiveAccountFlag = parseExplicitActiveAccountFlag([entry.loginLine, ...entry.detailLines]);
  if (explicitActiveAccountFlag !== null) {
    return explicitActiveAccountFlag;
  }
  return isActiveGithubAuthenticationLine(entry.loginLine);
}

function isAuthOutputNoActive(outputOrError: Error | string): boolean {
  const text = (typeof outputOrError === 'string' ? outputOrError : formatError(outputOrError)).toLowerCase();
  return /not logged in to github\.com|no active account|no active github\.com|not authenticated/.test(text);
}

function isGithubAuthenticationLine(line: string): boolean {
  const lowerLine = line.toLowerCase();
  return /\bgithub\.com\b/.test(lowerLine) && lowerLine.includes('logged in');
}

function isNoActiveAuthError(error: unknown): boolean {
  const errorText = formatError(error).toLowerCase();
  return /not logged in|not authenticated|no active account|no github\.com account|no logged/.test(errorText);
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('timed out');
}

function mergeLocalAndGitHub(input: {
  environment: LocalEnvironment;
  github: ProbeGitHubResult;
  warnings: string[];
}): Pick<EnvProbeResult, 'capability' | 'environment' | 'status' | 'warnings'> {
  input.warnings.push(...input.github.warnings);
  return {
    capability: input.github.capability,
    environment: {
      ...input.environment,
      failingChecks: input.github.failingChecks,
      openPrs: input.github.openPrs,
    },
    status: input.github.capability === 'full' ? 'full' : 'local_fallback',
    warnings: input.warnings,
  };
}

function parseActiveAuthenticatedGithubAccountCount(authOutput: string): number {
  const lines = toNonEmptyLines(authOutput);
  if (lines.length === 0) {
    throw new Error('auth status output is empty');
  }

  if (isAuthOutputNoActive(authOutput)) {
    return 0;
  }

  const githubAuthEntries = parseGitHubAuthEntries(lines);
  if (githubAuthEntries.length > 0) {
    return githubAuthEntries.filter(isActiveGitHubAuthEntry).length;
  }

  if (hasGithubReference(lines)) {
    return 0;
  }

  throw new Error('unable to parse gh auth status output');
}

function parseExplicitActiveAccountFlag(lines: string[]): boolean | null {
  for (const line of lines) {
    const lowerLine = line.toLowerCase();
    if (/active account\s*:\s*(false|no)\b/.test(lowerLine) || /active\s*:\s*(false|no)\b/.test(lowerLine)) {
      return false;
    }
    if (/active account\s*:\s*(true|yes)\b/.test(lowerLine) || /active\s*:\s*(true|yes)\b/.test(lowerLine)) {
      return true;
    }
  }
  return null;
}

function parseFailingChecks(output: string): string[] {
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed)) {
    throw new Error('expected array from gh run list');
  }

  const failingChecks: string[] = [];
  for (const item of parsed) {
    if (!isRecord(item) || typeof item.name !== 'string') {
      throw new Error('invalid run record from gh run list');
    }
    if (item.conclusion === 'failure') {
      failingChecks.push(item.name);
    }
  }

  return failingChecks;
}

function parseGitHubAuthEntries(lines: string[]): GitHubAuthEntry[] {
  const entries: GitHubAuthEntry[] = [];
  let currentEntry: GitHubAuthEntry | null = null;

  for (const line of lines) {
    if (isGithubAuthenticationLine(line)) {
      currentEntry = { detailLines: [], loginLine: line };
      entries.push(currentEntry);
      continue;
    }

    if (currentEntry !== null) {
      currentEntry.detailLines.push(line);
    }
  }

  return entries;
}

function parseOpenPrs(output: string): GitHubPullRequest[] {
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed)) {
    throw new Error('expected array from gh pr list');
  }

  return parsed.map(item => {
    if (
      !isRecord(item) ||
      typeof item.headRefName !== 'string' ||
      typeof item.number !== 'number' ||
      typeof item.title !== 'string'
    ) {
      throw new Error('invalid PR record from gh pr list');
    }
    return { branch: item.headRefName, number: item.number, title: item.title };
  });
}

function parseWorktreeBranch(porcelainOutput: string, cwd: string): null | string {
  const blocks = porcelainOutput.split('\n\n');
  const parsed = blocks.map(block => {
    const lines = block
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0);
    return {
      branch: lines.find(l => l.startsWith('branch '))?.slice('branch '.length) ?? null,
      detached: lines.some(l => l === 'detached'),
      head: lines.find(l => l.startsWith('HEAD '))?.slice('HEAD '.length) ?? null,
      worktree: lines.find(l => l.startsWith('worktree '))?.slice('worktree '.length) ?? null,
    };
  });

  const current = parsed.find(b => b.worktree === cwd);
  if (current === undefined) {
    return null;
  }

  if (current.branch !== null) {
    return current.branch.replace(/^refs\/heads\//, '');
  }

  if (current.detached && current.head !== null) {
    const match = parsed.find(b => b !== current && b.head === current.head && b.branch !== null);
    if (match?.branch !== null && match?.branch !== undefined) {
      return match.branch.replace(/^refs\/heads\//, '');
    }
  }

  return null;
}

function pathHasExecutable(path: string): boolean {
  if (!existsSync(path)) {
    return false;
  }

  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function probeFailingChecks(input: {
  execGh: (args: string[], timeoutMs: number) => string;
  timeoutMs: number;
  warnings: string[];
}): ProbeFailingChecksResult {
  let output: string;
  try {
    output = input.execGh(['run', 'list', '--limit', '5', '--json', 'status,conclusion,name'], input.timeoutMs);
  } catch (error: unknown) {
    input.warnings.push(isTimeoutError(error) ? 'gh run list timed out' : `gh run list failed: ${formatError(error)}`);
    return { failingChecks: [], succeeded: false };
  }

  try {
    return { failingChecks: parseFailingChecks(output), succeeded: true };
  } catch (error: unknown) {
    input.warnings.push(`gh run list parse failed: ${formatError(error)}`);
    return { failingChecks: [], succeeded: false };
  }
}

function probeOpenPrs(input: {
  execGh: (args: string[], timeoutMs: number) => string;
  timeoutMs: number;
  warnings: string[];
}): ProbeOpenPrsResult {
  let output: string;
  try {
    output = input.execGh(['pr', 'list', '--json', 'number,title,headRefName', '--limit', '10'], input.timeoutMs);
  } catch (error: unknown) {
    input.warnings.push(isTimeoutError(error) ? 'gh pr list timed out' : `gh pr list failed: ${formatError(error)}`);
    return { openPrs: [], succeeded: false };
  }

  try {
    return { openPrs: parseOpenPrs(output), succeeded: true };
  } catch (error: unknown) {
    input.warnings.push(`gh pr list parse failed: ${formatError(error)}`);
    return { openPrs: [], succeeded: false };
  }
}

function resolveCommand(name: 'gh' | 'git'): string {
  const candidates = commandPaths().map(base => join(base, name));
  const resolved = candidates.find(pathHasExecutable);
  if (resolved !== undefined) {
    return resolved;
  }

  if (name === 'git') {
    return FALLBACK_GIT_COMMAND;
  }

  return FALLBACK_GH_COMMAND;
}

function toNonEmptyLines(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
}
