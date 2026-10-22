import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';

import type { DbPool } from '@aviaratech/ai-memory/internal';

import type { BackupHealth } from './disaster-recovery.js';

import { CleanupRefusedError, parseCleanupArguments, runCleanup } from './cleanup.js';
import { parsePluginArguments } from './pluginCli.js';

describe('explicit local database setup command', () => {
  const cli = fileURLToPath(new URL('../../dist/tools/pluginCli.js', import.meta.url));
  it('discovers setup before database configuration or private input', () => {
    const result = spawnSync(process.execPath, [cli, 'setup', '--help'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
      maxBuffer: 64 * 1024,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ai-memory setup/u);
    assert.match(result.stdout, /--dry-run/u);
    assert.match(result.stdout, /private/iu);
  });
  it('previews the exact loopback target without reading credentials or changing configuration', () => {
    const result = spawnSync(process.execPath, [cli, 'setup', '--dry-run', '--json', '--port', '55491'], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
      maxBuffer: 64 * 1024,
    });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout) as {
      state: string;
      target: { host: string; port: number };
      database: string;
      mcp: string;
    };
    assert.equal(value.state, 'prepared');
    assert.equal(value.target.host, '127.0.0.1');
    assert.equal(value.target.port, 55491);
    assert.equal(value.database, 'not_checked');
    assert.equal(value.mcp, 'not_checked');
  });
  it('refuses noninteractive mutation and credential arguments before any database action', () => {
    for (const flags of [[], ['--password', 'synthetic-must-not-print'], ['--host', 'remote.example.invalid']]) {
      const result = spawnSync(process.execPath, [cli, 'setup', '--json', ...flags], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH },
        maxBuffer: 64 * 1024,
      });
      assert.equal(result.status, 2);
      const value = JSON.parse(result.stdout || result.stderr) as { state: string; reason: string; database: string };
      assert.equal(value.state, 'setup_required');
      assert.ok(['interactive_required', 'invalid_options'].includes(value.reason));
      assert.doesNotMatch(result.stdout + result.stderr, /synthetic-must-not-print/u);
      assert.equal(value.database, 'not_checked');
    }
  });
});

const BACKUP_ID = '11111111-1111-4111-8111-111111111111';
const DATABASE_TARGET = 'a'.repeat(64);
const HEALTHY_BACKUP: BackupHealth = {
  ageHours: 1,
  backupId: BACKUP_ID,
  createdAt: '2026-10-22T12:00:00.000Z',
  databaseTarget: DATABASE_TARGET,
  lastAttempt: 'success',
  maxHours: 36,
  mode: 'local',
  state: 'healthy',
};

