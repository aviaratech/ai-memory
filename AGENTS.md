# AGENTS.md: aviaratech/ai-memory

ai-memory supplies a PostgreSQL-backed memory library, MCP tools and host hooks.
It stores durable knowledge and session continuity. Personal Safety rules and the
engineering charter apply; this file sets repository guidance.

## Boundaries

- Memory is evidence-backed context. It does not authorize actions or replace
  GitHub issue/PR state. Preserve project, task and producing-session identity.
- Keep durable knowledge in `memory_store`; `memory_flush` writes session state.
  Preserve privacy, evidence and write validation at the public tool boundary.
- Never test against the persistent personal database. Use only synthetic,
  domain-neutral fixtures and disposable PostgreSQL with pgvector, following
  [CONTRIBUTING](CONTRIBUTING.md#isolated-postgresql-tests).
- Keep credentials, actual memory records, private logs and machine-specific
  paths out of commits and public discussions. Never print database URLs.
- Add retry or recovery behavior only for an observed failure with linked evidence.

## Budgets

| What | Limit |
| --- | --- |
| PR | 400 changed non-test lines across at most 10 files |
| Tests | No more lines than the code covered; parser and money-path exceptions |
| Local check / full CI | 5 / 10 minutes; do not add a stage |
| Each skill or instruction file | 500 words |
| README / CONTRIBUTING | 1,500 / 300 words |
| Issue / PR / journal | 300 / 200 / 150 words |

Split work or ask the lead before exceeding a budget. Stop at twice the estimate
or a second redesign.

Observed before this change at `b424832` on Oct 24, 2026: README 595 words,
CONTRIBUTING 886, memory-lifecycle 1,525; no repository AGENTS file.
[Main CI](https://github.com/aviaratech/ai-memory/actions/runs/40106532922)
completed in 6m 20s from run start to update, excluding queue time.
Local `npm run checks` on this instruction slice passed in 1m 25s
using Node 24.21.0 and npm 11.19.0 with loopback access.

## Change and delivery

- Solve the stated outcome with the smallest change. Remove replaced paths.
  Keep one way to do each job; prefer maintained packages or standard libraries.
- Test caller-visible behavior. Bug fixes need a failing-then-passing regression;
  do not pin documentation wording. Run focused checks first and `npm run checks`
  once before pushing. Database changes also require disposable integration tests.
- Use an isolated issue worktree and configured host author. Ordinary code needs
  a fresh read-only reviewer; consequential changes need the consequential route
  and reviewer App approval. Honor stronger issue requirements, including
  [parent #68's GPT reviewer App requirement](https://github.com/aviaratech/ai-memory/issues/68).
- Release user-facing changes through the canonical release workflow. Host
  installation and operational adoption require their own authorized scope.
- Ask Paul before adding a command, MCP tool or configuration field, changing
  authorization, or crossing a Safety gate. Clean up only resources you created.
