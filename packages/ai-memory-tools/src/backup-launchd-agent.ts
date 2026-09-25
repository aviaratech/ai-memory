#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COMMAND_INSTALL,
  COMMAND_RUN_ONCE,
  COMMAND_STATUS,
  COMMAND_UNINSTALL,
  createBooleanOption,
  createStringOption,
  FLAG_DRY_RUN,
  FLAG_STDERR_LOG,
  FLAG_STDOUT_LOG,
  type LaunchdBaseCliOptions,
  type LaunchdBaseInstallConfig,
  type LaunchdPlistConfig,
  parseArguments,
  runCommand,
  runLaunchdAgentCli,
} from './launchd/agent.js';

const LABEL = 'com.aviaratech.ai-memory.backup';
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const BACKUP_SCRIPT = resolve(MODULE_DIR, '..', 'scripts', 'backup-db.sh');
const RECOVERY_SCRIPT = resolve(MODULE_DIR, 'disaster-recovery.js');
const LAUNCH_AGENTS_DIR = resolve(homedir(), 'Library', 'LaunchAgents');
const PLIST_PATH = resolve(LAUNCH_AGENTS_DIR, `${LABEL}.plist`);
const DEFAULT_STDOUT_LOG = resolve(homedir(), '.local', 'state', 'ai-memory', 'ai-memory-backup.out.log');
const DEFAULT_STDERR_LOG = resolve(homedir(), '.local', 'state', 'ai-memory', 'ai-memory-backup.err.log');

type CliOptions = LaunchdBaseCliOptions;

type InstallConfig = LaunchdBaseInstallConfig & { dryRun: boolean };

const COMMAND_NAMES = [COMMAND_INSTALL, COMMAND_RUN_ONCE, COMMAND_STATUS, COMMAND_UNINSTALL] as const;
const HELP_TEXT = [
  'Usage: npm run backup:<command> -- [options]',
  '',
  'Commands:',
  '  install      Install and load launchd backup agent (daily at 03:00)',
  '  status       Show install/load state',
  '  uninstall    Unload and remove launchd backup agent',
  '  run-once     Execute one backup pass immediately',
  '',
  'Options (install):',
  '  --stdout-log <path>       launchd stdout log file path',
  '  --stderr-log <path>       launchd stderr log file path',
  '  --dry-run                 Print generated plist without installing',
  '',
].join('\n');

async function main() {
  await runLaunchdAgentCli({
    agentName: 'backup-launchd-agent',
    buildInstallConfig: buildBackupInstallConfig,
    buildPlistConfig: buildBackupPlistConfig,
    installSummary: () => ({
      label: LABEL,
      schedule: 'daily at 03:00',
      status: 'installed',
    }),
    label: LABEL,
    launchAgentsDir: LAUNCH_AGENTS_DIR,
    parseArguments: parseBackupOptions,
    plistPath: PLIST_PATH,
    runOnce: async () => await runCommand(process.execPath, [RECOVERY_SCRIPT, 'backup']),
  });
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

function buildBackupInstallConfig(options: CliOptions): InstallConfig {
  if (!existsSync(BACKUP_SCRIPT) || !existsSync(RECOVERY_SCRIPT)) {
    throw new Error('Backup entry point is missing.');
  }

  return {
    dryRun: options.dryRun,
    stderrLogPath: options.stderrLogPath,
    stdoutLogPath: options.stdoutLogPath,
  };
}

function buildBackupPlistConfig(config: InstallConfig): LaunchdPlistConfig {
  const environmentVariables: Record<string, string> = {};

  for (const key of [
    'AI_MEMORY_BACKUP_DIR',
    'AI_MEMORY_BACKUP_DATABASE_URL_FILE',
    'AI_MEMORY_BACKUP_KEY_FILE',
    'AI_MEMORY_BACKUP_SOURCE_ID',
    'AI_MEMORY_S3_BUCKET',
    'AI_MEMORY_S3_PREFIX',
    'AWS_PROFILE',
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
    'AWS_SHARED_CREDENTIALS_FILE',
    'AWS_CONFIG_FILE',
  ]) {
    const value = process.env[key];
    if (value !== undefined && value.trim().length > 0) environmentVariables[key] = value;
  }
  if (
    !environmentVariables.AI_MEMORY_BACKUP_DATABASE_URL_FILE ||
    !environmentVariables.AI_MEMORY_BACKUP_KEY_FILE ||
    !environmentVariables.AI_MEMORY_BACKUP_SOURCE_ID
  ) {
    throw new Error('Set external database URL/key file paths and backup source identity before scheduling.');
  }
  if (process.env.PATH) environmentVariables.PATH = process.env.PATH;

  const preview = config.dryRun;
  const safeEnvironmentVariables = preview
    ? Object.fromEntries(Object.keys(environmentVariables).map(key => [key, '<redacted>']))
    : environmentVariables;

  return {
    doctypePublicId: '-/Apple/DTD PLIST 1.0/EN',
    environmentVariables: safeEnvironmentVariables,
    label: LABEL,
    programArguments: preview ? ['<node>', '<backup-script>', 'backup'] : [process.execPath, RECOVERY_SCRIPT, 'backup'],
    runAtLoad: false,
    standardErrorPath: preview ? '<private-log-path>' : config.stderrLogPath,
    standardOutPath: preview ? '<private-log-path>' : config.stdoutLogPath,
    startCalendarInterval: { hour: 3, minute: 0 },
  };
}

function parseBackupOptions(argv: readonly string[]): CliOptions {
  return parseArguments({
    argv,
    commandNames: COMMAND_NAMES,
    defaultOptions: {
      command: COMMAND_INSTALL,
      dryRun: false,
      stderrLogPath: DEFAULT_STDERR_LOG,
      stdoutLogPath: DEFAULT_STDOUT_LOG,
    },
    helpText: HELP_TEXT,
    optionFlags: [
      createBooleanOption(FLAG_DRY_RUN, options => {
        options.dryRun = true;
      }),
      createStringOption(FLAG_STDOUT_LOG, (options, value) => {
        options.stdoutLogPath = value;
      }),
      createStringOption(FLAG_STDERR_LOG, (options, value) => {
        options.stderrLogPath = value;
      }),
    ],
  });
}
