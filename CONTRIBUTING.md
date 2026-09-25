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

The project-identity test exercises migration history; do not point either URL at the persistent personal database. `npm run init -w @aviaratech/ai-memory-tools` and `npm run smoke -w @aviaratech/ai-memory-tools` can exercise a disposable `ai_memory_test` database after `npm run build`. Destroy only the test databases that you provisioned. Do not run tests with live content or provider keys.

Use synthetic, domain-neutral examples and fixtures. Keep credentials, actual memory records, private logs, and machine-specific paths out of commits and issue discussions. [Installation](docs/installation.md) and [operations](docs/operations.md) describe the user-facing commands.
