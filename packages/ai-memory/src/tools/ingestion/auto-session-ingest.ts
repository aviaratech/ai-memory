import {
  buildModelAttributionExtensions,
  type ModelAttributionExtensions,
  type ModelResolutionStatus,
  normalizeModelResolutionStatus,
} from './model-attribution.js';
import {
  closePool,
  CONTINUITY_FIELD_PROVENANCE_VALUES,
  type ContinuityFieldProvenance,
  formatError,
  ingestMemoryDelta,
  logAiMemoryWarn,
  normalizeRelatedLinkUrl,
  pool,
  readOptionalText,
  recordIngestionFailure,
  STATE_MODEL_PROVENANCE_VALUES,
  type StateModelProvenance,
  truncateText,
} from '@aviaratech/ai-memory/internal';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import {
  appendAiMemoryWarningsToPayload,
  createAiMemoryWarningCollector,
  recordAiMemoryWarningDetail,
  runWithAiMemoryWarningCollector,
} from '../warning-channel.js';

const execFileAsync = promisify(execFile);

const CLAUDE_REQUEST_MARKER = '## My request for Codex:';
const CLAUDE_REQUEST_MARKER_ALT = '## My request for Claude:';
const MAX_MESSAGE_CHARS = 900;
const MAX_MEMORY_CONTENT_CHARS = 700;
const MAX_SUMMARY_DURABLE_CONTENT_CHARS = 1200;
const MAX_AUTO_HISTORY_TURNS = 24;
const MAX_HISTORY_TURN_CONTENT_CHARS = 420;
const MAX_FAILURE_DETAIL_CHARS = 600;
const AUTO_INGEST_ID_VERSION = 'v1';
const AUTO_DURABLE_PROMOTION_ENV = 'AI_MEMORY_AUTO_DURABLE_PROMOTION';
const SESSION_SUMMARY_TTL_ENV = 'AI_MEMORY_RETENTION_SESSION_SUMMARY_DAYS';
const DEFAULT_SESSION_SUMMARY_TTL_DAYS = 14;
const GROK_EXPORT_TIMEOUT_MS = 10_000;
const GROK_EXPORT_MAX_BUFFER_BYTES = 1_000_000;

export interface AutoMemoryDeltaInput {
  agent?: unknown;
  assistantMessage?: unknown;
  autoDurablePromotionEnabled?: unknown;
  contextNeeded?: unknown;
  contextNeededProvenance?: unknown;
  /**
   * Default provenance for continuity list fields when callers supply
   * `nextActions`, `contextNeeded`, or `openQuestions` directly.
   * Missing fields may be derived from explicit handoff sections in the
   * assistant message and are tagged `derived` automatically.
   */
  continuityFieldProvenance?: unknown;
  createdAt?: unknown;
  cwd?: unknown;
  dedupeNamespace?: unknown;
  envModel?: unknown;
  eventReason?: unknown;
  evidenceRefs?: unknown;
  /** Bounded, source-normalized excerpts retained for cross-harness search. */
  history?: unknown;
  model?: unknown;
  modelResolutionError?: unknown;
  modelResolutionStatus?: unknown;
  nextActions?: unknown;
  nextActionsProvenance?: unknown;
  openQuestions?: unknown;
  openQuestionsProvenance?: unknown;
  repoId?: unknown;
  requestedModel?: unknown;
  resolvedModel?: unknown;
  sessionFilePath?: unknown;
  sessionId?: unknown;
  sessionSummary?: unknown;
  sessionSummaryTtlDays?: unknown;
  source?: unknown;
  stateModel?: unknown;
  /**
   * Provenance marker for `x_state_model`. Auto-ingest never fabricates a state model;
   * when set, this marks how the field arrived: `carry-forward` from a prior explicit
   * snapshot for the same session, or `agent-authored` when the caller supplied it
   * directly. Omitted when no `stateModel` is present.
   */
  stateModelProvenance?: unknown;
  toolCallCount?: unknown;
  transcriptPath?: unknown;
  userMessage?: unknown;
}

export interface AutoSessionHistoryEntry {
  content: string;
  model?: string | undefined;
  role: SummaryRole;
  timestamp?: string | undefined;
  turnId: string;
}

export interface AutoSessionIngestResult {
  continuityWarnings: string[];
  deltaId?: string;
  durableMemoriesStored: number;
  eventsIngested: number;
  sessionId?: string;
  warningDetails?: unknown;
  warnings?: string[];
}

export interface GrokExportCommand {
  args: string[];
  command: string;
  options: GrokExportCommandOptions;
}
export interface GrokExportCommandOptions {
  maxBuffer?: number | undefined;
  timeout?: number | undefined;
}

export type GrokExportCommandRunner = (input: GrokExportCommand) => Promise<{ stdout: string }>;

export interface ParsedGrokSessionExport {
  history: AutoSessionHistoryEntry[];
  lastAssistantMessage: string | undefined;
  lastUserMessage: string | undefined;
  toolCallCount: number;
}

interface ArtifactMarkdownInput {
  agent: string;
  assistantMessage: string | undefined;
  contextNeeded: string[];
  cwd: string | undefined;
  eventReason: string | undefined;
  inputEvidenceRefs: string[];
  model: string | undefined;
  modelResolutionError: string | undefined;
  modelResolutionStatus: ModelResolutionStatus | undefined;
  nextActions: string[];
  openQuestions: string[];
  repoId: string | undefined;
  requestedModel: string | undefined;
  resolvedModel: string | undefined;
  sessionFilePath: string | undefined;
  sessionId: string;
  sessionSummary: string | undefined;
  source: string;
  toolCallCount: number;
  transcriptPath: string | undefined;
  userMessage: string | undefined;
}
interface AutoIngestHashInput {
  agent: string;
  assistantMessage: string | undefined;
  cwd: string | undefined;
  dedupeNamespace: string;
  history: AutoSessionHistoryEntry[];
  model: string | undefined;
  modelResolutionStatus: ModelResolutionStatus | undefined;
  repoId: string | undefined;
  requestedModel: string | undefined;
  resolvedModel: string | undefined;
  sessionId: string;
  toolCallCount: number;
  userMessage: string | undefined;
}

interface AutoMemoryDelta {
  append_events: { summary: string; ts: string; type: string }[];
  artifacts: { content_markdown: string; kind: string; title: string }[];
  created_at: string;
  delta_id: string;
  produced_by: ModelAttributionExtensions & {
    agent: string;
    model?: string;
  };
  schema_version: string;
  session_id: string;
  snapshot: {
    mode: string;
    value: {
      anchors: {
        focus_paths: string[];
        related_links: { label: string; url: string }[];
      };
      context_needed: string[];
      created_at: string;
      goal: string;
      next_actions: string[];
      open_questions: string[];
      plan: { done: boolean; id: string; text: string }[];
      progress: {
        blockers: string[];
        completed: string[];
        in_flight: string[];
      };
      snapshot_id: string;
      x_context_needed_provenance?: ContinuityFieldProvenance;
      x_env_model?: Record<string, unknown>;
      x_next_actions_provenance?: ContinuityFieldProvenance;
      x_open_questions_provenance?: ContinuityFieldProvenance;
      x_state_model?: Record<string, unknown>;
      x_state_model_provenance?: StateModelProvenance;
    };
  };
  tenancy: {
    repo_id?: string;
  };
  workflow: {
    entity_id: string;
    entity_type: string;
    entity_url?: string;
    system: string;
    title: string;
  };
  x_durable_memories?: DurableMemoryProposal[];
}

interface CaptureMessageContentInput {
  content: unknown[];
  entryIndex: number;
  model?: string | undefined;
  role: SummaryRole;
  summary: ParsedClaudeSummary;
  timestamp: string | undefined;
}

type ContinuityLookupFn = (sessionId: string) => Promise<ContinuityLookupResult>;

interface ContinuityLookupResult {
  contextNeeded?: string[];
  nextActions: string[];
  openQuestions: string[];
  stateModel?: Record<string, unknown>;
}

interface DurableMemoryProposal {
  category: string;
  confidence: number;
  content: string;
  evidence_refs: { path?: string; type: string; url?: string }[];
  memory_key: string;
  project: string | undefined;
  sensitivity: string;
  source: string;
  source_model?: null | string;
  source_timestamp?: string | undefined;
  status: string;
  tags: string[];
  ttl_days: number;
}

interface FindLatestCodexSessionFileInput {
  root?: unknown;
  sinceEpochSeconds?: unknown;
}

interface IngestAutoSessionDeltaOptions {
  ingestMemoryDelta?: IngestMemoryDeltaFn;
  lookupContinuity?: ContinuityLookupFn;
}

