import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { setTimeout as pauseFor } from 'node:timers/promises';

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

const metadataMarker = 'Record metadata proof branch';
const sourceActions = ['opened', 'synchronize', 'reopened', 'ready_for_review'];
const pendingStates = ['queued', 'pending', 'requested', 'waiting', 'in_progress'];
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const commitSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) && !/^0+$/.test(value);

// The versioned run-name is captured before a runner starts. Native run.head_sha
// alone cannot identify its base, and run.pull_requests can be empty after merge.
function runIdentity(run, workflow) {
  const match =
    /^am-ci-v1 ([1-9]\d*) ([1-9]\d*) ([1-9]\d*) ([^\s]+) ([a-f0-9]{40}) ([a-f0-9]{40}) (opened|synchronize|reopened|ready_for_review|edited)$/.exec(
      run.display_title ?? '',
    );
  if (
    !match ||
    run.event !== 'pull_request' ||
    !positiveId(run.id) ||
    !positiveId(run.run_number) ||
    !positiveId(run.run_attempt) ||
    !positiveId(run.workflow_id) ||
    run.path?.split('@')[0] !== '.github/workflows/ci.yml' ||
    (workflow && run.workflow_id !== workflow)
  )
    throw new Error('Unknown run identity');
  const [, pr, headRepo, baseRepo, ref, head, base, action] = match;
  if (
    ![pr, headRepo, baseRepo].map(Number).every(positiveId) ||
    !commitSha(head) ||
    !commitSha(base) ||
    Number(headRepo) !== run.head_repository?.id ||
    Number(baseRepo) !== run.repository?.id ||
    head !== run.head_sha
  )
    throw new Error('Inconsistent native run identity');
  return { tuple: match.slice(1, 7).join(' '), action };
}

