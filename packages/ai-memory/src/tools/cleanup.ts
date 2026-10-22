#!/usr/bin/env node

/**
 * CLI: ai-memory cleanup
 *
 * Removes stored data ai-memory no longer keeps (see retention/corpusCleanup.ts).
 * The default is a read-only dry run. --apply needs a healthy `backup:check`
 * result and deletes only rows created before that backup was taken. This
 * command is never run at startup or on a schedule.
 */

import type { DbClient, DbPool } from '@aviaratech/ai-memory/internal';

import { createPool } from '@aviaratech/ai-memory/internal';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  applyCorpusCleanup,
  CLEANUP_TABLES,
  type CorpusCleanupReport,
  DEFAULT_CLEANUP_HISTORY_DAYS,
  MIN_CLEANUP_HISTORY_DAYS,
  planCorpusCleanup,
} from '../retention/corpusCleanup.js';
import { type BackupHealth, databaseTargetDigest, readBackupHealth } from './disaster-recovery.js';
import { formatAiMemoryDatabaseTarget, requireAiMemoryCliDatabaseTarget } from './runtimeEnv.js';

// Rows from transactions still open when the backup snapshot started are not in
// the backup; the margin keeps them out of the cleanup.
export const BACKUP_CUTOFF_MARGIN_MS = 60 * 60 * 1000;
const APPLY_STATEMENT_TIMEOUT_MS = 30 * 60 * 1000;

const USAGE = `Usage: ai-memory cleanup [--dry-run | --apply --backup-id ID] [--history-days N] [--vacuum-full] [--json]

Removes stored data ai-memory no longer keeps: memories written by memory_flush,
automatically promoted session summaries, expired session summaries, session
snapshots and deltas that resume no longer reads, and events from removed features.
Memories written with memory_store are kept, apart from expired session summaries.

  --dry-run          Count what would be deleted and kept (default). Read-only.
  --apply            Delete. Requires a healthy backup:check result for this database
                     and deletes only rows created before that backup.
  --backup-id ID     Required with --apply: the backup id the reviewed dry run printed.
  --history-days N   Keep every snapshot and delta from the N days before the cutoff
                     (default ${String(DEFAULT_CLEANUP_HISTORY_DAYS)}, minimum ${String(MIN_CLEANUP_HISTORY_DAYS)}).
  --vacuum-full      After --apply, rewrite the cleaned tables to return disk space.
                     Locks each table briefly.
  --json             Print the report as JSON.`;

export interface CleanupCliOptions {
  apply: boolean;
  backupId?: string | undefined;
  help: boolean;
  historyDays: number;
  json: boolean;
  vacuumFull: boolean;
}

export interface CleanupRunDependencies {
  /** databaseTargetDigest() of the database this run connects to. */
  databaseTarget: string;
  pool: Pick<DbPool, 'connect'>;
  readBackupHealth: () => Promise<BackupHealth>;
}

export interface CleanupRunResult {
  backup: { backupId: null | string; createdAt: null | string; reason?: string; state: string };
  /** Set when maintenance after a committed apply failed; the deletions stand. */
  maintenanceWarning?: string;
  mode: 'apply' | 'dry-run';
  report: CorpusCleanupReport;
  sizesAfter?: Record<string, number>;
  sizesBefore: Record<string, number>;
}

export class CleanupRefusedError extends Error {}

