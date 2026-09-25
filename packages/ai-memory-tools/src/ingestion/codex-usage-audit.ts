import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { parseJsonlLines } from './auto-session-ingest.js';

interface Attribution {
  effort: string;
  model: string;
  requestedModel: string;
  role: Role;
}
interface AttributionTotals extends Attribution {
  totals: Totals;
}
type Role = 'lead' | 'reviewer' | 'unknown' | 'worker';
interface SessionInput {
  file: string;
  role?: Role | undefined;
}
interface Totals {
  cachedInput: null | number;
  input: number;
  output: number;
  reasoningOutput: null | number;
  responses: number;
  uncachedInput: null | number;
}
const emptyTotals = (): Totals => ({
  cachedInput: 0,
  input: 0,
  output: 0,
  reasoningOutput: 0,
  responses: 0,
  uncachedInput: 0,
});
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const token = (value: unknown): null | number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const model = (value: unknown): string =>
  typeof value === 'string' && /^gpt-\d+(?:\.\d+)?(?:-(?:astra|sol|terra|luna|codex|spark|mini|nano))*$/u.test(value)
    ? value
    : 'unknown';
const effort = (value: unknown): string =>
  typeof value === 'string' && ['high', 'low', 'max', 'medium', 'minimal', 'none', 'ultra', 'xhigh'].includes(value)
    ? value
    : 'unknown';
const role = (value: unknown): Role =>
  value === 'lead' || value === 'reviewer' || value === 'worker' ? value : 'unknown';
const hash = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');

/** Explicit local files only; no DB, provider, prompt excerpts, or cumulative counter summation. */
export function auditCodexUsage(input: { sessions: SessionInput[]; since: string; until: string }) {
  const since = Date.parse(input.since);
  const until = Date.parse(input.until);
  if (!Number.isFinite(since) || !Number.isFinite(until) || since >= until)
    throw new Error('A valid increasing audit window is required');
  if (input.sessions.length === 0 || input.sessions.length > 64)
    throw new Error('Audit requires 1–64 explicit session files');
  if (input.sessions.reduce((sum, session) => sum + statSync(session.file).size, 0) > 128 * 1024 * 1024)
    throw new Error('Audit input exceeds 128 MiB; narrow the explicit sample');
  const report = {
    acceptedDelivery: null,
    byAttribution: [] as AttributionTotals[],
    compactions: 0,
    corrections: null,
    crossTaskResponses: 0,
    duplicateResponses: 0,
    executionMs: null,
    invalidResponses: 0,
    limitations: [
      'Local per-response diagnostics, not account billing or quota debits.',
      'Cached input is included in input; reasoning output is included in output.',
      'Cumulative event/turn/thread counters are ignored; missing categories remain null.',
      'Tool-output characters are not tokens. Only explicit files and the half-open window are counted.',
      'No task titles or prompt bodies are inspected for role or acceptance; attach authoritative delivery receipts separately.',
      'Requested model, role and effort are unknown unless recorded or role explicitly supplied; unfamiliar model IDs are unknown.',
      'Elapsed transcript spans do not establish execution or queue time. No general savings claim is supported.',
    ],
    malformedLines: 0,
    queueMs: null,
    schemaVersion: 1,
    sessions: [] as {
      bytes: number;
      cliVersion: string;
      roleSource: string;
      sha256: string;
      taskHash: null | string;
      totals: Totals;
      turns: number;
    }[],
    toolOutputs: { over20000Chars: 0, records: 0, textChars: 0 },
    totals: emptyTotals(),
    window: { endExclusive: true, since: new Date(since).toISOString(), until: new Date(until).toISOString() },
  };
  const seen = new Set<string>();
  for (const session of input.sessions) {
    const bytes = readFileSync(session.file);
    const entries = parseJsonlLines(session.file, {
      contents: bytes.toString('utf8'),
      onMalformedLines: count => {
        report.malformedLines += count;
      },
    });
    const metadata = record(record(entries.find(entry => record(entry).type === 'session_meta')).payload);
    const task = metadata.id ?? metadata.session_id;
    const attributionRole = session.role === undefined ? role(metadata.agent_role) : role(session.role);
    const contexts = new Map<unknown, Attribution>();
    const initial = attribution(metadata, {
      effort: 'unknown',
      model: 'unknown',
      requestedModel: 'unknown',
      role: attributionRole,
    });
    let current = initial;
    const totals = emptyTotals();
    const turns = new Set<unknown>();
    // Index recorded turn context first: persisted usage may arrive after a later turn starts.
    for (const entry of entries) {
      const item = record(entry);
      if (item.type !== 'turn_context') continue;
      const payload = record(item.payload);
      current = attribution(payload, current);
      if (typeof payload.turn_id === 'string') contexts.set(payload.turn_id, current);
    }
    current = initial;
    for (const entry of entries) {
      const item = record(entry);
      const payload = record(item.payload);
      if (item.type === 'turn_context') current = attribution(payload, current);
      const time = typeof item.timestamp === 'string' ? Date.parse(item.timestamp) : NaN;
      if (!Number.isFinite(time) || time < since || time >= until) continue;
      if (item.type === 'compacted') report.compactions++;
      if (
        item.type === 'response_item' &&
        (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output')
      ) {
        const text = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? '');
        report.toolOutputs.records++;
        report.toolOutputs.textChars += text.length;
        if (text.length > 20000) report.toolOutputs.over20000Chars++;
      }
      if (item.type !== 'token_usage_record') continue;
      if (typeof task !== 'string' || payload.thread_id !== task) {
        report.crossTaskResponses++;
        continue;
      }
      if (typeof payload.response_id !== 'string' || payload.response_id.length === 0) {
        report.invalidResponses++;
        continue;
      }
      if (seen.has(payload.response_id)) {
        report.duplicateResponses++;
        continue;
      }
      const usage = readUsage(payload.usage);
      if (usage === undefined) {
        report.invalidResponses++;
        continue;
      }
      seen.add(payload.response_id);
      if (typeof payload.turn_id === 'string') turns.add(payload.turn_id);
      const context = contexts.get(payload.turn_id) ?? current;
      let group = report.byAttribution.find(
        group =>
          group.model === context.model &&
          group.requestedModel === context.requestedModel &&
          group.effort === context.effort &&
          group.role === context.role,
      );
      if (group === undefined) {
        group = { ...context, totals: emptyTotals() };
        report.byAttribution.push(group);
      }
      addTotals(group.totals, usage);
      addTotals(report.totals, usage);
      addTotals(totals, usage);
    }
    report.sessions.push({
      bytes: bytes.length,
      cliVersion:
        typeof metadata.cli_version === 'string' && /^\d+\.\d+\.\d+$/u.test(metadata.cli_version)
          ? metadata.cli_version
          : 'unknown',
      roleSource: session.role === undefined ? 'metadata-or-unknown' : 'operator-supplied',
      sha256: hash(bytes),
      taskHash: typeof task === 'string' ? hash(task) : null,
      totals,
      turns: turns.size,
    });
  }
  return report;
}

