# Audit Findings — web-prreview

**Date:** 2026-07-08
**Agent:** kirei-refactor (parallel slice)
**Scope:** apps/web/src/components/prreview (all files + subdirs; ~90 source files)
**Category:** audit (per full taxonomy)

## Summary
The PR Review feature is well-structured with strong adherence to folder-per-component, sidecar naming (`.hooks.ts`, `.types.ts`, `prreview-*.ts` kebab roots), barrel discipline (top barrel exposes only `PrReviewView`), and feature isolation (only `@/lib/*`, `@/components/ui`, relative within, no cross-feature).

**Key issues (total ~22 findings):**
- Dead code: 3 unused exports (1 impactful, 2 internal).
- Duplication: 1 significant (parallel run/fix registries + guards; ~2x copy-paste of complex state machines).
- God/complexity: 4 (1 file >400-line ratchet; 1+ god hook return surfaces >20 members; 1 large hooks file).
- Abstraction: under-extraction for the duplicated registry concern.
- Consistency: 4–5 (direct generated import in tests x2; hook call in .tsx body; cross-component deep .hooks imports for types; leaky test import of const from sibling hooks).
- Best practice: 1 (repeated console.error in error paths).

No TODO/FIXME/HACK, no commented-out code, no `any`, no deep nesting (guard-clause style), no feature upward imports, no state in *.tsx bodies except the noted resize hook call.

Files respect sibling shape (all 6 required files per component folder). No `.parts.tsx` overflow yet.

## Counts by Category
| Category | # Findings | High | Med | Low |
|----------|------------|------|-----|-----|
| 1. Dead code | 3 | 0 | 0 | 3 |
| 2. Duplication/DRY | 2 | 0 | 1 | 1 |
| 3. God files & complexity | 4 | 1 | 2 | 1 |
| 4. Abstraction quality | 1 | 0 | 1 | 0 |
| 5. Consistency/conventions | 6 | 2 | 2 | 2 |
| 6. Best-practice gaps | 1 | 0 | 0 | 1 |
| **Total** | **17** | **3** | **6** | **8** |

(Counts are distinct actionable items; some files have multiple.)

## All Findings

### 1. Dead Code to Remove
| File | What | Risk | Effort | Severity | One-line fix |
|------|------|------|--------|----------|--------------|
| `apps/web/src/components/prreview/prreview.constants.ts:92` | `export function runStatusOf(...)` — defined, exported, **0 references** anywhere in slice (confirmed via grep). Its `PrReviewRun` import is only for this. | low | XS | low | Remove the function + clean `PrReviewRun` from the import (keep `ReviewLens` if still needed). |
| `apps/web/src/components/prreview/PrPicker/PrPicker.hooks.ts:15` | `export const DEFAULT_PR_SORT: PrSortOption = 'newest';` — only referenced inside this same `.hooks.ts`; never imported by `PrPicker.tsx`, tests, or elsewhere. | low | XS | low | Remove `export`; make internal `const`. |
| `apps/web/src/components/prreview/PrPicker/PrPicker.hooks.ts:39` | `export function parsePrNumber(raw: string): number \| null;` — only referenced inside same `.hooks.ts`; no external consumer. | low | XS | low | Remove `export`; make internal `function`. |

### 2. Duplication to Consolidate
| Pattern | Files | Extract to | What it does | Effort | Severity |
|---------|-------|------------|--------------|--------|----------|
| Run/fix registry + start guard + per-pr error + list/sub + upsert-with-tiebreak | `prreview-runs.hooks.ts` (~270l), `prreview-runs.ts`, `prreview-fixes.hooks.ts` (~270l) | `src/lib/use*Registry.ts` (or `lib/pr-review-registry.ts` + `lib/pr-fix-registry.ts` thin) or a generic `useLiveEntityMap` | Nearly identical: Map state, `useRef` for in-flight-per-pr guard + latest-ref, mount listPr + onEvent subscribe, upsert preferring newer `updatedAt` + status rank on tie, per-pr error map cleared on success, `startX` wrapper with same guard dance. Fixes add "dismissed" local set. | M | med |
| Per-PR keyed ephemeral UI state (survives switch without remount) | `PrWorkspace/PrWorkspace.hooks.ts:48` (`useDescriptionCollapse`), `useChangedFiles:89` | Small shared `usePerPrState<T>(key, initial)` or accept | Both key local collapse/loaded state by `prNumber` so switching PRs resets without effect deps dance. | S | low |

