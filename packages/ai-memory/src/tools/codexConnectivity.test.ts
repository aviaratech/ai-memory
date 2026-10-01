import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { parse, type TomlTable } from 'smol-toml';

vi.mock('./ensure-postgres.js', () => ({
  ensurePostgresRunning: vi.fn().mockRejectedValue(new Error('synthetic-private-password')),
}));
vi.mock('node:child_process', () => ({
  execFile: vi.fn(
    (
      _command: string,
      _args: string[],
      _options: unknown,
      callback: (error: null, result: { stdout: string; stderr: string }) => void,
    ) => {
      callback(null, { stdout: '{"loaded":false,"plistExists":false,"status":"not_loaded"}', stderr: '' });
    },
  ),
}));

import { collectDoctorReport, ensureCliRegistration } from './codexConnectivity.js';
import { resolveAiMemoryServerScriptPath } from './codexAiMemoryConfig.js';

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ai-memory-codex-repair-'));
  directories.push(directory);
  const codexConfigPath = join(directory, 'config.toml');
  const nodeExecPath = join(directory, 'selected-node');
  mkdirSync(join(directory, 'memory-consumers'));
  const protectedLauncherPath = join(directory, 'memory-consumers', 'mcp-launcher.mjs');
  symlinkSync(process.execPath, nodeExecPath);
  writeFileSync(protectedLauncherPath, 'throw new Error("wrapper must not execute during diagnosis or repair");');
  const input = { quiet: true, codexConfigPath, nodeExecPath, protectedLauncherPath };
  const unrelated = '[mcp_servers.other]\ncommand = "other-service"\nargs = ["unchanged"]\n';
  const configuration = `${unrelated}\n[mcp_servers.ai-memory]\ncommand = ${JSON.stringify(nodeExecPath)}\nargs = [${JSON.stringify(protectedLauncherPath)}]\n`;
  writeFileSync(codexConfigPath, configuration, { mode: 0o600 });
  return { input, configuration, unrelated };
}

test('explicit protected repair preserves the healthy one-argument registration byte for byte', async () => {
  const { input, configuration } = fixture();
  assert.equal(await ensureCliRegistration(input), false);
  assert.equal(readFileSync(input.codexConfigPath, 'utf8'), configuration);
});

test('unrecognized registration is preserved without building inline database credentials', async () => {
  const { input, configuration } = fixture();
  await assert.rejects(
    ensureCliRegistration({ quiet: true, codexConfigPath: input.codexConfigPath }),
    /external or conflicting/u,
  );
  assert.equal(readFileSync(input.codexConfigPath, 'utf8'), configuration);
});

test('explicit protected repair fixes stale Node and removes inline secrets while preserving other entries', async () => {
  const { input, configuration, unrelated } = fixture();
  writeFileSync(
    input.codexConfigPath,
    `${configuration.replace(JSON.stringify(input.nodeExecPath), '"node"')}\n[mcp_servers.ai-memory.env]\nPRIVATE_TOKEN = "synthetic-private-password"\n`,
  );
  assert.equal(await ensureCliRegistration(input), true);
  const actual = readFileSync(input.codexConfigPath, 'utf8');
  assert.deepEqual((parse(actual).mcp_servers as TomlTable).other, (parse(unrelated).mcp_servers as TomlTable).other);
  assert.ok(actual.includes(JSON.stringify(input.nodeExecPath)));
  assert.equal(actual.includes('synthetic-private-password'), false);
  assert.equal(actual.includes('.env]'), false);
});

test('conflicting selected wrapper and unavailable wrapper do not mutate recoverable configuration', async () => {
  const { input, configuration } = fixture();
  await assert.rejects(
    ensureCliRegistration({ ...input, protectedLauncherPath: join(tmpdir(), 'unselected-script.mjs') }),
    /external or conflicting/u,
  );
  assert.equal(readFileSync(input.codexConfigPath, 'utf8'), configuration);
  rmSync(input.protectedLauncherPath);
  await assert.rejects(ensureCliRegistration(input), /unavailable/u);
  assert.equal(readFileSync(input.codexConfigPath, 'utf8'), configuration);
});

test('quoted existing registration is a conflict and is never overwritten', async () => {
  const { input } = fixture();
  const raw = '[mcp_servers."ai-memory"]\ncommand = "external"\nargs = ["other-script"]\n';
  writeFileSync(input.codexConfigPath, raw);
  await assert.rejects(ensureCliRegistration(input), /external or conflicting/u);
  assert.equal(readFileSync(input.codexConfigPath, 'utf8'), raw);
});

test('dotted and indented quoted external registrations are preserved', async () => {
  const { input } = fixture();
  for (const raw of [
    'mcp_servers.ai-memory.command = "external"\nmcp_servers.ai-memory.args = ["other-script"]\n',
    '  [mcp_servers."ai-memory"]\n  command = "external"\n  args = ["other-script"]\n',
  ]) {
    writeFileSync(input.codexConfigPath, raw);
    await assert.rejects(ensureCliRegistration(input), /external or conflicting/u);
    assert.equal(readFileSync(input.codexConfigPath, 'utf8'), raw);
  }
});

test('healthy dotted registration with literal strings remains byte for byte unchanged', async () => {
  const { input } = fixture();
  const raw = `mcp_servers.'ai-memory'.command = '${input.nodeExecPath}'\nmcp_servers.'ai-memory'.args = ['${input.protectedLauncherPath}']\n`;
  writeFileSync(input.codexConfigPath, raw);
  assert.equal(await ensureCliRegistration(input), false);
  assert.equal(readFileSync(input.codexConfigPath, 'utf8'), raw);
});

