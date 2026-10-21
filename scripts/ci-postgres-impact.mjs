import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const full = reason => ({ run: 'true', reason });
const documentationOnly = { run: 'false', reason: 'documentation-only' };

// This is a narrow safe-skip list, not an incomplete list of DB dependencies.
function documentationPath(path) {
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..') || path.includes('\\')) return false;
  return (
    ['README.md', 'CONTRIBUTING.md', 'LICENSE'].includes(path) || (path.startsWith('docs/') && path.endsWith('.md'))
  );
}

export function classifyDiff(bytes) {
  try {
    if (!bytes.length || bytes.at(-1) !== 0) return full('impact-or-unknown');
    const fields = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\0');
    fields.pop();
    if (fields.length % 2 !== 0) return full('impact-or-unknown');
    for (let index = 0; index < fields.length; index += 2) {
      const match = /^:(\d{6}) (\d{6}) [a-f0-9]{40} [a-f0-9]{40} ([AMD])$/.exec(fields[index]);
      if (!match || !documentationPath(fields[index + 1])) return full('impact-or-unknown');
      const [, before, after, status] = match;
      const regular =
        status === 'A'
          ? before === '000000' && after === '100644'
          : status === 'D'
            ? before === '100644' && after === '000000'
            : before === '100644' && after === '100644';
      if (!regular) return full('impact-or-unknown');
    }
    return documentationOnly;
  } catch {
    return full('impact-or-unknown');
  }
}

export function selectPostgres({ event, base, head, cwd = process.cwd() }) {
  if (event !== 'pull_request') return full('full-event');
  if (![base, head].every(sha => typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha) && !/^0+$/.test(sha)))
    return full('impact-or-unknown');
  try {
    const git = args =>
      execFileSync('git', args, { cwd, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const sha of [base, head]) git(['cat-file', '-e', `${sha}^{commit}`]);
    // No API path cap or last-commit approximation. Disabling renames exposes
    // both endpoints as delete/add, including a DB file moved into docs/.
    return classifyDiff(
      git(['diff', '--raw', '--no-abbrev', '--no-renames', '--no-ext-diff', '--no-textconv', '-z', base, head, '--']),
    );
  } catch {
    return full('impact-or-unknown');
  }
}

export function requireCoverage(env) {
  for (const lane of ['LINUX_RESULT', 'MACOS_RESULT', 'PACKAGE_RESULT', 'SELECTION_RESULT'])
    if (env[lane] !== 'success') throw new Error(`Required coverage missing: ${lane}`);
  const run = env.POSTGRES_RUN;
  const reason = env.POSTGRES_REASON;
  if (run === 'false' && reason === 'documentation-only' && env.POSTGRES_RESULT === 'skipped') return;
  if (run === 'true' && ['full-event', 'impact-or-unknown'].includes(reason) && env.POSTGRES_RESULT === 'success')
    return;
  throw new Error('PostgreSQL result does not satisfy the selected integration coverage');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'select') {
    const result = selectPostgres({
      event: process.env.GITHUB_EVENT_NAME,
      base: process.env.PR_BASE_SHA,
      head: process.env.PR_HEAD_SHA,
    });
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `run=${result.run}\nreason=${result.reason}\n`);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `PostgreSQL integration: ${result.run === 'true' ? 'required (complete suite)' : 'intentionally skipped'}; ${result.reason}.\n`,
      );
    console.log(JSON.stringify(result));
  } else if (process.argv[2] === 'aggregate') {
    requireCoverage(process.env);
    console.log(
      process.env.POSTGRES_RUN === 'true'
        ? 'Required PostgreSQL integration succeeded.'
        : 'PostgreSQL integration intentionally skipped: documentation-only changes.',
    );
  } else {
    throw new Error('Expected select or aggregate');
  }
}
