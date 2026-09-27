#!/usr/bin/env node

import { closePool, getDatabaseUrlForDisplay, initializeDatabase } from '@aviaratech/ai-memory/internal';

import { bootstrapAiMemoryCliRuntimeEnv } from './runtimeEnv.js';

async function main() {
  bootstrapAiMemoryCliRuntimeEnv();
  await initializeDatabase();
  process.stdout.write(`[ai-memory] schema is ready (${getDatabaseUrlForDisplay()})\n`);
}

void (async () => {
  try {
    await main();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[ai-memory] init failed: ${message}\n`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
})();
