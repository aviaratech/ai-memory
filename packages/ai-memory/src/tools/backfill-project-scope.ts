import { constants } from 'node:fs';
import { link, lstat, open, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyProjectScopeBackfill,
  createProjectScopeBackfillPlan,
  validateBackfillSelectors,
  validateProjectScopeBackfillPlan,
  type BackfillSelectors,
} from '../db/project-scope-backfill.js';
import { pool } from '../db/runtime.js';

const MAX_BYTES = 32 * 1024 * 1024;
type Arguments =
  | { mode: 'help' }
  | { mode: 'dry-run'; output?: string; selectors: BackfillSelectors }
  | { expectedDigest: string; mode: 'apply'; output?: string; planFile: string };

export function parseProjectScopeBackfillArguments(argv: string[]): Arguments {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return { mode: 'help' };
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (['--apply', '--dry-run'].includes(arg)) {
      if (flags.has(arg)) throw new Error('duplicate_argument');
      flags.add(arg);
      continue;
    }
    if (
      !['--project', '--legacy-project', '--session-id', '--limit', '--plan-file', '--expect-plan', '--out'].includes(
        arg,
      )
    )
      throw new Error('unknown_argument');
    const value = argv[++index];
    if (values.has(arg) || value === undefined || !value.trim() || value.startsWith('--'))
      throw new Error('invalid_argument');
    values.set(arg, value);
  }
  const output = values.get('--out');
  const publication = output === undefined ? {} : { output };
  if (flags.has('--apply')) {
    if (
      flags.has('--dry-run') ||
      ['--project', '--legacy-project', '--session-id', '--limit'].some(key => values.has(key))
    )
      throw new Error('conflicting_arguments');
    const planFile = values.get('--plan-file');
    const expected = values.get('--expect-plan');
    if (planFile === undefined || expected === undefined || !/^sha256:[a-f0-9]{64}$/u.test(expected))
      throw new Error('reviewed_plan_required');
    return { ...publication, expectedDigest: expected.slice(7), mode: 'apply', planFile };
  }
  if (values.has('--plan-file') || values.has('--expect-plan')) throw new Error('conflicting_arguments');
  const project = values.get('--project');
  const legacyProject = values.get('--legacy-project');
  const limit = values.get('--limit') ?? '200';
  if (project === undefined || legacyProject === undefined || !/^\d+$/u.test(limit))
    throw new Error('bounded_selectors_required');
  const sessionId = values.get('--session-id');
  const selectors = { legacyProject, limit: Number(limit), project, ...(sessionId === undefined ? {} : { sessionId }) };
  validateBackfillSelectors(selectors);
  return { ...publication, mode: 'dry-run', selectors };
}

export async function readProjectScopePlanFile(path: string): Promise<unknown> {
  const prior = await lstat(path);
  if (!prior.isFile() || prior.isSymbolicLink()) throw new Error('regular_plan_required');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.dev !== prior.dev || before.ino !== prior.ino) throw new Error('changed_plan_file');
    if (before.size > MAX_BYTES) throw new Error('oversized_plan');
    const buffer = Buffer.alloc(before.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const result = await file.read(buffer, bytes, buffer.length - bytes, bytes);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
    }
    const after = await file.stat();
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw new Error('changed_plan_file');
    try {
      return JSON.parse(buffer.subarray(0, bytes).toString('utf8')) as unknown;
    } catch {
      throw new Error('invalid_plan_json');
    }
  } finally {
    await file.close();
  }
}

export async function writeProjectScopeResult(path: string, value: unknown) {
  const json = resultJson(value);
  await requireAbsent(path);
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  let owned: Awaited<ReturnType<typeof file.stat>> | undefined;
  let failed = false;
  let failure: unknown;
  try {
    owned = await file.stat();
    await file.writeFile(json);
    await file.sync();
    await link(temporary, path); // Atomic create; unlike rename, never replaces evidence.
  } catch (error) {
    failed = true;
    failure = error;
  }
  const cleanupErrors: unknown[] = [];
  try {
    owned ??= await file.stat();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await file.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    if (owned === undefined) throw new Error('output_cleanup_identity_unavailable');
    const current = await lstat(temporary);
    if (current.dev !== owned.dev || current.ino !== owned.ino) throw new Error('output_cleanup_identity_changed');
    await unlink(temporary);
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0)
    throw new AggregateError([...(failed ? [failure] : []), ...cleanupErrors], 'output_cleanup_failed');
  if (failed) throw failure;
}

function resultJson(value: unknown) {
  const json = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(json) > MAX_BYTES) throw new Error('oversized_output');
  return json;
}
async function requireAbsent(path: string) {
  try {
    await lstat(path);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('output_already_exists');
}

async function main() {
  const args = parseProjectScopeBackfillArguments(process.argv.slice(2));
  if (args.mode === 'help') {
    process.stdout.write(
      'Usage: backfill:project-scope -- --project owner/repo --legacy-project repo [--session-id id] [--limit 200] [--out new-plan.json]\nDefault: true read-only dry-run; initialized loopback database required.\nApply: --apply --plan-file reviewed.json --expect-plan sha256:<digest> [--out new-receipt.json]\nOffline writer quiescence is required before apply. Historical durable keys are preserved; implicit-key coalescence is not guaranteed.\n',
    );
    return;
  }
  if (args.output !== undefined) await requireAbsent(args.output);
  let result;
  if (args.mode === 'dry-run') result = await createProjectScopeBackfillPlan({ pool, selectors: args.selectors });
  else {
    const plan = validateProjectScopeBackfillPlan(await readProjectScopePlanFile(args.planFile));
    result = await applyProjectScopeBackfill({ expectedDigest: args.expectedDigest, plan, pool });
  }
  if (args.output !== undefined) await writeProjectScopeResult(args.output, result);
  else
    await new Promise<void>((done, reject) => {
      process.stdout.write(resultJson(result), error => {
        if (error) reject(error);
        else done();
      });
    });
  if (result.status === 'refused') process.exitCode = 2;
}

const direct = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  void (async () => {
    try {
      await main();
    } catch (error: unknown) {
      const busy = typeof error === 'object' && error !== null && 'code' in error && error.code === '55P03';
      const reason = busy
        ? 'maintenance_lock_busy'
        : error instanceof Error && /^[a-z_]+$/u.test(error.message)
          ? error.message
          : 'database_or_io_failure';
      process.stderr.write(`${JSON.stringify({ reason, ...(busy ? { retryable: true } : {}), status: 'error' })}\n`);
      process.exitCode = 1;
    } finally {
      try {
        await pool.end();
      } catch {
        process.stderr.write(`${JSON.stringify({ reason: 'pool_cleanup_failed', status: 'error' })}\n`);
        process.exitCode = 1;
      }
    }
  })();
}
