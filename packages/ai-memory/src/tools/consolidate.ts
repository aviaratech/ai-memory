import { lstat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  applyFragmentConsolidation,
  createFragmentConsolidationPlan,
  validateFragmentConsolidationPlan,
  validateFragmentConsolidationSelectors,
  type FragmentConsolidationSelectors,
} from '../consolidation/consolidate-fragments.js';
import { pool } from '../db/runtime.js';
import {
  readProjectScopePlanFile as readPlanFile,
  writeProjectScopeResult as writeResult,
} from './backfill-project-scope.js';

type Arguments =
  | { mode: 'help' }
  | { mode: 'dry-run'; selectors: FragmentConsolidationSelectors; output?: string }
  | { mode: 'apply'; planFile: string; expectedDigest: string; output?: string };
const USAGE = `ai-memory consolidate --project owner/repo [--org-id id] [--sensitivity public|internal|confidential|restricted] [--session-id id] [--limit 50] [--dry-run] [--out new-plan.json]
Default: true read-only dry-run on an initialized loopback database. Classification may contact the configured provider.
Apply: ai-memory consolidate --apply --plan-file reviewed.json --expect-plan sha256:<digest> [--out new-receipt.json]
Apply requires offline writer quiescence and preserves every existing keyed row. It never regenerates model text.
One reviewed unit contains at most50 fragments and50 keyed context rows; overflow refuses.`;

export function parseConsolidateArguments(argv: string[]): Arguments {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return { mode: 'help' };
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (['--apply', '--dry-run'].includes(argument)) {
      if (flags.has(argument)) throw new Error('duplicate_argument');
      flags.add(argument);
      continue;
    }
    if (
      ![
        '--project',
        '--org-id',
        '--sensitivity',
        '--session-id',
        '--limit',
        '--out',
        '--plan-file',
        '--expect-plan',
      ].includes(argument)
    )
      throw new Error('unknown_argument');
    const value = argv[++index];
    if (values.has(argument) || value === undefined || !value.trim() || value.startsWith('--'))
      throw new Error('invalid_argument');
    values.set(argument, value);
  }
  const output = values.get('--out');
  const publication = output === undefined ? {} : { output };
  if (flags.has('--apply')) {
    if (
      flags.has('--dry-run') ||
      ['--project', '--org-id', '--sensitivity', '--session-id', '--limit'].some(key => values.has(key))
    )
      throw new Error('conflicting_arguments');
    const planFile = values.get('--plan-file');
    const expected = values.get('--expect-plan');
    if (planFile === undefined || expected === undefined || !/^sha256:[a-f0-9]{64}$/u.test(expected))
      throw new Error('reviewed_plan_required');
    return { ...publication, mode: 'apply', planFile, expectedDigest: expected.slice(7) };
  }
  if (values.has('--plan-file') || values.has('--expect-plan')) throw new Error('conflicting_arguments');
  const project = values.get('--project');
  const limit = values.get('--limit') ?? '50';
  if (project === undefined || !/^\d+$/u.test(limit)) throw new Error('bounded_selectors_required');
  const sessionId = values.get('--session-id');
  const selectors = validateFragmentConsolidationSelectors({
    project,
    limit: Number(limit),
    orgId: values.get('--org-id') ?? null,
    sensitivity: values.get('--sensitivity') ?? 'internal',
    ...(sessionId === undefined ? {} : { sessionId }),
  });
  return { ...publication, mode: 'dry-run', selectors };
}

export async function runConsolidateCli(argv: string[]): Promise<void> {
  let opened = false;
  try {
    const args = parseConsolidateArguments(argv);
    if (args.mode === 'help') {
      process.stdout.write(`${USAGE}\n`);
      return;
    }
    if (args.output !== undefined) {
      try {
        await lstat(args.output);
        throw new Error('output_already_exists');
      } catch (error) {
        if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
    opened = true;
    const result =
      args.mode === 'dry-run'
        ? await createFragmentConsolidationPlan({ pool, selectors: args.selectors })
        : await applyFragmentConsolidation({
            pool,
            plan: validateFragmentConsolidationPlan(await readPlanFile(args.planFile)),
            expectedDigest: args.expectedDigest,
          });
    if (args.output !== undefined) await writeResult(args.output, result);
    const output =
      args.output === undefined
        ? result
        : {
            status: result.status,
            output: args.output,
            planDigest: 'digest' in result ? result.digest : result.planDigest,
          };
    const json = `${JSON.stringify(output)}\n`;
    if (Buffer.byteLength(json) > 32 * 1024 * 1024) throw new Error('oversized_output');
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(json, error => {
        if (error) reject(error);
        else resolve();
      });
    });
    process.exitCode = result.status === 'refused' ? 2 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const busy = typeof error === 'object' && error !== null && 'code' in error && error.code === '55P03';
    const code = busy
      ? 'maintenance_lock_busy'
      : /^[a-z_]+$/u.test(message)
        ? message
        : message.includes('AI_MEMORY_DATABASE_URL')
          ? 'database_configuration_required'
          : 'consolidation_failed';
    process.stderr.write(`${JSON.stringify({ status: 'failed', code, ...(busy ? { retryable: true } : {}) })}\n`);
    process.exitCode = 2;
  } finally {
    if (opened) {
      try {
        await pool.end();
      } catch {
        process.stderr.write(`${JSON.stringify({ status: 'failed', code: 'database_pool_cleanup_failed' })}\n`);
        process.exitCode = 2;
      }
    }
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]))
  void runConsolidateCli(process.argv.slice(2));
