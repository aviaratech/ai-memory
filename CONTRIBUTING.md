# Contributing

Use Node.js 24 with npm 11 (validated with Node.js 24.21.0 and npm 11.19.0). The repository uses npm workspaces, strict TypeScript, native Oxlint with type-aware rules, Oxfmt, and Vitest. Run the canonical gate from the repository root:

```sh
npm ci
npm run checks
```

`checks` runs `format:check`, the dependency build, `lint`, `typecheck`, and `test` in that order. `npm run format` applies Oxfmt intentionally. Run `npm run test` for unit and contract tests or `npm run build` for a focused build; these do not replace `checks` before a change is submitted.

## Isolated PostgreSQL tests

Integration tests are separate from the default gate. Use a **disposable** PostgreSQL 18 instance with pgvector installed, and two different loopback databases that contain no personal memory. The tested database stack is PostgreSQL 18.6 with pgvector 0.8.6. Provision a test role that owns both `ai_memory_test` and `ai_memory_project_identity_test` using your local administrator tools. Supply protected loopback URLs for each through `AI_MEMORY_DATABASE_URL` and `AI_MEMORY_PROJECT_IDENTITY_TEST_URL`, then run:

```sh
npm run test:integration
```

The project-identity test exercises migration history; do not point either URL at the persistent personal database. `npm run init -w @aviaratech/ai-memory` and `npm run smoke -w @aviaratech/ai-memory` can exercise a disposable `ai_memory_test` database after `npm run build`. Destroy only the test databases that you provisioned. Do not run tests with live content or provider keys.

The non-owner startup regression uses the separate `AI_MEMORY_PROJECT_IDENTITY_TEST_URL` as its disposable administrator connection. That test administrator needs `CREATEDB` and `CREATEROLE`; the fixture creates unique synthetic databases and a non-owner login, proves packaged startup with a SELECT-only migration ledger, and drops its own databases and login in cleanup. Use these capabilities only on the disposable test instance. CI's disposable PostgreSQL service supplies this administrator role.

Use synthetic, domain-neutral examples and fixtures. Keep credentials, actual memory records, private logs, and machine-specific paths out of commits and issue discussions. [Installation](docs/installation.md) and [operations](docs/operations.md) describe the user-facing commands.

## PostgreSQL coverage selection in CI

PR CI skips PostgreSQL provisioning and integration only when the complete event base/head diff contains ordinary non-executable files at root `README.md`, `CONTRIBUTING.md`, `LICENSE`, or Markdown files under `docs/`. The CI owner is `scripts/ci-postgres-impact.mjs`; it uses a NUL-delimited raw Git diff with rename detection disabled so deletions and both rename endpoints are classified. Missing history, an empty diff, malformed evidence, unsupported modes/statuses, source/configuration changes and unknown paths require the complete suite. All main pushes run full integration. The aggregate `checks` job requires successful Linux, macOS, package and selection jobs; it accepts a skipped PostgreSQL lane only for a validated documentation-only decision. A failed, cancelled or unexpectedly skipped required lane fails the aggregate.

The current 14 integration files span the following owners under `packages/ai-memory/src/`:

| Integration files | Transitive impact beyond the test file |
| --- | --- |
| `db/consolidate-fragments`, `db/flush-decision` | Consolidation, classification, ingestion/flush, embeddings, hashes and built CLI exports |
| `db/memory-access`, `db/vector`, `tools/db/append-only-events`, `tools/eval/search-benchmark` | Public/internal built exports, store/query/ranking/vector SQL, audit events and synthetic search fixtures |
| `db/project-identity`, `db/project-scope-backfill`, `db/run-migrations` | Historical SQL migrations, identity fixtures, scope backfill, schema/catalog/role checks and core/plugin MCP startup |
| `db/task-hooks` | Session/continuity/tool-invocation APIs and prompt retrieval |
| `db/workflow-events` | Telemetry projection, workflow health reports, retention SQL and retention configuration |
| `tools/localPostgresSetup` | Protected configuration, provisioning, migrations and setup subprocesses |
| `tools/smoke-ingest` | Built ingestion smoke CLI and both harnesses |
| `tools/telemetry-packaged` | Actual core/plugin archives, package manifests/exports, hooks, launchers, bundled/staged assets and migrations |

Each name above has the suffix `.integration.test.ts`. All `packages/**`, `plugins/**`, migrations, fixtures, scripts, dependency locks, Node/npm/toolchain and CI/configuration changes therefore run integration; a `src/db/**` filter would miss current dependencies. New or uncertain paths run the full suite rather than relying on a static import graph. The selection does not choose individual tests or change Vitest coverage.

`npm run test:integration` remains an explicit full-suite command using both disposable URLs described above. Release qualification in `.github/workflows/release.yml` always provisions its own disposable PostgreSQL and executes that command independently of PR selection. The fast skip saves PostgreSQL work only; ordinary source, platform and package checks remain required. CI timings must be measured separately from queue time, including the extra install/build in selected PostgreSQL jobs.

Temporary unmerged CI qualification for ai-memory issue #56.
