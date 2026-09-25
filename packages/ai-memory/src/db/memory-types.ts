export const MEMORY_TYPE_VALUES = ['episodic', 'semantic', 'procedural', 'reflective'] as const;

export type MemoryType = (typeof MEMORY_TYPE_VALUES)[number];
export const DEFAULT_MEMORY_TYPE: MemoryType = 'episodic';

type AutoAssignableMemoryType = Exclude<MemoryType, 'reflective'>;

const AUTO_MEMORY_TYPE_BY_CATEGORY: Readonly<Record<string, AutoAssignableMemoryType>> = {
  architecture: 'semantic',
  'audit-log': 'episodic',
  bugfix: 'episodic',
  checkpoint: 'episodic',
  convention: 'semantic',
  decision: 'semantic',
  'implementation-note': 'episodic',
  methodology: 'semantic',
  preference: 'procedural',
  'root-cause': 'episodic',
  'session-summary': 'episodic',
  workflow: 'procedural',
};

const MEMORY_TYPE_SET = new Set<string>(MEMORY_TYPE_VALUES);

export function inferMemoryTypeFromCategory(category: string): AutoAssignableMemoryType | undefined {
  return AUTO_MEMORY_TYPE_BY_CATEGORY[category.toLowerCase()];
}

export function normalizeMemoryType(value: unknown, fieldName: string): MemoryType | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be one of: ${MEMORY_TYPE_VALUES.join(', ')}`);
  }

  const normalized = value.trim().toLowerCase();
  if (!MEMORY_TYPE_SET.has(normalized)) {
    throw new Error(`${fieldName} must be one of: ${MEMORY_TYPE_VALUES.join(', ')}`);
  }

  return normalized as MemoryType;
}

export function parseOptionalMemoryType(value: unknown): MemoryType | undefined {
  try {
    return normalizeMemoryType(value, 'memoryType');
  } catch {
    return undefined;
  }
}

export function resolveMemoryTypeFromCategory(category: string): MemoryType {
  return inferMemoryTypeFromCategory(category) ?? DEFAULT_MEMORY_TYPE;
}
