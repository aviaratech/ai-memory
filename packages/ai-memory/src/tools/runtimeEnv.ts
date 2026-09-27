import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod/v4';

const DEBUG_ENV_FLAG = 'AVIARA_PLUGIN_DEBUG_ENV';
const DEFAULT_MCP_HTTP_HOST = '127.0.0.1';
const DEFAULT_MCP_HTTP_PORT = 3100;
const DEFAULT_POSTGRES_REQUIRED_MAJOR = 18;
const DEFAULT_POSTGRES_SERVICE = 'postgresql@18';
const FORWARDED_ENV_SOURCE_PREFIX = 'AVIARA_PLUGIN_ENV_SOURCE_';
const MISSING_DATABASE_URL_MESSAGE =
  'ai-memory database env is not configured. Set the loopback-only AI_MEMORY_DATABASE_URL for the dedicated local PostgreSQL database.';
const PLACEHOLDER_ENV_PATTERN = /^\$\{[^}]+\}$/u;
const SAFE_HOMEBREW_SERVICE_PATTERN = /^[a-z0-9@._+-]+$/iu;

export interface AiMemoryDatabaseTarget {
  authMode: 'url';
  databaseUrl: string;
  databaseUrlHost?: string | undefined;
  resolvedVia?: RuntimeEnvResolvedVia | undefined;
}

export interface AiMemoryMcpEnvConfig {
  autoStartPostgres: boolean;
  httpHost: string;
  httpPort: number;
  requirePostgresOnStartup: boolean;
  transportMode: 'http' | 'stdio';
}

export interface AiMemoryPostgresEnvConfig {
  logStderr?: string | undefined;
  requiredMajor: number;
  service: string;
  shell: string;
  startCommand?: string | undefined;
}

export interface AiMemoryRuntimeDiagnostics {
  authMode?: 'url' | undefined;
  databaseHost?: string | undefined;
  databaseName?: string | undefined;
  databaseUrlHost?: string | undefined;
  databaseUrlPresent: boolean;
  databaseUser?: string | undefined;
  resolvedKey?: string | undefined;
  resolvedSource?: 'canonical' | undefined;
  resolvedVia?: RuntimeEnvResolvedVia | undefined;
  status: RuntimeEnvStatus;
  validationError?: string | undefined;
}

export interface BootstrapAiMemoryCliRuntimeEnvInput {
  env?: NodeJS.ProcessEnv;
  globalEnv?: NodeJS.ProcessEnv;
  globalEnvPath?: string;
  logger?: (message: string) => void;
  repoEnv?: NodeJS.ProcessEnv;
  repoEnvPath?: string;
}

interface BootstrapAiMemoryRuntimeEnvResult {
  authMode?: 'url' | undefined;
  databaseHost?: string | undefined;
  databaseName?: string | undefined;
  databaseTarget?: AiMemoryDatabaseTarget | undefined;
  databaseUrl: string | undefined;
  databaseUrlHost: string | undefined;
  databaseUrlPresent: boolean;
  databaseUser?: string | undefined;
  resolvedKey: string | undefined;
  resolvedSource: 'canonical' | undefined;
  resolvedVia: RuntimeEnvResolvedVia | undefined;
  source: 'canonical' | undefined;
  sourceKey: string | undefined;
  status: RuntimeEnvStatus;
  validationError?: string | undefined;
}

interface RuntimeEnvLayer {
  env: NodeJS.ProcessEnv;
  resolvedVia: RuntimeEnvResolvedVia;
}

type RuntimeEnvResolvedVia = 'global_plugins_env' | 'process_env' | 'repo_env';
type RuntimeEnvStatus = 'invalid' | 'missing' | 'ok';

