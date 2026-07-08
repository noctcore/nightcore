# Audit Findings — web-harness-insight

**Date:** 2026-07-08
**Agent:** kirei-refactor (parallel slice)
**Scope:** apps/web/src/components/harness + insight + scorecard (~156 source files)
**Category:** audit

---

## Summary

Three "run/scan/analysis" view features (Harness, Insight, Scorecard) that share a common lifecycle pattern (CONFIGURE → RUNNING → RESULTS) and stream-folding infrastructure. They correctly share via `lib/` (scan-run, useScanRun, useScanResultsView, useRunConfig, etc.) rather than cross-importing.

**Overall assessment:** The slice is structurally healthy. The shared abstractions in `lib/` are the right pattern. Most apparent duplication is thin adapter wrappers over shared UI primitives (ScanConfigForm, CategoryTabsShell, GroundedFindingBody, DetailCardGrid).

**Grandfathered file-size violations (per web-file-size-ratchet baseline):**
- `HarnessView.tsx`: 425 lines (cap 400)
- `InsightView.hooks.ts`: 430 lines (cap 400)

**Dead code found:**
- `runStatusOf()` exported from all three `*.constants.ts` files — never imported (prreview has its own copy)
- `CategoryProgress` re-export from `harness-stream.ts` — unused (defined in harness.types.ts, imported there directly)

**Best-practice gaps:**
- 2 `console.error` calls in error paths in `harness-data.hooks.ts` (listHarnessRuns failures)

**No issues found in:**
- Cross-feature imports (none within slice)
- `any` types
- TODO/FIXME/HACK comments
- Dead branches (`if (false)`, etc.)
- Commented-out code blocks

---

## Dead Code to Remove

| File | What | Risk |
|------|------|------|
| `apps/web/src/components/harness/harness.constants.ts:141` | `export function runStatusOf(...)` — unused export | Low |
| `apps/web/src/components/insight/insight.constants.ts:76` | `export function runStatusOf(...)` — unused export | Low |
| `apps/web/src/components/scorecard/scorecard.constants.ts:95` | `export function runStatusOf(...)` — unused export | Low |
| `apps/web/src/components/harness/harness-stream.ts:45` | `export type { CategoryProgress }` re-export — unused (import from harness.types.ts instead) | Low |

**Notes:**
- `runStatusOf` is defined in prreview.constants.ts and used there (different slice). Within this slice, `runStatusFromPersisted` from `@/lib/scan-run` is used instead.
- The constants files legitimately export `ALL_CATEGORIES`/`ALL_DIMENSIONS`, `*_META`, `runStatusOf`, etc. Only `runStatusOf` is dead within this slice.

---

## Duplication to Consolidate

**None requiring consolidation within slice scope.**

### Patterns observed (intentionally similar, correctly factored)

| Pattern | Files | Status | Notes |
|---------|-------|--------|-------|
| `*-stream.ts` folders | harness/insight/scorecard | ✅ Shared via lib | All use `makeScanFold` from `@/lib/scan-run/fold` |
| `RunControls` | all three | ✅ Thin adapters | Compose `ScanConfigForm`; differ only in CTA label, icon, scope picker (Insight only) |
| `CategoryTabs` | harness, insight | ✅ Thin adapters | Compose `CategoryTabsShell`; differ in type param + listLabel/errorLabel |
| `DetailPanel` | all three | ✅ Thin adapters | Compose `GroundedFindingBody`; differ in badge layout and section mapping |
| `Grid` | all three | ✅ Thin adapters | Compose `DetailCard`/`DetailCardGrid`/`Card`; differ in data shape (evidence vs location vs findings) |
| `View` + `View.hooks` lifecycle | all three | ✅ Shared via lib | Use `useScanRun`, `useScanResultsView`, `useRunConfig`, `deriveRunPhase` etc. |

**Cross-slice note (for orchestrator):** The same `RunControls`/`CategoryTabs`/`Grid`/`DetailPanel` patterns appear in `prreview/`, `issues/`. If consolidating, the shared abstraction belongs in `lib/` or a new `components/scan/` (not direct cross-feature). Do not consolidate by having harness import from insight.

---

## Abstractions to Add

**None required within slice.** The shared infrastructure already lives in the right place (`lib/scan-run/`, `lib/useScanRun.ts`, `lib/useScanResultsView.ts`, `lib/useRunConfig.ts`).

---

## Abstractions to Remove

**None.** No over-abstraction detected. The thin adapters are the correct minimal surface.

---

## Files to Split

| File | Lines | Problem | Split into |
|------|-------|---------|------------|
| `HarnessView.tsx` | ~425 | Grandfathered over ratchet (400) | Not actionable — grandfathered in baseline; shrinking would require deleting baseline entry |
| `InsightView.hooks.ts` | ~430 | Grandfathered over ratchet (400) | Not actionable — grandfathered in baseline |

**Note:** Per AGENTS.md, new files never join the baseline. These two are frozen. A refactor that shrinks them under 400 must also delete their baseline entries via `bun run lint:meta -- --update-baseline`.

---

## Implementation Order

N/A — this is an audit report, not an execution plan. If an agent later executes fixes:

