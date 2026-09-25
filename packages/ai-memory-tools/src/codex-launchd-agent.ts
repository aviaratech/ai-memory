#!/usr/bin/env node

import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildAiMemoryLaunchEnv,
  readCodexAiMemoryRegistration,
  resolveCodexConfigPath,
} from './codexAiMemoryConfig.js';
import {
  COMMAND_INSTALL,
  COMMAND_RUN_ONCE,
  COMMAND_STATUS,
  COMMAND_UNINSTALL,
  createBooleanOption,
  createPositiveIntegerOption,
  createStringOption,
  extractArgumentAfter,
  extractFirstProgramArgument,
  extractPlistInteger,
  extractScriptProgramArgument,
  extractWatchPath,
  FLAG_DRY_RUN,
  FLAG_STDERR_LOG,
  FLAG_STDOUT_LOG,
  type LaunchdBaseCliOptions,
  type LaunchdBaseInstallConfig,
  type LaunchdPlistConfig,
  parseArguments,
  runCommand,
  runLaunchdAgentCli,
  validateFileReadable,
} from './launchd/agent.js';

const LABEL = 'com.aviaratech.ai-memory.codex-ingest';
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const INGEST_SCRIPT = resolve(MODULE_DIR, 'ingestion', 'ingest-codex-launchd.js');
const LAUNCH_AGENTS_DIR = resolve(homedir(), 'Library', 'LaunchAgents');
const PLIST_PATH = resolve(LAUNCH_AGENTS_DIR, `${LABEL}.plist`);
const DEFAULT_INTERVAL_SECONDS = 120;
const DEFAULT_QUIET_SECONDS = 120;
const DEFAULT_SESSIONS_ROOT = resolve(homedir(), '.codex', 'sessions');
const DEFAULT_STATE_FILE = resolve(homedir(), '.local', 'state', 'ai-memory', 'codex-launchd-state.json');
const DEFAULT_STDOUT_LOG = resolve(homedir(), '.local', 'state', 'ai-memory', 'ai-memory-codex-launchd.out.log');
const DEFAULT_STDERR_LOG = resolve(homedir(), '.local', 'state', 'ai-memory', 'ai-memory-codex-launchd.err.log');

const FLAG_FORCE = '--force';
const FLAG_INTERVAL = '--interval';
const FLAG_NODE_PATH = '--node-path';
const FLAG_QUIET_SECONDS = '--quiet-seconds';
const FLAG_ROOT = '--root';
const FLAG_SESSIONS_ROOT = '--sessions-root';
const FLAG_STATE_FILE = '--state-file';

interface CliOptions extends LaunchdBaseCliOptions {
  force: boolean;
  intervalSeconds: number;
  nodePath: string;
  quietSeconds: number;
  sessionsRoot: string;
  stateFile: string;
}

interface InstallConfig extends LaunchdBaseInstallConfig {
  intervalSeconds: number;
  nodePath: string;
  quietSeconds: number;
  sessionsRoot: string;
  stateFile: string;
}

interface PlistSummary {
  exists: true;
  hasLabel: boolean;
  intervalSeconds?: number | undefined;
  nodePath?: string | undefined;
  scriptPath?: string | undefined;
  sessionsRoot?: string | undefined;
  stateFile?: string | undefined;
}

const COMMAND_NAMES = [COMMAND_INSTALL, COMMAND_RUN_ONCE, COMMAND_STATUS, COMMAND_UNINSTALL] as const;
const HELP_TEXT = [
  'Usage: npm run codex:launchd:<command> -- [options]',
  '',
  'Commands:',
  '  install      Install and load launchd agent',
  '  status       Show install/load state',
  '  uninstall    Unload and remove launchd agent',
  '  run-once     Execute one ingestion pass immediately',
  '',
  'Options (install/run-once):',
  '  --interval <seconds>      Poll interval for launchd StartInterval',
  '  --quiet-seconds <n>       Session file quiet window before ingest',
  '  --node-path <path>        Absolute node executable path',
  '  --sessions-root <path>    Codex sessions root directory',
  '  --state-file <path>       Launchd ingestion state file',
  '  --stdout-log <path>       launchd stdout log file path',
  '  --stderr-log <path>       launchd stderr log file path',
  '  --force                   Force ingestion even if not quiet/unchanged (run-once)',
  '  --dry-run                 Print generated plist (install) or dry-run ingest (run-once)',
  '',
].join('\n');