let initializedRuntimeEnv: BootstrapAiMemoryRuntimeEnvResult | undefined;
const OptionalEnvText = z.preprocess(value => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}, z.string().optional());
const AiMemoryServiceEnvSchema = z.looseObject({
  AI_MEMORY_LOG_STDERR: OptionalEnvText,
  AI_MEMORY_MCP_AUTO_START_POSTGRES: OptionalEnvText,
  AI_MEMORY_MCP_HTTP_HOST: OptionalEnvText,
  AI_MEMORY_MCP_HTTP_PORT: OptionalEnvText,
  AI_MEMORY_MCP_REQUIRE_POSTGRES: OptionalEnvText,
  AI_MEMORY_MCP_TRANSPORT: OptionalEnvText,
  AI_MEMORY_POSTGRES_REQUIRED_MAJOR: OptionalEnvText,
  AI_MEMORY_POSTGRES_SERVICE: OptionalEnvText,
  AI_MEMORY_POSTGRES_START_COMMAND: OptionalEnvText,
  SHELL: OptionalEnvText,
});
const OPTIONAL_RUNTIME_ENV_KEYS = [
  'AI_MEMORY_EMBEDDING_API_KEY',
  'AI_MEMORY_EMBEDDING_MODEL',
  'AI_MEMORY_EMBEDDING_PROVIDER',
  'AI_MEMORY_EMBEDDING_TIMEOUT_MS',
] as const;

export function bootstrapAiMemoryCliRuntimeEnv(
  input: BootstrapAiMemoryCliRuntimeEnvInput = {},
): BootstrapAiMemoryRuntimeEnvResult {
  return bootstrapAiMemoryRuntimeEnvInternal(input);
}

export function bootstrapAiMemoryRuntimeEnv(
  input: BootstrapAiMemoryCliRuntimeEnvInput = {},
): BootstrapAiMemoryRuntimeEnvResult {
  return bootstrapAiMemoryRuntimeEnvInternal(input);
}

export function formatAiMemoryDatabaseTarget(target: AiMemoryDatabaseTarget): string {
  return redactUrlForDisplay(target.databaseUrl);
}

export function getAiMemoryRuntimeDiagnostics(input?: BootstrapAiMemoryCliRuntimeEnvInput): AiMemoryRuntimeDiagnostics {
  const runtimeEnv =
    input === undefined ? (initializedRuntimeEnv ?? bootstrapAiMemoryRuntimeEnv()) : bootstrapAiMemoryRuntimeEnv(input);
  return {
    authMode: runtimeEnv.authMode,
    databaseHost: runtimeEnv.databaseHost,
    databaseName: runtimeEnv.databaseName,
    databaseUrlHost: runtimeEnv.databaseUrlHost,
    databaseUrlPresent: runtimeEnv.databaseUrlPresent,
    databaseUser: runtimeEnv.databaseUser,
    resolvedKey: runtimeEnv.resolvedKey,
    resolvedSource: runtimeEnv.resolvedSource,
    resolvedVia: runtimeEnv.resolvedVia,
    status: runtimeEnv.status,
    validationError: runtimeEnv.validationError,
  };
}

export function initializeAiMemoryRuntimeEnv(
  input: BootstrapAiMemoryCliRuntimeEnvInput = {},
): BootstrapAiMemoryRuntimeEnvResult {
  initializedRuntimeEnv = bootstrapAiMemoryRuntimeEnv(input);
  return initializedRuntimeEnv;
}

export function loadAiMemoryMcpEnvConfig(input: { env?: NodeJS.ProcessEnv } = {}): AiMemoryMcpEnvConfig {
  const env = parseAiMemoryServiceEnv(input.env ?? process.env);
  return {
    autoStartPostgres: parseBooleanEnv({
      defaultValue: false,
      name: 'AI_MEMORY_MCP_AUTO_START_POSTGRES',
      value: env.AI_MEMORY_MCP_AUTO_START_POSTGRES,
    }),
    httpHost: env.AI_MEMORY_MCP_HTTP_HOST ?? DEFAULT_MCP_HTTP_HOST,
    httpPort: parsePortEnv({
      defaultValue: DEFAULT_MCP_HTTP_PORT,
      name: 'AI_MEMORY_MCP_HTTP_PORT',
      value: env.AI_MEMORY_MCP_HTTP_PORT,
    }),
    requirePostgresOnStartup: parseBooleanEnv({
      defaultValue: false,
      name: 'AI_MEMORY_MCP_REQUIRE_POSTGRES',
      value: env.AI_MEMORY_MCP_REQUIRE_POSTGRES,
    }),
    transportMode: parseMcpTransportMode(env.AI_MEMORY_MCP_TRANSPORT),
  };
}

