#!/usr/bin/env node

import { loadAiMemoryInternalLogging, MISSING_AI_MEMORY_BUILD_WARNING } from '../aiMemoryInternalLogging.js';

async function main() {
  // Preflight @aviaratech/ai-memory/internal. Before ai-memory
  // may still be missing dist outputs in a fresh worktree. Without this probe
  // the dynamic import of ./session-start-hook.js below would throw
  // ERR_MODULE_NOT_FOUND, which the defensive catch at the bottom would otherwise
  // swallow as a silent no-op envelope and mask the real cause from operators.
  const internalLogging = await loadAiMemoryInternalLogging();
  if (internalLogging.usingFallback) {
    emitHookResult({ systemMessage: MISSING_AI_MEMORY_BUILD_WARNING });
    return;
  }

  const { runSessionStartHook } = await import('./session-start-hook.js');
  const payload = await readHookInput();

  const hookEventName =
    firstDefinedText(payload.hook_event_name, payload.hookEventName, payload.event_name, payload.eventName) ??
    'unknown';
  const sessionId = firstDefinedText(payload.session_id, payload.sessionId, payload.agent_id, payload.agentId);
  const cwd = firstDefinedText(payload.cwd, process.env.CLAUDE_PROJECT_DIR, process.env.PWD) ?? process.cwd();
  const repoId = firstDefinedText(payload.repo_id, payload.repoId, payload.repository);

  const outcome = await runSessionStartHook(undefined, {
    cwd,
    hookEventName,
    repoId,
    sessionId,
  });

  if (outcome.warning) {
    emitHookResult({ systemMessage: outcome.warning });
  } else {
    const bootstrapText = outcome.bootstrapText ?? outcome.recallText;
    if (bootstrapText !== undefined) {
      emitHookResult({ systemMessage: bootstrapText });
    } else if (outcome.suppressOutput) {
      emitHookResult();
    } else {
      emitHookResult();
    }
  }
}

main().catch((error: unknown) => {
  // runSessionStartHook handles its own errors internally, but an unexpected
  // import-time failure (a transitive missing-dist case we do not preflight, a
  // syntax error in a new hook helper, etc.) must not silently masquerade as a
  // no-op envelope. Surface the cause via systemMessage so operators have a
  // diagnostic starting point instead of debugging a hook that "did nothing".
  emitHookResult({ systemMessage: formatHookCrashMessage(error) });
});

interface HookResultOptions {
  systemMessage?: string;
}

function emitHookResult(options?: HookResultOptions) {
  const hasWarning = options?.systemMessage !== undefined && options.systemMessage.length > 0;
  process.stdout.write(
    `${JSON.stringify({
      continue: true,
      ...(hasWarning ? { suppressOutput: false, systemMessage: options.systemMessage } : { suppressOutput: true }),
    })}\n`,
  );
}

function firstDefinedText(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }

    const normalized = value.trim();
    if (normalized.length > 0) {
      return normalized;
    }
  }

  return undefined;
}

function formatHookCrashMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `[ai-memory] warning: session-start hook startup failed before recall could run: ${detail}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readHookInput() {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin as AsyncIterable<unknown>) {
    chunks.push(toChunkBuffer(chunk));
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw.length === 0) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toChunkBuffer(chunk: unknown): Buffer {
  if (typeof chunk === 'string') {
    return Buffer.from(chunk);
  }

  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }

  return Buffer.from(String(chunk));
}
