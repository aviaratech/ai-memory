/**
 * memory_delta@0.1 / context_pack@0.1 extension-field contract.
 *
 * Validation ownership:
 * - AJV JSON Schema is the canonical validator for persisted contract payloads.
 * - Zod validates MCP tool inputs before payload construction; it is not a
 *   replacement for persisted contract validation.
 *
 * Extension boundaries:
 * - `x_` fields are allowed on session snapshot values.
 * - `x_` fields are allowed on designated top-level memory_delta surfaces.
 * - Non-`x_` unknown keys on strict core objects remain rejected.
 *
 * Snapshot mode contract:
 * - `patch` values must satisfy SnapshotPatchV01 (requires `ops`).
 * - `replace` values must satisfy SessionSnapshotV01.
 */
export const MEMORY_DELTA_TOP_LEVEL_EXTENSION_SURFACES = [
  'root',
  'snapshot',
  'produced_by',
  'tenancy',
  'telemetry',
  'workflow',
  'append_events[*]',
  'artifacts[*]',
] as const;

export const SNAPSHOT_EXTENSION_SURFACES = ['replace:value', 'patch:value'] as const;
