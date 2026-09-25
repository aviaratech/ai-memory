import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import type { MemoryType } from '../db/memory-types.js';

export const STRATEGY_CONFIDENCE_VALUES = ['high', 'medium', 'low'] as const;

/**
 * Provenance for list-shaped continuity fields on a session snapshot.
 *
 * `agent-authored` — supplied directly by an agent, typically through a deliberate
 *   flush or structured caller input.
 * `carry-forward` — copied from a prior explicit snapshot for the same session.
 * `derived` — deterministically extracted from explicit session-end handoff sections
 *   such as "Next steps:" or "Open questions:". Derived items are useful continuity
 *   hints, not fresh agent commitments.
 */
export const CONTINUITY_FIELD_PROVENANCE_VALUES = ['agent-authored', 'carry-forward', 'derived'] as const;

/**
 * Provenance for `x_state_model` on a session snapshot.
 *
 * `agent-authored` — supplied by an agent (typically through `memory_flush`) and reflects
 *   the agent's own assumptions/uncertainty/confidence at the time of the call.
 * `carry-forward` — copied from a prior explicit snapshot for the same session by the
 *   automatic ingestion pipeline. Not agent-authored at the time the snapshot was
 *   written; it must not be treated as a fresh confidence signal.
 *
 * Automatic ingestion never fabricates a state model; if neither value applies, the
 * snapshot omits both `x_state_model` and `x_state_model_provenance`.
 */
export const STATE_MODEL_PROVENANCE_VALUES = ['agent-authored', 'carry-forward'] as const;
export interface AgentStateModel {
  assumptions?: string[];
  confidence_history?: { reason: string; value: StrategyConfidence }[];
  constraints?: string[];
  next_decision?: string;
  strategy_confidence: StrategyConfidence;
  uncertainty?: string[];
  updated_at?: string;
}

export interface AiContextPackV11 {
  budgets_json: Record<string, JsonValue>;
  created_at: string;
  pack_id: string;
  pinned_json: Record<string, JsonValue>;
  produced_by_agent: string;
  produced_by_instance_id?: null | string;
  raw_json: ContextPackV01;
  schema_version: string;
  session_id?: null | string;
  stats_json: Record<string, JsonValue>;
  task_json: Record<string, JsonValue>;
  tenancy_json: Record<string, JsonValue>;
  working_set_json: Record<string, JsonValue>;
}

export interface AiMemoryDeltaV11 {
  append_events_json: JsonValue[];
  artifacts_json: JsonValue[];
  created_at: string;
  delta_id: string;
  produced_by_agent: string;
  produced_by_model?: null | string;
  raw_json: MemoryDeltaV01;
  schema_version: string;
  session_id?: null | string;
  snapshot_json: JsonValue;
  snapshot_mode: SnapshotMode;
  telemetry_json: Record<string, JsonValue>;
  tenancy_json: Record<string, JsonValue>;
}
export interface AiMemoryEntryV11 {
  agent?: null | string;
  category?: null | string;
  confidence: number;
  content: string;
  created_at: string;
  evidence_refs: JsonValue[];
  expires_at?: null | string;
  id: string;
  importance?: null | number;
  memory_key?: null | string;
  memory_type?: MemoryType | null;
  metadata_json: Record<string, JsonValue>;
  model?: null | string;
  org_id?: null | string;
  project?: null | string;
  repo_id?: null | string;
  repo_slug?: null | string;
  sensitivity: Sensitivity;
  session_id?: null | string;
  source: string;
  status: MemoryStatus;
  supersedes_id?: null | string;
  tags: string[];
  thread_id?: null | string;
  tool?: null | string;
  updated_at: string;
  updated_by?: null | string;
  user_id?: null | string;
}

export interface AiMemoryEventV11 {
  actor?: null | string;
  created_at: string;
  event_type: string;
  id: string;
  memory_id: string;
  payload_json: Record<string, JsonValue>;
}

export interface AiSessionEventV11 {
  created_at: string;
  event_id: string;
  event_type: string;
  id: string;
  payload_json: Record<string, JsonValue>;
  session_id: string;
  summary: string;
}

export interface AiSessionSnapshotV11 {
  created_at: string;
  id: string;
  schema_version: string;
  session_id: string;
  snapshot_id: string;
  snapshot_json: Record<string, JsonValue> | SessionSnapshotV01 | SnapshotPatchV01;
  source_delta_id?: null | string;
}

export interface AiSessionV11 {
  agent: string;
  ended_at?: null | string;
  metadata_json: Record<string, JsonValue>;
  model?: null | string;
  org_id?: null | string;
  repo_id?: null | string;
  repo_slug?: null | string;
  session_id: string;
  started_at: string;
  status: SessionStatus;
  task_id?: null | string;
  task_title?: null | string;
  task_type?: null | string;
  tool?: null | string;
  updated_at: string;
  user_id?: null | string;
}

export interface ContextPackV01 extends ExtensionFields {
  budgets?: ExtensionFields & {
    max_chars_pinned?: number;
    max_chars_snapshot?: number;
    max_chars_total?: number;
    max_chars_working_set?: number;
    max_events?: number;
  };
  created_at: string;
  pack_id: string;
  pinned: ExtensionFields & {
    constraints: string[];
    conventions?: string[];
    safety?: string[];
  };
  produced_by: ExtensionFields & {
    agent: string;
    instance_id?: string;
  };
  schema_version: 'context_pack@0.1';
  session: ExtensionFields & {
    recent_events?: SessionEventDigestV01[];
    session_id: string;
    snapshot: SessionSnapshotV01;
  };
  stats?: ExtensionFields & {
    chars_pinned?: number;
    chars_snapshot?: number;
    chars_total?: number;
    chars_working_set?: number;
    events_included?: number;
  };
  task: ExtensionFields & {
    description?: string;
    links?: LinkRef[];
    task_id?: string;
    title?: string;
    type: TaskType;
  };
  tenancy: ExtensionFields & {
    org_id?: string;
    repo_id?: string;
    repo_slug?: string;
    user_id?: string;
  };
  workflow?: WorkflowRefV01;
  working_set: ExtensionFields & {
    diffs?: WorkingSetDiff[];
    files?: WorkingSetFile[];
    notes?: string[];
  };
}

