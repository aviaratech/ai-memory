#!/usr/bin/env node

import { logAiMemoryInfo, logAiMemoryWarn } from '@aviaratech/ai-memory/internal';

import {
  buildAutoMemoryDelta,
  closeAiMemoryPool,
  findLatestCodexSessionFile,
  lookupSessionContinuityFromPool,
  parseCodexSessionSummary,
  recordAutoIngestionFailure,
  resolveRepoIdFromCwd,
} from './auto-session-ingest.js';
import { runIngestPipeline } from './pipeline.js';

const CODEX_WRAPPER_SOURCE = 'codex-wrapper';

const FAILURE_CONTEXT: {
  agent: string;
  details: Record<string, unknown>;
  repoId?: string | undefined;
  sessionId?: string | undefined;
  source: string;
  stage: string;
} = {
  agent: 'codex-cli',
  details: {},
  source: CODEX_WRAPPER_SOURCE,
  stage: 'wrapper_init',
};

interface ParsedArgs {
  dryRun: boolean;
  root?: string | undefined;
  sessionFile?: string | undefined;
  sinceEpochSeconds?: number | undefined;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  FAILURE_CONTEXT.stage = 'resolve_session_file';

  const sessionFile =
    args.sessionFile ??
    findLatestCodexSessionFile({
      root: args.root,
      sinceEpochSeconds: args.sinceEpochSeconds,
    });

  if (sessionFile === undefined) {
    throw new Error('No Codex session file found to ingest.');
  }
  FAILURE_CONTEXT.details = {
    ...FAILURE_CONTEXT.details,
    session_file: sessionFile,
  };

  const parsed = parseCodexSessionSummary(sessionFile);
  const requestedModel = parsed.requestedModel;
  const resolvedModel = parsed.resolvedModel ?? parsed.model;
  const modelResolutionStatus = parsed.modelResolutionStatus;
  const modelResolutionError = parsed.modelResolutionError;
  FAILURE_CONTEXT.sessionId = parsed.sessionId;
  const repoId = parsed.repoId ?? (await resolveRepoIdFromCwd(parsed.cwd));
  FAILURE_CONTEXT.repoId = repoId;

  if (args.dryRun) {
    FAILURE_CONTEXT.stage = 'dry_run';
    const memoryDelta = buildAutoMemoryDelta({
      agent: 'codex-cli',
      assistantMessage: parsed.lastAssistantMessage,
      createdAt: parsed.createdAt,
      cwd: parsed.cwd,
      dedupeNamespace: 'codex',
      eventReason: 'post-session-wrapper',
      history: parsed.history,
      model: parsed.model,
      modelResolutionError,
      modelResolutionStatus,
      repoId,
      requestedModel,
      resolvedModel,
      sessionFilePath: sessionFile,
      sessionId: parsed.sessionId,
      source: CODEX_WRAPPER_SOURCE,
      toolCallCount: parsed.toolCallCount,
      userMessage: parsed.lastUserMessage,
    });

    process.stdout.write(
      `${JSON.stringify(
        {
          dryRun: true,
          memoryDelta,
          parsed,
          repoId,
          sessionFile,
        },
        null,
        2,
      )}\n`,
    );

    return;
  }

  FAILURE_CONTEXT.stage = 'ingest_auto_delta';
  const result = await runIngestPipeline(
    {
      agent: 'codex-cli',
      assistantMessage: parsed.lastAssistantMessage,
      createdAt: parsed.createdAt,
      cwd: parsed.cwd,
      dedupeNamespace: 'codex',
      eventReason: 'post-session-wrapper',
      history: parsed.history,
      model: parsed.model,
      modelResolutionError,
      modelResolutionStatus,
      repoId,
      requestedModel,
      resolvedModel,
      sessionFilePath: sessionFile,
      sessionId: parsed.sessionId,
      source: CODEX_WRAPPER_SOURCE,
      toolCallCount: parsed.toolCallCount,
      userMessage: parsed.lastUserMessage,
    },
    { lookupContinuity: lookupSessionContinuityFromPool },
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        parsed,
        repoId,
        result,
        sessionFile,
        status: 'ok',
      },
      null,
      2,
    )}\n`,
  );
}

void (async () => {
  try {
    await main();
  } catch (error: unknown) {
    await recordAutoIngestionFailure({
      ...FAILURE_CONTEXT,
      error,
    });

    const message = error instanceof Error ? error.message : String(error);
    logAiMemoryWarn('hook.codex_wrapper_ingest_failed', {
      message: `Codex wrapper ingest failed: ${message}`,
      source: CODEX_WRAPPER_SOURCE,
    });
    process.exitCode = 1;
  } finally {
    await closeAiMemoryPool().catch(() => {});
  }
})();

process.on('beforeExit', () => {
  if (process.exitCode === 0) {
    logAiMemoryInfo('hook.codex_wrapper_ingest_complete', {
      message: 'Codex wrapper ingest completed',
      source: CODEX_WRAPPER_SOURCE,
    });
  }
});

function parseArguments(argv: readonly string[]): ParsedArgs {
  const args: ParsedArgs = {
    dryRun: false,
    root: undefined,
    sessionFile: undefined,
    sinceEpochSeconds: undefined,
  };

  const queue: string[] = [...argv];
  while (queue.length > 0) {
    const value = queue.shift();
    if (value === undefined) {
      break;
    }

    if (value === '--dry-run') {
      args.dryRun = true;
      continue;
    }

    if (value === '--latest') {
      continue;
    }

    if (value === '--session-file') {
      args.sessionFile = requireNextArgument(queue, value);
      continue;
    }

    if (value === '--since') {
      args.sinceEpochSeconds = toPositiveInteger(requireNextArgument(queue, value), '--since');
      continue;
    }

    if (value === '--root') {
      args.root = requireNextArgument(queue, value);
      continue;
    }

    throw new Error(`Unknown argument: ${value}`);
  }

  return args;
}

function requireNextArgument(queue: string[], optionName: string) {
  const value = queue.shift();
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${optionName} requires a value.`);
  }

  return value;
}

function toPositiveInteger(value: string, fieldName: string) {
  const numericValue = Number(value);
  if (!Number.isInteger(numericValue) || numericValue <= 0) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }

  return numericValue;
}
