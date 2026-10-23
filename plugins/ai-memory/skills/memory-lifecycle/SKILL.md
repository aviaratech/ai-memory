---
name: memory-lifecycle
description: Use when needing to retrieve scoped continuity, store, search, or flush memory — covers orient/flush/store patterns and memory quality standards
---

# Memory Lifecycle

## Everyday tools

Start with these four tools:

1. `memory_store` saves reusable knowledge with a stable key and real evidence. If rejected, apply each `problems[]` field's `fix` before retrying; never invent evidence or retain sensitive data.
2. `memory_get` fetches a full record by id, or by `key` / `keys` (up to 25) with an explicit project. Keys return active rows by default and `found: false` when missing; set `includeInactive` for superseded history.
3. `memory_recall` with `project` and `topic` returns at most five ranked active keyed items with excerpts, verification dates and evidence. Database errors or a one-second timeout return `status: degraded` and the matching project/host/role cached brief when available; an absent cache is explicit. Omit `topic` for the existing recent-memory recall.
4. `memory_search` finds source-linked previews by query and filters; expand selected records with `memory_get`.

```jsonc
memory_get({ project: "example/catalog", key: "rule/merge-slot" })
memory_recall({ project: "example/catalog", topic: "release rules" })
```

## Orient During Session Work

The session-start hook probes the task pack named by the host-supplied session identity. Automatic checkpoints require the same recognized host, project and producing session; explicit logical-task packs preserve their original source session. A matching pack wins. Otherwise startup supplies bounded, keyed durable project facts as background, excluding another session's latest project flush. Missing project identity reads no unscoped memories. Pack reads retain `memory_continuity_pack` telemetry. The complete decoded startup context is capped at 8,000 UTF-16 characters, including guidance, scope, provenance, warnings and truncation notices. Load this skill on demand; a truncation notice means details must be retrieved explicitly.

For supported Codex and Claude Code hooks, `SessionStart` with `source: startup` arms one task-conditioned retrieval on the first nonempty `UserPromptSubmit`. Its ID, category, date and excerpt context is capped at 3,200 decoded UTF-16 characters. Resume, compaction, replay and missing or expired lifecycle state never rearm it. Explicit tools remain available; use `memory_orient` or `memory_search` when the concrete task needs more evidence. Do not replace bounded startup continuity with broad session reads.

`PreCompact` uses only the supplied, validated producing-session transcript to derive a checkpoint. Later compactions refresh derived fields and retain explicit field lineage; conditional writes preserve competing newer flushes. Unsupported or inconsistent transcripts leave automatic checkpointing unavailable. Deliberate `memory_flush` remains the source of authored meaning and handoff intent.

The health report's seven-day per-host consumption summary counts injected IDs and later observed successful ai-memory `memory_get` results or explicit assistant `[memory:<id>]` citations in the same project and session. Coverage is partial or unobserved; a reported use rate is a lower bound on observed use, and unobservable rates remain unset. Continuity adoption readiness remains supply/lifecycle evidence. Neither establishes semantic consumption or actual seven-day operator-use acceptance.

Call `memory_continuity_pack` manually only when a host does not run the session-start hook. For an active checkpoint, pass exactly one of `lead`, `outcome`, or `task`; a worker project flush cannot replace that scoped checkpoint. Call `memory_continuity_debug` only when inspecting the exact startup payload, truncation state, or budget pressure:

```jsonc
memory_continuity_debug({
  project: "example/docs"
})
```

Keep logical task and host session identity distinct. Pass the same `task` on checkpoints across reconnects and harnesses, and the actual `sessionId` of each producing host session. If they differ, recover with `memory_continuity_pack({ project, task })`; exact session resume describes that session, not the newest logical-task checkpoint. When the host identity is also the task identity, startup can recover that task pack directly. An omitted flush session ID produces a generated, explicitly unattested identity; never use the shared MCP service environment as the caller identity.

Reuse an already recovered checkpoint. Call `memory_orient` only when a concrete task needs prior decisions or implicit constraints beyond that checkpoint:

```jsonc
memory_orient({
  project: "example/docs",
  task: "<describe the task>",
  stateModel: {
    strategy_confidence: "high", // "high" | "medium" | "low"
    assumptions: [],
    uncertainty: [],
    constraints: []
  }
})
```

After the response:

1. Check top-level `status`, `orientation.environmentStatus`, and flat `warnings` before writing any code. `status` represents memory/continuity health; `environmentStatus` represents the optional environment probe.
2. If top-level `status` is `partial` or `degraded`, report retrieval as unavailable or incomplete. Recover an existing explicit task pack or a known exact session when useful; project recall is background, not task authority. An environment-only warning such as `local_fallback` or `unavailable` does not trigger fallback reads.

## Search Before Decisions

Before major architectural or design decisions, call `memory_search`:

```jsonc
memory_search({
  query: "<describe what you need to know>",
  activeGoal: "<current goal text>",  // conditions search results
  memoryType: "semantic"              // optional: episodic | semantic | procedural | reflective
})
```

