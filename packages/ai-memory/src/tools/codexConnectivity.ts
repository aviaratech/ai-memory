#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  buildDesiredCodexAiMemoryConfig,
  type CodexMcpRegistrationEvaluation,
  DEFAULT_CODEX_HTTP_URL,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT,
  evaluateCodexAiMemoryRegistration,
  isManagedCodexAiMemoryRegistration,
  readCodexAiMemoryRegistration,
  resolveAiMemoryServerScriptPath,
  writeCodexAiMemoryRegistration,
} from './codexAiMemoryConfig.js';
import { ensurePostgresRunning } from './ensure-postgres.js';

const execFileAsync = promisify(execFile);
const MODULE_FILE = fileURLToPath(import.meta.url);
const MODULE_DIR = resolve(MODULE_FILE, '..');
const HTTP_LAUNCHD_SCRIPT = resolve(MODULE_DIR, 'codex-http-launchd-agent.js');
const INGEST_LAUNCHD_SCRIPT = resolve(MODULE_DIR, 'codex-launchd-agent.js');
const FLAG_HELP = '--help';
const FLAG_JSON = '--json';
const FLAG_QUIET = '--quiet';
const FLAG_SHORT_HELP = '-h';

interface CliOptions extends RegistrationOptions {
  command: CommandName;
  json: boolean;
  quiet: boolean;
}

interface RegistrationOptions {
  codexConfigPath?: string | undefined;
  nodeExecPath?: string | undefined;
  protectedLauncherPath?: string | undefined;
}

type CommandName = 'bootstrap' | 'doctor' | 'ensure-cli';

interface DoctorCheck {
  detail?: string | undefined;
  ok: boolean;
  status: string;
}

interface DoctorReport {
  fixes: string[];
  httpHealth: DoctorCheck;
  httpLaunchd: DoctorCheck;
  ingestLaunchd: DoctorCheck;
  ok: boolean;
  postgres: DoctorCheck;
  registration: DoctorCheck & {
    mismatches: string[];
  };
  warnings: string[];
}

async function main() {
  const args = parseArguments(process.argv.slice(2));

  if (args.command === 'ensure-cli') {
    const repaired = await ensureCliRegistration(args);
    if (!args.quiet) {
      process.stdout.write(
        repaired
          ? 'ai-memory Codex MCP registration repaired.\n'
          : 'ai-memory Codex MCP registration already healthy.\n',
      );
    }
    return;
  }

  if (args.command === 'bootstrap') {
    await ensureCliRegistration(args);
    await ensurePostgresRunning({
      logProgress: !args.quiet,
      startIfNeeded: true,
    });
    await runLaunchdCommand(HTTP_LAUNCHD_SCRIPT, ['install']);
    await runLaunchdCommand(INGEST_LAUNCHD_SCRIPT, ['install']);
    await waitForHttpHealth();

    const report = await collectDoctorReport(args);
    renderReport({
      action: 'bootstrap',
      json: args.json,
      report,
    });

    if (!report.ok) {
      process.exitCode = 1;
    }
    return;
  }

  const report = await collectDoctorReport(args);
  renderReport({
    action: 'doctor',
    json: args.json,
    report,
  });
  if (!report.ok) {
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  (import.meta.url === pathToFileURL(process.argv[1]).href ||
    import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
)
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });

