# @aviaratech/ai-memory

The package root exports the memory engine API. `./internal` retains the existing privileged exports for current consumers. `./ingestion` exports the ingestion pipeline, and `./server` starts the MCP server when run. The package also contains health, evaluation, and operational commands, the `ai-memory-mcp` executable, and numbered PostgreSQL migrations. Importing the package root does not start operational services.

Set an explicit loopback `AI_MEMORY_DATABASE_URL` for commands that access PostgreSQL. See [installation](../../docs/installation.md), [API and architecture](../../docs/api-architecture.md), and [operations](../../docs/operations.md).
