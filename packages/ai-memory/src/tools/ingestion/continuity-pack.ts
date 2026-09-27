import {
  buildScopedContinuityPackScopeKey,
  CONTINUITY_FIELD_PROVENANCE_VALUES,
  type ContinuityFieldProvenance,
  type ContinuityPackReadResult,
  type ContinuityPackRecord,
  type ContinuityPackScope,
  upsertContinuityPack,
} from '@aviaratech/ai-memory/internal';

import type { ParsedFlushInput } from './flush-session.js';

export const DEFAULT_CONTINUITY_PACK_BUDGET_CHARS = 6000;

export interface BuiltContinuityPack {
  budgetChars: number;
  pack: ContinuityPackPayload;
  payloadChars: number;
  payloadText: string;
  project: string;
  scope: ContinuityPackScope;
  scopeKey: string;
  source: string;
}

export interface ContinuityPackDebugPayload {
  budget: {
    budgetChars: number;
    payloadChars: number;
    pressurePct: number;
    truncated: boolean;
  };
  project?: string | undefined;
  renderedText: string;
  scopeKey?: string | undefined;
  sessionId?: string | undefined;
  source?: string | undefined;
  status: ContinuityPackReadResult['status'];
  updatedAt?: string | undefined;
}

export interface ContinuityPackPayload extends Record<string, unknown> {
  budgets: {
    budgetChars: number;
    payloadChars: number;
    truncated: boolean;
  };
  contextNeeded: string[];
  decisions: string[];
  nextActions: string[];
  openQuestions: string[];
  provenance: {
    agent?: string | undefined;
    continuityFields: ContinuityFieldProvenance;
    scope: ContinuityPackScope;
    sessionId: string;
    source: string;
  };
  reflection: {
    count: number;
  };
  summary: string;
  updatedAt: string;
}

export type ContinuityPackRefreshResult =
  | {
      budgetChars: number;
      payloadChars: number;
      scopeKey: string;
      scopeKeys?: string[] | undefined;
      status: 'updated';
      truncated: boolean;
    }
  | {
      message: string;
      reason: 'refresh_failed';
      status: 'error';
    }
  | {
      reason: 'missing_project';
      status: 'skipped';
    };

export function buildContinuityPackDebugPayload(result: ContinuityPackReadResult): ContinuityPackDebugPayload {
  if (result.status === 'missing') {
    const scopeText = result.project ?? 'unknown project';
    return {
      budget: {
        budgetChars: 0,
        payloadChars: 0,
        pressurePct: 0,
        truncated: false,
      },
      project: result.project,
      renderedText: `No ai-memory continuity pack found for ${scopeText}.`,
      scopeKey: result.scopeKey,
      status: 'missing',
    };
  }

  const payload = toPayloadFromRecord(result.pack);
  const pressurePct =
    result.pack.budgetChars > 0 ? Number(((result.pack.payloadChars / result.pack.budgetChars) * 100).toFixed(1)) : 0;
  return {
    budget: {
      budgetChars: result.pack.budgetChars,
      payloadChars: result.pack.payloadChars,
      pressurePct,
      truncated: payload.budgets.truncated,
    },
    project: result.pack.project,
    renderedText: formatContinuityPackMarkdown(result.pack),
    scopeKey: result.pack.scopeKey,
    sessionId: result.pack.sessionId,
    source: result.pack.source,
    status: 'found',
    updatedAt: result.pack.updatedAt,
  };
}

