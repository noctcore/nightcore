/**
 * PR-diff size cap for the review prompts. The PR diff is FOREIGN, attacker-controllable
 * material and it is composed into a prompt on EVERY pass of a run — one per lens plus
 * the adversarial validator (~12× for a full run) — so an unbounded diff blows up both
 * the dollar cost and the model's context window. This module owns the single ceiling
 * every composition site truncates to, with a VISIBLE marker so nothing is silently
 * dropped (the model — and the logs — can see the material was cut).
 *
 * This is the ENGINE-side belt to the Rust core's suspenders: the core resolves + caps
 * the diff before it reaches the sidecar, but the cap is re-applied here so a large diff
 * can never reach the model regardless of how (or whether) an upstream capped it. The
 * untrusted-framing of the diff is a separate concern — see {@link import('../shared/untrusted.js').untrustedBlock}.
 */

/** Max bytes of PR diff embedded in any single review prompt. The diff is sent ~12× per
 *  run (one lens pass each + the validator), so this bounds cost and context. Chosen as
 *  a generous-but-finite ceiling: real reviewable diffs sit well under it, pathological
 *  ones get truncated with the marker below. */
export const MAX_DIFF_BYTES = 96 * 1024;

/** The visible marker appended when a diff is truncated, so the model and the logs both
 *  know content was cut (never silently dropped). */
function truncationMarker(totalBytes: number): string {
  return `\n… [diff truncated at ${MAX_DIFF_BYTES / 1024} KB of ${Math.round(totalBytes / 1024)} KB]`;
}

/**
 * Truncate `diff` to {@link MAX_DIFF_BYTES}, appending a visible truncation marker when
 * it is cut so the content is never silently dropped. A diff at or under the ceiling is
 * returned UNCHANGED. Truncation is on a UTF-8 byte boundary (a split multi-byte char at
 * the very end decodes to the Unicode replacement char rather than corrupting output).
 */
export function capDiff(diff: string): string {
  const bytes = Buffer.byteLength(diff, 'utf8');
  if (bytes <= MAX_DIFF_BYTES) return diff;
  const kept = Buffer.from(diff, 'utf8')
    .subarray(0, MAX_DIFF_BYTES)
    .toString('utf8');
  return `${kept}${truncationMarker(bytes)}`;
}
