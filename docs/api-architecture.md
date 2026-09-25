# API and architecture

`@aviaratech/ai-memory` owns the public memory API, persistence, retrieval, retention, and numbered SQL migrations. Import from its package root: `storeMemory`, `searchMemories`, `recallMemories`, `initializeDatabase`, and the other exports declared in `packages/ai-memory/src/index.ts`. `@aviaratech/ai-memory/internal` is reserved for its companion tools package.

`@aviaratech/ai-memory-tools` owns the MCP server, ingestion pipeline, health/evaluation commands, and operational CLIs. Its public root exports the ingestion pipeline; `./server` is the MCP entry point. The plugin packages skills, hooks, and a bundled Node launcher. It copies the core migration assets during build; the core migration registry remains `public.ai_memory_pgmigrations`.

The MCP tool schemas and provenance contracts are verified by package tests. The optional recovery replay/evaluation commands have separate resource and provider requirements; they are not part of installation or the default `npm run checks` gate. For database setup and recovery, use [installation](installation.md) and [operations](operations.md).
