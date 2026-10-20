import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test, vi } from 'vitest';
import * as postgres from './ensure-postgres.js';
import { parseSetupArguments, runLocalPostgresSetup } from './localPostgresSetup.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'memory-setup-'));
  roots.push(home);
  return home;
}

test('terminal echo is disabled before a private administrator prompt becomes visible and restored afterwards', async () => {
  const home = fixture(),
    bin = join(home, 'bin');
  mkdirSync(bin);
  for (const name of ['psql', 'pg_config', 'pg_dump'])
    writeFileSync(join(bin, name), '#!/bin/sh\necho "PostgreSQL 18.6"\n', { mode: 0o700 });
  const stdin = process.stdin,
    stderr = process.stderr;
  const properties: Array<[object, string, PropertyDescriptor | undefined]> = [
    [stdin, 'isTTY', Object.getOwnPropertyDescriptor(stdin, 'isTTY')],
    [stdin, 'isRaw', Object.getOwnPropertyDescriptor(stdin, 'isRaw')],
    [stdin, 'setRawMode', Object.getOwnPropertyDescriptor(stdin, 'setRawMode')],
    [stderr, 'isTTY', Object.getOwnPropertyDescriptor(stderr, 'isTTY')],
  ];
  let raw = false,
    promptWasPrivate = false,
    breakOutput = false;
  const credential = 'administrátor-密碼-fixture%41%password';
  let receivedCredential: string | undefined;
  const probe = vi.spyOn(postgres, 'probePostgres').mockImplementation(async input => {
    receivedCredential = decodeURIComponent(new URL(input!.databaseUrl!).password);
    return {
      ok: false,
      databaseName: undefined,
      databaseUrl: 'postgresql://localhost/postgres',
      errorMessage: 'synthetic offline fixture',
      latencyMs: 0,
      serverVersion: undefined,
    };
  });
  const output: string[] = [];
  Object.defineProperty(stdin, 'isTTY', { configurable: true, value: true });
  Object.defineProperty(stderr, 'isTTY', { configurable: true, value: true });
  Object.defineProperty(stdin, 'isRaw', { configurable: true, get: () => raw });
  Object.defineProperty(stdin, 'setRawMode', {
    configurable: true,
    value: (enabled: boolean) => {
      raw = enabled;
      return stdin;
    },
  });
  const write = vi.spyOn(stderr, 'write').mockImplementation(chunk => {
    const text = String(chunk);
    output.push(text);
    if (text.includes('Existing PostgreSQL administrator password')) {
      if (breakOutput) throw new Error('synthetic terminal output failure');
      promptWasPrivate = raw;
      queueMicrotask(() => {
        for (const byte of Buffer.from(`${credential}\n`)) stdin.emit('data', Buffer.from([byte]));
      });
    }
    return true;
  });
  try {
    const result = await runLocalPostgresSetup(parseSetupArguments(['--port', '1']), { home, env: { PATH: bin } });
    assert.equal(result.reason, 'server_unavailable');
    assert.equal(promptWasPrivate, true);
    assert.equal(raw, false);
    assert.equal(receivedCredential, credential);
    assert.equal(output.join('').includes(credential), false);
    breakOutput = true;
    const failed = await runLocalPostgresSetup(parseSetupArguments(['--port', '1']), { home, env: { PATH: bin } });
    assert.equal(failed.reason, 'cancelled');
    assert.equal(raw, false);
  } finally {
    probe.mockRestore();
    write.mockRestore();
    for (const [object, name, descriptor] of properties) {
      if (descriptor === undefined) Reflect.deleteProperty(object, name);
      else Object.defineProperty(object, name, descriptor);
    }
  }
});

test('setup refuses ambiguous targets and never accepts passwords as options', () => {
  for (const flags of [
    ['--port', '0'],
    ['--port', '4.5'],
    ['--port', '65536'],
    ['--database', 'postgres'],
    ['--owner', 'postgres'],
    ['--runtime-user', 'pg_monitor'],
    ['--host', '127.0.0.1', '--host', 'localhost'],
    ['--database', 'name;DROP'],
    ['--password', 'fixture'],
    ['--url', 'postgresql://localhost/ai_memory'],
  ])
    assert.throws(() => parseSetupArguments(flags), /invalid_options/u);
});

test('missing clients report the exact prerequisite stage without credentials or writes', async () => {
  const home = fixture();
  const result = await runLocalPostgresSetup(parseSetupArguments([]), {
    home,
    env: { PATH: '/missing' },
    prompt: async () => {
      throw new Error('must not ask for credentials');
    },
  });
  assert.equal(result.state, 'setup_required');
  assert.equal(result.reason, 'prerequisite_missing');
  assert.equal(result.stage, 1);
  assert.match(result.nextAction, /PostgreSQL 18/u);
  assert.deepEqual(readdirSync(home), []);
});

test('unreachable server reports a labelled administrator stage and preserves configuration', async () => {
  const home = fixture(),
    bin = join(home, 'bin');
  mkdirSync(bin);
  for (const name of ['psql', 'pg_config', 'pg_dump'])
    writeFileSync(join(bin, name), '#!/bin/sh\necho "PostgreSQL 18.6"\n', { mode: 0o700 });
  const labels: string[] = [];
  const result = await runLocalPostgresSetup(parseSetupArguments(['--port', '1']), {
    home,
    env: { PATH: bin },
    prompt: async (label: string) => {
      labels.push(label);
      return 'fixture';
    },
  });
  assert.equal(result.reason, 'server_unavailable');
  assert.equal(result.stage, 2);
  assert.match(labels[0]!, /existing PostgreSQL administrator/iu);
  assert.doesNotMatch(JSON.stringify(result), /fixture|postgresql:\/\//u);
  assert.deepEqual(readdirSync(home), ['bin']);
});
