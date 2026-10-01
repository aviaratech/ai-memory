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

For a versioned npm installation, create a separate local directory and install the single core package (0.2.1 after its reviewed release):

```sh
mkdir ai-memory-client && cd ai-memory-client
npm init -y
npm install --save-exact @aviaratech/ai-memory@0.2.1
```

The installed package provides `node_modules/@aviaratech/ai-memory/dist/tools/server.js` as its MCP stdio server. Keep this installation with its matching migration files for recovery. After a reviewed 0.2.1 release, the optional plugin is distributed as `aviaratech-ai-memory-plugin-0.2.1.tgz` on its matching GitHub release. After downloading that archive, extract it to a dedicated directory before configuring a compatible plugin host:

```sh
mkdir ai-memory-plugin
tar -xzf aviaratech-ai-memory-plugin-0.2.1.tgz -C ai-memory-plugin --strip-components=1
```

The archive includes the bundled MCP launcher, migrations, license, and third-party notices.

For bootstrap and upgrades, provide `AI_MEMORY_DATABASE_URL` for the database-owning administrator role through your host's protected environment. It must be an explicit `postgresql://` URL for `localhost`, `127.0.0.1`, or `::1` and the dedicated `ai_memory` database. The package does not infer a URL from another service or load a shared `.env` file. After setting it, run these commands from the standalone checkout:

```sh
npm run pg:status -w @aviaratech/ai-memory
npm run init -w @aviaratech/ai-memory
```

From the versioned npm installation, use the shipped commands instead:

```sh
node node_modules/@aviaratech/ai-memory/dist/tools/ensure-postgres.js --status
node node_modules/@aviaratech/ai-memory/dist/tools/init-db.js
```

`init` applies pending numbered migrations with the administrator role and records them in `public.ai_memory_pgmigrations`. Once the ledger contains the complete migration set shipped with the package, initialization verifies its structure and ordered migration names in a read-only transaction. It performs no schema DDL, ledger writes, or sequence changes, including when invoked during MCP startup.

A separate non-owner runtime login can therefore start after the administrator has initialized the matching package. Give that login database connection and schema `USAGE`, the privileges needed by the application on its memory tables, and only `SELECT` on `public.ai_memory_pgmigrations`. It needs no schema `CREATE`, ledger ownership, membership in an administrator role, or privileges on the ledger's sequence. Do not grant application write privileges on the migration ledger. Supply this runtime login's URL to the MCP process through the same protected environment mechanism.

Missing or pending migrations and incompatible ledger structure or history fail initialization with an administrator requirement. Apply upgrades using the matching reviewed package and administrator role before restarting the runtime; do not add runtime DDL privileges or bypass initialization. The ledger records migration names rather than historical SQL content hashes, so retain the matching package and its migration assets for recovery.

The CLI fails if the URL is missing or points to a remote host. `AI_MEMORY_MIGRATIONS_DIR` is a controlled packaging/test override; normal installs use migrations shipped with the core package.

## Connect an MCP client

Configure an MCP client that supports stdio servers to launch `node` with the **absolute path** to either this checkout's `packages/ai-memory/dist/tools/server.js` or the installed `node_modules/@aviaratech/ai-memory/dist/tools/server.js` as its argument. For example, adapt this generic server entry to your client's configuration format:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/ai-memory/packages/ai-memory/dist/tools/server.js"]
}
```

Give that server process the same protected `AI_MEMORY_DATABASE_URL`; keep credentials out of a shared client configuration. `npm run mcp -w @aviaratech/ai-memory` starts the same stdio server from the repository root, and the core package exposes an `ai-memory-mcp` bin. The optional plugin contains skills and hooks; its bundled launcher is built at `plugins/ai-memory/dist/mcp-launcher.js`, and compatible Claude plugin hosts read `plugins/ai-memory/.mcp.json`.

No provider key is needed for basic local storage and text search. `AI_MEMORY_EMBEDDING_PROVIDER=openai` enables the optional OpenAI embedding path and requires `AI_MEMORY_EMBEDDING_API_KEY`; `AI_MEMORY_EMBEDDING_MODEL` defaults to `text-embedding-3-small`. Optional classification uses `AI_MEMORY_CLASSIFY_API_KEY` (or the embedding key) and `AI_MEMORY_CLASSIFY_MODEL`. These features call an external provider and may incur provider charges. Leave them unset for a local-only installation. See [operations](operations.md) before enabling backups.

For a dependency and import mapping from the published 0.1.x tools package, see [Migrating from 0.1.x](api-architecture.md#migrating-from-01x). Existing 0.1.x installs remain usable; the 0.2.1 commands above apply only after that version is published.

## Protected Codex registration

A protected wrapper is an explicitly selected external launch contract. It must use the exact absolute Node executable and one absolute wrapper path, with no inline `env` table. The package does not infer ownership from a script name or read/execute the wrapper during diagnosis. Keep your existing protected environment loader and released MCP launcher in that wrapper. For example, adapt these synthetic paths:

```sh
node node_modules/@aviaratech/ai-memory/dist/tools/codexConnectivity.js doctor --json \
  --node-executable /absolute/selected/bin/node \
  --protected-launcher /absolute/runtime/memory-consumers/mcp-launcher.mjs
node node_modules/@aviaratech/ai-memory/dist/tools/codexConnectivity.js ensure-cli \
  --node-executable /absolute/selected/bin/node \
  --protected-launcher /absolute/runtime/memory-consumers/mcp-launcher.mjs
```

`doctor` is read only. `configured_protected` confirms the exact registration and accessible launch files; it does not establish a successful MCP connection, validate wrapper behavior, or confirm database readiness. The database probe uses only the diagnostic process's environment and reports `not_checked` when that environment cannot supply a usable target. HTTP and launchd checks report their separate service states.

`ensure-cli` preserves a healthy selected registration byte for byte. Explicit repair can correct the Node path and remove inline environment from that same selected wrapper entry. A different wrapper, extra launch arguments, unsupported configuration form, or an undeclared external registration is a conflict and is preserved. Repair parses and validates the complete TOML document, preserves unrelated settings and their value types, and writes atomically; formatting and comments can change during repair. Documents containing TOML date/time values are preserved without repair because the supported runtime's date representation cannot retain all fractional precision. A pre-commit failure preserves the original file. The command does not execute the launcher or activate host services. `--config-path` selects a separate configuration file for controlled inspection or repair. `bootstrap` also starts PostgreSQL and installs services, so use it only with separate host activation authority.

Release 0.2.1 ships migrations `001_baseline` through `007_stored_search_vector`. Its stored search-vector query requires migration 007 to be applied by the database-owning administrator before runtime startup. The six-file 0.2.0 release cannot run against a seven-migration ledger. Retain the exact original release and migration bytes for backup recovery; see [stored search-vector operations](operations.md#stored-search-vector-migration).
