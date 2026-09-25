import { validateContextPackV01, validateMemoryDeltaV01 } from './runtime.js';
import { isRecord } from './type-guards.js';

/**
 * Contract validation ownership:
 * - AJV validates persisted memory_delta/context_pack payloads against the
 *   canonical JSON Schemas.
 * - Zod (server.ts tool schemas) validates MCP input arguments before payload
 *   construction; it is intentionally not a second contract authority.
 */
const contextPackValidator = validateContextPackV01;
const memoryDeltaValidator = validateMemoryDeltaV01;

export function assertValidContextPack(contextPack: unknown) {
  if (contextPackValidator(contextPack)) {
    return;
  }

  throw new Error(`Invalid context_pack@0.1 payload: ${formatAjvErrors(contextPackValidator.errors)}`);
}

export function assertValidMemoryDelta(memoryDelta: unknown) {
  if (memoryDeltaValidator(memoryDelta)) {
    return;
  }

  throw new Error(`Invalid memory_delta@0.1 payload: ${formatAjvErrors(memoryDeltaValidator.errors)}`);
}

function formatAjvError(error: unknown) {
  if (!isRecord(error)) {
    return '/ is invalid';
  }

  const instancePath =
    typeof error.instancePath === 'string' && error.instancePath.length > 0 ? error.instancePath : '/';
  const message = typeof error.message === 'string' ? error.message : 'is invalid';
  return `${instancePath} ${message}`.trim();
}

function formatAjvErrors(errors: unknown) {
  if (!Array.isArray(errors) || errors.length === 0) {
    return 'unknown schema validation error';
  }

  return errors.map(error => formatAjvError(error)).join('; ');
}
