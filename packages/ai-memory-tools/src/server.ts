#!/usr/bin/env node

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import {
  closePool,
  countContestedMemories,
  formatError,
  formatMemoryPayload,
  getCapabilities,
  getContinuityPack,
  getDatabaseUrlForDisplay,
  getMemoryEntries,
  getSessionResume,
  hasTimeoutWarning,
  ingestContextPack,
  ingestMemoryDelta,
  initializeDatabase,
  isRecord,
  listContestedMemories,
  listIngestionFailures,
  listSessionEvents,
  logAiMemoryError,
  logAiMemoryInfo,
  logAiMemoryWarn,
  MEMORY_TYPE_VALUES,
  orientMemory,
  readOptionalText,
  recallMemories,
  recordIngestionFailure,
  recordToolInvocation,
  resolveContestedMemory,
  searchMemories,
  storeMemory,
  STRATEGY_CONFIDENCE_VALUES,
  type ToolInvocationInput,
} from '@aviaratech/ai-memory/internal';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import * as z from 'zod/v4';

import { ensurePostgresRunning, formatPostgresRecoveryHint } from './ensure-postgres.js';
import { buildContinuityPackDebugPayload } from './ingestion/continuity-pack.js';
import { runIngestPipeline } from './ingestion/pipeline.js';
import { getAiMemoryRuntimeDiagnostics, initializeAiMemoryRuntimeEnv, loadAiMemoryMcpEnvConfig } from './runtimeEnv.js';
import { extractTimedOutSteps, summarizeToolArgs } from './telemetry-summary.js';
import {
  appendAiMemoryWarningsToTextResult,
  createAiMemoryWarningCollector,
  listAiMemoryWarningDetails,
  recordAiMemoryWarningDetail,
  runWithAiMemoryWarningCollector,
} from './warning-channel.js';

export const server = new McpServer({
  name: 'ai-memory',
  version: '0.1.1',
});

let startupInitialization: Promise<void> = Promise.resolve();

const TOOL_CATEGORY_BY_NAME = {
  memory_continuity_debug: 'read',
  memory_continuity_pack: 'read',
  memory_flush: 'write',
  memory_get: 'read',
  memory_ingest_context_pack: 'write',
  memory_ingest_delta: 'write',
  memory_ingestion_failures: 'ops',
  memory_orient: 'read',
  memory_recall: 'read',
  memory_resolve_contested: 'write',
  memory_runtime_diagnostics: 'ops',
  memory_search: 'read',
  memory_session_resume: 'read',
  memory_session_tail: 'read',
  memory_store: 'write',
} as const;

interface AgentContext {
  agent?: string;
  model?: string;
  source?: string;
}

interface PostgresStatus {
  databaseName?: string | undefined;
  databaseUrl: string;
  errorMessage?: string | undefined;
  hint?: string | undefined;
  ok: boolean;
  serverVersion?: string | undefined;
}
type SummaryMap = Record<string, number | string>;

type ToolCategory = 'ops' | 'read' | 'write';

interface ToolErrorResult {
  [key: string]: unknown;
  content: ToolTextContent[];
  isError: true;
}

interface ToolInvocationParams {
  args: unknown;
  handler: () => Promise<ToolResult>;
  toolName: ToolName;
}
type ToolName = keyof typeof TOOL_CATEGORY_BY_NAME;

type ToolResult = ToolErrorResult | ToolTextResult;

interface ToolTextContent {
  text: string;
  type: 'text';
}

interface ToolTextResult {
  [key: string]: unknown;
  content: ToolTextContent[];
}

export function detectAgentContext(env: NodeJS.ProcessEnv = process.env): AgentContext {
  const rawIdentity = env.AI_AGENT_IDENTITY?.trim();
  const identity = rawIdentity != null && rawIdentity.length > 0 ? rawIdentity : undefined;
  const rawModel = env.CLAUDE_MODEL?.trim();
  const model = rawModel != null && rawModel.length > 0 ? rawModel : undefined;
  const modelContext = model === undefined ? {} : { model };
  if (identity !== undefined) return { agent: identity, source: identity, ...modelContext };
  if (env.CLAUDECODE === '1') return { agent: 'claude-code', source: 'claude-code', ...modelContext };
  if (env.CODEX !== undefined) return { agent: 'codex', source: 'codex', ...modelContext };
  return modelContext;
}

export function mergeDetectedDefaults(args: unknown, detectedDefaults: AgentContext): Record<string, unknown> {
  const defaults = omitUndefinedValues({
    ...detectedDefaults,
    detectedSource: detectedDefaults.source,
  });
  const input = isRecord(args) ? omitUndefinedValues(args) : {};
  return { ...defaults, ...input };
}

function acceptJsonEncoded<T extends z.ZodType>(schema: T) {
  return z.preprocess(parsePossiblyJsonEncoded, schema);
}

function hasNonEmptyStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.some(item => typeof item === 'string' && item.trim().length > 0);
}

function isAgentWriterSource(source: unknown): boolean {
  if (typeof source !== 'string') {
    return false;
  }
  const normalized = source.trim().toLowerCase();
  return (
    normalized === 'agent' ||
    normalized === 'claude-code' ||
    normalized === 'codex' ||
    normalized.endsWith('-builder') ||
    normalized.endsWith('-reviewer') ||
    normalized.endsWith('-retro')
  );
}

function omitUndefinedValues(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function parsePossiblyJsonEncoded(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

const detectedAgentContext = detectAgentContext();

const memoryStoreEvidenceRefSchema = z.union([z.string().min(1), z.record(z.string(), z.unknown())]);

export const memoryStoreInputSchema = z.object({
  agent: z.string().min(1).optional().describe('Agent identifier writing memory.'),
  category: z.string().min(1).describe('Memory category (required): decision, convention, bugfix, preference, etc.'),
  confidence: acceptJsonEncoded(z.number().min(0).max(1).optional()).describe(
    'Confidence score from 0 to 1. Policy gate: non-session-summary >= 0.5, session-summary <= 0.5.',
  ),
  content: z.string().min(1).describe('Memory content to persist.'),
  evidenceRefs: acceptJsonEncoded(z.array(memoryStoreEvidenceRefSchema).optional()).describe(
    'Evidence references for auditability. REQUIRED for architecture, convention, methodology, preference, and root-cause categories. Include at least one file path, PR URL, or issue link.',
  ),
  expiresAt: z
    .string()
    .min(1)
    .optional()
    .describe('Optional expiration timestamp (ISO-8601 recommended). Required for session-summary durable memories.'),
  importance: acceptJsonEncoded(z.number().min(0).max(1).optional()).describe(
    'Optional importance override from 0 to 1. When omitted, ai-memory computes initial importance from confidence + taxonomy tier.',
  ),
  memoryKey: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Stable idempotency key for upsert (e.g. "org/repo:document-format"). ' +
        'Auto-derived from content hash for strict categories (architecture, convention, preference, root-cause) when omitted. ' +
        'Explicit keys provide better cross-edit upsert semantics; auto-derived keys upsert only when content is identical.',
    ),
  memoryType: z
    .enum(MEMORY_TYPE_VALUES)
    .optional()
    .describe('Optional memory type override. Defaults are inferred from category when omitted.'),
  metadata: acceptJsonEncoded(z.record(z.string(), z.unknown()).optional())
    .optional()
    .describe('Optional additional metadata object.'),
  model: z.string().min(1).optional().describe('Model identifier writing memory.'),
  orgId: z.string().min(1).optional().describe('Optional organization scope id.'),
  project: z.string().min(1).optional().describe('Optional project or repo context.'),
  repoId: z.string().min(1).optional().describe('Optional repository scope id.'),
  repoSlug: z.string().min(1).optional().describe('Optional repository slug.'),
  sensitivity: z
    .enum(['confidential', 'internal', 'public', 'restricted'])
    .optional()
    .describe('Data sensitivity classification.'),
  sessionId: z.string().min(1).optional().describe('Session id for provenance.'),
  source: z.string().min(1).optional().describe('Tool/source identifier (claude-code, codex, manual).'),
  status: z.enum(['active', 'archived', 'contested', 'expired', 'superseded']).optional().describe('Lifecycle status.'),
  supersedesId: acceptJsonEncoded(z.number().int().positive().optional()).describe(
    'Optional previous memory id this entry supersedes.',
  ),
  tags: acceptJsonEncoded(z.array(z.string().min(1)).optional()).describe('Optional tags for retrieval.'),
  threadId: z.string().min(1).optional().describe('Thread id for provenance.'),
  tool: z.string().min(1).optional().describe('Tool/runtime identifier writing memory.'),
  updatedBy: z.string().min(1).optional().describe('Optional actor/user that updated this memory.'),
  userId: z.string().min(1).optional().describe('Optional user scope id.'),
});

server.registerTool(
  'memory_store',
  {
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true, readOnlyHint: false },
    description:
      'Store a durable memory for cross-session, cross-agent recall. Do not store secrets, PHI, or raw logs. Category-specific requirements: session-summary requires expiresAt and confidence <= 0.5; architecture, convention, methodology, preference, and root-cause require evidenceRefs and memoryKey.',
    inputSchema: memoryStoreInputSchema.shape,
  },
  (args: unknown) =>
    runTool({
      args,
      handler: async () => {
        const record = await storeMemory(mergeDetectedDefaults(args, detectedAgentContext));
        return toTextResult({ memory: record, status: 'ok' });
      },
      toolName: 'memory_store',
    }),
);