test('literal extra arguments are a conflict even when the selected Node is stale', async () => {
  const { input, configuration } = fixture();
  const raw = configuration
    .replace(JSON.stringify(input.nodeExecPath), '"node"')
    .replace(
      `args = [${JSON.stringify(input.protectedLauncherPath)}]`,
      `args = [${JSON.stringify(input.protectedLauncherPath)}, '--extra']`,
    );
  writeFileSync(input.codexConfigPath, raw);
  await assert.rejects(ensureCliRegistration(input), /external or conflicting/u);
  assert.equal(readFileSync(input.codexConfigPath, 'utf8'), raw);
});

test('quoted and indented inline environments are unready and removed by explicit repair', async () => {
  const { input, configuration } = fixture();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unreachable')));
  for (const suffix of [
    '\n[mcp_servers."ai-memory".env]\nPRIVATE_TOKEN = "synthetic-private-password"\n',
    '  env = { PRIVATE_TOKEN = "synthetic-private-password" }\n',
  ]) {
    writeFileSync(input.codexConfigPath, configuration + suffix);
    const before = await collectDoctorReport(input);
    assert.equal(before.registration.ok, false);
    assert.equal(before.registration.mismatches.includes('inline_env_not_allowed'), true);
    assert.equal(await ensureCliRegistration(input), true);
    assert.equal(readFileSync(input.codexConfigPath, 'utf8').includes('synthetic-private-password'), false);
    assert.equal((await collectDoctorReport(input)).registration.ok, true);
  }
});

test('indented disabled registration is preserved and diagnosed as unready', async () => {
  const { input, configuration } = fixture();
  const raw = `${configuration}  enabled = false\n`;
  writeFileSync(input.codexConfigPath, raw);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unreachable')));
  assert.equal((await collectDoctorReport(input)).registration.ok, false);
  await assert.rejects(ensureCliRegistration(input), /unsupported configuration form/u);
  assert.equal(readFileSync(input.codexConfigPath, 'utf8'), raw);
});

test('repair preserves an unrelated quoted project key containing a closing bracket', async () => {
  const { input, configuration } = fixture();
  const unrelated = '[projects."/synthetic/project[work]"]\ntrust_level = "trusted"\n';
  const raw = `${configuration.replace(JSON.stringify(input.nodeExecPath), '"node"')}\n[mcp_servers.ai-memory.env]\nPRIVATE_TOKEN = "synthetic-private-password"\n\n${unrelated}`;
  writeFileSync(input.codexConfigPath, raw);
  assert.equal(await ensureCliRegistration(input), true);
  const actual = readFileSync(input.codexConfigPath, 'utf8');
  assert.ok(actual.includes('"/synthetic/project[work]"'));
  assert.ok(actual.includes('trust_level = "trusted"'));
});

test('a missing registration is not created for an unavailable selected wrapper', async () => {
  const { input } = fixture();
  rmSync(input.codexConfigPath);
  rmSync(input.protectedLauncherPath);
  await assert.rejects(ensureCliRegistration(input), /unavailable/u);
  assert.throws(() => readFileSync(input.codexConfigPath));
});

test('disabled and unsupported nested registrations are preserved and diagnosed as unready', async () => {
  const { input, configuration } = fixture();
  for (const suffix of [
    'enabled = false\n',
    '\n[mcp_servers.ai-memory.env.nested]\nSECRET = "synthetic-private-password"\n',
  ]) {
    const raw = configuration + suffix;
    writeFileSync(input.codexConfigPath, raw);
    await assert.rejects(ensureCliRegistration(input), /unsupported configuration form/u);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unreachable')));
    assert.equal((await collectDoctorReport(input)).registration.ok, false);
    assert.equal(readFileSync(input.codexConfigPath, 'utf8'), raw);
  }
});

test('doctor is read only and distinguishes protected configuration from unavailable runtime readiness without secrets', async () => {
  const { input, configuration } = fixture();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('synthetic-private-password')));
  const report = await collectDoctorReport(input);
  assert.equal(report.registration.ok, true);
  assert.equal(report.registration.status, 'configured_protected');
  assert.equal(report.postgres.status, 'not_checked');
  assert.equal(report.ok, false);
  assert.equal(report.httpHealth.ok, false);
  assert.equal(JSON.stringify(report).includes('synthetic-private-password'), false);
  assert.equal(readFileSync(input.codexConfigPath, 'utf8'), configuration);
});

test('an undeclared external wrapper is diagnosed as a conflict, separate from runtime health', async () => {
  const { input, configuration } = fixture();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' }));
  const report = await collectDoctorReport({ codexConfigPath: input.codexConfigPath });
  assert.equal(report.registration.status, 'external_registration');
  assert.equal(report.registration.ok, false);
  assert.equal(report.httpHealth.ok, true);
  assert.equal(readFileSync(input.codexConfigPath, 'utf8'), configuration);
});

test('stale package direct registration is repaired in the existing owner', async () => {
  const { input } = fixture();
  const configuration = `[mcp_servers.ai-memory]\ncommand = "node"\nargs = [${JSON.stringify(resolveAiMemoryServerScriptPath())}]\n\n[mcp_servers.ai-memory.env]\nAI_MEMORY_DATABASE_URL = "postgresql://localhost:5432/synthetic_memory"\nAI_MEMORY_POSTGRES_REQUIRED_MAJOR = "18"\n`;
  writeFileSync(input.codexConfigPath, configuration);
  assert.equal(await ensureCliRegistration({ quiet: true, codexConfigPath: input.codexConfigPath }), true);
  assert.ok(readFileSync(input.codexConfigPath, 'utf8').includes(JSON.stringify(process.execPath)));
});
