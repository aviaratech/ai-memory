> **Reference**: Keep these examples aligned with the installed ai-memory tool contracts.

# AI Memory Agent Rules

These rules define how agents should use the shared `ai-memory` MCP tools.

## Purpose

- Keep durable engineering knowledge consistent across Claude Code, Codex, and Grok Build.
- Preserve session continuity while preventing sensitive data from entering memory storage.

## Native Memory Boundary

- Hooks probe the task pack matching the supplied host identity and preserve the producing session provenance. A match skips unrelated project recall/orient. Otherwise startup reads small background project context within the same bounded pack-read budget. Missing project identity must not broaden to global recall.
- Vector and hybrid retrieval are task-conditioned: use `memory_orient` or `memory_search` when there is a concrete task/query. Do not replace startup continuity with vector fanout or multi-session reads.
- `memory_flush` remains the deliberate write path for meaning, decisions, and handoff intent. Session-end hooks provide automatic capture and derived hints, not authoritative agent commitments.

## Session Start Checklist (Required)

Run these steps at the beginning of every non-trivial session:

1. Reuse the bounded session-start checkpoint when it matches the active task. Startup probes the task pack named by the host identity, preserving its source session; only a missing match falls back to project background and compact recall/orient. Read scope, provenance and degradation notices.

2. Call `memory_continuity_pack({ project: "example/docs" })` manually only when a host does not run the session-start hook. For an active checkpoint, use exactly one explicit scope, for example `memory_continuity_pack({ project: "example/docs", task: "task-42" })`; `lead` and `outcome` work the same way. Call `memory_continuity_debug` with the same single scope only when inspecting the exact payload, truncation state, or budget pressure.

3. Call `memory_orient({ project: "example/docs", task: "<describe the task>" })` only when you have a concrete task and want task-conditioned retrieval. Read `status` and `warnings` before coding.

4. If `memory_orient` is unavailable or degraded, do not interpret the failure as absent evidence. Recover a known task pack or exact known session when useful. Project recall remains background, not authority for the active task.

5. `memory_search({ query: "<describe the task>" })`
   -- Before major design/implementation decisions when orient/fallback context is thin.

Skip step 5 for trivial tasks.

## Hardened MCP Contract Reference

Use this section as the source of truth for current `memory_continuity_pack`, `memory_orient`, and `memory_flush` behavior.

### `memory_continuity_pack` (Cross-Chat Read Path Contract)

- Reads one bounded continuity pack from `ai_continuity_packs`. The default project scope is startup background context; it is explicitly rendered as non-authoritative for any active lead/outcome/task.
- Startup hooks already read this automatically before orient, so manual calls are normally unnecessary.
- Session-start read attempts, including failures, are recorded as `memory_continuity_pack` read telemetry. The health report renders dedicated continuity-pack read quality, missing/degraded read count, and p95 latency so a materialized pack with poor or zero reads is visible.
- Health reporting also surfaces continuity-pack budget pressure, source quality (`explicit_flush_snapshots`, `auto_hint_snapshots`, and derived/carry-forward fields), and deterministic adoption-readiness signals: pack found/missing/degraded reads, actionable-field completeness, and sessions with a flush after a pack read. Readiness is supply/lifecycle evidence, not proof that an agent semantically consumed the context.
- Input accepts `project` or `repoId`, plus exactly one optional `lead`, `outcome`, or `task` identity. A scoped read is still one indexed lookup and returns only that checkpoint.
- `memory_flush` always refreshes the project startup pack. When its explicit `lead`, `outcome`, or `task` identities are present, it additionally refreshes separate scoped packs. A worker that only updates project context cannot replace a lead/outcome/task checkpoint.
- The read path is intentionally not vector-backed. Vectors belong in task-conditioned `memory_orient`/`memory_search`, where the agent has a meaningful query.

### `memory_continuity_debug` (Exact Startup Payload Debug)

- Returns the exact rendered startup continuity pack plus budget metadata (`budgetChars`, `payloadChars`, `pressurePct`, `truncated`).
- Use only for debugging startup context or budget pressure. Normal session starts should rely on hooks, and task recall should use `memory_orient`/`memory_search`.
- Shares the same project/repo and optional single explicit scope as `memory_continuity_pack`; it does not perform vector recall or broad session reads.
- The response is `status: "found"` with pack metadata/content or `status: "missing"` when no pack exists yet.

