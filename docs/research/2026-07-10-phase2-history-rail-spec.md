# Build spec: Views Phase 2 — cross-kind run History view

**Date:** 2026-07-10
**Ticket:** wayfinder #98 (graduated from the map's Not-yet-specified on #96 close)
**Status:** build-ready, **GATED** — do not build until the Phase-1 stage nav (PRs 3–4 of
`2026-07-10-phase1-view-rethink-spec.md`) has merged AND been dogfooded for real use.
Every decision below is locked (grilled 2026-07-10). Do NOT re-litigate; implement.
**Prior art:** `docs/research/2026-07-10-scan-views-rethink.md` (Option B mechanics / Phase 2),
`docs/research/2026-07-10-phase1-view-rethink-spec.md` (stage nav, `family`, preselect).

---

## 1. Decision record (grilled 2026-07-10)

| # | Branch | Decision |
|---|---|---|
| 1 | Build at all / when | **Yes — spec now, build after Phase-1 dogfood.** #98 closes with this spec; implementation is a separately-gated ticket. |
| 2 | Where it surfaces | **One global History view** in the project nav group (Board / Worktrees / History). Stage shells untouched; per-mode history menus inside stages stay as-is. |
| 3 | Aggregator shape | **Web-side merge hook.** No Rust command, no contracts, no codegen. The research doc's `list_all_scan_runs` Rust aggregator is explicitly REJECTED for v1 — the three per-family bridge list commands already exist and already return full run lists; the hook is the upgrade seam if a server-side aggregator is ever wanted. |
| 4 | `FindingsResultsView` | **Not built, not tied to History.** History renders summaries and routes into existing stage views — it never renders findings. The descriptor-keyed renderer design lives in Appendix A as a standalone future ticket, triggered by the next new scan sibling, not by this build. |