export function parseCleanupArguments(argv: readonly string[]): CleanupCliOptions {
  const options: CleanupCliOptions = {
    apply: false,
    help: false,
    historyDays: DEFAULT_CLEANUP_HISTORY_DAYS,
    json: false,
    vacuumFull: false,
  };
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (seen.has(arg)) throw new Error(`Duplicate option: ${arg}`);
    seen.add(arg);
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--dry-run') options.apply = false;
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--vacuum-full') options.vacuumFull = true;
    else if (arg === '--backup-id') {
      const value = argv[++index];
      if (value === undefined || !/^[a-f0-9-]{36}$/u.test(value)) throw new Error('--backup-id needs a backup id.');
      options.backupId = value;
    } else if (arg === '--history-days') {
      const value = argv[++index];
      const days = Number(value);
      if (value === undefined || !Number.isInteger(days) || days < MIN_CLEANUP_HISTORY_DAYS) {
        throw new Error(`--history-days needs an integer of at least ${String(MIN_CLEANUP_HISTORY_DAYS)}.`);
      }
      options.historyDays = days;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (seen.has('--apply') && seen.has('--dry-run')) throw new Error('Choose either --dry-run or --apply.');
  if (options.vacuumFull && !options.apply) throw new Error('--vacuum-full only applies with --apply.');
  if (options.apply && options.backupId === undefined && !options.help) {
    throw new Error('--apply needs --backup-id with the backup id from the reviewed dry run.');
  }
  if (!options.apply && options.backupId !== undefined) throw new Error('--backup-id only applies with --apply.');
  return options;
}

export async function runCleanup(
  options: Pick<CleanupCliOptions, 'apply' | 'backupId' | 'historyDays' | 'vacuumFull'>,
  dependencies: CleanupRunDependencies,
): Promise<CleanupRunResult> {
  const backup = await checkBackup(dependencies.readBackupHealth, dependencies.databaseTarget);
  if (options.apply && backup.state !== 'healthy') {
    throw new CleanupRefusedError(
      `cleanup --apply needs a healthy backup of this database first (${backup.reason ?? `backup:check reports ${backup.state}`}). ` +
        'Run a backup with this version, confirm backup:check passes, then rerun the dry run.',
    );
  }
  if (options.apply && options.backupId !== backup.backupId) {
    throw new CleanupRefusedError(
      `--backup-id does not match the latest healthy backup (${String(backup.backupId)}). Rerun the dry run and review it.`,
    );
  }

  const client = await dependencies.pool.connect();
  try {
    const cutoff =
      backup.state === 'healthy' && backup.createdAt !== null
        ? new Date(Date.parse(backup.createdAt) - BACKUP_CUTOFF_MARGIN_MS)
        : await readDatabaseNow(client);
    const bounds = { cutoff, historyDays: options.historyDays };
    const sizesBefore = await readTableSizes(client);

    if (!options.apply) {
      await client.query('BEGIN READ ONLY');
      try {
        const report = await planCorpusCleanup(client, bounds);
        return { backup, mode: 'dry-run', report, sizesBefore };
      } finally {
        await client.query('ROLLBACK');
      }
    }

    let report: CorpusCleanupReport;
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL statement_timeout = ${String(APPLY_STATEMENT_TIMEOUT_MS)}`);
      await client.query("SET LOCAL lock_timeout = '30s'");
      report = await applyCorpusCleanup(client, bounds);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }

    // The deletions are committed; maintenance problems are reported, not thrown.
    let maintenanceWarning: string | undefined;
    try {
      await client.query(`SET statement_timeout = ${String(APPLY_STATEMENT_TIMEOUT_MS)}`);
      await client.query("SET lock_timeout = '30s'");
      for (const table of CLEANUP_TABLES) {
        await client.query(options.vacuumFull ? `VACUUM (FULL, ANALYZE) ${table}` : `ANALYZE ${table}`);
      }
    } catch (error) {
      maintenanceWarning = `${options.vacuumFull ? 'VACUUM FULL' : 'ANALYZE'} did not finish: ${error instanceof Error ? error.message : String(error)}`;
    }
    const sizesAfter = await readTableSizes(client);
    return {
      backup,
      mode: 'apply',
      report,
      sizesAfter,
      sizesBefore,
      ...(maintenanceWarning === undefined ? {} : { maintenanceWarning }),
    };
  } finally {
    client.release();
  }
}

export function renderCleanupReport(result: CleanupRunResult, database: string): string {
  const { report } = result;
  const applied = result.mode === 'apply';
  const lines = [
    `ai-memory cleanup: ${applied ? 'applied' : 'dry run, nothing deleted'}`,
    `Database: ${database}`,
    result.backup.state === 'healthy'
      ? `Backup: healthy, taken ${String(result.backup.createdAt)} (backup id ${String(result.backup.backupId)}).`
      : `Backup: ${result.backup.reason ?? result.backup.state}. --apply refuses until this database has a healthy backup, and these counts use the current time, so they are larger than an apply would delete.`,
    `Only rows created before ${report.cutoff} are eligible. Snapshots and deltas from the ${String(report.historyDays)} days before that (since ${report.historyCutoff}) are kept.`,
    '',
    applied ? 'Deleted' : 'Would delete',
  ];
  for (const table of CLEANUP_TABLES) {
    lines.push(`  ${table.padEnd(22)} ${formatCount(report.totals[table]).padStart(9)}`);
    for (const row of report.rows.filter(entry => entry.table === table)) {
      const label = [row.reason, row.source, row.category].filter(Boolean).join(' / ');
      lines.push(`    ${label.padEnd(64)} ${formatCount(row.rows).padStart(9)}`);
    }
  }
  lines.push('', 'Kept');
  lines.push(
    `  ai_memory_entries: ${formatCount(report.kept.entries)} rows` +
      (report.kept.lineageProtected > 0
        ? ` (${formatCount(report.kept.lineageProtected)} kept only to preserve lineage or a contested pair)`
        : ''),
  );
  if (report.kept.activeMissingEmbedding !== null && report.kept.activeMissingEmbedding > 0) {
    lines.push(
      `  ${formatCount(report.kept.activeMissingEmbedding)} kept active memories have no embedding; run backfill:embeddings to add them.`,
    );
  }
  lines.push('', 'Table size with indexes');
  for (const [table, before] of Object.entries(result.sizesBefore)) {
    const after = result.sizesAfter?.[table];
    lines.push(`  ${table.padEnd(22)} ${formatBytes(before)}${after === undefined ? '' : ` -> ${formatBytes(after)}`}`);
  }
  if (applied && result.sizesAfter !== undefined) {
    lines.push('  Disk space returns after --vacuum-full; otherwise PostgreSQL reuses the freed space.');
  }
  if (result.maintenanceWarning !== undefined) {
    lines.push('', `Warning: the deletions are committed, but ${result.maintenanceWarning}`);
  }
  if (!applied) {
    lines.push(
      '',
      result.backup.state === 'healthy'
        ? `To delete these rows: ai-memory cleanup --apply --backup-id ${String(result.backup.backupId)}`
        : 'Take a backup of this database, then rerun this dry run before applying.',
    );
  }
  return `${lines.join('\n')}\n`;
}

export async function runCleanupCli(argv: string[]): Promise<void> {
  let options: CleanupCliOptions;
  try {
    options = parseCleanupArguments(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  let pool: DbPool | undefined;
  try {
    const target = requireAiMemoryCliDatabaseTarget();
    pool = createPool({ connectionString: target.databaseUrl, max: 1 });
    const result = await runCleanup(options, {
      databaseTarget: databaseTargetDigest(target.databaseUrl),
      pool,
      readBackupHealth,
    });
    const database = formatAiMemoryDatabaseTarget(target);
    process.stdout.write(
      options.json ? `${JSON.stringify({ database, ...result }, null, 2)}\n` : renderCleanupReport(result, database),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[ai-memory] cleanup ${error instanceof CleanupRefusedError ? 'refused' : 'failed'}: ${message}\n`,
    );
    process.exitCode = error instanceof CleanupRefusedError ? 2 : 1;
  } finally {
    await pool?.end().catch(() => undefined);
  }
}

