#!/usr/bin/env node

import { homedir } from 'node:os';
import { resolve } from 'node:path';

import {
  buildAiMemoryHttpLaunchEnv,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT,
  readCodexAiMemoryRegistration,
  resolveAiMemoryServerScriptPath,
  resolveCodexConfigPath,
} from './codexAiMemoryConfig.js';
import {
  COMMAND_INSTALL,
  COMMAND_STATUS,
  COMMAND_UNINSTALL,
  createBooleanOption,
  createPositiveIntegerOption,
  createStringOption,
  extractEnvironmentValue,
  extractFirstProgramArgument,
  extractScriptProgramArgument,
  FLAG_DRY_RUN,
  FLAG_STDERR_LOG,
  FLAG_STDOUT_LOG,
  type LaunchdBaseCliOptions,
  type LaunchdBaseInstallConfig,
  type LaunchdPlistConfig,
  parseArguments,
  runLaunchdAgentCli,
  validateFileReadable,
} from './launchd/agent.js';

const LABEL = 'com.aviaratech.ai-memory.mcp-http';
const SERVER_SCRIPT = resolveAiMemoryServerScriptPath();
const LAUNCH_AGENTS_DIR = resolve(homedir(), 'Library', 'LaunchAgents');
const PLIST_PATH = resolve(LAUNCH_AGENTS_DIR, `${LABEL}.plist`);
const DEFAULT_STDOUT_LOG = resolve(homedir(), '.local', 'state', 'ai-memory', 'ai-memory-mcp-http.out.log');
const DEFAULT_STDERR_LOG = resolve(homedir(), '.local', 'state', 'ai-memory', 'ai-memory-mcp-http.err.log');

const FLAG_CONFIG_PATH = '--config-path';
const FLAG_HOST = '--host';
const FLAG_NODE_PATH = '--node-path';
const FLAG_PORT = '--port';

interface CliOptions extends LaunchdBaseCliOptions {
  configPath: string;
  host: string;
  nodePath: string;
  port: number;
}

interface InstallConfig extends LaunchdBaseInstallConfig {
  configPath: string;
  host: string;
  nodePath: string;
  port: number;
}

interface PlistSummary {
  configPath?: string | undefined;
  exists: true;
  hasLabel: boolean;
  host?: string | undefined;
  nodePath?: string | undefined;
  port?: number | undefined;
  scriptPath?: string | undefined;
}

const COMMAND_NAMES = [COMMAND_INSTALL, COMMAND_STATUS, COMMAND_UNINSTALL] as const;
const HELP_TEXT = [
  'Usage: npm run codex:mcp:http:<command> -- [options]',
  '',
  'Commands:',
  '  install      Install and load launchd HTTP MCP service',
  '  status       Show install/load state',
  '  uninstall    Unload and remove launchd HTTP MCP service',
  '',
  'Options (install):',
  '  --config-path <path>      Codex config path used to recover ai-memory env values',
  '  --host <host>             HTTP bind host',
  '  --port <port>             HTTP bind port',
  '  --node-path <path>        Absolute node executable path',
  '  --stdout-log <path>       launchd stdout log file path',
  '  --stderr-log <path>       launchd stderr log file path',
  '  --dry-run                 Print generated plist',
  '',
].join('\n');

async function main() {
  await runLaunchdAgentCli({
    agentName: 'codex-http-launchd-agent',
    buildInstallConfig: buildHttpInstallConfig,
    buildPlistConfig: buildHttpPlistConfig,
    installSummary: config => ({
      configPath: config.configPath,
      host: config.host,
      label: LABEL,
      nodePath: config.nodePath,
      port: config.port,
      status: 'installed',
    }),
    kickstartAfterInstall: true,
    label: LABEL,
    launchAgentsDir: LAUNCH_AGENTS_DIR,
    parseArguments: parseHttpOptions,
    plistPath: PLIST_PATH,
    summarizePlist: summarizeHttpPlist,
  });
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

function buildHttpInstallConfig(options: CliOptions): InstallConfig {
  validateFileReadable(options.nodePath, FLAG_NODE_PATH);
  validateFileReadable(SERVER_SCRIPT, 'server script');

  return {
    configPath: options.configPath,
    host: options.host,
    nodePath: options.nodePath,
    port: options.port,
    stderrLogPath: options.stderrLogPath,
    stdoutLogPath: options.stdoutLogPath,
  };
}

function buildHttpPlistConfig(config: InstallConfig): LaunchdPlistConfig {
  const registration = readCodexAiMemoryRegistration(config.configPath);
  const environmentVariables = buildAiMemoryHttpLaunchEnv({
    baseEnv: process.env,
    existingEnv: registration.env,
    host: config.host,
    port: config.port,
  });

  return {
    environmentVariables,
    keepAlive: true,
    label: LABEL,
    programArguments: [config.nodePath, SERVER_SCRIPT],
    runAtLoad: true,
    standardErrorPath: config.stderrLogPath,
    standardOutPath: config.stdoutLogPath,
    workingDirectory: homedir(),
  };
}

function parseHttpOptions(argv: readonly string[]): CliOptions {
  return parseArguments({
    argv,
    commandNames: COMMAND_NAMES,
    defaultOptions: {
      command: COMMAND_INSTALL,
      configPath: resolveCodexConfigPath(),
      dryRun: false,
      host: DEFAULT_HTTP_HOST,
      nodePath: process.execPath,
      port: DEFAULT_HTTP_PORT,
      stderrLogPath: DEFAULT_STDERR_LOG,
      stdoutLogPath: DEFAULT_STDOUT_LOG,
    },
    helpText: HELP_TEXT,
    optionFlags: [
      createBooleanOption(FLAG_DRY_RUN, options => {
        options.dryRun = true;
      }),
      createStringOption(FLAG_CONFIG_PATH, (options, value) => {
        options.configPath = value;
      }),
      createStringOption(FLAG_HOST, (options, value) => {
        options.host = value;
      }),
      createStringOption(FLAG_NODE_PATH, (options, value) => {
        options.nodePath = value;
      }),
      createPositiveIntegerOption(FLAG_PORT, (options, value) => {
        options.port = value;
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

function summarizeHttpPlist(raw: string): PlistSummary {
  const port = extractEnvironmentValue(raw, 'AI_MEMORY_MCP_HTTP_PORT');
  return {
    configPath: undefined,
    exists: true,
    hasLabel: raw.includes(`<string>${LABEL}</string>`),
    host: extractEnvironmentValue(raw, 'AI_MEMORY_MCP_HTTP_HOST'),
    nodePath: extractFirstProgramArgument(raw),
    port: port === undefined ? undefined : Number(port),
    scriptPath: extractScriptProgramArgument(raw),
  };
}
