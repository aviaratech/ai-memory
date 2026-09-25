/**
 * Embedding provider — env-gated abstraction for vector embeddings.
 *
 * Supports OpenAI text-embedding-3-small via native fetch.
 * Returns null on any failure — never throws, never blocks memory writes.
 *
 * Environment variables:
 *   AI_MEMORY_EMBEDDING_PROVIDER: 'openai' | 'none' (default: 'none')
 *   AI_MEMORY_EMBEDDING_API_KEY:  required when provider != 'none'
 *   AI_MEMORY_EMBEDDING_MODEL:    default 'text-embedding-3-small'
 *   AI_MEMORY_EMBEDDING_TIMEOUT_MS: request timeout budget in ms (default: 5000)
 */

import { logAiMemoryDebug, logAiMemoryError, logAiMemoryInfo, logAiMemoryWarn } from '../logger.js';
import { formatTimeoutMessage, resolveTimeoutPolicy } from '../timeout-policy.js';
import { recordAiMemoryWarningDetail } from '../warning-channel.js';
import { SESSION_SUMMARY_CATEGORY } from './runtime.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface EmbeddingOptions {
  category?: null | string;
  operation?: string;
}

export interface EmbeddingProvider {
  readonly dimension: number;
  embed(text: string, operation?: string): Promise<null | number[]>;
  readonly model: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_DIMENSION = 1536;
const FORWARDED_ENV_SOURCE_PREFIX = 'AVIARA_PLUGIN_ENV_SOURCE_';

interface OpenAiEmbeddingResponse {
  data?: { embedding?: number[] }[];
}

interface OpenAiEmbedOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
}

type ProviderName = 'none' | 'openai';