### 3. God Files & Complexity
| File | Lines | Problem | Split suggestion | Effort | Severity |
|------|-------|---------|------------------|--------|----------|
| `apps/web/src/components/prreview/prreview-lifecycle.ts` | ~471 | Exceeds web-file-size-ratchet 400-line cap; mixes many small pure helpers + 2 large derive fns (deriveReviewLifecycle, deriveReviewTimeline, reconcilePostedVerdict, compareRuns). | `prreview-lifecycle.ts` (core states) + `prreview-timeline.ts` (derive + types) or keep pure fns but trim file via more modules. | L | med |
| `apps/web/src/components/prreview/PrReviewView/PrReviewView.types.ts` (PrReviewViewModel) + `PrReviewView.hooks.ts` | model ~45 fields; hooks ~230l | Hook return surface far exceeds `max-hook-return-surface` (20); god-controller despite 5-way split. | Split returned model into focused sub-models or objects: list slice, workspace slice, post gates, fix gates, selection UI. Return fewer top-level keys or nest. | M | high |
| `apps/web/src/components/prreview/prreview-section.hooks.ts:318` | ~350l total, return ~32 members | Section hook return >20 members. | Group: e.g. `{ streams, ui, lifecycle: {lifecycle, reconciliation, stale, timeline, followup}, ... }` | S | med |
| `apps/web/src/components/prreview/prreview-gates.hooks.ts` | ~390l | Large file owning 4 state machines (post, address, push, fixAction) with refs + effects. | Already good split from view; if grows further, per-gate hooks (e.g. `usePostGate.ts`). | S | low |

No functions with 3+ levels of nesting found (early-return guards dominate). No component fn >50l imperative in .tsx (they delegate to hooks).

### 4. Abstractions to Add / Remove
**Under-abstraction (add):**
- Registry/guard/start discipline duplicated between review runs and fixes. The "live event fold + persisted reconcile + per-key in-flight guard + per-key error slot" is a reusable capability. Put in `lib/` so future `skills` or similar can reuse without copy-paste. (See dupe table.)
- (Minor) The two "keyed-by-pr UI affordance" hooks share a pattern that could be a 5-line util.

**Over-abstraction (none flagged):**
- Slice types in `ReviewSection.types.ts` are a good decomposition to avoid a single mega-props.
- No single-impl interfaces, no premature factories, no deep inheritance.

**Files over ~300 lines read and assessed:** lifecycle (god), gates.hooks, section.hooks, runs/fixes hooks, ReviewSection.tsx (~370), PrWorkspace.tsx (~290), PrReviewView.tsx (~320) — all doing focused work except the noted wide surfaces.

### 5. Consistency / Conventions Violations
| File:line | Issue | Rule reference | Fix |
|-----------|-------|----------------|-----|
| `PrReviewView/PrReviewView.test.tsx:22`, `PrReviewView.hooks.test.tsx:21` | `import type { PrReviewRun } from '@/lib/generated/PrReviewRun';` (direct generated) | AGENTS.md "Generated ... never imported from .../lib/generated/* directly"; contracts "through the bridge re-export" | Import from `@/lib/bridge` (the type is re-exported there). |
| `PrReviewView/PrReviewView.tsx:21,29` | `const panel = useResizablePanelWidth();` called in component body (adds hook call + layout state to .tsx) | `nightcore/no-state-in-component-body`, "thin shell", "per-file hook budget" + "lift extra state/effects into the colocated .hooks.ts" | Consume in `usePrReviewView` (or a `usePrReviewLayout`); thread `panel` (width, dragging, separatorProps) through the model. |
| `PrReviewView/PrReviewView.test.tsx:24` | `import { OWN_PR_TITLE } from '../ReviewSection/ReviewSection.hooks';` | Internal cross-component reach into sibling's private hooks; test-only but still | Move `OWN_PR_TITLE` / `FIX_RUNNING_TITLE` to `prreview.constants.ts` (or `prreview-gates.constants.ts`) and import from the shared module. |
| `PrWorkspace/PrWorkspace.types.ts:8`, `PrReviewView/PrReviewView.types.ts:11` | `import type { PrNumberStatusView } from '../PrStatusBlock/PrStatusBlock.hooks';` (and similar) | Cross-component import of implementation module for types (inconsistent with "barrel or types sibling") | Move `PrNumberStatusView` (and peer types) to `PrStatusBlock.types.ts`; export from `PrStatusBlock/index.ts`; import from barrel. |
| `ReviewSection/index.ts` | Exports many `*Slice` types that are assembly details used internally via barrel | Barrel discipline: "exports ONLY the symbols consumed from OUTSIDE the feature" | If slices are truly internal, consider `ReviewSection/types.ts` (non-barrel) or keep if `PrWorkspace` (sibling) is treated as "outside subdir". Low priority. |
| `prreview.constants.ts` (and parallel copies in other features) | `runStatusOf` dead + duplicated ad-hoc in harness/insight/scorecard | Feature isolation + shared via lib/ | N/A for this slice; removing dead here is still correct. |

