# Combined Findings: Motion Layer + Responsive UI Uplift

**Date:** 2026-07-05
**Skill:** /kirei-chain
**Lenses:** ui, perf, arch
**Scope:** Introduce a `motion/react` animation layer to make the Nightcore desktop UI feel lively, AND fix the "controls shrinking when the window isn't full-screen" class of responsive bug — across `apps/web` (React 19 · Tailwind v4 · Tauri/WKWebView), respecting the strict folder-per-component architecture.

## Per-Lens Reports
- **UI/UX:** [docs/ui/2026-07-05-motion-and-responsive-audit.md](../ui/2026-07-05-motion-and-responsive-audit.md)
- **Performance:** [docs/perf/2026-07-05-motion-layer-perf.md](../perf/2026-07-05-motion-layer-perf.md)
- **Architecture:** [docs/arch/2026-07-05-motion-layer-integration-arch.md](../arch/2026-07-05-motion-layer-integration-arch.md)

All headline file:line refs were spot-verified against the working tree (Board toolbar `Board.tsx:126` has zero shrink guards; `Button.tsx:34` base class lacks `shrink-0`/`whitespace-nowrap`; AppShell inline arrows at `AppShell.tsx:219/222/223/248`; grid `minmax(320px,1fr)` at `ProjectsView.tsx:50`; reduced-motion guard at `styles.css:275`).

---

## Cross-Cutting Themes (appeared in 2+ lenses — highest leverage)

1. **`MotionConfig reducedMotion="user"` at the app root is non-negotiable — flagged by ALL THREE lenses.**
   The existing global CSS `prefers-reduced-motion` guard (`styles.css:275-284`) only zeroes CSS `animation`/`transition` durations — it cannot touch `motion/react`'s JS-driven springs (WAAPI/rAF). UI flags it as an a11y regression, perf as needless main-thread work for reduced-motion users, arch as a root-provider wiring decision. Keep the CSS guard (it still owns CSS keyframes: StatusDot/Spinner/Skeleton) AND add `MotionConfig` (owns motion/react). Two non-overlapping owners.

2. **`LazyMotion` + `domAnimation` + `m.*` (`strict`) is bundle-control AND a structural safety rail — perf + arch (ui implied).**
   ~15-18KB gzip vs ~34KB full; matches the codebase's existing aggressive `lazy()` code-splitting. Crucially, `domAnimation` **excludes** `layout`/`layoutId`/drag/projection (those need `domMax`) — so choosing it makes the single most dangerous motion feature a no-op on the board unless someone deliberately swaps bundles. `strict` throws if anyone writes `motion.*` instead of `m.*`.

3. **The Board is the danger zone — perf + ui converge on the same rules.**
   Rows are virtualizer-positioned via `transform: translateY` with dynamic `measureElement` (`Column.tsx:94-125`), and drag already uses a `<DragOverlay>` clone (`BoardDnd.tsx:38-42`). Both lenses independently prescribe: **no `layout`/`layoutId`/`AnimatePresence`-layout on rows or `TaskCard`; animate the `<DragOverlay>` only; no list-stagger inside virtualized columns.** Perf adds that a window resize already fires a simultaneous per-row remeasure — layout animation on rows would turn every resize into a FLIP-reflow storm.

4. **Exit choreography + view transitions via `AnimatePresence` — all three lenses.**
   Today every overlay (Modal, Toast, Menu, drawer, splash) enters with an animation but hard-cuts on unmount. This is the biggest polish-per-effort win. UI owns the choreography, arch owns where `AnimatePresence` mounts (at the mount/unmount conditional — `AppShell.tsx` for drawer/views, inside `Modal` for dialogs), perf owns the constraint that it must sit **inside** each lazy view boundary (not around `<Suspense>`) to avoid a fallback flash, and above `TaskStreamContext.Provider`.

5. **Motion tokens: canonical TS constants + mirrored CSS custom properties — ui + arch.**
   No duration/easing tokens exist today; `cubic-bezier(.22,1,.36,1)` and a dozen durations are inline literals. Both lenses want one source of truth mirrored into `styles.css :root` so CSS keyframes and JS motion never drift.

---

## Conflicts Between Lenses

- **Where the shared motion module physically lives.**
  kirei-ui proposed `apps/web/src/lib/motion.ts`. kirei-arch argued **against** `lib/**` and **for** `apps/web/src/components/ui/motion/`, because `lib/**` is the framework-neutral data/util leaf that sits *below* the rendering layer — putting a rendering library there is a layer inversion, and arch even proposes adding a lint ban on `motion` imports in `lib/**`. **RESOLUTION: follow arch → `components/ui/motion/`** (canonical `tokens.ts` + `variants.ts` + `primitives.tsx` + `MotionProvider`, re-exported through `ui/index.ts`). This satisfies `no-cross-feature-imports` (`sharedFeatures:['ui']`), keeps `ui/` purity, and every feature imports motion from `@/components/ui`. The UI doc's `lib/motion.ts` reference is superseded by this.

- **`AnimatePresence` for views: wrap the whole chain vs. per-view boundary.**
  arch: wrap the in-`<main>` view chain with `<AnimatePresence mode="wait">` keyed on `view`. perf: put `AnimatePresence` *inside* each view boundary so exit doesn't race the lazy `<Suspense>` fallback (flash). These aren't contradictory but must be reconciled in the seam slice: key the chain on `view`, but ensure each lazy view's Suspense fallback is handled (preload-on-nav-intent, or fallback-rendered-inside-the-animated-container) so an exiting view doesn't flash `RouteFallback`. **RESOLUTION: single seam keyed on `view`, with Suspense-flash handling as an explicit design detail in that slice.** Ship the in-`<main>` seam first; defer the projects↔board full-screen (sidebar add/remove) swap.