const strategyConfidenceSchema = z.enum(STRATEGY_CONFIDENCE_VALUES);

const agentStateModelInputSchema = z
  .object({
    assumptions: z.array(z.string()).optional(),
    confidence_history: z
      .array(
        z.object({
          reason: z.string(),
          value: z
            .string()
            .describe('Normalized to nearest valid value (high, medium, low) if a near-miss is provided.'),
        }),
      )
      .optional(),
    constraints: z.array(z.string()).optional(),
    next_decision: z.string().optional(),
    strategy_confidence: strategyConfidenceSchema.optional().describe('Normalized to "medium" if missing or invalid.'),
    uncertainty: z.array(z.string()).optional(),
    updated_at: z.string().optional(),
  })
  .loose();

const memoryFlushInputShape = {
  activeGoal: z
    .string()
    .min(1)
    .optional()
    .describe('Optional active goal text to link this flush snapshot to the current goal context.'),
  agent: z.string().min(1).optional().describe('Optional agent identifier for promoted durable memories.'),
  contextNeeded: acceptJsonEncoded(z.array(z.string().min(1)).optional()).describe(
    'Information or operator context the next session needs to proceed. Stored in session snapshot for resume.',
  ),
  decisions: acceptJsonEncoded(z.array(z.string().min(1)).optional()).describe(
    'Architecture or scope decisions made this session. Stored as durable decision memories.',
  ),
  detectedSource: z
    .string()
    .min(1)
    .optional()
    .describe('Detected writer source supplied by the MCP runtime before persistence routing.'),
  envModel: acceptJsonEncoded(z.record(z.string(), z.unknown()).optional()).describe(
    'Optional environment model (see EnvironmentModel in contracts/types.ts). ' +
      'Expected keys include branch, workspace_dirty, uncommitted_files, open_prs, failing_checks, blocked_by, and tooling_available.',
  ),
  lead: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional active lead identity. Writes a separate lead-scoped checkpoint without replacing project startup context.',
    ),
  nextActions: acceptJsonEncoded(z.array(z.string().min(1)).optional()).describe(
    'What should happen next. Stored in session snapshot for resume.',
  ),
  openQuestions: acceptJsonEncoded(z.array(z.string().min(1)).optional()).describe(
    'Unresolved questions. Stored in session snapshot for resume.',
  ),
  outcome: z
    .string()
    .min(1)
    .optional()
    .describe('Optional current outcome identity for a separate bounded checkpoint.'),
  project: z.string().min(1).optional().describe('Optional project context.'),
  repoSlug: z
    .string()
    .min(1)
    .optional()
    .describe('Verified owner/repository identity; resolves its project basename to the repository scope.'),
  rootCauses: acceptJsonEncoded(z.array(z.string().min(1)).optional()).describe(
    'Bugs diagnosed or root causes identified. Stored as durable root-cause memories.',
  ),
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Actual producing host session identity. If omitted, a generated unattested identity is returned; task remains a separate recovery scope.',
    ),
  source: z.string().min(1).optional().describe('Optional source identifier for promoted durable memories.'),
  stateModel: acceptJsonEncoded(agentStateModelInputSchema.optional()).describe(
    'Optional agent state model (see AgentStateModel in contracts/types.ts). ' +
      'Fields: strategy_confidence ("high"|"medium"|"low", normalized to "medium" if missing), ' +
      'assumptions, uncertainty, constraints, next_decision, updated_at, confidence_history.',
  ),
  summary: z.string().min(1).describe('Agent-authored summary of current work and key context.'),
  task: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Stable logical task identity, retained across host sessions and MCP reconnects. Recover this checkpoint through memory_continuity_pack with task.',
    ),
};

export const memoryFlushInputSchema = z.object(memoryFlushInputShape).superRefine((input, ctx) => {
  const writerSource = input.detectedSource ?? input.source ?? input.agent;
  if (!isAgentWriterSource(writerSource)) {
    return;
  }

  if (!hasNonEmptyStringArray(input.nextActions)) {
    ctx.addIssue({
      code: 'custom',
      message: 'Agent memory_flush requires nextActions with at least one non-empty entry.',
      path: ['nextActions'],
    });
  }

  const assumptions = isRecord(input.stateModel) ? input.stateModel.assumptions : undefined;
  if (!hasNonEmptyStringArray(input.openQuestions) && !hasNonEmptyStringArray(assumptions)) {
    ctx.addIssue({
      code: 'custom',
      message:
        'Agent memory_flush requires openQuestions with at least one non-empty entry or stateModel.assumptions with at least one non-empty entry.',
      path: ['openQuestions'],
    });
  }
});

server.registerTool(
  'memory_flush',
  {
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true, readOnlyHint: false },
    description:
      'Save critical session context before compaction or handoff. ' +
      'Stores a checkpoint summary (searchable, not in recall), promotes decisions/root-causes to durable memory, ' +
      'updates the session snapshot with next_actions, context_needed, and open_questions for session resume, and when stateModel is present ' +
      'generates reflective memories with a returned reflections count.',
    inputSchema: memoryFlushInputShape,
  },
  (args: unknown) => {
    const merged = mergeDetectedDefaults(args, detectedAgentContext);
    return runTool({
      args: merged,
      handler: async () => {
        const parsed = memoryFlushInputSchema.parse(merged);
        const result = await runIngestPipeline({
          ...parsed,
          source: 'manual-flush',
        });
        return toTextResult(result);
      },
      toolName: 'memory_flush',
    });
  },
);