type IngestMemoryDeltaFn = (input: { memoryDelta: AutoMemoryDelta }) => Promise<unknown>;

interface IngestMemoryDeltaResult {
  deltaId?: unknown;
  durableMemoriesStored?: unknown;
  eventsIngested?: unknown;
  sessionId?: unknown;
}

interface JsonlFileInfo {
  mtimeMs: number;
  path: string;
}
type JsonlRecord = Record<string, unknown>;

interface ParsedClaudeSummary {
  assistantMessageCount: number;
  history: AutoSessionHistoryEntry[];
  lastAssistantMessage: string | undefined;
  lastUserMessage: string | undefined;
  lineCount: number;
  sessionSummary: string | undefined;
  toolCallCount: number;
  userMessageCount: number;
}

interface ParsedCodexSummary {
  agentMessageCount: number;
  createdAt: string | undefined;
  cwd: string | undefined;
  history: AutoSessionHistoryEntry[];
  lastAssistantMessage: string | undefined;
  lastUserMessage: string | undefined;
  model: string | undefined;
  modelResolutionError: string | undefined;
  modelResolutionStatus: ModelResolutionStatus | undefined;
  repoId: string | undefined;
  requestedModel: string | undefined;
  resolvedModel: string | undefined;
  sessionId: string | undefined;
  toolCallCount: number;
  userMessageCount: number;
}

interface RecordAutoIngestionFailureInput {
  agent?: unknown;
  details?: unknown;
  error?: unknown;
  repoId?: unknown;
  sessionId?: unknown;
  source?: unknown;
  stage?: unknown;
}

type SummaryRole = 'assistant' | 'user';

const CREDENTIAL_LABEL_PATTERN =
  /\b(?:api[ _-]?key|api[ _-]?secret|client[ _-]?key|client[ _-]?secret|token|secret|password|passwd|authorization)\b/gi;
const CREDENTIAL_SEPARATOR_PATTERN = /^["']?(?:\s*[:=]\s*|\s+(?:is\s+)?)/i;
const CREDENTIAL_VALUE_PATTERN = /^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"']+)/u;

const REDACTION_RULES = [
  {
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi,
    replacement: '[REDACTED_PRIVATE_KEY]',
  },
  {
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: '[REDACTED_AWS_ACCESS_KEY]',
  },
  {
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    replacement: '[REDACTED_GITHUB_TOKEN]',
  },
  {
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replacement: '[REDACTED_CHAT_TOKEN]',
  },
  {
    pattern: /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g,
    replacement: '[REDACTED_API_TOKEN]',
  },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: '[REDACTED_JWT]',
  },
  {
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: '[REDACTED_SSN]',
  },
  {
    pattern: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: '[REDACTED_EMAIL]',
  },
  {
    pattern: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    replacement: '[REDACTED_PHONE]',
  },
];

export function buildAutoMemoryDelta(input: AutoMemoryDeltaInput): AutoMemoryDelta {
  const createdAt = normalizeIso(input.createdAt) ?? new Date().toISOString();
  const sessionId = normalizeRequiredText(input.sessionId, 'sessionId');
  const agent = normalizeRequiredText(input.agent, 'agent');
  const source = normalizeRequiredText(input.source, 'source');
  const dedupeNamespace = readOptionalText(input.dedupeNamespace) ?? source;

  const cwd = sanitizePath(readOptionalText(input.cwd));
  const repoId = readOptionalText(input.repoId);
  const requestedModel = sanitizeMemoryText(readOptionalText(input.requestedModel));
  const resolvedModel =
    sanitizeMemoryText(readOptionalText(input.resolvedModel)) ?? sanitizeMemoryText(readOptionalText(input.model));
  const model = resolvedModel ?? sanitizeMemoryText(readOptionalText(input.model));
  const modelResolutionStatus =
    normalizeModelResolutionStatus(input.modelResolutionStatus) ??
    (requestedModel !== undefined && model !== undefined ? 'resolved' : undefined);
  const modelResolutionError = sanitizeMemoryText(readOptionalText(input.modelResolutionError));
  const userMessage = sanitizeMemoryText(readOptionalText(input.userMessage));
  const assistantMessage = sanitizeMemoryText(readOptionalText(input.assistantMessage));
  const history = normalizeAutoSessionHistory(input.history);
  const transcriptPath = sanitizePath(readOptionalText(input.transcriptPath));
  const sessionFilePath = sanitizePath(readOptionalText(input.sessionFilePath));
  const eventReason = sanitizeMemoryText(readOptionalText(input.eventReason));
  const toolCallCount = normalizeOptionalInteger(input.toolCallCount) ?? 0;

  const sessionSummary = sanitizeMemoryText(readOptionalText(input.sessionSummary));

  const inputNextActions = normalizeOptionalTextArray(input.nextActions);
  const inputContextNeeded = normalizeOptionalTextArray(input.contextNeeded);
  const inputOpenQuestions = normalizeOptionalTextArray(input.openQuestions);
  const extractedContinuity =
    assistantMessage !== undefined &&
    (inputNextActions.length === 0 || inputContextNeeded.length === 0 || inputOpenQuestions.length === 0)
      ? extractContinuityFromText(assistantMessage)
      : { contextNeeded: [], nextActions: [], openQuestions: [] };
  const extractedContextNeeded = extractedContinuity.contextNeeded ?? [];
  const nextActionsDerived = inputNextActions.length === 0 && extractedContinuity.nextActions.length > 0;
  const contextNeededDerived = inputContextNeeded.length === 0 && extractedContextNeeded.length > 0;
  const openQuestionsDerived = inputOpenQuestions.length === 0 && extractedContinuity.openQuestions.length > 0;
  const nextActions = inputNextActions.length > 0 ? inputNextActions : extractedContinuity.nextActions;
  const contextNeeded = inputContextNeeded.length > 0 ? inputContextNeeded : extractedContextNeeded;
  const openQuestions = inputOpenQuestions.length > 0 ? inputOpenQuestions : extractedContinuity.openQuestions;
  const defaultContinuityFieldProvenance = normalizeContinuityFieldProvenance(input.continuityFieldProvenance);
  const nextActionsProvenance =
    normalizeContinuityFieldProvenance(input.nextActionsProvenance) ??
    (nextActionsDerived ? ('derived' satisfies ContinuityFieldProvenance) : defaultContinuityFieldProvenance);
  const contextNeededProvenance =
    normalizeContinuityFieldProvenance(input.contextNeededProvenance) ??
    (contextNeededDerived ? ('derived' satisfies ContinuityFieldProvenance) : defaultContinuityFieldProvenance);
  const openQuestionsProvenance =
    normalizeContinuityFieldProvenance(input.openQuestionsProvenance) ??
    (openQuestionsDerived ? ('derived' satisfies ContinuityFieldProvenance) : defaultContinuityFieldProvenance);
  const inputEvidenceRefs = normalizeOptionalTextArray(input.evidenceRefs);
  const envModel = isObjectRecord(input.envModel) ? input.envModel : undefined;
  const stateModel = isObjectRecord(input.stateModel) ? input.stateModel : undefined;
  const stateModelProvenance =
    stateModel === undefined ? undefined : normalizeStateModelProvenance(input.stateModelProvenance);

  let goal: string;
  if (sessionSummary !== undefined) {
    goal = truncateText(sessionSummary, 180);
  } else if (userMessage !== undefined && userMessage.length > 0) {
    goal = `Address user request: ${truncateText(userMessage, 180)}`;
  } else {
    goal = `Capture ${agent} session summary for shared memory.`;
  }

  const completionLine = `Captured ${agent} session summary via ${source}.`;

  const artifactMarkdown = buildArtifactMarkdown({
    agent,
    assistantMessage,
    contextNeeded,
    cwd,
    eventReason,
    inputEvidenceRefs,
    model,
    modelResolutionError,
    modelResolutionStatus,
    nextActions,
    openQuestions,
    repoId,
    requestedModel,
    resolvedModel: resolvedModel ?? model,
    sessionFilePath,
    sessionId,
    sessionSummary,
    source,
    toolCallCount,
    transcriptPath,
    userMessage,
  });

  const appendEvents = [
    {
      summary: `${agent} auto-session ingestion completed.`,
      ts: createdAt,
      type: 'checkpoint',
    },
  ];

  if (toolCallCount > 0) {
    appendEvents.push({
      summary: `Observed ${String(toolCallCount)} tool calls before session end.`,
      ts: createdAt,
      type: 'note_added',
    });
  }

  const deltaHash = createAutoIngestHash({
    agent,
    assistantMessage,
    cwd,
    dedupeNamespace,
    history,
    model,
    modelResolutionStatus,
    repoId,
    requestedModel,
    resolvedModel: resolvedModel ?? model,
    sessionId,
    toolCallCount,
    userMessage,
  });
  const snapshotId = `${dedupeNamespace}-snapshot-${sessionId}-${deltaHash.slice(0, 12)}`;
  const deltaId = `${dedupeNamespace}-delta-${sessionId}-${deltaHash.slice(0, 16)}`;
  const includeDurableMemory = resolveAutoDurablePromotionEnabled(input.autoDurablePromotionEnabled);

  const relatedLinks: { label: string; url: string }[] = [];
  if (transcriptPath !== undefined) {
    relatedLinks.push({
      label: 'transcript',
      url: normalizeRelatedLinkUrl(transcriptPath),
    });
  }
  if (sessionFilePath !== undefined) {
    relatedLinks.push({
      label: 'session_file',
      url: normalizeRelatedLinkUrl(sessionFilePath),
    });
  }
  for (const ref of inputEvidenceRefs) {
    relatedLinks.push({ label: 'evidence', url: normalizeRelatedLinkUrl(ref) });
  }

  const memoryDelta: AutoMemoryDelta = {
    append_events: appendEvents,
    artifacts: [
      {
        content_markdown: artifactMarkdown,
        kind: 'summary',
        title: `${agent} session summary`,
      },
    ],
    created_at: createdAt,
    delta_id: deltaId,
    produced_by: {
      agent,
      ...(model !== undefined ? { model } : {}),
      ...buildModelAttributionExtensions({
        ...(requestedModel !== undefined ? { requestedModel } : {}),
        ...(resolvedModel !== undefined ? { resolvedModel } : {}),
        ...(modelResolutionStatus !== undefined ? { modelResolutionStatus } : {}),
        ...(modelResolutionError !== undefined ? { modelResolutionError } : {}),
      }),
    },
    schema_version: 'memory_delta@0.1',
    session_id: sessionId,
    snapshot: {
      mode: 'replace',
      value: {
        anchors: {
          focus_paths: cwd !== undefined ? [cwd] : [],
          related_links: relatedLinks,
        },
        context_needed: contextNeeded,
        created_at: createdAt,
        goal,
        next_actions: nextActions,
        open_questions: openQuestions,
        plan: [
          {
            done: true,
            id: 'auto-capture-summary',
            text: completionLine,
          },
        ],
        progress: {
          blockers: [],
          completed: [completionLine],
          in_flight: [],
        },
        snapshot_id: snapshotId,
        ...(nextActions.length > 0 && nextActionsProvenance !== undefined
          ? { x_next_actions_provenance: nextActionsProvenance }
          : {}),
        ...(contextNeeded.length > 0 && contextNeededProvenance !== undefined
          ? { x_context_needed_provenance: contextNeededProvenance }
          : {}),
        ...(openQuestions.length > 0 && openQuestionsProvenance !== undefined
          ? { x_open_questions_provenance: openQuestionsProvenance }
          : {}),
        ...(envModel !== undefined ? { x_env_model: envModel } : {}),
        // Auto-channel snapshots may only carry an `x_state_model` paired with a valid
        // `x_state_model_provenance` value. If a caller supplies a stateModel without a
        // documented provenance, both are dropped so an automatic snapshot never emits
        // an unprovenanced state model that downstream readers could misinterpret as a
        // fresh agent-authored confidence signal.
        ...(stateModel !== undefined && stateModelProvenance !== undefined
          ? { x_state_model: stateModel, x_state_model_provenance: stateModelProvenance }
          : {}),
      },
    },
    tenancy: {
      ...(repoId !== undefined ? { repo_id: repoId } : {}),
    },
    workflow: {
      entity_id: sessionId,
      entity_type: 'agent_session',
      ...(repoId !== undefined ? { entity_url: `repo://${repoId}` } : {}),
      system: source,
      title: `${agent} session`,
    },
  };

  if (includeDurableMemory) {
    const sessionSummaryTtlDays = resolveSessionSummaryTtlDays(input.sessionSummaryTtlDays);
    const hasSessionSummary = sessionSummary !== undefined;
    const durableContentLimit = hasSessionSummary ? MAX_SUMMARY_DURABLE_CONTENT_CHARS : MAX_MEMORY_CONTENT_CHARS;
    const summarySeed = truncateText(
      sessionSummary ?? assistantMessage ?? userMessage ?? completionLine,
      durableContentLimit,
    );
    const repoMarker = repoId !== undefined ? ` [${repoId}]` : '';
    const memoryHeading = `${agent} session summary (${sessionId})${repoMarker}`;
    const memoryContent = truncateText(`${memoryHeading}: ${summarySeed}`, durableContentLimit);
    const evidenceRefs = buildAutoDurableEvidenceRefs({
      inputEvidenceRefs,
      sessionFilePath,
      transcriptPath,
    });
    const tags = ['auto', source, agent, 'session-summary'];
    if (repoId !== undefined) {
      tags.push(repoId.replaceAll('/', '-').toLowerCase());
    }

    memoryDelta.x_durable_memories = [
      {
        category: 'session-summary',
        confidence: hasSessionSummary ? 0.45 : 0.35,
        content: memoryContent,
        evidence_refs: evidenceRefs,
        memory_key: `${dedupeNamespace}:${sessionId}:summary:v1`,
        project: repoId,
        sensitivity: 'internal',
        source,
        status: 'active',
        tags,
        ttl_days: sessionSummaryTtlDays,
      },
      ...history.map(turn =>
        buildHistoryDurableMemory({
          agent,
          dedupeNamespace,
          evidenceRefs,
          project: repoId,
          sessionId,
          source,
          ttlDays: sessionSummaryTtlDays,
          turn,
        }),
      ),
    ];
  }

  return memoryDelta;
}

