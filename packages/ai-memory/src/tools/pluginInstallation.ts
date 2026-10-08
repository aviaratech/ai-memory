import type { PluginOptions } from './pluginCli.js';

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';

import { getPackageVersion } from '../version.js';

interface Asset {
  version: string;
  root: string;
  digest: string;
  files: Record<string, string>;
  installedPath?: string;
}
interface State {
  schema: 1;
  binding: string;
  marketplace: string;
  current?: Asset;
  previous?: Asset;
  pending?: Asset;
}
export interface PluginResult {
  ok: boolean;
  state: string;
  message: string;
  actions: string[];
  host: PluginOptions['host'];
  scope: PluginOptions['scope'];
  plugin: { state: string; version?: string; digest?: string; installedPath?: string };
  hooks: { state: string };
  mcp: { state: string };
  database: { state: string };
}
export interface PluginContext {
  home?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  pluginRoot?: string;
  runtimeVersion?: string;
  nativeRun?: (host: PluginOptions['host'], args: string[]) => Promise<string>;
}
interface Context {
  options: PluginOptions;
  home: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  pluginRoot: string;
  runtimeVersion: string;
  root: string;
  binding: string;
  marketplace: string;
  nativeRun: NonNullable<PluginContext['nativeRun']>;
  cancelled?: boolean;
  recordNative?: (pid: number, active: boolean) => void;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw new Error('Process ownership cannot be checked.');
  }
}