export const memoryOrientInputSchema = z.object({
  activeGoal: z
    .string()
    .min(1)
    .optional()
    .describe('Optional active goal text used to condition task-relevant retrieval during orient.'),
  agent: z.string().min(1).optional().describe('Optional agent identifier for session fallback scope.'),
  cwd: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional repository working directory for environment probing. Use when the MCP server process is outside the target git repo.',
    ),
  envProbe: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Environment probe mode. Accepted values: none, local, full. ' +
        "'none' disables checks, 'local' runs local git commands, and 'full' adds GitHub PR/check probes with graceful local fallback.",
    ),
  fullContentTopN: z
    .number()
    .int()
    .min(0)
    .max(5)
    .optional()
    .describe(
      "When memoryDetail is 'compact', include full content for up to N top-ranked memories per array (0-5, default 0).",
    ),
  memoryDetail: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional memory payload detail for orient memory arrays. Accepted values: compact, full. Defaults to 'compact'.",
    ),
  memoryType: z
    .string()
    .min(1)
    .optional()
    .describe(
      `Optional memory type filter for recall/search sub-steps. Accepted values: ${MEMORY_TYPE_VALUES.join(', ')}.`,
    ),
  project: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional project scope for recall/search/resume and the project-scoped contested count. ' +
        'When omitted, orient stays unscoped and skips the project-specific contested-memory count.',
    ),
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe('Optional exact session id for direct prior-session resume; agent/project remain fallback scope only.'),
  stateModel: acceptJsonEncoded(agentStateModelInputSchema.optional()).describe(
    'Deprecated no-op. Accepted for backward compatibility with older callers but currently has no effect on orient. ' +
      'Fields: strategy_confidence ("high"|"medium"|"low"), assumptions, uncertainty, constraints, next_decision.',
  ),
  task: z.string().min(1).optional().describe('Optional task query used for targeted memory search.'),
});

export const memoryRuntimeDiagnosticsInputSchema = z.object({});

const memoryContinuityPackInputShape = {
  lead: z
    .string()
    .min(1)
    .optional()
    .describe('Explicit lead checkpoint scope. Exactly one explicit scope may be selected.'),
  outcome: z
    .string()
    .min(1)
    .optional()
    .describe('Explicit outcome checkpoint scope. Exactly one explicit scope may be selected.'),
  project: z.string().min(1).optional().describe('Project or repository scope for the continuity pack.'),
  repoId: z.string().min(1).optional().describe('Repository scope alias used when project is omitted.'),
  task: z
    .string()
    .min(1)
    .optional()
    .describe('Explicit task checkpoint scope. Exactly one explicit scope may be selected.'),
};

export const memoryContinuityPackInputSchema = z.object(memoryContinuityPackInputShape).superRefine((input, ctx) => {
  const selectedScopes = [input.lead, input.outcome, input.task].filter(value => value !== undefined);
  if (selectedScopes.length > 1) {
    ctx.addIssue({
      code: 'custom',
      message: 'memory_continuity_pack accepts exactly one of lead, outcome, or task.',
      path: ['lead'],
    });
  }
});

export const memoryContinuityDebugInputSchema = memoryContinuityPackInputSchema;

export const memoryGetInputSchema = z.object({
  id: acceptJsonEncoded(z.number().int().positive().optional()).describe('Single memory id to fetch.'),
  ids: acceptJsonEncoded(z.array(z.number().int().positive()).max(100).optional()).describe(
    'Multiple memory ids to fetch (max 100).',
  ),
  includeInactive: z
    .boolean()
    .optional()
    .describe('Include superseded/expired/archived memories when true (default: true).'),
  project: z.string().min(1).optional().describe('Optional project filter for scoped lookup.'),
});

server.registerTool(
  'memory_continuity_debug',
  {
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: true },
    description:
      'Read and render the exact bounded cross-chat continuity pack that session startup would consume, including budget/truncation metadata. Debug-only; does not run vector recall.',
    inputSchema: memoryContinuityPackInputShape,
  },
  (args: unknown) =>
    runTool({
      args,
      handler: async () => {
        const parsed = memoryContinuityDebugInputSchema.parse(args);
        const result = await getContinuityPack(parsed);
        return toTextResult(buildContinuityPackDebugPayload(result));
      },
      toolName: 'memory_continuity_debug',
    }),
);

server.registerTool(
  'memory_continuity_pack',
  {
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: true },
    description:
      'Read a bounded cross-chat continuity pack. The default project scope is startup background context; pass exactly one lead, outcome, or task identity for an explicit checkpoint. Refresh happens through memory_flush.',
    inputSchema: memoryContinuityPackInputShape,
  },
  (args: unknown) =>
    runTool({
      args,
      handler: async () => {
        const parsed = memoryContinuityPackInputSchema.parse(args);
        const result = await getContinuityPack(parsed);
        return toTextResult(result);
      },
      toolName: 'memory_continuity_pack',
    }),
);

server.registerTool(
  'memory_orient',
  {
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true, readOnlyHint: false },
    description:
      'Single-call startup orientation: combines recall, session resume, task search, contested count, and environment probing. Recall/search may update stored access importance.',
    inputSchema: memoryOrientInputSchema.shape,
  },
  (args: unknown) =>
    runTool({
      args,
      handler: async () => {
        const result = await orientMemory(mergeDetectedDefaults(args, detectedAgentContext));
        return toTextResult(result);
      },
      toolName: 'memory_orient',
    }),
);

server.registerTool(
  'memory_runtime_diagnostics',
  {
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false, readOnlyHint: false },
    description:
      'Inspect the ai-memory runtime credential resolution without revealing secrets. ' +
      'Reports whether the database URL is present, which key won, which runtime source provided it, and the derived database host.',
    inputSchema: memoryRuntimeDiagnosticsInputSchema.shape,
  },
  (args: unknown) =>
    runTool({
      args,
      handler: () => Promise.resolve(toTextResult(getAiMemoryRuntimeDiagnostics())),
      toolName: 'memory_runtime_diagnostics',
    }),
);

server.registerTool(
  'memory_get',
  {
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: true },
    description: 'Fetch durable memory rows by id for on-demand expansion after compact orient/search previews.',
    inputSchema: memoryGetInputSchema.shape,
  },
  (args: unknown) =>
    runTool({
      args,
      handler: async () => {
        const memories = await getMemoryEntries(args);
        return toTextResult({ count: memories.length, memories });
      },
      toolName: 'memory_get',
    }),
);

export const memorySearchInputSchema = z.object({
  activeGoal: z.string().min(1).optional().describe('Optional active goal text used to condition result reranking.'),
  category: z.string().min(1).optional().describe('Optional category filter.'),
  fullContentTopN: acceptJsonEncoded(z.number().int().min(0).max(5).optional()).describe(
    "When memoryDetail is 'compact', include full content for up to N top-ranked results (0-5, default 0).",
  ),
  includeInactive: z.boolean().optional().describe('Include superseded/expired/archived memories when true.'),
  limit: acceptJsonEncoded(z.number().int().min(1).max(25).optional()).describe('Max number of results (default 8).'),
  memoryDetail: z.enum(['compact', 'full']).optional().describe('Result detail: compact (default) or full.'),
  memoryType: z.enum(MEMORY_TYPE_VALUES).optional().describe('Optional memory type filter.'),
  project: z.string().min(1).optional().describe('Optional project filter.'),
  query: z.string().min(1).describe('Search query string.'),
  sessionId: z.string().min(1).optional().describe('Optional exact session id for scoped recovery.'),
});

server.registerTool(
  'memory_search',
  {
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true, readOnlyHint: false },
    description:
      'Search durable memories by semantic-ish text query + filters. Returns compact source-linked previews by default; use memory_get for full detail. All detail modes share a 16384-byte serialized result cap; oversized full records become marked compact previews.',
    inputSchema: memorySearchInputSchema.shape,
  },
  (args: unknown) =>
    runTool({
      args,
      handler: async () => {
        const parsed = memorySearchInputSchema.parse(args);
        const memories = await searchMemories(parsed);
        return toTextResult({
          count: memories.length,
          memories,
        });
      },
      toolName: 'memory_search',
    }),
);

