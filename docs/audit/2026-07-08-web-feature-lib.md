# Audit Findings — web-feature-lib

**Date:** 2026-07-08
**Agent:** kirei-refactor (parallel slice)
**Scope:** apps/web/src/components/app, issues, worktree, settings, projects, new-project, onboarding + apps/web/src/lib (excluding generated/) + App.tsx + main.tsx

---

## Summary

Audit of ~300 source files covering the composition root (AppShell), feature folders (issues, worktree, settings, projects, new-project, onboarding), and the lib utilities (bridge seam, data layer, formatters, hooks, streams).

**Key observations:**
- **Lib is a correct framework-neutral leaf**: no imports from components/* or motion. Bridge is the sole Tauri seam.
- **Bridge seam discipline is sound**: all `@tauri-apps/*` imports confined to `lib/bridge/`, all external code imports via barrel.
- **No direct generated imports** within scope (prreview violations are outside this slice).
- **Duplication has been consolidated** into lib/: `useScanRun`, `useScanResultsView`, `useBulkConvert`, `scan-run/*`, `formatters`, etc.
- **Tests use vitest-browser-react** (correct, no jsdom).
- **No TODO/FIXME/HACK comments** found in scope.
- **No state in production component bodies** (`.tsx`); state lives in `.hooks.ts`.
- **Grandfathered file-size ratchet** entries exist for 3 files in scope.

**Highest-leverage findings:**
1. **Dead data in New Project flow** — `NewProjectDialog` collects `model`/`concurrency` but `useNewProjectFlow.create` and AppShell ignore them (draft fields dropped).
2. **Grandfathered over-cap files** — 3 files exceed 400-line ratchet (AppShell.tsx 457, bridge/events.ts 697, IssueTriageView.hooks.ts 506) — frozen in baseline.
3. **Hardcoded legacy model labels** — `MODELS = ['Opus 4.8', ...]` passed as model ids to NewProjectDialog; rest of app uses contract ids (`claude-opus-4-8`).
4. **Bridge events.ts is a god module** (692 lines) — all nc:* subscriptions and narrowers in one file; functional but large.
5. **AppShell.tsx (450 lines)** mixes routing, lazy loading, provider wiring, and overlay orchestration — thin shell but crosses many concerns.

---

## Dead Code to Remove

| File | What | Risk |
|------|------|------|
| `apps/web/src/components/app/AppShell/AppShell.tsx:85` | `const MODELS = ['Opus 4.8', 'Sonnet 4.8', 'Haiku 4.5'];` — legacy display strings used as model ids; not the contract ids | Low (behavioral risk if backend expects ids) |
| `apps/web/src/components/app/AppShell/AppShell.tsx:416` | `models={MODELS}` passed to NewProjectDialog; draft.model/draft.concurrency never forwarded to create | Low |
| N/A | No commented-out blocks or unused exports detected via grep + barrel inspection | — |

**Note:** `MODELS` constant and the `model`/`concurrency` fields on `NewProjectDraft` are not strictly "dead" (they're wired through props), but the values are wrong and the collected fields are dropped by the caller — effectively dead data paths.

---

## Duplication to Consolidate

No new copy-paste duplication found in scope. Prior consolidation work is visible and correct:

- `lib/scan-run/{fold,lifecycle,results}.ts` + `lib/useScanRun.ts` + `lib/useScanResultsView.ts` + `lib/useBulkConvert.ts` — the shared scan machinery hoisted out of Insight/Harness/Scorecard/IssueTriage.
- `lib/formatters.ts` — grounded location + relative time + cost + elapsed, used by multiple scan surfaces.
- `lib/attachments.ts` — image/background/icon validation shared by create + settings.

These live in `lib/` by design (only place cross-feature sharing is allowed).

---

## Abstractions to Add

| What's missing | Currently | Should be |
|----------------|-----------|-----------|
| Model id contract for New Project | `NewProjectDialogProps.models: string[]` + `MODELS` display labels passed as ids | Should accept `ModelOption[]` or contract ids; dialog should not treat human labels as wire values |
| New Project model/concurrency wiring | Dialog collects 4 fields; flow only forwards `(folder, name)` | Either drop the fields from the dialog, or wire them through `createProject` (if backend supports) or store as initial settings |

---

## Abstractions to Remove

None. The existing lib/ extractions (scan-run, bulk convert, results view) are justified by 3+ consumers and the `no-cross-feature-imports` rule.

---

## Files to Split

| File | Lines | Problem | Split into |
|------|-------|---------|------------|
| `apps/web/src/lib/bridge/events.ts` | 692 (baseline 697) | All nc:* channels, narrowers, and payload types in one file. Functional but hard to navigate. | Keep as-is for now (grandfathered); a future carve-out could split per-channel (e.g. `events/session.ts`, `events/project.ts`) but would need a barrel re-export to preserve public API. |
| `apps/web/src/components/app/AppShell/AppShell.tsx` | 450 (baseline 457) | Thin presentational host but mixes: lazy route registration, browser banner, overlay wiring, provider composition. | Not a priority split — composition root is allowed to orchestrate. If it grows further, the lazy map could move to a `routes.ts` sidecar. |

---

## Implementation Order

1. **Investigate/align New Project model wiring** — decide whether `model`/`concurrency` should flow through or be removed from the dialog. Low risk, touches only the new-project path.
2. **(Optional) Replace MODELS display labels** with proper model ids or `MODEL_OPTIONS` — depends on (1).
3. **No other mechanical refactors required** within this slice. Grandfathered ratchet entries are tracked in baseline; do not touch without a deliberate shrink + baseline update.

---

## Effort Estimates

| Change | Effort | Risk | Value |
|--------|--------|------|-------|
| Audit wiring gap (New Project model/concurrency) | XS | Low | Medium |
| Align MODELS with contract ids (or remove) | S | Low | Low |
| Split bridge/events.ts (optional, future) | L | Medium | Low |
| Split AppShell.tsx (not recommended) | M | Low | Low |

---

## What NOT to Refactor

- **Grandfathered ratchet files**: AppShell.tsx (457), bridge/events.ts (697), IssueTriageView.hooks.ts (506). These are frozen in `tools/lint-meta/baselines/web-file-size-ratchet.json`. Touching without shrinking + baseline update will fail CI.
- **Console.error usage**: pervasive and intentional (fire-and-forget handlers surface via toast; errors are logged for diagnostics).
- **Bridge barrel surface**: any reorg must preserve `@/lib/bridge` exports unchanged.
- **Scan-run consolidation**: already correctly placed in lib/; do not move into features.
- **App composition root crossing features**: allowed and required; AppShell is the sole crosser.

---

## Additional Notes (Consistency / Conventions)

- **Barrels export only external surface**: app/*, lib/bridge/*, and feature barrels all follow the rule.
- **File naming**: feature modules use kebab for compound domain modules at feature root (e.g., `issue-stream.ts`, `settings-cards.tsx`). Legacy bare-noun roots in board/ are grandfathered.
- **Bridge "one command, three names"**: Rust snake_case, invoke string, camelCase wrapper — all aligned inside bridge/.
- **No direct generated imports** in this slice.
- **Tests**: all `*.test.tsx` use `vitest` + `vitest-browser-react` + `composeStories`; query by role/text, not data-testid.
