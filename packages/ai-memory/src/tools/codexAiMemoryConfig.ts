import { randomUUID } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parse, stringify, type TomlTable, type TomlValue } from 'smol-toml';

import { bootstrapAiMemoryCliRuntimeEnv } from './runtimeEnv.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_HTTP_HOST = '127.0.0.1';
export const DEFAULT_HTTP_PORT = 3100;
export const DEFAULT_HTTP_MCP_PATH = '/mcp';
const DEFAULT_POSTGRES_REQUIRED_MAJOR = '18';
export const DEFAULT_MCP_NAME = 'ai-memory';
const DEFAULT_CODEX_CONFIG_PATH = resolve(homedir(), '.codex', 'config.toml');
const DEFAULT_CODEX_MANAGED_RUNTIME_CURRENT_PATH = resolve(homedir(), '.local', 'share', 'aviaratech-ai', 'current');
export const DEFAULT_CODEX_HTTP_URL = `http://${DEFAULT_HTTP_HOST}:${String(DEFAULT_HTTP_PORT)}${DEFAULT_HTTP_MCP_PATH}`;
const DEFAULT_SERVER_SCRIPT_PATH = resolve(MODULE_DIR, 'server.js');
const EMBEDDING_ENV_KEYS = [
  'AI_MEMORY_EMBEDDING_API_KEY',
  'AI_MEMORY_EMBEDDING_MODEL',
  'AI_MEMORY_EMBEDDING_PROVIDER',
  'AI_MEMORY_EMBEDDING_TIMEOUT_MS',
] as const;
const REQUIRED_ENV_KEYS = ['AI_MEMORY_DATABASE_URL', 'AI_MEMORY_POSTGRES_REQUIRED_MAJOR'] as const;

export interface CodexMcpRegistration {
  args: string[];
  command?: string | undefined;
  env: Record<string, string>;
  exists: boolean;
  hasInlineEnv?: boolean | undefined;
  disabled?: boolean | undefined;
  unsupportedFormat?: boolean | undefined;
}

export interface CodexMcpRegistrationEvaluation {
  mismatches: string[];
  ok: boolean;
  registration: CodexMcpRegistration;
}

export interface DesiredCodexAiMemoryConfig {
  args: string[];
  command: string;
  configPath: string;
  env: Record<string, string>;
  mcpName: string;
  protectedLauncherPath?: string | undefined;
  serverScriptPath: string;
}

export function buildAiMemoryHttpLaunchEnv(
  input: {
    baseEnv?: NodeJS.ProcessEnv | undefined;
    existingEnv?: Record<string, string> | undefined;
    host?: string | undefined;
    port?: number | undefined;
  } = {},
): Record<string, string> {
  const env = buildAiMemoryLaunchEnv(input);
  env.AI_MEMORY_MCP_HTTP_HOST = input.host ?? DEFAULT_HTTP_HOST;
  env.AI_MEMORY_MCP_HTTP_PORT = String(input.port ?? DEFAULT_HTTP_PORT);
  env.AI_MEMORY_MCP_TRANSPORT = 'http';
  return env;
}

