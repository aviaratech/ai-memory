import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { createPool, type DbClient, type DbPool } from '../db/pool.js';
import { runAiMemoryMigrations } from '../db/run-migrations.js';
import { getPackageVersion } from '../version.js';
import { loadPluginRuntimeEnv, preparePluginDatabaseConfig } from './pluginEnv.js';

const execute = promisify(execFile);

const HELP = `ai-memory setup [--host 127.0.0.1|localhost|::1] [--port 5432]
  [--database ai_memory] [--owner ai_memory_owner] [--runtime-user ai_memory_runtime]
  [--admin-user postgres] [--dry-run] [--json]
Explicit local PostgreSQL 18 setup. Changes are explained before confirmation.
Passwords use labelled private interactive input, never command arguments.
Dry-run makes no changes and does not read credentials or connect to a database.
Package/plugin installation alone never provisions PostgreSQL or a service.`;

export interface SetupOptions {
  host: string;
  port: number;
  database: string;
  owner: string;
  runtimeUser: string;
  adminUser: string;
  dryRun: boolean;
  json: boolean;
}

export function parseSetupArguments(args: string[]): SetupOptions {
  const value: SetupOptions = {
    host: '127.0.0.1',
    port: 5432,
    database: 'ai_memory',
    owner: 'ai_memory_owner',
    runtimeUser: 'ai_memory_runtime',
    adminUser: 'postgres',
    dryRun: false,
    json: false,
  };
  const names = new Map([
    ['--host', 'host'],
    ['--database', 'database'],
    ['--owner', 'owner'],
    ['--runtime-user', 'runtimeUser'],
    ['--admin-user', 'adminUser'],
  ] as const);
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (seen.has(flag)) throw new Error('invalid_options');
    seen.add(flag);
    if (flag === '--dry-run') value.dryRun = true;
    else if (flag === '--json') value.json = true;
    else {
      const next = args[++index];
      if (next === undefined || next.startsWith('--')) throw new Error('invalid_options');
      if (flag === '--port') value.port = Number(next);
      else {
        const key = names.get(flag as '--host');
        if (key === undefined) throw new Error('invalid_options');
        value[key] = next;
      }
    }
  }
  if (
    !['127.0.0.1', 'localhost', '::1'].includes(value.host) ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535
  )
    throw new Error('invalid_options');
  for (const name of [value.database, value.owner, value.runtimeUser, value.adminUser])
    if (!/^[a-z][a-z0-9_]{0,62}$/u.test(name) || name.startsWith('pg_')) throw new Error('invalid_options');
  if (
    ['postgres', 'template0', 'template1'].includes(value.database) ||
    new Set([value.owner, value.runtimeUser, value.adminUser]).size !== 3
  )
    throw new Error('invalid_options');
  return value;
}

export async function runSetupCli(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  let options: SetupOptions;
  try {
    options = parseSetupArguments(args);
  } catch {
    output(
      {
        ok: false,
        state: 'setup_required',
        reason: 'invalid_options',
        database: 'not_checked',
        mcp: 'not_checked',
        nextAction: 'Run ai-memory setup --help; credentials are accepted only through private prompts.',
      },
      args.includes('--json'),
    );
    process.exitCode = 2;
    return;
  }
  if (options.dryRun) {
    output(
      {
        ok: true,
        state: 'prepared',
        target: options,
        database: 'not_checked',
        mcp: 'not_checked',
        nextAction:
          'Run the same setup command without --dry-run in a private terminal; review the intended role, database and protected configuration changes.',
      },
      options.json,
    );
    return;
  }
  const result = await runLocalPostgresSetup(options, {
    home: homedir(),
    progress: (stage, message) => process.stderr.write(`[${String(stage)}/6] ${message}\n`),
  });
  output(result, options.json);
  process.exitCode = result.ok ? 0 : 2;
}

interface SetupInput {
  home: string;
  env?: NodeJS.ProcessEnv;
  prompt?: (label: string, secret: boolean) => Promise<string>;
  progress?: (stage: number, message: string) => void;
}