async function openAiEmbed(
  text: string,
  options: OpenAiEmbedOptions & { operation: string },
): Promise<null | number[]> {
  const { apiKey, model, operation, timeoutMs } = options;
  let response: Response;
  try {
    response = await fetch(OPENAI_EMBEDDINGS_URL, {
      body: JSON.stringify({ input: text, model }),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (isAbortError(error)) {
      const phase = `embedding.${operation}`;
      const message = formatTimeoutMessage(phase, timeoutMs);
      logAiMemoryWarn('embedding.timeout', {
        message,
        model,
        operation,
        phase,
        timeout_ms: timeoutMs,
      });
      recordAiMemoryWarningDetail({
        code: 'embedding.timeout',
        message,
      });
      return null;
    }
    logAiMemoryError('embedding.fetch_failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  if (!response.ok) {
    logAiMemoryWarn('embedding.api_error', {
      model,
      status: response.status,
    });
    return null;
  }

  let body: OpenAiEmbeddingResponse;
  try {
    body = (await response.json()) as OpenAiEmbeddingResponse;
  } catch {
    logAiMemoryError('embedding.parse_failed', { model });
    return null;
  }

  const embedding = body.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length === 0) {
    logAiMemoryWarn('embedding.empty_response', { model });
    return null;
  }

  return embedding;
}

function readApiKey(): string | undefined {
  const raw = process.env.AI_MEMORY_EMBEDDING_API_KEY;
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readModel(): string {
  const raw = process.env.AI_MEMORY_EMBEDDING_MODEL;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw.trim();
  }
  return DEFAULT_MODEL;
}

function readProvider(): ProviderName {
  const raw = process.env.AI_MEMORY_EMBEDDING_PROVIDER?.trim().toLowerCase();
  if (raw === 'openai') {
    return 'openai';
  }
  return 'none';
}

// ---------------------------------------------------------------------------
// Resolved provider (lazy singleton)
// ---------------------------------------------------------------------------

let resolvedProvider: EmbeddingProvider | null | undefined;

/**
 * Compute an embedding vector for the given text.
 *
 * Returns null when:
 *  - Provider is not configured (AI_MEMORY_EMBEDDING_PROVIDER is 'none' or unset)
 *  - API key is missing
 *  - Network failure, invalid response, or rate limit
 *  - Category is 'session-summary' (cost control — low-signal, TTL'd)
 *  - Text is empty
 *
 * Never throws. Safe to call in the write path without try/catch.
 *
 * The second argument may be either a bare category string (legacy 2-arg
 * form) or an options object with `category` and/or `operation`. The
 * `operation` value is appended to the phase emitted on timeout
 * (`embedding.<operation> timed out after Nms`) so health-report phase
 * aggregation can attribute degradation to the calling tool.
 */
export function getEmbedding(
  text: string,
  categoryOrOptions?: EmbeddingOptions | null | string,
): Promise<null | number[]> {
  const { category, operation } = normalizeEmbeddingArgs(categoryOrOptions);

  if (typeof category === 'string' && category.toLowerCase() === SESSION_SUMMARY_CATEGORY) {
    logAiMemoryDebug('embedding.skipped_session_summary', {});
    return Promise.resolve(null);
  }

  if (text.trim().length === 0) {
    return Promise.resolve(null);
  }

  const provider = resolveProvider();
  if (provider === null) {
    return Promise.resolve(null);
  }

  return provider.embed(text, operation);
}

/**
 * Returns true when an embedding provider is configured and available.
 */
export function isEmbeddingAvailable(): boolean {
  return resolveProvider() !== null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reset the cached provider — only for testing.
 * @internal
 */
export function resetEmbeddingProvider(): void {
  resolvedProvider = undefined;
}

function isAbortError(error: unknown): boolean {
  // AbortSignal.timeout() aborts with a `TimeoutError` DOMException; manual
  // controller.abort() (or fetch propagating an AbortError) uses `AbortError`.
  // Both are timeout/abort signals from this code path's perspective.
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function normalizeEmbeddingArgs(input: EmbeddingOptions | null | string | undefined): {
  category: null | string | undefined;
  operation: string;
} {
  if (input === null || typeof input === 'string' || input === undefined) {
    return { category: input, operation: 'unspecified' };
  }
  return {
    category: input.category ?? undefined,
    operation: input.operation ?? 'unspecified',
  };
}

function resolveEmbeddingEnvSource(key: string): string {
  const forwardedSource = process.env[`${FORWARDED_ENV_SOURCE_PREFIX}${key}`]?.trim();
  if (forwardedSource === 'global_plugins_env' || forwardedSource === 'process_env' || forwardedSource === 'repo_env') {
    return forwardedSource;
  }

  return process.env[key] === undefined ? 'missing' : 'process_env';
}

function resolveProvider(): EmbeddingProvider | null {
  if (resolvedProvider !== undefined) {
    return resolvedProvider;
  }

  const providerName = readProvider();
  if (providerName === 'none') {
    logAiMemoryWarn('embedding.provider_unavailable', {
      message: 'Embedding provider is not configured; storing without embedding vector',
      reason: 'provider_not_configured',
      source_layer: resolveEmbeddingEnvSource('AI_MEMORY_EMBEDDING_PROVIDER'),
    });
    resolvedProvider = null;
    return null;
  }

  const apiKey = readApiKey();
  if (apiKey === undefined) {
    logAiMemoryWarn('embedding.missing_api_key', {
      message: 'AI_MEMORY_EMBEDDING_PROVIDER is set but AI_MEMORY_EMBEDDING_API_KEY is missing',
      provider: providerName,
      reason: 'missing_api_key',
      source_layer: resolveEmbeddingEnvSource('AI_MEMORY_EMBEDDING_API_KEY'),
    });
    resolvedProvider = null;
    return null;
  }

  const model = readModel();
  const timeoutMs = resolveTimeoutPolicy().embedding.timeoutMs;
  const embedOptions: OpenAiEmbedOptions = { apiKey, model, timeoutMs };

  const provider: EmbeddingProvider = {
    dimension: DEFAULT_DIMENSION,
    embed(text: string, operation = 'unspecified'): Promise<null | number[]> {
      return openAiEmbed(text, { ...embedOptions, operation });
    },
    model,
  };

  resolvedProvider = provider;
  logAiMemoryInfo('embedding.provider_resolved', {
    model,
    provider: providerName,
    source_layer: resolveEmbeddingEnvSource('AI_MEMORY_EMBEDDING_PROVIDER'),
    timeout_ms: timeoutMs,
  });
  return provider;
}
