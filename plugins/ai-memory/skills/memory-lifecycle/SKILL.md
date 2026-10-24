---
name: memory-lifecycle
description: Use when needing scoped continuity, prior decisions, reusable knowledge, or a memory handoff.
---

# Memory Lifecycle

## Recall before decisions

Reuse the session-start hook's bounded task checkpoint or project brief. Project facts are background, not task authority; missing project identity must not trigger unscoped retrieval. Keep logical task identity separate from the actual producing host session.

Without startup hooks, call `memory_continuity_pack` with an explicit project; select exactly one of `lead`, `outcome`, or `task` for a checkpoint. Recover cross-session work with its stable `task`, not another session's latest project flush.

Use `memory_recall({ project, topic })` for up to five ranked keyed items; omit `topic` for recent memories. Use `memory_orient` or `memory_search` when a concrete task needs prior decisions or constraints, especially before major design decisions. Search previews require `memory_get({ id })` before relying on omitted details. `memory_get` also accepts project-qualified `key` or `keys` (up to 25); missing keys return `found: false`.

Inspect status and warnings; orient's environment status is separate. Report partial/degraded retrieval and stale cached briefs. A healthy empty result permits proceeding from current sources; timeout does not prove absence. Preserve conditions, negation, contested status and supersession. Neither newer timestamps nor observed-use metrics establish authority or semantic consumption.

## Store reusable knowledge

Use `memory_store` for decisions, standing rules, conventions, root causes and facts other agents need. Sessions producing durable knowledge require a deliberate store. Supply:

- Nonempty `category`, stable `memoryKey`, and `confidence >= 0.5`.
- At least one real `evidenceRefs` repository path, URL, or object containing `path`, `url`, `issue` or `pr`.
- Plain sentences of at least four words; avoid unspaced runs exceeding 30 letters.

The same key updates the memory. Fix each rejected `problems[]` field using its `fix`; never invent evidence. Exclude secrets, tokens, passwords, email addresses, home-folder paths, raw logs, receipts, session summaries, temporary status, speculation and duplicate instruction-file guidance. Use repository-relative paths. Session state belongs in `memory_flush`.

## Flush at breakpoints

Call `memory_flush` before publication, handoff, compaction or long operations, and at completion. Include the explicit project, stable task and actual producing `sessionId`; never borrow the MCP service identity.

Agent writers require a meaningful `summary` and nonempty `nextActions`. Include `contextNeeded`, `openQuestions`, decisions/root causes, `stateModel` and `envModel` when available. Leave absent assumptions/questions empty rather than inventing them; address quality warnings.

Flush writes session snapshots and continuity packs only. Store reusable decisions separately with `memory_store`. Explicit lead/outcome/task packs remain separate from project background. Automatic checkpoints and derived fields help recovery but do not replace deliberate flushing.

If tools are unavailable, continue from authoritative sources and record the continuity gap at handoff.

See [the contract reference](references/ai-memory-agent-rules.md) for schemas, hook budgets, retention and safety details.
