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

For the 0.2.3 helper release, install the exact runtime package in a dedicated local directory. It contains the built native plugin as well as the engine and operational commands; installation needs no source checkout or build:

```sh
mkdir ai-memory-client && cd ai-memory-client
npm init -y
npm install --save-exact --ignore-scripts @aviaratech/ai-memory@0.2.3
npx --no-install ai-memory --version
```

The helper and the native MCP server report the same package version. The matching GitHub release also provides `aviaratech-ai-memory-plugin-0.2.3.tgz`; its plugin files are identical to `node_modules/@aviaratech/ai-memory/plugins/ai-memory`. Retain the exact package, plugin and migrations for recovery. Versions through 0.2.2 have no native helper; preserve their manual configurations until you explicitly choose a migration.

## Install the native plugin

Use the same interface for Codex and Claude Code. Select the host and scope explicitly, and require the version of the runtime package invoking the helper:

```sh
npx --no-install ai-memory plugin install --host codex --scope user --version 0.2.3 --dry-run --json
npx --no-install ai-memory plugin install --host codex --scope user --version 0.2.3 --json
npx --no-install ai-memory plugin doctor --host codex --scope user --json
```

For Claude Code, replace `--host codex` with `--host claude-code`. Its native manager supports `user`, `project` and `local` scopes; run project/local operations from the same project directory. The validated Codex CLI supports user scope. Other Codex scopes report `unsupported` without changing files. A missing or incompatible native manager reports the required action. The helper registers a local marketplace using the selected host's native commands and reads back the selected version and actual installed launcher bytes before reporting `installed`.

Installation does not grant hook trust or restart a running host. Review the native host's hook permissions and reload/restart it explicitly. Results keep native plugin discovery, hook trust/restart, MCP connection and database readiness separate. A successful installation alone leaves MCP and database states `not_checked`.

The helper preserves unrelated host entries, manual ai-memory MCP registrations, plugin data and protected credentials. An existing ai-memory plugin without its matching owned receipt, a disabled/custom policy, conflicting marketplace or corrupt snapshot reports `conflict` for inspection. It does not silently replace that configuration. Dry-run describes the selected operation without invoking the native manager or writing state.

## Configure the plugin runtime

Create a dedicated, regular `~/.config/ai-memory/plugin.env` file owned by your user with mode `0600`; its parent directory must be owned by your user and not writable by other users. Set the explicit loopback database URL there using your trusted editor/protected credential workflow:

```dotenv
AI_MEMORY_DATABASE_URL=postgresql://ai_memory_runtime:YOUR_PASSWORD@127.0.0.1/ai_memory
```

Use a runtime role after the administrator initialization below. The plugin launcher reads this dedicated file using the existing environment parser; native hosts do not consistently forward arbitrary environment variables to plugin MCP processes. Symlinks and exposed credential files are rejected. The installer does not create credentials, start PostgreSQL, initialize a database, install a service or enable a provider. Keep optional provider keys unset for local-only storage/search.

`plugin doctor` reads native registration and installed bytes, validates protected configuration, checks the selected plugin's migration ledger in a read-only transaction, and attempts an MCP handshake only when prerequisites are ready. Its diagnostic MCP process is constrained to read-only database transactions and has provider settings removed. Missing or pending migrations report an administrator requirement even if the configured login is an administrator; diagnosis never applies migrations. Hook trust remains an explicit native-host action after a successful handshake.

## Update, rollback and remove

First install the exact reviewed runtime version you intend to use in this local directory, then invoke `plugin update` with that same `--version`. For example, an installation moving to 0.2.3 uses:

```sh
npm install --save-exact --ignore-scripts @aviaratech/ai-memory@0.2.3
npx --no-install ai-memory plugin update --host codex --scope user --version 0.2.3 --dry-run --json
npx --no-install ai-memory plugin update --host codex --scope user --version 0.2.3 --json
npx --no-install ai-memory plugin rollback --host codex --scope user --json
npx --no-install ai-memory plugin remove --host codex --scope user --json
```

The helper binds immutable plugin snapshots and an installation receipt to the host, native configuration root, user and scope (and project directory for project/local scope). Repeating an installation verifies the current native registration and bytes. Update retains the previous verified snapshot; rollback selects its exact launcher bytes rather than fetching a mutable version. An interrupted mutation retains a pending receipt and requires `plugin rollback` before another mutation. An interrupted first installation can be unwound without a prior version. Recovery reuses a recognized lock only after its owner and recorded native process groups are absent; active or unrecognized locks are preserved for inspection. If interruption leaves an `operation.reclaim` guard, inspect the recorded owner and state before removing that exact guard; the helper preserves it rather than guessing ownership. Corrupt snapshots are never reused.

Rollback changes plugin code, not the database schema. A release with an older migration inventory cannot use a newer ledger; doctor reports that incompatibility. Preserve your database and backups and use an explicitly compatible release rather than reversing migrations automatically. Remove unregisters only the owned native plugin and marketplace, requests Claude's `--keep-data`, and preserves protected environment, plugin data and retained recovery snapshots. Restart/reload the host after update, rollback or removal.

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

For a dependency and import mapping from the published 0.1.x tools package, see [Migrating from 0.1.x](api-architecture.md#migrating-from-01x). Existing 0.1.x installs remain usable. The native helper starts with the 0.2.3 release; earlier versions retain their existing manual setup.

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