export function buildContinuityPackFromFlush(input: {
  budgetChars?: number | undefined;
  nowIso: string;
  parsed: ParsedFlushInput;
  reflectionCount: number;
  scope?: ContinuityPackScope | undefined;
  sessionId: string;
}): BuiltContinuityPack {
  if (input.parsed.project === undefined) {
    throw new Error('project is required to build a continuity pack.');
  }

  const budgetChars = input.budgetChars ?? DEFAULT_CONTINUITY_PACK_BUDGET_CHARS;
  const scope = input.scope ?? { type: 'project' };
  const source = input.parsed.source ?? 'memory_flush';
  const basePack = buildPackPayload({
    budgetChars,
    nowIso: input.nowIso,
    parsed: input.parsed,
    reflectionCount: input.reflectionCount,
    scope,
    sessionId: input.sessionId,
    source,
    truncated: false,
  });
  const budgeted = fitPackToBudget(basePack, budgetChars);
  const { pack, payloadText } = stabilizePayloadChars(budgeted);
  return {
    budgetChars,
    pack,
    payloadChars: payloadText.length,
    payloadText,
    project: input.parsed.project,
    scope,
    scopeKey: buildScopedContinuityPackScopeKey({ project: input.parsed.project, scope }),
    source,
  };
}

export function buildScopedContinuityPacksFromFlush(input: {
  budgetChars?: number | undefined;
  nowIso: string;
  parsed: ParsedFlushInput;
  reflectionCount: number;
  sessionId: string;
}): BuiltContinuityPack[] {
  const scopes: ContinuityPackScope[] = [
    { type: 'project' },
    ...(input.parsed.lead === undefined ? [] : [{ id: input.parsed.lead, type: 'lead' } as const]),
    ...(input.parsed.outcome === undefined ? [] : [{ id: input.parsed.outcome, type: 'outcome' } as const]),
    ...(input.parsed.task === undefined ? [] : [{ id: input.parsed.task, type: 'task' } as const]),
  ];
  return scopes.map(scope => buildContinuityPackFromFlush({ ...input, scope }));
}

export function formatContinuityPackMarkdown(pack: BuiltContinuityPack | ContinuityPackRecord): string {
  if (!('payloadText' in pack)) {
    return renderContinuityPackPayload(toPayloadFromRecord(pack));
  }
  return pack.payloadText;
}

export async function refreshContinuityPackFromFlush(input: {
  parsed: ParsedFlushInput;
  reflectionCount: number;
  sessionId: string;
}): Promise<ContinuityPackRefreshResult> {
  if (input.parsed.project === undefined) {
    return { reason: 'missing_project', status: 'skipped' };
  }

  const nowIso = new Date().toISOString();
  const builtPacks = buildScopedContinuityPacksFromFlush({
    nowIso,
    parsed: input.parsed,
    reflectionCount: input.reflectionCount,
    sessionId: input.sessionId,
  });
  const results = await Promise.all(
    builtPacks.map(pack =>
      upsertContinuityPack({
        budgetChars: pack.budgetChars,
        pack: pack.pack,
        payloadText: pack.payloadText,
        project: pack.project,
        scope: pack.scope,
        sessionId: input.sessionId,
        source: pack.source,
        updatedAt: nowIso,
      }),
    ),
  );
  const projectResult = results[0];
  const projectPack = builtPacks[0];
  if (projectResult === undefined || projectPack === undefined) {
    throw new Error('Continuity pack refresh did not build a project scope.');
  }
  return {
    budgetChars: projectResult.budgetChars,
    payloadChars: projectResult.payloadChars,
    scopeKey: projectResult.scopeKey,
    scopeKeys: results.map(result => result.scopeKey),
    status: 'updated',
    truncated: projectPack.pack.budgets.truncated,
  };
}

function buildPackPayload(input: {
  budgetChars: number;
  nowIso: string;
  parsed: ParsedFlushInput;
  reflectionCount: number;
  scope: ContinuityPackScope;
  sessionId: string;
  source: string;
  truncated: boolean;
}): ContinuityPackPayload {
  return {
    budgets: {
      budgetChars: input.budgetChars,
      payloadChars: 0,
      truncated: input.truncated,
    },
    contextNeeded: input.parsed.contextNeeded,
    decisions: input.parsed.decisions,
    nextActions: input.parsed.nextActions,
    openQuestions: input.parsed.openQuestions,
    provenance: {
      ...(input.parsed.agent !== undefined ? { agent: input.parsed.agent } : {}),
      continuityFields: 'agent-authored',
      scope: input.scope,
      sessionId: input.sessionId,
      source: input.source,
    },
    reflection: {
      count: input.reflectionCount,
    },
    summary: input.parsed.summary,
    updatedAt: input.nowIso,
  };
}

