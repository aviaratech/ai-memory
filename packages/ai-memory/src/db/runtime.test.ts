import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { CONTEXT_PACK_TOOL, getDatabaseUrl, MEMORY_STATUS_VALUES, pool, SENSITIVITY_VALUES } from './runtime.js';

describe('runtime lazy pool', () => {
  it('exports constants without requiring a database URL', () => {
    assert.equal(CONTEXT_PACK_TOOL, 'context-pack');
    assert.ok(Array.isArray(MEMORY_STATUS_VALUES));
  });

  it('MEMORY_STATUS_VALUES and SENSITIVITY_VALUES are populated arrays', () => {
    // These constants must be assigned before any fallible I/O (schema loading)
    // in the module body so that esbuild __esm lazy-init failures cannot leave
    // them undefined — see the hoisting comment in runtime.ts.
    assert.ok(Array.isArray(MEMORY_STATUS_VALUES), 'MEMORY_STATUS_VALUES must be an array');
    assert.ok(MEMORY_STATUS_VALUES.length > 0, 'MEMORY_STATUS_VALUES must not be empty');
    assert.ok(MEMORY_STATUS_VALUES.includes('active'), 'MEMORY_STATUS_VALUES must include active');

    assert.ok(Array.isArray(SENSITIVITY_VALUES), 'SENSITIVITY_VALUES must be an array');
    assert.ok(SENSITIVITY_VALUES.length > 0, 'SENSITIVITY_VALUES must not be empty');
    assert.ok(SENSITIVITY_VALUES.includes('internal'), 'SENSITIVITY_VALUES must include internal');
  });

  it('getDatabaseUrl reads process.env at call time, not import time', () => {
    const saved = process.env.AI_MEMORY_DATABASE_URL;
    const sentinel = 'postgresql://lazy-test@127.0.0.1:5432/test';
    try {
      delete process.env.AI_MEMORY_DATABASE_URL;
      delete process.env.AVIARA_MEMORY_DATABASE_URL;
      delete process.env.DATABASE_URL;
      assert.equal(getDatabaseUrl(), undefined);

      process.env.AI_MEMORY_DATABASE_URL = sentinel;
      assert.equal(getDatabaseUrl(), sentinel);
    } finally {
      if (saved !== undefined) {
        process.env.AI_MEMORY_DATABASE_URL = saved;
      } else {
        delete process.env.AI_MEMORY_DATABASE_URL;
      }
    }
  });

  it('pool methods throw when DATABASE_URL is unset and no prior pool exists', () => {
    const saved = process.env.AI_MEMORY_DATABASE_URL;
    const savedAviara = process.env.AVIARA_MEMORY_DATABASE_URL;
    const savedGeneric = process.env.DATABASE_URL;
    const savedAwsRegion = process.env.AWS_REGION;
    const savedDbHost = process.env.DB_HOST;
    const savedDbPort = process.env.DB_PORT;
    const savedDbName = process.env.DB_NAME;
    const savedDbUser = process.env.DB_USER;
    try {
      delete process.env.AI_MEMORY_DATABASE_URL;
      delete process.env.AVIARA_MEMORY_DATABASE_URL;
      delete process.env.DATABASE_URL;
      delete process.env.AWS_REGION;
      delete process.env.DB_HOST;
      delete process.env.DB_PORT;
      delete process.env.DB_NAME;
      delete process.env.DB_USER;

      assert.throws(
        () => pool.query('SELECT 1'),
        (err: Error) => {
          assert.match(err.message, /AI_MEMORY_DATABASE_URL is required/u);
          return true;
        },
      );
    } finally {
      if (saved !== undefined) process.env.AI_MEMORY_DATABASE_URL = saved;
      if (savedAviara !== undefined) process.env.AVIARA_MEMORY_DATABASE_URL = savedAviara;
      if (savedGeneric !== undefined) process.env.DATABASE_URL = savedGeneric;
      if (savedAwsRegion !== undefined) process.env.AWS_REGION = savedAwsRegion;
      if (savedDbHost !== undefined) process.env.DB_HOST = savedDbHost;
      if (savedDbPort !== undefined) process.env.DB_PORT = savedDbPort;
      if (savedDbName !== undefined) process.env.DB_NAME = savedDbName;
      if (savedDbUser !== undefined) process.env.DB_USER = savedDbUser;
    }
  });
});