export async function closeAiMemoryPool() {
  await closePool();
}

export function findLatestCodexSessionFile(input: FindLatestCodexSessionFileInput = {}) {
  const root = readOptionalText(input.root) ?? join(homedir(), '.codex', 'sessions');
  const sinceEpochSeconds = normalizeOptionalInteger(input.sinceEpochSeconds);
  const sinceEpochMs = sinceEpochSeconds !== undefined ? sinceEpochSeconds * 1000 : undefined;

  if (!existsSync(root)) {
    return undefined;
  }

  const files: JsonlFileInfo[] = [];
  collectJsonlFiles(root, files);

  if (files.length === 0) {
    return undefined;
  }

  const filtered =
    sinceEpochMs === undefined
      ? files
      : files.filter(file => file.mtimeMs >= sinceEpochMs - 5_000 || file.mtimeMs >= sinceEpochMs - 60_000);

  const candidates = filtered.length > 0 ? filtered : files;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  return candidates[0]?.path;
}

export async function ingestAutoSessionDelta(
  input: AutoMemoryDeltaInput,
  options: IngestAutoSessionDeltaOptions = {},
): Promise<AutoSessionIngestResult> {
  const warningCollector = createAiMemoryWarningCollector();
  const result = await runWithAiMemoryWarningCollector(warningCollector, async () => {
    const sessionId = readOptionalText(input.sessionId);

    // Overwrite guardrail: explicit flush continuity always wins over hook-derived fallback.
    // When a lookupContinuity function is provided, check for existing snapshot values
    // and prefer them over any hook-extracted fallback values. Auto-ingest never
    // fabricates `x_state_model`; the only way it appears on an auto snapshot is via
    // deterministic carry-forward from a prior snapshot for the same session, which
    // is marked with `x_state_model_provenance: 'carry-forward'`.
    let mergedInput = input;
    if (sessionId !== undefined && options.lookupContinuity !== undefined) {
      const existing = await options.lookupContinuity(sessionId);
      const existingContextNeeded = existing.contextNeeded ?? [];
      const inputNextActions = normalizeOptionalTextArray(input.nextActions);
      const inputContextNeeded = normalizeOptionalTextArray(input.contextNeeded);
      const inputOpenQuestions = normalizeOptionalTextArray(input.openQuestions);
      const guardrailNextActions = existing.nextActions.length > 0 ? existing.nextActions : inputNextActions;
      const guardrailContextNeeded = existingContextNeeded.length > 0 ? existingContextNeeded : inputContextNeeded;
      const guardrailOpenQuestions = existing.openQuestions.length > 0 ? existing.openQuestions : inputOpenQuestions;
      const carriedStateModel =
        existing.stateModel !== undefined && !isObjectRecord(input.stateModel) ? existing.stateModel : undefined;
      const guardrailStateModel = carriedStateModel ?? input.stateModel;
      const guardrailProvenance =
        carriedStateModel !== undefined ? ('carry-forward' satisfies StateModelProvenance) : input.stateModelProvenance;
      const guardrailNextActionsProvenance =
        existing.nextActions.length > 0
          ? ('carry-forward' satisfies ContinuityFieldProvenance)
          : (input.nextActionsProvenance ?? input.continuityFieldProvenance);
      const guardrailContextNeededProvenance =
        existingContextNeeded.length > 0
          ? ('carry-forward' satisfies ContinuityFieldProvenance)
          : (input.contextNeededProvenance ?? input.continuityFieldProvenance);
      const guardrailOpenQuestionsProvenance =
        existing.openQuestions.length > 0
          ? ('carry-forward' satisfies ContinuityFieldProvenance)
          : (input.openQuestionsProvenance ?? input.continuityFieldProvenance);
      if (
        guardrailNextActions !== inputNextActions ||
        guardrailContextNeeded !== inputContextNeeded ||
        guardrailOpenQuestions !== inputOpenQuestions ||
        guardrailStateModel !== input.stateModel ||
        guardrailProvenance !== input.stateModelProvenance ||
        guardrailNextActionsProvenance !== input.nextActionsProvenance ||
        guardrailContextNeededProvenance !== input.contextNeededProvenance ||
        guardrailOpenQuestionsProvenance !== input.openQuestionsProvenance
      ) {
        mergedInput = {
          ...input,
          contextNeeded: guardrailContextNeeded,
          contextNeededProvenance: guardrailContextNeededProvenance,
          nextActions: guardrailNextActions,
          nextActionsProvenance: guardrailNextActionsProvenance,
          openQuestions: guardrailOpenQuestions,
          openQuestionsProvenance: guardrailOpenQuestionsProvenance,
          stateModel: guardrailStateModel,
          stateModelProvenance: guardrailProvenance,
        };
      }
    }

    const memoryDelta = buildAutoMemoryDelta(mergedInput);

    const continuityWarnings = buildAutoIngestContinuityWarnings(memoryDelta);
    if (continuityWarnings.length > 0) {
      const guidance =
        'To improve continuity, call memory_flush with nextActions, openQuestions, stateModel, and envModel before session end.';
      logAiMemoryWarn('ingest.auto_session.continuity_quality', {
        guidance,
        message: `Session-end continuity fields incomplete: ${continuityWarnings.join('; ')}. ${guidance}`,
        sessionId: sessionId ?? 'unknown',
        warnings: continuityWarnings,
      });
    }

    try {
      const ingestMemoryDeltaFn = options.ingestMemoryDelta ?? ingestMemoryDelta;
      const ingestResult = (await ingestMemoryDeltaFn({
        memoryDelta,
      })) as IngestMemoryDeltaResult;

      return {
        continuityWarnings,
        deltaId: readOptionalText(ingestResult.deltaId),
        durableMemoriesStored: normalizeOptionalInteger(ingestResult.durableMemoriesStored) ?? 0,
        eventsIngested: normalizeOptionalInteger(ingestResult.eventsIngested) ?? 0,
        sessionId: readOptionalText(ingestResult.sessionId),
      };
    } catch (error) {
      await recordAutoIngestionFailure({
        agent: readOptionalText(input.agent),
        details: {
          created_at: memoryDelta.created_at,
          delta_id: memoryDelta.delta_id,
          source: readOptionalText(input.source),
        },
        error,
        repoId: readOptionalText(input.repoId),
        sessionId: readOptionalText(input.sessionId),
        source: readOptionalText(input.source) ?? 'auto-session-ingest',
        stage: 'ingest_memory_delta',
      });

      throw error;
    }
  });

  return appendAiMemoryWarningsToPayload(result, warningCollector.warningDetails) as AutoSessionIngestResult;
}