export async function collectDoctorReport(input: RegistrationOptions = {}): Promise<DoctorReport> {
  const warnings: string[] = [];
  const fixes = [
    'Use the documented exact Node/launcher selection for a protected registration. Unknown registrations require manual reconciliation.',
  ];

  const existingRegistration = readCodexAiMemoryRegistration(input.codexConfigPath);
  const external =
    input.protectedLauncherPath === undefined &&
    existingRegistration.exists &&
    !isManagedCodexAiMemoryRegistration(existingRegistration, input) &&
    !isDirectRegistration(existingRegistration);
  let registrationEvaluation: CodexMcpRegistrationEvaluation;
  try {
    registrationEvaluation = external
      ? { mismatches: ['external_registration'], ok: false, registration: existingRegistration }
      : input.protectedLauncherPath === undefined && isManagedCodexAiMemoryRegistration(existingRegistration, input)
        ? { mismatches: [], ok: true, registration: existingRegistration }
        : evaluateCodexAiMemoryRegistration(
            existingRegistration,
            buildDesiredCodexAiMemoryConfig({ ...input, baseEnv: { ...process.env }, existingRegistration }),
          );
  } catch {
    registrationEvaluation = {
      mismatches: ['diagnostic_configuration_unavailable'],
      ok: false,
      registration: existingRegistration,
    };
  }
  const registrationStatus = getRegistrationStatus(registrationEvaluation);

  let postgresCheck: DoctorCheck;
  try {
    const postgres = await ensurePostgresRunning({ logProgress: false, startIfNeeded: false });
    postgresCheck = {
      detail: getPostgresDetail(postgres),
      ok: postgres.ok,
      status: postgres.ok ? 'running' : 'not_running',
    };
  } catch {
    postgresCheck = {
      detail:
        'The diagnostic process has no usable database configuration; the protected wrapper environment was not loaded.',
      ok: false,
      status: 'not_checked',
    };
  }

  const httpLaunchd = await collectLaunchdStatus(HTTP_LAUNCHD_SCRIPT);
  const ingestLaunchd = await collectLaunchdStatus(INGEST_LAUNCHD_SCRIPT);
  const httpHealth = await collectHttpHealthStatus();

  if (!registrationEvaluation.ok) {
    warnings.push('Codex global MCP registration is missing or stale.');
  }
  if (!postgresCheck.ok) {
    warnings.push('Database readiness was not confirmed from the diagnostic process.');
  }
  if (!httpLaunchd.ok) {
    warnings.push('The local ai-memory HTTP launchd service is not loaded.');
  }
  if (!httpHealth.ok) {
    warnings.push('The ai-memory HTTP health probe failed.');
    fixes.push('Inspect `.logs/ai-memory-mcp-http.err.log` if the HTTP service keeps failing to start.');
  }
  if (!ingestLaunchd.ok) {
    warnings.push('The Codex launchd ingestion service is not loaded.');
  }

  fixes.push(
    'Restart the Codex desktop app after bootstrap so new app sessions reload the repaired MCP configuration.',
  );
  fixes.push(
    `If a desktop client uses manual connectors, point it to \`${DEFAULT_CODEX_HTTP_URL}\` (health check: \`http://${DEFAULT_HTTP_HOST}:${String(DEFAULT_HTTP_PORT)}/health\`).`,
  );

  return {
    fixes,
    httpHealth,
    httpLaunchd,
    ingestLaunchd,
    ok: registrationEvaluation.ok && postgresCheck.ok && httpLaunchd.ok && httpHealth.ok && ingestLaunchd.ok,
    postgres: postgresCheck,
    registration: {
      detail: registrationStatus,
      mismatches: registrationEvaluation.mismatches,
      ok: registrationEvaluation.ok,
      status: external
        ? 'external_registration'
        : registrationEvaluation.ok
          ? input.protectedLauncherPath === undefined
            ? 'healthy'
            : 'configured_protected'
          : 'needs_repair',
    },
    warnings,
  };
}

async function collectHttpHealthStatus(): Promise<DoctorCheck> {
  const healthUrl = `http://${DEFAULT_HTTP_HOST}:${String(DEFAULT_HTTP_PORT)}/health`;
  try {
    const response = await fetch(healthUrl);
    if (!response.ok) {
      const statusCode = String(response.status);
      return {
        detail: statusCode,
        ok: false,
        status: 'unhealthy',
      };
    }

    const statusCode = String(response.status);
    return {
      detail: `${statusCode} ${response.statusText}`.trim(),
      ok: true,
      status: 'healthy',
    };
  } catch {
    return {
      detail: 'HTTP health endpoint is unreachable.',
      ok: false,
      status: 'unreachable',
    };
  }
}