async function validationEvidence({ eventName, event, env, postgres, fetchImpl = fetch }) {
  const ordinary = { validation: 'full' };
  let retryAfterMs = 0;
  try {
    const pr = event?.pull_request;
    const changes = event?.changes;
    if (
      eventName !== 'pull_request' ||
      event.action !== 'edited' ||
      !changes ||
      Array.isArray(changes) ||
      !Object.keys(changes).length ||
      Object.entries(changes).some(
        ([key, value]) =>
          !['title', 'body'].includes(key) ||
          !value ||
          Object.keys(value).length !== 1 ||
          !Object.hasOwn(value, 'from') ||
          !(typeof value.from === 'string' || (key === 'body' && value.from === null)),
      )
    )
      return ordinary;
    if (
      !positiveId(event.number) ||
      event.number !== pr?.number ||
      !positiveId(pr.head?.repo?.id) ||
      !positiveId(pr.base?.repo?.id) ||
      pr.base.repo.id !== event.repository?.id ||
      !commitSha(pr.head?.sha) ||
      !commitSha(pr.base?.sha) ||
      pr.base.ref !== 'main' ||
      !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY ?? '') ||
      env.GITHUB_REPOSITORY !== event.repository?.full_name ||
      !env.GH_TOKEN ||
      (env.GITHUB_API_URL && env.GITHUB_API_URL !== 'https://api.github.com') ||
      !/^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? '') ||
      !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? '')
    )
      return ordinary;
    const tuple = `${event.number} ${pr.head.repo.id} ${pr.base.repo.id} ${pr.base.ref} ${pr.head.sha} ${pr.base.sha}`;
    const root = `/repos/${env.GITHUB_REPOSITORY}/actions`;
    const read = async path => {
      const response = await fetchImpl(`https://api.github.com${path}`, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${env.GH_TOKEN}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (response.status !== 200) throw new Error('Native evidence unavailable');
      const remaining = response.headers.get('x-ratelimit-remaining');
      const reset = response.headers.get('x-ratelimit-reset');
      if (remaining !== null && /^\d+$/.test(remaining) && Number(remaining) < 100 && /^\d+$/.test(reset ?? ''))
        retryAfterMs = Math.max(retryAfterMs, Number(reset) * 1000 - Date.now() + 1000);
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw new Error('Native response exceeds evidence bound');
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    };
    const pages = async (path, field) => {
      const records = [];
      let total;
      for (let page = 1; page <= 10; page++) {
        const data = await read(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
        if (
          !Number.isSafeInteger(data.total_count) ||
          data.total_count < 0 ||
          data.total_count > 1000 ||
          !Array.isArray(data[field]) ||
          (total !== undefined && total !== data.total_count)
        )
          throw new Error('Incomplete native history');
        total = data.total_count;
        records.push(...data[field]);
        if (records.length === total) {
          if (new Set(records.map(item => item.id)).size !== total) throw new Error('Ambiguous native history');
          return records;
        }
        if (records.length > total || !data[field].length) break;
      }
      throw new Error('Incomplete native history');
    };
    const current = await read(`${root}/runs/${env.GITHUB_RUN_ID}`);
    const currentIdentity = runIdentity(current);
    if (
      current.id !== Number(env.GITHUB_RUN_ID) ||
      current.run_attempt !== Number(env.GITHUB_RUN_ATTEMPT) ||
      currentIdentity.tuple !== tuple ||
      currentIdentity.action !== 'edited'
    )
      return ordinary;
    const historyPath = `${root}/workflows/${current.workflow_id}/runs?event=pull_request&head_sha=${pr.head.sha}`;
    const runs = await pages(historyPath, 'workflow_runs');
    const snapshot = history =>
      JSON.stringify(
        history
          .filter(run => run.id !== current.id)
          .map(run => [
            run.id,
            run.run_number,
            run.run_attempt,
            run.workflow_id,
            run.path,
            run.event,
            run.display_title,
            run.head_sha,
            run.repository?.id,
            run.head_repository?.id,
            run.status,
            run.conclusion,
            run.created_at,
          ])
          .sort((a, b) => a[0] - b[0]),
      );
    if (runs.some(run => !positiveId(run.run_number)) || new Set(runs.map(run => run.run_number)).size !== runs.length)
      return ordinary;
    const candidates = [];
    for (const run of runs) {
      if (run.id === current.id) continue;
      const identity = runIdentity(run, current.workflow_id);
      if (run.repository.id !== event.repository.id) return ordinary;
      if (identity.tuple !== tuple) continue;
      // A rerun keeps its immutable run_number and original run.created_at.
      // The attempt endpoint records the new attempt's own creation/queue time.
      const attempt = run.run_attempt === 1 ? run : await read(`${root}/runs/${run.id}/attempts/${run.run_attempt}`);
      if (
        runIdentity(attempt, current.workflow_id).tuple !== tuple ||
        attempt.id !== run.id ||
        attempt.run_attempt !== run.run_attempt ||
        attempt.run_number !== run.run_number ||
        attempt.display_title !== run.display_title ||
        attempt.status !== run.status ||
        attempt.conclusion !== run.conclusion
      )
        return ordinary;
      const created = Date.parse(attempt.created_at);
      if (!Number.isFinite(created) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(attempt.created_at))
        return ordinary;
      candidates.push({ run, identity, created });
    }
    candidates.sort((a, b) => b.created - a.created || b.run.run_number - a.run.run_number);
    if (
      candidates.some(
        (item, index) =>
          index &&
          item.created === candidates[index - 1].created &&
          (item.run.run_attempt !== 1 || candidates[index - 1].run.run_attempt !== 1),
      )
    )
      return ordinary;
    for (const { run, identity } of candidates) {
      const jobs = await pages(`${root}/runs/${run.id}/attempts/${run.run_attempt}/jobs`, 'jobs');
      if (
        jobs.some(
          job =>
            !positiveId(job.id) ||
            job.run_id !== run.id ||
            job.head_sha !== pr.head.sha ||
            (!pendingStates.includes(job.status) && job.status !== 'completed') ||
            (pendingStates.includes(job.status) && job.conclusion !== null),
        ) ||
        new Set(jobs.map(job => job.name)).size !== jobs.length
      )
        return ordinary;
      const byName = new Map(jobs.map(job => [job.name, job]));
      // Selection records its metadata decision before checks can be queued.
      // Skipped lanes or a successful metadata aggregate alone are never proof.
      const markers = byName.get('selection')?.steps?.filter(step => step.name === metadataMarker);
      if (
        identity.action === 'edited' &&
        ((pendingStates.includes(run.status) && run.conclusion === null) ||
          (run.status === 'completed' && ['success', 'failure', 'cancelled', 'timed_out'].includes(run.conclusion))) &&
        byName.get('selection')?.status === 'completed' &&
        byName.get('selection')?.conclusion === 'success' &&
        markers?.length === 1 &&
        markers[0].status === 'completed' &&
        markers[0].conclusion === 'success' &&
        ['linux', 'macos', 'package', 'postgres'].every(
          name => byName.get(name)?.status === 'completed' && byName.get(name)?.conclusion === 'skipped',
        )
      )
        continue;
      if (run.status === 'completed') {
        if (
          run.conclusion !== 'success' ||
          byName.get('checks')?.conclusion !== 'success' ||
          jobs.some(job => job.status !== 'completed')
        )
          return ordinary;
        requireCoverage({
          LINUX_RESULT: byName.get('linux')?.conclusion,
          MACOS_RESULT: byName.get('macos')?.conclusion,
          PACKAGE_RESULT: byName.get('package')?.conclusion,
          SELECTION_RESULT: byName.get('selection')?.conclusion,
          POSTGRES_RUN: postgres.run,
          POSTGRES_REASON: postgres.reason,
          POSTGRES_RESULT: byName.get('postgres')?.conclusion,
        });
      } else {
        if (
          !pendingStates.includes(run.status) ||
          run.conclusion !== null ||
          jobs.some(
            job =>
              job.status === 'completed' &&
              job.conclusion !== 'success' &&
              !(job.name === 'postgres' && postgres.run === 'false' && job.conclusion === 'skipped'),
          )
        )
          return ordinary;
        if (
          !sourceActions.includes(identity.action) &&
          !(
            identity.action === 'edited' &&
            byName.get('selection')?.conclusion === 'success' &&
            ['linux', 'macos', 'package'].every(name => {
              const job = byName.get(name);
              return (
                job &&
                (pendingStates.includes(job.status) || (job.status === 'completed' && job.conclusion === 'success'))
              );
            })
          )
        )
          return ordinary;
      }
      // Every matching snapshot affected ordering or excluded evidence. Refresh
      // all of them, including metadata we skipped and older runs that can rerun.
      for (const { run: observed } of candidates) {
        const fresh = await read(`${root}/runs/${observed.id}`);
        if (
          runIdentity(fresh, current.workflow_id).tuple !== tuple ||
          fresh.id !== observed.id ||
          fresh.run_number !== observed.run_number ||
          fresh.display_title !== observed.display_title ||
          fresh.run_attempt !== observed.run_attempt ||
          fresh.status !== observed.status ||
          fresh.conclusion !== observed.conclusion ||
          fresh.created_at !== observed.created_at
        )
          return ordinary;
      }
      if (snapshot(await pages(historyPath, 'workflow_runs')) !== snapshot(runs)) return ordinary;
      return {
        validation: 'metadata',
        validationRun: run.id,
        validationAttempt: run.run_attempt,
        pending: run.status !== 'completed',
        retryAfterMs,
      };
    }
    return ordinary;
  } catch {
    return ordinary;
  }
}