// Safety cap on the explicit-flush scan. Explicit flushes per session are rare in
// practice (typically 1–5), so this cap is structural overhead rather than an
// observed-data limit. The join already excludes auto-source snapshots, so the cap
// does not affect carry-forward when many auto snapshots are newer than the latest
// explicit flush.
export const EXPLICIT_FLUSH_LOOKUP_LIMIT = 50;

/** SQL the lookup issues against the DB; exported for test parity assertions. */
export const EXPLICIT_FLUSH_LOOKUP_SQL = `SELECT s.snapshot_json
       FROM ai_session_snapshots s
       JOIN ai_memory_deltas d ON d.delta_id = s.source_delta_id
       WHERE s.session_id = $1
         AND COALESCE(d.raw_json->'workflow'->>'system', '') IN ('memory-flush', 'manual', 'manual-flush')
       ORDER BY s.created_at DESC, s.id DESC
       LIMIT $2`;

type SnapshotQueryFn = (sql: string, params: [string, number]) => Promise<{ rows: SnapshotQueryRow[] }>;
interface SnapshotQueryRow {
  snapshot_json: unknown;
}

export async function loadGrokSessionExport(
  input: { command?: string | undefined; sessionId: string },
  runner: GrokExportCommandRunner = async ({ args, command, options }) => {
    const result = await execFileAsync(command, args, {
      encoding: 'utf8',
      maxBuffer: options.maxBuffer,
      timeout: options.timeout,
    });
    return { stdout: result.stdout };
  },
): Promise<ParsedGrokSessionExport> {
  const command = readOptionalText(input.command) ?? readOptionalText(process.env.GROK_CLI_COMMAND) ?? 'grok';
  const parsed = parseGrokSessionExport(
    (
      await runner({
        args: ['--no-auto-update', 'export', input.sessionId],
        command,
        options: {
          maxBuffer: GROK_EXPORT_MAX_BUFFER_BYTES,
          timeout: GROK_EXPORT_TIMEOUT_MS,
        },
      })
    ).stdout,
  );
  if (parsed.history.length === 0) {
    throw new Error('Grok export did not contain supported conversation sections.');
  }
  return parsed;
}

/**
 * Carry-forward only reads from explicit-flush source snapshots for this session.
 * The join filters out auto-source snapshots (codex-*, claude-session-end, etc.) so
 * that newer auto snapshots cannot push an older explicit flush past a scan window:
 * the lookup walks explicit flushes only, newest-first, picking the first non-empty
 * value per field.
 *
 * `queryFn` is overridable for tests; production callers omit it and the default
 * pool-backed query runs.
 */
export async function lookupSessionContinuityFromPool(
  sessionId: string,
  queryFn?: SnapshotQueryFn,
): Promise<ContinuityLookupResult> {
  const runQuery: SnapshotQueryFn =
    queryFn ?? ((sql, params) => pool.query<SnapshotQueryRow>(sql, params).then(result => ({ rows: result.rows })));

  try {
    const result = await runQuery(EXPLICIT_FLUSH_LOOKUP_SQL, [sessionId, EXPLICIT_FLUSH_LOOKUP_LIMIT]);

    let contextNeeded: string[] = [];
    let nextActions: string[] = [];
    let openQuestions: string[] = [];
    let stateModel: Record<string, unknown> | undefined;

    for (const row of result.rows) {
      if (!isObjectRecord(row.snapshot_json)) {
        continue;
      }
      if (nextActions.length === 0) {
        const candidate = normalizeOptionalTextArray(row.snapshot_json.next_actions);
        if (candidate.length > 0) {
          nextActions = candidate;
        }
      }
      if (contextNeeded.length === 0) {
        const candidate = normalizeOptionalTextArray(row.snapshot_json.context_needed);
        if (candidate.length > 0) {
          contextNeeded = candidate;
        }
      }
      if (openQuestions.length === 0) {
        const candidate = normalizeOptionalTextArray(row.snapshot_json.open_questions);
        if (candidate.length > 0) {
          openQuestions = candidate;
        }
      }
      if (stateModel === undefined && isObjectRecord(row.snapshot_json.x_state_model)) {
        stateModel = row.snapshot_json.x_state_model;
      }
      if (contextNeeded.length > 0 && nextActions.length > 0 && openQuestions.length > 0 && stateModel !== undefined) {
        break;
      }
    }

    return {
      contextNeeded,
      nextActions,
      openQuestions,
      ...(stateModel !== undefined ? { stateModel } : {}),
    };
  } catch (error) {
    const warningMessage = `Failed to look up stored continuity for session ${sessionId}; continuing with empty nextActions/openQuestions.`;
    recordAiMemoryWarningDetail({
      code: 'ingest.lookup_continuity_failed',
      message: warningMessage,
    });
    logAiMemoryWarn('ingest.lookup_continuity_failed', {
      error: formatError(error),
      message: warningMessage,
      sessionId,
    });
    return { contextNeeded: [], nextActions: [], openQuestions: [] };
  }
}

