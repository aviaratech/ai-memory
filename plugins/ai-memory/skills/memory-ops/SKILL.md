---
name: memory-ops
description: Use when reviewing memory health, consolidating stale memories, debugging search quality, or resolving contested memories
---

# Memory Operations

## Health Check

Verify system health and key metrics:

1. Run `npm run health -w @aviaratech/ai-memory-tools` for a full report.
2. Or use the `/ai-memory:memory-health` command for a quick connectivity check.

**Key metrics to review:**

| Metric | Target | Meaning |
|---|---|---|
| `continuityStateModelPct` | >= 50% | Sessions including stateModel in flush |
| Continuity packs materialized | >= 1 active project pack | Cross-chat startup context has a bounded read model |
| Continuity pack reads | > 0 after fresh starts | Session-start hooks are reading the bounded pack |
| Continuity pack read quality | >= 99% success, p95 <= 500ms | Startup continuity reads are reliable and cheap |
| Continuity pack budget pressure | <= 90% max payload/budget | Startup context is not close to blowing agent context |
| Continuity adoption readiness | Informational | Pack availability, actionable-field completeness, and flush-after-pack lifecycle evidence |
| Auto derived/carry-forward continuity | Informational | Hook output is enriching snapshots without pretending to be an explicit flush |
| Continuity source quality | Informational | Split explicit flush snapshots from auto-derived/carry-forward hints |
| Writer mix | >= 20% per tool | Each agent tool contributing deliberate writes |
| Ingestion failure rate | Low | Recent ingestion errors |

When `continuityStateModelPct` is below 25%, the launch gate issues a warning. Below 50% is on-target but worth monitoring.
If continuity packs stay at zero while `memory_flush` usage is non-zero, inspect `memory_flush` warnings and the `continuityPack` response field before adding new reflection machinery.
If continuity packs are materialized but continuity-pack reads stay at zero after a fresh Codex/Claude start, inspect session-start hook telemetry before assuming packs are unused.
If continuity adoption readiness shows missing/degraded reads, debug hooks or MCP connectivity before changing pack content.
If actionable-field completeness is low, improve explicit `memory_flush` handoffs (`nextActions`, `openQuestions`, `decisions`, `contextNeeded`) rather than adding vector startup retrieval. Treat flush-after-pack as a lifecycle readiness signal, not semantic consumption proof.
If read quality is below target or budget pressure is high, call `memory_continuity_debug({ project })` once to inspect the exact startup payload, payload size, budget, truncation state, and source. Do not use it as routine recall.
Auto-derived `next_actions`, `context_needed`, and `open_questions` are tagged as derived in snapshot provenance; carry-forward values are tagged separately. Do not count either as agent-writer `memory_flush` compliance.

## Contested Memory Resolution

When two memories conflict, use `memory_resolve_contested`:

```jsonc
memory_resolve_contested({
  memoryIdA: 42,
  memoryIdB: 87,
  action: "merge"  // list | keep_first | keep_second | keep_both | merge
})
```

**When to use each action:**

- `list` -- review contested pairs before resolving (default when no memoryIdA/B given).
- `keep_first` / `keep_second` -- one is clearly outdated or wrong.
- `merge` -- both contain partial truths that combine into a complete picture. Requires `mergedContent`.
- `keep_both` -- they cover distinct aspects that appear to conflict but are both valid in their respective contexts.

Default to `merge` when in doubt. Prefer `keep_both` only when the memories address genuinely different scopes.

## Search Quality Debugging

When search results are poor or missing expected entries:

1. Call `memory_orient` and check `capabilities` in the response:
   - `embedding` -- embedding-based search available.
   - `search` -- search pipeline is configured.
   - `searchAvailable` -- search is operational (DB connected, indexes present).
   - `sessionResume` -- session resume is available.
   - `envProbe` -- environment probe mode (`none`, `local`, or `full`).
2. If capabilities are missing, the hybrid search pipeline is degraded. Trigram support requires the `pg_trgm` extension.
3. Test with `memory_search` using a known term from a recently stored memory to verify end-to-end.
4. Check that the search query is not too broad -- use `activeGoal` and `memoryType` filters to narrow results.

**Search ranking signals (for reference):** semantic (55%), keyword (33%), keyword-hint (4%), taxonomy (4%), confidence (4%).

## Ingestion Failure Triage

When sessions are not being ingested or memory gaps appear:

1. Use `memory_ingestion_failures` to list recent failures.
2. Common causes:
   - **Malformed payloads** -- missing required fields in context packs or deltas.
   - **DB connectivity** -- PostgreSQL not running or connection pool exhausted.
   - **Schema drift** -- migrations not applied after an update (`npm run init -w @aviaratech/ai-memory-tools`).
3. For DB connectivity issues, verify with `npm run pg:status -w @aviaratech/ai-memory-tools`.
4. For schema drift, run migrations and re-check: `npm run init -w @aviaratech/ai-memory-tools`.
