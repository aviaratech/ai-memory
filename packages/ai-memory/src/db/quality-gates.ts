import {
  MIN_DURABLE_CONTENT_CHARS,
  MIN_HIGH_CONFIDENCE_DURABLE,
  SESSION_SUMMARY_CATEGORY,
  SESSION_SUMMARY_MAX_CONFIDENCE,
} from './runtime.js';

const STRICT_METADATA_CATEGORIES = ['architecture', 'convention', 'methodology', 'preference', 'root-cause'] as const;

export interface PolicyResult {
  warnings: string[];
}

export function assertDurableMemoryInputPolicy(memory: {
  category: string;
  confidence: number;
  content: string;
  evidenceRefs?: (Record<string, unknown> | string)[] | undefined;
  expiresAt?: string | undefined;
  memoryKey?: string | undefined;
}): PolicyResult {
  assertMemoryContentQuality(memory.content, 'content');

  if (memory.category === SESSION_SUMMARY_CATEGORY) {
    if (memory.expiresAt === undefined) {
      throw new Error('session-summary durable memories must include expiresAt.');
    }
    if (memory.confidence > SESSION_SUMMARY_MAX_CONFIDENCE) {
      throw new Error(
        `session-summary durable memories must use confidence <= ${String(SESSION_SUMMARY_MAX_CONFIDENCE)}.`,
      );
    }
    return { warnings: [] };
  }

  if (memory.confidence < MIN_HIGH_CONFIDENCE_DURABLE) {
    throw new Error(
      `durable memories outside ${SESSION_SUMMARY_CATEGORY} must use confidence >= ${String(MIN_HIGH_CONFIDENCE_DURABLE)}. ` +
        `Guidance: raise confidence to at least ${String(MIN_HIGH_CONFIDENCE_DURABLE)} when evidence is strong, ` +
        `or use category '${SESSION_SUMMARY_CATEGORY}' with expiresAt for lower-confidence context.`,
    );
  }

  return checkStrictMetadataPolicy(memory);
}

export function assertDurableMemoryProposalPolicy(
  proposal: {
    category: string;
    confidence: number;
    content: string;
    ttlDays?: number | undefined;
  },
  index: number,
) {
  const prefix = `x_durable_memories[${String(index)}]`;
  assertMemoryContentQuality(proposal.content, `${prefix}.content`);

  if (proposal.category === SESSION_SUMMARY_CATEGORY) {
    if (proposal.ttlDays === undefined) {
      throw new Error(`${prefix}.ttl_days is required for session-summary durable proposals.`);
    }
    if (proposal.confidence > SESSION_SUMMARY_MAX_CONFIDENCE) {
      throw new Error(`${prefix}.confidence must be <= ${String(SESSION_SUMMARY_MAX_CONFIDENCE)} for session-summary.`);
    }
    return;
  }

  if (proposal.confidence < MIN_HIGH_CONFIDENCE_DURABLE) {
    throw new Error(
      `${prefix}.confidence must be >= ${String(MIN_HIGH_CONFIDENCE_DURABLE)} for non-session-summary durable proposals. ` +
        `Guidance: set ${prefix}.confidence to at least ${String(MIN_HIGH_CONFIDENCE_DURABLE)}, or switch category to ` +
        `'${SESSION_SUMMARY_CATEGORY}' and include ${prefix}.ttl_days for a low-confidence summary.`,
    );
  }
}

export function isStrictMetadataCategory(category: string): boolean {
  return (STRICT_METADATA_CATEGORIES as readonly string[]).includes(category.toLowerCase());
}

function assertMemoryContentQuality(content: string, fieldName: string) {
  if (content.trim().length < MIN_DURABLE_CONTENT_CHARS) {
    throw new Error(`${fieldName} must be at least ${String(MIN_DURABLE_CONTENT_CHARS)} characters.`);
  }
}

function checkStrictMetadataPolicy(memory: {
  category: string;
  evidenceRefs?: (Record<string, unknown> | string)[] | undefined;
  memoryKey?: string | undefined;
}): PolicyResult {
  if (!isStrictMetadataCategory(memory.category)) {
    return { warnings: [] };
  }

  const categoryLabel = memory.category;

  if (memory.memoryKey === undefined) {
    throw new Error(
      `memoryKey is required for '${categoryLabel}' memories. ` +
        'Provide a stable key like "<project>:<topic>" (e.g. "org/repo:zustand-store-naming"). ' +
        'Note: normalizeMemoryInput() auto-derives a key when omitted — if you see this error, ' +
        'you may be calling assertDurableMemoryInputPolicy() directly. ' +
        'See docs/process/ai-memory-agent-rules.md#memorykey-convention for examples.',
    );
  }

  const warnings: string[] = [];

  if (memory.evidenceRefs === undefined || memory.evidenceRefs.length === 0) {
    warnings.push(
      `evidenceRefs is recommended for '${categoryLabel}' memories. ` +
        'Include at least one reference (file path, PR URL, or issue link) for auditability.',
    );
    return { warnings };
  }

  for (const ref of memory.evidenceRefs) {
    if (!isAuditableEvidenceRef(ref)) {
      warnings.push(
        `evidenceRefs for '${categoryLabel}' memories should be auditable. ` +
          'Each ref should be a non-empty string (file path or URL) or an object with a non-empty path, url, issue, or pr field.',
      );
      break;
    }
  }

  return { warnings };
}

function isAuditableEvidenceRef(ref: Record<string, unknown> | string): boolean {
  if (typeof ref === 'string') {
    return ref.trim().length > 0;
  }
  const auditableKeys = ['path', 'url', 'issue', 'pr'] as const;
  return auditableKeys.some(key => {
    const value = ref[key];
    return typeof value === 'string' && value.trim().length > 0;
  });
}
