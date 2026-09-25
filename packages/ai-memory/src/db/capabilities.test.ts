import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'vitest';

import { getCapabilities, probeCapabilities, resetCapabilitiesForTests } from './capabilities.js';

interface ProbeClientOptions {
  extensionNames?: string[];
  hasEmbeddingColumn?: boolean;
  throwOnExtensionQuery?: boolean;
}

interface ProbeQueryCall {
  sql: string;
  values?: readonly unknown[] | undefined;
}

function createProbeClient(options: ProbeClientOptions = {}) {
  const calls: ProbeQueryCall[] = [];
  const { extensionNames = [], hasEmbeddingColumn = false, throwOnExtensionQuery = false } = options;

  return {
    calls,
    query(sql: string, values?: readonly unknown[]) {
      calls.push({ sql, values });

      if (sql.includes('information_schema.columns')) {
        return Promise.resolve({ rows: [{ exists: hasEmbeddingColumn }] });
      }

      if (sql.includes('FROM pg_extension')) {
        if (throwOnExtensionQuery) {
          return Promise.reject(new Error('extension probe failed'));
        }
        return Promise.resolve({
          rows: extensionNames.map(extname => ({ extname })),
        });
      }

      return Promise.reject(new Error(`Unexpected SQL: ${sql}`));
    },
  };
}

describe('probeCapabilities', () => {
  beforeEach(() => {
    resetCapabilitiesForTests();
  });

  afterEach(() => {
    resetCapabilitiesForTests();
  });

  it('returns all-false when embedding column and extensions are absent', async () => {
    const client = createProbeClient({
      extensionNames: [],
      hasEmbeddingColumn: false,
    });

    const capabilities = await probeCapabilities(client);

    assert.deepEqual(capabilities, {
      hasEmbeddingColumn: false,
      hasTrigram: false,
      hasVector: false,
    });
    assert.deepEqual(getCapabilities(), capabilities);
  });

  it('returns all-true when embedding column, vector, and pg_trgm are present', async () => {
    const client = createProbeClient({
      extensionNames: ['vector', 'pg_trgm'],
      hasEmbeddingColumn: true,
    });

    const capabilities = await probeCapabilities(client);

    assert.deepEqual(capabilities, {
      hasEmbeddingColumn: true,
      hasTrigram: true,
      hasVector: true,
    });
    assert.deepEqual(getCapabilities(), capabilities);
  });

  it('returns all-false when probe query throws', async () => {
    const client = createProbeClient({
      extensionNames: ['vector', 'pg_trgm'],
      hasEmbeddingColumn: true,
      throwOnExtensionQuery: true,
    });

    const capabilities = await probeCapabilities(client);

    assert.deepEqual(capabilities, {
      hasEmbeddingColumn: false,
      hasTrigram: false,
      hasVector: false,
    });
  });

  it('caches the first probe result for subsequent calls', async () => {
    const firstClient = createProbeClient({
      extensionNames: ['vector'],
      hasEmbeddingColumn: true,
    });
    const secondClient = createProbeClient({
      extensionNames: ['vector', 'pg_trgm'],
      hasEmbeddingColumn: false,
    });

    const firstProbe = await probeCapabilities(firstClient);
    const secondProbe = await probeCapabilities(secondClient);

    assert.deepEqual(secondProbe, firstProbe);
    assert.equal(firstClient.calls.length, 2);
    assert.equal(secondClient.calls.length, 0);
  });
});