async function collectLaunchdStatus(scriptPath: string): Promise<DoctorCheck> {
  try {
    const result = await runNodeScript(scriptPath, ['status']);
    const parsed = JSON.parse(result.stdout) as {
      loaded?: boolean;
      plistExists?: boolean;
      status?: string;
    };
    const status = parsed.status ?? 'unknown';
    const detail = getLaunchdStatusDetail({
      loaded: parsed.loaded === true,
      plistExists: parsed.plistExists === true,
      status,
    });
    return {
      detail,
      ok: parsed.loaded === true,
      status,
    };
  } catch {
    return {
      detail: 'Unable to read launchd service status.',
      ok: false,
      status: 'error',
    };
  }
}

function dedupeStrings(values: string[]) {
  return [...new Set(values)];
}

export async function ensureCliRegistration(input: RegistrationOptions & { quiet: boolean }): Promise<boolean> {
  const existingRegistration = readCodexAiMemoryRegistration(input.codexConfigPath);
  if (input.protectedLauncherPath === undefined && isManagedCodexAiMemoryRegistration(existingRegistration, input)) {
    return false;
  }
  if (
    existingRegistration.exists &&
    (existingRegistration.args.length !== 1 ||
      existingRegistration.args[0] !== (input.protectedLauncherPath ?? resolveAiMemoryServerScriptPath()))
  ) {
    throw new Error('Existing Codex ai-memory registration is external or conflicting; it was preserved.');
  }

  const desired = buildDesiredCodexAiMemoryConfig({
    ...input,
    existingRegistration,
  });
  const evaluation = evaluateCodexAiMemoryRegistration(existingRegistration, desired);
  if (evaluation.ok) {
    return false;
  }

  if (
    evaluation.mismatches.includes('registration_disabled') ||
    evaluation.mismatches.includes('unsupported_registration_format')
  ) {
    throw new Error('Disabled or unsupported configuration form; registration was preserved.');
  }
  if (evaluation.mismatches.some(value => value.endsWith('_unavailable'))) {
    throw new Error('Selected protected launcher or Node executable is unavailable; registration was preserved.');
  }
  const before = existsSync(desired.configPath) ? readFileSync(desired.configPath, 'utf8') : undefined;
  writeCodexAiMemoryRegistration(desired, before);

  const afterRegistration = readCodexAiMemoryRegistration(desired.configPath);
  const afterEvaluation = evaluateCodexAiMemoryRegistration(afterRegistration, desired);
  if (!afterEvaluation.ok) {
    throw new Error(
      `ai-memory Codex MCP registration is still stale after repair (${afterEvaluation.mismatches.join(', ')}). Run \`npm run codex:doctor -w @aviaratech/ai-memory\`.`,
    );
  }

  if (!input.quiet) {
    process.stderr.write('ai-memory Codex MCP registration was stale and has been repaired.\n');
  }
  return true;
}

function formatDetail(detail?: string) {
  return detail === undefined || detail.length === 0 ? '' : ` (${detail})`;
}

function isDirectRegistration(registration: CodexMcpRegistrationEvaluation['registration']): boolean {
  return registration.args.length === 1 && registration.args[0] === resolveAiMemoryServerScriptPath();
}

function getLaunchdStatusDetail(input: { loaded: boolean; plistExists: boolean; status: string }) {
  if (input.loaded) {
    return input.status;
  }

  if (input.plistExists) {
    return `${input.status} (plist present)`;
  }

  return input.status;
}

function getPostgresDetail(postgres: Awaited<ReturnType<typeof ensurePostgresRunning>>) {
  if (!postgres.ok) {
    return 'Database probe failed; database readiness is not confirmed.';
  }

  if (postgres.serverVersion === undefined) {
    return 'Database connection confirmed from the diagnostic process.';
  }

  return postgres.serverVersion;
}

function getRegistrationStatus(evaluation: CodexMcpRegistrationEvaluation) {
  if (evaluation.ok) {
    return 'healthy';
  }

  if (evaluation.registration.exists) {
    return `stale (${evaluation.mismatches.join(', ')})`;
  }

  return 'missing';
}

