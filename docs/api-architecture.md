# API and architecture

`@aviaratech/ai-memory` is the single npm package for the memory engine, MCP server, ingestion pipeline, health and evaluation commands, and operational CLIs. The package root retains its public memory API, including `storeMemory`, `searchMemories`, `recallMemories`, and `initializeDatabase`. `@aviaratech/ai-memory/internal` retains its existing privileged exports without widening that surface.

The former tools root ingestion API is available at `@aviaratech/ai-memory/ingestion`, with the same exports and behavior. The MCP entry point is `@aviaratech/ai-memory/server`, and the `ai-memory-mcp` executable starts the same server. Importing the package root does not start MCP, ingestion, migrations, or background services. The implementation remains in separate engine, ingestion, server, and operations modules within the package; no forwarding tools package is built.

The runtime package ships the existing built plugin under `plugins/ai-memory`; the matching GitHub archive packages those same files. The plugin contains portable Codex and Claude metadata, skills, hooks, bundled launcher/server and core numbered migration assets. Its package-derived MCP version matches the runtime and plugin manifests. The `ai-memory plugin` CLI owns native installation receipts and delegates registration to the supported host manager; it does not expose a new engine API or setup/service path. Its protected launcher reads the dedicated plugin environment file and requires an already complete migration ledger. The migration registry remains `public.ai_memory_pgmigrations`; read-only doctor cannot apply missing migrations even with administrator credentials.

## Migrating from 0.1.x

Existing 0.1.x installations and archives remain usable unchanged. Consumers moving to 0.2.0 must change the dependency and imports explicitly:

| Before (0.1.x) | After (0.2.0) |
| --- | --- |
| `@aviaratech/ai-memory-tools` dependency | `@aviaratech/ai-memory` dependency |
| `@aviaratech/ai-memory-tools` import | `@aviaratech/ai-memory/ingestion` import |
| `@aviaratech/ai-memory-tools/server` import | `@aviaratech/ai-memory/server` import |
| `node_modules/@aviaratech/ai-memory-tools/dist/server.js` | `node_modules/@aviaratech/ai-memory/dist/tools/server.js` |
| `npm run <command> -w @aviaratech/ai-memory-tools` | `npm run <command> -w @aviaratech/ai-memory` |

The `ai-memory-mcp` executable name and core root/internal imports stay the same.

Before removing the old tools dependency, repoint persisted MCP configurations, backup and Codex launchd registrations, and other absolute consumer paths to the new installation. Existing launchd plists retain their absolute `ProgramArguments`; installing the new package does not rewrite them. Update those arguments or regenerate registrations with the existing installers, using their `--dry-run` previews to review the result. Preserve each registration's protected environment and credential-file references, existing schedule, log paths, and recovery or ingestion state. Compare regenerated jobs with the existing registrations rather than adopting installer defaults over customized settings. Verify that every replacement entrypoint exists in the new installation and that each consumer references it before removing the old tools installation. Keep the existing database and migration ledger.

The 0.2.0 source change does not rewrite installed 0.1.x packages or publish a release by itself.

The MCP tool schemas and provenance contracts are verified by package tests. The optional recovery replay and evaluation commands have separate resource and provider requirements; they are not part of installation or the default `npm run checks` gate. For database setup and recovery, use [installation](installation.md) and [operations](operations.md).