### `memory_orient` (Read Path Contract)

- Always inspect both `status` and `warnings` from the response before coding.
- Optional `memoryType` filter accepts only: `episodic`, `semantic`, `procedural`, `reflective`.
- Invalid `memoryType` values fail fast with an error listing allowed values. Correct by using one of the accepted enums or omitting the field.
- `memoryDetail` defaults to `compact` and supports `compact | full`.
- Compact orient memory rows include lightweight preview fields (for example: `id`, `category`, `memoryType`, `status`, `source`, `evidenceRefs`, `tags`, `excerpt`) rather than full metadata payloads.
- `fullContentTopN` (0-5, default `0`) can inline full `content` for the top N compact memories per array (`recentMemories`, `taskRelevant`). Use `memory_get` for the complete record and source detail.
- Pass an exact persisted `sessionId` to `memory_orient` for direct lead/task resume; `agent` and `project` remain fallback metadata and must not widen an exact session lookup.
- Orient recall ordering is task-conditioned: `task` + `activeGoal` token overlap re-ranks recall slots before compact/full formatting.
- Use `memory_get` with preview ids when you need to expand compact rows into full memory records.
- `activeGoal` is now plain text and should be passed as a string when goal-conditioned recall/search context is needed.
- Use `capabilities.searchAvailable` to determine if search is generally available before deciding whether to call oriented search workflows.
- Use `capabilities.search` for legacy compatibility behavior and `orientation.taskSearchStatus`/`orientation.taskSearchResultCount` to inspect the outcome of this specific orient call.
- Structured goal CRUD tooling is retired. Use `activeGoal` text instead of identifier-based goal flows.
- Timeout/degradation policy: orient lanes are bounded. The direct task-search lane reserves one bounded embedding phase plus one bounded database/text-fallback phase; other lanes use one bounded step. A successful direct text fallback remains `ok`; only a failed or timed-out lane appends warnings and can downgrade status to `partial` or `degraded`.
- `stateModel` is an accepted but deprecated no-op input for orient. It is retained for backward compatibility, is not evaluated, and orient returns no intervention. It is still worth sending: `memory_flush` seeds `x_state_model` from your working state for session-resume continuity.

**Orient contract example with optional `stateModel` (accepted, no-op):**

```jsonc
{
  "project": "example/docs",
  "task": "Implement orient-loop health metrics",
  "stateModel": {
    "strategy_confidence": "high",
    "assumptions": [],
    "uncertainty": [],
    "constraints": []
  }
}
```

```jsonc
// Invalid memoryType (throws)
{ "memoryType": "semantic-ish" }

// Corrected
{ "memoryType": "semantic" }

// Also valid: omit filter entirely
{}

// Compact orient + inline full content for the top 2 previews
{ "memoryDetail": "compact", "fullContentTopN": 2 }
```

When orient returns `partial` or `degraded`, continue with available context and run fallback reads (`memory_recall`, `memory_session_resume`) to recover continuity.

### `memory_search` (Task History Read Path)