export function buildAiMemoryLaunchEnv(
  input: {
    baseEnv?: NodeJS.ProcessEnv | undefined;
    existingEnv?: Record<string, string> | undefined;
    globalEnv?: NodeJS.ProcessEnv | undefined;
    globalEnvPath?: string | undefined;
    repoEnv?: NodeJS.ProcessEnv | undefined;
    repoEnvPath?: string | undefined;
  } = {},
): Record<string, string> {
  const existingEnv = input.existingEnv ?? {};
  const baseEnv = { ...existingEnv, ...(input.baseEnv ?? process.env) };
  const runtimeEnvInput: Parameters<typeof bootstrapAiMemoryCliRuntimeEnv>[0] = {
    env: baseEnv,
  };
  if (input.globalEnv !== undefined) {
    runtimeEnvInput.globalEnv = input.globalEnv;
  }
  if (input.globalEnvPath !== undefined) {
    runtimeEnvInput.globalEnvPath = input.globalEnvPath;
  }
  if (input.repoEnv !== undefined) {
    runtimeEnvInput.repoEnv = input.repoEnv;
  }
  if (input.repoEnvPath !== undefined) {
    runtimeEnvInput.repoEnvPath = input.repoEnvPath;
  }
  const runtimeEnv = bootstrapAiMemoryCliRuntimeEnv(runtimeEnvInput);
  const databaseTarget = runtimeEnv.databaseTarget;
  if (databaseTarget === undefined) {
    throw new Error(
      runtimeEnv.validationError ?? 'Set loopback AI_MEMORY_DATABASE_URL for the local ai-memory database.',
    );
  }

  const env: Record<string, string> = {
    AI_MEMORY_POSTGRES_REQUIRED_MAJOR:
      firstNonEmptyString(baseEnv.AI_MEMORY_POSTGRES_REQUIRED_MAJOR, existingEnv.AI_MEMORY_POSTGRES_REQUIRED_MAJOR) ??
      DEFAULT_POSTGRES_REQUIRED_MAJOR,
  };

  const startCommand = firstNonEmptyString(
    baseEnv.AI_MEMORY_POSTGRES_START_COMMAND,
    existingEnv.AI_MEMORY_POSTGRES_START_COMMAND,
  );
  if (startCommand !== undefined) {
    env.AI_MEMORY_POSTGRES_START_COMMAND = startCommand;
  }

  env.AI_MEMORY_DATABASE_URL =
    firstNonEmptyString(baseEnv.AI_MEMORY_DATABASE_URL, existingEnv.AI_MEMORY_DATABASE_URL, runtimeEnv.databaseUrl) ??
    databaseTarget.databaseUrl;

  for (const key of EMBEDDING_ENV_KEYS) {
    const value = firstNonEmptyString(baseEnv[key], existingEnv[key]);
    if (value !== undefined) {
      env[key] = value;
    }
  }

  return env;
}

export function buildDesiredCodexAiMemoryConfig(
  input: {
    baseEnv?: NodeJS.ProcessEnv | undefined;
    codexConfigPath?: string | undefined;
    existingRegistration?: CodexMcpRegistration | undefined;
    mcpName?: string | undefined;
    nodeExecPath?: string | undefined;
    protectedLauncherPath?: string | undefined;
  } = {},
): DesiredCodexAiMemoryConfig {
  if (input.protectedLauncherPath !== undefined) {
    if (!isAbsolute(input.protectedLauncherPath))
      throw new Error('Protected launch requires an absolute launcher path.');
    if (input.nodeExecPath === undefined || !isAbsolute(input.nodeExecPath))
      throw new Error('Protected launch requires an explicit absolute Node executable path.');
    return {
      args: [input.protectedLauncherPath],
      command: input.nodeExecPath,
      configPath: input.codexConfigPath ?? DEFAULT_CODEX_CONFIG_PATH,
      env: {},
      mcpName: input.mcpName ?? DEFAULT_MCP_NAME,
      protectedLauncherPath: input.protectedLauncherPath,
      serverScriptPath: input.protectedLauncherPath,
    };
  }
  const existingEnv = input.existingRegistration?.env ?? {};
  const env = buildAiMemoryLaunchEnv({ baseEnv: input.baseEnv, existingEnv });

  return {
    args: [DEFAULT_SERVER_SCRIPT_PATH],
    command: input.nodeExecPath ?? process.execPath,
    configPath: input.codexConfigPath ?? DEFAULT_CODEX_CONFIG_PATH,
    env,
    mcpName: input.mcpName ?? DEFAULT_MCP_NAME,
    serverScriptPath: DEFAULT_SERVER_SCRIPT_PATH,
  };
}

