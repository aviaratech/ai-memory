# Operations

## Weekly stale-memory review

For a build containing migration 011 and the stale command, run `ai-memory stale [--project <p>] [--json]` against the configured loopback database. It lists active, unexpired keyed memories with `unverified_30d` when verification is at least 30 days old, and `evidence_closed` when a cited GitHub issue or PR closed strictly after `last_verified_at`. JSON contains `project`, `memoryKey`, `lastVerifiedAt` and `reasons`; it omits memory bodies. The global report preserves unscoped items as `project: null`; a project filter selects only that exact project. Re-storing the same key and unchanged content refreshes verification in place, preserving its ID and creation time.

`GH_TOKEN` or `GITHUB_TOKEN` enables read-only GitHub GET requests. Only `https://github.com/<owner>/<repo>/issues/<number>` and `/pull/<number>` references (strings or `url`/`issue`/`pr` object fields) are checked. Results, including open items, are cached for 24 hours in owner-only `evidence-*.json` files alongside the existing brief cache, qualified by project and reference. Without a token, age flags and valid cached results still work; the command prints one warning and exits 0. Failed GitHub lookups retain age checks and print one advisory; they are not recorded as an open/closed result.

The brief marks old verification and valid cached closures with `(check: unverified_30d)` and `(check: evidence_closed)`. Hooks never contact GitHub; running `stale` refreshes evidence for subsequent brief generation. Non-GitHub references are ignored. Flags do not expire, delete or otherwise change a memory. Review flags and the health report's [per-item use and prune candidates](telemetry.md#per-item-memory-use) before deciding whether to verify or prune a pin.

The following macOS example is documentation only. The operator chooses paths, protects credentials, installs and enables the job. Use absolute paths to the selected Node executable and installed package tools (the same `AI_MEMORY_TOOLS` directory used below). Save an owner-only wrapper such as `/absolute/private/weekly-memory-review.sh`:

```sh
#!/bin/sh
set -eu
umask 077
# This operator-owned, mode-0600 shell environment file supplies
# AI_MEMORY_DATABASE_URL and optionally GH_TOKEN or GITHUB_TOKEN.
set -a
. /absolute/private/memory-review.env
set +a
NODE=/absolute/path/to/node
AI_MEMORY_TOOLS=/absolute/path/to/installed/core/dist/tools
REPORTS=/absolute/private/memory-reports
mkdir -p "$REPORTS"
"$NODE" "$AI_MEMORY_TOOLS/pluginCli.js" stale --project example/catalog --json > "$REPORTS/stale.json.tmp"
mv "$REPORTS/stale.json.tmp" "$REPORTS/stale.json"
"$NODE" "$AI_MEMORY_TOOLS/health-report.js" --days 30 --json > "$REPORTS/health.json.tmp"
mv "$REPORTS/health.json.tmp" "$REPORTS/health.json"
```

Save this plist as `~/Library/LaunchAgents/com.aviaratech.ai-memory.weekly-review.plist`, replacing all placeholder paths. It runs Sundays at 09:00 local time. Keep tokens and database URLs out of the plist and captured output.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.aviaratech.ai-memory.weekly-review</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>/absolute/private/weekly-memory-review.sh</string></array>
  <key>StartCalendarInterval</key><dict><key>Weekday</key><integer>0</integer><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>/absolute/private/memory-review.stdout</string>
  <key>StandardErrorPath</key><string>/absolute/private/memory-review.stderr</string>
</dict></plist>
```

After reviewing the wrapper/plist and selecting a compatible installed build, the operator can enable it with `launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.aviaratech.ai-memory.weekly-review.plist"` and inspect it with `launchctl print "gui/$(id -u)/com.aviaratech.ai-memory.weekly-review"`. Disable only this job with `launchctl bootout "gui/$(id -u)/com.aviaratech.ai-memory.weekly-review"`. These examples do not install, activate, migrate or initialize anything automatically.

With `AI_MEMORY_DATABASE_URL` set to the dedicated loopback database, these commands check connectivity, apply migrations, and report health:

```sh
npm run pg:status -w @aviaratech/ai-memory
npm run init -w @aviaratech/ai-memory
npm run health -w @aviaratech/ai-memory -- --json
```

`npm run smoke -w @aviaratech/ai-memory` uses bundled fictional fixtures and writes to the selected database. Run it only against an isolated disposable database. `npm run pg:ensure -w @aviaratech/ai-memory` can start a local service when `AI_MEMORY_POSTGRES_START_COMMAND` is configured; it does not choose a remote database or Docker fallback.

## Adopting 0.3.0

