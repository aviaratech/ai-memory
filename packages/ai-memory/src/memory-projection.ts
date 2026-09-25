import { readOptionalText, readStringArray } from './db/normalization.js';
import { buildSearchQueryTokens, normalizeSearchReferenceText } from './db/query-helpers.js';
import { isRecord } from './db/type-guards.js';

type MemoryDetail = 'compact' | 'full';

const DEFAULT_MEMORY_EXCERPT_CHARS = 240;
const MAX_COMPACT_EVIDENCE_REFS = 2;

export function formatMemoryPayload(input: {
  boundPreview?: boolean;
  fullContentTopN: number;
  memories: unknown[];
  memoryDetail: MemoryDetail;
  query?: string | undefined;
}) {
  if (input.memoryDetail === 'full') {
    return input.memories;
  }

  return input.memories.map((memory, index) =>
    toCompactMemory({
      boundPreview: input.boundPreview ?? false,
      includeFullContent: index < input.fullContentTopN,
      memory,
      query: input.query,
    }),
  );
}

function buildExcerpt(content: string | undefined, query: string | undefined): string | undefined {
  if (content === undefined) return undefined;
  if (content.length <= DEFAULT_MEMORY_EXCERPT_CHARS) return content;
  const tokens = supportingTokens(query);
  if (tokens.length > 0) {
    const sentences = content.split(/(?<=[.!?])\s+|\n\s*\n/u);
    let selected = 0;
    for (let index = 1; index < sentences.length; index++) {
      if (passageScore(sentences[index] ?? '', tokens) > passageScore(sentences[selected] ?? '', tokens))
        selected = index;
    }
    let passage = sentences[selected] ?? '';
    if (passageScore(passage, tokens) > 0) {
      const notice = '[partial context; verify conditions with memory_get] ';
      const passageLimit = DEFAULT_MEMORY_EXCERPT_CHARS - notice.length - 3;
      // Keep complete adjacent sentences when they fit, including qualifications
      // after a permission. An incomplete sentence must request detail explicitly.
      const next = sentences[selected + 1];
      if (next !== undefined && passage.length + next.length + 1 <= passageLimit) passage += ` ${next}`;
      const previous = sentences[selected - 1];
      if (previous !== undefined && previous.length + passage.length + 1 <= passageLimit)
        passage = `${previous} ${passage}`;
      if (passage.length > passageLimit) {
        const incomplete = '[incomplete passage; use memory_get] ';
        return `${incomplete}${passage.slice(0, DEFAULT_MEMORY_EXCERPT_CHARS - incomplete.length - 3).trimEnd()}...`;
      }
      return `${notice}${passage}...`;
    }
  }
  return `${content.slice(0, DEFAULT_MEMORY_EXCERPT_CHARS).trimEnd()}...`;
}

function passageScore(text: string, tokens: string[]): number {
  const normalized = text.toLowerCase();
  return tokens.reduce((score, token) => score + (normalized.includes(token) ? token.length : 0), 0);
}

function readMemoryId(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const normalized = Number(value.trim());
    return Number.isFinite(normalized) && Number.isInteger(normalized) ? normalized : undefined;
  }
  return undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function supportingTokens(query: string | undefined): string[] {
  return buildSearchQueryTokens(normalizeSearchReferenceText(query ?? ''))
    .filter(token => token.length >= 4 || /^\d+$/u.test(token))
    .map(token => token.slice(0, 6));
}

function toCompactEvidenceRefs(value: unknown, query: string | undefined): unknown[] {
  if (!Array.isArray(value)) return [];

  const compactRefs: unknown[] = [];
  for (const ref of value) {
    if (typeof ref === 'string') {
      const text = readOptionalText(ref);
      if (text !== undefined) compactRefs.push(text);
    } else if (isRecord(ref)) {
      const path = readOptionalText(ref.path);
      const type = readOptionalText(ref.type);
      const url = readOptionalText(ref.url);
      if (path !== undefined || url !== undefined) {
        compactRefs.push({
          ...(type !== undefined ? { type } : {}),
          ...(url !== undefined ? { url } : {}),
          ...(path !== undefined ? { path } : {}),
        });
      }
    }
  }
  const tokens = supportingTokens(query);
  if (tokens.length > 0) {
    compactRefs.sort(
      (left, right) => passageScore(JSON.stringify(right), tokens) - passageScore(JSON.stringify(left), tokens),
    );
  }
  return compactRefs.slice(0, MAX_COMPACT_EVIDENCE_REFS);
}