Other conventions OK: folder structure, sidecar naming (dotted roles, kebab for domain modules), no prop-drilling (lint-enforced), no cross-feature imports, Vitest browser tests, no state in bodies (except noted), barrels narrow at feature root.

### 6. Best-Practice Gaps
| File(s) | Issue | Severity | Effort | Risk | Fix |
|---------|-------|----------|--------|------|-----|
| `prreview-*.ts:*.catch`, `PrReviewView/PrReviewView.hooks.ts:189`, `prreview-navigation.hooks.ts:188`, `prreview-selection.hooks.ts:169`, `prreview-section.ts:117`, `prreview-gates.hooks.ts:217+307`, `PrStatusBlock/PrStatusBlock.hooks.ts:90` (9 sites) | `console.error('...', err)` in catch paths. Always paired with `toast.error` or state, so user sees it; still direct console in feature code. | low | XS | low | Drop the console (toast+inline error already surface); or route through a shared `reportError` from lib if one is added. Not debug logs. |

No other gaps: no magic numbers (resize consts + comments), no untyped, no sync-in-async fire-and-forget without void, no swallowed errors (rejections surface via gates/errors), input from bridge is trusted per architecture, no feature flags.

## Implementation Order (if acting on findings)
Refactors have dependencies:
1. Remove dead exports (XS, safe, no callers, enables import cleanup) — `prreview.constants.ts`, `PrPicker/PrPicker.hooks.ts`.
2. Fix direct generated imports in tests (XS, mechanical, high value for contract compliance).
3. Fix hook-in-body for resize (S, touches model surface + layout).
4. Consolidate registry dupe (M–L, depends on deciding shared shape in lib/; high leverage).
5. Reduce hook return surfaces + split lifecycle if ratchet pressure (M, value depends on whether baseline complains).
6. Clean up cross-component .hooks type imports (S, consistency polish).
7. Optional: address repeated console.error (XS).

**Do NOT** edit generated code. Do NOT propose changes outside prreview slice (e.g. deduping runStatusOf copies lives in other slices + lib).

## Effort / Risk / Value Summary
| Change | Effort | Risk | Value |
|--------|--------|------|-------|
| Remove 3 dead exports + dead import | XS | low | low (but clean) |
| Fix 2 generated direct imports (tests) | XS | low | high (contract) |
| Lift useResizable out of .tsx body | S | low | med |
| Extract shared registry/guard abstraction | M | med | high |
| Reduce god hook returns (section + view model) | M | med | high |
| Split lifecycle.ts (size) | L | med | med (if ratchet active) |
| Move titles to shared consts; fix type imports from .hooks | S | low | low |
| Drop/replace console.error | XS | low | low |

## What NOT to Refactor
- The split into `prreview-*.hooks.ts` + assembly (intentional per AGENTS.md "Hooks placement").
- Use of `buildReviewSectionProps` + slice types (good decomposition).
- The 3-way mode (config/running/results) and fix strip — domain complexity.
- Grandfathered sizes unless actively shrinking the file + baseline in same change (see `tools/lint-meta` but do not stray for edits).
- Anything in `lib/`, `ui/`, `board/`, etc. — out of scope for this slice.

## Verification (for implementer)
- `bun run lint` (rebuilds eslint-plugin; must pass `nightcore/*` rules + no-warn-severity)
- `bun run typecheck`
- `bun run test:web` (or `test:all`)
- For size changes: after shrink, `bun run lint:meta -- --update-baseline` only if lowering an entry.
- No new direct `@/lib/generated/*` or cross-feature imports introduced.
- Hook returns ≤20 after any model refactor.
- Component .tsx bodies contain 0 `useState`/`useEffect`/etc (only calls to their colocated or lifted hooks).

---

**Handoff note:** This slice did not audit `ui/`, `board/`, `harness/`, `insight/`, `scorecard/`, `app/`, `issues/`, `lib/` (non-generated), `packages/eslint-plugin`, or `tools/lint-meta` — those are parallel regions. One cross-slice observation: `runStatusOf` duplication pattern exists in harness/insight/scorecard constants (other slices); a shared helper in `lib/` would be the correct home if deduping is authorized globally.