export async function runLocalPostgresSetup(options: SetupOptions, input: SetupInput) {
  let stage = 1;
  const required = (reason: string, nextAction: string) => ({
    ok: false,
    state: 'setup_required',
    reason,
    stage,
    database: 'not_checked',
    mcp: 'not_checked',
    configurationSaved: false,
    nextAction,
  });
  if (input.prompt === undefined && (!process.stdin.isTTY || !process.stderr.isTTY))
    return required('interactive_required', 'Run ai-memory setup in a private interactive terminal.');
  const prompt = input.prompt ?? privatePrompt;
  const progress = input.progress ?? (() => {});
  progress(stage, 'Check PostgreSQL 18 client tools; no service will be installed, stopped or started.');
  try {
    for (const command of ['psql', 'pg_config', 'pg_dump']) {
      const { stdout } = await execute(command, ['--version'], {
        env: { PATH: (input.env ?? process.env).PATH },
        timeout: 5_000,
        maxBuffer: 64 * 1024,
      });
      if (!/PostgreSQL\)?\s+18\./u.test(stdout)) throw new Error('prerequisite_missing');
    }
  } catch {
    return required(
      'prerequisite_missing',
      process.platform === 'darwin'
        ? 'Install PostgreSQL 18 and pgvector with your maintained packages: brew install postgresql@18 pgvector. Then put PostgreSQL 18 client tools on PATH and rerun setup. No operating-system password is requested by ai-memory.'
        : 'Install PostgreSQL 18 server/client and pgvector from your maintained distribution packages (PGDG Debian/Ubuntu: sudo apt install postgresql-18 postgresql-client-18 postgresql-18-pgvector). If sudo prompts, use your operating-system elevation credential, not a PostgreSQL password. Put PostgreSQL 18 client tools on PATH and rerun setup.',
    );
  }
  stage = 2;
  progress(
    stage,
    `Authenticate administrator ${options.adminUser} at ${options.host}:${String(options.port)}/postgres and verify server identity.`,
  );
  let adminPassword: string;
  try {
    adminPassword = await prompt(
      `Existing PostgreSQL administrator password for ${options.adminUser} (private input; not your operating-system password): `,
      true,
    );
  } catch {
    return required('cancelled', 'Rerun the same setup command in a private terminal when ready.');
  }
  const url = databaseUrl(options, options.adminUser, adminPassword, 'postgres');
  const { probePostgres, getPostgresMajorMismatchMessage } = await import('./ensure-postgres.js');
  const probe = await probePostgres({ databaseUrl: url, connectTimeoutMs: 3_000 });
  if (!probe.ok)
    return required(
      'server_unavailable',
      `Start or select your intended PostgreSQL 18 instance at ${options.host}:${String(options.port)}, verify the existing administrator login, and rerun the same command. Do not stop or replace an unrelated server.`,
    );
  if (getPostgresMajorMismatchMessage({ requiredMajor: 18, serverVersion: probe.serverVersion }) !== undefined)
    return required(
      'server_incompatible',
      'Select a PostgreSQL 18 instance on an unused port. Existing services were preserved.',
    );
  return provision(options, input, url, prompt, progress);
}

interface ServerIdentity {
  database: string;
  user: string;
  session: string;
  address: string;
  port: number;
  version: number;
}
async function identity(
  client: Pick<DbClient, 'query'>,
  database: string,
  user: string,
  expected?: ServerIdentity,
): Promise<ServerIdentity> {
  const row = (
    await client.query<ServerIdentity>(
      `SELECT current_database() AS database, current_user AS user, session_user AS session, host(inet_server_addr()) AS address, inet_server_port() AS port, current_setting('server_version_num')::int AS version`,
    )
  ).rows[0];
  if (
    row === undefined ||
    row.database !== database ||
    row.user !== user ||
    Math.floor(row.version / 10000) !== 18 ||
    (expected !== undefined &&
      (row.address !== expected.address || row.port !== expected.port || row.version !== expected.version))
  )
    throw new Error('identity_conflict');
  return row;
}