1. Remove dead `runStatusOf` exports (safe, no callers)
2. Remove dead `CategoryProgress` re-export from harness-stream.ts (safe)
3. (Optional) Replace `console.error` with structured logging or remove (low value)

---

## Effort Estimates

| Change | Effort | Risk | Value |
|--------|--------|------|-------|
| Remove 3 dead `runStatusOf` exports | XS | Low | Low |
| Remove dead `CategoryProgress` re-export | XS | Low | Low |
| Replace 2 console.error with no-op or toast | XS | Low | Low |
| Split grandfathered god files | M | Medium | Low (already grandfathered) |

---

## What NOT to Refactor

| Item | Reason |
|------|--------|
| Similar `RunControls`/`CategoryTabs`/`Grid` shapes across harness/insight/scorecard | They are intentionally thin adapters over shared UI primitives; the differences (CTA labels, icons, scope picker, data shapes) are feature semantics, not copy-paste debt |
| `*-stream.ts` structural similarity | Correctly use the shared `makeScanFold` from `lib/scan-run`; this is the intended pattern |
| `HarnessView.hooks.ts` (~290 LOC) | Complex but correctly composed of focused hooks (`useHarness`, `useHarnessProposals`, `useHarnessApply`, `useScanResultsView`); not a god hook |
| Test patterns in `*-stream.test.tsx` | They test the same shared fold abstraction with different event vocabularies; similarity is expected |
| `console.error` in error paths (2 sites) | These are legitimate "best-effort reconcile failed" cases; not debug noise. Could be upgraded but not urgent |
| Grandfathered file sizes | Per AGENTS.md ratchet rules — they are recorded and only shrink one-way |

---

## Best-Practice Gaps

| File:Line | Gap | Severity | Fix |
|-----------|-----|----------|-----|
| `harness-data.hooks.ts:277,309` | `console.error('listHarnessRuns failed', err)` in catch blocks | Low | Consider using the injected toast channel or a silent no-op; these are best-effort reconciles after authoritative state has already updated |
| (none) | `any` / untyped | — | None found |
| (none) | Swallowed errors | — | All async paths use `runAction` wrapper which toasts on error |
| (none) | Sync-in-async | — | None observed |
| (none) | Magic numbers/strings in UI logic | — | All literals are in `*_META` tables or shared primitives |

---

## Consistency / Conventions

| Aspect | Status | Notes |
|--------|--------|-------|
| Folder-per-component | ✅ | All components have the full sibling set |
| Sidecar naming | ✅ | `harness-*.ts`, `insight-*.ts`, `scorecard-*.ts` at feature root; `*.hooks.ts`, `*.types.ts`, `*.constants.ts` colocated |
| Barrel discipline | ✅ | Feature `index.ts` exports only the View (and its Props type); no re-export of entire surface |
| State in body | ✅ | None — state lives in `.hooks.ts` files |
| Hook budget | ✅ | `useHarnessView`/`useInsightView`/`useScorecardView` compose focused hooks; no single hook returns >20 members |
| Props budget | ✅ | `ViewProps` interfaces are small (5 members) |
| Import ordering | (not checked) | Would be caught by `bun run lint` |
| No cross-feature imports | ✅ | Verified — no `@/components/harness` etc. imports from insight/scorecard and vice versa |

---

## File Size Audit (vs 400-line ratchet)

| File | Lines | Baseline? | Action |
|------|-------|-----------|--------|
| `HarnessView/HarnessView.tsx` | ~425 | Yes (425) | Grandfathered; do not touch unless shrinking below 400 + deleting baseline entry |
| `InsightView/InsightView.hooks.ts` | ~430 | Yes (430) | Grandfathered; do not touch unless shrinking below 400 + deleting baseline entry |
| `HarnessView/HarnessView.hooks.ts` | ~290 | No | Within limits |
| `harness-stream.ts` | ~310 | No | Within limits |
| `insight-stream.ts` | ~200 | No | Within limits |
| `scorecard-stream.ts` | ~205 | No | Within limits |
| All other component files | < 200 | — | Within limits |

---

## Stream Test Pattern Consistency

All three `*-stream.test.tsx` files follow the same structure:

```ts
import { wireX, storedToX, streamFromRun, foldX, EMPTY_X_STREAM } from './X-stream';

describe('foldX', () => {
  it('X-started resets...', () => { ... });
  it('X-step-started marks...', () => { ... });
  it('X-step-completed stores...', () => { ... });
  // ...
});
```

This is appropriate — they're testing the same generic fold with different vocabularies. No duplication debt.

---

## Cross-Slice Notes (for orchestrator)

1. `runStatusOf` also exists in `prreview.constants.ts` — if removing, consider whether prreview needs the same cleanup (different slice).
2. The `RunControls`/`CategoryTabs`/`Grid`/`DetailPanel` patterns in `issues/`, `prreview/` follow the same thin-adapter shape — any consolidation would be a cross-slice refactor, not within this slice.
3. `lib/scan-run/` and `lib/use*` hooks are the correct sharing point; do not propose moving shared logic into one feature.

---

*End of audit findings.*
