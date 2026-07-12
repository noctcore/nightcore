/**
 * Shared scan run-lifecycle helpers, hoisted out of the structurally-identical
 * scan siblings (Insight / Harness / Scorecard / Issue Triage / PR-Review).
 * `apps/web/src/lib/` is the only place the `no-cross-feature-imports` lint permits
 * cross-family sharing, so the pieces that were cloned byte-for-byte across every
 * `*-stream.ts` reducer and `*View.hooks.ts` live here. Mirrors the backend's
 * `scan_lifecycle_commands!` macro over generic `ScanStore`/`ScanRun` (see
 * `packages/engine/src/scans/shared/`).
 *
 * This barrel preserves the flat `@/lib/scan-run` public surface after the module
 * was split into cohesive submodules (issue #50 web-file-size ratchet):
 *   - `./scan-run/lifecycle` — run phase, token usage, per-step progress
 *   - `./scan-run/results`   — location normalize, lens tabs/counts, item patch
 *   - `./scan-run/fold`      — the generic `makeScanFold` reducer factory
 *   - `./scan-run/narrow`    — safeParse-backed enum guards for persisted reads
 *   - `./scan-run/copy`      — run-history menu, config summary, empty-state copy
 * Call sites import from `@/lib/scan-run` unchanged; the `*-stream.ts` folds and
 * the `*View.hooks.ts` view models both resolve here.
 */
export * from './scan-run/copy';
export * from './scan-run/fold';
export * from './scan-run/lifecycle';
export * from './scan-run/narrow';
export * from './scan-run/results';