export const memoryIngestContextPackInputSchema = z.object({
  contextPack: acceptJsonEncoded(z.record(z.string(), z.unknown())).describe(
    'A context_pack@0.1 object compliant with the shared contract schema.',
  ),
});

server.registerTool(
  'memory_ingest_context_pack',
  {
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false, readOnlyHint: false },
    description:
      'Validate and ingest a full context_pack@0.1 payload (session, snapshot, events, and context artifact).',
    inputSchema: memoryIngestContextPackInputSchema.shape,
  },
  (args: unknown) =>
    runTool({
      args,
      handler: async () => {
        const result = await ingestContextPack(args);
        return toTextResult(result);
      },
      toolName: 'memory_ingest_context_pack',
    }),
);

export const memoryIngestDeltaInputSchema = z.object({
  memoryDelta: acceptJsonEncoded(z.record(z.string(), z.unknown())).describe(
    'A memory_delta@0.1 object compliant with the shared contract schema.',
  ),
});

server.registerTool(
  'memory_ingest_delta',
  {
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false, readOnlyHint: false },
    description:
      'Validate and ingest a full memory_delta@0.1 payload, including append events and optional durable memory proposals.',
    inputSchema: memoryIngestDeltaInputSchema.shape,
  },
  (args: unknown) =>
    runTool({
      args,
      handler: async () => {
        const result = await ingestMemoryDelta(args);
        return toTextResult(result);
      },
      toolName: 'memory_ingest_delta',
    }),
);

server.registerTool(
  'memory_ingestion_failures',
  {
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: true },
    description:
      'List recent ai-memory ingestion failures (hooks/wrappers/ingesters) for operational debugging and observability.',
    inputSchema: {
      limit: acceptJsonEncoded(z.number().int().min(1).max(200).optional()).describe(
        'Max records to return (default 20).',
      ),
      sessionId: z.string().min(1).optional().describe('Optional session id filter.'),
      source: z.string().min(1).optional().describe('Optional source filter (claude-session-end, codex-wrapper, etc).'),
      stage: z
        .string()
        .min(1)
        .optional()
        .describe('Optional stage filter (ingest_auto_delta, ingest_memory_delta, etc).'),
    },
  },
  (args: unknown) =>
    runTool({
      args,
      handler: async () => {
        const failures = await listIngestionFailures(args);
        return toTextResult({ count: failures.length, failures });
      },
      toolName: 'memory_ingestion_failures',
    }),
);

server.registerTool(
  'memory_recall',
  {
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false, readOnlyHint: false },
    description: 'Recall recent durable memories for session startup context.',
    inputSchema: {
      category: z.string().min(1).optional().describe('Optional category filter.'),
      includeInactive: z.boolean().optional().describe('Include superseded/expired/archived memories when true.'),
      limit: acceptJsonEncoded(z.number().int().min(1).max(50).optional()).describe(
        'Max number of records (default 10).',
      ),
      memoryType: z.enum(MEMORY_TYPE_VALUES).optional().describe('Optional memory type filter.'),
      project: z.string().min(1).optional().describe('Optional project filter.'),
      sinceDays: acceptJsonEncoded(z.number().int().min(1).max(3650).optional()).describe(
        'Lookback window in days (default 90).',
      ),
    },
  },
  (args: unknown) =>
    runTool({
      args,
      handler: async () => {
        const memories = await recallMemories(args);
        const contestedCount = await countContestedMemories(args);
        const result: Record<string, unknown> = {
          count: memories.length,
          memories,
        };
        if (contestedCount > 5) {
          result.notice = `Note: ${String(contestedCount)} contested memories exist. Consider running memory_resolve_contested.`;
        }
        return toTextResult(result);
      },
      toolName: 'memory_recall',
    }),
);

server.registerTool(
  'memory_resolve_contested',
  {
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false, readOnlyHint: false },
    description: 'List contested memory pairs and optionally resolve them.',
    inputSchema: {
      action: z
        .enum(['list', 'keep_first', 'keep_second', 'keep_both', 'merge'])
        .optional()
        .describe(
          'Resolution action. list: show contested memories (default limit: 100, max: 500). ' +
            'keep_first: keep A, supersede B. keep_second: keep B, supersede A. ' +
            'keep_both: set both back to active. merge: create new memory superseding both.',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe('Max contested pairs to return for list action (default 100, max 500).'),
      memoryIdA: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('First memory id in the contested pair. Required for resolution actions.'),
      memoryIdB: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Second memory id in the contested pair. Required for resolution actions.'),
      mergedContent: z
        .string()
        .min(1)
        .optional()
        .describe('Merged content for the new memory. Required when action is merge.'),
      project: z.string().min(1).optional().describe('Optional project filter for list action.'),
    },
  },
  (args: unknown) =>
    runTool({
      args,
      handler: async () => {
        const request = isRecord(args) ? args : {};
        const action = request.action ?? 'list';
        if (action === 'list') {
          const memories = await listContestedMemories(args);
          return toTextResult({ count: memories.length, memories });
        }
        const result = await resolveContestedMemory(args);
        return toTextResult({ status: 'ok', ...result });
      },
      toolName: 'memory_resolve_contested',
    }),
);

server.registerTool(
  'memory_session_resume',
  {
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: true },
    description:
      'Fetch short-term session context for reliable resume: session metadata, latest snapshot, and recent events. ' +
      'Pass a known host sessionId for exact scoped lookup; a missing or foreign session never falls back. ' +
      'For a logical task spanning sessions, use memory_continuity_pack with task instead. Without sessionId, agent/project/repoId select the most recent matching session as background. ' +
      'At least one of sessionId, agent, project, or repoId must be provided.',
    inputSchema: {
      agent: z.string().min(1).optional().describe('Agent identifier for fallback session resolution.'),
      eventLimit: acceptJsonEncoded(z.number().int().min(1).max(500).optional()).describe(
        'Max recent events to include (default 25).',
      ),
      project: z.string().min(1).optional().describe('Project identifier for fallback session resolution.'),
      repoId: z.string().min(1).optional().describe('Repository identifier for fallback session resolution.'),
      sessionId: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Exact host session id to resume. Missing or foreign scoped sessions return not_found without fallback.',
        ),
    },
  },
  (args: unknown) =>
    runTool({
      args,
      handler: async () => {
        const session = await getSessionResume(args);
        return toTextResult(session);
      },
      toolName: 'memory_session_resume',
    }),
);

server.registerTool(
  'memory_session_tail',
  {
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: true },
    description: 'Read recent short-term session events for a session, optionally since an ISO timestamp.',
    inputSchema: {
      limit: acceptJsonEncoded(z.number().int().min(1).max(500).optional()).describe(
        'Max number of events to return (default 50).',
      ),
      sessionId: z.string().min(1).describe('Session id to read.'),
      since: z.string().min(1).optional().describe('Optional ISO timestamp lower bound for event created_at.'),
    },
  },
  (args: unknown) =>
    runTool({
      args,
      handler: async () => {
        const events = await listSessionEvents(args);
        return toTextResult(events);
      },
      toolName: 'memory_session_tail',
    }),
);

