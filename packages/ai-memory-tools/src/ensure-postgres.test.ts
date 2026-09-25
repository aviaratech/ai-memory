import { buildSync } from 'esbuild';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ensurePostgresRunning,
  formatPostgresProbeError,
  formatPostgresRecoveryHint,
  getPostgresMajorMismatchMessage,
} from './ensure-postgres.js';

const currentFile = fileURLToPath(import.meta.url);
const packageRoot = join(dirname(currentFile), '..');
const ensurePostgresScript = join(packageRoot, 'src', 'ensure-postgres.ts');
const checkSessionStartHookScript = join(packageRoot, 'src', 'ingestion', 'check-session-start-hook.ts');

/**
 * Writes a Node ESM loader pair (loader + register entry) into a temp directory
 * that throws ERR_MODULE_NOT_FOUND for the given workspace specifier. Returns
 * the file URL of the register entry so it can be passed via `node --import`.
 *
 * Using a loader instead of renaming the real `packages/<pkg>/dist/index.js`
 * keeps the regression test isolated from other tests in the same package
 * (whose subprocesses may import the same shared file concurrently).
 */
interface MissingWorkspaceModuleLoaderOptions {
  blockedSpecifier: string;
  distMarker: string;
  fixtureDir: string;
}

function writeMissingWorkspaceModuleLoader(options: MissingWorkspaceModuleLoaderOptions): URL {
  const { blockedSpecifier, distMarker, fixtureDir } = options;
  const loaderPath = join(fixtureDir, 'loader.mjs');
  const registerPath = join(fixtureDir, 'register.mjs');
  const literalSpecifier = JSON.stringify(blockedSpecifier);
  const literalDistMarker = JSON.stringify(distMarker);

  writeFileSync(
    loaderPath,
    [
      'export function resolve(specifier, context, nextResolve) {',
      `  const blocked = ${literalSpecifier};`,
      `  const distMarker = ${literalDistMarker};`,
      '  const normalized = String(specifier).replaceAll("\\\\", "/");',
      '  if (specifier === blocked || normalized.includes(distMarker)) {',
      '    const parent = context && typeof context.parentURL === "string" ? context.parentURL : "<unknown>";',
      '    const error = new Error("Cannot find package \'" + blocked + "\' imported from " + parent);',
      '    error.code = "ERR_MODULE_NOT_FOUND";',
      '    error.specifier = blocked;',
      '    throw error;',
      '  }',
      '  return nextResolve(specifier, context);',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );

  writeFileSync(
    registerPath,
    ["import { register } from 'node:module';", "register('./loader.mjs', import.meta.url);", ''].join('\n'),
    'utf8',
  );

  return pathToFileURL(registerPath);
}

const TEST_REMOTE_DATABASE_URL = 'postgresql://memory:secret@db.example.invalid:5432/sample_db?sslmode=require';

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }

  process.env[key] = value;
}

test('remote database configuration is rejected before recovery guidance', () => {
  const previousDatabaseUrl = process.env.AI_MEMORY_DATABASE_URL;
  const previousStartCommand = process.env.AI_MEMORY_POSTGRES_START_COMMAND;

  try {
    process.env.AI_MEMORY_DATABASE_URL = TEST_REMOTE_DATABASE_URL;
    delete process.env.AI_MEMORY_POSTGRES_START_COMMAND;

    assert.throws(() => formatPostgresRecoveryHint(), /loopback host/u);
  } finally {
    restoreEnv('AI_MEMORY_DATABASE_URL', previousDatabaseUrl);
    restoreEnv('AI_MEMORY_POSTGRES_START_COMMAND', previousStartCommand);
  }
});

test('remote recovery hint surfaces probe error before local-only guidance', () => {
  const hint = formatPostgresRecoveryHint(TEST_REMOTE_DATABASE_URL, 'connect ETIMEDOUT (code: ETIMEDOUT)');

  assert.match(hint, /^Postgres probe failed: connect ETIMEDOUT \(code: ETIMEDOUT\)\. /u);
  assert.ok(
    hint.indexOf('connect ETIMEDOUT') < hint.indexOf('configure a loopback'),
    'expected the concrete probe error before generic recovery guidance',
  );
});

test('PostgreSQL 18.2 has no major mismatch for the local target', () => {
  assert.equal(
    getPostgresMajorMismatchMessage({
      requiredMajor: 18,
      serverVersion: 'PostgreSQL 18.2 on aarch64-unknown-linux-gnu',
    }),
    undefined,
  );
});

test('unsupported PostgreSQL majors produce a mismatch diagnostic', () => {
  assert.match(
    getPostgresMajorMismatchMessage({
      requiredMajor: 18,
      serverVersion: 'PostgreSQL 16.10 on aarch64-apple-darwin',
    }) ?? '',
    /Detected PostgreSQL 16\.10.*; ai-memory requires PostgreSQL 18\.x/u,
  );
});

test('probe error formatting preserves remote connection error code', () => {
  const error = new Error('connect ETIMEDOUT');
  Object.assign(error, { code: 'ETIMEDOUT' });

  assert.equal(formatPostgresProbeError(error), 'connect ETIMEDOUT (code: ETIMEDOUT)');
});

