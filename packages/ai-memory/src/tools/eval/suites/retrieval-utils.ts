import { formatError, isRecord } from '@aviaratech/ai-memory/internal';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

export { formatError };

export interface RetrievalFixture {
  memories: Record<string, unknown>[];
  queries: RetrievalFixtureQuery[];
}

export type RetrievalFixtureProjectScope = 'other' | 'primary';

export interface RetrievalFixtureQuery {
  category?: string;
  expectedEvidenceRefs?: string[] | undefined;
  expectedSource?: string | undefined;
  expectedTopK: string[];
  k: number;
  query: string;
}

export function buildProjectScope(fixtureName: string, index: number): string {
  return `__experiment_harness_retrieval__:${fixtureName}:${String(index)}:${Date.now().toString()}`;
}

export function parseRetrievalFixture(rawFixture: string): RetrievalFixture {
  const parsed: unknown = JSON.parse(rawFixture);
  if (!isRecord(parsed)) {
    throw new Error('retrieval fixture must be a JSON object');
  }
  if (!Array.isArray(parsed.memories)) {
    throw new Error('retrieval fixture must include a "memories" array');
  }
  if (!Array.isArray(parsed.queries)) {
    throw new Error('retrieval fixture must include a "queries" array');
  }

  const memories = parsed.memories.map(parseFixtureMemory);
  const queries = parsed.queries.map(parseFixtureQuery);
  return { memories, queries };
}

export function readFixtureFiles(fixtureDirectory: string): string[] {
  if (!existsSync(fixtureDirectory)) {
    return [];
  }
  return readdirSync(fixtureDirectory)
    .filter(fileName => fileName.endsWith('.json'))
    .map(fileName => resolve(fixtureDirectory, fileName))
    .sort((left, right) => left.localeCompare(right));
}

export function resolveFixtureProjectScope(memory: Record<string, unknown>, projectScope: string): string {
  return memory.fixtureProjectScope === 'other' ? `${projectScope}:other` : projectScope;
}

export function toMemoryKeys(results: unknown): string[] {
  if (!Array.isArray(results)) {
    return [];
  }

  const memoryKeys: string[] = [];
  for (const result of results) {
    if (!isRecord(result)) {
      continue;
    }
    const memoryKey = result.memoryKey;
    if (typeof memoryKey === 'string' && memoryKey.trim().length > 0) {
      memoryKeys.push(memoryKey.trim());
    }
  }
  return memoryKeys;
}

function parseExpectedEvidenceRefs(value: unknown[]): string[] {
  if (!value.every(item => typeof item === 'string' && item.trim().length > 0)) {
    throw new Error('retrieval query expectedEvidenceRefs must be a non-empty string array when provided');
  }
  return value.map(item => (item as string).trim());
}

function parseFixtureMemory(memory: unknown): Record<string, unknown> {
  if (!isRecord(memory)) {
    throw new Error('retrieval memory fixture entries must be objects');
  }
  if (
    memory.fixtureProjectScope !== undefined &&
    memory.fixtureProjectScope !== 'primary' &&
    memory.fixtureProjectScope !== 'other'
  ) {
    throw new Error('retrieval memory fixture fixtureProjectScope must be "primary" or "other" when provided');
  }
  return memory;
}

function parseFixtureQuery(query: unknown): RetrievalFixtureQuery {
  if (!isRecord(query)) {
    throw new Error('retrieval query fixture entries must be objects');
  }
  if (typeof query.query !== 'string' || query.query.trim().length === 0) {
    throw new Error('retrieval query fixture entries must include a non-empty "query" string');
  }
  if (!Array.isArray(query.expectedTopK) || !query.expectedTopK.every(item => typeof item === 'string')) {
    throw new Error('retrieval query fixture entries must include string array "expectedTopK"');
  }
  if (typeof query.k !== 'number' || !Number.isInteger(query.k) || query.k < 1) {
    throw new Error('retrieval query fixture entries must include integer "k" >= 1');
  }

  return {
    ...(typeof query.category === 'string' && query.category.trim().length > 0
      ? { category: query.category.trim() }
      : {}),
    expectedTopK: query.expectedTopK,
    ...(Array.isArray(query.expectedEvidenceRefs)
      ? { expectedEvidenceRefs: parseExpectedEvidenceRefs(query.expectedEvidenceRefs) }
      : {}),
    ...(typeof query.expectedSource === 'string' && query.expectedSource.trim().length > 0
      ? { expectedSource: query.expectedSource.trim() }
      : {}),
    k: query.k,
    query: query.query.trim(),
  };
}