export function parseClaudeTranscriptSummary(transcriptPath: string | undefined): ParsedClaudeSummary {
  const summary = createClaudeSummary();

  if (transcriptPath === undefined || !existsSync(transcriptPath)) {
    return summary;
  }

  const lines = parseJsonlLines(transcriptPath);
  summary.lineCount = lines.length;

  for (const [index, entry] of lines.entries()) {
    applyClaudeEntryToSummary({ entry, entryIndex: index, summary });
  }

  return summary;
}

export function parseCodexSessionSummary(sessionFile: string | undefined): ParsedCodexSummary {
  const summary = createCodexSummary(sessionFile);
  const sessionFileLabel = sessionFile ?? '<unknown>';

  if (sessionFile === undefined || !existsSync(sessionFile)) {
    throw new Error(`Codex session file not found: ${sessionFileLabel}`);
  }

  const lines = parseJsonlLines(sessionFile);
  let sourceModel: string | undefined;

  for (const [index, entry] of lines.entries()) {
    sourceModel = applyCodexEntryToSummary({ entry, entryIndex: index, sourceModel, summary });
  }

  if (summary.resolvedModel === undefined && summary.model !== undefined) {
    summary.resolvedModel = summary.model;
  }
  if (summary.model === undefined && summary.resolvedModel !== undefined) {
    summary.model = summary.resolvedModel;
  }
  if (summary.modelResolutionStatus === undefined) {
    if (summary.requestedModel !== undefined && summary.resolvedModel !== undefined) {
      summary.modelResolutionStatus = 'resolved';
    } else if (summary.requestedModel !== undefined) {
      summary.modelResolutionStatus = 'failed';
    }
  }

  if (summary.sessionId === undefined) {
    throw new Error(`Unable to resolve session id from ${sessionFileLabel}`);
  }

  return summary;
}

/**
 * Parse the stable conversation sections emitted by `grok export <session-id>`.
 * The exporter deliberately omits raw ACP timestamps, so callers preserve the
 * SessionEnd event timestamp on the enclosing memory delta instead of inventing
 * per-turn timestamps.
 */
export function parseGrokSessionExport(markdown: string): ParsedGrokSessionExport {
  const summary: ParsedGrokSessionExport = {
    history: [],
    lastAssistantMessage: undefined,
    lastUserMessage: undefined,
    toolCallCount: 0,
  };
  let activeRole: SummaryRole | undefined;
  let contentLines: string[] = [];
  let assistantTurnCount = 0;
  let userTurnCount = 0;

  const flushActiveTurn = () => {
    if (activeRole === undefined) {
      return;
    }
    const content = normalizeConversationText(contentLines.join('\n'), { role: activeRole });
    contentLines = [];
    if (content === undefined) {
      return;
    }
    const turnNumber = activeRole === 'assistant' ? ++assistantTurnCount : ++userTurnCount;
    const turn: AutoSessionHistoryEntry = {
      content,
      role: activeRole,
      turnId: `grok-${activeRole}-${String(turnNumber)}`,
    };
    summary.history.push(turn);
    if (activeRole === 'assistant') {
      summary.lastAssistantMessage = content;
    } else {
      summary.lastUserMessage = content;
    }
  };

  for (const line of markdown.split(/\r?\n/u)) {
    if (line === '## User') {
      flushActiveTurn();
      activeRole = 'user';
      continue;
    }
    if (line === '## Assistant') {
      flushActiveTurn();
      activeRole = 'assistant';
      continue;
    }
    if (line === '## Tools') {
      flushActiveTurn();
      activeRole = undefined;
      continue;
    }
    if (activeRole !== undefined) {
      contentLines.push(line);
    } else if (line.startsWith('- ')) {
      summary.toolCallCount += 1;
    }
  }
  flushActiveTurn();

  return {
    ...summary,
    history: summary.history.slice(-MAX_AUTO_HISTORY_TURNS),
  };
}

export async function recordAutoIngestionFailure(input: RecordAutoIngestionFailureInput = {}) {
  const source = readOptionalText(input.source) ?? 'auto-session-ingest';
  const stage = readOptionalText(input.stage) ?? 'unknown';
  const sessionId = readOptionalText(input.sessionId);
  const agent = readOptionalText(input.agent);
  const repoId = readOptionalText(input.repoId);
  const error = input.error;
  const details = sanitizeFailureDetails(input.details);

  try {
    await recordIngestionFailure({
      agent,
      details,
      error,
      repoId,
      sessionId,
      source,
      stage,
    });
  } catch (recordError) {
    const message = recordError instanceof Error ? recordError.message : String(recordError);
    const warningMessage = `Failed to write ingestion failure audit (${source}/${stage}); continuing without durable failure audit row.`;
    recordAiMemoryWarningDetail({
      code: 'ingest.failure_audit_write_failed',
      message: warningMessage,
    });
    logAiMemoryWarn('ingest.failure_audit_write_failed', {
      error: message,
      message: warningMessage,
      source,
      stage,
    });
  }
}

export async function resolveRepoIdFromCwd(cwd: unknown) {
  const normalizedCwd = readOptionalText(cwd);
  if (normalizedCwd === undefined) {
    return undefined;
  }

  try {
    const { stdout } = await execFileAsync('git', ['-C', normalizedCwd, 'config', '--get', 'remote.origin.url']);
    return parseRepositoryUrlToRepoId(stdout);
  } catch (error) {
    const warningMessage = `Failed to resolve repo id from cwd via git remote lookup; continuing without repoId enrichment.`;
    recordAiMemoryWarningDetail({
      code: 'ingest.repo_id_resolution_failed',
      message: warningMessage,
    });
    logAiMemoryWarn('ingest.repo_id_resolution_failed', {
      cwd: normalizedCwd,
      error: formatError(error),
      message: warningMessage,
    });
    return undefined;
  }
}

const NEXT_ACTIONS_HEADING = /^#{1,3}\s+(next actions?|next steps?|action items?|todos?|what.?s next)/i;
const CONTEXT_NEEDED_HEADING = /^#{1,3}\s+(context needed|needed context|operator context|blocked on|waiting on)/i;
const OPEN_QUESTIONS_HEADING = /^#{1,3}\s+(open questions?|questions?|unknowns?|unresolved)/i;
const NEXT_ACTIONS_LABELS = new Set([
  'action item',
  'action items',
  'next action',
  'next actions',
  'next step',
  'next steps',
  'suggested next step',
  'suggested next steps',
  'todo',
  'todos',
  'what s next',
  'whats next',
]);
const CONTEXT_NEEDED_LABELS = new Set([
  'blocked on',
  'context needed',
  'needed context',
  'operator context',
  'waiting on',
]);
const OPEN_QUESTIONS_LABELS = new Set([
  'open question',
  'open questions',
  'question',
  'questions',
  'unknown',
  'unknowns',
  'unresolved',
]);
const BULLET_ITEM = /^([-*•]|\d+[.)])\s+(.+)/;
const MAX_EXTRACTED_ITEMS = 10;

export function buildAutoIngestContinuityWarnings(delta: AutoMemoryDelta): string[] {
  const warnings: string[] = [];
  const snapshot = delta.snapshot.value;
  if (snapshot.next_actions.length === 0) {
    warnings.push('next_actions is empty');
  }
  if (snapshot.open_questions.length === 0) {
    warnings.push('open_questions is empty');
  }
  if (!isObjectRecord(snapshot.x_state_model)) {
    warnings.push('x_state_model is missing');
  }
  if (!isObjectRecord(snapshot.x_env_model)) {
    warnings.push('x_env_model is missing');
  }
  return warnings;
}

/**
 * Deterministically extract next_actions and open_questions from a text block.
 * Scans for markdown headings matching known continuity section names, then collects
 * bullet items beneath them. Same input always yields same output (no heuristics).
 */
export function extractContinuityFromText(text: string): ContinuityLookupResult {
  const contextNeeded: string[] = [];
  const nextActions: string[] = [];
  const openQuestions: string[] = [];

  if (text.length === 0) {
    return { contextNeeded, nextActions, openQuestions };
  }

  let currentSection: 'context_needed' | 'next_actions' | 'open_questions' | null = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();

    if (line.startsWith('#')) {
      if (NEXT_ACTIONS_HEADING.test(line)) {
        currentSection = 'next_actions';
      } else if (CONTEXT_NEEDED_HEADING.test(line)) {
        currentSection = 'context_needed';
      } else if (OPEN_QUESTIONS_HEADING.test(line)) {
        currentSection = 'open_questions';
      } else {
        currentSection = null;
      }
      continue;
    }

    if (matchesContinuityLabel(line, NEXT_ACTIONS_LABELS)) {
      currentSection = 'next_actions';
      continue;
    }
    if (matchesContinuityLabel(line, CONTEXT_NEEDED_LABELS)) {
      currentSection = 'context_needed';
      continue;
    }
    if (matchesContinuityLabel(line, OPEN_QUESTIONS_LABELS)) {
      currentSection = 'open_questions';
      continue;
    }

    if (currentSection !== null) {
      const match = BULLET_ITEM.exec(line);
      if (match !== null) {
        const raw = (match[2] ?? '').trim();
        if (raw.length > 0) {
          const item = sanitizeMemoryText(raw) ?? raw;
          if (currentSection === 'next_actions' && nextActions.length < MAX_EXTRACTED_ITEMS) {
            nextActions.push(item);
          } else if (currentSection === 'context_needed' && contextNeeded.length < MAX_EXTRACTED_ITEMS) {
            contextNeeded.push(item);
          } else if (currentSection === 'open_questions' && openQuestions.length < MAX_EXTRACTED_ITEMS) {
            openQuestions.push(item);
          }
        }
      }
    }
  }

  return { contextNeeded, nextActions, openQuestions };
}

