import { createHash } from 'node:crypto';

import { DERIVED_MEMORY_KEY_PREFIX, MEMORY_IDENTITY_HASH_VERSION } from './runtime.js';

const SIMILARITY_CATEGORIES = new Set(['architecture', 'bugfix', 'convention', 'decision', 'preference', 'root-cause']);
const DEFAULT_SIMILARITY_THRESHOLD = 0.6;

export { DEFAULT_SIMILARITY_THRESHOLD, SIMILARITY_CATEGORIES };

export function computeTextSimilarity(textA: string, textB: string): number {
  if (textA.length === 0 && textB.length === 0) {
    return 1;
  }

  if (textA.length === 0 || textB.length === 0) {
    return 0;
  }

  const tokensA = tokenize(textA);
  const tokensB = tokenize(textB);

  if (tokensA.length === 0 || tokensB.length === 0) {
    return 0;
  }

  const jaccardScore = jaccardSimilarity(new Set(tokensA), new Set(tokensB));
  const bigramScore = bigramSimilarity(tokensA, tokensB);

  return 0.6 * jaccardScore + 0.4 * bigramScore;
}

export function createDurableMemoryKey(input: {
  category: string;
  content: string;
  orgId?: string | undefined;
  project?: string | undefined;
  repoId?: string | undefined;
  repoSlug?: string | undefined;
  sensitivity?: string | undefined;
  tags?: string[] | undefined;
}) {
  const identityHash = createMemoryIdentityHash({
    category: input.category,
    content: input.content,
    orgId: input.orgId,
    project: input.project,
    repoId: input.repoId,
    repoSlug: input.repoSlug,
    sensitivity: input.sensitivity,
    tags: input.tags,
  });

  return `${DERIVED_MEMORY_KEY_PREFIX}:${MEMORY_IDENTITY_HASH_VERSION}:${identityHash}`;
}

export function createMemoryDedupeHash(input: {
  category?: string | undefined;
  content?: string | undefined;
  orgId?: string | undefined;
  project?: string | undefined;
  repoId?: string | undefined;
  repoSlug?: string | undefined;
  sensitivity?: string | undefined;
  tags?: string[] | undefined;
}) {
  const identityHash = createMemoryIdentityHash(input);
  return `sha256:${identityHash}`;
}

export function normalizeFingerprintText(value?: string) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function stableJsonHash(value: unknown) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function bigramSimilarity(tokensA: string[], tokensB: string[]): number {
  const bigramsA = toBigrams(tokensA);
  const bigramsB = toBigrams(tokensB);

  if (bigramsA.size === 0 && bigramsB.size === 0) {
    return 1;
  }

  if (bigramsA.size === 0 || bigramsB.size === 0) {
    return 0;
  }

  let intersectionSize = 0;
  for (const bigram of bigramsA) {
    if (bigramsB.has(bigram)) {
      intersectionSize++;
    }
  }

  const unionSize = bigramsA.size + bigramsB.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

function createMemoryIdentityHash(input: {
  category?: string | undefined;
  content?: string | undefined;
  orgId?: string | undefined;
  project?: string | undefined;
  repoId?: string | undefined;
  repoSlug?: string | undefined;
  sensitivity?: string | undefined;
  tags?: string[] | undefined;
}) {
  const payload = {
    category: normalizeFingerprintText(input.category),
    content: normalizeFingerprintText(input.content),
    orgId: normalizeFingerprintText(input.orgId),
    project: normalizeFingerprintText(input.project),
    repoId: normalizeFingerprintText(input.repoId),
    repoSlug: normalizeFingerprintText(input.repoSlug),
    sensitivity: normalizeFingerprintText(input.sensitivity),
    tags: Array.isArray(input.tags)
      ? input.tags
          .map(tag => normalizeFingerprintText(tag))
          .filter(Boolean)
          .sort((left, right) => left.localeCompare(right))
      : [],
    version: MEMORY_IDENTITY_HASH_VERSION,
  };

  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
  let intersectionSize = 0;
  for (const item of setA) {
    if (setB.has(item)) {
      intersectionSize++;
    }
  }

  const unionSize = setA.size + setB.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  const sortedKeys = Object.keys(value).sort((left, right) => left.localeCompare(right));
  const entries = sortedKeys.map(
    key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
  );
  return `{${entries.join(',')}}`;
}

function toBigrams(tokens: string[]): Set<string> {
  const bigrams = new Set<string>();
  for (let index = 0; index < tokens.length - 1; index++) {
    const current = tokens[index];
    const next = tokens[index + 1];
    if (current !== undefined && next !== undefined) {
      bigrams.add(`${current} ${next}`);
    }
  }
  return bigrams;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(token => token.length > 1);
}
