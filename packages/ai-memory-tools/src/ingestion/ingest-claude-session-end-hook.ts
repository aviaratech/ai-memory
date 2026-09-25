#!/usr/bin/env node

import { isRecord } from '@aviaratech/ai-memory/internal';

import { runSessionEndHook } from './session-end-hook.js';

async function main() {
  const payload = await readHookInput();
  const outcome = await runSessionEndHook({ payload });

  process.stdout.write(
    `${JSON.stringify({
      continue: outcome.continue,
      suppressOutput: outcome.suppressOutput,
    })}\n`,
  );
}

main().catch(() => {
  // Ensure the hook always emits valid JSON so Claude Code does not break.
  process.stdout.write(
    `${JSON.stringify({
      continue: true,
      suppressOutput: true,
    })}\n`,
  );
});

async function readHookInput() {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin as AsyncIterable<unknown>) {
    chunks.push(toChunkBuffer(chunk));
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw.length === 0) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toChunkBuffer(chunk: unknown): Buffer {
  if (typeof chunk === 'string') {
    return Buffer.from(chunk);
  }

  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }

  return Buffer.from(String(chunk));
}
