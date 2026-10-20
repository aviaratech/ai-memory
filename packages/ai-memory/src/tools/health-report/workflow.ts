import type { DbPool } from '../../db/pool.js';
import { createPool, assertLocalDatabaseUrl } from '../../db/pool.js';
import {
  readWorkflowAggregates,
  validateWorkflowReportQuery,
  type WorkflowReportQuery,
  type WorkflowAggregateData,
} from '../../db/workflow-events.js';

export interface WorkflowReportV1 extends WorkflowAggregateData {
  schemaVersion: 1;
  scope: { projectId: string; taskId: string };
  window: { start: string; end: string; basis: 'ingested_at' };
  correlationHorizonDays: 90;
  coverageLabel: 'observed; incomplete';
  outcomeAttribution: 'producer-reported; not independent acceptance';
  hypotheses: { observation: string; evidenceIds: string[]; outcomeEventIds: string[] }[];
}

export async function collectWorkflowReport(query: WorkflowReportQuery, db: DbPool): Promise<WorkflowReportV1> {
  const data = await readWorkflowAggregates(query, db);
  return {
    schemaVersion: 1,
    scope: { projectId: query.projectId, taskId: query.taskId },
    window: { start: query.windowStartIso, end: query.windowEndIso, basis: 'ingested_at' },
    correlationHorizonDays: 90,
    coverageLabel: 'observed; incomplete',
    outcomeAttribution: 'producer-reported; not independent acceptance',
    ...data,
    hypotheses: data.groups
      .filter(group => group.dimension === 'stage' && BigInt(group.failures) >= 2n)
      .map(group => ({
        observation: `Investigate ${group.failures} reported failures at stage ${group.key ?? 'unknown'}; these observations do not establish a cause or savings.`,
        evidenceIds: group.evidenceIds,
        outcomeEventIds: data.outcomeReferences
          .filter(
            reference => reference.resolved && (reference.stage === group.key || reference.relatedStage === group.key),
          )
          .slice(0, 8)
          .map(reference => `${reference.producer}:${reference.eventId}`),
      })),
  };
}

const MAX_REPORT_BYTES = 256 * 1024;
function bounded(value: string): string {
  if (Buffer.byteLength(value, 'utf8') > MAX_REPORT_BYTES) throw new Error('report_oversized');
  return value;
}

export function renderWorkflowReport(report: WorkflowReportV1): string {
  // Bound the complete artifact even when the human-readable projection is small.
  bounded(JSON.stringify(report));
  return bounded(
    [
      `Workflow telemetry: ${report.scope.projectId} / ${report.scope.taskId}`,
      `Coverage: ${report.coverageLabel}; lifecycle hooks do not report provider token totals.`,
      `Outcomes: ${report.outcomeAttribution}.`,
      `Activity window: ${report.window.start} to ${report.window.end} (${report.window.basis}); retained correlation horizon: 90 days.`,
      ...Object.entries(report.totals).map(
        ([name, value]) =>
          `${name}: ${value.total ?? 'UNKNOWN'} (${value.observedSamples} observed, ${value.missingSamples} missing)`,
      ),
      `Canonical memory-tool activity: ${JSON.stringify(report.canonicalActivity)}`,
      `Omissions: omitted groups: ${report.omittedGroups}; omitted evidence IDs: ${report.omittedEvidenceIds}; omitted outcome references: ${report.omittedOutcomeReferences}.`,
      `Source/stage/edge groups: ${JSON.stringify(report.groups)}`,
      `Coverage observations: ${JSON.stringify(report.coverage)}`,
      `Producer-reported outcome references: ${JSON.stringify(report.outcomeReferences)}`,
      `Evidence IDs: ${report.evidenceIds.join(', ') || 'UNKNOWN'}`,
      `Hypotheses only: ${JSON.stringify(report.hypotheses)}`,
      '',
    ].join('\n'),
  );
}

export async function runWorkflowReportCli(argv: string[]): Promise<void> {
  let pool: DbPool | undefined;
  try {
    let projectId = '';
    let taskId = '';
    let days = 7;
    let limit = 20;
    let json = false;
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i];
      if (flag === '--json') {
        json = true;
        continue;
      }
      const value = argv[++i];
      if (value === undefined) throw new Error('invalid_workflow_scope');
      if (flag === '--project') projectId = value;
      else if (flag === '--task') taskId = value;
      else if (flag === '--days') days = Number(value);
      else if (flag === '--limit') limit = Number(value);
      else throw new Error('invalid_workflow_scope');
    }
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('invalid_workflow_scope');
    const now = Date.now();
    const query = {
      projectId,
      taskId,
      windowStartIso: new Date(now - days * 86400000).toISOString(),
      windowEndIso: new Date(now).toISOString(),
      limit,
      timeoutMs: 5000,
    };
    validateWorkflowReportQuery(query);
    const url = process.env.AI_MEMORY_DATABASE_URL;
    if (url === undefined) throw new Error('workflow_report_unavailable');
    pool = createPool({
      connectionString: assertLocalDatabaseUrl(url),
      max: 1,
      connectionTimeoutMillis: 500,
      statementTimeoutMs: 5000,
      idleInTransactionTimeoutMs: 5000,
    });
    const report = await collectWorkflowReport(query, pool);
    const output = json ? bounded(`${JSON.stringify(report)}\n`) : renderWorkflowReport(report);
    await new Promise<void>((resolve, reject) =>
      process.stdout.write(output, error => {
        if (error) reject(error);
        else resolve();
      }),
    );
  } catch (error) {
    const message =
      error instanceof Error && ['invalid_workflow_scope', 'report_oversized'].includes(error.message)
        ? error.message
        : 'workflow_report_unavailable';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  } finally {
    if (pool !== undefined) await pool.end().catch(() => {});
  }
}
