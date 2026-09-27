import { isRecord } from '@aviaratech/ai-memory/internal';
import { execFile, type ExecFileException } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const COMMAND_INSTALL = 'install';
export const COMMAND_RUN_ONCE = 'run-once';
export const COMMAND_STATUS = 'status';
export const COMMAND_UNINSTALL = 'uninstall';
export const FLAG_DRY_RUN = '--dry-run';
export const FLAG_HELP = '--help';
export const FLAG_SHORT_HELP = '-h';
export const FLAG_STDERR_LOG = '--stderr-log';
export const FLAG_STDOUT_LOG = '--stdout-log';

export interface LaunchctlRunInput {
  allowFailure?: boolean | undefined;
}

export interface LaunchctlRunResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface LaunchdBaseCliOptions {
  command: LaunchdCommandName;
  dryRun: boolean;
  stderrLogPath: string;
  stdoutLogPath: string;
}

export interface LaunchdBaseInstallConfig {
  stderrLogPath: string;
  stdoutLogPath: string;
}

export type LaunchdCommandName =
  | typeof COMMAND_INSTALL
  | typeof COMMAND_RUN_ONCE
  | typeof COMMAND_STATUS
  | typeof COMMAND_UNINSTALL;

export interface LaunchdPlistConfig {
  doctypePublicId?: string | undefined;
  environmentVariables: Record<string, string>;
  keepAlive?: boolean | undefined;
  label: string;
  programArguments: readonly string[];
  runAtLoad: boolean;
  standardErrorPath: string;
  standardOutPath: string;
  startCalendarInterval?: undefined | { hour: number; minute: number };
  startIntervalSeconds?: number | undefined;
  watchPaths?: readonly string[] | undefined;
  workingDirectory?: string | undefined;
}

export interface OptionFlag<TOptions> {
  apply: (options: TOptions, queue: string[]) => void;
  flag: string;
}

export interface ParseArgumentsInput<TOptions extends LaunchdBaseCliOptions> {
  argv: readonly string[];
  commandNames: readonly LaunchdCommandName[];
  defaultOptions: TOptions;
  helpText: string;
  optionFlags: readonly OptionFlag<TOptions>[];
}

export interface ProcessResult {
  stderr: string;
  stdout: string;
}

export interface RunLaunchdAgentCliInput<
  TOptions extends LaunchdBaseCliOptions,
  TInstallConfig extends LaunchdBaseInstallConfig,
> {
  agentName: string;
  buildInstallConfig: (options: TOptions) => TInstallConfig;
  buildPlistConfig: (config: TInstallConfig) => LaunchdPlistConfig;
  extraInstallDirs?: (config: TInstallConfig) => readonly string[];
  installSummary: (config: TInstallConfig) => Record<string, unknown>;
  kickstartAfterInstall?: boolean | undefined;
  label: string;
  launchAgentsDir: string;
  parseArguments: (argv: readonly string[]) => TOptions;
  plistPath: string;
  runOnce?: (options: TOptions) => Promise<ProcessResult>;
  summarizePlist?: (raw: string) => unknown;
}

export function createBooleanOption<TOptions>(flag: string, apply: (options: TOptions) => void): OptionFlag<TOptions> {
  return {
    apply: options => {
      apply(options);
    },
    flag,
  };
}

export function createPositiveIntegerOption<TOptions>(
  flag: string,
  apply: (options: TOptions, value: number) => void,
): OptionFlag<TOptions> {
  return {
    apply: (options, queue) => {
      apply(options, toPositiveInteger(requireNextArgument(queue, flag), flag));
    },
    flag,
  };
}

export function createStringOption<TOptions>(
  flag: string,
  apply: (options: TOptions, value: string) => void,
): OptionFlag<TOptions> {
  return {
    apply: (options, queue) => {
      apply(options, requireNextArgument(queue, flag));
    },
    flag,
  };
}

export function decodeXml(value: string) {
  return value
    .replaceAll('&apos;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&');
}

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function escapeXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function extractArgumentAfter(raw: string, flag: string) {
  const programArgumentsRegex = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/;
  const arrayMatch = programArgumentsRegex.exec(raw);
  const programArgumentsXml = arrayMatch?.[1];
  if (programArgumentsXml === undefined) {
    return undefined;
  }

  const values = [...programArgumentsXml.matchAll(/<string>([^<]*)<\/string>/g)].map(match => {
    const encodedValue = match[1];
    return decodeXml(encodedValue ?? '');
  });
  const index = values.indexOf(flag);
  if (index < 0) {
    return undefined;
  }

  return values[index + 1];
}