async function main() {
  logAiMemoryInfo('mcp.agent_context_detected', {
    agent: detectedAgentContext.agent ?? null,
    message: `Agent context detected: agent=${detectedAgentContext.agent ?? 'undefined'}, source=${detectedAgentContext.source ?? 'undefined'}`,
    source: detectedAgentContext.source ?? null,
  });

  const envConfig = loadAiMemoryMcpEnvConfig();
  const postgresStatus = normalizePostgresStatus(
    await ensurePostgresRunning({
      logProgress: false,
      startIfNeeded: envConfig.autoStartPostgres,
    }),
  );
  let startupMode: 'degraded' | 'full' = postgresStatus.ok ? 'full' : 'degraded';

  if (!postgresStatus.ok) {
    const hint = postgresStatus.hint ?? formatPostgresRecoveryHint(postgresStatus.databaseUrl);
    const message = `Postgres unavailable at ${postgresStatus.databaseUrl}. ${hint}`;
    logAiMemoryWarn('mcp.postgres_unavailable', {
      database_url: postgresStatus.databaseUrl,
      error: postgresStatus.errorMessage,
      hint,
      message,
    });

    if (envConfig.requirePostgresOnStartup) {
      throw new Error(message);
    }
  }

  logAiMemoryInfo('mcp.starting', {
    auto_start_postgres: envConfig.autoStartPostgres,
    database: postgresStatus.databaseName,
    database_url: postgresStatus.databaseUrl,
    message: `Starting ai-memory MCP server (${postgresStatus.databaseUrl}, mode=${startupMode})`,
    require_postgres: envConfig.requirePostgresOnStartup,
    server_version: postgresStatus.serverVersion,
    startup_mode: startupMode,
  });

  if (postgresStatus.ok) {
    startupInitialization = initializeDatabase()
      .then(() => {
        const capabilities = getCapabilities();
        logAiMemoryInfo('mcp.db_capabilities', {
          has_embedding_column: capabilities.hasEmbeddingColumn,
          has_trigram: capabilities.hasTrigram,
          has_vector: capabilities.hasVector,
          message: `Database capabilities detected (vector=${String(capabilities.hasVector)}, embedding_column=${String(capabilities.hasEmbeddingColumn)}, trigram=${String(capabilities.hasTrigram)})`,
        });
      })
      .catch((error: unknown) => {
        const message = formatError(error);
        startupMode = 'degraded';
        logAiMemoryError('mcp.database_init_failed', {
          database_url: postgresStatus.databaseUrl,
          error: message,
          hint: formatPostgresRecoveryHint(postgresStatus.databaseUrl),
          message: `ai-memory database initialization failed: ${message}`,
        });
        if (envConfig.requirePostgresOnStartup) {
          throw error;
        }
      });
  } else {
    startupInitialization = Promise.resolve();
  }

  const transportMode = envConfig.transportMode;

  if (transportMode === 'http') {
    const httpPort = envConfig.httpPort;
    const httpHost = envConfig.httpHost;
    const httpTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    activeHttpServer = createServer((req, res) => {
      const url = req.url ?? '/';
      if (url === '/mcp' || url.startsWith('/mcp?') || url.startsWith('/mcp/')) {
        void httpTransport.handleRequest(req, res).catch((error: unknown) => {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: 'Internal server error processing MCP request.',
              }),
            );
          }
          logAiMemoryError('mcp.http_transport_error', {
            error: formatError(error),
            message: `Failed to handle MCP request on ${url}`,
            transport: 'http',
          });
        });
      } else if (url === '/' || url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            name: 'ai-memory',
            status: 'ok',
            transport: 'http',
          }),
        );
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found. MCP endpoint is at /mcp' }));
      }
    });

    activeHttpServer.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        logAiMemoryError('mcp.http_port_in_use', {
          host: httpHost,
          message: `Port ${String(httpPort)} already in use. Stop the existing server or set AI_MEMORY_MCP_HTTP_PORT to a different port.`,
          port: httpPort,
        });
        process.exit(1);
      }
      throw error;
    });

    activeHttpServer.listen(httpPort, httpHost, () => {
      logAiMemoryInfo('mcp.http_listening', {
        host: httpHost,
        message: `ai-memory MCP HTTP server listening on ${httpHost}:${String(httpPort)}`,
        port: httpPort,
      });
    });

    // SDK type incompatibility: StreamableHTTPServerTransport defines onclose as
    // (() => void) | undefined, but Transport requires optional-without-undefined
    // under our exactOptionalPropertyTypes tsconfig
    await server.connect(httpTransport as Transport);
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }

  await startupInitialization;

  logAiMemoryInfo('mcp.connected', {
    database_url: getDatabaseUrlForDisplay(),
    message: `ai-memory MCP connected (${getDatabaseUrlForDisplay()}, transport=${transportMode}, mode=${startupMode})`,
    startup_mode: startupMode,
    transport: transportMode,
  });
}

let activeHttpServer: HttpServer | undefined;
let shuttingDown = false;

export function summarizeToolPayload(response: ToolResult, toolName: ToolName): SummaryMap {
  const first = response.content[0];
  if (first === undefined || typeof first.text !== 'string') {
    return {};
  }

  try {
    const payloadRecord = asRecord(JSON.parse(first.text) as unknown);
    if (payloadRecord === undefined) {
      return {};
    }

    const summary: SummaryMap = {};
    if (toolName === 'memory_search') {
      summary.search_response_bytes = Buffer.byteLength(JSON.stringify(response), 'utf8');
      if (payloadRecord.memoryDetail === 'compact' || payloadRecord.memoryDetail === 'full') {
        summary.search_detail = payloadRecord.memoryDetail;
      }
      for (const [payloadKey, summaryKey] of [
        ['requestedCount', 'search_requested_count'],
        ['count', 'search_returned_count'],
        ['candidateCount', 'search_candidate_count'],
        ['budgetBytes', 'search_budget_bytes'],
      ]) {
        if (payloadKey !== undefined && summaryKey !== undefined) {
          appendNumericSummaryValue({ payloadKey, payloadRecord, summary, summaryKey });
        }
      }
      summary.search_truncated = payloadRecord.truncated === true ? 1 : 0;
      summary.search_budget_exceeded = payloadRecord.budgetExceeded === true ? 1 : 0;
    }
    appendTrimmedSummaryValue({
      payloadKey: 'status',
      payloadRecord,
      summary,
      summaryKey: 'response_status',
    });

    const resultCount = resolveResultCount(payloadRecord);
    if (resultCount !== undefined) {
      summary.result_count = resultCount;
    }

    appendNumericSummaryValue({
      payloadKey: 'eventsIngested',
      payloadRecord,
      summary,
      summaryKey: 'events_ingested',
    });
    appendNumericSummaryValue({
      payloadKey: 'durableMemoriesStored',
      payloadRecord,
      summary,
      summaryKey: 'durable_memories_stored',
    });
    appendNumericSummaryValue({
      payloadKey: 'durableMemoriesDeduped',
      payloadRecord,
      summary,
      summaryKey: 'durable_memories_deduped',
    });
    appendTrimmedSummaryValue({
      payloadKey: 'sessionId',
      payloadRecord,
      summary,
      summaryKey: 'session_id',
    });
    appendTrimmedSummaryValue({
      payloadKey: 'resolvedVia',
      payloadRecord,
      summary,
      summaryKey: 'resolved_via',
    });
    appendContinuityPackPayloadSummary({ payloadRecord, summary, toolName });
    appendOrientPayloadSummary({ payloadRecord, summary, toolName });

    const warningSummary = summarizeWarnings(payloadRecord.warnings);
    if (warningSummary !== undefined) {
      summary.warning_count = warningSummary.warningCount;
      summary.timeout_warning_count = warningSummary.timeoutWarningCount;
      if (warningSummary.timedOutSteps.length > 0) {
        summary.timed_out_steps = warningSummary.timedOutSteps.join(',');
      }
    }

    const writeDisposition = resolveWriteDisposition(payloadRecord);
    if (writeDisposition !== undefined) {
      summary.write_disposition = writeDisposition;
    }

    return summary;
  } catch (error) {
    const warningMessage = `Failed to summarize tool payload for ${toolName}; continuing without payload summary metrics.`;
    recordAiMemoryWarningDetail({
      code: 'mcp.tool_payload_summary_failed',
      message: warningMessage,
    });
    logAiMemoryWarn('mcp.tool_payload_summary_failed', {
      error: formatError(error),
      message: warningMessage,
      tool_name: toolName,
    });
    return {};
  }
}