/** CLI: audit:codex <manifest.json>; manifest contains since, until, sessions[{file,role?}]. */
export function runCodexUsageAuditCli(manifestFile: string | undefined): void {
  try {
    if (manifestFile === undefined) throw new Error('missing manifest');
    const manifest = record(JSON.parse(readFileSync(manifestFile, 'utf8')));
    if (typeof manifest.since !== 'string' || typeof manifest.until !== 'string' || !Array.isArray(manifest.sessions))
      throw new Error('invalid manifest');
    const sessions = manifest.sessions.map((value: unknown) => {
      const session = record(value);
      if (
        typeof session.file !== 'string' ||
        (session.role !== undefined && !['lead', 'reviewer', 'unknown', 'worker'].includes(String(session.role)))
      )
        throw new Error('invalid session');
      return { file: session.file, ...(session.role === undefined ? {} : { role: role(session.role) }) };
    });
    process.stdout.write(
      `${JSON.stringify(auditCodexUsage({ sessions, since: manifest.since, until: manifest.until }), null, 2)}\n`,
    );
  } catch {
    // Paths, parser errors and file contents can contain credentials. Never echo them.
    process.stderr.write(
      'Codex audit failed: check the manifest, window, explicit file limits, and local file access.\n',
    );
    process.exitCode = 1;
  }
}
function addTotals(target: Totals, value: Totals): void {
  target.responses += value.responses;
  target.input += value.input;
  target.output += value.output;
  for (const key of ['cachedInput', 'uncachedInput', 'reasoningOutput'] as const) {
    target[key] = target[key] === null || value[key] === null ? null : target[key] + value[key];
  }
}
function attribution(payload: Record<string, unknown>, fallback: Attribution): Attribution {
  return {
    effort: effort(payload.effort ?? payload.reasoning_effort ?? fallback.effort),
    model: model(payload.resolved_model ?? payload.model ?? fallback.model),
    requestedModel: model(payload.requested_model ?? fallback.requestedModel),
    role: fallback.role,
  };
}

function readUsage(value: unknown): Totals | undefined {
  const usage = record(value);
  const input = token(usage.input_tokens);
  const output = token(usage.output_tokens);
  const cachedInput = token(usage.cached_input_tokens);
  const reasoningOutput = token(usage.reasoning_output_tokens);
  if (
    input === null ||
    output === null ||
    (cachedInput !== null && cachedInput > input) ||
    (reasoningOutput !== null && reasoningOutput > output)
  )
    return undefined;
  return {
    cachedInput,
    input,
    output,
    reasoningOutput,
    responses: 1,
    uncachedInput: cachedInput === null ? null : input - cachedInput,
  };
}