- Search compact → inspect preview → `memory_get({ id })` for full-record recovery. `memoryDetail: "full"` and `fullContentTopN` (0-5) request expanded content within the same response budget.
- The final search `CallToolResult` is at most 16,384 UTF-8 bytes measured by `JSON.stringify`, including escaped text, envelope, metadata and appended warnings. JSON-RPC request ids and transport framing are outside this tool-owned budget. Orient, recall, get, continuity and session response contracts retain their own behavior.
- Every returned row declares `detail: "compact"|"full"`. Full records/content that do not fit become compact previews with `fullContentOmitted: true`; content is never sliced and labeled full. Compact metadata fields over 512 serialized UTF-8 bytes are omitted with `previewTruncated: true`; excerpts retain the canonical 240-character limit. A rank-preserving prefix is returned; if the first preview cannot fit, its ID remains recoverable. No lower-ranked row replaces an oversized higher-ranked row.
- `candidateCount` is the size of the limited ranked retrieval result, `count` is the number actually returned, and `requestedCount` is the requested limit (default 8). These are not database-wide matched counts. `truncated` covers metadata omission, full-content fallback, dropped rows or warning truncation; `budgetExceeded` records a candidate or warning envelope exceeding its available budget before fallback. `budgetBytes` is the cap. Warnings retain at most four messages (240 characters each) and four code/message details (120/240 characters), with `warningsTruncated` reporting loss.
- Tool annotations are SDK hints, never authorization gates. They describe domain effects; all tools also append best-effort invocation telemetry, and failures append an audit event. Search and recall update stored access importance; orient inherits those writes and can probe external repository state. Runtime diagnostics can hydrate process environment values. Session resume/get/continuity reads do not write domain records.
- Store, flush, ingestion and contested resolution may update existing records; their annotations conservatively declare writes and non-idempotence. Search/recall/orient are also non-idempotent because throttled importance boosts can recur. Diagnostics conservatively make no idempotence promise. Embedding/model and external probe paths declare open-world interaction; fixed database, session, continuity and local diagnostic paths declare a closed domain.
- Search indexes and re-ranks memory keys, source labels, tags, and evidence references alongside content, project, and category. Exact issue/PR evidence references therefore remain searchable without a slow transcript scan.
- Pass `sessionId` to restrict a search to a known checkpoint session. `includeInactive` is false by default, so superseded/expired/archived entries cannot override current active guidance; use `memory_get` with explicit ids when historical lineage is required.

Content-free search metrics reuse `ai_tool_invocations.summary_json`: `search_detail`, `search_requested_count`, `search_returned_count`, `search_candidate_count`, `search_response_bytes`, `search_budget_bytes`, `search_truncated`, and `search_budget_exceeded`. Existing duration and tool columns supply latency and operation identity. No raw queries/bodies/evidence, token estimates or prices are added. For a bounded sample of compact/full use and payload percentiles:

```sql
WITH recent AS (
  SELECT summary_json
  FROM ai_tool_invocations
  WHERE tool_name = 'memory_search'
    AND created_at >= NOW() - INTERVAL '7 days'
    AND summary_json ? 'search_response_bytes'
  ORDER BY created_at DESC
  LIMIT 10000
)
SELECT summary_json->>'search_detail' AS detail, COUNT(*) AS calls,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY (summary_json->>'search_response_bytes')::numeric) AS payload_p50_bytes,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY (summary_json->>'search_response_bytes')::numeric) AS payload_p95_bytes
FROM recent
GROUP BY summary_json->>'search_detail';
```

Search→get attribution is unknown unless an existing session identity proves the relationship; aggregate call counts alone do not establish conversion.

### `memory_flush` (Write Path Contract)

- `summary` is required and must be non-empty.
- Brief summaries now trigger non-blocking continuity warnings so handoffs include enough implementation context.
- Durable promotions:
  - `decisions` and `rootCauses` are promoted to durable actionable memories.
  - `summary` is recorded as a checkpoint/session-summary signal for continuity/searchability.
- Continuity snapshot extensions:
  - `activeGoal` is written as `x_active_goal`.
  - `stateModel` is written as `x_state_model`.
  - `envModel` is written as `x_env_model`.
