/**
 * Typed registry of known ingestion failure signatures and their resolution metadata.
 *
 * Gate: resolver applies only when `created_at < fixDate` AND the normalized failure
 * signature matches. Post-fix regressions (created_at >= fixDate) remain actionable.
 *
 * Signature format: `${stage}: ${normalizedFirstLineOfErrorMessage}`
 * Normalization replaces UUIDs, SHA256 hashes, hex strings, timestamps, and numbers
 * with placeholders — matching the same normalization used in health-report signatures.
 *
 * To add an entry after a fix lands:
 *   1. Run `npm run health -w @aviaratech/ai-memory-tools` to see the current top failure signatures.
 *   2. Copy the signature string exactly.
 *   3. Set fixDate to the ISO date when the fix was merged/deployed.
 *   4. Set resolvedBy to a release or change reference.
 *   5. Run `npm run failures:resolve-known -w @aviaratech/ai-memory-tools -- --dry-run` to verify match counts.
 *   6. Commit this file and the PR together.
 */

export interface KnownFailureSignature {
  /** ISO date string. Failures with created_at < fixDate are candidates for resolution. */
  readonly fixDate: string;
  /** Reference to the fix (e.g., 'release:0.2.0', 'commit:abc123'). */
  readonly resolvedBy: string;
  /** Human-readable description of what the fix addressed. */
  readonly resolvedReason: string;
  /**
   * Normalized failure signature in the format `${stage}: ${normalizedMessage}`.
   * Must match exactly what buildFailureSignature() produces for the target failures.
   */
  readonly signature: string;
}

/**
 * Product-local failure signatures resolved by code fixes.
 * A new installation has no historical resolutions to apply.
 */
export const KNOWN_FAILURE_SIGNATURES: readonly KnownFailureSignature[] = [];