if (isMainModule()) {
  initializeAiMemoryRuntimeEnv();

  const subcommand = process.argv[2];

  if (subcommand === 'audit:codex') {
    void import('./ingestion/codex-usage-audit.js').then(({ runCodexUsageAuditCli }) => {
      runCodexUsageAuditCli(process.argv[3]);
    });
  } else if (subcommand === 'hook:session-start') {
    void (async () => {
      const { runSessionStartHook, serializeSessionStartHook } = await import('./ingestion/session-start-hook.js');
      let input = '';
      for await (const chunk of process.stdin) {
        input += String(chunk);
      }
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(input) as Record<string, unknown>;
      } catch {
        /* empty payload is fine */
      }
      const outcome = await runSessionStartHook(undefined, buildSessionStartHookContextFromPayload(payload));
      process.stdout.write(`${serializeSessionStartHook(outcome)}\n`);
      process.exit(0);
    })();
  } else if (subcommand === 'hook:session-end') {
    void (async () => {
      const { runSessionEndHook } = await import('./ingestion/session-end-hook.js');
      let input = '';
      for await (const chunk of process.stdin) {
        input += String(chunk);
      }
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(input) as Record<string, unknown>;
      } catch {
        /* empty payload is fine */
      }
      await runSessionEndHook({ payload });
      process.exit(0);
    })();
  } else if (subcommand === 'diagnose-env') {
    process.stdout.write(`${JSON.stringify(getAiMemoryRuntimeDiagnostics(), null, 2)}\n`);
    process.exit(0);
  } else if (subcommand === '--help' || subcommand === '-h') {
    writeCliUsage(process.stdout);
    process.exit(0);
  } else if (subcommand !== undefined) {
    process.stderr.write(`Unknown subcommand: ${subcommand}\n`);
    writeCliUsage(process.stderr);
    process.exit(1);
  } else {
    // Default: start MCP server (existing behavior)
    process.on('SIGINT', () => {
      void shutdown('SIGINT');
    });

    process.on('SIGTERM', () => {
      void shutdown('SIGTERM');
    });

    main().catch(async (error: unknown) => {
      const message = formatError(error);
      logAiMemoryError('mcp.startup_failed', {
        message: `ai-memory MCP startup failed: ${message}`,
      });
      await Promise.allSettled([closePool()]);
      process.exit(1);
    });
  }
}

export interface SessionStartHookSubcommandContext {
  cwd: string;
  hookEventName?: string | undefined;
  repoId?: string | undefined;
  sessionId?: string | undefined;
}

export function buildSessionStartHookContextFromPayload(
  payload: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
): SessionStartHookSubcommandContext {
  const context: SessionStartHookSubcommandContext = {
    cwd: firstDefinedText(payload.cwd, env.CLAUDE_PROJECT_DIR, env.PWD) ?? process.cwd(),
  };

  const hookEventName = firstDefinedText(
    payload.hook_event_name,
    payload.hookEventName,
    payload.event_name,
    payload.eventName,
  );
  if (hookEventName !== undefined) {
    context.hookEventName = hookEventName;
  }

  const repoId = firstDefinedText(payload.repo_id, payload.repoId, payload.repository);
  if (repoId !== undefined) {
    context.repoId = repoId;
  }

  const sessionId = firstDefinedText(payload.session_id, payload.sessionId, payload.agent_id, payload.agentId);
  if (sessionId !== undefined) {
    context.sessionId = sessionId;
  }

  return context;
}

export function resolveToolInvocationColumnMetadata(
  summary: Record<string, number | string>,
): Pick<ToolInvocationInput, 'project' | 'sessionId'> {
  const metadata: Pick<ToolInvocationInput, 'project' | 'sessionId'> = {};
  const sessionId = readSummaryText(summary, 'session_id');
  const project = readSummaryText(summary, 'project');
  if (sessionId !== undefined) {
    metadata.sessionId = sessionId;
  }
  if (project !== undefined) {
    metadata.project = project;
  }
  return metadata;
}

export function resolveToolInvocationResponseStatus(summary: Record<string, number | string>): string | undefined {
  const value = summary.response_status;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function appendContinuityPackPayloadSummary(input: {
  payloadRecord: Record<string, unknown>;
  summary: SummaryMap;
  toolName: ToolName;
}) {
  if (input.toolName !== 'memory_continuity_pack' && input.toolName !== 'memory_continuity_debug') {
    return;
  }

  appendTrimmedSummaryValue({
    payloadKey: 'status',
    payloadRecord: input.payloadRecord,
    summary: input.summary,
    summaryKey: 'continuity_pack_status',
  });

  const pack =
    input.toolName === 'memory_continuity_debug'
      ? asRecord(input.payloadRecord.budget)
      : asRecord(input.payloadRecord.pack);
  if (pack === undefined) {
    return;
  }
  appendNumericSummaryValue({
    payloadKey: 'payloadChars',
    payloadRecord: pack,
    summary: input.summary,
    summaryKey: 'continuity_pack_payload_chars',
  });
  appendNumericSummaryValue({
    payloadKey: 'budgetChars',
    payloadRecord: pack,
    summary: input.summary,
    summaryKey: 'continuity_pack_budget_chars',
  });
}

function appendNumericSummaryValue(input: {
  payloadKey: string;
  payloadRecord: Record<string, unknown>;
  summary: SummaryMap;
  summaryKey: string;
}) {
  const value = input.payloadRecord[input.payloadKey];
  if (typeof value === 'number' && Number.isFinite(value)) {
    input.summary[input.summaryKey] = value;
  }
}

function appendOrientPayloadSummary(input: {
  payloadRecord: Record<string, unknown>;
  summary: SummaryMap;
  toolName: ToolName;
}) {
  if (input.toolName !== 'memory_orient') {
    return;
  }

  const orientation = asRecord(input.payloadRecord.orientation);
  if (orientation === undefined) {
    return;
  }

  appendTrimmedSummaryValue({
    payloadKey: 'environmentStatus',
    payloadRecord: orientation,
    summary: input.summary,
    summaryKey: 'environment_status',
  });

  appendNumericSummaryValue({
    payloadKey: 'memoryPayloadChars',
    payloadRecord: orientation,
    summary: input.summary,
    summaryKey: 'orient_payload_chars',
  });
  appendNumericSummaryValue({
    payloadKey: 'memoryPayloadApproxTokens',
    payloadRecord: orientation,
    summary: input.summary,
    summaryKey: 'orient_payload_tokens_estimate',
  });
  appendNumericSummaryValue({
    payloadKey: 'memoryPayloadBudgetChars',
    payloadRecord: orientation,
    summary: input.summary,
    summaryKey: 'orient_payload_budget_chars',
  });

  if (orientation.memoryPayloadBudgetExceeded === true) {
    input.summary.orient_payload_budget_exceeded = 1;
  } else if (orientation.memoryPayloadBudgetExceeded === false) {
    input.summary.orient_payload_budget_exceeded = 0;
  }
}

function appendTrimmedSummaryValue(input: {
  payloadKey: string;
  payloadRecord: Record<string, unknown>;
  summary: SummaryMap;
  summaryKey: string;
}) {
  const value = extractTrimmedString(input.payloadRecord, input.payloadKey);
  if (value !== undefined) {
    input.summary[input.summaryKey] = value;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) {
    return value;
  }
  return undefined;
}

function extractTrimmedString(record: Record<string, unknown>, key: string): string | undefined {
  return readOptionalText(record[key]);
}

function firstDefinedText(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    const normalized = readOptionalText(value);
    if (normalized !== undefined) {
      return normalized;
    }
  }
  return undefined;
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) return false;
  if (import.meta.url === pathToFileURL(entrypoint).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entrypoint)).href;
  } catch {
    return false;
  }
}

