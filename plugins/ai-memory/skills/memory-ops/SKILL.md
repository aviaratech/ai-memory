---
name: memory-ops
description: Use when reviewing memory health, removing data ai-memory no longer keeps, debugging search quality, or resolving contested memories
---

# Memory Operations

## Health Check

Full report: `npm run health -w @aviaratech/ai-memory`; quick connectivity: `/ai-memory:memory-health`.

| Metric | Target/meaning |
|---|---|
| `continuityStateModelPct` | >= 50% sessions include `stateModel` in flush |
| Continuity packs materialized | >= 1 active project pack; bounded cross-chat startup read |
| Continuity pack reads | > 0 after fresh starts; session-start hooks read pack |
| Continuity pack read quality | >= 99% success, p95 <= 500ms |
| Continuity pack budget pressure | <= 90% max payload/budget; context not near limit |
| Continuity adoption readiness | Informational: availability, actionable completeness, flush-after-pack lifecycle evidence |
| Auto derived/carry-forward continuity | Informational: hooks enrich snapshots without implying explicit flush |
| Continuity source quality | Informational: split explicit flush from derived/carry-forward hints |
| Writer mix | >= 20% per tool; deliberate agent writes |
| Ingestion failure rate | Low recent errors |

`continuityStateModelPct` <25% warns at launch; below 50% is on-target but worth monitoring. Zero packs with non-zero `memory_flush`: inspect warnings and `continuityPack` before adding machinery. Packs but no reads after fresh Codex/Claude start: inspect hook telemetry first. Missing/degraded adoption reads: debug hooks/MCP connectivity before pack changes. Low actionable-field completeness: improve explicit `memory_flush` handoffs (`nextActions`, `openQuestions`, `decisions`, `contextNeeded`), not vector startup retrieval; flush-after-pack means lifecycle readiness, not semantic consumption proof. Below-target read quality or high budget pressure: call `memory_continuity_debug({ project })` once for exact startup payload, size, budget, truncation, source; not routine recall. Auto-derived `next_actions`, `context_needed`, `open_questions` are tagged derived in snapshot provenance; carry-forward separately tagged. Neither counts as agent-writer `memory_flush` compliance.

## Removing Data ai-memory No Longer Keeps

`ai-memory cleanup` dry-run counts `memory_flush` memories, auto-promoted/expired summaries, superseded session snapshots/deltas, removed-feature events. `ai-memory cleanup --apply --backup-id <id>` deletes these only after a healthy backup of the same DB; it retains `memory_store` memories except expired session summaries. Only people apply; agents only dry-run. See operations guide.

## Contested Memory Resolution

`memory_resolve_contested` takes `memoryIdA`, `memoryIdB`, `action` (`list | keep_first | keep_second | keep_both | merge`); `merge` requires `mergedContent`. `list` reviews pairs and defaults without either ID. Keep first/second when one is clearly outdated/wrong. Merge partial truths into a complete picture; default if unsure. Keep both only for valid, genuinely different scopes.

## Search Quality Debugging

Call `memory_orient`; inspect `capabilities`: `embedding` (embedding search), `search` (configured pipeline), `searchAvailable` (DB/indexes operational), `sessionResume` (resume available), `envProbe` (mode: `none`, `local`, `full`). Missing capabilities mean degraded hybrid search; trigram requires the `pg_trgm` extension. Verify end-to-end with `memory_search` on a known recently stored term. Narrow broad queries using `activeGoal`, `memoryType`. Ranking: semantic 55%, keyword 33%, keyword-hint 4%, taxonomy 4%, confidence 4%.

## Ingestion Failure Triage

`memory_ingestion_failures` lists recent failures. Causes: malformed payloads (required context-pack/delta fields missing); DB connectivity (PostgreSQL stopped or pool exhausted); schema drift (migrations unapplied after update). Connectivity: verify `npm run pg:status -w @aviaratech/ai-memory`. Schema drift: run migrations, re-check `npm run init -w @aviaratech/ai-memory`.