function toCompactMemory(input: {
  boundPreview: boolean;
  includeFullContent: boolean;
  memory: unknown;
  query?: string | undefined;
}) {
  if (!isRecord(input.memory)) return {};

  const memory = input.memory;
  let compactMemory: Record<string, unknown> = {};
  const id = readMemoryId(memory.id);
  const agent = readOptionalText(memory.agent);
  const category = readOptionalText(memory.category);
  const memoryType = readOptionalText(memory.memoryType ?? memory.memory_type);
  const status = readOptionalText(memory.status);
  const tags = readStringArray(memory.tags);
  const memoryKey = readOptionalText(memory.memoryKey ?? memory.memory_key);
  const sessionId = readOptionalText(memory.sessionId ?? memory.session_id);
  const source = readOptionalText(memory.source);
  const evidenceRefs = toCompactEvidenceRefs(memory.evidenceRefs ?? memory.evidence_refs, input.query);
  const createdAt = readOptionalText(memory.createdAt ?? memory.created_at);
  const updatedAt = readOptionalText(memory.updatedAt ?? memory.updated_at);
  const declaredConfidence = readOptionalNumber(memory.declaredConfidence ?? memory.declared_confidence);
  const calibratedConfidence = readOptionalNumber(memory.calibratedConfidence ?? memory.calibrated_confidence);
  const signals = isRecord(memory.signals) ? memory.signals : undefined;
  const content = readOptionalText(memory.content);
  const excerpt = buildExcerpt(content, input.query);
  const supersedesId = readMemoryId(memory.supersedesId ?? memory.supersedes_id);

  if (id !== undefined) compactMemory.id = id;
  if (agent !== undefined) compactMemory.agent = agent;
  if (category !== undefined) compactMemory.category = category;
  if (memoryType !== undefined) compactMemory.memoryType = memoryType;
  if (status !== undefined) compactMemory.status = status;
  if (supersedesId !== undefined) compactMemory.supersedesId = supersedesId;
  if (tags.length > 0) compactMemory.tags = tags;
  if (memoryKey !== undefined) compactMemory.memoryKey = memoryKey;
  if (sessionId !== undefined) compactMemory.sessionId = sessionId;
  if (source !== undefined) compactMemory.source = source;
  if (evidenceRefs.length > 0) compactMemory.evidenceRefs = evidenceRefs;
  if (createdAt !== undefined) compactMemory.createdAt = createdAt;
  if (updatedAt !== undefined) compactMemory.updatedAt = updatedAt;
  if (declaredConfidence !== undefined) compactMemory.declaredConfidence = declaredConfidence;
  if (calibratedConfidence !== undefined) compactMemory.calibratedConfidence = calibratedConfidence;
  if (signals !== undefined) compactMemory.signals = signals;
  if (excerpt !== undefined) compactMemory.excerpt = excerpt;
  // Search opts into bounded preview metadata; orient retains its distinct contract.
  // Omit oversized compound fields rather than fabricate source links or signals.
  if (input.boundPreview) {
    const entries = Object.entries(compactMemory);
    const boundedEntries = entries.filter(
      ([key, value]) => key === 'id' || key === 'excerpt' || Buffer.byteLength(JSON.stringify(value), 'utf8') <= 512,
    );
    compactMemory = Object.fromEntries(boundedEntries);
    if (boundedEntries.length < entries.length) compactMemory.previewTruncated = true;
  }
  if (input.includeFullContent && content !== undefined) compactMemory.content = content;

  return compactMemory;
}
