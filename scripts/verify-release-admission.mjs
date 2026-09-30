import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [directory, repository, source, sourceTree, reviewer] = process.argv.slice(2);
assert.ok(directory && repository && reviewer, 'Usage: verify-release-admission <directory> <repository> <source> <tree> <reviewer>');
assert.match(source ?? '', /^[0-9a-f]{40}$/, 'invalid source SHA');
assert.match(sourceTree ?? '', /^[0-9a-f]{40}$/, 'invalid source tree');
assert.ok(reviewer.endsWith('[bot]'), 'configured reviewer must be an App actor');
const read = name => JSON.parse(readFileSync(join(directory, `${name}.json`), 'utf8'));
const pullRequests = read('pullRequests');
const headCommit = read('headCommit');
const reviews = read('reviews');
const workflowRuns = read('workflowRuns');
for (const [name, value] of Object.entries({ pullRequests, reviews, workflowRuns })) {
  assert.ok(Array.isArray(value), `${name} must be an array`);
}

const merged = pullRequests.filter(pr => pr.state === 'closed' && pr.merged_at && pr.merge_commit_sha === source);
assert.equal(merged.length, 1, 'source must identify one merged main PR');
const pr = merged[0];
assert.ok(Number.isSafeInteger(pr.number) && pr.number > 0, 'invalid PR number');
assert.ok(pr.base?.ref === 'main' && pr.base.repo?.full_name === repository, 'source must come from a canonical main PR');
assert.match(pr.head?.sha ?? '', /^[0-9a-f]{40}$/, 'invalid PR head');
assert.ok(pr.user?.login && pr.user.login.toLowerCase() !== reviewer.toLowerCase(), 'reviewer must be distinct from the PR author');

const decisive = reviews.filter(review => review.user?.login === reviewer && review.user.type === 'Bot' &&
  ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state));
for (const review of decisive) assert.ok(Number.isSafeInteger(review.id) && review.id > 0, 'invalid review identity');
decisive.sort((a, b) => b.id - a.id);
const approval = decisive[0];
assert.equal(approval?.state, 'APPROVED', 'source requires an independent App approval');
assert.equal(approval.commit_id, pr.head.sha, 'approval must cover the exact PR head');
const approvedAt = Date.parse(approval.submitted_at);
const mergedAt = Date.parse(pr.merged_at);
assert.ok(Number.isFinite(approvedAt) && Number.isFinite(mergedAt) && approvedAt <= mergedAt, 'approval must be submitted before merge');
assert.equal(headCommit.sha, pr.head.sha, 'wrong reviewed head commit');
// A squash merge changes the commit identity; its complete tree must remain reviewed.
assert.equal(headCommit.tree?.sha, sourceTree, 'reviewed tree differs from release source');

const runs = workflowRuns.filter(run => run.repository?.full_name === repository &&
  run.path === '.github/workflows/ci.yml' && run.head_sha === source &&
  run.head_branch === 'main' && run.event === 'push');
assert.ok(runs.length > 0, 'source requires canonical main CI');
for (const run of runs) assert.ok(Number.isSafeInteger(run.id) && run.id > 0, 'invalid CI identity');
runs.sort((a, b) => b.id - a.id);
assert.ok(runs[0].status === 'completed' && runs[0].conclusion === 'success', 'latest main CI must complete successfully');
process.stdout.write(`${JSON.stringify({ source, pullRequest: pr.number, reviewedHead: pr.head.sha, review: approval.id, ciRun: runs[0].id })}\n`);