export type ContinuityFieldProvenance = (typeof CONTINUITY_FIELD_PROVENANCE_VALUES)[number];

export interface DurableMemoryProposal {
  category?: string;
  confidence?: number;
  content: string;
  evidence_refs?: JsonValue[];
  memory_key?: string;
  project?: string;
  sensitivity?: Sensitivity;
  source?: string;
  source_timestamp?: string;
  status?: MemoryStatus;
  tags?: string[];
  ttl_days?: number;
}

export interface EnvironmentModel {
  blocked_by?: string[];
  branch?: string;
  failing_checks?: string[];
  open_prs?: { number: number; title: string }[];
  probed_at?: string;
  tooling_available?: string[];
  uncommitted_files?: number;
  workspace_dirty?: boolean;
}

export type ExtensionFields = Partial<Record<`x_${string}`, JsonValue>>;

export type JsonPrimitive = boolean | null | number | string;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface LinkRef extends ExtensionFields {
  label: string;
  url: string;
}

export interface MemoryArtifact extends ExtensionFields {
  content_markdown: string;
  kind: 'adr' | 'note' | 'plan' | 'runbook' | 'summary';
  title: string;
}

export interface MemoryDeltaEvent extends ExtensionFields {
  payload_ref?: string;
  summary: string;
  ts?: string;
  type: SessionEventType;
}

// x_durable_memories is added via intersection because DurableMemoryProposal's
// optional properties include undefined under exactOptionalPropertyTypes: false,
// making it structurally incompatible with ExtensionFields' JsonValue constraint.
// Deferred until exactOptionalPropertyTypes is enabled (see tsconfig.json).
export type MemoryDeltaV01 = ExtensionFields & {
  append_events?: MemoryDeltaEvent[];
  artifacts?: MemoryArtifact[];
  created_at: string;
  delta_id: string;
  produced_by: ExtensionFields & {
    agent: string;
    model?: string;
  };
  schema_version: 'memory_delta@0.1';
  session_id: string;
  snapshot: ExtensionFields & {
    mode: SnapshotMode;
    value: SessionSnapshotV01 | SnapshotPatchV01;
  };
  telemetry?: ExtensionFields & {
    pack_chars_total_budget?: number;
    pack_chars_total_seen?: number;
    pack_used_id?: string;
    uncertainty?: 'high' | 'low' | 'medium';
  };
  tenancy: ExtensionFields & {
    org_id?: string;
    repo_id?: string;
    user_id?: string;
  };
  workflow?: WorkflowRefV01;
  x_durable_memories?: DurableMemoryProposal[];
};

export type MemoryStatus = 'active' | 'archived' | 'contested' | 'expired' | 'superseded';

export type Sensitivity = 'confidential' | 'internal' | 'public' | 'restricted';

export type { MemoryType };

export interface SessionEventDigestV01 extends ExtensionFields {
  event_id: string;
  summary: string;
  ts: string;
  type: SessionEventType;
}

export type SessionEventType =
  | 'checkpoint'
  | 'diff_applied'
  | 'note_added'
  | 'plan_updated'
  | 'review_completed'
  | 'tests_ran';

export interface SessionPlanItem extends ExtensionFields {
  done?: boolean;
  id: string;
  text: string;
}

export interface SessionProgress extends ExtensionFields {
  blockers: string[];
  completed: string[];
  in_flight: string[];
}

export interface SessionSnapshotV01 extends ExtensionFields {
  anchors: ExtensionFields & {
    focus_paths?: string[];
    related_links?: LinkRef[];
  };
  context_needed?: string[];
  created_at: string;
  goal: string;
  next_actions: string[];
  open_questions: string[];
  plan: SessionPlanItem[];
  progress: SessionProgress;
  snapshot_id: string;
}

export type SessionStatus = 'abandoned' | 'active' | 'completed' | 'error';

export type SnapshotMode = 'patch' | 'replace';

export interface SnapshotPatchV01 extends ExtensionFields {
  ops: (
    | (ExtensionFields & { op: 'add' | 'set'; path: string; value: JsonValue })
    | (ExtensionFields & { op: 'remove'; path: string })
  )[];
}

export type StateModelProvenance = (typeof STATE_MODEL_PROVENANCE_VALUES)[number];

export type StrategyConfidence = (typeof STRATEGY_CONFIDENCE_VALUES)[number];

export type TaskType = 'bugfix' | 'chore' | 'feature' | 'incident' | 'refactor' | 'research' | 'review' | 'unknown';

export interface WorkflowRefV01 extends ExtensionFields {
  entity_id: string;
  entity_type: string;
  entity_url?: string;
  state?: string;
  system: string;
  title?: string;
}

export interface WorkingSetDiff extends ExtensionFields {
  label: string;
  revision?: ExtensionFields & {
    base?: string;
    head?: string;
  };
  unified_diff?: string;
}

export interface WorkingSetFile extends ExtensionFields {
  excerpt?: string;
  path: string;
  purpose?: string;
  revision?: ExtensionFields & {
    blob_sha?: string;
    commit_sha?: string;
  };
}

export const aiMemoryContractsRuntimeAnchors = {
  mcpServer: McpServer,
  zodNamespace: z,
};