export function parseJsonlLines(
  filePath: string,
  options?: { contents?: string; onMalformedLines?: (count: number) => void },
) {
  const parsed: unknown[] = [];
  let malformedLineCount = 0;
  const lines = (options?.contents ?? readFileSync(filePath, 'utf8')).split('\n').filter(Boolean);

  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      malformedLineCount += 1;
      continue;
    }
  }

  if (options?.onMalformedLines !== undefined) {
    options.onMalformedLines(malformedLineCount);
  } else if (malformedLineCount > 0) {
    const warningMessage = `Skipped ${String(malformedLineCount)} malformed JSONL line(s) while parsing ${basename(filePath)}.`;
    recordAiMemoryWarningDetail({
      code: 'ingest.jsonl_line_parse_failed',
      message: warningMessage,
    });
    logAiMemoryWarn('ingest.jsonl_line_parse_failed', {
      file: basename(filePath),
      malformed_line_count: malformedLineCount,
      message: warningMessage,
    });
  }

  return parsed;
}

function applyClaudeEntryToSummary(input: { entry: unknown; entryIndex: number; summary: ParsedClaudeSummary }) {
  const { entry, entryIndex, summary } = input;
  if (!isObjectRecord(entry)) {
    return;
  }

  const entryType = readOptionalText(entry.type);
  if (entryType === 'summary' && typeof entry.summary === 'string') {
    summary.sessionSummary = toCompactText(entry.summary, MAX_MESSAGE_CHARS);
    return;
  }

  const message = isObjectRecord(entry.message) ? entry.message : undefined;
  if (message === undefined) {
    return;
  }

  const role = readOptionalText(message.role);
  const content = Array.isArray(message.content) ? (message.content as unknown[]) : [];

  if (entryType === 'assistant' && role === 'assistant') {
    summary.assistantMessageCount += 1;
    captureMessageContent({
      content,
      entryIndex,
      model: readOptionalText(message.model),
      role: 'assistant',
      summary,
      timestamp: normalizeIso(entry.timestamp),
    });
    return;
  }

  if (entryType === 'user' && role === 'user') {
    summary.userMessageCount += 1;
    captureMessageContent({
      content,
      entryIndex,
      role: 'user',
      summary,
      timestamp: normalizeIso(entry.timestamp),
    });
  }
}

function applyCodexEntryToSummary(input: {
  entry: unknown;
  entryIndex: number;
  sourceModel: string | undefined;
  summary: ParsedCodexSummary;
}): string | undefined {
  const { entry, entryIndex, summary } = input;
  let sourceModel = input.sourceModel;
  if (!isObjectRecord(entry)) {
    return sourceModel;
  }

  const entryType = readOptionalText(entry.type);
  if (summary.createdAt === undefined && typeof entry.timestamp === 'string') {
    summary.createdAt = normalizeIso(entry.timestamp);
  }

  if (entryType === 'turn_context' && isObjectRecord(entry.payload)) {
    const turnRequestedModel = firstDefinedText(entry.payload.requested_model, entry.payload.requestedModel);
    if (turnRequestedModel !== undefined) {
      summary.requestedModel = turnRequestedModel;
    }

    const turnResolvedModel = firstDefinedText(
      entry.payload.resolved_model,
      entry.payload.resolvedModel,
      entry.payload.model,
    );
    sourceModel = turnResolvedModel;
    if (turnResolvedModel !== undefined) {
      summary.resolvedModel = turnResolvedModel;
      summary.model = turnResolvedModel;
    }

    const turnResolutionStatus = normalizeModelResolutionStatus(
      firstDefinedText(entry.payload.model_resolution_status, entry.payload.modelResolutionStatus),
    );
    if (turnResolutionStatus !== undefined) {
      summary.modelResolutionStatus = turnResolutionStatus;
    }

    const turnResolutionError = firstDefinedText(
      entry.payload.model_resolution_error,
      entry.payload.modelResolutionError,
    );
    if (turnResolutionError !== undefined) {
      summary.modelResolutionError = turnResolutionError;
    }
  }

  if (entryType === 'session_meta') {
    applyCodexSessionMeta(summary, entry.payload);
    return summary.resolvedModel ?? summary.model;
  }

  applyCodexPayload({ entryIndex, model: sourceModel, payload: entry.payload, summary, timestamp: entry.timestamp });
  return sourceModel;
}

function applyCodexPayload(input: {
  entryIndex: number;
  model: string | undefined;
  payload: unknown;
  summary: ParsedCodexSummary;
  timestamp: unknown;
}) {
  const { entryIndex, model, payload, summary, timestamp } = input;
  if (!isObjectRecord(payload)) {
    return;
  }

  if (isCodexToolPayload(payload.type)) {
    summary.toolCallCount += 1;
    return;
  }

  if (payload.type === 'user_message' && typeof payload.message === 'string') {
    summary.userMessageCount += 1;
    const content = normalizeConversationText(payload.message, { role: 'user' });
    if (content !== undefined) {
      summary.lastUserMessage = content;
      summary.history.push({
        content,
        role: 'user',
        ...(normalizeIso(timestamp) !== undefined ? { timestamp: normalizeIso(timestamp) } : {}),
        turnId: `codex-user-${String(entryIndex + 1)}`,
      });
    }
    return;
  }

  if (payload.type === 'agent_message' && typeof payload.message === 'string') {
    summary.agentMessageCount += 1;
    const content = normalizeConversationText(payload.message, { role: 'assistant' });
    if (content !== undefined) {
      summary.lastAssistantMessage = content;
      summary.history.push({
        content,
        ...(model !== undefined ? { model } : {}),
        role: 'assistant',
        ...(normalizeIso(timestamp) !== undefined ? { timestamp: normalizeIso(timestamp) } : {}),
        turnId: `codex-assistant-${String(entryIndex + 1)}`,
      });
    }
    return;
  }

  if (payload.type === 'message' && payload.role === 'assistant' && Array.isArray(payload.content)) {
    for (const [partIndex, part] of payload.content.entries()) {
      if (!isObjectRecord(part) || part.type !== 'output_text' || typeof part.text !== 'string') {
        continue;
      }

      const normalized = normalizeConversationText(part.text, {
        role: 'assistant',
      });
      if (normalized !== undefined) {
        summary.lastAssistantMessage = normalized;
        summary.history.push({
          content: normalized,
          ...(model !== undefined ? { model } : {}),
          role: 'assistant',
          ...(normalizeIso(timestamp) !== undefined ? { timestamp: normalizeIso(timestamp) } : {}),
          turnId: `codex-assistant-${String(entryIndex + 1)}-${String(partIndex + 1)}`,
        });
      }
    }
  }
}

function applyCodexSessionMeta(summary: ParsedCodexSummary, payload: unknown) {
  if (!isObjectRecord(payload)) {
    return;
  }

  const sessionId = readOptionalText(payload.id);
  if (sessionId !== undefined) {
    summary.sessionId = sessionId;
  }

  const cwd = readOptionalText(payload.cwd);
  if (cwd !== undefined) {
    summary.cwd = cwd;
  }

  const requestedModel = firstDefinedText(payload.requested_model, payload.requestedModel);
  if (requestedModel !== undefined) {
    summary.requestedModel = requestedModel;
  }

  const resolvedModel = firstDefinedText(payload.resolved_model, payload.resolvedModel, payload.model);
  if (resolvedModel !== undefined) {
    summary.resolvedModel = resolvedModel;
    summary.model = resolvedModel;
  }

  const modelResolutionStatus = normalizeModelResolutionStatus(
    firstDefinedText(payload.model_resolution_status, payload.modelResolutionStatus),
  );
  if (modelResolutionStatus !== undefined) {
    summary.modelResolutionStatus = modelResolutionStatus;
  }

  const modelResolutionError = firstDefinedText(payload.model_resolution_error, payload.modelResolutionError);
  if (modelResolutionError !== undefined) {
    summary.modelResolutionError = modelResolutionError;
  }

  const gitSection = isObjectRecord(payload.git) ? payload.git : undefined;
  const repositoryUrl = readOptionalText(gitSection?.repository_url);
  if (repositoryUrl !== undefined) {
    summary.repoId = parseRepositoryUrlToRepoId(repositoryUrl);
  }
}