- Agent-writer calls (`agent`, `claude-code`, `codex`, or builder/reviewer/retro identities) are rejected unless they include non-empty `nextActions` and either non-empty `openQuestions` or at least one `stateModel.assumptions` entry. Manual flushes and hook/auto-ingest sources remain backward-compatible and may provide sparse continuity fields.
- Continuity fields `nextActions`, `contextNeeded`, `openQuestions`, `stateModel`, and `envModel` are expected in agent-authored flush payloads. Missing rich continuity fields can still generate named quality warnings in the flush response -- agents should treat these warnings as actionable, not informational.
- **`stateModel` is especially important**: it seeds `x_state_model` for resume continuity. Missing state model data is visible in snapshot continuity adoption, while launch-gate health now tracks agent-writer payload completeness from `memory_flush` tool telemetry (target: >= 95%).
- `stateModel` v2 contract: `strategy_confidence` must be `"high"`, `"medium"`, or `"low"` (string literals). If missing or invalid, it is normalized to `"medium"` with a named warning in the flush response. New temporal fields: `updated_at` (ISO timestamp) and `confidence_history` (array of `{value, reason}` entries) are optional. `envModel` gains `probed_at` (ISO timestamp) for staleness tracking.
- After the core transaction commits, the existing reflection stage runs and then refreshes the bounded project continuity pack used by future session-start hooks. Explicit `lead`, `outcome`, and `task` values also refresh matching scoped packs; omit them rather than guessing identity. This keeps long-term cross-chat continuity on the existing flush/reflection path instead of adding a separate reflector.
- `memory_flush` response includes `warnings`, `reflection`/`consolidation`, and `continuityPack` metadata for operational visibility.
- Automatic Codex/Claude session-end hooks and the supported Grok Build `SessionEnd` export adapter may extract bounded handoff context. They retain source/session/turn identity and evidence references, but never raw unfiltered logs or secrets. The Grok adapter requires a host that invokes `SessionEnd`; it does not install or mutate a Grok hook. Derived snapshot fields are tagged with `x_*_provenance: "derived"`; values carried forward from an explicit flush are tagged `"carry-forward"`. Derived/carry-forward fields improve continuity but do not satisfy the agent-writer `memory_flush` gate or replace an explicit flush.

## Read Path (Required)

