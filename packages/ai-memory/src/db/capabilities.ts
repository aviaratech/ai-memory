import { logAiMemoryWarn } from '../logger.js';
import { formatError } from './type-guards.js';

const EMBEDDING_COLUMN_NAME = 'embedding';
const TRIGRAM_EXTENSION_NAME = 'pg_trgm';
const VECTOR_EXTENSION_NAME = 'vector';

export interface DbCapabilities {
  hasEmbeddingColumn: boolean;
  hasTrigram: boolean;
  hasVector: boolean;
}

interface QueryClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const FALLBACK_CAPABILITIES: DbCapabilities = {
  hasEmbeddingColumn: false,
  hasTrigram: false,
  hasVector: false,
};

let cachedCapabilities: DbCapabilities = FALLBACK_CAPABILITIES;
let cachedProbePromise: Promise<DbCapabilities> | undefined;

export function getCapabilities(): DbCapabilities {
  return { ...cachedCapabilities };
}

export async function probeCapabilities(client: QueryClient): Promise<DbCapabilities> {
  if (cachedProbePromise !== undefined) {
    return cachedProbePromise;
  }

  cachedProbePromise = probeCapabilitiesWithClient(client);
  cachedCapabilities = await cachedProbePromise;
  return cachedCapabilities;
}

/**
 * Reset cached capabilities for tests.
 * @internal
 */
export function resetCapabilitiesForTests() {
  cachedCapabilities = FALLBACK_CAPABILITIES;
  cachedProbePromise = undefined;
}

function isEmbeddingColumnPresent(row: Record<string, unknown> | undefined) {
  return row?.exists === true;
}

async function probeCapabilitiesWithClient(client: QueryClient): Promise<DbCapabilities> {
  try {
    const [embeddingColumnResult, extensionResult] = await Promise.all([
      client.query(
        `
          SELECT EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_name = 'ai_memory_entries'
              AND column_name = $1
              AND table_schema = ANY(current_schemas(false))
          )
        `,
        [EMBEDDING_COLUMN_NAME],
      ),
      client.query(
        `
          SELECT extname
          FROM pg_extension
          WHERE extname = ANY($1::text[])
        `,
        [[TRIGRAM_EXTENSION_NAME, VECTOR_EXTENSION_NAME]],
      ),
    ]);

    const hasEmbeddingColumn = isEmbeddingColumnPresent(embeddingColumnResult.rows[0]);
    const extensionNames = new Set(
      extensionResult.rows.map(readExtensionName).filter((value): value is string => value !== undefined),
    );

    return {
      hasEmbeddingColumn,
      hasTrigram: extensionNames.has(TRIGRAM_EXTENSION_NAME),
      hasVector: extensionNames.has(VECTOR_EXTENSION_NAME),
    };
  } catch (error) {
    logAiMemoryWarn('db.capabilities_probe_failed', {
      error: formatError(error),
      message: 'Falling back to conservative DB capabilities (all false).',
    });
    return FALLBACK_CAPABILITIES;
  }
}

function readExtensionName(row: Record<string, unknown>) {
  const extname = row.extname;
  return typeof extname === 'string' ? extname : undefined;
}