function buildArtifactMarkdown(params: ArtifactMarkdownInput): string {
  const lines: (string | undefined)[] = [
    '## Auto Session Summary',
    `- agent: ${params.agent}`,
    `- source: ${params.source}`,
    `- session_id: ${params.sessionId}`,
    params.requestedModel !== undefined ? `- requested_model: ${params.requestedModel}` : undefined,
    params.resolvedModel !== undefined ? `- resolved_model: ${params.resolvedModel}` : undefined,
    params.modelResolutionStatus !== undefined
      ? `- model_resolution_status: ${params.modelResolutionStatus}`
      : undefined,
    params.modelResolutionError !== undefined ? `- model_resolution_error: ${params.modelResolutionError}` : undefined,
    params.model !== undefined ? `- model: ${params.model}` : undefined,
    params.repoId !== undefined ? `- repo_id: ${params.repoId}` : undefined,
    params.cwd !== undefined ? `- cwd: ${params.cwd}` : undefined,
    params.eventReason !== undefined ? `- event_reason: ${params.eventReason}` : undefined,
    `- tool_calls_seen: ${String(params.toolCallCount)}`,
    '',
    ...(params.sessionSummary !== undefined ? ['## Session Summary', params.sessionSummary, ''] : []),
    '## Last User Message',
    params.userMessage ?? '_none captured_',
    '',
    '## Last Assistant Message',
    params.assistantMessage ?? '_none captured_',
  ];

  for (const [heading, items] of [
    ['## Next Actions', params.nextActions],
    ['## Context Needed', params.contextNeeded],
    ['## Open Questions', params.openQuestions],
  ] as const) {
    if (items.length > 0) {
      lines.push('', heading);
      for (const item of items) {
        lines.push(`- ${item}`);
      }
    }
  }

  lines.push('', '## Evidence');
  if (params.transcriptPath !== undefined) {
    lines.push(`- transcript_path: ${params.transcriptPath}`);
  }
  if (params.sessionFilePath !== undefined) {
    lines.push(`- session_file: ${params.sessionFilePath}`);
  }
  for (const ref of params.inputEvidenceRefs) {
    lines.push(`- evidence_ref: ${ref}`);
  }

  return lines.filter(Boolean).join('\n');
}

function buildAutoDurableEvidenceRefs(input: {
  inputEvidenceRefs: string[];
  sessionFilePath: string | undefined;
  transcriptPath: string | undefined;
}): { path?: string; type: string; url?: string }[] {
  const evidenceRefs: { path?: string; type: string; url?: string }[] = [];
  if (input.transcriptPath !== undefined) {
    evidenceRefs.push({ path: input.transcriptPath, type: 'transcript' });
  }
  if (input.sessionFilePath !== undefined) {
    evidenceRefs.push({ path: input.sessionFilePath, type: 'session_file' });
  }
  for (const ref of input.inputEvidenceRefs) {
    evidenceRefs.push({ type: 'provided', url: normalizeRelatedLinkUrl(ref) });
  }
  return evidenceRefs;
}

function buildHistoryDurableMemory(input: {
  agent: string;
  dedupeNamespace: string;
  evidenceRefs: { path?: string; type: string; url?: string }[];
  project: string | undefined;
  sessionId: string;
  source: string;
  ttlDays: number;
  turn: AutoSessionHistoryEntry;
}): DurableMemoryProposal {
  const repoMarker = input.project !== undefined ? ` [${input.project}]` : '';
  const heading = `${input.agent} ${input.turn.role} turn (${input.sessionId}/${input.turn.turnId})${repoMarker}`;
  const content = truncateText(`${heading}: ${input.turn.content}`, MAX_MEMORY_CONTENT_CHARS);
  const tags = ['auto', 'session-history', input.source, input.agent, input.turn.role, 'session-summary'];
  if (input.project !== undefined) {
    tags.push(input.project.replaceAll('/', '-').toLowerCase());
  }

  return {
    category: 'session-summary',
    confidence: 0.3,
    content,
    evidence_refs: input.evidenceRefs,
    memory_key: `${input.dedupeNamespace}:${input.sessionId}:turn:${input.turn.turnId}:v1`,
    project: input.project,
    sensitivity: 'internal',
    source: input.source,
    source_model: input.turn.model ?? null,
    ...(input.turn.timestamp === undefined ? {} : { source_timestamp: input.turn.timestamp }),
    status: 'active',
    tags,
    ttl_days: input.ttlDays,
  };
}

function captureMessageContent(input: CaptureMessageContentInput) {
  const { content, entryIndex, model, role, summary, timestamp } = input;

  for (const [partIndex, item] of content.entries()) {
    if (!isObjectRecord(item)) {
      continue;
    }

    if (role === 'assistant' && item.type === 'tool_use') {
      summary.toolCallCount += 1;
      continue;
    }

    if (item.type !== 'text' || typeof item.text !== 'string') {
      continue;
    }

    const normalized = normalizeConversationText(item.text, { role });
    if (normalized === undefined) {
      continue;
    }

    if (role === 'assistant') {
      summary.lastAssistantMessage = normalized;
    } else {
      summary.lastUserMessage = normalized;
    }
    summary.history.push({
      content: normalized,
      ...(model !== undefined ? { model } : {}),
      role,
      ...(timestamp !== undefined ? { timestamp } : {}),
      turnId: `claude-${role}-${String(entryIndex + 1)}-${String(partIndex + 1)}`,
    });
  }
}

function collectJsonlFiles(directory: string, output: JsonlFileInfo[]) {
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      collectJsonlFiles(fullPath, output);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
      continue;
    }

    const stats = statSync(fullPath);
    if (stats.size <= 0) {
      continue;
    }

    output.push({
      mtimeMs: stats.mtimeMs,
      path: fullPath,
    });
  }
}

function createAutoIngestHash(input: AutoIngestHashInput) {
  const payload = {
    agent: input.agent,
    assistantMessage: input.assistantMessage ?? '',
    cwd: input.cwd ?? '',
    dedupeNamespace: input.dedupeNamespace,
    history: input.history,
    model: input.model ?? '',
    modelResolutionStatus: input.modelResolutionStatus ?? '',
    repoId: input.repoId ?? '',
    requestedModel: input.requestedModel ?? '',
    resolvedModel: input.resolvedModel ?? '',
    sessionId: input.sessionId,
    toolCallCount: input.toolCallCount,
    userMessage: input.userMessage ?? '',
    version: AUTO_INGEST_ID_VERSION,
  };

  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function createClaudeSummary(): ParsedClaudeSummary {
  return {
    assistantMessageCount: 0,
    history: [],
    lastAssistantMessage: undefined,
    lastUserMessage: undefined,
    lineCount: 0,
    sessionSummary: undefined,
    toolCallCount: 0,
    userMessageCount: 0,
  };
}

function createCodexSummary(sessionFile: string | undefined): ParsedCodexSummary {
  return {
    agentMessageCount: 0,
    createdAt: undefined,
    cwd: undefined,
    history: [],
    lastAssistantMessage: undefined,
    lastUserMessage: undefined,
    model: undefined,
    modelResolutionError: undefined,
    modelResolutionStatus: undefined,
    repoId: undefined,
    requestedModel: undefined,
    resolvedModel: undefined,
    sessionId: extractSessionIdFromFilename(sessionFile),
    toolCallCount: 0,
    userMessageCount: 0,
  };
}

function extractSessionIdFromFilename(filePath: string | undefined) {
  const fileName = basename(filePath ?? '');
  const match =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(fileName) ??
    /[0-9a-f]{8}(?:-[0-9a-f]{4}){4}/i.exec(fileName);

  return match ? match[0] : undefined;
}

function firstDefinedText(...values: unknown[]): string | undefined {
  for (const value of values) {
    const normalized = readOptionalText(value);
    if (normalized !== undefined) {
      return normalized;
    }
  }
  return undefined;
}

function isCodexToolPayload(type: unknown) {
  return type === 'function_call' || type === 'custom_tool_call' || type === 'web_search_call';
}

function isObjectRecord(value: unknown): value is JsonlRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function matchesContinuityLabel(line: string, labels: Set<string>): boolean {
  const normalized = normalizeContinuityLabel(line);
  return normalized !== null && labels.has(normalized);
}

function normalizeAutoSessionHistory(value: unknown): AutoSessionHistoryEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const history: AutoSessionHistoryEntry[] = [];
  for (const [index, candidate] of value.entries()) {
    if (!isObjectRecord(candidate)) {
      continue;
    }
    const role = normalizeSummaryRole(candidate.role);
    if (role === undefined) {
      continue;
    }
    const content = normalizeConversationText(candidate.content, { role });
    if (content === undefined) {
      continue;
    }
    const turnId = readOptionalText(candidate.turnId) ?? `${role}-${String(index + 1)}`;
    const model = readOptionalText(candidate.model);
    const timestamp = normalizeIso(candidate.timestamp);
    history.push({
      content: truncateText(content, MAX_HISTORY_TURN_CONTENT_CHARS),
      ...(model !== undefined ? { model } : {}),
      role,
      ...(timestamp !== undefined ? { timestamp } : {}),
      turnId,
    });
  }

  return history.slice(-MAX_AUTO_HISTORY_TURNS);
}