export function loadAiMemoryPostgresEnvConfig(input: { env?: NodeJS.ProcessEnv } = {}): AiMemoryPostgresEnvConfig {
  const env = parseAiMemoryServiceEnv(input.env ?? process.env);
  const requiredMajor = parsePositiveIntegerEnv({
    defaultValue: DEFAULT_POSTGRES_REQUIRED_MAJOR,
    name: 'AI_MEMORY_POSTGRES_REQUIRED_MAJOR',
    value: env.AI_MEMORY_POSTGRES_REQUIRED_MAJOR,
  });
  return {
    ...(env.AI_MEMORY_LOG_STDERR === undefined ? {} : { logStderr: env.AI_MEMORY_LOG_STDERR }),
    requiredMajor,
    service: parsePostgresServiceEnv({
      defaultValue:
        requiredMajor === DEFAULT_POSTGRES_REQUIRED_MAJOR
          ? DEFAULT_POSTGRES_SERVICE
          : `postgresql@${String(requiredMajor)}`,
      value: env.AI_MEMORY_POSTGRES_SERVICE,
    }),
    shell: env.SHELL ?? '/bin/bash',
    ...(env.AI_MEMORY_POSTGRES_START_COMMAND === undefined
      ? {}
      : { startCommand: env.AI_MEMORY_POSTGRES_START_COMMAND }),
  };
}

export function requireAiMemoryCliDatabaseTarget(
  input: BootstrapAiMemoryCliRuntimeEnvInput = {},
): AiMemoryDatabaseTarget {
  const runtimeEnv = bootstrapAiMemoryCliRuntimeEnv(input);
  if (runtimeEnv.databaseTarget !== undefined) return runtimeEnv.databaseTarget;
  throw new Error(runtimeEnv.validationError ?? MISSING_DATABASE_URL_MESSAGE);
}

export function requireAiMemoryCliDatabaseUrl(input: BootstrapAiMemoryCliRuntimeEnvInput = {}): string {
  return requireAiMemoryCliDatabaseTarget(input).databaseUrl;
}

function bootstrapAiMemoryRuntimeEnvInternal(
  input: BootstrapAiMemoryCliRuntimeEnvInput = {},
): BootstrapAiMemoryRuntimeEnvResult {
  const env = input.env ?? process.env;
  const logger = resolveLogger(env, input.logger);
  const globalEnv =
    input.globalEnv ?? (input.globalEnvPath === undefined ? {} : loadSimpleEnvFile(input.globalEnvPath));
  const repoEnv = input.repoEnv ?? (input.repoEnvPath === undefined ? {} : loadSimpleEnvFile(input.repoEnvPath));
  const layers: RuntimeEnvLayer[] = [
    { env, resolvedVia: 'process_env' },
    { env: globalEnv, resolvedVia: 'global_plugins_env' },
    { env: repoEnv, resolvedVia: 'repo_env' },
  ];
  hydrateOptionalRuntimeEnv({ env, layers: layers.slice(1) });
  for (const layer of layers) {
    const value = readUsableEnvValue(layer.env.AI_MEMORY_DATABASE_URL);
    if (value === undefined) continue;
    const validationError = validateLocalDatabaseUrl(value);
    if (validationError !== undefined) return createInvalidRuntimeEnvResult(validationError);
    const databaseUrlHost = resolveDatabaseUrlHost(value);
    if (databaseUrlHost === undefined)
      return createInvalidRuntimeEnvResult('AI_MEMORY_DATABASE_URL must contain a loopback PostgreSQL host.');
    const resolvedVia =
      layer.resolvedVia === 'process_env'
        ? (resolveForwardedRuntimeEnvSource(env, 'AI_MEMORY_DATABASE_URL') ?? layer.resolvedVia)
        : layer.resolvedVia;
    env.AI_MEMORY_DATABASE_URL = value;
    if (resolvedVia !== 'process_env') env[getForwardedEnvSourceKey('AI_MEMORY_DATABASE_URL')] = resolvedVia;
    logger?.(`[ai-memory] resolved AI_MEMORY_DATABASE_URL (loopback) via ${resolvedVia}`);
    return {
      authMode: 'url',
      databaseHost: databaseUrlHost,
      databaseName: resolveDatabaseName(value),
      databaseTarget: { authMode: 'url', databaseUrl: value, databaseUrlHost, resolvedVia },
      databaseUrl: value,
      databaseUrlHost,
      databaseUrlPresent: true,
      resolvedKey: 'AI_MEMORY_DATABASE_URL',
      resolvedSource: 'canonical',
      resolvedVia,
      source: 'canonical',
      sourceKey: 'AI_MEMORY_DATABASE_URL',
      status: 'ok',
    };
  }
  return {
    databaseUrl: undefined,
    databaseUrlHost: undefined,
    databaseUrlPresent: false,
    resolvedKey: undefined,
    resolvedSource: undefined,
    resolvedVia: undefined,
    source: undefined,
    sourceKey: undefined,
    status: 'missing',
  };
}