Previews select relevant passages and evidence when a query is available. Preserve negation, conditions, contested status and supersession lineage; a partial excerpt requires detail before acting. Newer timestamps alone do not establish authority. Inspect the compact previews, then call `memory_get({ id: <selected id> })` for the complete record before relying on details omitted from the preview. Search has one 16,384-byte serialized result budget, including warnings; `memoryDetail: "full"` and `fullContentTopN` cannot bypass it. A result with `detail: "compact"` and `fullContentOmitted: true` is a preview, even when full detail was requested. `candidateCount` counts only the limited ranked candidates fetched, and `count` counts returned previews/records, never all matching database rows.

If a healthy search finds no relevant memories, state the missing evidence and proceed from authoritative current sources. A timeout or unavailable retrieval does not establish absence.

## Store Durable Knowledge

Call `memory_store` for reusable knowledge that more than one agent needs: decisions and standing rules, conventions, hard-to-re-derive facts, "where things live" pointers, root causes and study verdicts. `memory_store` is the only way to write a durable memory; `memory_flush` keeps session state. Every session that produces durable knowledge requires at least one deliberate `memory_store` call.

**Write gate (a write that fails any check is rejected):**

- Include `category` (required, non-empty) and `confidence >= 0.5`.
- Include a stable `memoryKey` such as `owner/repo:topic`. A later write with the same key updates the memory.
- Include `evidenceRefs` with at least one repository path, URL, or object with `path`, `url`, `issue` or `pr`.
- Write plain sentences of at least four words. Runs of more than 30 letters without spaces are rejected.
- Never include secrets, tokens, passwords, email addresses or home-folder paths (`/Users/<name>`, `/home/<name>`). Use repository-relative paths.
- Do not store `session-summary` memories; save session state with `memory_flush`.

**When to store:**

| Checkpoint | Category | What to Store |
|---|---|---|
| After resolving a root cause | `root-cause` | What the bug was, why it happened, how it was fixed |
| After choosing an approach | `architecture` | Approach selected, alternatives considered, tradeoffs |
| After discovering a convention | `convention` | The pattern, where it applies, example file paths |
| After multi-step debugging | `root-cause` | Symptoms, dead ends explored, final resolution |
| Before handoff | `preference` | Workflow discoveries for continuity |

**Do NOT store:** session summaries or status snapshots, raw error logs, receipts, session-specific temporary state, speculative conclusions from a single file read, anything that duplicates AGENTS.md or CLAUDE.md guidance.

## Flush at Breakpoints

Call `memory_flush` at natural breakpoints -- task completion, handoff, before long operations, before publishing a PR, or when context is getting long.

```jsonc
memory_flush({
  project: "example/docs",
  task: "<stable logical task identity>",
  sessionId: "<actual producing host session identity>",
  summary: "<>= 120 chars describing what was done>",
  decisions: ["<key choices made>"],
  nextActions: ["<what should happen next>"],
  contextNeeded: ["<operator or project context needed to proceed>"],
  openQuestions: ["<unresolved decisions>"],
  stateModel: {
    strategy_confidence: "medium",
    assumptions: ["<what you are assuming>"],
    uncertainty: ["<what is still unknown>"],
    constraints: ["<hard constraints>"]
  },
  envModel: { /* environment context when available */ }
})
```

**Agent-writer gate:** `memory_flush` calls from agent identities require `summary` and non-empty `nextActions`. Missing `openQuestions` or assumptions are advisory: leave them empty when none exist instead of inventing content. Compressed narrative text also returns a quality warning; preserve spaces between words. Include `contextNeeded` when outside input or operator state matters, include `decisions` when choices were made, and include `stateModel`/`envModel` whenever available; missing rich continuity fields can still generate quality warnings.

`memory_flush` writes session state only: the session snapshot (including `decisions` and `rootCauses`) and the continuity pack. It stores no durable memories, so store any decision or root cause that other agents need with `memory_store`. After the snapshot commits, ai-memory refreshes the bounded project continuity pack available for explicit background reads. Explicit `lead`, `outcome`, and `task` values additionally write their separate scoped packs.

Automatic Codex/Claude session-end hooks and the supported Grok Build `SessionEnd` export adapter record a session snapshot with identity and evidence references only; they never write durable memories. Do not store raw logs or secrets. This plugin does not install a Grok host hook. Derived snapshot fields are tagged with `x_*_provenance: "derived"`; values carried forward from an explicit flush are tagged `"carry-forward"`. Treat derived fields as helpful continuity hints, not a substitute for deliberate `memory_flush`.

## If Tools Unavailable

Continue normally. Note in your handoff that memory tools were unavailable so the next session is aware of the gap.

## Full Contract Reference

See `references/ai-memory-agent-rules.md` in this skill directory for the complete MCP contract schemas, memory taxonomy, retention policy, and safety rules.