function fitPackToBudget(pack: ContinuityPackPayload, budgetChars: number): ContinuityPackPayload {
  const rendered = renderContinuityPackPayload(pack);
  if (rendered.length <= budgetChars) {
    return pack;
  }

  const compactPack: ContinuityPackPayload = {
    ...pack,
    budgets: {
      ...pack.budgets,
      truncated: true,
    },
    contextNeeded: pack.contextNeeded.slice(0, 3).map(context => truncateText(context, 140)),
    decisions: pack.decisions.slice(0, 2).map(decision => truncateText(decision, 140)),
    nextActions: pack.nextActions.slice(0, 3).map(action => truncateText(action, 140)),
    openQuestions: pack.openQuestions.slice(0, 2).map(question => truncateText(question, 140)),
    summary: truncateText(pack.summary, 320),
  };

  let compactRendered = renderContinuityPackPayload(compactPack);
  while (compactRendered.length > budgetChars && compactPack.decisions.length > 0) {
    compactPack.decisions.pop();
    compactRendered = renderContinuityPackPayload(compactPack);
  }
  while (compactRendered.length > budgetChars && compactPack.openQuestions.length > 0) {
    compactPack.openQuestions.pop();
    compactRendered = renderContinuityPackPayload(compactPack);
  }
  while (compactRendered.length > budgetChars && compactPack.contextNeeded.length > 1) {
    compactPack.contextNeeded.pop();
    compactRendered = renderContinuityPackPayload(compactPack);
  }
  while (compactRendered.length > budgetChars && compactPack.nextActions.length > 1) {
    compactPack.nextActions.pop();
    compactRendered = renderContinuityPackPayload(compactPack);
  }
  if (compactRendered.length <= budgetChars) {
    return compactPack;
  }

  const fixedCost = compactRendered.length - compactPack.summary.length;
  const summaryBudget = Math.max(24, budgetChars - fixedCost - 3);
  return {
    ...compactPack,
    summary: truncateText(compactPack.summary, summaryBudget),
  };
}

function formatScope(scope: ContinuityPackScope): string {
  return scope.type === 'project' ? 'project' : `${scope.type}:${scope.id ?? 'unknown'}`;
}

function pushList(input: { label: string; lines: string[]; values: readonly string[] }): void {
  if (input.values.length === 0) {
    return;
  }
  input.lines.push('', `${input.label}:`);
  for (const value of input.values) {
    input.lines.push(`- ${value}`);
  }
}