export function extractEnvironmentValue(raw: string, key: string) {
  const pattern = new RegExp(`<key>${escapeRegExp(key)}</key>\\s*<string>([^<]*)</string>`);
  const match = pattern.exec(raw);
  const value = match?.[1];
  return value === undefined ? undefined : decodeXml(value);
}

export function extractFirstProgramArgument(raw: string) {
  const firstProgramArgumentRegex = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/;
  const match = firstProgramArgumentRegex.exec(raw);
  const firstArgument = match?.[1];
  return firstArgument === undefined ? undefined : decodeXml(firstArgument);
}

export function extractPlistInteger(raw: string, key: string) {
  const pattern = new RegExp(`<key>${escapeRegExp(key)}</key>\\s*<integer>(\\d+)</integer>`);
  const match = pattern.exec(raw);
  const integerValue = match?.[1];
  return integerValue === undefined ? undefined : Number(integerValue);
}

export function extractScriptProgramArgument(raw: string) {
  const allArgsRegex = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/;
  const argsMatch = allArgsRegex.exec(raw);
  if (argsMatch?.[1] === undefined) {
    return undefined;
  }

  const stringRegex = /<string>([^<]+)<\/string>/g;
  let match: null | RegExpExecArray;
  while ((match = stringRegex.exec(argsMatch[1])) !== null) {
    const value = match[1];
    if (value !== undefined && (value.endsWith('.ts') || value.endsWith('.js') || value.endsWith('.mjs'))) {
      return decodeXml(value);
    }
  }

  return undefined;
}

export function extractWatchPath(raw: string) {
  const watchPathRegex = /<key>WatchPaths<\/key>\s*<array>\s*<string>([^<]+)<\/string>/;
  const match = watchPathRegex.exec(raw);
  const watchPath = match?.[1];
  return watchPath === undefined ? undefined : decodeXml(watchPath);
}

export function normalizeStdStream(value: unknown) {
  if (typeof value === 'string') {
    return value;
  }

  if (Buffer.isBuffer(value)) {
    return value.toString('utf8');
  }

  return '';
}

export function parseArguments<TOptions extends LaunchdBaseCliOptions>(input: ParseArgumentsInput<TOptions>): TOptions {
  const { argv, commandNames, defaultOptions, helpText, optionFlags } = input;
  if (argv.length === 0 || argv.includes(FLAG_HELP) || argv.includes(FLAG_SHORT_HELP)) {
    process.stdout.write(helpText);
    process.exit(0);
  }

  const commandArg = argv[0];
  if (commandArg === undefined || !commandNames.includes(commandArg as LaunchdCommandName)) {
    throw new Error(`Unsupported command: ${commandArg ?? '(missing)'}`);
  }

  const options = { ...defaultOptions, command: commandArg as TOptions['command'] };
  const queue = [...argv.slice(1)];
  while (queue.length > 0) {
    const value = queue.shift();
    if (value === undefined) {
      break;
    }

    const optionFlag = optionFlags.find(flag => flag.flag === value);
    if (optionFlag === undefined) {
      throw new Error(`Unknown option: ${value}`);
    }
    optionFlag.apply(options, queue);
  }

  return options;
}