export function evaluateCodexAiMemoryRegistration(
  registration: CodexMcpRegistration,
  desired: DesiredCodexAiMemoryConfig,
): CodexMcpRegistrationEvaluation {
  const mismatches: string[] = [];

  if (!registration.exists) {
    mismatches.push('missing_registration');
    if (desired.protectedLauncherPath !== undefined) {
      if (!isUsableFile(desired.command, constants.X_OK)) mismatches.push('node_executable_unavailable');
      if (!isUsableFile(desired.protectedLauncherPath, constants.R_OK))
        mismatches.push('protected_launcher_unavailable');
    }
    return { mismatches, ok: false, registration };
  }
  if (registration.disabled === true) mismatches.push('registration_disabled');
  if (registration.unsupportedFormat === true) mismatches.push('unsupported_registration_format');

  if (registration.command !== desired.command) {
    mismatches.push('command_mismatch');
  }

  if (
    registration.args.length !== desired.args.length ||
    registration.args.some((value, index) => value !== desired.args[index])
  ) {
    mismatches.push('args_mismatch');
  }

  if (desired.protectedLauncherPath !== undefined) {
    if (registration.hasInlineEnv === true || Object.keys(registration.env).length > 0)
      mismatches.push('inline_env_not_allowed');
    if (!isUsableFile(desired.command, constants.X_OK)) mismatches.push('node_executable_unavailable');
    if (!isUsableFile(desired.protectedLauncherPath, constants.R_OK)) mismatches.push('protected_launcher_unavailable');
    return { mismatches, ok: mismatches.length === 0, registration };
  }

  for (const key of getRequiredRegistrationEnvKeys(desired.env)) {
    if (registration.env[key] !== desired.env[key]) {
      mismatches.push(`${key.toLowerCase()}_mismatch`);
    }
  }

  const shouldCarryEmbeddingEnv = EMBEDDING_ENV_KEYS.some(key => desired.env[key] !== undefined);
  if (shouldCarryEmbeddingEnv) {
    for (const key of EMBEDDING_ENV_KEYS) {
      const desiredValue = desired.env[key];
      if (desiredValue !== undefined && registration.env[key] !== desiredValue) {
        mismatches.push(`${key.toLowerCase()}_mismatch`);
      }
    }
  }

  return {
    mismatches,
    ok: mismatches.length === 0,
    registration,
  };
}

export function isManagedCodexAiMemoryRegistration(
  registration: CodexMcpRegistration,
  input: { currentPath?: string | undefined; nodeExecPath?: string | undefined } = {},
): boolean {
  const expectedNodeExecPath = input.nodeExecPath ?? process.execPath;
  if (
    !registration.exists ||
    registration.disabled === true ||
    registration.unsupportedFormat === true ||
    registration.command !== expectedNodeExecPath ||
    registration.args.length !== 1
  ) {
    return false;
  }

  const currentPath = input.currentPath ?? DEFAULT_CODEX_MANAGED_RUNTIME_CURRENT_PATH;
  const expectedLauncherPath = resolve(currentPath, 'plugins', 'ai-memory', 'dist', 'mcp-launcher.js');
  return resolve(registration.args[0] ?? '') === expectedLauncherPath;
}