**Hard constraints (unchanged from Phase 1):** run stores and
`.nightcore/{insights,scorecards,harness}/` untouched; zero migration; zero persistence
change; `apply_harness_artifact` untouched; PR Review / Issue Triage are NOT aggregated
(different molds: concurrent / list-driven — per the rethink doc's risk list).

---

## 2. Scope

**In:**
- New `history` member of the `AppView` union + render branch + nav row
  (group `project`, label **"History"**, hint **`R`** — freed by the Phase-1 flip; post-flip
  hints become `K W R T U H E P S`, all distinct).
- New `apps/web/src/components/history/HistoryView/` feature folder (folder-per-component).
- New `useAllScanRuns` hook + slim TS-only `ScanRunSummary` type.
- Run-level click-through routing into Understand / Harden / Enforce via the routing seam.

**Out (explicit):**
- Rust `list_all_scan_runs` command, ts-rs summary type, any codegen (rejected, branch 3).
- Live event plumbing — History loads on mount and refreshes on remount/focus; in-flight
  runs appear with their stored `status`, they do not tick live.
- Pagination / virtualization — ≤150 rows (MAX_RUNS=50 × 3 stores) renders as a plain list.
- PR Review + Issue Triage families.
- Building `FindingsResultsView` (Appendix A is design-only).

---

## 3. Design

### 3.1 `ScanRunSummary` + `useAllScanRuns`

TS-only (NOT a zod contract — nothing crosses a wire; the inputs are already generated types):

```ts
// apps/web/src/components/history/HistoryView/HistoryView.types.ts
export type ScanFamily = 'insight' | 'scorecard' | 'harness';
export type ScanRunSummary = {
  id: string;
  family: ScanFamily;
  title: string;
  status: string;        // pass-through of the per-family status string
  createdAt: number;
  projectPath: string;
};
```

`useAllScanRuns(projectPath)` (in `HistoryView.hooks.ts`, or `apps/web/src/lib/` if a second
consumer appears — implementer's call, but default to the component folder):

- Calls the three existing bridge commands in parallel:
  `listInsightRuns()` (`lib/bridge/commands/insight.ts:39`),
  `listHarnessRuns()` (`lib/bridge/commands/harness.ts:40`),
  `listScorecardRuns()` (`lib/bridge/commands/scorecard.ts:35`).
- Maps each run to `ScanRunSummary` (all three generated types share
  `id / projectPath / status / createdAt / title` — verified against
  `apps/web/src/lib/generated/{Insight,Scorecard,Harness}Run.ts`).
- Filters to the current `projectPath`, sorts `createdAt` desc, returns
  `{ runs, loading, error, refresh }`.
- Each bridge command already defaults to `[]` on failure; a single failed family must not
  blank the view — merge what loaded, surface a non-blocking warning row.

### 3.2 HistoryView

`apps/web/src/components/history/HistoryView/` — full folder-per-component
(`HistoryView.tsx`, `.hooks.ts`, `.types.ts`, `index.ts`, `.stories.tsx`, `.test.tsx`).
Imports only `lib/` + `ui/` — no feature-view imports, so `no-cross-feature-imports` stays
green without composition-root placement.

- Plain list, newest first: family badge (Insight / Scorecard / Harness), title, status
  chip (reuse the existing status-chip idiom from the stage views), relative timestamp.
- Empty state: "No scan runs yet — start one from Understand, Harden, or Enforce."
- Row click → `onOpenRun(family, runId)` prop.

### 3.3 Routing (run-level, no token parsing)

`AppShellViews.tsx` wires `onOpenRun` to the routing seam directly — do NOT synthesize
source-ref tokens (run-level tokens are not part of the frozen mint grammar):

```
family → stage view: insight → 'understand' (Find), scorecard → 'understand' (Grade),
harness → 'enforce'   // matches the REGISTRY's harness→enforce mapping from PR 3
```

`onOpenRun` sets `scanTarget = { view, family, runId }` (no `kind`/`itemId` — run-level)
then `setView(view)`. The stage shells' preselect machinery already keys `selectRun` on
`runId` (`usePreselectNavigation`), so a target without `itemId` opens the run with no panel
— exactly the wanted behavior. If the merged PR 3 landed a different run-level idiom, use
that instead; the invariant is: **row click lands on the owning stage with the run selected.**

Deleted-run edge: stage preselect already degrades gracefully (`getRun → null` leaves the
shell on its current stream) — History rows may be stale after a store prune; that is
acceptable and needs no extra handling beyond the existing degradation.

---

## 4. Files

| Action | File |
|---|---|
| new | `apps/web/src/components/history/HistoryView/*` (6 files, folder-per-component) |
| edit | `apps/web/src/components/app/AppShell/AppShell.types.ts` — union `+ 'history'` |
| edit | `apps/web/src/components/app/AppShell/AppShellViews.tsx` — render branch + `onOpenRun` wiring |
| edit | `apps/web/src/components/app/AppShell/nav.constants.tsx` — row: `history` / "History" / `R` / group `project` |

No Rust, no contracts, no codegen, no lint-meta map edits (`scan-family-parity` untouched —
no enrolled folder moves; the `nav-render-parity` rule from PR 3 only constrains REGISTRY
views, and `history` is not a REGISTRY view — but the union member MUST still get its render
branch in the same commit; never orphan a member).

## 5. Test plan

1. **Hook** — merge + sort + project-filter over three mocked bridge responses; one family
   failing (empty array) still yields the other two + warning state.
2. **Empty state** renders when all three return `[]`.
3. **Row click** — assert `onOpenRun` fires with `(family, runId)`; shell-level test asserts
   the Understand/Enforce surface renders with the run selected (clone the AppShell routing
   idiom from `AppShell.test.tsx` "routes to the Settings surface").
4. **Stories** — populated (mixed families + statuses), empty, one-family-failed.

## 6. Verification gates

```
bun run lint                              # folder-per-component, no-cross-feature-imports
bun run lint:meta                         # incl. nav-render-parity from PR 3
bun run --filter @nightcore/web typecheck
bun run --filter @nightcore/web test
bun run dogfood:ui                        # manual: History lists runs, click lands on the right stage
```

`cargo test` is a no-op guard here (zero Rust changes) — run it once to prove no ts-rs drift.

---

## Appendix A — `FindingsResultsView` (design-only; future standalone ticket)

**Trigger:** the next NEW scan sibling (an 8th single-run kind), or a second concrete
consumer that renders findings generically. NOT triggered by History (which renders
summaries) and NOT part of the Phase-2 build.

Sketch (Option A's renderer-registry track from the rethink doc):
- `apps/web/src/components/ui/FindingsResultsView/` — a generic findings-list renderer keyed
  by a per-kind descriptor: `{ family, itemNoun, columns, badge(item), detail(item) }`.
- Kind-specific renderers register in a table (the descriptor), so a new sibling supplies a
  descriptor entry instead of hand-cloning a results screen.
- Migration path: adopt in ONE existing view first (Insight — the plainest), prove pixel
  parity via its stories, then migrate Scorecard/Harness only if the descriptor holds
  without leaking kind-conditionals. Abort criterion: if the descriptor needs per-kind
  branches inside the shared renderer, the abstraction has failed — stop and keep per-kind
  screens.
- Constraint carried forward: `scan-family-parity` enrolment map and folder layout stay;
  the renderer is a leaf `ui/` primitive, not a re-homing of the views.
