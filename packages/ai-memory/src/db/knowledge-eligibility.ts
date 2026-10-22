const SESSION_CATEGORIES = ['session-summary', 'checkpoint'];
const FLUSH_SOURCES = ['manual-flush', 'memory-flush'];
const FLUSH_TAG = 'memory-flush';

// Keyed facts remain shared knowledge even when their provenance includes a flush.
// Unkeyed session records are retained for explicit session recovery.
export const KNOWLEDGE_MEMORY_SQL = `(
  memory_key IS NOT NULL OR (
    lower(btrim(coalesce(category, ''))) NOT IN (${SESSION_CATEGORIES.map(value => `'${value}'`).join(', ')})
    AND lower(btrim(coalesce(source, ''))) NOT IN (${FLUSH_SOURCES.map(value => `'${value}'`).join(', ')})
    AND NOT (coalesce(tags, '{}'::text[]) @> ARRAY['${FLUSH_TAG}']::text[])
  )
)`;

export function isKnowledgeMemory(input: Record<string, unknown>): boolean {
  if ((input.memoryKey ?? input.memory_key) !== undefined && (input.memoryKey ?? input.memory_key) !== null)
    return true;
  const category = typeof input.category === 'string' ? input.category.trim().toLowerCase() : '';
  const source = typeof input.source === 'string' ? input.source.trim().toLowerCase() : '';
  return (
    !SESSION_CATEGORIES.includes(category) &&
    !FLUSH_SOURCES.includes(source) &&
    !(Array.isArray(input.tags) && input.tags.includes(FLUSH_TAG))
  );
}
