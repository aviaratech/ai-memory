# Operations

With `AI_MEMORY_DATABASE_URL` set to the dedicated loopback database, these commands check connectivity, apply migrations, and report health:

```sh
npm run pg:status -w @aviaratech/ai-memory
npm run init -w @aviaratech/ai-memory
npm run health -w @aviaratech/ai-memory -- --json
```

`npm run smoke -w @aviaratech/ai-memory` uses bundled fictional fixtures and writes to the selected database. Run it only against an isolated disposable database. `npm run pg:ensure -w @aviaratech/ai-memory` can start a local service when `AI_MEMORY_POSTGRES_START_COMMAND` is configured; it does not choose a remote database or Docker fallback.

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

## Stored search-vector migration

Source migration `007_stored_search_vector` follows the six migrations in the released 0.2.0 package. It adds a generated stored text-search vector using the existing search expression. PostgreSQL maintains it on inserts and updates; adoption backfills existing records, rewrites the table and requires an exclusive table lock. Allow for the additional storage and write cost when scheduling an approved upgrade with its matching package. A canceled migration rolls back its column and ledger entry; initialization discards the failed connection so a retry can resume the pending migration.

After adopting 007, the six-migration 0.2.0 initializer rejects the longer ledger. Retaining the old indexes does not enable a code-only rollback. Recovery to 0.2.0 uses a verified backup from the six-migration database and the original 0.2.0 package, restored into a new database through the procedure below. A backup taken after 007 instead requires the matching seven-migration source or release. Restore enforces the migration-code digest; mixing those assets fails with `MIGRATION_CODE_MISMATCH`. Keep the corresponding package and recovery credentials with each backup through the existing separate protected channels.

## Memory access-time migration

Source migration `008_memory_last_accessed_at` adds a nullable `last_accessed_at` column. Search and recall record access there, so reading a memory no longer changes its `updated_at`. The column has no default, so adoption changes only the catalog and does not rewrite the table. An administrator applies it with the matching package before runtime startup. As with 007, an earlier initializer rejects the longer ledger, and recovery to that release uses a backup taken before adoption together with the matching package.

To measure search latency, run `npm run search:benchmark -w @aviaratech/ai-memory` against an empty disposable database. It seeds 40,000 synthetic memories by default (`--rows` changes this), times many-term, long and issue-reference queries, and removes its rows. It refuses to run against a database that holds any other memories.

## Encrypted local backup

Back up a dedicated database named `ai_memory` or `ai_memory_<name>`. Set `AI_MEMORY_BACKUP_SOURCE_ID` to a stable, opaque identifier of 8–128 letters, digits, dots, underscores, or hyphens. Set `AI_MEMORY_BACKUP_KEY_FILE` to an **absolute**, owner-only (`0600`) file containing a base64-encoded 32-byte random key. Keep it outside this checkout and the backup directory. `AI_MEMORY_BACKUP_DIR` defaults to `~/.local/share/ai-memory/backups`; it must be owner-only (`0700`) and outside the checkout. `pg_dump` and `pg_restore` 18 must be on `PATH`.

For an interactive run, `AI_MEMORY_DATABASE_URL` supplies the loopback source URL. For scheduling, instead put that URL in a separate owner-only file outside the checkout and set `AI_MEMORY_BACKUP_DATABASE_URL_FILE` to its absolute path. Keep its password out of launchd configuration, command arguments, traces, and public output. Recoverable copies of the encryption key, PostgreSQL recovery credentials, and any S3 credentials must live in **separate** protected channels; a backup archive cannot recover its own key.

After setting those variables through your protected environment, run:

```sh
npm run backup:run-once -w @aviaratech/ai-memory
npm run backup:check -w @aviaratech/ai-memory
npm run backup:status -w @aviaratech/ai-memory
```

`backup:run-once` writes a PostgreSQL 18 custom-format snapshot, validates its inventory and dump, encrypts it with AES-256-GCM, and publishes a completion manifest after sealing. The local result is an encrypted `<backup-id>.aimdr` file and matching `<backup-id>.manifest.json`. `backup:check` exits nonzero if the latest attempt failed or stalled, there is no completed backup, or its snapshot is older than 36 hours; `AI_MEMORY_BACKUP_MAX_AGE_HOURS` changes that freshness threshold. `backup:status` reports the optional launchd job state. A failed attempt retains completed backups and records a stage/reason in `last-attempt.json`.

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
