---
name: memory-lifecycle
description: Use when needing to retrieve scoped continuity, store, search, or flush memory — covers orient/flush/store patterns and memory quality standards
---

# Memory Lifecycle

## Orient During Session Work

The session-start hook first probes the task pack matching the host-supplied session identity. A matching pack preserves its original source session and skips unrelated project recall/orient. If no task pack matches, the same bounded read falls back to a small, explicitly background project pack, followed by compact recall and no-task orientation. Missing project identity reads no unscoped background memories. Pack reads retain `memory_continuity_pack` telemetry. The complete decoded host context is capped at 8,000 UTF-16 characters, including guidance, scope, provenance, deduplicated recent-memory previews, orientation health, degradation warnings, and truncation notices. The hook does not embed this skill; load its procedures when needed. A truncation notice means details must be retrieved on demand.

Boundary: hooks make memory ambient with bounded deterministic reads; vector/hybrid retrieval belongs in task-conditioned `memory_orient` or `memory_search` calls once you have a concrete task. Do not replace startup continuity with vector fanout or broad session reads.

Health-report continuity adoption readiness is deterministic supply/lifecycle evidence: pack found/missing/degraded reads, actionable-field completeness, and whether sessions flushed after reading a pack. It is not semantic proof that the agent consumed the context.

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

Call `memory_store` for conventions, architecture decisions, root causes, and preferences. Every session that produces durable knowledge requires at least one deliberate `memory_store` call.

**Quality gates:**

- Include `category` (required, non-empty).
- Use `confidence >= 0.5` for non-session-summary categories.
- Include `evidenceRefs` (at least one file path, PR URL, or issue link).
- For strict categories (`convention`, `architecture`, `preference`, `root-cause`): `memoryKey` is also required.
- For `session-summary`: `expiresAt` is required (ISO-8601) and `confidence` must be `<= 0.5`.

**When to store:**

| Checkpoint | Category | What to Store |
|---|---|---|
| After resolving a root cause | `root-cause` | What the bug was, why it happened, how it was fixed |
| After choosing an approach | `architecture` | Approach selected, alternatives considered, tradeoffs |
| After discovering a convention | `convention` | The pattern, where it applies, example file paths |
| After multi-step debugging | `root-cause` | Symptoms, dead ends explored, final resolution |
| Before handoff | `preference` | Workflow discoveries for continuity |

**Do NOT store:** raw error logs, session-specific temporary state, speculative conclusions from a single file read, anything that duplicates AGENTS.md or CLAUDE.md guidance.

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

**Agent-writer gate:** `memory_flush` calls from agent identities require `summary`, non-empty `nextActions`, and either non-empty `openQuestions` or at least one `stateModel.assumptions` entry. Include `contextNeeded` when outside input or operator state matters, include `decisions` when choices were made, and include `stateModel`/`envModel` whenever available; missing rich continuity fields can still generate quality warnings.

`memory_flush` is also the continuity-pack write path. After the core transaction commits, the existing reflection stage runs, then ai-memory refreshes the bounded project continuity pack used by future session-start hooks. Explicit `lead`, `outcome`, and `task` values additionally write their separate scoped packs. Do not add a separate long-term-memory/reflection pass unless this path proves insufficient.

Automatic Codex/Claude session-end hooks and the supported Grok Build `SessionEnd` export adapter retain bounded source-attributed excerpts, identity, and evidence references only; do not store raw logs or secrets. This plugin does not install a Grok host hook. Derived snapshot fields are tagged with `x_*_provenance: "derived"`; values carried forward from an explicit flush are tagged `"carry-forward"`. Treat derived fields as helpful continuity hints, not a substitute for deliberate `memory_flush`.

## If Tools Unavailable

Continue normally. Note in your handoff that memory tools were unavailable so the next session is aware of the gap.

## Full Contract Reference

See `references/ai-memory-agent-rules.md` in this skill directory for the complete MCP contract schemas, memory taxonomy, retention policy, and safety rules.