function parseArguments(argv: readonly string[]): CliOptions {
  if (argv.length === 0 || argv.includes(FLAG_HELP) || argv.includes(FLAG_SHORT_HELP)) {
    printHelp();
    process.exit(0);
  }

  const command = argv[0];
  if (command !== 'bootstrap' && command !== 'doctor' && command !== 'ensure-cli') {
    throw new Error(`Unsupported command: ${command ?? '(missing)'}`);
  }

  const options: CliOptions = {
    command,
    json: false,
    quiet: false,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--protected-launcher' || arg === '--node-executable' || arg === '--config-path') {
      const value = argv[++index];
      if (value === undefined || value.startsWith('--'))
        throw new Error('A registration selection option requires a path.');
      if (arg === '--protected-launcher') options.protectedLauncherPath = value;
      if (arg === '--node-executable') options.nodeExecPath = value;
      if (arg === '--config-path') options.codexConfigPath = value;
      continue;
    }
    if (arg === FLAG_JSON) {
      options.json = true;
      continue;
    }

    if (arg === FLAG_QUIET) {
      options.quiet = true;
      continue;
    }

    throw new Error('Unknown option.');
  }

  return options;
}

function printHelp() {
  process.stdout.write(
    [
      'Usage: npm run codex:<command> -- [options]',
      '',
      'Commands:',
      '  bootstrap    Repair global Codex MCP registration, install launchd services, and verify health',
      '  doctor       Check the global Codex ai-memory setup and print actionable failures',
      '  ensure-cli   Repair only the global Codex MCP registration if it is stale',
      '',
      'Options:',
      '  --json       Emit machine-readable JSON',
      '  --quiet      Suppress non-essential progress output',
      '  --protected-launcher <absolute path>  Explicitly select an external protected wrapper',
      '  --node-executable <absolute path>    Select the exact Node executable (required for protected launch)',
      '  --config-path <path>                 Select the Codex configuration file',
      '',
    ].join('\n'),
  );
}

function renderDoctorText(report: DoctorReport, action: 'bootstrap' | 'doctor') {
  const heading = report.ok ? `ai-memory Codex ${action}: OK` : `ai-memory Codex ${action}: FAIL`;
  const lines = [
    heading,
    `- Codex MCP registration: ${report.registration.status}${formatDetail(report.registration.detail)}`,
    `- Postgres: ${report.postgres.status}${formatDetail(report.postgres.detail)}`,
    `- HTTP MCP launchd: ${report.httpLaunchd.status}${formatDetail(report.httpLaunchd.detail)}`,
    `- HTTP health: ${report.httpHealth.status}${formatDetail(report.httpHealth.detail)}`,
    `- Codex ingestion launchd: ${report.ingestLaunchd.status}${formatDetail(report.ingestLaunchd.detail)}`,
  ];

  if (report.warnings.length > 0) {
    lines.push('', 'Warnings:');
    for (const warning of report.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  if (!report.ok) {
    lines.push('', 'Next steps:');
    for (const fix of dedupeStrings(report.fixes)) {
      lines.push(`- ${fix}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function renderReport(input: { action: 'bootstrap' | 'doctor'; json: boolean; report: DoctorReport }) {
  if (input.json) {
    process.stdout.write(
      `${JSON.stringify({
        action: input.action,
        ...input.report,
      })}\n`,
    );
    return;
  }

  process.stdout.write(renderDoctorText(input.report, input.action));
}

async function runLaunchdCommand(scriptPath: string, args: string[]): Promise<void> {
  try {
    await runNodeScript(scriptPath, args);
  } catch {
    throw new Error('ai-memory launchd command failed; inspect protected service diagnostics.');
  }
}

async function runNodeScript(scriptPath: string, args: string[]): Promise<{ stderr: string; stdout: string }> {
  return await execFileAsync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
  });
}

async function waitForHttpHealth(): Promise<void> {
  const attempts = 10;
  const delayMs = 500;

  for (let index = 0; index < attempts; index += 1) {
    const health = await collectHttpHealthStatus();
    if (health.ok) {
      return;
    }
    await sleep(delayMs);
  }

  throw new Error(
    `ai-memory HTTP service did not become healthy at http://${DEFAULT_HTTP_HOST}:${String(DEFAULT_HTTP_PORT)}/health. Run \`npm run codex:doctor -w @aviaratech/ai-memory\`.`,
  );
}