function readContinuityFieldProvenance(value: unknown): ContinuityFieldProvenance | undefined {
  return typeof value === 'string' && (CONTINUITY_FIELD_PROVENANCE_VALUES as readonly string[]).includes(value)
    ? (value as ContinuityFieldProvenance)
    : undefined;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function readScope(value: unknown, scopeKey: string): ContinuityPackScope {
  const raw = readRecord(value);
  const type = raw.type;
  const id = raw.id;
  if (type === 'project') {
    return { type };
  }
  if ((type === 'lead' || type === 'outcome' || type === 'task') && typeof id === 'string') {
    return { id, type };
  }

  const scopeKeyParts = scopeKey.split(':');
  const typeFromKey = scopeKeyParts[0];
  const idFromKey = scopeKeyParts.slice(2).join(':');
  if (
    (typeFromKey === 'lead' || typeFromKey === 'outcome' || typeFromKey === 'task') &&
    typeof idFromKey === 'string' &&
    idFromKey.length > 0
  ) {
    return { id: idFromKey, type: typeFromKey };
  }
  return { type: 'project' };
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function renderContinuityPackPayload(pack: ContinuityPackPayload): string {
  const fullText = renderContinuityPackPayloadLines(pack, false).join('\n');
  if (!pack.budgets.truncated || fullText.length <= pack.budgets.budgetChars) {
    return fullText;
  }

  const compactText = renderContinuityPackPayloadLines(pack, true).join('\n');
  if (compactText.length <= pack.budgets.budgetChars) {
    return compactText;
  }

  return truncateText(compactText, pack.budgets.budgetChars);
}

function renderContinuityPackPayloadLines(pack: ContinuityPackPayload, compact: boolean): string[] {
  const lines = [
    '### Cross-Chat Continuity',
    '',
    `- budget: ${String(pack.budgets.payloadChars)} chars / ${String(pack.budgets.budgetChars)} budget${
      pack.budgets.truncated ? ' (truncated)' : ''
    }`,
    '',
    `Summary: ${pack.summary}`,
  ];
  if (!compact) {
    lines.splice(
      2,
      0,
      `- updated: ${pack.updatedAt}`,
      `- source: ${pack.provenance.source}`,
      `- source session: ${pack.provenance.sessionId}`,
      `- scope: ${formatScope(pack.provenance.scope)}`,
      `- authority: ${pack.provenance.scope.type === 'project' ? 'background project context; not a lead/outcome/task checkpoint' : 'scoped checkpoint'}`,
      `- field provenance: ${pack.provenance.continuityFields}`,
    );
    pushList({ label: 'Next', lines, values: pack.nextActions });
    pushList({ label: 'Context Needed', lines, values: pack.contextNeeded });
    pushList({ label: 'Decisions', lines, values: pack.decisions });
    pushList({ label: 'Open Questions', lines, values: pack.openQuestions });
    return lines;
  }

  pushList({ label: 'Next', lines, values: pack.nextActions.slice(0, 1) });
  return lines;
}

function stabilizePayloadChars(pack: ContinuityPackPayload): {
  pack: ContinuityPackPayload;
  payloadText: string;
} {
  let current = pack;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const payloadText = renderContinuityPackPayload(current);
    if (payloadText.length === current.budgets.payloadChars) {
      return { pack: current, payloadText };
    }
    current = {
      ...current,
      budgets: {
        ...current.budgets,
        payloadChars: payloadText.length,
      },
    };
  }
  return {
    pack: current,
    payloadText: renderContinuityPackPayload(current),
  };
}

function toPayloadFromRecord(record: ContinuityPackRecord): ContinuityPackPayload {
  const rawPack = record.pack;
  const rawBudgets = readRecord(rawPack.budgets);
  const rawProvenance = readRecord(rawPack.provenance);
  const rawReflection = readRecord(rawPack.reflection);
  return {
    budgets: {
      budgetChars: record.budgetChars,
      payloadChars: record.payloadChars,
      truncated: rawBudgets.truncated === true,
    },
    contextNeeded: readStringArray(rawPack.contextNeeded),
    decisions: readStringArray(rawPack.decisions),
    nextActions: readStringArray(rawPack.nextActions),
    openQuestions: readStringArray(rawPack.openQuestions),
    provenance: {
      ...(typeof rawProvenance.agent === 'string' ? { agent: rawProvenance.agent } : {}),
      continuityFields: readContinuityFieldProvenance(rawProvenance.continuityFields) ?? 'agent-authored',
      scope: readScope(rawProvenance.scope, record.scopeKey),
      sessionId: typeof rawProvenance.sessionId === 'string' ? rawProvenance.sessionId : (record.sessionId ?? ''),
      source: typeof rawProvenance.source === 'string' ? rawProvenance.source : record.source,
    },
    reflection: {
      count: typeof rawReflection.count === 'number' ? rawReflection.count : 0,
    },
    summary: typeof rawPack.summary === 'string' ? rawPack.summary : '',
    updatedAt: typeof rawPack.updatedAt === 'string' ? rawPack.updatedAt : (record.updatedAt ?? ''),
  };
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 3) {
    return '.'.repeat(Math.max(0, maxChars));
  }
  return `${text.slice(0, maxChars - 3).trimEnd()}...`;
}
