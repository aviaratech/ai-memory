import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'vitest';

import type * as SmokeIngestModuleNamespace from './smoke-ingest.js';

const FIXTURE_FILES = ['context_pack.json', 'memory_delta.json'] as const;
type SmokeIngestModule = typeof SmokeIngestModuleNamespace;
let smokeIngestModuleLoadCounter = 0;

function createFixtureDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-fixture-'));
  for (const fixtureFile of FIXTURE_FILES) {
    writeFileSync(join(dir, fixtureFile), '{}', 'utf8');
  }

  return dir;
}

async function loadSmokeIngestModule(): Promise<SmokeIngestModule> {
  const moduleUrl = new URL(
    `./smoke-ingest.js?cacheBust=${String(Date.now())}-${String(++smokeIngestModuleLoadCounter)}`,
    import.meta.url,
  ).href;
  return (await import(moduleUrl)) as SmokeIngestModule;
}

async function withDbEnvUnset<T>(run: () => Promise<T>): Promise<T> {
  const previous = {
    AI_MEMORY_DATABASE_URL: process.env.AI_MEMORY_DATABASE_URL,
    AVIARA_MEMORY_DATABASE_URL: process.env.AVIARA_MEMORY_DATABASE_URL,
    DATABASE_URL: process.env.DATABASE_URL,
  };

  delete process.env.AI_MEMORY_DATABASE_URL;
  delete process.env.AVIARA_MEMORY_DATABASE_URL;
  delete process.env.DATABASE_URL;

  try {
    return await run();
  } finally {
    if (previous.AI_MEMORY_DATABASE_URL === undefined) {
      delete process.env.AI_MEMORY_DATABASE_URL;
    } else {
      process.env.AI_MEMORY_DATABASE_URL = previous.AI_MEMORY_DATABASE_URL;
    }

    if (previous.AVIARA_MEMORY_DATABASE_URL === undefined) {
      delete process.env.AVIARA_MEMORY_DATABASE_URL;
    } else {
      process.env.AVIARA_MEMORY_DATABASE_URL = previous.AVIARA_MEMORY_DATABASE_URL;
    }

    if (previous.DATABASE_URL === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previous.DATABASE_URL;
    }
  }
}

async function withFixtureEnv<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env.AI_MEMORY_SMOKE_FIXTURE_PATH;

  if (value === undefined) {
    delete process.env.AI_MEMORY_SMOKE_FIXTURE_PATH;
  } else {
    process.env.AI_MEMORY_SMOKE_FIXTURE_PATH = value;
  }

  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.AI_MEMORY_SMOKE_FIXTURE_PATH;
    } else {
      process.env.AI_MEMORY_SMOKE_FIXTURE_PATH = previous;
    }
  }
}

test('smoke-ingest helper module imports without DB env when not executing CLI main', async () => {
  await withDbEnvUnset(async () => {
    const mod = await loadSmokeIngestModule();
    assert.equal(typeof mod.getSmokeContractFixturePath, 'function');
  });
});

test('getSmokeContractFixturePath resolves the repo-local default path when no override is provided', async () => {
  await withFixtureEnv(undefined, async () => {
    const { DEFAULT_SMOKE_FIXTURE_PATH, getSmokeContractFixturePath } = await loadSmokeIngestModule();
    assert.equal(getSmokeContractFixturePath(['node', '/repo/smoke-ingest.ts']), resolve(DEFAULT_SMOKE_FIXTURE_PATH));
  });
});

test('getSmokeContractFixturePath honors --fixture-path command-line argument', async () => {
  const fixturePath = createFixtureDirectory();
  try {
    const { getSmokeContractFixturePath } = await loadSmokeIngestModule();
    assert.equal(
      getSmokeContractFixturePath(['node', 'smoke-ingest.ts', '--fixture-path', fixturePath]),
      resolve(fixturePath),
    );
  } finally {
    rmSync(fixturePath, { force: true, recursive: true });
  }
});

test('getSmokeContractFixturePath uses AI_MEMORY_SMOKE_FIXTURE_PATH when CLI argument is not provided', async () => {
  const fixturePath = createFixtureDirectory();
  try {
    await withFixtureEnv(fixturePath, async () => {
      const { getSmokeContractFixturePath } = await loadSmokeIngestModule();
      assert.equal(getSmokeContractFixturePath(['node', 'smoke-ingest.ts']), resolve(fixturePath));
    });
  } finally {
    rmSync(fixturePath, { force: true, recursive: true });
  }
});

test('getSmokeContractFixturePath validates required fixture files', async () => {
  const fixturePath = createFixtureDirectory();
  rmSync(join(fixturePath, 'memory_delta.json'), { force: true });

  try {
    const { getSmokeContractFixturePath } = await loadSmokeIngestModule();
    assert.throws(() => {
      getSmokeContractFixturePath(['node', 'smoke-ingest.ts', '--fixture-path', fixturePath]);
    }, /fixture file missing/);
  } finally {
    rmSync(fixturePath, { force: true, recursive: true });
  }
});
