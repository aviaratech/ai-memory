type SummaryMap = Record<string, number | string>;

/**
 * Parses ai-memory warning strings of the form `<phase> timed out after <n>ms`
 * (emitted by `withTimeout` and `runBoundedQuery`) and returns the deduplicated
 * phase names in first-seen order.
 *
 * The phase name is the per-sub-step label that the bounded runner attaches to
 * `TimeoutError`, so callers can attribute degradation to the timed-out step
 * (e.g. `db.read.search_memories.reversal_penalty`, `memory_orient.search.direct`).
 */
export function extractTimedOutSteps(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const steps: string[] = [];
  for (const warning of value) {
    if (typeof warning !== 'string') {
      continue;
    }
    const match = / timed out after \d+ms\b/iu.exec(warning);
    if (match === null) {
      continue;
    }
    const phase = warning.slice(0, match.index).trim();
    if (phase.length === 0 || seen.has(phase)) {
      continue;
    }
    seen.add(phase);
    steps.push(phase);
  }
  return steps;
}

export function summarizeToolArgs(args: unknown): SummaryMap {
  const argsRecord = asRecord(args);
  if (argsRecord === undefined) {
    return {};
  }

  const summary: SummaryMap = {};
  const copyTextField = (sourceKey: string, targetKey: string) => {
    const value = argsRecord[sourceKey];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        summary[targetKey] = trimmed;
      }
    }
  };
  const copyNumberField = (sourceKey: string, targetKey: string) => {
    const value = argsRecord[sourceKey];
    if (typeof value === 'number' && Number.isFinite(value)) {
      summary[targetKey] = value;
    }
  };

  copyTextField('sessionId', 'session_id');
  copyTextField('category', 'category');
  copyTextField('detectedSource', 'detected_source');
  copyTextField('source', 'source');
  copyTextField('stage', 'stage');
  copyTextField('since', 'since');

  copyTextField('project', 'project');

  copyNumberField('limit', 'limit');
  copyNumberField('sinceDays', 'since_days');
  copyNumberField('eventLimit', 'event_limit');

  const query = argsRecord.query;
  if (typeof query === 'string') {
    summary.query_length = query.length;
  }

  const nextActionsCount = countStringArrayItems(argsRecord.nextActions);
  const contextNeededCount = countStringArrayItems(argsRecord.contextNeeded);
  const openQuestionsCount = countStringArrayItems(argsRecord.openQuestions);
  const stateModel = asRecord(argsRecord.stateModel);
  const assumptionsCount = stateModel === undefined ? 0 : countStringArrayItems(stateModel.assumptions);
  if (nextActionsCount > 0) {
    summary.next_actions_count = nextActionsCount;
  }
  if (contextNeededCount > 0) {
    summary.context_needed_count = contextNeededCount;
  }
  if (openQuestionsCount > 0) {
    summary.open_questions_count = openQuestionsCount;
  }
  if (assumptionsCount > 0) {
    summary.state_model_assumptions_count = assumptionsCount;
  }
  if (nextActionsCount > 0 || contextNeededCount > 0 || openQuestionsCount > 0 || assumptionsCount > 0) {
    summary.continuity_complete = nextActionsCount > 0 && (openQuestionsCount > 0 || assumptionsCount > 0) ? 1 : 0;
  }

  return summary;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  const parsed = parseJsonString(value);
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return undefined;
}

function countStringArrayItems(value: unknown): number {
  const parsed = parseJsonString(value);
  if (!Array.isArray(parsed)) {
    return 0;
  }
  return parsed.filter(item => typeof item === 'string' && item.trim().length > 0).length;
}

function parseJsonString(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}