- **Modal presence API — coordination point, not a true conflict.**
  UI notes dialogs mount as `{cond && <Modal/>}` at call sites, so for `AnimatePresence` to see an exit, `Modal` likely needs an `open` prop (presence owned by Modal) — an API change touching every dialog caller. Arch/perf agree the presence must live at the conditional. **This `open`-prop refactor is the single highest-risk piece of the shared-primitive work** — treat it as its own slice with all call sites updated together.

---

## Unified Priority Order

1. **[PRE-WORK GATE] Restore the Board memo before animating the board.** `AppShell.tsx:219-250` passes 4 fresh inline-arrow handlers (`onChangeAppearance`, `onPickBackground`, `onClearBackground`, `onAutoCommitChange`) to `memo(Board)`; combined with per-frame `setStreams`, `Board` + all 5 Columns reconcile on **every streamed frame** — the `Board.tsx:41-45` "only re-renders on real changes" invariant is currently false. Also stabilize per-column `onClear` (`Board.tsx:277`). This is a real existing perf bug regardless of animation, and it **gates all board-surface animation**. — owner: **perf**
2. **Responsive squish fixes (ship independently; zero motion risk — this is the user's literally-reported bug).** Bake `shrink-0 whitespace-nowrap` into `Button`/`IconButton`/`Segmented`/`Pill`; add a `ui/Toolbar` primitive (`flex flex-wrap items-center gap-2`, children `shrink-0`); rebuild the Board header on `<Button>` + `<Toolbar>`; fix the grid track (`minmax(320px,1fr)` → `minmax(min(320px,100%),1fr)`); add `min-w-0`/`shrink-0` to the breaker banner; cap the TaskDetail drawer width. — owner: **ui**
3. **Motion foundation (cross-cutting blocker — unblocks everything).** Install `motion` (apps/web only); add `ui/motion/tokens.ts` (canonical) + mirror `--nc-motion-*`/`--nc-ease-*` into `styles.css :root`; mount `<LazyMotion features={domAnimation} strict>` + `<MotionConfig reducedMotion="user">` at the AppShell root, **above** `TaskStreamContext.Provider`; add vitest + Storybook determinism (`transition={{duration:0}}`). — owner: **arch** (all three)
4. **Shared `ui/` exit choreography (one change fans out to every feature).** Modal → `AnimatePresence` via the `open`-prop refactor (touches every dialog caller); Toast enter/exit + settle; Menu enter/exit; Segmented `layoutId` sliding highlight; Button `whileTap`/`whileHover`. — owner: **ui** (perf guardrails)
5. **Per-feature surfaces.** Splash → board cross-fade; the `view`-keyed `AnimatePresence` seam in `AppShell`; TaskDetail drawer presence; **`<DragOverlay>` pickup animation only** on the board; RunProgress `width`→`scaleX` + row stagger keyed on discrete finished-count. — owner: **ui + arch** (perf hard rules)

---

## Recommended Execution Strategy

**One dependency-ordered build task** (created in `.nightcore/tasks/`), executed in the phase order above, because the phases have a hard dependency spine: the memo fix gates board animation (1 → 5), and the motion foundation gates all choreography (3 → 4, 5). Phase 2 (responsive) is fully independent and can land first/concurrently — it is the user's reported bug and carries zero animation risk.

Slice boundaries if decomposed later (each ends green on `bun run lint` + `--filter @nightcore/web typecheck` + `bun run lint:meta` + `test:web`):
- **Slice A** — Board memo fix (perf pre-work) + responsive squish fixes (independent, ship first).
- **Slice B** — Motion foundation: install + tokens + providers + test/storybook determinism + the `lib/**` motion lint ban.
- **Slice C** — `ui/motion/` primitives (`FadeIn`/`RiseIn`/`SlideIn`/`AnimatedList` + `AnimatePresence` re-export) with stories + tests.
- **Slice D** — Shared `ui/` adoption incl. the Modal `open`-prop refactor (highest risk; all call sites together) + Toast/Menu/Segmented/Button.
- **Slice E** — Per-feature surfaces: Splash cross-fade, `AppShell` view seam, drawer presence, board `DragOverlay` animation, RunProgress.

**Hard rules the executor must honor (from perf + ui, non-negotiable):**
- No `layout`/`layoutId`/`AnimatePresence`-layout on `Column` rows or `TaskCard`. Animate the `<DragOverlay>` only. Keep the existing `opacity-40` drag-source pattern.
- No motion component may consume `TaskStreamContext` or animate off raw token state; run-screen animations key on discrete signals (phase, finished-count) only. Continuous/ambient motion uses `MotionValue`, never React state.
- Never permanent `will-change` on cards/rows/toasts (standing GPU layers; multiplies across a 1000-card board).
- Transform/opacity only on hot surfaces. Keep StatusDot/Spinner/Skeleton as CSS keyframes.
- Do not delete the CSS `prefers-reduced-motion` guard.
- `motion` in `apps/web/package.json` only — never `packages/*`, `lib/**`, or `lib/generated/**`.

## Out of Scope (surfaced but not investigated — candidate follow-ups)
- **Radius-token drift** (ui): components bypass `--nc-radius` with ad-hoc `rounded-[9px]`/`rounded-[14px]`. A small design-consistency pass; not blocking.
- **`runningProjectIds` fresh array each render** (`AppShell.tsx:105`, perf): only reaches `ProjectsView`, off the hot path — note only.
- **Bundle deep-dive** (not run this chain): motion's exact byte impact and whether `loadFeatures`-lazy is worth it — could be a `/kirei-bundle` follow-up if the entry chunk becomes a concern.
- **The projects↔board full-screen transition** (adds/removes the sidebar): deferred by arch as higher-risk/layout-structural; a later slice, not this task.