function poolFor(url: string, role?: string): DbPool {
  return createPool({
    connectionString: url,
    max: 1,
    connectionTimeoutMillis: 3_000,
    statementTimeoutMs: role === undefined ? 30_000 : 0,
    idleInTransactionTimeoutMs: 30_000,
    ...(role === undefined ? {} : { pgOptions: { options: `-c role=${role}` } }),
  });
}

// Like psql's private \\password command, send a SCRAM verifier rather than a
// cleartext password in DDL/server statement logs. Printable ASCII avoids a new
// SASLprep implementation/dependency. PostgreSQL's scram_build_secret defines
// this format: https://github.com/postgres/postgres/blob/REL_18_STABLE/src/common/scram-common.c
function passwordVerifier(password: string): string {
  if (!/^[\x21-\x7e]{12,256}$/u.test(password)) throw new Error('credential_required');
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const stored = createHash('sha256').update(clientKey).digest('base64');
  const server = createHmac('sha256', salted).update('Server Key').digest('base64');
  salted.fill(0);
  clientKey.fill(0);
  return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${server}`;
}

async function provision(
  options: SetupOptions,
  input: SetupInput,
  adminUrl: string,
  prompt: NonNullable<SetupInput['prompt']>,
  progress: NonNullable<SetupInput['progress']>,
) {
  let stage = 2,
    configurationSaved = false,
    step = 'administrator_identity',
    database = 'not_checked',
    mcp = 'not_checked';
  const pools: DbPool[] = [];
  let administrator: DbClient | undefined;
  const failure = (reason: string, action: string) => ({
    ok: false,
    state: 'setup_required',
    reason,
    stage,
    database,
    mcp,
    configurationSaved,
    nextAction: action,
  });
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  try {
    const adminPool = poolFor(adminUrl);
    pools.push(adminPool);
    administrator = await adminPool.connect();
    const observed = await identity(administrator, 'postgres', options.adminUser);
    if (observed.session !== options.adminUser) throw new Error('identity_conflict');
    const admin = (
      await administrator.query<{ superuser: boolean }>(
        'SELECT rolsuper AS superuser FROM pg_roles WHERE rolname=current_user',
      )
    ).rows[0];
    if (admin?.superuser !== true) throw new Error('administrator_required');
    const locked = (
      await administrator.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock(29,hashtext($1)) AS acquired', [
        options.database,
      ])
    ).rows[0];
    if (locked?.acquired !== true) throw new Error('setup_busy');
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const migrationsDir = resolve(packageRoot, 'migrations');
    const tables = new Set(
      readdirSync(migrationsDir)
        .filter(name => /^\d{3}_.+\.sql$/u.test(name))
        .flatMap(name =>
          [
            ...readFileSync(resolve(migrationsDir, name), 'utf8').matchAll(
              /^\s*CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)/gimu,
            ),
          ].map(match => match[1]!),
        ),
    );
    if (tables.size === 0 || [...tables].some(name => !/^ai_[a-z0-9_]+$/u.test(name)))
      throw new Error('schema_conflict');
    step = 'protected_configuration';
    let saved: string | undefined;
    let savedPassword: string | undefined;
    try {
      const configuration = loadPluginRuntimeEnv({ home: input.home, env: {} });
      saved = configuration.runtime.databaseUrl;
      if (configuration.fileState === 'protected' && saved === undefined) throw new Error('configuration_conflict');
      if (saved !== undefined) {
        const parsed = new URL(saved);
        if (
          parsed.hostname.replaceAll('[', '').replaceAll(']', '') !== options.host ||
          (parsed.port || '5432') !== String(options.port) ||
          parsed.pathname !== `/${options.database}` ||
          decodeURIComponent(parsed.username) !== options.runtimeUser ||
          parsed.search !== ''
        )
          throw new Error('configuration_conflict');
        savedPassword = decodeURIComponent(parsed.password);
        configurationSaved = true;
      }
    } catch {
      throw new Error('configuration_conflict');
    }
    stage = 3;
    step = 'conflict_inspection';
    progress(
      stage,
      `Inspect intended database ${options.database}, owner ${options.owner} and runtime login ${options.runtimeUser}; preserve all conflicting state.`,
    );
    const roles = (
      await administrator.query<{
        rolname: string;
        rolsuper: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolcanlogin: boolean;
        rolreplication: boolean;
        rolbypassrls: boolean;
        rolinherit: boolean;
        configured: boolean;
        membership: boolean;
        other_database: boolean;
      }>(
        `SELECT r.rolname,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolcanlogin,r.rolreplication,r.rolbypassrls,r.rolinherit,r.rolconfig IS NOT NULL AS configured, EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) AS membership, EXISTS(SELECT 1 FROM pg_database d WHERE d.datdba=r.oid AND d.datname<>$2) AS other_database FROM pg_roles r WHERE r.rolname=ANY($1::text[])`,
        [[options.owner, options.runtimeUser], options.database],
      )
    ).rows;
    for (const role of roles)
      if (
        role.rolsuper ||
        role.rolcreatedb ||
        role.rolcreaterole ||
        role.rolreplication ||
        role.rolbypassrls ||
        role.rolinherit ||
        role.configured ||
        role.membership ||
        role.other_database ||
        role.rolcanlogin !== (role.rolname === options.runtimeUser)
      )
        throw new Error('role_conflict');
    const existing = (
      await administrator.query<{ owner: string }>(
        'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1',
        [options.database],
      )
    ).rows[0];
    if (existing !== undefined && existing.owner !== options.owner) throw new Error('database_conflict');
    const targetAdminUrl = new URL(adminUrl);
    targetAdminUrl.pathname = `/${options.database}`;
    if (existing !== undefined) {
      const existingPool = poolFor(targetAdminUrl.href);
      pools.push(existingPool);
      await identity(existingPool, options.database, options.adminUser, observed);
      const relations = (
        await existingPool.query<{ name: string; owner: string }>(
          `SELECT c.relname AS name,pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')`,
        )
      ).rows;
      if (relations.length > 0 && !relations.some(relation => relation.name === 'ai_memory_pgmigrations'))
        throw new Error('schema_conflict');
      for (const relation of relations)
        if (
          (!tables.has(relation.name) && relation.name !== 'ai_memory_pgmigrations') ||
          relation.owner !== options.owner
        )
          throw new Error('schema_conflict');
    }
    const runtimeExists = roles.some(role => role.rolname === options.runtimeUser);
    let password =
      saved === undefined
        ? await prompt(
            `${runtimeExists ? 'Existing memory database credential' : 'New memory database credential'} for ${options.runtimeUser} (private input; ${runtimeExists ? 'will not be reset' : '12–256 printable ASCII characters, no spaces'}): `,
            true,
          )
        : savedPassword!;
    let verifier: string | undefined;
    if (!runtimeExists) {
      verifier = passwordVerifier(password);
      if ((await prompt('Repeat the new memory database credential (private input): ', true)) !== password)
        throw new Error('credential_required');
    }
    const runtimeUrl = databaseUrl(options, options.runtimeUser, password, options.database);
    const publication = preparePluginDatabaseConfig({ home: input.home, databaseUrl: runtimeUrl });
    if (runtimeExists && existing !== undefined) {
      const login = poolFor(runtimeUrl);
      pools.push(login);
      await identity(login, options.database, options.runtimeUser, observed);
    }
    progress(
      stage,
      `Plan: ${existing === undefined ? 'create' : 'verify'} database ${options.database}; ${roles.some(role => role.rolname === options.owner) ? 'reuse' : 'create'} non-login owner ${options.owner}; ${runtimeExists ? 'reuse without resetting' : 'create'} runtime login ${options.runtimeUser}; ensure extensions and canonical migrations; grant application access and ledger SELECT only; ${saved === undefined ? 'create' : 'verify unchanged'} protected plugin.env; prove MCP. Server ${observed.address}:${String(observed.port)}, PostgreSQL ${String(observed.version)}. No service or host registration changes.`,
    );
    if (
      (await prompt(
        `Confirm changes: type "setup ${options.database} on ${options.host}:${String(options.port)}": `,
        false,
      )) !== `setup ${options.database} on ${options.host}:${String(options.port)}`
    )
      throw new Error('cancelled');
    if (!roles.some(role => role.rolname === options.owner))
      await administrator.query(
        `CREATE ROLE ${quote(options.owner)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
      );
    if (!runtimeExists)
      await administrator.query(
        `CREATE ROLE ${quote(options.runtimeUser)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${verifier!}'`,
      );
    if (existing === undefined)
      await administrator.query(`CREATE DATABASE ${quote(options.database)} OWNER ${quote(options.owner)}`);
    stage = 4;
    step = 'extensions';
    progress(stage, 'Verify intended ownership, required extensions and canonical migration postconditions.');
    const target = poolFor(targetAdminUrl.href);
    pools.push(target);
    await identity(target, options.database, options.adminUser, observed);
    const ownerReadback = (
      await target.query<{ owner: string }>(
        'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=current_database()',
      )
    ).rows[0];
    if (ownerReadback?.owner !== options.owner) throw new Error('database_conflict');
    const extensions = (
      await target.query<{ name: string }>('SELECT name FROM pg_available_extensions WHERE name=ANY($1::text[])', [
        ['vector', 'pg_trgm'],
      ])
    ).rows;
    if (extensions.length !== 2) throw new Error('extension_required');
    await target.query('CREATE EXTENSION IF NOT EXISTS vector');
    await target.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    const migrationPool = poolFor(targetAdminUrl.href, options.owner);
    pools.push(migrationPool);
    step = 'canonical_migrations';
    await identity(migrationPool, options.database, options.owner, observed);
    await runAiMemoryMigrations(migrationPool, { migrationsDir });
    step = 'runtime_grants';
    // Baseline assets include historical tables later dropped by that same
    // migration. Grant only canonical application relations actually present.
    const currentTables = (
      await target.query<{ name: string; owner: string }>(
        `SELECT c.relname AS name,pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')`,
      )
    ).rows;
    for (const relation of currentTables)
      if (
        (!tables.has(relation.name) && relation.name !== 'ai_memory_pgmigrations') ||
        relation.owner !== options.owner
      )
        throw new Error('schema_conflict');
    await target.query(`GRANT CONNECT ON DATABASE ${quote(options.database)} TO ${quote(options.runtimeUser)}`);
    await target.query(`GRANT USAGE ON SCHEMA public TO ${quote(options.runtimeUser)}`);
    for (const table of currentTables
      .map(relation => relation.name)
      .filter(name => name !== 'ai_memory_pgmigrations')) {
      await target.query(
        `GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.${quote(table)} TO ${quote(options.runtimeUser)}`,
      );
      const sequences = (
        await target.query<{ name: string }>(
          `SELECT s.relname AS name FROM pg_class s JOIN pg_depend d ON d.objid=s.oid AND d.classid='pg_class'::regclass JOIN pg_class t ON t.oid=d.refobjid JOIN pg_namespace n ON n.oid=s.relnamespace WHERE s.relkind='S' AND n.nspname='public' AND t.relname=$1 AND d.deptype IN ('a','i')`,
          [table],
        )
      ).rows;
      for (const sequence of sequences)
        await target.query(
          `GRANT USAGE,SELECT ON SEQUENCE public.${quote(sequence.name)} TO ${quote(options.runtimeUser)}`,
        );
    }
    await target.query(`GRANT SELECT ON public.ai_memory_pgmigrations TO ${quote(options.runtimeUser)}`);
    step = 'runtime_privileges';
    const privilege = (
      await target.query<{ unsafe: boolean }>(
        `SELECT has_schema_privilege($1,'public','CREATE') OR has_table_privilege($1,'public.ai_memory_pgmigrations','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_sequence_privilege($1,'public.ai_memory_pgmigrations_id_seq','USAGE,SELECT,UPDATE') AS unsafe`,
        [options.runtimeUser],
      )
    ).rows[0];
    if (privilege?.unsafe !== false) throw new Error('role_conflict');
    const runtime = poolFor(runtimeUrl);
    pools.push(runtime);
    step = 'runtime_login';
    await identity(runtime, options.database, options.runtimeUser, observed);
    await runAiMemoryMigrations(runtime, { migrationsDir, readOnly: true });
    database = 'ready';
    stage = 5;
    step = 'configuration_publication';
    progress(stage, 'Publish the protected runtime credential only after schema and least-privilege checks.');
    publication.commit();
    configurationSaved = true;
    password = '';
    stage = 6;
    step = 'runtime_readback';
    progress(
      stage,
      'Reconnect from protected configuration and verify actual read-only schema and MCP handshake/tools.',
    );
    const configurationReadback = loadPluginRuntimeEnv({ home: input.home, env: {} });
    if (configurationReadback.runtime.databaseUrl !== runtimeUrl) throw new Error('configuration_conflict');
    const verifiedUrl = new URL(runtimeUrl);
    verifiedUrl.searchParams.set('options', '-c default_transaction_read_only=on -c statement_timeout=5000');
    const environment: NodeJS.ProcessEnv = {
      HOME: input.home,
      PATH: (input.env ?? process.env).PATH,
      AI_MEMORY_DATABASE_URL: verifiedUrl.href,
      AI_MEMORY_PLUGIN_DOCTOR: '1',
      AI_MEMORY_PLUGIN_MIGRATIONS_MODE: 'require_complete',
      AI_MEMORY_MCP_AUTO_START_POSTGRES: 'false',
      AI_MEMORY_MCP_REQUIRE_POSTGRES: 'true',
      AI_MEMORY_MCP_TRANSPORT: 'stdio',
    };
    const { probeDatabase, probeMcp } = await import('./pluginDoctor.js');
    if ((await probeDatabase(environment, migrationsDir)) !== 'ready') {
      database = 'required';
      throw new Error('schema_required');
    }
    mcp = 'failed';
    if (
      !(await probeMcp(
        environment,
        resolve(packageRoot, 'plugins/ai-memory/dist/mcp-launcher.js'),
        getPackageVersion(),
      ))
    )
      throw new Error('mcp_required');
    mcp = 'connected';
    return {
      ok: true,
      state: 'runtime_verified',
      reason: 'ready',
      stage,
      database: 'ready',
      mcp: 'connected',
      configurationSaved,
      nextAction:
        'Local database/schema and packaged MCP connection verified. Install or inspect the native plugin separately with ai-memory plugin --help; explicitly reload/restart the host and review its hook trust. Backups and optional providers remain separate.',
    };
  } catch (error) {
    const reasons = new Set([
      'identity_conflict',
      'administrator_required',
      'setup_busy',
      'role_conflict',
      'database_conflict',
      'schema_conflict',
      'configuration_conflict',
      'credential_required',
      'cancelled',
      'extension_required',
      'schema_required',
      'mcp_required',
    ]);
    const reason =
      error instanceof Error && reasons.has(error.message)
        ? error.message
        : step === 'canonical_migrations' &&
            error instanceof Error &&
            /incompatible migration|migration assets/u.test(error.message)
          ? 'schema_conflict'
          : 'operation_failed';
    const code =
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string' &&
      /^[0-9A-Z]{5}$/u.test(error.code)
        ? error.code
        : undefined;
    const actions: Record<string, string> = {
      configuration_conflict:
        'Inspect the dedicated ~/.config/ai-memory/plugin.env and its parent directories with your trusted protected editor: regular owner-owned file 0600, protected directories, no symlinks. Preserve the existing file; select its matching target or explicitly resolve the conflict, then rerun the same setup command.',
      role_conflict:
        'Inspect the named owner/runtime role privileges and memberships. Select unused --owner and --runtime-user names or explicitly resolve the intended roles outside setup; existing passwords are never reset.',
      database_conflict:
        'Inspect the named database and its owner. Select the intended compatible database or an unused --database name; existing databases were preserved.',
      schema_conflict:
        'Inspect the intended database and canonical migration ledger. Use the matching reviewed package for a compatible initialized database, or select an unused --database. Untracked populated databases and incompatible history are preserved; setup never resets or adopts them implicitly.',
      administrator_required:
        'Rerun with --admin-user naming the intended local PostgreSQL superuser for initialization. The saved runtime login remains a separate non-owner role.',
      setup_busy: 'Wait for the active setup operation on this database to finish, then rerun the same setup command.',
      credential_required:
        'Rerun in a private terminal and enter the same new 12–256 printable ASCII credential twice, without spaces. Existing role passwords are never changed.',
      cancelled:
        'Rerun the same setup command in a private terminal when ready; completed compatible database work is preserved.',
      extension_required:
        'Install pgvector for the selected PostgreSQL 18 server using its maintained platform packages, then rerun the same command. Any sudo prompt requires your operating-system elevation credential, not a PostgreSQL password.',
      schema_required:
        'Recheck the saved runtime configuration and matching canonical migration ledger, then rerun the same setup command with the intended administrator.',
      mcp_required:
        'Rerun ai-memory setup from the same complete released package and inspect its packaged MCP readiness. Database work and saved protected configuration are preserved; native plugin trust/restart is separate.',
      identity_conflict:
        'Inspect the selected loopback host/port, administrator and intended database identity before rerunning. Setup will not redirect or replace a different server.',
    };
    return {
      ...failure(
        reason,
        `${configurationSaved ? 'Protected configuration was saved and is preserved. ' : ''}${actions[reason] ?? `Inspect the failed operation at stage ${String(stage)}/6 (${step}${code === undefined ? '' : `, SQLSTATE ${code}`}) and rerun the same setup command after resolving it. Completed compatible work is preserved; passwords and databases are never reset.`}`,
      ),
      step,
      ...(code === undefined ? {} : { code }),
    };
  } finally {
    if (administrator !== undefined) {
      await administrator.query('SELECT pg_advisory_unlock_all()').catch(() => {});
      administrator.release();
    }
    for (const pool of pools) await pool.end();
  }
}

