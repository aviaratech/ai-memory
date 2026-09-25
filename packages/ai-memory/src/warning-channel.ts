/**
 * Per-call telemetry sink for ai-memory operations.
 *
 * `recordAiMemoryWarningDetail` writes into an `AsyncLocalStorage`-scoped
 * collector started by `runWithAiMemoryWarningCollector`. The MCP server in
 * `@aviaratech/ai-memory-tools` wraps every tool invocation in such a
 * collector and forwards the resulting warning messages into the response
 * payload (`payload.warnings`) and into `ai_tool_invocations.summary_json.timed_out_steps`.
 *
 * Lives in `@aviaratech/ai-memory` (not `ai-memory-tools`) so DB-layer code
 * — embedding fetch, bounded DB transactions, flush sub-phases — can record
 * phase-attributed degradation directly.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import { isRecord } from './db/type-guards.js';

export interface AiMemoryWarningCollector {
  warningDetails: AiMemoryWarningDetail[];
}

export interface AiMemoryWarningDetail {
  code: string;
  message: string;
}

interface TextContentLike {
  text: string;
  type: 'text';
}

interface TextResultLike {
  [key: string]: unknown;
  content: TextContentLike[];
}

const warningStorage = new AsyncLocalStorage<AiMemoryWarningCollector>();

export function appendAiMemoryWarningsToPayload(
  payload: unknown,
  warningDetails: readonly AiMemoryWarningDetail[],
): unknown {
  if (!isRecord(payload) || warningDetails.length === 0) {
    return payload;
  }

  const existingWarningMessages = readWarningMessages(payload.warnings);
  const existingWarningDetails = readWarningDetails(payload.warningDetails);
  const mergedWarningDetails = dedupeWarningDetails([...existingWarningDetails, ...warningDetails]);
  const mergedWarningMessages = dedupeWarningMessages([
    ...existingWarningMessages,
    ...collectAiMemoryWarningMessages(mergedWarningDetails),
  ]);

  return {
    ...payload,
    ...(mergedWarningMessages.length > 0 ? { warnings: mergedWarningMessages } : {}),
    ...(mergedWarningDetails.length > 0 ? { warningDetails: mergedWarningDetails } : {}),
  };
}

export function appendAiMemoryWarningsToTextResult<T extends TextResultLike>(
  result: T,
  warningDetails: readonly AiMemoryWarningDetail[],
): T {
  if (warningDetails.length === 0) {
    return result;
  }

  const firstContent = result.content[0];
  if (firstContent?.type !== 'text') {
    return result;
  }

  try {
    const payload = JSON.parse(firstContent.text) as unknown;
    const mergedPayload = appendAiMemoryWarningsToPayload(payload, warningDetails);
    if (mergedPayload === payload) {
      return result;
    }

    return {
      ...result,
      content: [
        {
          ...firstContent,
          text: JSON.stringify(mergedPayload, null, 2),
        },
        ...result.content.slice(1),
      ],
    };
  } catch {
    return result;
  }
}

export function collectAiMemoryWarningMessages(warningDetails: readonly AiMemoryWarningDetail[]): string[] {
  return dedupeWarningMessages(
    warningDetails.flatMap(detail => {
      const normalized = normalizeWarningDetail(detail);
      return normalized === undefined ? [] : [normalized.message];
    }),
  );
}

export function createAiMemoryWarningCollector(): AiMemoryWarningCollector {
  return { warningDetails: [] };
}

export function listAiMemoryWarningDetails(collector: AiMemoryWarningCollector): AiMemoryWarningDetail[] {
  return collector.warningDetails.map(detail => ({ ...detail }));
}

export function recordAiMemoryWarningDetail(detail: AiMemoryWarningDetail): void {
  const collector = warningStorage.getStore();
  if (collector === undefined) {
    return;
  }

  const normalized = normalizeWarningDetail(detail);
  if (normalized === undefined) {
    return;
  }

  const duplicate = collector.warningDetails.some(
    existing => existing.code === normalized.code && existing.message === normalized.message,
  );
  if (!duplicate) {
    collector.warningDetails.push(normalized);
  }
}

export async function runWithAiMemoryWarningCollector<T>(
  collector: AiMemoryWarningCollector,
  fn: () => Promise<T>,
): Promise<T> {
  return await warningStorage.run(collector, fn);
}

function dedupeWarningDetails(warningDetails: readonly AiMemoryWarningDetail[]): AiMemoryWarningDetail[] {
  const deduped: AiMemoryWarningDetail[] = [];
  for (const detail of warningDetails) {
    const normalized = normalizeWarningDetail(detail);
    if (normalized === undefined) {
      continue;
    }

    const exists = deduped.some(
      existing => existing.code === normalized.code && existing.message === normalized.message,
    );
    if (!exists) {
      deduped.push(normalized);
    }
  }
  return deduped;
}

function dedupeWarningMessages(messages: readonly string[]): string[] {
  const deduped: string[] = [];
  for (const message of messages) {
    const normalized = typeof message === 'string' ? message.trim() : '';
    if (normalized.length === 0 || deduped.includes(normalized)) {
      continue;
    }
    deduped.push(normalized);
  }
  return deduped;
}

function normalizeWarningDetail(detail: AiMemoryWarningDetail): AiMemoryWarningDetail | undefined {
  const code = typeof detail.code === 'string' ? detail.code.trim() : '';
  const message = typeof detail.message === 'string' ? detail.message.trim() : '';
  if (code.length === 0 || message.length === 0) {
    return undefined;
  }

  return { code, message };
}

function readWarningDetails(value: unknown): AiMemoryWarningDetail[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap(item => {
    if (!isRecord(item)) {
      return [];
    }

    const normalized = normalizeWarningDetail({
      code: typeof item.code === 'string' ? item.code : '',
      message: typeof item.message === 'string' ? item.message : '',
    });
    return normalized === undefined ? [] : [normalized];
  });
}

function readWarningMessages(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap(item => (typeof item === 'string' && item.trim().length > 0 ? [item.trim()] : []));
}
