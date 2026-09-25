const FAILURE_SIGNATURE_MAX_TEXT_LENGTH = 160;

/**
 * Builds a normalized failure signature for grouping and matching purposes.
 *
 * Replaces volatile tokens (UUIDs, hashes, timestamps, numbers) with placeholders
 * so semantically identical failures group together regardless of dynamic values.
 *
 * Format: `${stage}: ${normalizedFirstLineOfErrorMessage}`
 */
export function buildFailureSignature(stage: string, message: string): string {
  const normalizedStage = stage.trim().length === 0 ? '(unknown)' : stage.trim();
  const firstLine = message.split('\n')[0] ?? '';
  const normalizedMessage = firstLine
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/giu, '<uuid>')
    .replace(/\b[0-9a-f]{64}\b/giu, '<sha256>')
    .replace(/\b[0-9a-f]{32,}\b/giu, '<hex>')
    .replace(/\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?\b/giu, '<timestamp>')
    .replace(/\b\d+(?:\.\d+)?\b/gu, '<n>')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, FAILURE_SIGNATURE_MAX_TEXT_LENGTH);

  const safeMessage = normalizedMessage.length > 0 ? normalizedMessage : '(no error message)';
  return `${normalizedStage}: ${safeMessage}`;
}