export async function preserveValidation(options) {
  const proof = await validationEvidence(options);
  return proof.validation === 'metadata'
    ? { validation: 'metadata', validationRun: proof.validationRun }
    : { validation: 'full' };
}

export async function waitForValidation({
  pause = pauseFor,
  report = value => console.log(JSON.stringify(value)),
  ...options
}) {
  const { env } = options;
  if (
    env.VALIDATION_MODE !== 'metadata' ||
    env.SELECTION_RESULT !== 'success' ||
    ['LINUX_RESULT', 'MACOS_RESULT', 'PACKAGE_RESULT', 'POSTGRES_RESULT'].some(name => env[name] !== 'skipped')
  )
    throw new Error('Invalid metadata aggregation admission');
  let polls = 0;
  const started = Date.now();
  for (;;) {
    const proof = await validationEvidence(options);
    if (proof.validation !== 'metadata')
      throw new Error('Compatible actual full source validation is missing, failed or uncertain');
    const progress = {
      validationRun: proof.validationRun,
      validationAttempt: proof.validationAttempt,
      polls: ++polls,
      elapsedSeconds: Math.floor((Date.now() - started) / 1000),
    };
    if (!proof.pending) {
      report({ ...progress, stage: 'verified' });
      return { validationRun: proof.validationRun };
    }
    const delay = Math.max(Math.min(30000 * 2 ** Math.min(polls - 1, 2), 120000), proof.retryAfterMs);
    report({ ...progress, stage: 'pending', retrySeconds: Math.ceil(delay / 1000) });
    await pause(delay);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (['select', 'metadata'].includes(process.argv[2])) {
    const postgres = selectPostgres({
      event: process.env.GITHUB_EVENT_NAME,
      base: process.env.PR_BASE_SHA,
      head: process.env.PR_HEAD_SHA,
    });
    let event;
    try {
      event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    } catch {
      event = null;
    }
    if (process.argv[2] === 'metadata') {
      const proof = await waitForValidation({
        eventName: process.env.GITHUB_EVENT_NAME,
        event,
        env: process.env,
        postgres,
      });
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          `Required checks independently verified actual full source validation run ${proof.validationRun}.\n`,
        );
    } else {
      const preservation = await preserveValidation({
        eventName: process.env.GITHUB_EVENT_NAME,
        event,
        env: process.env,
        postgres,
      });
      const result =
        preservation.validation === 'metadata'
          ? {
              run: 'false',
              reason: 'compatible-validation',
              validation: 'metadata',
              validation_run: preservation.validationRun,
            }
          : { ...postgres, validation: 'full' };
      if (process.env.GITHUB_OUTPUT)
        appendFileSync(
          process.env.GITHUB_OUTPUT,
          Object.entries(result)
            .map(([key, value]) => `${key}=${value}\n`)
            .join(''),
        );
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          result.validation === 'metadata'
            ? `PR metadata only: checks must independently verify actual full validation; selection hint ${result.validation_run} is not success proof.\n`
            : `Full validation; PostgreSQL integration: ${result.run === 'true' ? 'required (complete suite)' : 'intentionally skipped'}; ${result.reason}.\n`,
        );
      console.log(JSON.stringify(result));
    }
  } else if (process.argv[2] === 'aggregate') {
    requireCoverage(process.env);
    console.log(
      process.env.POSTGRES_RUN === 'true'
        ? 'Required PostgreSQL integration succeeded.'
        : 'PostgreSQL integration intentionally skipped: documentation-only changes.',
    );
  } else {
    throw new Error('Expected select, metadata or aggregate');
  }
}