export function renderPlist(config: LaunchdPlistConfig) {
  const doctypePublicId = config.doctypePublicId ?? '-//Apple//DTD PLIST 1.0//EN';
  const argumentXml = renderStringArray(config.programArguments);
  const sections = [
    `    <key>Label</key>
    <string>${escapeXml(config.label)}</string>`,
    `    <key>ProgramArguments</key>
    <array>
      ${argumentXml}
    </array>`,
    `    <key>RunAtLoad</key>
    ${renderPlistBoolean(config.runAtLoad)}`,
  ];

  if (config.startIntervalSeconds !== undefined) {
    sections.push(`    <key>StartInterval</key>
    <integer>${String(config.startIntervalSeconds)}</integer>`);
  }

  if (config.watchPaths !== undefined) {
    sections.push(`    <key>WatchPaths</key>
    <array>
      ${renderStringArray(config.watchPaths)}
    </array>`);
  }

  if (config.keepAlive !== undefined) {
    sections.push(`    <key>KeepAlive</key>
    ${renderPlistBoolean(config.keepAlive)}`);
  }

  if (config.startCalendarInterval !== undefined) {
    sections.push(`    <key>StartCalendarInterval</key>
    <dict>
      <key>Hour</key>
      <integer>${String(config.startCalendarInterval.hour)}</integer>
      <key>Minute</key>
      <integer>${String(config.startCalendarInterval.minute)}</integer>
    </dict>`);
  }

  sections.push(`    <key>StandardOutPath</key>
    <string>${escapeXml(config.standardOutPath)}</string>`);
  sections.push(`    <key>StandardErrorPath</key>
    <string>${escapeXml(config.standardErrorPath)}</string>`);

  if (config.workingDirectory !== undefined) {
    sections.push(`    <key>WorkingDirectory</key>
    <string>${escapeXml(config.workingDirectory)}</string>`);
  }

  sections.push(`    <key>EnvironmentVariables</key>
    <dict>
${renderEnvironmentXml(config.environmentVariables)}
    </dict>`);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "${doctypePublicId}" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
${sections.join('\n')}
  </dict>
</plist>`;
}

export async function runCommand(command: string, args: readonly string[]): Promise<ProcessResult> {
  return await new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { encoding: 'utf8' },
      (...callbackArgs: [ExecFileException | null, string, string]) => {
        const [error, stdout, stderr] = callbackArgs;
        if (error) {
          const errorWithStreams = error as Error & {
            stderr?: string;
            stdout?: string;
          };
          errorWithStreams.stderr = stderr;
          errorWithStreams.stdout = stdout;
          reject(errorWithStreams);
          return;
        }

        resolve({
          stderr,
          stdout,
        });
      },
    );
  });
}

export async function runLaunchctl(
  args: readonly string[],
  input: LaunchctlRunInput = {},
): Promise<LaunchctlRunResult> {
  try {
    const result = await runCommand('launchctl', args);
    return {
      exitCode: 0,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  } catch (error: unknown) {
    const exitCode = normalizeExitCode(error);
    const stderr = normalizeStdStream(getRecordField(error, 'stderr'));
    const stdout = normalizeStdStream(getRecordField(error, 'stdout'));

    if (input.allowFailure !== true) {
      const message = stderr || stdout || (error instanceof Error ? error.message : String(error));
      throw new Error(`launchctl ${args.join(' ')} failed: ${message}`);
    }

    return {
      exitCode,
      stderr,
      stdout,
    };
  }
}

export async function runLaunchdAgentCli<
  TOptions extends LaunchdBaseCliOptions,
  TInstallConfig extends LaunchdBaseInstallConfig,
>(definition: RunLaunchdAgentCliInput<TOptions, TInstallConfig>) {
  if (process.platform !== 'darwin') {
    throw new Error(`${definition.agentName} is macOS-only.`);
  }

  const args = definition.parseArguments(process.argv.slice(2));
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error('process.getuid is not available on this platform.');
  }

  const domain = `gui/${String(uid)}`;
  const serviceTarget = `${domain}/${definition.label}`;

  if (args.command === COMMAND_INSTALL) {
    const config = definition.buildInstallConfig(args);
    const plist = renderPlist(definition.buildPlistConfig(config));

    if (args.dryRun) {
      process.stdout.write(`${plist}\n`);
      return;
    }

    mkdirSync(definition.launchAgentsDir, { recursive: true });
    mkdirSync(dirname(config.stdoutLogPath), { recursive: true });
    mkdirSync(dirname(config.stderrLogPath), { recursive: true });
    for (const extraDir of definition.extraInstallDirs?.(config) ?? []) {
      mkdirSync(extraDir, { recursive: true });
    }

    writeFileSync(definition.plistPath, `${plist}\n`, 'utf8');

    await runLaunchctl(['bootout', domain, definition.plistPath], { allowFailure: true });
    await runLaunchctl(['bootstrap', domain, definition.plistPath]);
    await runLaunchctl(['enable', serviceTarget], { allowFailure: true });
    if (definition.kickstartAfterInstall === true) {
      await runLaunchctl(['kickstart', '-k', serviceTarget], {
        allowFailure: true,
      });
    }

    process.stdout.write(`${JSON.stringify(definition.installSummary(config))}\n`);
    return;
  }

  if (args.command === COMMAND_STATUS) {
    const statusInput = {
      label: definition.label,
      plistPath: definition.plistPath,
      serviceTarget,
      ...(definition.summarizePlist !== undefined ? { summarizePlist: definition.summarizePlist } : {}),
    };
    await printStatus(statusInput);
    return;
  }

  if (args.command === COMMAND_UNINSTALL) {
    await runLaunchctl(['bootout', domain, definition.plistPath], { allowFailure: true });
    await runLaunchctl(['disable', serviceTarget], { allowFailure: true });
    if (existsSync(definition.plistPath)) {
      rmSync(definition.plistPath, { force: true });
    }

    process.stdout.write(
      `${JSON.stringify({
        label: definition.label,
        plistPath: definition.plistPath,
        status: 'uninstalled',
      })}\n`,
    );
    return;
  }

  if (definition.runOnce === undefined) {
    throw new Error(`Unsupported command: ${args.command}`);
  }

  const run = await definition.runOnce(args);
  if (run.stdout.length > 0) {
    process.stdout.write(run.stdout);
  }
  if (run.stderr.length > 0) {
    process.stderr.write(run.stderr);
  }
}

export function toPositiveInteger(value: string, fieldName: string) {
  const numericValue = Number(value);
  if (!Number.isInteger(numericValue) || numericValue <= 0) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }

  return numericValue;
}

export function validateFileReadable(filePath: string, fieldName: string) {
  validatePathExists(filePath, fieldName);

  const stats = statSync(filePath);
  if (!stats.isFile()) {
    throw new Error(`${fieldName} must be a file: ${filePath}`);
  }
}

export function validatePathExists(filePath: string, fieldName: string) {
  if (!existsSync(filePath)) {
    throw new Error(`${fieldName} does not exist: ${filePath}`);
  }
}

function getRecordField(record: unknown, key: string) {
  if (!isRecord(record)) {
    return undefined;
  }
  return record[key];
}

function normalizeExitCode(error: unknown) {
  const code = getRecordField(error, 'code');
  if (typeof code === 'number') {
    return code;
  }

  const status = getRecordField(error, 'status');
  if (typeof status === 'number') {
    return status;
  }

  return 1;
}

async function printStatus(input: {
  label: string;
  plistPath: string;
  serviceTarget: string;
  summarizePlist?: (raw: string) => unknown;
}) {
  const plistExists = existsSync(input.plistPath);
  const printResult = await runLaunchctl(['print', input.serviceTarget], {
    allowFailure: true,
  });
  const loaded = printResult.exitCode === 0;
  const launchctlOutput = printResult.stdout.trim();
  const launchctlError = printResult.stderr.trim();

  let plistSummary: unknown;
  if (plistExists && input.summarizePlist !== undefined) {
    try {
      const raw = readFileSync(input.plistPath, 'utf8');
      plistSummary = input.summarizePlist(raw);
    } catch {
      plistSummary = { parseError: true };
    }
  }

  let status = 'not_installed';
  if (loaded) {
    status = 'loaded';
  } else if (plistExists) {
    status = 'not_loaded';
  }

  process.stdout.write(
    `${JSON.stringify({
      label: input.label,
      loaded,
      plistExists,
      plistPath: input.plistPath,
      plistSummary,
      serviceTarget: input.serviceTarget,
      status,
      ...(launchctlError.length > 0 ? { launchctlError } : {}),
      ...(launchctlOutput.length > 0 ? { launchctlOutput } : {}),
    })}\n`,
  );
}

function renderEnvironmentXml(env: Record<string, string>) {
  return Object.entries(env)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `      <key>${escapeXml(key)}</key>\n      <string>${escapeXml(value)}</string>`)
    .join('\n');
}

function renderPlistBoolean(value: boolean) {
  return value ? '<true/>' : '<false/>';
}

function renderStringArray(values: readonly string[]) {
  return values.map(value => `<string>${escapeXml(value)}</string>`).join('\n      ');
}

function requireNextArgument(queue: string[], optionName: string) {
  const value = queue.shift();
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${optionName} requires a value.`);
  }

  return value;
}
