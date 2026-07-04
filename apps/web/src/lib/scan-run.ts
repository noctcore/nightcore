/**
 * Shared scan run-lifecycle helpers, hoisted out of the four structurally-identical
 * scan siblings (Insight / Harness / Scorecard / PR-Review). `apps/web/src/lib/` is
 * the only place the `no-cross-feature-imports` lint permits cross-family sharing,
 * so the pieces that were cloned byte-for-byte across every `*-stream.ts` reducer
 * live here. Mirrors the backend's `scan_lifecycle_commands!` macro over generic
 * `ScanStore`/`ScanRun` (see `packages/engine/src/scans/shared/`).
 */

/** The token-usage accumulator every scan stream carries (input/output tokens). */
export interface ScanUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Accumulate a per-step usage delta into a running total. A missing delta
 * (`undefined`) leaves the total untouched. This was cloned verbatim in all four
 * `*-stream.ts` reducers — it is the token-accounting primitive the fold uses on
 * every `*-category-completed` / `*-dimension-completed` / `*-lens-completed` event.
 */
export function addUsage(a: ScanUsage, b: ScanUsage | undefined): ScanUsage {
  if (b === undefined) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}
