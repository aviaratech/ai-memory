# @aviaratech/ai-memory

The package root exports the memory engine API. `./internal` retains the existing privileged exports for current consumers. `./ingestion` exports the ingestion pipeline, and `./server` starts the MCP server when run. The package also contains health, evaluation, and operational commands, the `ai-memory-mcp` executable, and numbered PostgreSQL migrations. Importing the package root does not start operational services.

Set an explicit loopback `AI_MEMORY_DATABASE_URL` for commands that access PostgreSQL. See [installation](../../docs/installation.md), [API and architecture](../../docs/api-architecture.md), and [operations](../../docs/operations.md).

For explicit guided local PostgreSQL onboarding from this installed package:

```sh
npx --no-install ai-memory setup --help
npx --no-install ai-memory setup --dry-run --json
npx --no-install ai-memory setup --admin-user postgres --port 5432
```

Use a private interactive terminal. Setup labels existing PostgreSQL administrator and new memory runtime credentials, explains changes before confirmation, preserves conflicts and resumes compatible completed work. Success requires actual schema and packaged MCP connection proof. It never resets an existing password/database, stops unrelated services or installs a native plugin. Npm/plugin installation alone does not provision a database or service. Follow the [numbered installation guide](https://github.com/aviaratech/ai-memory/blob/main/docs/installation.md) for prerequisites, validated platforms, protected configuration and separate plugin/backup steps.