function isTomlTable(value: TomlValue | undefined): value is TomlTable {
  return (
    value !== null &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function parseCodexConfig(raw: string): TomlTable {
  try {
    // Preserve TOML integer/float types and full integer precision when rewriting unrelated settings.
    return parse(raw, { integersAsBigInt: true });
  } catch {
    // Parser errors can include source lines containing credentials.
    throw new Error('Invalid Codex configuration; no repair was written.');
  }
}

function registrationFromConfig(config: TomlTable): CodexMcpRegistration {
  const absent = { args: [], command: undefined, env: {}, exists: false };
  const unsupported = { ...absent, exists: true, unsupportedFormat: true };
  if (config.mcp_servers === undefined) return absent;
  if (!isTomlTable(config.mcp_servers)) return unsupported;
  const registration = config.mcp_servers[DEFAULT_MCP_NAME];
  if (registration === undefined) return absent;
  if (!isTomlTable(registration)) return unsupported;
  const args = registration.args;
  const env = registration.env;
  const validArgs = Array.isArray(args) && args.every(value => typeof value === 'string');
  const validEnv =
    env === undefined || (isTomlTable(env) && Object.values(env).every(value => typeof value === 'string'));
  return {
    args: validArgs ? args : [],
    command: typeof registration.command === 'string' ? registration.command : undefined,
    env: validEnv && env !== undefined ? (env as Record<string, string>) : {},
    exists: true,
    hasInlineEnv: env !== undefined,
    disabled: registration.enabled === false,
    unsupportedFormat:
      !validArgs ||
      !validEnv ||
      typeof registration.command !== 'string' ||
      (registration.enabled !== undefined && typeof registration.enabled !== 'boolean') ||
      registration.url !== undefined,
  };
}

export function readCodexAiMemoryRegistration(configPath: string = DEFAULT_CODEX_CONFIG_PATH): CodexMcpRegistration {
  if (!existsSync(configPath)) return registrationFromConfig({});
  try {
    return registrationFromConfig(parseCodexConfig(readFileSync(configPath, 'utf8')));
  } catch {
    return { args: [], command: undefined, env: {}, exists: true, unsupportedFormat: true };
  }
}

/** Update only the supported registration, preserving other host entries and the original file until atomic commit. */
export function writeCodexAiMemoryRegistration(
  desired: DesiredCodexAiMemoryConfig,
  expectedRaw: string | undefined,
): void {
  if (desired.mcpName !== DEFAULT_MCP_NAME) throw new Error('Only the ai-memory registration is supported.');
  const readCurrent = () => (existsSync(desired.configPath) ? readFileSync(desired.configPath, 'utf8') : undefined);
  if (readCurrent() !== expectedRaw) throw new Error('Codex configuration changed; no repair was written.');
  const config = parseCodexConfig(expectedRaw ?? '');
  const existing = registrationFromConfig(config);
  if (existing.disabled === true || existing.unsupportedFormat === true) {
    throw new Error('Disabled or unsupported configuration form; registration was preserved.');
  }
  if (existing.exists && (existing.args.length !== 1 || existing.args[0] !== desired.args[0])) {
    throw new Error('Existing Codex ai-memory registration is external or conflicting; it was preserved.');
  }
  const servers = isTomlTable(config.mcp_servers) ? config.mcp_servers : (Object.create(null) as TomlTable);
  const registration = isTomlTable(servers[DEFAULT_MCP_NAME])
    ? servers[DEFAULT_MCP_NAME]
    : (Object.create(null) as TomlTable);
  registration.command = desired.command;
  registration.args = desired.args;
  delete registration.env;
  if (Object.keys(desired.env).length > 0)
    registration.env = Object.assign(Object.create(null) as TomlTable, desired.env);
  servers[DEFAULT_MCP_NAME] = registration;
  config.mcp_servers = servers;
  let next: string;
  try {
    next = stringify(config, { numbersAsFloat: true });
    if (!isDeepStrictEqual(parseCodexConfig(next), config)) throw new Error('roundtrip mismatch');
  } catch {
    throw new Error('Codex configuration could not be preserved; no repair was written.');
  }
  mkdirSync(dirname(desired.configPath), { recursive: true, mode: 0o700 });
  const temporary = `${desired.configPath}.ai-memory-${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, next);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (readCurrent() !== expectedRaw) throw new Error('Codex configuration changed; no repair was written.');
    renameSync(temporary, desired.configPath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function isUsableFile(path: string, mode: number): boolean {
  try {
    accessSync(path, mode);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function resolveAiMemoryServerScriptPath(): string {
  return DEFAULT_SERVER_SCRIPT_PATH;
}

export function resolveCodexConfigPath(): string {
  return DEFAULT_CODEX_CONFIG_PATH;
}

function firstNonEmptyString(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }

  return undefined;
}

function getRequiredRegistrationEnvKeys(env: Record<string, string>): string[] {
  return [
    ...REQUIRED_ENV_KEYS,
    ...(env.AI_MEMORY_POSTGRES_START_COMMAND === undefined ? [] : ['AI_MEMORY_POSTGRES_START_COMMAND']),
  ];
}
