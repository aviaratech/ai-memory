# Installation

Install Node.js 24 and npm 11, PostgreSQL 18 server and client tools, and pgvector for PostgreSQL 18. The validated combination is Node.js 24.21.0, npm 11.19.0, PostgreSQL 18.6, and pgvector 0.8.6. Install PostgreSQL and pgvector through your platform's maintained packages, then verify `node --version`, `npm --version`, `pg_config --version`, `pg_dump --version`, and that `SELECT default_version FROM pg_available_extensions WHERE name = 'vector'` returns the installed pgvector version. A restore host needs the exact extension versions recorded by its source backup.

Create a dedicated local PostgreSQL login role that **owns** the `ai_memory` database. Ownership gives the role the schema creation rights required for `public.ai_memory_pgmigrations` and the memory tables on PostgreSQL 18. For example, from a local PostgreSQL administrator session, set the new role's password interactively and create the database with that role as owner:

```sh
createuser -h 127.0.0.1 -U postgres --login --pwprompt ai_memory_user
createdb -h 127.0.0.1 -U postgres --owner=ai_memory_user ai_memory
psql -h 127.0.0.1 -U postgres -d ai_memory -c 'CREATE EXTENSION IF NOT EXISTS vector'
psql -h 127.0.0.1 -U postgres -d ai_memory -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm'
```

Use your own administrator role and authentication method if they differ; do not put passwords in this repository or shell history. The migrations also try to create the extensions when privileges allow; vector search is unavailable if pgvector is absent. Keep this personal database and its backups as persistent data, separate from the disposable databases used in [contributor tests](../CONTRIBUTING.md#isolated-postgresql-tests).

From this standalone checkout, install and build the workspaces:

```sh
npm ci
npm run build
```

For a versioned npm installation, create a separate local directory and install the tools package; it brings in the matching core package:

```sh
mkdir ai-memory-client && cd ai-memory-client
npm init -y
npm install --save-exact @aviaratech/ai-memory-tools@0.1.1
```

The installed package provides `node_modules/@aviaratech/ai-memory-tools/dist/server.js` as its MCP stdio server. Keep this installation with its matching migration files for recovery. The optional plugin is distributed as `aviaratech-ai-memory-plugin-0.1.1.tgz` on the matching [GitHub release](https://github.com/aviaratech/ai-memory/releases/tag/v0.1.1). After downloading that archive, extract it to a dedicated directory before configuring a compatible plugin host:

```sh
mkdir ai-memory-plugin
tar -xzf aviaratech-ai-memory-plugin-0.1.1.tgz -C ai-memory-plugin --strip-components=1
```

The archive includes the bundled MCP launcher, migrations, license, and third-party notices.

Provide `AI_MEMORY_DATABASE_URL` for the database-owning role through your host's protected environment. It must be an explicit `postgresql://` URL for `localhost`, `127.0.0.1`, or `::1` and the dedicated `ai_memory` database. The package does not infer a URL from another service or load a shared `.env` file. After setting it, run these commands from the standalone checkout:

```sh
npm run pg:status -w @aviaratech/ai-memory-tools
npm run init -w @aviaratech/ai-memory-tools
```

From the versioned npm installation, use the shipped commands instead:

```sh
node node_modules/@aviaratech/ai-memory-tools/dist/ensure-postgres.js --status
node node_modules/@aviaratech/ai-memory-tools/dist/init-db.js
```

`init` applies the numbered migrations and records them in `public.ai_memory_pgmigrations`. The CLI fails if the URL is missing or points to a remote host. `AI_MEMORY_MIGRATIONS_DIR` is a controlled packaging/test override; normal installs use migrations shipped with the core package.

## Connect an MCP client

Configure an MCP client that supports stdio servers to launch `node` with the **absolute path** to either this checkout's `packages/ai-memory-tools/dist/server.js` or the installed `node_modules/@aviaratech/ai-memory-tools/dist/server.js` as its argument. For example, adapt this generic server entry to your client's configuration format:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/ai-memory/packages/ai-memory-tools/dist/server.js"]
}
```

Give that server process the same protected `AI_MEMORY_DATABASE_URL`; keep credentials out of a shared client configuration. `npm run mcp -w @aviaratech/ai-memory-tools` starts the same stdio server from the repository root, and the tools package exposes an `ai-memory-mcp` bin. The optional plugin contains skills and hooks; its bundled launcher is built at `plugins/ai-memory/dist/mcp-launcher.js`, and compatible Claude plugin hosts read `plugins/ai-memory/.mcp.json`.

No provider key is needed for basic local storage and text search. `AI_MEMORY_EMBEDDING_PROVIDER=openai` enables the optional OpenAI embedding path and requires `AI_MEMORY_EMBEDDING_API_KEY`; `AI_MEMORY_EMBEDDING_MODEL` defaults to `text-embedding-3-small`. Optional classification uses `AI_MEMORY_CLASSIFY_API_KEY` (or the embedding key) and `AI_MEMORY_CLASSIFY_MODEL`. These features call an external provider and may incur provider charges. Leave them unset for a local-only installation. See [operations](operations.md) before enabling backups.