function normalizeContinuityFieldProvenance(value: unknown): ContinuityFieldProvenance | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  if ((CONTINUITY_FIELD_PROVENANCE_VALUES as readonly string[]).includes(value)) {
    return value as ContinuityFieldProvenance;
  }
  return undefined;
}

function normalizeContinuityLabel(line: string): null | string {
  let label = line.trim();
  if (label.startsWith('**')) {
    label = label.slice(2);
  }
  if (label.endsWith(':**') || label.endsWith('**:')) {
    label = label.slice(0, -3);
  } else if (label.endsWith(':')) {
    label = label.slice(0, -1);
  } else {
    return null;
  }
  return (
    label
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/\s+/g, ' ')
      .trim() || null
  );
}

function normalizeConversationText(text: unknown, input: { role?: SummaryRole } = {}) {
  const role = input.role === 'assistant' ? 'assistant' : 'user';

  let normalized = String(text).trim();
  if (normalized.length === 0) {
    return undefined;
  }

  if (role === 'user') {
    normalized = stripRequestWrapper(normalized);

    if (normalized.startsWith('<permissions instructions>') || normalized.startsWith('<environment_context>')) {
      return undefined;
    }

    if (normalized.startsWith('# AGENTS.md instructions for')) {
      return undefined;
    }
  }

  normalized = redactSensitiveText(normalized);
  normalized = toCompactText(normalized, MAX_MESSAGE_CHARS);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeIso(value: unknown) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    return undefined;
  }

  return parsed.toISOString();
}

function normalizeOptionalInteger(value: unknown) {
  if (value === undefined || value === null) {
    return undefined;
  }

  const numericValue = Number(value);
  if (!Number.isInteger(numericValue) || numericValue < 0) {
    return undefined;
  }

  return numericValue;
}

function normalizeOptionalTextArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const result: string[] = [];
  for (const item of value) {
    const text = readOptionalText(item);
    if (text !== undefined) {
      result.push(sanitizeMemoryText(text) ?? text);
    }
  }

  return result;
}

function normalizeRepoId(rawValue: unknown) {
  const trimmed = readOptionalText(rawValue);
  if (trimmed === undefined) {
    return undefined;
  }

  const withoutLeadingSlash = trimmed.replace(/^\/+/, '');
  const withoutGitSuffix = withoutLeadingSlash.replace(/\.git$/i, '');

  if (!withoutGitSuffix.includes('/')) {
    return undefined;
  }

  return withoutGitSuffix;
}

function normalizeRequiredText(value: unknown, fieldName: string) {
  const normalized = readOptionalText(value);
  if (normalized === undefined) {
    throw new Error(`${fieldName} is required.`);
  }

  return normalized;
}

function normalizeStateModelProvenance(value: unknown): StateModelProvenance | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return (STATE_MODEL_PROVENANCE_VALUES as readonly string[]).includes(value)
    ? (value as StateModelProvenance)
    : undefined;
}

function normalizeSummaryRole(value: unknown): SummaryRole | undefined {
  if (value === 'assistant' || value === 'user') {
    return value;
  }
  return undefined;
}

function parseRepositoryUrlToRepoId(value: unknown) {
  const normalized = readOptionalText(value);
  if (normalized === undefined) {
    return undefined;
  }

  if (normalized.startsWith('git@')) {
    const parts = normalized.split(':');
    if (parts.length < 2) {
      return undefined;
    }

    return normalizeRepoId(parts.slice(1).join(':'));
  }

  if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
    try {
      const parsed = new URL(normalized);
      return normalizeRepoId(parsed.pathname);
    } catch {
      return undefined;
    }
  }

  return normalizeRepoId(normalized);
}

function redactSensitiveText(value: unknown) {
  let redacted = String(value);

  for (const rule of REDACTION_RULES) {
    redacted = redacted.replace(rule.pattern, rule.replacement);
  }

  const parts: string[] = [];
  let cursor = 0;
  for (const label of redacted.matchAll(CREDENTIAL_LABEL_PATTERN)) {
    if (label.index < cursor) {
      continue;
    }
    const labelEnd = label.index + label[0].length;
    const separator = CREDENTIAL_SEPARATOR_PATTERN.exec(redacted.slice(labelEnd));
    if (separator === null) {
      continue;
    }
    const valueStart = labelEnd + separator[0].length;
    const credential = CREDENTIAL_VALUE_PATTERN.exec(redacted.slice(valueStart));
    if (credential === null) {
      continue;
    }
    parts.push(redacted.slice(cursor, valueStart), '[REDACTED_SECRET_VALUE]');
    cursor = valueStart + credential[0].length;
  }
  parts.push(redacted.slice(cursor));
  return parts.join('');
}

function resolveAutoDurablePromotionEnabled(value: unknown) {
  if (typeof value === 'boolean') {
    return value;
  }

  const raw = process.env[AUTO_DURABLE_PROMOTION_ENV];
  if (typeof raw !== 'string') {
    return false;
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) {
    return false;
  }

  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }

  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }

  return false;
}

function resolveSessionSummaryTtlDays(value: unknown) {
  const override = normalizeOptionalInteger(value);
  if (override !== undefined && override > 0) {
    return override;
  }

  const raw = readOptionalText(process.env[SESSION_SUMMARY_TTL_ENV]);
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return DEFAULT_SESSION_SUMMARY_TTL_DAYS;
}

function sanitizeFailureDetails(value: unknown) {
  if (!isObjectRecord(value)) {
    if (value === undefined || value === null) {
      return {};
    }

    return {
      value: truncateText(redactSensitiveText(String(value)), MAX_FAILURE_DETAIL_CHARS),
    };
  }

  const output: Record<string, boolean | number | string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || entry === null) {
      continue;
    }

    if (typeof entry === 'string') {
      output[key] = truncateText(redactSensitiveText(entry), MAX_FAILURE_DETAIL_CHARS);
      continue;
    }

    if (typeof entry === 'number' || typeof entry === 'boolean') {
      output[key] = entry;
      continue;
    }

    output[key] = truncateText(redactSensitiveText(String(entry)), MAX_FAILURE_DETAIL_CHARS);
  }

  return output;
}

function sanitizeMemoryText(value: unknown) {
  const normalized = readOptionalText(value);
  if (normalized === undefined) {
    return undefined;
  }

  const redacted = redactSensitiveText(normalized);
  const compact = toCompactText(redacted, MAX_MESSAGE_CHARS);
  return compact.length > 0 ? compact : undefined;
}

function sanitizePath(value: unknown) {
  const normalized = readOptionalText(value);
  if (normalized === undefined) {
    return undefined;
  }

  const pathRedacted = normalized
    .replace(/\/Users\/[^/\s]+/g, '/Users/[user]')
    .replace(/\/home\/[^/\s]+/g, '/home/[user]')
    .replace(/([A-Za-z]:\\Users\\)[^\\\s]+/g, '$1[user]');

  return redactSensitiveText(pathRedacted);
}

function stripRequestWrapper(text: string) {
  if (text.includes(CLAUDE_REQUEST_MARKER)) {
    return text.split(CLAUDE_REQUEST_MARKER).at(-1)?.trim() ?? text;
  }

  if (text.includes(CLAUDE_REQUEST_MARKER_ALT)) {
    return text.split(CLAUDE_REQUEST_MARKER_ALT).at(-1)?.trim() ?? text;
  }

  return text;
}

function toCompactText(text: unknown, maxChars: number) {
  const collapsed = String(text)
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[\t ]+/g, ' ')
    .trim();

  return truncateText(collapsed, maxChars);
}