- At task start, run the [Session Start Checklist](#session-start-checklist-required) above.
- When resuming a known session, call `memory_session_resume` for short-term continuity (see [Session Resume Identity Contract](#session-resume-identity-contract) below).
- Before major design or implementation decisions, call `memory_search` for existing conventions, prior decisions, and known root causes.
- If no relevant memories are found, proceed normally and establish fresh decisions in-task.

### Health and Replay Disposition

- Health reports retain aggregate historical observations. A timeout or failure recorded before this source repair remains historical evidence; do not resolve, delete, or bulk-retain it merely because the repair is merged.
- Source verification proves the bounded timeout and retrieval contracts, not installed-service behavior. Once a local service is available, run the read-only health report and retrieval harness; use observations from that service to assess installed behavior.
- The redacted `cross-harness-delivery-control` fixture reports answer/source correctness, returned size, search calls, and observed latency. It exercises disposable evaluator scopes only and is not an approval or a replacement for GitHub issue/PR state.

### Session Resume Identity Contract

`memory_session_resume` resolves sessions using a two-priority strategy:

1. **Direct session lookup**: Pass the actual producing host `sessionId`. A requested project/repository or agent scope must match; missing and foreign sessions never fall back. For the newest logical-task checkpoint across sessions, use `memory_continuity_pack({ project, task })`.
2. **Fallback resolution**: Omit `sessionId`, then pass `agent` and/or `project`/`repoId` metadata to find the most recent matching session. An absent exact `sessionId` returns missing; it never widens to another session.

Keep the same explicit `task` on flushes across harnesses and reconnects, while passing each producing host `sessionId` separately. These IDs are not universally equal. An omitted flush sessionId is generated and explicitly unattested; never infer it from the shared MCP process. Scoped packs and memory evidence preserve context, while original approvals and source records remain authoritative.

**Valid session IDs** are strings persisted in the `ai_sessions` table via `memory_ingest_context_pack` or `memory_ingest_delta`. They originate from:

- Claude Code session-end hooks (format: UUID from Claude runtime)
- Codex wrapper post-session ingestion (format: UUID from Codex runtime)
- Orchestrator transcripts (only if the orchestrator calls an ingestion tool)

**Do NOT pass** issue numbers, branch names, workflow labels, or arbitrary identifiers as `sessionId` — these are not persisted session IDs and will return `not_found`.

**Recommended call patterns:**

```jsonc
// Best: direct lookup with known session ID
{ "sessionId": "cafda941-a411-4bf7-8725-0e47594b5c9e" }

// Good: fallback by agent + project (finds most recent session)
{ "agent": "claude-code", "project": "example/docs" }

// Good: fallback by agent + repoId
{ "agent": "codex-cli", "repoId": "example/docs" }

// Exact lookup constrained by the supplied project and agent (no fallback)
{ "sessionId": "cafda941-...", "agent": "claude-code", "project": "example/docs" }
```

The response includes `resolvedVia: "direct" | "fallback" | "not_found"` so callers know which path was used.

## Write Path (Required)

- Store durable outcomes with `memory_store` when they are likely to matter in future sessions.
- Durable writes must include a non-empty `category`.
- Confidence policy:
  - `session-summary` memories are intentionally low-confidence and ephemeral.
  - Non-`session-summary` durable memories should be higher confidence.
- Preferred write targets:
  - Architecture decisions and tradeoffs.
  - Team conventions and stable patterns.
  - Root causes that took meaningful debugging effort.
  - Workflow preferences that reduce repeated setup.
- Keep entries concise and specific (single claim per memory when possible).

## Memory Taxonomy

Every memory category belongs to one of three tiers that determine query-time ranking in both `memory_recall` and `memory_search`.

| Tier           | Weight | Sort Priority | Categories                                                                     |
| -------------- | ------ | ------------- | ------------------------------------------------------------------------------ |
| **actionable** | 1.0    | 0 (highest)   | `architecture`, `bugfix`, `convention`, `decision`, `preference`, `root-cause` |
| **contextual** | 0.5    | 1             | `implementation-note`, `workflow`                                              |
| **low-signal** | 0.0    | 2 (lowest)    | `audit-log`, `checkpoint`, `session-summary`                                   |

**Defaulting behavior:** Unknown, missing, or newly introduced categories that are not listed above default to **contextual**. This applies to both recall ordering (SQL tier sort) and search reranking (taxonomy weight signal). Unknown categories are never demoted to low-signal.

**How taxonomy affects queries:**

- **`memory_recall`**: Results are sorted by tier priority (actionable first, then contextual, then low-signal), then by confidence, then by recency.
- **`memory_search`**: Hybrid reranking uses five weighted signals: semantic (55%), keyword (33%), keyword-hint (4%), taxonomy (4%), and confidence (4%). Semantic relevance uses `max(AND-semantic, OR-semantic * 0.8)` to rescue partial-match rows. A deterministic token fallback triggers when the hybrid pipeline returns zero results.

**Canonical source:** `packages/ai-memory/src/db/taxonomy.ts`

### Strict Metadata Categories

The following categories enforce strict metadata requirements at write time:

- `convention`
- `architecture`
- `preference`
- `root-cause`

For these categories, `memory_store` **requires**:

| Field          | Required | Purpose                                                          |
| -------------- | -------- | ---------------------------------------------------------------- |
| `memoryKey`    | Yes      | Stable idempotency key for upsert; prevents duplicates           |
| `confidence`   | Yes      | Must be >= 0.5 (enforced for all non-session-summary categories) |
| `evidenceRefs` | Yes      | At least one file path, PR URL, or issue link for auditability   |

### Canonical Project Identifier

Use the host repository identifier as `project`; `example/docs` is a synthetic example.

Do not use legacy aliases for new writes.

Runtime ingest/search paths no longer canonicalize legacy aliases automatically.

### memoryKey Convention

Use a stable, descriptive key so future updates upsert the same entry:

```
<project>:<topic>
```

Examples:

- `example/docs:document-import-pattern`
- `example/docs:token-refresh-convention`
- `example/docs:component-store-naming`

### Keyed Update Example

Store an initial convention:

```json
{
  "category": "convention",
  "memoryKey": "example/docs:component-store-naming",
  "content": "Component stores expose pure selectors from their module.",
  "confidence": 0.9,
  "evidenceRefs": ["src/store/README.md"],
  "project": "example/docs",
  "tags": ["components", "naming", "convention"]
}
```

Update the same convention later (upserts by memoryKey):

```json
{
  "category": "convention",
  "memoryKey": "example/docs:component-store-naming",
  "content": "Component stores expose pure selectors from their module and keep the update functions separate.",
  "confidence": 0.92,
  "evidenceRefs": ["src/store/README.md", "https://example.invalid/review/7"],
  "project": "example/docs",
  "tags": ["zustand", "naming", "convention", "selectors"]
}
```

### Supersedes Workflow

When a decision fully replaces an older one, use `supersedesId` to mark the old entry:

1. Find the old memory ID via `memory_search`.
2. Store the new memory with `supersedesId` pointing to the old ID:

```json
{
  "category": "architecture",
  "memoryKey": "example/docs:document-storage-approach",
  "content": "Moved document metadata into a dedicated index. The prior index remains available only for historical reads.",
  "confidence": 0.95,
  "evidenceRefs": ["docs/decisions/document-index.md"],
  "supersedesId": 42,
  "project": "example/docs",
  "tags": ["documents", "index", "architecture"]
}
```

The old entry (ID 42) remains in history for audit but is marked as superseded.

## Deliberate Write Participation

- Every agent session that produces durable knowledge must include at least one deliberate `memory_store` call before handoff.
- Automatic session-end ingestion (Claude Code session-end hook, Codex wrapper post-session) supplements but does not replace deliberate writes. Session-end summaries are low-confidence ephemeral records, not canonical decisions.
- Target: each agent tool (Claude Code, Codex) should contribute at least 20% of deliberate durable writes over the health report window. The health report tracks writer mix by source and flags contributors below the threshold as `LOW`.
- When no durable knowledge was produced in a session (e.g., trivial fix, pure read-only investigation), skipping `memory_store` is acceptable. The expectation applies to sessions that generate reusable guidance.

## Non-Review Write Checkpoints (Builder/Implementation Sessions)

Builder and implementation sessions often produce durable knowledge that review sessions do not. Use these checkpoints to decide when to write:

### When to Write

| Checkpoint                         | Category       | What to Store                                                                 |
| ---------------------------------- | -------------- | ----------------------------------------------------------------------------- |
| **After resolving a root cause**   | `root-cause`   | What the bug was, why it happened, how it was fixed                           |
| **After choosing an approach**     | `architecture` | Which approach was selected, alternatives considered, tradeoffs               |
| **After discovering a convention** | `convention`   | The pattern, where it applies, example file paths                             |
| **After a multi-step debugging**   | `root-cause`   | Symptoms, dead ends explored, final resolution                                |
| **Before handoff**                 | `preference`   | Workflow discoveries (e.g., specific test commands, env setup) for continuity |

### High-Signal Examples

**Root cause after debugging:**

```json
{
  "category": "root-cause",
  "memoryKey": "example/docs:import-phase-race-condition",
  "content": "Import phase transitions during rendering caused repeat navigation. Move transitions to explicit event handlers to avoid re-entry.",
  "confidence": 0.9,
  "evidenceRefs": ["https://example.invalid/review/8"],
  "project": "example/docs",
  "tags": ["document-import", "capture", "race-condition", "navigation"]
}
```

**Convention discovered during implementation:**

```json
{
  "category": "convention",
  "memoryKey": "example/docs:component-store-selector-pattern",
  "content": "Component stores expose pure selectors that take state and return derived values.",
  "confidence": 0.85,
  "evidenceRefs": ["src/components/exampleStore.selectors.ts"],
  "project": "example/docs",
  "tags": ["components", "selectors", "convention"]
}
```

**Architecture decision during builder session:**

```json
{
  "category": "architecture",
  "memoryKey": "example/docs:session-snapshot-continuity-fields",
  "content": "Auto session snapshots now include structured continuity fields (next_actions, context_needed, open_questions, evidence_refs) populated by the caller. This improves session resume quality for implementation sessions where the assistant message alone is insufficient context.",
  "confidence": 0.85,
  "evidenceRefs": ["packages/ai-memory-tools/src/ingestion/auto-session-ingest.ts"],
  "project": "example/docs",
  "tags": ["ai-memory", "session-snapshot", "continuity"]
}
```

### Anti-Patterns (Do NOT Store)

- Raw error logs or stack traces (summarize the root cause instead)
- Session-specific temporary state (task progress, in-flight branch names)
- Speculative conclusions from a single file read
- Anything that duplicates existing AGENTS.md or CLAUDE.md guidance

## Retention Awareness

- `session-summary` memories require `expiresAt` at write time (enforced by quality gate). Default TTL: 14 days (configurable via `AI_MEMORY_RETENTION_SESSION_SUMMARY_DAYS` env var or `sessionSummaryTtlDays` input).
- Canonical durable categories (`convention`, `architecture`, `preference`, `root-cause`, `decision`, `bugfix`) are non-TTL by default. Their lifecycle is managed via `active`/`superseded`/`archived` status.
- Transient session data (`ai_sessions`, snapshots, events, context packs, deltas) is subject to a 90-day retention window.
- For the full retention matrix and purge semantics, see [AI Memory Retention Policy](ai-memory-retention-policy.md).

## Safety And Redaction

- Never store secrets, credentials, access tokens, private keys, PHI/PII, or raw logs.
- If uncertain whether data is sensitive, do not store it.
- Prefer summarized conclusions over transcript dumps.

## Conflict Handling

- If multiple memories conflict, treat newest active memory as current unless user instruction says otherwise.
- When updating guidance, write a new memory that clearly supersedes prior guidance.
- Do not silently discard historical context; preserve auditability through explicit updates.

## Enriched Session Snapshots

Auto session-end ingestion now accepts structured continuity fields that improve session resume quality:

| Field           | Purpose                                                    | Example                                           |
| --------------- | ---------------------------------------------------------- | ------------------------------------------------- |
| `nextActions`   | Concrete next steps for the next session                   | `["Run integration tests", "Publish PR"]`         |
| `contextNeeded` | Information the next session needs to proceed              | `["PR review feedback on #90009"]`                 |
| `openQuestions` | Unresolved decisions or unknowns                           | `["Should state live in store or orchestrator?"]` |
| `evidenceRefs`  | File paths, PR URLs, or issue links supporting the session | `["https://github.com/.../pull/123"]`             |

These fields are populated by the session-end hook caller (Claude Code hook, Codex wrapper). When not provided, they default to empty arrays. The fields appear in:

- The session snapshot (`snapshot.value.next_actions`, etc.)
- The artifact markdown (as structured sections)
- The snapshot anchors (`related_links` for evidence refs and transcript paths)

Callers should populate these fields for implementation sessions to improve cross-session continuity.
Agent writers must include `nextActions` and either `openQuestions` or `stateModel.assumptions`; hook/auto-ingest callers may still omit them for backward compatibility.

## Pre-Compaction / Pre-Handoff Flush

Call `memory_flush` in these situations:

- Before `/exit` or session end on a long session (>30 tool calls)
- When you sense the context is getting long (compaction warning signs)
- After completing a major task milestone

Include: key decisions made, root causes found, what should happen next.

```jsonc
{
  "project": "example/catalog",
  "sessionId": "example-session",
  "agent": "codex",
  "summary": "Verified the catalog import and kept the pending approval visible.",
  "nextActions": ["Check the approved import record"],
  "contextNeeded": ["The approval record remains authoritative"],
  "openQuestions": ["Has the catalog owner approved the import?"],
  "stateModel": {
    "assumptions": ["The local import is complete"],
    "constraints": ["Do not publish before approval"],
    "strategy_confidence": "medium"
  }
}
```

The `summary` is stored as a `checkpoint` memory (searchable but not in recall). `decisions` and `rootCauses` are promoted to durable actionable-tier memories. `nextActions`, `contextNeeded`, and `openQuestions` populate the session snapshot for `memory_session_resume`.

## Runtime Notes

- Claude Code performs a session-start recall probe plus automatic session-end ingestion; this does not replace deliberate reads/writes for critical decisions.
- Codex relies on MCP tool usage plus wrapper/launchd post-session ingestion from `~/.codex/sessions`.
- Automatic durable-memory promotion is available when `AI_MEMORY_AUTO_DURABLE_PROMOTION=1` is configured for the relevant ingestion path. When Claude's compaction summary is available, it is used as the primary content source (higher signal, 1200-char limit, confidence 0.45). Without a compaction summary, the last assistant message is used (700-char limit, confidence 0.35).
- Auto-promoted memories are `session-summary` category with TTL (default 14 days), not long-lived canonical decisions. Deliberate `memory_store` writes are still required for durable knowledge.
- Write-time similarity detection auto-supersedes near-duplicate entries for all actionable categories (`architecture`, `bugfix`, `convention`, `decision`, `preference`, `root-cause`).

## Contract Documentation

When changing ai-memory tools, update the corresponding package documentation
and this reference in the same change. Check accepted inputs, response fields,
continuity warnings, and examples against the actual server contracts.