function normalizePostgresStatus(value: unknown): PostgresStatus {
  const status = asRecord(value);
  if (status === undefined) {
    throw new Error('Invalid ensurePostgresRunning response.');
  }

  return {
    databaseName: typeof status.databaseName === 'string' ? status.databaseName : undefined,
    databaseUrl: typeof status.databaseUrl === 'string' ? status.databaseUrl : '<unknown>',
    errorMessage: typeof status.errorMessage === 'string' ? status.errorMessage : undefined,
    hint: typeof status.hint === 'string' ? status.hint : undefined,
    ok: status.ok === true,
    serverVersion: typeof status.serverVersion === 'string' ? status.serverVersion : undefined,
  };
}

function readSummaryText(summary: Record<string, number | string>, key: string): string | undefined {
  const value = summary[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function resolveResultCount(payloadRecord: Record<string, unknown>): number | undefined {
  const directCount = payloadRecord.count;
  if (typeof directCount === 'number' && Number.isFinite(directCount)) {
    return directCount;
  }

  const candidateArrays = [payloadRecord.memories, payloadRecord.failures, payloadRecord.events];
  for (const candidate of candidateArrays) {
    if (Array.isArray(candidate)) {
      return candidate.length;
    }
  }

  return undefined;
}

function resolveWriteDisposition(payloadRecord: Record<string, unknown>): string | undefined {
  const memoryRecord = asRecord(payloadRecord.memory);
  if (memoryRecord === undefined) {
    return undefined;
  }
  const writeDisposition = memoryRecord.writeDisposition;
  if (typeof writeDisposition !== 'string') {
    return undefined;
  }
  const trimmedDisposition = writeDisposition.trim();
  return trimmedDisposition.length > 0 ? trimmedDisposition : undefined;
}

async function runTool(params: ToolInvocationParams): Promise<ToolResult> {
  const startedAt = Date.now();
  const invocationId = randomUUID();
  const warningCollector = createAiMemoryWarningCollector();

  return await runWithAiMemoryWarningCollector(warningCollector, async () => {
    try {
      await startupInitialization;
      const handlerResponse = await params.handler();
      // Append collector warnings BEFORE summarization so embedding/DB-layer
      // timeout warnings recorded via the AsyncLocalStorage channel are
      // visible in the response payload's `warnings`/`warningDetails` fields
      // — which is the source of truth for `summarizeToolPayload`'s
      // `timed_out_steps`/`timeout_warning_count`/`warning_count` summary
      // values. Recording these on `ai_tool_invocations.summary_json` is the
      // only way the health report can attribute timeouts by phase.
      const augmentedResponse = appendAiMemoryWarningsToTextResult(
        handlerResponse,
        listAiMemoryWarningDetails(warningCollector),
      );
      const response =
        params.toolName === 'memory_search'
          ? finalizeSearchResponse(augmentedResponse, params.args)
          : augmentedResponse;
      const durationMs = Date.now() - startedAt;
      const payloadSummary = summarizeToolPayload(response, params.toolName);
      const requestSummary = summarizeToolArgs(params.args);
      const toolCategory: ToolCategory = TOOL_CATEGORY_BY_NAME[params.toolName];
      const combinedSummary = { ...requestSummary, ...payloadSummary };
      const columnMetadata = resolveToolInvocationColumnMetadata(combinedSummary);

      logAiMemoryInfo('mcp.tool_invocation', {
        ...combinedSummary,
        duration_ms: durationMs,
        invocation_id: invocationId,
        message: `${params.toolName} succeeded in ${String(durationMs)}ms`,
        status: 'ok',
        tool_category: toolCategory,
        tool_name: params.toolName,
      });

      const invocationInput: ToolInvocationInput = {
        ...columnMetadata,
        durationMs,
        invocationId,
        responseStatus: resolveToolInvocationResponseStatus(combinedSummary),
        status: 'ok',
        summaryFields: combinedSummary,
        timeoutWarningCount:
          typeof combinedSummary.timeout_warning_count === 'number' ? combinedSummary.timeout_warning_count : 0,
        toolCategory,
        toolName: params.toolName,
        warningCount: typeof combinedSummary.warning_count === 'number' ? combinedSummary.warning_count : 0,
      };
      void recordToolInvocation(invocationInput).catch(() => {});

      if (params.toolName === 'memory_orient' && combinedSummary.orient_payload_budget_exceeded === 1) {
        logAiMemoryWarn('mcp.orient_payload_budget_exceeded', {
          message:
            `memory_orient payload exceeded budget: ` +
            `${String(combinedSummary.orient_payload_chars ?? 0)} chars ` +
            `(budget=${String(combinedSummary.orient_payload_budget_chars ?? 0)} chars)`,
          orient_payload_budget_chars: combinedSummary.orient_payload_budget_chars,
          orient_payload_chars: combinedSummary.orient_payload_chars,
          orient_payload_tokens_estimate: combinedSummary.orient_payload_tokens_estimate,
          tool_name: params.toolName,
        });
      }

      return response;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const toolCategory: ToolCategory = TOOL_CATEGORY_BY_NAME[params.toolName];
      const message = formatError(error);
      const requestSummary = summarizeToolArgs(params.args);
      const columnMetadata = resolveToolInvocationColumnMetadata(requestSummary);

      logAiMemoryWarn('mcp.tool_invocation', {
        ...requestSummary,
        duration_ms: durationMs,
        error: message,
        invocation_id: invocationId,
        message: `${params.toolName} failed in ${String(durationMs)}ms: ${message}`,
        status: 'error',
        tool_category: toolCategory,
        tool_name: params.toolName,
      });

      await recordIngestionFailure({
        details: {
          duration_ms: durationMs,
          invocation_id: invocationId,
          ...requestSummary,
        },
        errorMessage: message,
        source: 'mcp-tool',
        stage: params.toolName,
      }).catch((recordError: unknown) => {
        const warningMessage = `Failed to record ai_ingestion_failures row for ${params.toolName}; returning tool error without queryable failure audit.`;
        recordAiMemoryWarningDetail({
          code: 'mcp.tool_failure_audit_record_failed',
          message: warningMessage,
        });
        logAiMemoryWarn('mcp.tool_failure_audit_record_failed', {
          duration_ms: durationMs,
          error: formatError(recordError),
          invocation_id: invocationId,
          message: warningMessage,
          tool_name: params.toolName,
        });
      });

      const errorResponse = appendAiMemoryWarningsToTextResult(
        params.toolName === 'memory_search'
          ? { ...toTextResult({ status: 'error' }), isError: true as const }
          : toErrorResult(error, params.toolName),
        listAiMemoryWarningDetails(warningCollector),
      );
      const response =
        params.toolName === 'memory_search' ? finalizeSearchResponse(errorResponse, params.args) : errorResponse;
      const summaryFields =
        params.toolName === 'memory_search'
          ? { ...requestSummary, ...summarizeToolPayload(response, params.toolName) }
          : requestSummary;
      void recordToolInvocation({
        ...columnMetadata,
        durationMs,
        invocationId,
        status: 'error',
        summaryFields,
        timeoutWarningCount:
          typeof summaryFields.timeout_warning_count === 'number' ? summaryFields.timeout_warning_count : 0,
        toolCategory,
        toolName: params.toolName,
        warningCount: typeof summaryFields.warning_count === 'number' ? summaryFields.warning_count : 0,
      }).catch(() => {});

      return response;
    }
  });
}

async function shutdown(signal: 'SIGINT' | 'SIGTERM') {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  logAiMemoryInfo('mcp.shutdown', {
    message: `ai-memory MCP received ${signal}; closing resources`,
    signal,
  });

  const httpServer = activeHttpServer;
  const closeHttpServer = httpServer
    ? new Promise<void>(resolve => {
        httpServer.close(() => {
          resolve();
        });
      })
    : Promise.resolve();
  await Promise.allSettled([server.close(), closeHttpServer, closePool()]);
  process.exit(0);
}

function summarizeWarnings(value: unknown):
  | undefined
  | {
      timedOutSteps: string[];
      timeoutWarningCount: number;
      warningCount: number;
    } {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const warningMessages = value.flatMap(warning =>
    typeof warning === 'string' && warning.trim().length > 0 ? [warning.trim()] : [],
  );
  if (warningMessages.length === 0) {
    return undefined;
  }

  return {
    timedOutSteps: extractTimedOutSteps(warningMessages),
    timeoutWarningCount: warningMessages.filter(warning => hasTimeoutWarning(warning)).length,
    warningCount: warningMessages.length,
  };
}

function toErrorResult(error: unknown, toolName: ToolName): ToolErrorResult {
  const message = formatError(error);
  return {
    content: [
      {
        text: `${toolName} failed: ${message}`,
        type: 'text',
      },
    ],
    isError: true,
  };
}

// UTF-8 bytes of JSON.stringify(CallToolResult), including escaped text and warnings.
// Transport JSON-RPC ids/framing are outside this tool-owned result contract.
export const SEARCH_RESPONSE_BUDGET_BYTES = 16_384;

export function finalizeSearchResponse(response: ToolResult, args: unknown): ToolResult {
  const parsed = memorySearchInputSchema.safeParse(args);
  const memoryDetail = parsed.success ? (parsed.data.memoryDetail ?? 'compact') : 'compact';
  const fullContentTopN = parsed.success ? (parsed.data.fullContentTopN ?? 0) : 0;
  let original: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(response.content[0]?.text ?? '{}');
    if (isRecord(value)) original = value;
  } catch {
    // Error text can contain credentials or an unbounded validation diagnostic.
  }
  const candidates = response.isError === true || !Array.isArray(original.memories) ? [] : original.memories;
  const warnings = Array.isArray(original.warnings) ? original.warnings : [];
  const warningDetails = Array.isArray(original.warningDetails) ? original.warningDetails : [];
  const boundedWarnings = warnings
    .filter((value): value is string => typeof value === 'string')
    .slice(0, 4)
    .map(value => value.slice(0, 240));
  const boundedDetails = warningDetails
    .filter(isRecord)
    .slice(0, 4)
    .map(value => ({
      code: typeof value.code === 'string' ? value.code.slice(0, 120) : 'memory_search.warning',
      message: typeof value.message === 'string' ? value.message.slice(0, 240) : '',
    }));
  const warningsTruncated =
    JSON.stringify(warnings) !== JSON.stringify(boundedWarnings) ||
    JSON.stringify(warningDetails) !== JSON.stringify(boundedDetails);
  let status = warnings.length > 0 || warningDetails.length > 0 ? 'degraded' : 'ok';
  if (original.status === 'partial' || original.status === 'degraded') status = original.status;
  if (response.isError === true) status = 'error';
  const payload = {
    budgetBytes: SEARCH_RESPONSE_BUDGET_BYTES,
    budgetExceeded: false,
    candidateCount: candidates.length,
    count: 0,
    memoryDetail,
    ...(response.isError === true ? { error: 'memory_search_failed' } : {}),
    memories: [] as Record<string, unknown>[],
    requestedCount: parsed.success ? (parsed.data.limit ?? 8) : 0,
    status,
    truncated: warningsTruncated,
    warningsTruncated,
    ...(boundedWarnings.length > 0 ? { warnings: boundedWarnings } : {}),
    ...(boundedDetails.length > 0 ? { warningDetails: boundedDetails } : {}),
  };
  const serialize = (): ToolResult => ({
    ...toTextResult(payload),
    ...(response.isError === true ? { isError: true as const } : {}),
  });
  const responseBytes = () => Buffer.byteLength(JSON.stringify(serialize()), 'utf8');
  // Reserve room for the top identity even when escaped warnings fill the envelope.
  while (
    responseBytes() > SEARCH_RESPONSE_BUDGET_BYTES - 1024 &&
    (boundedDetails.length > 0 || boundedWarnings.length > 0)
  ) {
    if (boundedDetails.length > 0) boundedDetails.pop();
    else boundedWarnings.pop();
    payload.warningsTruncated = true;
    payload.truncated = true;
    payload.budgetExceeded = true;
  }
  const fits = () => responseBytes() <= SEARCH_RESPONSE_BUDGET_BYTES;
  for (const [index, candidate] of candidates.entries()) {
    const wantsFull = memoryDetail === 'full' || index < fullContentTopN;
    const [projected] = formatMemoryPayload({
      boundPreview: true,
      fullContentTopN: 0,
      memories: [candidate],
      memoryDetail: 'compact',
      query: parsed.success ? parsed.data.query : undefined,
    });
    const preview = isRecord(projected) ? projected : {};
    const [expanded] = formatMemoryPayload({
      boundPreview: true,
      fullContentTopN: wantsFull ? 1 : 0,
      memories: [candidate],
      memoryDetail,
    });
    let selected: Record<string, unknown> =
      wantsFull && isRecord(expanded) ? { ...expanded, detail: 'full' } : { ...preview, detail: 'compact' };
    if (selected.previewTruncated === true) payload.truncated = true;
    payload.memories.push(selected);
    payload.count = payload.memories.length;
    if (!fits()) {
      payload.budgetExceeded = true;
      payload.truncated = true;
      selected = { ...preview, detail: 'compact', ...(wantsFull ? { fullContentOmitted: true } : {}) };
      payload.memories[payload.memories.length - 1] = selected;
      if (!fits()) {
        // Keep a recoverable first identity even if every preview field is large.
        if (index === 0) {
          payload.memories[0] = {
            detail: 'compact',
            id: preview.id,
            previewTruncated: true,
            ...(wantsFull ? { fullContentOmitted: true } : {}),
          };
        } else {
          payload.memories.pop();
          payload.count = payload.memories.length;
        }
        break;
      }
    }
  }
  return serialize();
}

function toTextResult(payload: unknown): ToolTextResult {
  return {
    content: [
      {
        text: JSON.stringify(payload, null, 2),
        type: 'text',
      },
    ],
  };
}

function writeCliUsage(stream: NodeJS.WritableStream): void {
  stream.write(
    'Usage: ai-memory-mcp [audit:codex <manifest.json> | hook:session-start | hook:session-end | diagnose-env]\n',
  );
  stream.write('  (no args)           Start MCP server (default)\n');
  stream.write('  diagnose-env        Print sanitized runtime credential diagnostics as JSON\n');
  stream.write('  hook:session-start  Run session-start recall, output JSON\n');
  stream.write('  hook:session-end    Run session-end ingestion (reads stdin)\n');
}
