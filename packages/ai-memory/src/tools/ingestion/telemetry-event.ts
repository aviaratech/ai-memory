import { randomUUID } from 'node:crypto';
import { createPool, assertLocalDatabaseUrl, type DbPool } from '../../db/pool.js';
import { insertWorkflowEvent } from '../../db/workflow-events.js';
import {
  parseTelemetryEvent,
  projectHostTelemetry,
  type TelemetryRejectCode,
  type TelemetryEventV1,
} from '../../telemetry/event.js';
import { memoryHookHost } from './session-task-hooks.js';

export type TelemetryIngestResult =
  | { status: 'stored' | 'duplicate' | 'conflict' }
  | { status: 'rejected'; code: TelemetryRejectCode }
  | { status: 'unavailable'; code: 'storage_unavailable' };

async function storeEvent(event: TelemetryEventV1, supplied?: DbPool): Promise<TelemetryIngestResult> {
  let owned: DbPool | undefined;
  try {
    if (supplied === undefined) {
      const url = process.env.AI_MEMORY_DATABASE_URL;
      if (url === undefined) return { status: 'unavailable', code: 'storage_unavailable' };
      owned = createPool({
        connectionString: assertLocalDatabaseUrl(url),
        max: 1,
        connectionTimeoutMillis: 500,
        statementTimeoutMs: 500,
        idleInTransactionTimeoutMs: 500,
      });
    }
    const target = supplied ?? owned;
    if (target === undefined) return { status: 'unavailable', code: 'storage_unavailable' };
    return { status: await insertWorkflowEvent(event, target) };
  } catch {
    return { status: 'unavailable', code: 'storage_unavailable' };
  } finally {
    if (owned !== undefined) await owned.end().catch(() => {});
  }
}

export async function ingestTelemetryEvent(
  input: unknown,
  options: { dbPool?: DbPool } = {},
): Promise<TelemetryIngestResult> {
  const parsed = parseTelemetryEvent(input);
  if (!parsed.ok) return { status: 'rejected', code: parsed.code };
  return storeEvent(parsed.event, options.dbPool);
}

async function readInput(limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += bytes.byteLength;
    if (size > limit) throw new Error('oversized');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function writeResult(result: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(result)}\n`, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function runTelemetryIngestCli(): Promise<void> {
  let result: TelemetryIngestResult;
  try {
    result = await ingestTelemetryEvent(await readInput(16 * 1024));
  } catch (error) {
    result = {
      status: 'rejected',
      code: error instanceof Error && error.message === 'oversized' ? 'oversized' : 'invalid_event',
    };
  }
  await writeResult(result);
}

/** Handler deadline bounds a concrete lifecycle wait, not verification runtime. */
export async function runTelemetryHookCli(): Promise<void> {
  let completion: Promise<void> | undefined;
  const finish = () => (completion ??= writeResult({ continue: true }));
  const deadline = setTimeout(() => {
    void finish().finally(() => process.exit(0));
  }, 3000);
  try {
    const payload = await readInput(64 * 1024);
    const host = memoryHookHost(process.env);
    if (host !== undefined) {
      const event = projectHostTelemetry(host, payload, randomUUID);
      if (event.ok) await storeEvent(event.event);
    }
  } catch {
    /* Advisory hook: fixed envelope only; never echo input/errors. */
  } finally {
    clearTimeout(deadline);
    await finish();
  }
}
