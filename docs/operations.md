# Operations

With `AI_MEMORY_DATABASE_URL` set to the dedicated loopback database, these commands check connectivity, apply migrations, and report health:

```sh
npm run pg:status -w @aviaratech/ai-memory-tools
npm run init -w @aviaratech/ai-memory-tools
npm run health -w @aviaratech/ai-memory-tools -- --json
```

`npm run smoke -w @aviaratech/ai-memory-tools` uses bundled fictional fixtures and writes to the selected database. Run it only against an isolated disposable database. `npm run pg:ensure -w @aviaratech/ai-memory-tools` can start a local service when `AI_MEMORY_POSTGRES_START_COMMAND` is configured; it does not choose a remote database or Docker fallback.

## Encrypted local backup

Back up a dedicated database named `ai_memory` or `ai_memory_<name>`. Set `AI_MEMORY_BACKUP_SOURCE_ID` to a stable, opaque identifier of 8–128 letters, digits, dots, underscores, or hyphens. Set `AI_MEMORY_BACKUP_KEY_FILE` to an **absolute**, owner-only (`0600`) file containing a base64-encoded 32-byte random key. Keep it outside this checkout and the backup directory. `AI_MEMORY_BACKUP_DIR` defaults to `~/.local/share/ai-memory/backups`; it must be owner-only (`0700`) and outside the checkout. `pg_dump` and `pg_restore` 18 must be on `PATH`.

For an interactive run, `AI_MEMORY_DATABASE_URL` supplies the loopback source URL. For scheduling, instead put that URL in a separate owner-only file outside the checkout and set `AI_MEMORY_BACKUP_DATABASE_URL_FILE` to its absolute path. Keep its password out of launchd configuration, command arguments, traces, and public output. Recoverable copies of the encryption key, PostgreSQL recovery credentials, and any S3 credentials must live in **separate** protected channels; a backup archive cannot recover its own key.

After setting those variables through your protected environment, run:

```sh
npm run backup:run-once -w @aviaratech/ai-memory-tools
npm run backup:check -w @aviaratech/ai-memory-tools
npm run backup:status -w @aviaratech/ai-memory-tools
```

`backup:run-once` writes a PostgreSQL 18 custom-format snapshot, validates its inventory and dump, encrypts it with AES-256-GCM, and publishes a completion manifest after sealing. The local result is an encrypted `<backup-id>.aimdr` file and matching `<backup-id>.manifest.json`. `backup:check` exits nonzero if the latest attempt failed or stalled, there is no completed backup, or its snapshot is older than 36 hours; `AI_MEMORY_BACKUP_MAX_AGE_HOURS` changes that freshness threshold. `backup:status` reports the optional launchd job state. A failed attempt retains completed backups and records a stage/reason in `last-attempt.json`.

The optional macOS `backup:install` job proposes a daily 03:00 local schedule. Inspect the generated job and host permissions before enabling it. A daily snapshot can lose about 24 hours of writes after the latest successful run, and **more** if backups fail or are delayed. This is snapshot recovery, not point-in-time recovery. Accept that data-loss window and monitor `backup:check` and launchd stderr before scheduling. A local backup alone does not survive loss of its host.

## Optional S3 copy

Set `AI_MEMORY_S3_BUCKET` and optionally `AI_MEMORY_S3_PREFIX` (default `ai-memory`) to add an off-machine copy. This is optional; ordinary local operation and local backup need no AWS account. The destination must be a private general-purpose bucket with Versioning Enabled, Block Public Access, default server-side encryption, and Object Lock **COMPLIANCE** default retention of at least 30 days. The command checks these controls, uploads the encrypted archive, downloads and verifies its version, then publishes the manifest last. Use a backup principal restricted to bucket preflight and object upload/read/retention checks; it must not be able to delete completed versions or change bucket protection. Keep restore administration and credentials separate. S3 adds storage, request, and transfer charges under your own account. [AWS Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html) explains version retention.

## Restore into a new database

Use PostgreSQL 18, the source backup's extension versions, and the **same ai-memory release or source revision with its original migration files** on the recovery machine. Restore checks a digest of migration names and bytes; a later checkout with added or edited migrations fails with `MIGRATION_CODE_MISMATCH`. Retain a recoverable copy of the matching release separately from the backup and key, and run restore from that release. Apply any later migrations only after the restored database has passed verification. Recover the key and PostgreSQL administrator URL through their independent protected channels. Place a matching encrypted archive and manifest in an owner-only directory outside the checkout, or identify an S3 manifest **key and version ID**. Never point restore at an active memory database: the command creates a new `ai_memory_restore_*` database and refuses an existing target.

Set `AI_MEMORY_BACKUP_DIR` to an owner-only recovery workspace outside the checkout, `AI_MEMORY_BACKUP_KEY_FILE` to the recovered key file, `AI_MEMORY_RESTORE_EXPECT_SOURCE_ID` to the original source ID, `AI_MEMORY_RESTORE_EXPECT_DATABASE` to the original `ai_memory*` database name, and `AI_MEMORY_RESTORE_ADMIN_URL` to a loopback PostgreSQL administrator URL ending in `/postgres`. For a local archive, also set `AI_MEMORY_RESTORE_MANIFEST_FILE` to the absolute manifest path. Then run:

```sh
npm run restore -w @aviaratech/ai-memory-tools
```

For S3 recovery, set `AI_MEMORY_S3_BUCKET`, optional prefix, `AI_MEMORY_RESTORE_MANIFEST_KEY`, and `AI_MEMORY_RESTORE_MANIFEST_VERSION` instead of the local manifest path. The manifest identifies the archive's exact version. Restore authenticates and checks the archive before creating the target, then verifies PostgreSQL and extension versions, migration names, table counts, sequences, and memory smoke. A failed new target is retained for inspection; the command never deletes it or any S3 version. Promote a verified target only through your own separate operational procedure.