test('ensurePostgresRunning rejects remote database URLs before startup', async () => {
  const previousDatabaseUrl = process.env.AI_MEMORY_DATABASE_URL;
  const previousPath = process.env.PATH;
  const previousStartCommand = process.env.AI_MEMORY_POSTGRES_START_COMMAND;

  try {
    process.env.AI_MEMORY_DATABASE_URL = TEST_REMOTE_DATABASE_URL;
    process.env.AI_MEMORY_POSTGRES_START_COMMAND = 'false';
    process.env.PATH = '/usr/bin:/bin';

    await assert.rejects(
      ensurePostgresRunning({
        connectTimeoutMs: 20,
        logProgress: false,
        startCommandTimeoutMs: 20,
        startIfNeeded: true,
      }),
      /loopback host/u,
    );
  } finally {
    restoreEnv('AI_MEMORY_DATABASE_URL', previousDatabaseUrl);
    restoreEnv('AI_MEMORY_POSTGRES_START_COMMAND', previousStartCommand);
    restoreEnv('PATH', previousPath);
  }
});

test('recovery hint rejects unsupported remote targets', () => {
  const hint = formatPostgresRecoveryHint(TEST_REMOTE_DATABASE_URL);
  assert.match(hint, /loopback PostgreSQL URL/u);
  assert.doesNotMatch(hint, /AWS_PROFILE|AWS_REGION/u);
});

test('source-running ensure-postgres does not crash on missing ai-memory dist artifacts', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', ensurePostgresScript, '--status', '--quiet'], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      AI_MEMORY_DATABASE_URL: 'postgresql://invalid:invalid@127.0.0.1:1/ai_memory',
    },
    timeout: 20_000,
  });

  assert.notEqual(result.status, 0, 'expected the dummy database probe to fail');
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/u);
  assert.doesNotMatch(result.stderr, /dist\/internal\.js/u);
});

test('source-running session-start hook surfaces missing @aviaratech/ai-memory dist as actionable warning', () => {
  // If @aviaratech/ai-memory dist outputs are missing in a fresh checkout,
  // the dynamic import of
  // ./session-start-hook.js would throw ERR_MODULE_NOT_FOUND through
  // `@aviaratech/ai-memory/internal`, and the defensive top-level catch in
  // check-session-start-hook.ts would silently swallow it. This test pins the
  // fix: a missing ai-memory internal build surfaces an explicit systemMessage
  // warning instead of an empty success envelope.
  const fixtureDir = mkdtempSync(join(tmpdir(), 'ai-memory-tools-missing-ai-memory-hook-'));

  try {
    const registerUrl = writeMissingWorkspaceModuleLoader({
      blockedSpecifier: '@aviaratech/ai-memory/internal',
      distMarker: '/ai-memory/dist/internal',
      fixtureDir,
    });

    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--import', registerUrl.href, checkSessionStartHookScript, '--hook'],
      {
        cwd: packageRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          AI_MEMORY_DATABASE_URL: 'postgresql://invalid:invalid@127.0.0.1:1/ai_memory',
          AI_MEMORY_LOG_STDERR: '1',
        },
        input: JSON.stringify({ cwd: packageRoot, hook_event_name: 'SessionStart' }),
        timeout: 20_000,
      },
    );

    assert.equal(
      result.status,
      0,
      `session-start hook must exit cleanly when ai-memory dist is missing; got status ${String(result.status)}, stderr=${result.stderr}`,
    );
    assert.doesNotMatch(
      result.stderr,
      /ERR_MODULE_NOT_FOUND/u,
      'session-start hook must not leak ERR_MODULE_NOT_FOUND when ai-memory internal dist is missing',
    );
    assert.match(
      result.stderr,
      /@aviaratech\/ai-memory build artifacts are unavailable/u,
      'operator must see the actionable build-artifacts warning when ai-memory internal dist is missing',
    );

    const stdoutTrimmed = result.stdout.trim();
    const parsed: unknown = JSON.parse(stdoutTrimmed);
    assert.ok(parsed !== null && typeof parsed === 'object', 'hook stdout must parse as a JSON object');
    const envelope = parsed as { continue?: unknown; systemMessage?: unknown };
    assert.equal(envelope.continue, true, 'hook output envelope must include continue:true');
    assert.equal(typeof envelope.systemMessage, 'string', 'hook envelope must include the systemMessage warning');
    assert.match(
      String(envelope.systemMessage ?? ''),
      /@aviaratech\/ai-memory build artifacts are unavailable/u,
      'hook envelope systemMessage must name the missing ai-memory build artifacts',
    );
  } finally {
    rmSync(fixtureDir, { force: true, recursive: true });
  }
});

test('bundled import of ensure-postgres does not run the CLI side effect', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'ai-memory-ensure-postgres-bundle-'));
  const entryPath = join(fixtureRoot, 'entry.mjs');
  const bundlePath = join(fixtureRoot, 'bundle.mjs');

  try {
    writeFileSync(
      entryPath,
      [`import ${JSON.stringify(ensurePostgresScript)};`, "process.stdout.write('entry-ok\\n');", ''].join('\n'),
      'utf8',
    );

    buildSync({
      banner: {
        js: `import { createRequire as __aviaraCreateRequire } from 'node:module'; const require = __aviaraCreateRequire(import.meta.url);`,
      },
      bundle: true,
      entryPoints: [entryPath],
      external: ['node:*'],
      format: 'esm',
      logLevel: 'silent',
      outfile: bundlePath,
      platform: 'node',
      target: 'node22',
    });

    const result = spawnSync(process.execPath, [realpathSync(bundlePath)], {
      cwd: packageRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        AI_MEMORY_DATABASE_URL: 'postgresql://invalid:invalid@127.0.0.1:1/ai_memory',
      },
      timeout: 10_000,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'entry-ok\n');
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
});