describe('explicit cleanup command', () => {
  it('defaults to a read-only dry run and accepts only bounded options', () => {
    assert.deepEqual(parseCleanupArguments([]), {
      apply: false,
      help: false,
      historyDays: 30,
      json: false,
      vacuumFull: false,
    });
    assert.deepEqual(
      parseCleanupArguments(['--apply', '--backup-id', BACKUP_ID, '--history-days', '45', '--vacuum-full', '--json']),
      {
        apply: true,
        backupId: BACKUP_ID,
        help: false,
        historyDays: 45,
        json: true,
        vacuumFull: true,
      },
    );
    for (const args of [
      ['--apply'],
      ['--apply', '--backup-id', 'not-an-id'],
      ['--backup-id', BACKUP_ID],
      ['--apply', '--backup-id', BACKUP_ID, '--dry-run'],
      ['--apply', '--apply', '--backup-id', BACKUP_ID],
      ['--history-days', '6'],
      ['--history-days', '2.5'],
      ['--history-days'],
      ['--vacuum-full'],
      ['--force'],
    ])
      assert.throws(() => parseCleanupArguments(args));
  });
  it('refuses to apply without a matching healthy backup before opening a database connection', async () => {
    let connected = false;
    const pool: Pick<DbPool, 'connect'> = {
      connect() {
        connected = true;
        return Promise.reject(new Error('must not connect'));
      },
    };
    const apply = { apply: true, backupId: BACKUP_ID, historyDays: 30, vacuumFull: false };
    const health = (overrides: Partial<BackupHealth>) => () =>
      Promise.resolve({ ...HEALTHY_BACKUP, ...overrides } satisfies BackupHealth);
    const refusals: [() => Promise<BackupHealth>, RegExp][] = [
      [health({ backupId: null, createdAt: null, state: 'missing' }), /missing/u],
      [health({ state: 'stale' }), /stale/u],
      [health({ state: 'failed' }), /failed/u],
      [health({ databaseTarget: 'f'.repeat(64) }), /not a backup of this database/u],
      [health({ databaseTarget: null }), /not a backup of this database/u],
      [health({ backupId: '22222222-2222-4222-8222-222222222222' }), /--backup-id does not match/u],
      [() => Promise.reject(Object.assign(new Error('x'), { code: 'BACKUP_PATH_UNSAFE' })), /BACKUP_PATH_UNSAFE/u],
    ];
    for (const [readBackupHealth, reason] of refusals) {
      await assert.rejects(
        runCleanup(apply, { databaseTarget: DATABASE_TARGET, pool, readBackupHealth }),
        (error: unknown) => error instanceof CleanupRefusedError && reason.test(error.message),
      );
    }
    assert.equal(connected, false);
  });
  it('explains the cleanup without a database or host configuration', () => {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../../dist/tools/pluginCli.js', import.meta.url)), 'cleanup', '--help'],
      { encoding: 'utf8', env: { PATH: process.env.PATH }, maxBuffer: 64 * 1024 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--dry-run/u);
    assert.match(result.stdout, /--apply/u);
    assert.match(result.stdout, /backup:check/u);
  });
});

describe('standalone plugin command contract', () => {
  it('requires explicit host, scope and exact install/update version', () => {
    for (const operation of ['install', 'update']) {
      assert.throws(
        () => parsePluginArguments(['plugin', operation, '--host', 'codex', '--scope', 'user']),
        /version/u,
      );
      assert.throws(
        () => parsePluginArguments(['plugin', operation, '--scope', 'user', '--version', '1.2.3']),
        /host/u,
      );
      assert.throws(
        () => parsePluginArguments(['plugin', operation, '--host', 'codex', '--version', '1.2.3']),
        /scope/u,
      );
      for (const version of ['latest', '^1.2.3', '../escape', '1.2']) {
        assert.throws(
          () => parsePluginArguments(['plugin', operation, '--host', 'codex', '--scope', 'user', '--version', version]),
          /version/u,
        );
      }
    }
  });

  it('uses the same five operations and flags for both native hosts', () => {
    for (const host of ['codex', 'claude-code']) {
      for (const operation of ['install', 'doctor', 'update', 'rollback', 'remove']) {
        const args = ['plugin', operation, '--host', host, '--scope', 'user', '--dry-run', '--json'];
        if (operation === 'install' || operation === 'update') args.push('--version', '1.2.3');
        const result = parsePluginArguments(args);
        assert.equal(result.host, host);
        assert.equal(result.operation, operation);
        assert.equal(result.scope, 'user');
        assert.equal(result.dryRun, true);
        assert.equal(result.json, true);
      }
    }
  });

  it('rejects unknown, duplicate or incomplete options before touching a host', () => {
    const base = ['plugin', 'doctor', '--host', 'codex', '--scope', 'user'];
    for (const tail of [['--repair'], ['--host', 'codex'], ['--version'], ['--scope', 'user']]) {
      assert.throws(() => parsePluginArguments([...base, ...tail]));
    }
    assert.throws(() => parsePluginArguments(['plugin', 'bootstrap', '--host', 'codex', '--scope', 'user']));
  });
});
