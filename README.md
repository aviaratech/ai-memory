# ai-memory

ai-memory stores agent memories in a PostgreSQL database on the same machine as the agent. This repository is a standalone release candidate; it does not provide a hosted service or native ChatGPT memory integration.

The tested stack is Node.js 24.21.0 with npm 11.19.0, PostgreSQL 18.6, and pgvector 0.8.6. The package declares Node 24 support (`>=24 <25`), and recovery requires PostgreSQL major version 18 plus the exact extension versions recorded in the backup. PostgreSQL client tools `pg_dump` and `pg_restore` must also be version 18.

```sh
npm ci
npm run checks
```

For a personal database and MCP client, install the single `@aviaratech/ai-memory` npm package as described in [installation](docs/installation.md). [API and architecture](docs/api-architecture.md) explains package ownership; [operations](docs/operations.md) covers health, encrypted backup, and recovery. [Contributing](CONTRIBUTING.md) describes checks and isolated database tests.

The source and package archives are licensed under the [MIT License](LICENSE). The plugin archive also includes notices for its bundled dependencies.

GitHub Actions runs the same `npm run checks` on eligible pull requests and main pushes, followed by synthetic integration tests against a disposable PostgreSQL 18 service. Fork pull requests receive read-only repository access and no provider or production credentials. The workflow also runs the repository's secret scanner against reachable history and the proposed tree. To run those checks locally, install [Betterleaks 1.8.1](https://github.com/betterleaks/betterleaks/releases/tag/v1.8.1), then run `npm run scan:secrets` and `npm run scan:secrets:probe`. Repository-host secret scanning and push protection add a separate layer where available; confirm their settings before publication.

Memory stays on the local machine unless you configure an external embedding or classification provider or optional S3 backups. Local availability depends on that machine and its PostgreSQL service. Public source code alone does not run a service for you.

## Pinned project briefs

The plugin's SessionStart hook adds a deterministic brief on startup, clear and compact in Claude Code and Codex when native hooks are enabled. Set `AI_MEMORY_ROLE` to the session's role (for example `lead`); it defaults to `default`. Store a keyed rule with `pinned: true` and `audience: ["all"]`, or a list of host (`claude-code`, `codex`) or role tags. Any matching tag includes the item. Audience controls brief selection; it does not restrict explicit memory-tool access. A `state` memory keyed `<project>:state/<role>` appears first even when unpinned. Every item shows its key, verification time and first evidence reference; role state also shows its update time. Project-qualified keys keep state separate under global key uniqueness; a legacy literal `state/<role>` is used only when that project has no canonical state record.

The brief retains whole items in descending importance, then key order, within 7,500 characters, leaving room in the 8,000-character hook envelope for guidance and cache provenance. An omission line explains how to search for the remaining items. Existing rows default to audience `all`, unpinned, and verification at their original update time. `memory_store` accepts `audience`, `pinned` and optional `lastVerifiedAt`; send the desired audience/pin fields when updating a pinned key.

Where Codex hooks are off, generate the same brief explicitly and include the resulting file as session context:

```sh
ai-memory brief --project example/catalog --host codex --role lead --out ./project-brief.md
```

Omit `--out` to print it. The command uses the protected local database configuration and reads memory without running migrations. Successful hook and CLI builds atomically refresh a private cache under `~/.cache/ai-memory/briefs` (override with `AI_MEMORY_BRIEF_CACHE_DIR`). Files are separately keyed by exact project, host and role. On database failure, the hook injects that scope's last successful brief with its generated-at time and exits successfully. Treat cached facts as potentially stale. No cache means the existing availability warning; another scope's file is never substituted. Generation does not seed rules or alter host configuration.
