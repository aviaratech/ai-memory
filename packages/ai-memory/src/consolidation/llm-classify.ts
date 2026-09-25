/**
 * LLM classification for memory consolidation (AI Memory v2 Phase F — Stage 2).
 *
 * Classifies a candidate pair as reinforce / contradict / refine / unrelated
 * using the OpenAI chat completions API.
 *
 * Environment variables:
 *   AI_MEMORY_CLASSIFY_API_KEY  — API key (falls back to AI_MEMORY_EMBEDDING_API_KEY)
 *   AI_MEMORY_CLASSIFY_MODEL    — Model to use (default: 'gpt-4o-mini')
 */

import { isRecord } from '../db/type-guards.js';
import { logAiMemoryError, logAiMemoryWarn } from '../logger.js';

const CONFIDENCE_DELTA_MAX = 0.1;
const CONFIDENCE_DELTA_MIN = -0.1;
const DEFAULT_CLASSIFY_MODEL = 'gpt-4o-mini';
const MAX_REASONING_CHARS = 200;
const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const CLASSIFY_SYSTEM_PROMPT =
  "You are classifying the relationship between two memories in a coding agent's knowledge base. Output only valid JSON.";

export interface ConsolidationClassification {
  confidenceDelta: number;
  reasoning: string;
  relationship: 'contradict' | 'refine' | 'reinforce' | 'unrelated';
}

interface ExistingMemoryContext {
  category: string;
  confidence: number;
  content: string;
  memoryType?: null | string;
}

interface NewMemoryContext {
  category: string;
  confidence?: number | undefined;
  content: string;
  memoryType?: null | string;
}

interface OpenAiChatResponse {
  choices?: { message?: { content?: string } }[];
}

/**
 * Classify the relationship between a new memory and an existing candidate.
 *
 * Returns null on any failure — never throws.
 * Exported for unit testability (mock fetch to exercise parsing logic).
 */
export async function classifyMemoryPair(
  newMemory: NewMemoryContext,
  existingMemory: ExistingMemoryContext,
): Promise<ConsolidationClassification | null> {
  const apiKey = readClassifyApiKey();
  if (apiKey === undefined) {
    logAiMemoryWarn('consolidation.no_classify_api_key', {
      message: 'Set AI_MEMORY_CLASSIFY_API_KEY or AI_MEMORY_EMBEDDING_API_KEY to enable LLM classification',
    });
    return null;
  }
  const model = readClassifyModel();
  const userPrompt = buildUserPrompt(newMemory, existingMemory);
  return await callAndParse({ apiKey, model, userPrompt });
}

function buildUserPrompt(newMemory: NewMemoryContext, existingMemory: ExistingMemoryContext): string {
  return [
    `EXISTING MEMORY:\n${existingMemory.content}`,
    `(confidence: ${String(existingMemory.confidence)}, category: ${existingMemory.category}, memory_type: ${existingMemory.memoryType ?? 'null'})`,
    ``,
    `NEW MEMORY:\n${newMemory.content}`,
    `(confidence: ${String(newMemory.confidence ?? 0.7)}, category: ${newMemory.category}, memory_type: ${newMemory.memoryType ?? 'null'})`,
    ``,
    `Classify the relationship. Output JSON only with fields: relationship, confidenceDelta, reasoning.`,
    `- "reinforce": new memory confirms/supports existing (bump confidence)`,
    `- "contradict": new memory conflicts with existing (flag for review)`,
    `- "refine": new memory updates/extends existing (supersede existing unless memory-type policy says otherwise)`,
    `- "unrelated": similar language but different topic (no action)`,
    `- reflective memories are meta-observations and should not be auto-superseded`,
    `- episodic + semantic pairs about the same topic are valid consolidation candidates`,
    ``,
    `confidenceDelta must be between -0.1 and +0.1. reasoning must be 200 chars max.`,
  ].join('\n');
}

async function callAndParse(options: {
  apiKey: string;
  model: string;
  userPrompt: string;
}): Promise<ConsolidationClassification | null> {
  const { apiKey, model, userPrompt } = options;
  let response: Response;
  try {
    response = await fetch(OPENAI_CHAT_URL, {
      body: JSON.stringify({
        messages: [
          { content: CLASSIFY_SYSTEM_PROMPT, role: 'system' },
          { content: userPrompt, role: 'user' },
        ],
        model,
        response_format: { type: 'json_object' },
        temperature: 0,
      }),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });
  } catch (error) {
    logAiMemoryError('consolidation.llm_fetch_failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  if (!response.ok) {
    logAiMemoryWarn('consolidation.llm_api_error', {
      model,
      status: response.status,
    });
    return null;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    logAiMemoryError('consolidation.llm_parse_failed', { model });
    return null;
  }
  return parseClassification(body, model);
}

function parseClassification(body: unknown, model: string): ConsolidationClassification | null {
  const chatResponse = body as OpenAiChatResponse;
  const contentText = chatResponse.choices?.[0]?.message?.content;
  if (typeof contentText !== 'string' || contentText.length === 0) {
    logAiMemoryWarn('consolidation.llm_empty_response', { model });
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentText);
  } catch {
    logAiMemoryError('consolidation.llm_json_parse_failed', {
      content: contentText.slice(0, 100),
    });
    return null;
  }
  if (!isRecord(parsed)) return null;
  const relationship = parsed.relationship;
  if (
    relationship !== 'reinforce' &&
    relationship !== 'contradict' &&
    relationship !== 'refine' &&
    relationship !== 'unrelated'
  ) {
    logAiMemoryWarn('consolidation.llm_invalid_relationship', {
      relationship: typeof relationship === 'string' ? relationship : '(non-string)',
    });
    return null;
  }
  const rawDelta = typeof parsed.confidenceDelta === 'number' ? parsed.confidenceDelta : 0;
  return {
    confidenceDelta: Math.min(CONFIDENCE_DELTA_MAX, Math.max(CONFIDENCE_DELTA_MIN, rawDelta)),
    reasoning: truncateReasoning(parsed.reasoning),
    relationship,
  };
}

function readClassifyApiKey(): string | undefined {
  const explicit = process.env.AI_MEMORY_CLASSIFY_API_KEY?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const fallback = process.env.AI_MEMORY_EMBEDDING_API_KEY?.trim();
  if (fallback !== undefined && fallback.length > 0) return fallback;
  return undefined;
}

function readClassifyModel(): string {
  const raw = process.env.AI_MEMORY_CLASSIFY_MODEL?.trim();
  return raw !== undefined && raw.length > 0 ? raw : DEFAULT_CLASSIFY_MODEL;
}

function truncateReasoning(text: unknown): string {
  const s = typeof text === 'string' ? text : '';
  return s.slice(0, MAX_REASONING_CHARS);
}