function databaseUrl(options: SetupOptions, user: string, password: string, database: string): string {
  const url = new URL(
    `postgresql://${options.host === '::1' ? '[::1]' : options.host}:${String(options.port)}/${database}`,
  );
  url.username = user;
  url.password = password;
  return url.href;
}

async function privatePrompt(label: string, secret: boolean): Promise<string> {
  const stream = process.stdin;
  if (!stream.isTTY || !process.stderr.isTTY) throw new Error('interactive_required');
  const previousRaw = stream.isRaw;
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    let value = '';
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      stream.off('data', read);
      stream.off('end', end);
      process.off('SIGTERM', cancel);
      process.off('SIGINT', cancel);
      try {
        stream.setRawMode(previousRaw);
        stream.pause();
        process.stderr.write('\n');
      } catch {
        error ??= new Error('cancelled');
      }
      if (error) reject(error);
      else resolve(value);
    };
    const cancel = () => {
      finish(new Error('cancelled'));
    };
    const end = () => {
      finish(new Error('cancelled'));
    };
    const read = (data: Buffer) => {
      for (const character of decoder.write(data)) {
        if (character === '\u0003' || character === '\u0004') {
          cancel();
          return;
        }
        if (character === '\r' || character === '\n') {
          finish();
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = Array.from(value).slice(0, -1).join('');
          continue;
        }
        if (character < ' ' || value.length >= 4096) {
          cancel();
          return;
        }
        value += character;
        if (!secret) {
          try {
            process.stderr.write(character);
          } catch {
            cancel();
            return;
          }
        }
      }
    };
    stream.on('data', read);
    stream.once('end', end);
    process.once('SIGTERM', cancel);
    process.once('SIGINT', cancel);
    try {
      stream.setRawMode(true);
      stream.resume();
      process.stderr.write(label);
    } catch {
      finish(new Error('cancelled'));
    }
  });
}

function output(value: Record<string, unknown>, json: boolean): void {
  process.stdout.write(
    json
      ? `${JSON.stringify(value)}\n`
      : `${String(value.state)}: ${String(value.reason ?? '')}\n${String(value.nextAction)}\n`,
  );
}