function createInvalidRuntimeEnvResult(validationError: string): BootstrapAiMemoryRuntimeEnvResult {
  return {
    databaseUrl: undefined,
    databaseUrlHost: undefined,
    databaseUrlPresent: false,
    resolvedKey: 'AI_MEMORY_DATABASE_URL',
    resolvedSource: 'canonical',
    resolvedVia: undefined,
    source: 'canonical',
    sourceKey: 'AI_MEMORY_DATABASE_URL',
    status: 'invalid',
    validationError,
  };
}

function getForwardedEnvSourceKey(key: string): string {
  return `${FORWARDED_ENV_SOURCE_PREFIX}${key}`;
}

function hydrateOptionalRuntimeEnv(input: { env: NodeJS.ProcessEnv; layers: readonly RuntimeEnvLayer[] }): void {
  for (const key of OPTIONAL_RUNTIME_ENV_KEYS) {
    if (readUsableEnvValue(input.env[key]) !== undefined) continue;
    for (const layer of input.layers) {
      const value = readUsableEnvValue(layer.env[key]);
      if (value === undefined) continue;
      input.env[key] = value;
      input.env[getForwardedEnvSourceKey(key)] = layer.resolvedVia;
      break;
    }
  }
}

function loadSimpleEnvFile(pathname: string): NodeJS.ProcessEnv {
  if (!existsSync(pathname)) return {};
  try {
    return parseSimpleEnvFile(readFileSync(pathname, 'utf8'));
  } catch {
    return {};
  }
}

function normalizeSimpleEnvValue(value: string): string | undefined {
  const trimmed = value.trim();
  const unquoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ? trimmed.slice(1, -1)
      : trimmed;
  return readUsableEnvValue(unquoted);
}

function parseAiMemoryServiceEnv(env: NodeJS.ProcessEnv): z.output<typeof AiMemoryServiceEnvSchema> {
  const result = AiMemoryServiceEnvSchema.safeParse(env);
  if (!result.success) throw new Error(`ai-memory service env is invalid: ${z.prettifyError(result.error)}`);
  return result.data;
}

