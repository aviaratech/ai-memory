/**
 * Deterministic regex-based error classifier for structured event capture.
 * Classification patterns are ordered — first match wins.
 * No LLM dependency; these are structural patterns in error messages.
 */
export function classifyError(errorMessage: string): string {
  if (/type\s*error|is not assignable/i.test(errorMessage)) return 'type_error';
  if (/eslint|lint/i.test(errorMessage)) return 'lint_failure';
  if (/test\s*(failed|failure)|expect.*received/i.test(errorMessage)) return 'test_failure';
  if (/build\s*(failed|error)|compilation/i.test(errorMessage)) return 'build_failure';
  if (/ENOENT|EACCES|EPERM/i.test(errorMessage)) return 'filesystem_error';
  return 'runtime_error';
}