function acquireLock(ctx: Context): () => void {
  const path = resolve(ctx.root, 'operation.lock');
  if (existsSync(path)) {
    const before = lstatSync(path);
    const prior = json(path);
    if (
      !before.isFile() ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o077) !== 0 ||
      prior.schema !== 1 ||
      prior.binding !== ctx.binding ||
      typeof prior.token !== 'string' ||
      !Number.isSafeInteger(prior.pid) ||
      Number(prior.pid) <= 0 ||
      !Array.isArray(prior.groups) ||
      !prior.groups.every(pid => Number.isSafeInteger(pid) && Number(pid) > 0)
    )
      throw new Error('Unrecognized interrupted lock; preserve it for inspection.');
    if (
      processExists(Number(prior.pid)) ||
      prior.groups.some(pid => processExists(process.platform === 'win32' ? Number(pid) : -Number(pid)))
    )
      throw new Error('An owner or its native process group is still active.');
    const current = lstatSync(path);
    if (
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      JSON.stringify(json(path)) !== JSON.stringify(prior)
    )
      throw new Error('Operation lock changed during recovery.');
    rmSync(path);
  }
  const token = randomUUID();
  const groups = new Set<number>();
  const value = () => ({ schema: 1, binding: ctx.binding, token, pid: process.pid, groups: [...groups] });
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value())}\n`);
  } finally {
    closeSync(fd);
  }
  ctx.recordNative = (pid, active) => {
    if (json(path).token !== token) throw new Error('Owned operation lock changed.');
    if (active) groups.add(pid);
    else groups.delete(pid);
    atomicJson(path, value());
  };
  return () => {
    delete ctx.recordNative;
    if (groups.size === 0 && json(path).token === token) rmSync(path);
  };
}

function sha(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function json(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  if (!lstatSync(path).isFile() || statSync(path).size > 4 * 1024 * 1024)
    throw new Error('Unsupported configuration file.');
  const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (data === null || typeof data !== 'object' || Array.isArray(data))
    throw new Error('Unsupported configuration document.');
  return data as Record<string, unknown>;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
function inventory(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && statSync(path).size <= 16 * 1024 * 1024)
        files[relative(root, path).split('\\').join('/')] = sha(readFileSync(path));
      else throw new Error('Plugin assets must be regular self-contained files.');
    }
  }
  if (!lstatSync(root).isDirectory()) throw new Error('Missing self-contained plugin assets.');
  walk(root);
  return files;
}
function asset(root: string, version: string): Asset {
  const files = inventory(root);
  for (const name of ['plugin.json', '.claude-plugin/plugin.json']) {
    const manifest = json(resolve(root, name));
    if (manifest.name !== 'ai-memory' || manifest.version !== version)
      throw new Error('Runtime and plugin versions differ.');
  }
  for (const name of [
    'dist/mcp-launcher.js',
    'dist/mcp-server.bundle.js',
    'hooks/hooks.json',
    'skills/memory-lifecycle/SKILL.md',
    'skills/memory-ops/SKILL.md',
  ]) {
    if (files[name] === undefined) throw new Error('Incomplete built plugin inventory.');
  }
  if (!Object.keys(files).some(name => /^migrations\/\d{3}_.+\.sql$/u.test(name)))
    throw new Error('Missing canonical migrations.');
  return { version, root, files, digest: sha(JSON.stringify(files)) };
}
function verify(assetValue: Asset, root = assetValue.root): void {
  if (!isAbsolute(root) || !lstatSync(root).isDirectory()) throw new Error('Missing installed plugin root.');
  for (const [name, expected] of Object.entries(assetValue.files)) {
    if (name.startsWith('/') || name.split('/').some(part => part === '..' || part === ''))
      throw new Error('Invalid asset receipt.');
    const path = resolve(root, name);
    if (!lstatSync(path).isFile() || sha(readFileSync(path)) !== expected)
      throw new Error('Plugin bytes differ from the verified snapshot.');
  }
}
function loadState(ctx: Context): State | undefined {
  const path = resolve(ctx.root, 'state.json');
  if (!existsSync(path)) return undefined;
  const state = json(path) as unknown as State;
  if (state.schema !== 1 || state.binding !== ctx.binding || state.marketplace !== ctx.marketplace)
    throw new Error('Installation receipt belongs to another context.');
  for (const item of [state.current, state.previous, state.pending]) {
    if (item === undefined) continue;
    if (
      typeof item.version !== 'string' ||
      !/^\d+\.\d+\.\d+$/u.test(item.version) ||
      typeof item.digest !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(item.digest) ||
      item.root !== resolve(ctx.root, 'marketplace/versions', item.version, item.digest, 'plugin') ||
      !isAbsolute(item.root) ||
      item.files === null ||
      typeof item.files !== 'object' ||
      sha(JSON.stringify(item.files)) !== item.digest
    )
      throw new Error('Invalid installation receipt.');
  }
  return state;
}
function result(ctx: Context, state: string, message: string, current?: Asset): PluginResult {
  return {
    ok: ['planned', 'installed', 'removed'].includes(state),
    state,
    message,
    host: ctx.options.host,
    scope: ctx.options.scope,
    actions: [],
    plugin:
      current === undefined
        ? { state: 'not_installed' }
        : {
            state: 'registered',
            version: current.version,
            digest: current.digest,
            ...(current.installedPath === undefined ? {} : { installedPath: current.installedPath }),
          },
    hooks: { state: 'requires_native_trust_or_restart' },
    mcp: { state: 'not_checked' },
    database: { state: 'not_checked' },
  };
}

function makeContext(options: PluginOptions, input: PluginContext): Context {
  const env = input.env ?? process.env;
  const home = resolve(input.home ?? homedir());
  const cwd = realpathSync(input.cwd ?? process.cwd());
  const codexHome = resolve(env.CODEX_HOME ?? resolve(home, '.codex'));
  const claudeHome = resolve(env.CLAUDE_CONFIG_DIR ?? resolve(home, '.claude'));
  const binding = JSON.stringify({
    host: options.host,
    scope: options.scope,
    cwd: options.scope === 'user' ? null : cwd,
    home,
    nativeHome: options.host === 'codex' ? codexHome : claudeHome,
  });
  const key = sha(binding);
  const root = resolve(home, '.config/ai-memory/plugins', key);
  const ctx: Context = {
    options,
    home,
    cwd,
    env,
    binding,
    root,
    marketplace: `ai-memory-managed-${key.slice(0, 16)}`,
    pluginRoot: resolve(input.pluginRoot ?? fileURLToPath(new URL('../../plugins/ai-memory', import.meta.url))),
    runtimeVersion: input.runtimeVersion ?? getPackageVersion(),
    nativeRun: input.nativeRun ?? (() => Promise.reject(new Error('uninitialized native runner'))),
  };
  if (input.nativeRun === undefined) ctx.nativeRun = (host, args) => executeNative(ctx, host, args);
  return ctx;
}

function checkConflicts(ctx: Context, state?: State): void {
  const id = `ai-memory@${ctx.marketplace}`;
  if (ctx.options.host === 'codex') {
    const path = resolve(ctx.env.CODEX_HOME ?? resolve(ctx.home, '.codex'), 'config.toml');
    const config = existsSync(path) ? parseToml(readFileSync(path, 'utf8')) : {};
    if (record(config.mcp_servers)['ai-memory'] !== undefined)
      throw new Error('An existing manual ai-memory MCP registration is preserved.');
    if (
      Object.keys(record(config.plugins)).some(
        key => key.startsWith('ai-memory@') && (key !== id || state === undefined),
      )
    )
      throw new Error('An existing native memory plugin is not owned by this receipt.');
    const marketplace = record(record(config.marketplaces)[ctx.marketplace]);
    if (
      Object.keys(marketplace).length > 0 &&
      (state === undefined ||
        marketplace.source !== resolve(ctx.root, 'marketplace') ||
        marketplace.source_type !== 'local')
    )
      throw new Error('Existing marketplace ownership differs.');
    const policy = record(record(config.plugins)[id]);
    if (Object.keys(policy).some(key => key !== 'enabled') || (policy.enabled !== undefined && policy.enabled !== true))
      throw new Error('Preserve custom or disabled native plugin policy before replacement.');
  } else {
    const configRoot = resolve(ctx.env.CLAUDE_CONFIG_DIR ?? resolve(ctx.home, '.claude'));
    const installed = record(json(resolve(configRoot, 'plugins/installed_plugins.json')).plugins);
    if (Object.keys(installed).some(key => key.startsWith('ai-memory@') && (key !== id || state === undefined)))
      throw new Error('An existing native memory plugin is not owned by this receipt.');
    const marketplace = record(json(resolve(configRoot, 'plugins/known_marketplaces.json'))[ctx.marketplace]);
    if (
      Object.keys(marketplace).length > 0 &&
      (state === undefined || record(marketplace.source).path !== resolve(ctx.root, 'marketplace'))
    )
      throw new Error('Existing marketplace ownership differs.');
    const settings = json(
      ctx.options.scope === 'user'
        ? resolve(configRoot, 'settings.json')
        : resolve(ctx.cwd, ctx.options.scope === 'project' ? '.claude/settings.json' : '.claude/settings.local.json'),
    );
    const enabled = record(settings.enabledPlugins)[id];
    if (enabled !== undefined && enabled !== true)
      throw new Error('Preserve disabled or unsupported native plugin policy before replacement.');
    for (const path of [resolve(ctx.home, '.claude.json'), resolve(ctx.cwd, '.mcp.json')]) {
      if (record(json(path).mcpServers)['ai-memory'] !== undefined)
        throw new Error('An existing manual ai-memory MCP registration is preserved.');
    }
  }
}

async function executeNative(ctx: Context, host: PluginOptions['host'], args: string[]): Promise<string> {
  if (ctx.cancelled) throw new Error('Native operation cancelled.');
  const command = host === 'codex' ? 'codex' : 'claude';
  const executable = (ctx.env.PATH ?? '')
    .split(delimiter)
    .map(part => resolve(part, command))
    .find(path => existsSync(path) && statSync(path).isFile());
  if (executable === undefined) throw new Error('Install the selected native host CLI first.');
  return await new Promise((done, reject) => {
    const child = spawn(executable, args, {
      cwd: ctx.cwd,
      env: { ...ctx.env, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let output = '';
    let bytes = 0;
    let failure = false;
    let killTimer: NodeJS.Timeout | undefined;
    const signalOwned = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure = true;
      }
    };
    const stop = () => {
      failure = true;
      signalOwned('SIGTERM');
      killTimer ??= setTimeout(() => {
        signalOwned('SIGKILL');
      }, 5_000);
    };
    const cancel = () => {
      ctx.cancelled = true;
      stop();
    };
    if (child.pid !== undefined) {
      try {
        ctx.recordNative?.(child.pid, true);
      } catch {
        stop();
      }
    }
    const timer = setTimeout(stop, 30_000);
    for (const stream of [child.stdout, child.stderr])
      stream?.on('data', (data: Buffer) => {
        bytes += data.length;
        if (bytes > 1024 * 1024) stop();
      });
    child.stdout?.on('data', (data: Buffer) => {
      if (bytes <= 1024 * 1024) output += data.toString();
    });
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    child.once('error', () => {
      failure = true;
    });
    // The native leader can exit while descendants retain its pipes. Reap the
    // entire group before close, including after a successful leader exit.
    child.once('exit', () => {
      signalOwned('SIGKILL');
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
      void (async () => {
        if (child.pid !== undefined) {
          const group = process.platform === 'win32' ? child.pid : -child.pid;
          const cleanupDeadline = Date.now() + 2_000;
          while (processExists(group) && Date.now() < cleanupDeadline)
            await new Promise(resolveWait => setTimeout(resolveWait, 25));
          if (processExists(group)) failure = true;
          else ctx.recordNative?.(child.pid, false);
        }
        if (code === 0 && !failure) done(output);
        else reject(new Error('Native plugin operation failed or requires manual action.'));
      })().catch(() => {
        reject(new Error('Native process cleanup could not be verified.'));
      });
    });
  });
}

function pointMarketplace(ctx: Context, selected: Asset): void {
  verify(selected);
  const root = resolve(ctx.root, 'marketplace');
  for (const directory of ['.agents/plugins', '.claude-plugin'])
    mkdirSync(resolve(root, directory), { recursive: true, mode: 0o700 });
  const source = `./${relative(root, selected.root).split('\\').join('/')}`;
  const entry = { name: 'ai-memory', version: selected.version, description: 'Durable local PostgreSQL memory plugin' };
  const common = { name: ctx.marketplace, owner: { name: 'AviaraTech' } };
  atomicJson(resolve(root, '.agents/plugins/marketplace.json'), {
    ...common,
    plugins: [{ ...entry, source: { source: 'local', path: source } }],
  });
  atomicJson(resolve(root, '.claude-plugin/marketplace.json'), { ...common, plugins: [{ ...entry, source }] });
}
function stage(ctx: Context): Asset {
  const source = asset(ctx.pluginRoot, ctx.runtimeVersion);
  const root = resolve(ctx.root, 'marketplace/versions', source.version, source.digest, 'plugin');
  if (!existsSync(root)) {
    mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
    cpSync(source.root, root, { recursive: true, errorOnExist: true, force: false });
  }
  verify(source, root);
  return { ...source, root };
}
async function readBack(ctx: Context, selected: Asset): Promise<Asset> {
  const id = `ai-memory@${ctx.marketplace}`;
  const raw: unknown = JSON.parse(
    await ctx.nativeRun(
      ctx.options.host,
      ctx.options.host === 'codex'
        ? ['plugin', 'list', '--marketplace', ctx.marketplace, '--json']
        : ['plugin', 'list', '--json'],
    ),
  );
  const entries = ctx.options.host === 'codex' ? record(raw).installed : raw;
  if (!Array.isArray(entries)) throw new Error('Native plugin inventory is unsupported.');
  const matches = entries
    .map(record)
    .filter(entry =>
      ctx.options.host === 'codex'
        ? entry.pluginId === id && entry.installed === true
        : entry.id === id &&
          entry.scope === ctx.options.scope &&
          (ctx.options.scope === 'user' || entry.projectPath === ctx.cwd),
    );
  if (matches.length !== 1 || matches[0]?.version !== selected.version || matches[0].enabled !== true)
    throw new Error('Native plugin registration is not verified.');
  const path = ctx.options.host === 'codex' ? selected.installedPath : matches[0].installPath;
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Native installed path is unavailable.');
  verify(selected, path);
  return { ...selected, installedPath: path };
}
async function add(ctx: Context, selected: Asset, update: boolean): Promise<Asset> {
  const id = `ai-memory@${ctx.marketplace}`;
  const raw = await ctx.nativeRun(
    ctx.options.host,
    ctx.options.host === 'codex'
      ? ['plugin', 'add', id, '--json']
      : ['plugin', update ? 'update' : 'install', id, '--scope', ctx.options.scope],
  );
  if (ctx.options.host === 'codex') {
    const native = record(JSON.parse(raw));
    if (native.pluginId !== id || native.version !== selected.version || typeof native.installedPath !== 'string')
      throw new Error('Native add response does not match the selected release.');
    selected = { ...selected, installedPath: native.installedPath };
  }
  return await readBack(ctx, selected);
}
async function removeRegistration(ctx: Context): Promise<void> {
  await ctx.nativeRun(
    ctx.options.host,
    ctx.options.host === 'codex'
      ? ['plugin', 'remove', `ai-memory@${ctx.marketplace}`, '--json']
      : ['plugin', 'uninstall', `ai-memory@${ctx.marketplace}`, '--scope', ctx.options.scope, '--keep-data'],
  );
}
function readOnlyRegistration(ctx: Context, selected: Asset): boolean {
  verify(selected);
  if (selected.installedPath === undefined) return false;
  verify(selected, selected.installedPath);
  const id = `ai-memory@${ctx.marketplace}`;
  if (ctx.options.host === 'codex') {
    const path = resolve(ctx.env.CODEX_HOME ?? resolve(ctx.home, '.codex'), 'config.toml');
    const config = existsSync(path) ? parseToml(readFileSync(path, 'utf8')) : {};
    return (
      record(record(config.plugins)[id]).enabled === true &&
      record(record(config.marketplaces)[ctx.marketplace]).source === resolve(ctx.root, 'marketplace')
    );
  }
  const root = resolve(ctx.env.CLAUDE_CONFIG_DIR ?? resolve(ctx.home, '.claude'));
  const entries = record(json(resolve(root, 'plugins/installed_plugins.json')).plugins)[id];
  if (
    !Array.isArray(entries) ||
    !entries.some(value => {
      const entry = record(value);
      return (
        entry.scope === ctx.options.scope &&
        (ctx.options.scope === 'user' || entry.projectPath === ctx.cwd) &&
        entry.version === selected.version &&
        entry.installPath === selected.installedPath
      );
    })
  )
    return false;
  const settings = json(
    ctx.options.scope === 'user'
      ? resolve(root, 'settings.json')
      : resolve(ctx.cwd, ctx.options.scope === 'project' ? '.claude/settings.json' : '.claude/settings.local.json'),
  );
  return record(settings.enabledPlugins)[id] === true;
}

function hasMarketplace(ctx: Context): boolean {
  if (ctx.options.host === 'codex') {
    const path = resolve(ctx.env.CODEX_HOME ?? resolve(ctx.home, '.codex'), 'config.toml');
    const config = existsSync(path) ? parseToml(readFileSync(path, 'utf8')) : {};
    return record(config.marketplaces)[ctx.marketplace] !== undefined;
  }
  return (
    json(resolve(ctx.env.CLAUDE_CONFIG_DIR ?? resolve(ctx.home, '.claude'), 'plugins/known_marketplaces.json'))[
      ctx.marketplace
    ] !== undefined
  );
}

async function verifyAbsent(ctx: Context): Promise<void> {
  const raw: unknown = JSON.parse(
    await ctx.nativeRun(
      ctx.options.host,
      ctx.options.host === 'codex'
        ? ['plugin', 'list', '--marketplace', ctx.marketplace, '--json']
        : ['plugin', 'list', '--json'],
    ),
  );
  const entries = ctx.options.host === 'codex' ? record(raw).installed : raw;
  if (
    !Array.isArray(entries) ||
    entries
      .map(record)
      .some(entry =>
        ctx.options.host === 'codex'
          ? entry.pluginId === `ai-memory@${ctx.marketplace}`
          : entry.id === `ai-memory@${ctx.marketplace}` &&
            entry.scope === ctx.options.scope &&
            (ctx.options.scope === 'user' || entry.projectPath === ctx.cwd),
      )
  )
    throw new Error('Native removal is not verified.');
}

function operationConflict(ctx: Context, state?: State): PluginResult | undefined {
  const options = ctx.options;
  if (state?.pending !== undefined && options.operation !== 'rollback')
    return result(
      ctx,
      'pending_recovery',
      'Replacement is incomplete. Run plugin rollback before another mutation.',
      state.current,
    );
  if ((options.operation === 'update' || options.operation === 'remove') && state?.current === undefined)
    return result(ctx, 'not_installed', 'No owned installation exists for this host and scope.');
  if (
    options.operation === 'rollback' &&
    state?.pending === undefined &&
    (state?.pending === undefined ? state?.previous : state.current) === undefined
  )
    return result(ctx, 'not_installed', 'No retained previous installation is available.');
  if (options.operation === 'install' && state?.current !== undefined && state.current.version !== options.version)
    return result(ctx, 'conflict', 'Use plugin update to replace the existing owned version.', state.current);
  return undefined;
}

export async function runPluginOperation(options: PluginOptions, input: PluginContext = {}): Promise<PluginResult> {
  const ctx = makeContext(options, input);
  if (options.host === 'codex' && options.scope !== 'user')
    return result(ctx, 'unsupported', 'This native Codex manager supports user scope. Select --scope user.');
  if (options.version !== undefined && options.version !== ctx.runtimeVersion)
    return result(
      ctx,
      'conflict',
      `Run the exact released @aviaratech/ai-memory@${options.version} package for this operation.`,
    );
  let state: State | undefined;
  try {
    state = loadState(ctx);
    checkConflicts(ctx, state);
  } catch {
    return result(
      ctx,
      'conflict',
      'Preserve the existing configuration or invalid receipt; resolve ownership/custom policy before retrying.',
    );
  }
  if (options.dryRun) {
    const plan = result(
      ctx,
      'planned',
      `Would ${options.operation} the owned ${options.host} ${options.scope} plugin; no files or native registrations changed.`,
      state?.current,
    );
    plan.actions.push(
      'Native discovery and bytes must be read back before installed is claimed.',
      'Hook trust/restart, protected configuration and PostgreSQL initialization remain separate explicit operations.',
    );
    return plan;
  }
  if (options.operation === 'doctor') {
    if (state?.pending !== undefined)
      return result(
        ctx,
        'pending_recovery',
        'Replacement is incomplete. Run plugin rollback with this same host and scope.',
        state.current,
      );
    const diagnostic = result(ctx, 'not_installed', 'No owned native installation is verified.', state?.current);
    try {
      if (state?.current !== undefined && readOnlyRegistration(ctx, state.current)) {
        diagnostic.plugin.state = 'discovered';
        diagnostic.state = 'configuration_required';
        diagnostic.message =
          'Native registration and released plugin bytes verified; checking protected configuration.';
        const { diagnosePluginRuntime } = await import('./pluginDoctor.js');
        return await diagnosePluginRuntime(diagnostic, {
          home: ctx.home,
          env: ctx.env,
          launcher: resolve(state.current.installedPath ?? '', 'dist/mcp-launcher.js'),
          version: state.current.version,
        });
      }
    } catch {
      diagnostic.state = 'conflict';
      diagnostic.message = 'Native configuration or installed bytes differ; preserve them and resolve the conflict.';
    }
    return diagnostic;
  }
  const admission = operationConflict(ctx, state);
  if (admission !== undefined) return admission;
  try {
    if (state?.current !== undefined) verify(state.current);
    if (options.operation === 'install' || options.operation === 'update') asset(ctx.pluginRoot, ctx.runtimeVersion);
    const help = await ctx.nativeRun(options.host, ['plugin', '--help']);
    if (!help.includes('marketplace') || !help.includes(options.host === 'codex' ? 'add' : 'install'))
      return result(ctx, 'unsupported', 'The selected host lacks supported native plugin management.');
  } catch {
    return result(ctx, 'conflict', 'Native capabilities, released assets or existing snapshot could not be verified.');
  }
  mkdirSync(ctx.root, { recursive: true, mode: 0o700 });
  if (
    !lstatSync(ctx.root).isDirectory() ||
    (statSync(ctx.root).mode & 0o022) !== 0 ||
    statSync(ctx.root).uid !== process.getuid?.()
  )
    return result(ctx, 'conflict', 'Installation state directory is not protected.');
  let releaseLock: () => void;
  try {
    releaseLock = acquireLock(ctx);
  } catch {
    return result(
      ctx,
      'conflict',
      'Another operation or interrupted lock exists; inspect the owned state before retrying.',
    );
  }
  let mutationStarted = false;
  try {
    // Recheck under the exclusive owned lock before changing native state.
    state = loadState(ctx);
    checkConflicts(ctx, state);
    const lockedAdmission = operationConflict(ctx, state);
    if (lockedAdmission !== undefined) return lockedAdmission;
    if (state?.current !== undefined) {
      verify(state.current);
      if (state.pending === undefined) await readBack(ctx, state.current);
    }
    if (
      (options.operation === 'install' || options.operation === 'update') &&
      state?.current !== undefined &&
      state?.current?.version === options.version
    ) {
      if (asset(ctx.pluginRoot, ctx.runtimeVersion).digest !== state.current.digest) {
        return result(
          ctx,
          'conflict',
          'Different plugin bytes were presented under an occupied version. Preserve the verified installation.',
          state.current,
        );
      }
      const current = await readBack(ctx, state.current);
      return result(
        ctx,
        'installed',
        'Selected version and native launcher bytes already match; no registration changed.',
        current,
      );
    }
    const receipt: State = state ?? { schema: 1, binding: ctx.binding, marketplace: ctx.marketplace };
    const path = resolve(ctx.root, 'state.json');
    if (options.operation === 'remove') {
      if (receipt.current === undefined) throw new Error('Missing owned installation.');
      await readBack(ctx, receipt.current);
      atomicJson(path, { ...receipt, pending: receipt.current });
      mutationStarted = true;
      await removeRegistration(ctx);
      await verifyAbsent(ctx);
      await ctx.nativeRun(options.host, [
        'plugin',
        'marketplace',
        'remove',
        ctx.marketplace,
        ...(options.host === 'codex' ? ['--json'] : []),
      ]);
      atomicJson(path, { schema: 1, binding: ctx.binding, marketplace: ctx.marketplace });
      return result(
        ctx,
        'removed',
        'Owned native plugin and marketplace removed. Protected environment and plugin data are preserved. Restart the host.',
      );
    }
    if (options.operation === 'rollback') {
      const selected = receipt.pending === undefined ? receipt.previous : receipt.current;
      if (selected === undefined && receipt.pending !== undefined) {
        verify(receipt.pending);
        mutationStarted = true;
        if (hasMarketplace(ctx)) {
          const raw: unknown = JSON.parse(
            await ctx.nativeRun(
              options.host,
              options.host === 'codex'
                ? ['plugin', 'list', '--marketplace', ctx.marketplace, '--json']
                : ['plugin', 'list', '--json'],
            ),
          );
          const entries = options.host === 'codex' ? record(raw).installed : raw;
          if (!Array.isArray(entries)) throw new Error('Native plugin inventory is unsupported.');
          if (
            entries
              .map(record)
              .some(entry => (options.host === 'codex' ? entry.pluginId : entry.id) === `ai-memory@${ctx.marketplace}`)
          )
            await removeRegistration(ctx);
          await verifyAbsent(ctx);
          await ctx.nativeRun(options.host, [
            'plugin',
            'marketplace',
            'remove',
            ctx.marketplace,
            ...(options.host === 'codex' ? ['--json'] : []),
          ]);
        }
        atomicJson(path, { schema: 1, binding: ctx.binding, marketplace: ctx.marketplace });
        return result(
          ctx,
          'removed',
          'Interrupted first installation unwound; protected environment and retained source bytes are preserved.',
        );
      }
      if (selected === undefined) throw new Error('Missing retained rollback snapshot.');
      verify(selected);
      atomicJson(path, { ...receipt, pending: selected });
      mutationStarted = true;
      pointMarketplace(ctx, selected);
      if (!hasMarketplace(ctx))
        await ctx.nativeRun(options.host, [
          'plugin',
          'marketplace',
          'add',
          resolve(ctx.root, 'marketplace'),
          ...(options.host === 'codex' ? ['--json'] : []),
        ]);
      // Codex selects its highest cached version; native removal before reinstall
      // makes a lower retained version unambiguous without deleting host files.
      if (options.host === 'codex') {
        const raw: unknown = JSON.parse(
          await ctx.nativeRun(options.host, ['plugin', 'list', '--marketplace', ctx.marketplace, '--json']),
        );
        const entries = record(raw).installed;
        if (!Array.isArray(entries)) throw new Error('Native plugin inventory is unsupported.');
        if (entries.map(record).some(entry => entry.pluginId === `ai-memory@${ctx.marketplace}`))
          await removeRegistration(ctx);
      }
      const current = await add(ctx, selected, options.host === 'claude-code');
      atomicJson(path, { ...receipt, current, previous: receipt.current, pending: undefined });
      return result(
        ctx,
        'installed',
        'Retained version and actual native launcher bytes restored. Restart the host.',
        current,
      );
    }
    const selected = stage(ctx);
    atomicJson(path, { ...receipt, pending: selected });
    mutationStarted = true;
    pointMarketplace(ctx, selected);
    if (receipt.current === undefined)
      await ctx.nativeRun(options.host, [
        'plugin',
        'marketplace',
        'add',
        resolve(ctx.root, 'marketplace'),
        ...(options.host === 'codex' ? ['--json'] : []),
      ]);
    const current = await add(ctx, selected, receipt.current !== undefined);
    atomicJson(path, { ...receipt, current, previous: receipt.current, pending: undefined });
    const installed = result(
      ctx,
      'installed',
      'Native installation and matching released launcher bytes verified.',
      current,
    );
    installed.actions.push(
      'Restart/reload the native host; review and trust its hooks explicitly.',
      'Configure protected ~/.config/ai-memory/plugin.env and initialize the dedicated database separately, then run plugin doctor.',
    );
    return installed;
  } catch {
    return result(
      ctx,
      mutationStarted ? 'pending_recovery' : 'conflict',
      mutationStarted
        ? 'Native replacement is incomplete; retained snapshots are preserved. Run plugin rollback with this same host and scope.'
        : 'Current native policy, registration or bytes changed; preserve them and resolve the conflict before mutation.',
      state?.current,
    );
  } finally {
    releaseLock();
  }
}
