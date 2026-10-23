/**
 * Write gate for durable memories.
 *
 * Durable memory holds reusable knowledge that more than one agent needs, so
 * every write must carry a stable caller-chosen key, at least one auditable
 * evidence reference and plain sentences, and must not contain secrets or
 * personal data. Session state belongs in memory_flush, not here.
 */
import {
  DERIVED_MEMORY_KEY_PREFIX,
  MIN_DURABLE_CONTENT_CHARS,
  MIN_HIGH_CONFIDENCE_DURABLE,
  SESSION_SUMMARY_CATEGORY,
} from './runtime.js';
import { isRecord } from './type-guards.js';

const MAX_WORD_LETTERS = 30;
const MIN_CONTENT_WORDS = 4;
const AUDITABLE_EVIDENCE_KEYS = ['path', 'url', 'issue', 'pr'] as const;
// Sources that mark memory_flush rows; the cleanup command removes rows carrying them.
const RESERVED_SOURCES = new Set(['manual-flush', 'memory-flush']);
// Numeric or vector fields never hold text worth scanning.
const UNSCANNED_FIELDS = new Set(['confidence', 'embedding', 'importance', 'supersedesId']);

interface SensitiveCheck {
  label: string;
  test: (value: string) => boolean;
}

// A key name followed by `:` or `=` and a value, e.g. `DB_PASSWORD=...` or `api_key: "..."`.
const SECRET_ASSIGNMENT =
  /(?:^|[^A-Za-z0-9])[A-Za-z0-9_]*?(?:password|passwd|secret|api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)\s*[:=]\s*['"]?([^\s'"]+)/giu;

// Checks name what was found without echoing it back to the caller.
const SENSITIVE_CHECKS: SensitiveCheck[] = [
  { label: 'a private key', test: value => /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(value) },
  { label: 'an AWS access key', test: value => /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u.test(value) },
  {
    label: 'a GitHub token',
    test: value => /\b(?:gh[oprsu]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})\b/u.test(value),
  },
  {
    label: 'an API key',
    test: value =>
      /\bsk-[A-Za-z0-9_-]{20,}|\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}|\bnpm_[A-Za-z0-9]{36}\b|\bAIza[0-9A-Za-z_-]{35}/u.test(
        value,
      ),
  },
  { label: 'a Slack token', test: value => /\bxox[abprs]-[A-Za-z0-9-]{10,}/u.test(value) },
  { label: 'a bearer token', test: value => /\bbearer\s+[A-Za-z0-9._~+/-]{20,}=*/iu.test(value) },
  {
    label: 'a JSON web token',
    test: value => /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u.test(value),
  },
  { label: 'a URL with a password', test: value => /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s/@]+@/iu.test(value) },
  { label: 'a password or secret value', test: hasSecretAssignment },
  // git@host:owner/repo remotes are not personal addresses.
  {
    label: 'an email address',
    test: value => /(?<![\w.+-])(?!git@)[\w.%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/iu.test(value),
  },
  {
    label: 'a home-folder path',
    test: value => /(?:^|[\s"'`(=:,[]|file:\/\/)(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^\s/\\]+/u.test(value),
  },
];

export interface DurableWriteGateInput extends Record<string, unknown> {
  category?: unknown;
  content?: unknown;
  evidenceRefs?: unknown;
  memoryKey?: unknown;
  source?: unknown;
}

export interface DurableWriteProblem {
  field: string;
  reason: string;
  fix: string;
}

export class DurableWriteGateError extends Error {
  constructor(readonly problems: DurableWriteProblem[]) {
    super(`memory_store rejected this durable memory: ${problems.map(problem => problem.reason).join(' ')}`);
    this.name = 'DurableWriteGateError';
  }
}

/** Collect every durable-write problem without echoing rejected sensitive values. */
export function assertDurableWriteGate(input: DurableWriteGateInput): void {
  const problems: DurableWriteProblem[] = [];
  const add = (field: string, reason: string, fix: string) => {
    problems.push({ field, reason, fix });
  };
  const category = typeof input.category === 'string' ? input.category.trim().toLowerCase() : '';
  const memoryKey = typeof input.memoryKey === 'string' ? input.memoryKey.trim() : '';
  const source = typeof input.source === 'string' ? input.source.trim().toLowerCase() : '';

  if (category.length === 0)
    add('category', 'category is required.', 'Choose the knowledge category, for example convention or decision.');
  if (category === SESSION_SUMMARY_CATEGORY) {
    add(
      'category',
      'Session summaries are session state; save them with memory_flush instead of memory_store.',
      'Save this session state with memory_flush; use memory_store only for reusable knowledge.',
    );
  }
  if (RESERVED_SOURCES.has(source)) {
    add(
      'source',
      `source "${source}" is reserved for memory_flush records.`,
      'Omit source or use the actual writing tool, for example codex.',
    );
  }
  if (memoryKey.length === 0) {
    add(
      'memoryKey',
      'memoryKey is required. Use a stable key such as "owner/repo:topic" so later writes update it.',
      'Set memoryKey to a stable caller-chosen key such as "owner/repo:topic".',
    );
  } else if (memoryKey.startsWith(`${DERIVED_MEMORY_KEY_PREFIX}:`)) {
    add(
      'memoryKey',
      `memoryKey must not use the reserved "${DERIVED_MEMORY_KEY_PREFIX}:" prefix.`,
      'Replace memoryKey with a stable caller-chosen key such as "owner/repo:topic".',
    );
  }
  if (!hasAuditableEvidence(input.evidenceRefs)) {
    add(
      'evidenceRefs',
      'evidenceRefs needs at least one auditable reference: a repository path, a URL, or an object with path, url, issue or pr.',
      'Add a real supporting repository path, issue or PR URL to evidenceRefs.',
    );
  }
  const content = typeof input.content === 'string' ? input.content : '';
  const contentProblems = findPlainLanguageProblems(content);
  if (content.trim().length < MIN_DURABLE_CONTENT_CHARS)
    contentProblems.push(`content must be at least ${String(MIN_DURABLE_CONTENT_CHARS)} characters.`);
  for (const reason of contentProblems)
    add(
      'content',
      reason,
      `Write plain sentences with spaces, at least ${String(MIN_CONTENT_WORDS)} words and ${String(MIN_DURABLE_CONTENT_CHARS)} characters.`,
    );
  if (
    input.confidence !== undefined &&
    (!Number.isFinite(Number(input.confidence)) ||
      Number(input.confidence) < MIN_HIGH_CONFIDENCE_DURABLE ||
      Number(input.confidence) > 1)
  ) {
    add(
      'confidence',
      `durable memories must use confidence >= ${String(MIN_HIGH_CONFIDENCE_DURABLE)} and <= 1.`,
      'Verify the supporting evidence, then set confidence between 0.5 and 1.',
    );
  }

  for (const [field, value] of Object.entries(input)) {
    if (UNSCANNED_FIELDS.has(field)) continue;
    const found = findSensitiveContent(readStrings(value));
    if (found !== undefined) {
      add(
        field,
        `${field} appears to contain ${found}. Remove secrets and personal data before storing.`,
        `Remove secrets and personal data from ${field}; replace private paths with repository-relative paths.`,
      );
    }
  }
  if (problems.length > 0) throw new DurableWriteGateError(problems);
}

/** The content checks alone, for text that becomes a memory by another path (a contested merge). */
export function assertDurableContent(content: string, field = 'content'): void {
  const problems = findPlainLanguageProblems(content);
  const found = findSensitiveContent([content]);
  if (found !== undefined) {
    problems.push(`${field} appears to contain ${found}. Remove secrets and personal data before storing.`);
  }
  if (problems.length > 0) {
    throw new Error(`${field} was rejected: ${problems.join(' ')}`);
  }
}

/**
 * Returns the first word longer than MAX_WORD_LETTERS letters that looks like
 * words run together. Paths, identifiers, camelCase and hex digests are allowed.
 */
export function findCompressedWord(text: string): string | undefined {
  for (const token of text.split(/\s+/u)) {
    if (token.includes('/') || token.includes('\\') || token.includes('@') || token.includes('`')) continue;
    for (const part of token.split(/[^\p{L}\p{N}_.+$=-]+/u)) {
      const word = part.replace(/^\p{P}+|\p{P}+$/gu, '');
      if (
        new RegExp(`^\\p{L}{${String(MAX_WORD_LETTERS + 1)},}$`, 'u').test(word) &&
        !/\p{Ll}\p{Lu}/u.test(word) &&
        !/^[a-fA-F]{32,}$/u.test(word)
      ) {
        return word;
      }
    }
  }
  return undefined;
}

export function isAuditableEvidenceRef(ref: unknown): boolean {
  if (typeof ref === 'string') {
    return ref.trim().length > 0;
  }
  if (!isRecord(ref)) {
    return false;
  }
  return AUDITABLE_EVIDENCE_KEYS.some(key => {
    const value = ref[key];
    return (typeof value === 'string' && value.trim().length > 0) || typeof value === 'number';
  });
}

function countWords(text: string): number {
  return text.split(/\s+/u).filter(word => /\p{L}/u.test(word)).length;
}

function findPlainLanguageProblems(content: string): string[] {
  const problems: string[] = [];
  if (countWords(content.trim()) < MIN_CONTENT_WORDS) {
    problems.push(`content must be plain sentences of at least ${String(MIN_CONTENT_WORDS)} words.`);
  }
  if (findCompressedWord(content) !== undefined) {
    problems.push(
      `content contains a run of more than ${String(MAX_WORD_LETTERS)} letters without spaces. Write plain sentences with spaces between words.`,
    );
  }
  return problems;
}

function findSensitiveContent(values: string[]): string | undefined {
  for (const value of values) {
    for (const { label, test } of SENSITIVE_CHECKS) {
      if (test(value)) return label;
    }
  }
  return undefined;
}

// Treat an assigned value as a secret unless it names another variable
// (`$TOKEN`, `${TOKEN}`, `NPM_TOKEN`) or is a short plain word such as "required".
// Letter-only values count when they are long or mix cases inside a word.
function hasSecretAssignment(value: string): boolean {
  for (const match of value.matchAll(SECRET_ASSIGNMENT)) {
    const assigned = match[1] ?? '';
    if (assigned.length < 8 || /^[$%{<]/u.test(assigned) || /^[A-Z][A-Z0-9_]*$/u.test(assigned)) continue;
    if (/[0-9]|[^A-Za-z]/u.test(assigned) || assigned.length >= 16 || /[a-z][A-Z]/u.test(assigned)) return true;
  }
  return false;
}

function hasAuditableEvidence(value: unknown): boolean {
  return Array.isArray(value) && value.some(ref => isAuditableEvidenceRef(ref));
}

function readStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(item => readStrings(item));
  if (isRecord(value)) return Object.values(value).flatMap(item => readStrings(item));
  return [];
}