async function checkBackup(
  read: () => Promise<BackupHealth>,
  databaseTarget: string,
): Promise<CleanupRunResult['backup']> {
  try {
    const health = await read();
    const base = { backupId: health.backupId, createdAt: health.createdAt };
    if (health.state !== 'healthy') return { ...base, state: health.state };
    if (health.createdAt === null || Number.isNaN(Date.parse(health.createdAt)) || health.backupId === null) {
      return { ...base, state: 'invalid' };
    }
    if (health.databaseTarget !== databaseTarget) {
      // Backups made before this version record no database; they also stamped
      // their time after the dump, so they cannot bound the cleanup.
      return {
        ...base,
        reason: 'the latest backup is not a backup of this database made with this version',
        state: 'other_database',
      };
    }
    return { ...base, state: 'healthy' };
  } catch (error) {
    // disaster-recovery failures carry only a code, never a secret.
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'UNKNOWN';
    return { backupId: null, createdAt: null, reason: `check failed: ${code}`, state: 'unavailable' };
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} kB`;
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

async function readDatabaseNow(client: DbClient): Promise<Date> {
  const result = await client.query<{ now: Date | string }>('SELECT NOW() AS now');
  const value = result.rows[0]?.now;
  return value instanceof Date ? value : new Date(String(value));
}

async function readTableSizes(client: DbClient): Promise<Record<string, number>> {
  const result = await client.query<{ bytes: number | string; table_name: string }>(
    `SELECT c.relname AS table_name, pg_total_relation_size(c.oid) AS bytes
     FROM pg_class c
     WHERE c.relkind = 'r' AND c.relnamespace = current_schema()::regnamespace AND c.relname = ANY($1::text[])`,
    [[...CLEANUP_TABLES]],
  );
  const sizes: Record<string, number> = {};
  for (const table of CLEANUP_TABLES) {
    const row = result.rows.find(entry => entry.table_name === table);
    if (row !== undefined) sizes[table] = Number(row.bytes);
  }
  return sizes;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  void runCleanupCli(process.argv.slice(2));
}