This checklist is for the operator of **one existing macOS install with manual stdio registrations**. Source/release verification does not execute it on your host. Use Node 24/npm 11 and PostgreSQL 18 with matching `pg_dump`/`pg_restore`. Keep the old package, migration files, configuration preimages and recovery key. Export absolute path variables `AI_MEMORY_INSTALL` (a new versioned install directory), `AI_MEMORY_PREVIOUS_INSTALL` (the old npm install), `AI_MEMORY_ADOPTION_STATE` (an owner-only directory outside either install), and `AI_MEMORY_EDITOR` (your editor executable). Supply the database-owner URL and the [protected backup variables](#encrypted-local-backup) through your existing credential workflow; leave optional S3/provider settings unset unless separately configured. Do not put credentials in the commands or registrations below.

1. **Stage the package and update saved registrations without restarting clients.**

   ```sh
   umask 077
   mkdir -p "$AI_MEMORY_ADOPTION_STATE"
   chmod 700 "$AI_MEMORY_ADOPTION_STATE"
   npm install --prefix "$AI_MEMORY_INSTALL" --save-exact --ignore-scripts @aviaratech/ai-memory@0.3.0
   export AI_MEMORY_TOOLS="$AI_MEMORY_INSTALL/node_modules/@aviaratech/ai-memory/dist/tools"
   export AI_MEMORY_PREVIOUS_TOOLS="$AI_MEMORY_PREVIOUS_INSTALL/node_modules/@aviaratech/ai-memory/dist/tools"
   node -p 'require(process.env.AI_MEMORY_INSTALL + "/node_modules/@aviaratech/ai-memory/package.json").version'
   cp -p "$HOME/.codex/config.toml" "$AI_MEMORY_ADOPTION_STATE/codex.toml.before"
   cp -p "$HOME/.claude.json" "$AI_MEMORY_ADOPTION_STATE/claude.json.before"
   cp -p "$HOME/Library/Application Support/Claude/claude_desktop_config.json" "$AI_MEMORY_ADOPTION_STATE/desktop.json.before"
   "$AI_MEMORY_EDITOR" "$HOME/.codex/config.toml" "$HOME/.claude.json" "$HOME/Library/Application Support/Claude/claude_desktop_config.json"
   ```

   Expected: version `0.3.0`; three private preimages; each saved ai-memory `command`/`args` selects the exact Node executable and the new absolute `dist/tools/server.js`. For a protected wrapper, update only its selected package target through its existing owner/loader procedure instead of removing that loader. Preserve every other field, especially Codex `[mcp_servers.ai-memory.tools.memory_flush]`, and unrelated registrations. Claude Code USER uses `mcpServers.ai-memory` in `.claude.json`; Desktop uses that key in its own file. A native plugin update does not repoint manual entries. Compare the saved files locally; do not publish their contents. **Rollback before migration:** restore the three preimages and the previous wrapper target. Registration changes alone do not prove a running client loaded 0.3.0.

2. **Pause ingestion and all old database clients.** Close Codex, Claude Code and Claude Desktop normally, allow their final session-end hooks to finish, and keep them closed. If the existing Codex ingestion job is installed, unload its exact plist:

   ```sh
   launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.aviaratech.ai-memory.codex-ingest.plist"
   launchctl print "gui/$(id -u)/com.aviaratech.ai-memory.codex-ingest"
   ```

   Expected: the job is absent (`print` exits nonzero); an already absent job needs no removal. Confirm no manual ingestion, session-end hooks, MCP clients or scheduled backups remain in flight through your existing process/DB monitoring. Do not proceed on an uncertain writer. Keep ingestion paused through step 6. **Rollback:** restore the saved registration/hook selections; reload only a previously installed job after choosing a compatible database/package pair.

3. **Preserve a pre-010 recovery point, initialize, then take the cleanup backup.** Use a separate protected backup directory for the previous package's backup so the two releases never share pending backup state. With `AI_MEMORY_BACKUP_DIR` selecting that old-version recovery directory:

   ```sh
   node "$AI_MEMORY_PREVIOUS_TOOLS/backup-launchd-agent.js" run-once
   node "$AI_MEMORY_PREVIOUS_TOOLS/disaster-recovery.js" status
   ```

   Expected: `{"stage":"complete",...}` and then `{"stage":"status","state":"healthy",...}`, both exit 0. Retain that archive, manifest, key and **executing previous package** together through separate protected channels. Record its backup id. If no compatible previous backup command is available, establish and verify the equivalent pre-upgrade recovery point before continuing.

   Switch `AI_MEMORY_BACKUP_DIR` to a different owner-only 0.3.0 backup directory; keep the same source identity and database target. Then:

   ```sh
   node "$AI_MEMORY_TOOLS/init-db.js"
   node "$AI_MEMORY_TOOLS/backup-launchd-agent.js" run-once
   node "$AI_MEMORY_TOOLS/disaster-recovery.js" status
   ```

   Expected: `[ai-memory] schema is ready (...)` after migrations through `010_index_first_search`, backup stage `complete`, and status `healthy`, all exit 0. These are the packaged equivalents of `init`, `backup:run-once` and `backup:check`. **Stop on any failed check.** A pre-010 backup is for rollback; cleanup needs this fresh 0.3.0 backup of the migrated database. **Rollback after migration:** restore the previous backup with its matching previous package into a new database, verify it, then switch clients to that verified target. An older initializer rejects the 010 ledger; changing registrations alone cannot undo it.

4. **Inspect and install the optional daily backup job.** Set `AI_MEMORY_BACKUP_DATABASE_URL_FILE` to the owner-only URL file for this database, outside the backup directory/install; keep the key in its separate owner-only file. Retain a pre-existing job's plist/schedule before replacement. On macOS:

   ```sh
   node "$AI_MEMORY_TOOLS/backup-launchd-agent.js" install --dry-run
   node "$AI_MEMORY_TOOLS/backup-launchd-agent.js" install
   node "$AI_MEMORY_TOOLS/backup-launchd-agent.js" status
   ```

   Expected: a redacted plist preview, then `{"label":"com.aviaratech.ai-memory.backup","schedule":"daily at 03:00","status":"installed"}` and status `loaded`. This is `backup:install`; it schedules snapshots, not point-in-time recovery. Accept the [snapshot loss window](#encrypted-local-backup) before enabling it. **Rollback:** `node "$AI_MEMORY_TOOLS/backup-launchd-agent.js" uninstall`, then restore/reload only the previous owned job if one existed. During synthetic review, isolate HOME and use a fixture `launchctl`; never bootstrap the real GUI domain.

5. **Review the cleanup dry run and capture its backup id.**

   ```sh
   node "$AI_MEMORY_TOOLS/cleanup.js" --dry-run --json > "$AI_MEMORY_ADOPTION_STATE/cleanup-plan.json"
   node -e 'const p=require(process.env.AI_MEMORY_ADOPTION_STATE+"/cleanup-plan.json"); if(p.mode!=="dry-run" || p.backup.state!=="healthy" || !p.backup.backupId) process.exit(1); console.log(JSON.stringify({backupId:p.backup.backupId,totals:p.report.totals,kept:p.report.kept},null,2))'
   export AI_MEMORY_CLEANUP_BACKUP_ID="$(node -p 'require(process.env.AI_MEMORY_ADOPTION_STATE+"/cleanup-plan.json").backup.backupId')"
   ```

   Expected: dry-run mode, healthy backup, a UUID, per-table deletion totals and kept counts; no data deleted. Review source/category reasons and lineage/contested protection in the full plan. `backup:check` itself does not print the id. **Stop if unhealthy or missing an id.** No rollback is needed for the read-only plan. If the backup changes, rerun and review this step.

6. **Apply only the reviewed backup-bound cleanup.**

   ```sh
   node "$AI_MEMORY_TOOLS/disaster-recovery.js" status
   node "$AI_MEMORY_TOOLS/cleanup.js" --apply --backup-id "$AI_MEMORY_CLEANUP_BACKUP_ID" --vacuum-full --json > "$AI_MEMORY_ADOPTION_STATE/cleanup-applied.json"
   node -e 'const p=require(process.env.AI_MEMORY_ADOPTION_STATE+"/cleanup-applied.json"); if(p.mode!=="apply" || p.maintenanceWarning) process.exit(1); console.log(JSON.stringify({totals:p.report.totals,kept:p.report.kept,sizesBefore:p.sizesBefore,sizesAfter:p.sizesAfter},null,2))'
   ```

   Expected: healthy backup; apply totals match the unchanged reviewed plan; curated/lineage/contested rows remain. `VACUUM FULL` takes table locks. A `maintenanceWarning` means deletions **already committed**, even if the cleanup command exited 0; investigate maintenance rather than blindly reapplying. A failed `backup:check` must stop the procedure. Cleanup independently refuses an unhealthy/mismatched backup and refuses `--apply` without `--backup-id` before deletion. This is covered by [`corpus-cleanup.integration.test.ts`](../packages/ai-memory/src/db/corpus-cleanup.integration.test.ts) and the CLI argument tests. **Rollback:** restore this 0.3.0 backup with 0.3.0 into a new database and verify it before any switch; it cannot restore a pre-010 ledger.

7. **Resume only compatible clients and the previously enabled ingestion job.** Restore the intended hook selections, reopen the three clients against the migrated 0.3.0 target, and, only if it was enabled before step 2:

   ```sh
   launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.aviaratech.ai-memory.codex-ingest.plist"
   launchctl print "gui/$(id -u)/com.aviaratech.ai-memory.codex-ingest"
   ```

   Expected: the owned job is loaded; each new client session completes its normal MCP connection/tool discovery, including Codex `memory_flush`. Update any ingestion/hook command still selecting the old package before re-enabling it. Stop on old executable/launcher selection or schema errors. This proves the fresh sessions only, not an already running conversation. **Rollback:** pause again and use the compatible restore procedure from step 3 or 6.

8. **Backfill kept knowledge when an embedding provider is configured.**

   ```sh
   node "$AI_MEMORY_TOOLS/scripts/backfill-embeddings.js" --dry-run --skip-init
   node "$AI_MEMORY_TOOLS/scripts/backfill-embeddings.js" --apply --skip-init
   node "$AI_MEMORY_TOOLS/scripts/backfill-embeddings.js" --dry-run --skip-init
   ```

   Expected: JSON `{dryRun,total,embedded,errors,skipped,batches,...}`; the apply has `errors: 0`, and the final pending `total` is 0 on a quiescent fixture. New writes during real operation can add pending work. Dry-run needs no provider. With no provider configured, **omit apply**: it otherwise exits 1 with `Embedding provider not configured`; retain the measured pending count and use local text search. Do not claim vectors were filled. A configured provider may incur charges. Existing vectors and memory `updated_at` are preserved. **Rollback:** stop provider work; restore the step-6 backup if undoing new vectors is required.

9. **Record health numbers and observe the adopted install.**

   ```sh
   node "$AI_MEMORY_TOOLS/health-report.js" --days 7 --json > "$AI_MEMORY_ADOPTION_STATE/health-after.json"
   node "$AI_MEMORY_TOOLS/disaster-recovery.js" status
   ```

   Expected: health JSON including `database.durableMemoriesCreated`, `durableMemoriesUpdated`, `ingestionFailures` and continuity readiness; backup remains healthy. Compare cleanup kept/deleted counts, table bytes and backfill pending/errors with the saved reports. Health reads its selected logs/transcripts/retros too; synthetic review supplies isolated empty paths with `--log-file`, `--transcripts-dir`, `--retros-dir`. A clean synthetic run does not establish a real seven-day error rate, corpus reduction or p95 latency. Measure those separately; existing #32–34 operational acceptance remains open. **Rollback:** stop writers and restore a verified, matching package/backup into a new database using [restore](#restore-into-a-new-database); promote it only after verification. Keep both pre-010 and 0.3.0 recovery assets until operational acceptance.

## Task workflow telemetry

For a build containing migration009, `ai-memory-mcp telemetry:ingest` accepts one strict content-free event from stdin. `ai-memory-mcp telemetry:report --project <digest> --task <id> --json` and `npm run health -w @aviaratech/ai-memory -- --workflow --project <digest> --task <id> --json` use the same bounded task report, before legacy collectors. See [telemetry](telemetry.md) for the event contract, source coverage, token-subset accounting, correlation, replay, retention and synthetic example. Applying migrations and enabling installed hooks require their own authorized deployment; the ingest path does not provision or activate them.

## Knowledge search and embedding maintenance

Default `memory_search` and recent `memory_recall` exclude unkeyed session summaries, checkpoints and records marked by the `manual-flush`/`memory-flush` source or `memory-flush` tag. Existing keyed facts remain shared knowledge. This changes eligibility before candidate ranking; it does not delete, expire, rewrite or consolidate records. Pass the existing exact `sessionId` selector to `memory_search` to search that session's retained history. Project and status/expiry filters still apply; use `includeInactive` explicitly when recovering expired or superseded history.

`memory_flush` writes no memories, so it requests no embeddings; rows that older versions wrote are skipped and removed by `cleanup` (below). Durable writes with `memory_store` are embedded on write. Write plain sentences with spaces and preserve negation and source references. The compressed-text warning identifies suspect producer input; it does not invent word boundaries or change that text. Search previews keep their existing size bounds, and `memory_get` remains the full-record path.

The existing embedding backfill counts and batches only active, unexpired eligible knowledge with missing vectors. Session summaries remain excluded even if keyed because the embedding provider deliberately skips that category, and rows with a flush source are skipped because `cleanup` removes them. Adding a vector leaves `updated_at` unchanged. Its default dry-run performs only the pending-count query: it neither initializes the database nor requires or calls an embedding provider. Use an already initialized, explicitly approved database; source qualification does not grant access to an operator corpus.

```sh
npm run backfill:embeddings -w @aviaratech/ai-memory -- --dry-run --skip-init
```

Review the eligible count and existing provider/cost scope before `--apply`. Apply rechecks eligibility, unchanged content and a still-missing vector when updating. The existing bounded batches and stable ID cursor remain in use. A later run skips committed vectors and retries incomplete rows; it does not embed the excluded session population. Preserve the full run output privately and distinguish the proposed count from completed writes. No provider, service or schedule is added.

## Verified project-scope backfill

From a matching reviewed source workspace, `backfill:project-scope` can reunite eligible bare-name scope projections with a qualified `owner/repo` scope. It requires an explicitly configured, already initialized loopback database. It never initializes or repairs a schema, starts a service, calls a provider, or scans every project. Source verification on disposable data does not authorize running it against an installed corpus.

Dry-run is the default and uses a read-only repeatable-read transaction. Select the exact qualified repository and its basename; an optional `--session-id` is an exact native producing-session ID, distinct from a logical task ID. Discovery and the entire dependency closure must fit `--limit` (default 200, maximum 5,000). An incomplete unit refuses; narrow it with an exact session rather than raising the bound or accepting a partial unit.

```sh
npm run backfill:project-scope -w @aviaratech/ai-memory -- \
  --project example/catalog --legacy-project catalog \
  --session-id actual-producing-session --out new-reviewed-plan.json
```

`--dry-run` may be explicit. The bounded JSON plan contains native IDs, evidence classifications, before/after fingerprints, scope/hash transitions and a digest; it omits memory content, raw historical payloads and credentials. Treat native IDs and repository evidence as protected local operational data. `--out` atomically creates a new owner-only file and refuses existing files or symlinks. Stdout is also supported; arrange its destination without overwriting existing evidence. Output and plan input are limited to 32 MiB; input must be a regular non-symlink file.

The target is a selector, not evidence that an arbitrary bare row belongs to it. Eligibility requires consistent repository fields on that row or its exact producing session. Supported assertions are `owner/repo` and explicit lowercase `github.com/owner/repo`; raw repository fields remain preserved. Existing hostless slugs do not independently attest a provider. Unknown and wholly foreign same-basename records stay isolated. Mixed repository claims and contradictory session dependencies refuse the unit. A memory's own claim never grants authority to an unqualified session, sibling memory or continuity pack. No task/title/recency/sole-row inference or global basename alias is created.

Before apply, establish writer quiescence through your separately authorized host procedure. This is offline maintenance. Short existing-table `SHARE ROW EXCLUSIVE` locks with `NOWAIT` protect the checked transaction state; a busy table refuses immediately with `maintenance_lock_busy` and `retryable: true`. These locks do not establish host quiescence or stop a previously reading client from submitting a later stale write. This command does not stop writers or grant operational admission.

Review the complete plan and its limitations, then apply those exact bytes with its printed digest:

```sh
npm run backfill:project-scope -w @aviaratech/ai-memory -- \
  --apply --plan-file new-reviewed-plan.json --expect-plan sha256:<digest> \
  --out new-apply-receipt.json
```

Apply rejects changed selectors, code/artifacts, migration history, schema/namespace, input rows and newly occupied targets. There is no force mode. It updates only verified project/session repository/continuity-key projections and reproducible unkeyed dedupe hashes. Native IDs, source/client/session/logical-task provenance, durable keys, content, status, first expiry, timestamps, references, lineage and historical JSON stay intact. PostgreSQL maintains its generated search vector. Scope-key suffixes, including colons, are preserved. Canonical key, dedupe or continuity collisions refuse the complete unit; records are never overwritten, semantically consolidated, superseded or deleted by this command.

Historical generated durable keys and keyed-row dedupe hashes remain opaque historical identities. Explicit-key lookup/upsert continues to reach the original ID. A caller that discards that key and derives a new canonical key may create a separate future keyed row; universal implicit-key coalescence is not provided. The plan exposes prospective canonical keys and refuses existing collisions rather than inventing aliases or rekeying caller references. Legacy NULL unkeyed hashes remain NULL; unknown or unreproducible non-NULL hashes refuse.

Versioned `project-scope-backfill:v1` transition events and `project-scope-backfill-unit:v1` completion events append to existing audit tables in the same transaction as updates. A completion uses an actual native session or memory anchor; no synthetic host session is fabricated. Replaying the original plan skips a compatible committed unit without duplicate audit. Uncommitted interruption rolls back and the original complete plan can be retried. Changed/corrupt/missing/conflicting receipts, incompatible code/schema/namespace or changed post-state refuse and require deliberate replanning. PostgreSQL sequence gaps after a failed apply are expected and must not be reset. Dry-run allocates no sequence values.

Plans bind the executing source or packaged module bytes, Node version and resolved database timeouts, so rebuilding or switching artifacts/configuration requires replanning. Preflight requires compatible column types, generated search expressions, integrity/query indexes, constraints and the canonical append-only trigger; additional columns remain fingerprinted. Database rows transferred for one unit, including committed replay, are capped at 32 MiB; oversized input refuses before changes. Native JSON numbers must survive an exact decimal round trip through the runtime; otherwise `native_numeric_precision` refuses the unit rather than rounding its integrity fingerprint. Collision-only rows remain observations and never expand the chosen mutation scope. Multiple narrowed units are independent invocations, not an automatic batch job. Keep reviewed plans and receipts; a committed unit has no automatic destructive inverse. If result-file publication fails after a commit, use a new output path and replay the original plan to recover its recorded completion. Existing backup/restore procedures and any live corpus or consolidation work require their own operational scope.

## Removing data ai-memory no longer keeps

ai-memory keeps durable, reusable knowledge written with `memory_store`. Each such memory needs a stable `memoryKey`, at least one `evidenceRefs` entry and plain sentences, and the write is rejected if it contains secrets, email addresses or home-folder paths. `memory_flush` and session-end ingestion write session state only: the session snapshot, its delta and events, and the continuity pack.

Older versions also stored flush decisions, root causes, checkpoints and reflections as memories, promoted ingested session summaries when `AI_MEMORY_AUTO_DURABLE_PROMOTION` was set, and recorded inline consolidation events. The `cleanup` command removes that data. It never runs at startup or on a schedule.

```sh
ai-memory cleanup                                   # dry run: counts by table, reason, source and category
ai-memory cleanup --apply --backup-id <backup-id>   # delete, using the backup the dry run named
```

`npm run cleanup -w @aviaratech/ai-memory -- ...` runs the same command from a checkout. The dry run is read-only and the default. It removes:

- memories written by `memory_flush` (the `manual-flush` source with no key or a derived key);
- automatically promoted session summaries, and any other session summary whose expiry has passed;
- session snapshots and deltas older than the history window (30 days before the backup by default, `--history-days N`), except the latest snapshot and delta of each session, the flush snapshots that carry-forward reads (the newest one and the newest holding each continuity field) and the deltas behind kept snapshots. Sessions with patch-mode deltas are left whole;
- `consolidation_metrics` session events, and the audit events of deleted memories.

Memories written with `memory_store` are kept, apart from expired session summaries. A removable row also stays when a `supersedes_id` chain links it to a kept memory in either direction (for example a flush fragment that refined a curated memory), or when it is contested, so `memory_resolve_contested` can still pair it. Other links recorded only in metadata are not followed.

`--apply` refuses unless `backup:check` reports a healthy backup of the same database, taken with this version, and `--backup-id` names that backup. The dry run prints the id; if a newer backup completes in between, rerun and review the dry run. Without such a backup, the dry run counts against the current time, so it shows more rows than an apply would delete.

Memories are deleted only if they were created and last updated at least one hour before the backup started, so they can be restored from it. Snapshot and delta times come from the session that produced them, so run the apply right after the backup with session ingestion paused (the Codex launchd job and the Claude and Codex session-end hooks); otherwise an old session ingested after the backup could lose rows that the backup lacks. All deletions run in one statement, and on unchanged data the apply removes exactly the rows the dry run counted. Use a database URL whose role owns the tables. Deleted space is reused by PostgreSQL; `--vacuum-full` also rewrites the cleaned tables to return disk space, which locks each table briefly. If that maintenance fails, the deletions stay committed and the report says what did not finish.

After the cleanup, `npm run backfill:embeddings -w @aviaratech/ai-memory -- --apply` adds embeddings to kept memories that lack one. It skips session summaries, expired rows and flush rows, and does not change `updated_at`.

## Stored search-vector migration

Source migration `007_stored_search_vector` follows the six migrations in the released 0.2.0 package. It adds a generated stored text-search vector using the existing search expression. PostgreSQL maintains it on inserts and updates; adoption backfills existing records, rewrites the table and requires an exclusive table lock. Allow for the additional storage and write cost when scheduling an approved upgrade with its matching package. A canceled migration rolls back its column and ledger entry; initialization discards the failed connection so a retry can resume the pending migration.

After adopting 007, the six-migration 0.2.0 initializer rejects the longer ledger. Retaining the old indexes does not enable a code-only rollback. Recovery to 0.2.0 uses a verified backup from the six-migration database and the original 0.2.0 package, restored into a new database through the procedure below. A backup taken after 007 instead requires the matching seven-migration source or release. Restore enforces the migration-code digest; mixing those assets fails with `MIGRATION_CODE_MISMATCH`. Keep the corresponding package and recovery credentials with each backup through the existing separate protected channels.

## Memory access-time migration

Source migration `008_memory_last_accessed_at` adds a nullable `last_accessed_at` column. Search and recall record access there, so reading a memory no longer changes its `updated_at`. The column has no default, so adoption changes only the catalog and does not rewrite the table. An administrator applies it with the matching package before runtime startup. As with 007, an earlier initializer rejects the longer ledger, and recovery to that release uses a backup taken before adoption together with the matching package.

To measure search latency, run `npm run search:benchmark -w @aviaratech/ai-memory` against an empty disposable database. It seeds 40,000 synthetic memories by default (`--rows` changes this), times many-term, long and issue-reference queries, and removes its rows. It refuses to run against a database that holds any other memories.

## Index-first search migration

Source migration `010_index_first_search` changes how `memory_search` finds candidates. Search no longer ranks every row that matches one of its terms. Each channel reads an index and returns at most 100 ids per read: rows matching the whole websearch query (newest first); rows matching the rarest query terms, ordered by a rarity-weighted count of the terms they contain; exact memory keys and exact tags (two indexes, so up to 200 ids); and issue or pull-request numbers in the query text, through the number terms the stored vector already holds. References that appear only in the active goal never select a row by themselves. Up to 32 query terms are probed, longest first. A term that matches more than 2,000 rows is too common to select candidates, and a term the query negates never does. When the whole-query and rare-term channels together return fewer than 50 rows, the newest rows that match any query term fill the pool, so a query made only of common terms still gets candidates. A row that matches any query term and also holds an issue number from the active goal enters through its own channel, so a goal can still move such rows to the top. Ranks, keyword hints and reference hints are computed only for the union of the channels, then the existing candidate limits and reranking apply. The vector channel is unchanged.

When more rows match than a channel returns, the channel chooses by recency and term rarity, not by how densely the terms occur. For queries whose terms are all very common, the top results can therefore differ from the previous release's densest-match ordering. The whole-query and any-term reads return at most 100 ids but consider every row the index says matches, without evaluating its vector, so a term that occurs in most of a large corpus costs time proportional to its matches (about a microsecond per matching row in the synthetic benchmark). A query that only negates terms scans the whole index.

The migration builds a GIN index on `search_vector` (`ai_memory_entries_search_vector_idx`, `fastupdate` off so a query never scans a pending list) and a replacement for `ai_memory_entries_author_category_created_idx` keyed on `lower(category)`, which is how the reversal-prior lookups compare categories (the earlier index keyed on `category`, so no query could use it). It turns `fastupdate` off for the tags index and merges its pending list, because search now reads that index on every call and every read scans a pending list in full. Last, it drops the two expression indexes that no longer serve any query (`ai_memory_entries_search_idx`, the 003 expression without reference terms, and `ai_memory_entries_reference_search_idx`, the same expression as the stored column) and the old author/category index. The trigram and tags indexes stay because the token fallback and temporal search still use them, and the migration leaves every other index alone.

The whole migration took about 0.6 seconds on a corpus of 40,600 rows. The index builds block writes; reads continue until the tags-index setting and the drops, which take exclusive locks that last until the migration commits. The builds cannot be `CONCURRENTLY` because each migration runs in a transaction. As with 007 and 008, an earlier initializer rejects the longer ledger, so a previous package cannot start against the migrated database; recovery to the previous release uses a backup taken before adoption together with the matching package. Stop running processes of the previous release before applying the migration: they keep working, but their expression-based search has no index to read and evaluates the expression for every row.

`npm run search:benchmark -w @aviaratech/ai-memory -- --explain` also plans and runs one query per class with the default planner settings and reports the indexes it reads, any sequential scan of the memory table, and the most rows one scan of that table read and then discarded. A high discarded count means a filter ran over an index-order walk.

## Encrypted local backup

Back up a dedicated database named `ai_memory` or `ai_memory_<name>`. Set `AI_MEMORY_BACKUP_SOURCE_ID` to a stable, opaque identifier of 8–128 letters, digits, dots, underscores, or hyphens. Set `AI_MEMORY_BACKUP_KEY_FILE` to an **absolute**, owner-only (`0600`) file containing a base64-encoded 32-byte random key. Keep it outside this checkout and the backup directory. `AI_MEMORY_BACKUP_DIR` defaults to `~/.local/share/ai-memory/backups`; it must be owner-only (`0700`) and outside the checkout. `pg_dump` and `pg_restore` 18 must be on `PATH`.

For an interactive run, `AI_MEMORY_DATABASE_URL` supplies the loopback source URL. For scheduling, instead put that URL in a separate owner-only file outside the checkout and set `AI_MEMORY_BACKUP_DATABASE_URL_FILE` to its absolute path. Keep its password out of launchd configuration, command arguments, traces, and public output. Recoverable copies of the encryption key, PostgreSQL recovery credentials, and any S3 credentials must live in **separate** protected channels; a backup archive cannot recover its own key.

After setting those variables through your protected environment, run:

```sh
npm run backup:run-once -w @aviaratech/ai-memory
npm run backup:check -w @aviaratech/ai-memory
npm run backup:status -w @aviaratech/ai-memory
```

`backup:run-once` writes a PostgreSQL 18 custom-format snapshot, validates its inventory and dump, encrypts it with AES-256-GCM, and publishes a completion manifest after sealing. The backup's creation time is recorded just before the snapshot starts, so rows committed before it are in the archive, and the completion record names the database it came from. `cleanup --apply` relies on both, so take a fresh backup with this version before a cleanup. The local result is an encrypted `<backup-id>.aimdr` file and matching `<backup-id>.manifest.json`. `backup:check` exits nonzero if the latest attempt failed or stalled, there is no completed backup, or its snapshot is older than 36 hours; `AI_MEMORY_BACKUP_MAX_AGE_HOURS` changes that freshness threshold. `backup:status` reports the optional launchd job state. A failed attempt retains completed backups and records a stage/reason in `last-attempt.json`.

Every backup entry point acquires exclusive ownership of the canonical backup directory before changing recovery state or starting backup work. An overlapping invocation exits nonzero with `BACKUP_BUSY` without changing the owner's checkpoints, status, archives or ownership. Directory aliases share the same ownership; independent directories can run independently. Ownership remains held until the command's existing resource cleanup completes.

The private `.backup-owner.json` records a run nonce, host, PID/birth, directory identity and work phase. `.backup-reclaim.json` serializes ownership changes. A live owner is never displaced because of age. A stopped owner can be reclaimed automatically only if it had not begun work or durably recorded completed resource cleanup. A dead PID with an active work phase does **not** prove detached tools stopped: that state, mismatched identity, malformed/unsafe files and interrupted reclamation fail closed with `BACKUP_OWNER_UNCERTAIN` or `BACKUP_BUSY`.

For an uncertain/interrupted lock, preserve the directory, both ownership files, encrypted archives and pending checkpoint. Quiesce scheduled/manual invocations through your existing operator procedure. On the recorded host, independently verify the exact recorded PID/birth and any backup/provider/database resources are stopped; a reused PID, elapsed age or an absent parent alone is insufficient. If identity or resource closure cannot be established, keep the lock and investigate rather than retrying deletion. Only after verified closure and with competing invocations quiescent may the matching stale ownership/reclamation files be removed manually; do not remove archive, checkpoint or status files. Retry through the normal backup command so existing source/key/migration/script compatibility checks govern resume. This is a local-filesystem protocol and does not promise cross-host/network-filesystem locking.

Backup and restore subprocesses have no total elapsed-time deadline. Connection and provider request timeouts still apply. On macOS and Linux, `SIGINT` or `SIGTERM` cancels the command, disconnects its PostgreSQL clients, terminates its owned subprocess groups, and allows five seconds for process closure before forcing termination. The command also closes outstanding sibling processes when a parallel preflight fails. It unwinds temporary files, preserves completed archives and compatible pending-upload checkpoints, and records `COMMAND_CANCELLED` for an interrupted backup. A compatible retry reuses the sealed archive; an interrupted restore retains its new target for inspection. Cancellation does not promote a partial result to a completed backup or verified restore.

The optional macOS `backup:install` job proposes a daily 03:00 local schedule. Inspect the generated job and host permissions before enabling it. A daily snapshot can lose about 24 hours of writes after the latest successful run, and **more** if backups fail or are delayed. This is snapshot recovery, not point-in-time recovery. Accept that data-loss window and monitor `backup:check` and launchd stderr before scheduling. A local backup alone does not survive loss of its host.

## Optional S3 copy

Set `AI_MEMORY_S3_BUCKET` and optionally `AI_MEMORY_S3_PREFIX` (default `ai-memory`) to add an off-machine copy. This is optional; ordinary local operation and local backup need no AWS account. The destination must be a private general-purpose bucket with Versioning Enabled, Block Public Access, default server-side encryption, and Object Lock **COMPLIANCE** default retention of at least 30 days. The command checks these controls, uploads the encrypted archive, downloads and verifies its version, then publishes the manifest last. Use a backup principal restricted to bucket preflight and object upload/read/retention checks; it must not be able to delete completed versions or change bucket protection. Keep restore administration and credentials separate. S3 adds storage, request, and transfer charges under your own account. [AWS Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html) explains version retention.

## Restore into a new database

Use PostgreSQL 18, the source backup's extension versions, and the **same ai-memory release or source revision with its original migration files** on the recovery machine. Restore checks a digest of migration names and bytes; a later checkout with added or edited migrations fails with `MIGRATION_CODE_MISMATCH`. Retain a recoverable copy of the matching release separately from the backup and key, and run restore from that release. Apply any later migrations only after the restored database has passed verification. Recover the key and PostgreSQL administrator URL through their independent protected channels. Place a matching encrypted archive and manifest in an owner-only directory outside the checkout, or identify an S3 manifest **key and version ID**. Never point restore at an active memory database: the command creates a new `ai_memory_restore_*` database and refuses an existing target.

Set `AI_MEMORY_BACKUP_DIR` to an owner-only recovery workspace outside the checkout, `AI_MEMORY_BACKUP_KEY_FILE` to the recovered key file, `AI_MEMORY_RESTORE_EXPECT_SOURCE_ID` to the original source ID, `AI_MEMORY_RESTORE_EXPECT_DATABASE` to the original `ai_memory*` database name, and `AI_MEMORY_RESTORE_ADMIN_URL` to a loopback PostgreSQL administrator URL ending in `/postgres`. For a local archive, also set `AI_MEMORY_RESTORE_MANIFEST_FILE` to the absolute manifest path. Then run:

```sh
npm run restore -w @aviaratech/ai-memory
```

For S3 recovery, set `AI_MEMORY_S3_BUCKET`, optional prefix, `AI_MEMORY_RESTORE_MANIFEST_KEY`, and `AI_MEMORY_RESTORE_MANIFEST_VERSION` instead of the local manifest path. The manifest identifies the archive's exact version. Restore authenticates and checks the archive before creating the target, then verifies PostgreSQL and extension versions, migration names, table counts, sequences, and memory smoke. A failed new target is retained for inspection; the command never deletes it or any S3 version. Promote a verified target only through your own separate operational procedure.