function parseBooleanEnv(input: { defaultValue: boolean; name: string; value: string | undefined }): boolean {
  if (input.value === undefined) return input.defaultValue;
  const normalized = input.value.trim().toLowerCase();
  if (['1', 'on', 'true', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${input.name} must be a boolean (true/false, yes/no, on/off, or 1/0)`);
}

function parseMcpTransportMode(value: string | undefined): AiMemoryMcpEnvConfig['transportMode'] {
  if (value === undefined) return 'stdio';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'http' || normalized === 'stdio') return normalized;
  throw new Error('AI_MEMORY_MCP_TRANSPORT must be stdio or http');
}

function parsePortEnv(input: { defaultValue: number; name: string; value: string | undefined }): number {
  if (input.value === undefined) return input.defaultValue;
  const parsed = Number(input.value);
  if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65_535) return parsed;
  throw new Error(`${input.name} must be an integer from 0 to 65535`);
}

function parsePositiveIntegerEnv(input: { defaultValue: number; name: string; value: string | undefined }): number {
  if (input.value === undefined) return input.defaultValue;
  const parsed = Number(input.value);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  throw new Error(`${input.name} must be a positive integer`);
}

function parsePostgresServiceEnv(input: { defaultValue: string; value: string | undefined }): string {
  if (input.value === undefined) return input.defaultValue;
  if (!SAFE_HOMEBREW_SERVICE_PATTERN.test(input.value))
    throw new Error('AI_MEMORY_POSTGRES_SERVICE must contain only alphanumeric characters, @, ., _, +, or -');
  return input.value;
}

function parseSimpleEnvFile(contents: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const assignment = line.startsWith('export ') ? line.slice(7).trimStart() : line;
    const equalsIndex = assignment.indexOf('=');
    if (equalsIndex < 1) continue;
    const key = assignment.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_]\w*$/u.test(key)) continue;
    const value = normalizeSimpleEnvValue(assignment.slice(equalsIndex + 1));
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function readUsableEnvValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || PLACEHOLDER_ENV_PATTERN.test(trimmed)) return undefined;
  return value;
}

function redactUrlForDisplay(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.password.length > 0) parsed.password = '****';
    return parsed.toString();
  } catch {
    return value;
  }
}

function resolveDatabaseName(value: string): string | undefined {
  try {
    const pathname = new URL(value).pathname.slice(1);
    return pathname.length > 0 ? pathname : undefined;
  } catch {
    return undefined;
  }
}

function resolveDatabaseUrlHost(value: string): string | undefined {
  try {
    const hostname = new URL(value).hostname.trim().toLowerCase();
    return hostname.length > 0 ? hostname : undefined;
  } catch {
    return undefined;
  }
}

function resolveForwardedRuntimeEnvSource(
  env: NodeJS.ProcessEnv,
  key: string,
): Exclude<RuntimeEnvResolvedVia, 'repo_env'> | undefined {
  const value = readUsableEnvValue(env[getForwardedEnvSourceKey(key)]);
  return value === 'global_plugins_env' || value === 'process_env' ? value : undefined;
}

function resolveLogger(
  env: NodeJS.ProcessEnv,
  logger?: (message: string) => void,
): ((message: string) => void) | undefined {
  if (logger !== undefined) return logger;
  if (env[DEBUG_ENV_FLAG] !== '1') return undefined;
  return message => process.stderr.write(`${message}\n`);
}

function validateLocalDatabaseUrl(value: string): string | undefined {
  // Bootstrap must remain usable before workspace database dist artifacts exist.
  // Do not import the core runtime here: ensure-postgres owns that readiness check.
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'AI_MEMORY_DATABASE_URL must be a valid PostgreSQL loopback connection URL.';
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    return 'AI_MEMORY_DATABASE_URL must use the PostgreSQL postgres:// or postgresql:// scheme.';
  }
  if (!['127.0.0.1', '::1', '[::1]', 'localhost'].includes(parsed.hostname.toLowerCase())) {
    return 'AI_MEMORY_DATABASE_URL must target a loopback host; remote and RDS targets are not supported.';
  }
  if (!/[^/]/u.test(parsed.pathname)) return 'AI_MEMORY_DATABASE_URL must name the dedicated local database.';
  if (!/^[a-z0-9_-]+$/iu.test(parsed.pathname.slice(1))) {
    return 'AI_MEMORY_DATABASE_URL must use a literal database name containing only letters, digits, underscores or hyphens.';
  }
  const targetOptions = new Set([
    'database',
    'dbname',
    'host',
    'hostaddr',
    'password',
    'port',
    'service',
    'servicefile',
    'user',
  ]);
  if ([...parsed.searchParams.keys()].some(key => targetOptions.has(key.toLowerCase()))) {
    return 'AI_MEMORY_DATABASE_URL must not contain connection-target query overrides.';
  }
  return undefined;
}