async function main() {
  await runLaunchdAgentCli({
    agentName: 'codex-launchd-agent',
    buildInstallConfig: buildCodexInstallConfig,
    buildPlistConfig: buildCodexPlistConfig,
    extraInstallDirs: config => [dirname(config.stateFile)],
    installSummary: config => ({
      intervalSeconds: config.intervalSeconds,
      label: LABEL,
      nodePath: config.nodePath,
      quietSeconds: config.quietSeconds,
      sessionsRoot: config.sessionsRoot,
      stateFile: config.stateFile,
      status: 'installed',
    }),
    kickstartAfterInstall: true,
    label: LABEL,
    launchAgentsDir: LAUNCH_AGENTS_DIR,
    parseArguments: parseCodexOptions,
    plistPath: PLIST_PATH,
    runOnce: async args => {
      const ingestArgs = [
        INGEST_SCRIPT,
        FLAG_QUIET_SECONDS,
        String(args.quietSeconds),
        FLAG_STATE_FILE,
        args.stateFile,
        FLAG_ROOT,
        args.sessionsRoot,
      ];

      if (args.force) {
        ingestArgs.push(FLAG_FORCE);
      }

      if (args.dryRun) {
        ingestArgs.push(FLAG_DRY_RUN);
      }

      return await runCommand(args.nodePath, ingestArgs);
    },
    summarizePlist: summarizeCodexPlist,
  });
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

function buildCodexInstallConfig(options: CliOptions): InstallConfig {
  validateFileReadable(options.nodePath, FLAG_NODE_PATH);
  validateFileReadable(INGEST_SCRIPT, 'ingest script');

  return {
    intervalSeconds: options.intervalSeconds,
    nodePath: options.nodePath,
    quietSeconds: options.quietSeconds,
    sessionsRoot: options.sessionsRoot,
    stateFile: options.stateFile,
    stderrLogPath: options.stderrLogPath,
    stdoutLogPath: options.stdoutLogPath,
  };
}

function buildCodexPlistConfig(config: InstallConfig): LaunchdPlistConfig {
  const registration = readCodexAiMemoryRegistration(resolveCodexConfigPath());
  const environmentVariables = {
    ...buildAiMemoryLaunchEnv({
      baseEnv: process.env,
      existingEnv: registration.env,
    }),
    AI_MEMORY_AUTO_DURABLE_PROMOTION: '1',
    AI_MEMORY_LOG_STDERR: '0',
  };

  return {
    environmentVariables,
    label: LABEL,
    programArguments: [
      config.nodePath,
      INGEST_SCRIPT,
      FLAG_QUIET_SECONDS,
      String(config.quietSeconds),
      FLAG_STATE_FILE,
      config.stateFile,
      FLAG_ROOT,
      config.sessionsRoot,
    ],
    runAtLoad: true,
    standardErrorPath: config.stderrLogPath,
    standardOutPath: config.stdoutLogPath,
    startIntervalSeconds: config.intervalSeconds,
    watchPaths: [config.sessionsRoot],
    workingDirectory: homedir(),
  };
}

function parseCodexOptions(argv: readonly string[]): CliOptions {
  return parseArguments({
    argv,
    commandNames: COMMAND_NAMES,
    defaultOptions: {
      command: COMMAND_INSTALL,
      dryRun: false,
      force: false,
      intervalSeconds: DEFAULT_INTERVAL_SECONDS,
      nodePath: process.execPath,
      quietSeconds: DEFAULT_QUIET_SECONDS,
      sessionsRoot: DEFAULT_SESSIONS_ROOT,
      stateFile: DEFAULT_STATE_FILE,
      stderrLogPath: DEFAULT_STDERR_LOG,
      stdoutLogPath: DEFAULT_STDOUT_LOG,
    },
    helpText: HELP_TEXT,
    optionFlags: [
      createBooleanOption(FLAG_DRY_RUN, options => {
        options.dryRun = true;
      }),
      createBooleanOption(FLAG_FORCE, options => {
        options.force = true;
      }),
      createPositiveIntegerOption(FLAG_INTERVAL, (options, value) => {
        options.intervalSeconds = value;
      }),
      createPositiveIntegerOption(FLAG_QUIET_SECONDS, (options, value) => {
        options.quietSeconds = value;
      }),
      createStringOption(FLAG_NODE_PATH, (options, value) => {
        options.nodePath = value;
      }),
      createStringOption(FLAG_SESSIONS_ROOT, (options, value) => {
        options.sessionsRoot = value;
      }),
      createStringOption(FLAG_STATE_FILE, (options, value) => {
        options.stateFile = value;
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

function summarizeCodexPlist(raw: string): PlistSummary {
  return {
    exists: true,
    hasLabel: raw.includes(`<string>${LABEL}</string>`),
    intervalSeconds: extractPlistInteger(raw, 'StartInterval'),
    nodePath: extractFirstProgramArgument(raw),
    scriptPath: extractScriptProgramArgument(raw),
    sessionsRoot: extractWatchPath(raw),
    stateFile: extractArgumentAfter(raw, FLAG_STATE_FILE),
  };
}
