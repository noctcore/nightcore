# Performance Report — Adding a motion/react Animation Layer

**Date:** 2026-07-05
**Agent:** kirei-perf (kirei-chain, alongside kirei-ui + kirei-arch)
**Scope:** Frontend (apps/web) — introducing `motion/react` to the Tauri/WKWebView React 19 UI. Research only, no code changes.

## Summary

The UI is already one of the most render-disciplined React codebases you'll audit: `nc:session` token streaming is RAF-coalesced into one `setStreams` per frame (`useBoard.hooks.ts:83-132`), the Board/Column/TaskCard tree is memoized down to the single card whose tool-count changed (`Board.tsx:306`, `Column.tsx:133`, `TaskCard.tsx:410`), the activity timeline appends in-place at O(1) and re-renders only the growing trailing row (`session-stream.ts:117-133`, `ActivityLog.tsx:255-315`), the board list is virtualized (`Column.hooks.ts:52-70`), drag uses a `<DragOverlay>` clone rather than moving the source (`BoardDnd.tsx:38-42`, `TaskCard.tsx:121-128`), and all existing motion is transform/opacity CSS keyframes behind a global `prefers-reduced-motion` guard (`styles.css:193-284`).

Because of this, the dominant risk of adding motion is NOT bundle weight — it is that **during a live run every animation frame already carries a React commit**. The RAF flush (`useBoard.hooks.ts:116`) fires a `setStreams` per frame; a JS-driven animation (motion spring/tween on the main thread) schedules its own rAF callback in the same frame. React reconcile + motion tick + WebKit layout/paint then share one 16.6ms budget. The safe strategy is: (1) keep motion off React's render path (MotionValues), (2) keep it off the compositor-hostile layout properties, and (3) fix the one place where streaming already over-renders a surface we'll want to animate.

WKWebView specifics: GPU-accelerated `transform`/`opacity` are cheap on WebKit's compositor; animating `width`/`height`/`top`/`left`/`margin` forces reflow. motion's `layout` prop animates via FLIP — it reads `getBoundingClientRect()` before/after (a forced synchronous reflow) — which is the single most dangerous motion feature to place on a virtualized/dragging surface.

## Bottleneck Map

### HIGH IMPACT — Board memo is already defeated on every stream flush (existing bug, animation amplifier)
**Type:** Re-render storm
**Location:** `apps/web/src/components/app/AppShell/AppShell.tsx:219-250` (inline arrows) → `apps/web/src/components/board/Board/Board.tsx:306` (`memo(BoardImpl)`, default shallow compare); secondary `Board.tsx:277` (`onClear={() => onClearColumn(def.statuses)}`).
**Impact:** `streams` state lives in `useBoard` → `useAppShell` → `AppShell`, so `setStreams` re-renders `AppShell` on **every coalesced frame** while streaming. `AppShell` hands `Board` four fresh inline-arrow props each render (`onChangeAppearance`, `onPickBackground`, `onClearBackground`, `onAutoCommitChange`), so `memo(Board)` never bails — the Board body + all 5 Columns reconcile per frame. `Board.tsx:41-45` claims the board "only re-renders when its tasks/selection/loop state actually change, not on every stream delta" — that invariant is currently false. It's tolerable today only because every TaskCard leaf still bails (stable primitives + memoized handlers). It stops being tolerable the moment any Board-surface animation is added: a per-frame reconcile becomes a per-frame animation/layout recompute.
**Root cause:** Inline closures created in `AppShell`'s render body; `onClear` inline closure per column in `Board`.
**Fix:** Memoize the 4 appearance/auto-commit handlers in `useAppShell` (mirror the `detailActions` `useMemo` at `AppShell.hooks.ts:623-640`), and give each column a stable `onClear` (pass `statuses` + the already-stable `onClearColumn`, or `useCallback` per column). Verify with React DevTools Profiler: with a task streaming, `Board` should show 0 renders per frame, not ~60.

### HIGH IMPACT — Layout animation on virtualized rows vs. the virtualizer + dnd-kit
**Type:** Layout thrashing / measurement conflict
**Location:** `apps/web/src/components/board/Column/Column.tsx:94-125` (rows are `position:absolute` + `transform: translateY(row.start)` + `ref={virtualizer.measureElement}`), `apps/web/src/components/board/Column/Column.hooks.ts:52-70` (dynamic `measureElement`, `overscan:6`), `apps/web/src/components/board/BoardDnd/BoardDnd.tsx:38-42` (`<DragOverlay>`), `apps/web/src/components/board/TaskCard/TaskCard.tsx:89,121-128` (source card gets only `opacity-40`, no self-transform).
**Impact:** Naive `<motion.div layout>` or `<AnimatePresence>` on the row wrapper or `TaskCard` will:
  - Overwrite the `transform: translateY(...)` the virtualizer sets for positioning → rows jump/snap.
  - Force a synchronous `getBoundingClientRect` per row per frame (FLIP), interleaving reads with the virtualizer's ResizeObserver writes → classic layout thrash mid-scroll.
  - `AnimatePresence` exit keeps a "removed" row mounted after the virtualizer drops it from `getVirtualItems()` → total-size/offset math desyncs from the exiting node → visual tearing + orphan nodes.
  - During drag, dnd-kit sets a transform on the active node while `layout` also wants the transform → conflict/stutter; a `layoutId` shared between the source row and the `DragOverlay` clone triggers a FLIP measure on every pointer move.
**Root cause:** motion `layout`/`layoutId`/`AnimatePresence`-layout each own the element's `transform` and measure its box — three systems (virtualizer, dnd-kit, motion) then contend for the same transform + measurement.
**Fix:** On virtualized rows and cards: (a) NO `layout`/`layoutId`; (b) enter/exit animations disabled for virtualized items (the row is already conditionally mounted by the virtualizer — let it, don't `AnimatePresence` it); (c) keep drag on the existing `<DragOverlay>` + `opacity-40` source pattern (it's already correct — the overlay is transform-driven and cheap); (d) if a card must animate on state change (e.g., a status flip glow), animate `opacity`/`box-shadow`/`transform` on the card's INNER content only, never the virtualizer-positioned wrapper. Choosing the `domAnimation` feature bundle (below) makes `layout` a no-op unless someone deliberately swaps to `domMax` — a structural guardrail.

### HIGH IMPACT — Animating anything that consumes the per-flush stream (run screens + TaskDetail)
**Type:** High-frequency setState → animation recompute
**Location:** streaming source `useBoard.hooks.ts:106-121`; live consumers `TaskDetail.hooks.ts:17` (`TaskStreamContext` value = live `SessionGroup[]`, changes every flush), `ActivityLog.tsx:37-47` (`scrollTick` grows every delta). Run screens: `RunProgress.tsx` + `RunLifecycleShell.tsx` render under live scan-log streaming/heartbeat.
**Impact:** Any `motion.*` component that (a) consumes `TaskStreamContext`, or (b) sits inside `ActivityLog`/`RunProgress`/`TaskDetailChrome`'s streaming subtree, and whose props/`animate` target derive from stream state, will re-evaluate its animation every flush — turning a one-shot transition into a per-frame recompute, and risking interrupted/restarted springs (a spring re-created each frame never settles).
**Root cause:** Stream velocity (token-level) is far higher than animation intent (state transitions).
**Fix:** (a) Mount the `LazyMotion` provider ABOVE `TaskStreamContext.Provider` so motion internals never consume the per-flush value. (b) In run screens, animate only phase/enter/exit and discrete count changes, keyed on the DISCRETE signal (phase, finished-count), never on the raw token stream. (c) Any continuous decoration (indeterminate bar, live glow, spinner) uses a MotionValue loop (`animate(mv, ...)`) so it updates the DOM outside React and adds zero renders to streaming frames. (d) Keep the existing 1Hz elapsed tickers as-is (`TaskCard.hooks.ts:20-56`, `RunProgress.hooks.ts:23-32`) — do NOT animate the elapsed digits with per-frame motion (would multiply the once-per-second render into 60/s).

### MEDIUM IMPACT — Drawer & view transitions (mount/unmount of lazy Suspense chunks)
**Type:** Enter/exit animation on code-split boundaries
**Location:** `AppShell.tsx:257-279` (TaskDetail drawer mounts on `selected !== null`, currently CSS `.nc-drawer-enter` on enter, no exit — `TaskDetail.tsx:185`), `AppShell.tsx:283-346` (views mount/unmount by `view === 'x'` behind `<Suspense>`), existing `nc-slide`/`nc-sheet-in` keyframes (`styles.css:227-244`).
**Impact:** These are the legitimate, safe places for `AnimatePresence` enter/exit — but each wraps a `lazy()` Suspense boundary. If `AnimatePresence` wraps the Suspense boundary, the exit animation can race the fallback (`fallback={null}`/`RouteFallback`) and flash. Exit animations also hold the outgoing view (and its heavy chunk's DOM: Markdown/Shiki) mounted a beat longer.
**Root cause:** Exit animation + Suspense unmount ordering.
**Fix:** Put `AnimatePresence` INSIDE each view boundary (animate the resolved content), not around the `<Suspense>`; keep exit durations short (≤200ms, matching existing `nc-slide` 0.26s / drawer). Prefer transform+opacity (slide/fade), which the existing keyframes already use. Cross-lens (kirei-ui owns the exact choreography; kirei-arch owns placement).

### MEDIUM IMPACT — Motion does not inherit the global reduced-motion guard
**Type:** Correctness/perf (unbounded motion for reduced-motion users)
**Location:** `styles.css:275-284` collapses every CSS `animation-duration`/`transition-duration`, but motion's JS springs/tweens read their own config, not the media query.
**Impact:** Without wiring, reduced-motion users still get full JS animation — both an accessibility regression and needless main-thread work.
**Fix:** Wrap the app in `<MotionConfig reducedMotion="user">` (or gate durations via `useReducedMotion()`). This is a hard guardrail, not optional.

### LOW IMPACT — RunProgress overall bar animates `width`
**Type:** Layout-affecting transition (contained)
**Location:** `RunProgress.tsx:88` (`transition-[width] duration-500`).
**Impact:** `width` transition triggers layout, but it's one isolated bar inside an `overflow-hidden` rounded container — reflow is contained and infrequent (per finished-category). Low.
**Fix (optional quick win):** Switch to `transform: scaleX()` off a `transform-origin:left` track to stay purely on the compositor if kirei-ui wants a smoother/faster determinate fill.

### LOW IMPACT — Toast has entrance but no exit; `will-change` discipline
**Type:** Missing exit / layer hygiene
**Location:** `Toast.tsx:44-50` (`animation: nc-rise` on enter, toasts just unmount — no exit), stacked list at `Toast.tsx:38-43`.
**Impact:** A natural `AnimatePresence` candidate (safe — few nodes, not virtualized, not streaming). Watch two things: (a) an `AnimatePresence` with `layout` on the stack would animate siblings shifting — acceptable here (small N) but keep it `domAnimation`, i.e. no layout, and let stack reflow instantly; (b) motion applies `will-change:transform` during animation and removes it after — do NOT hand-pin `will-change` on toasts or cards permanently; a permanent GPU layer per card/toast costs compositor memory (meaningful on a 1000-task board).

## Motion Render-Cost Model (how to keep motion/react cheap here)

1. **Bundle + safety in one: `LazyMotion` + `domAnimation` + `m.*`.**
   `import { LazyMotion, domAnimation, m, MotionConfig } from 'motion/react'`. The always-loaded `m` runtime is ~4.6KB gzip; `domAnimation` (~15–18KB gzip) adds animations/variants/exit + hover/tap/focus gestures. It deliberately EXCLUDES `layout`/`layoutId`/drag/`AnimatePresence`-projection (those need `domMax`, ~25KB+). Choosing `domAnimation` shrinks the bundle AND structurally forbids the expensive `layout` path on the board. Use `<LazyMotion features={domAnimation} strict>` — `strict` throws if anyone writes `motion.*` instead of `m.*`, enforcing the discipline. Context: current main JS chunk is ~491KB uncompressed (`index-*.js`) with heavy deps already lazy (Shiki `CodeBlock` 969KB, Markdown 66KB); motion's feature bundle can also be `loadFeatures`-lazied since animation is chrome, not entry-critical.
2. **Transform/opacity ONLY on hot surfaces.** Board cards/rows, run screens, drawer: animate `transform` (`x`/`y`/`scale`/`rotate`) and `opacity`. Never `width`/`height`/`top`/`left`/`margin`/`padding` (reflow on WebKit). The existing keyframes (`styles.css:193-264`) are already 100% transform/opacity — match that vocabulary.
3. **No `layout`/`layoutId` on virtualized or dragging elements.** (See HIGH #2.) `layout` = per-frame `getBoundingClientRect` (forced reflow). Fine on a small static panel; poison on the board.
4. **MotionValues to bypass React for continuous animation.** For anything that runs every frame (indeterminate bars, ambient glows, counters, drag-follow decorations): `useMotionValue` + `animate()`/`useSpring` + `useTransform`. These write to the DOM node's style directly via motion's own rAF and DO NOT trigger React re-renders — essential on surfaces that also re-render from streaming. Rule of thumb: if it animates continuously, it must be a MotionValue, not React state.
5. **`will-change` is transient, never permanent.** motion adds `will-change:transform` for the animation's duration and removes it on completion — let it. Do not add permanent `will-change` utility classes to cards/rows/toasts; each creates a standing GPU layer (compositor memory), which multiplies across a 1000-card board.
6. **Reduced-motion is wired, not assumed.** `<MotionConfig reducedMotion="user">` at the root (the CSS guard at `styles.css:275-284` does not reach motion's JS animations).
7. **One provider, mounted high, above the stream context.** Single `<LazyMotion>` at `AppShell` root, above `TaskStreamContext.Provider`, so motion internals never re-render on a flush and the feature bundle loads once.

## Existing re-render smells that animation would worsen

- **Board memo defeated per flush** — `AppShell.tsx:219-250` + `Board.tsx:277`. Pre-work REQUIRED before animating the board header/columns/cards. (Full detail: HIGH #1.)
- **`runningProjectIds` fresh array each render** — `AppShell.tsx:105`. Only reaches `ProjectsView` (off the board path). No pre-work; note only.
- **Everything else is clean.** No React Context churn on the hot path (only `Toast` and `TaskStreamContext` exist app-wide; `TaskStreamContext` churn is intentional and isolated to `ActivityLog`, `TaskDetail.hooks.ts:13-17`). Lists are virtualized + memoized. Serialization (`marked`+`DOMPurify`) is guarded to parse a sealed turn exactly once (`ActivityLog.tsx:264-274`, `session-stream.ts:16-20`). No unmemoized large `.map` on the streaming path.

## Measurable Guardrails ("good") + how to check in WKWebView (no CDP)

- **Target:** sustained ~60fps (frame ≤16.6ms) during: card drag across columns, TaskDetail drawer open/close, view switches, and a phase transition on a run screen while a task streams.
- **No long task >50ms** during any transition. **Drag latency unchanged** vs. pre-motion baseline. **No GPU-memory growth** from standing `will-change` layers after animations settle.
- **Tooling (WKWebView has no CDP):**
  - **Safari Web Inspector** attached to the app WebView (Develop → Nightcore) → **Timelines → Rendering Frames** (dropped/long frames) and **JavaScript & Events** (long tasks, forced layout warnings). Look specifically for "Forced Layout / Reflow" markers during drag — their presence means a `layout`/`getBoundingClientRect` read is thrashing.
  - **In-app probes** (both supported in WebKit): `PerformanceObserver({ entryTypes:['longtask'] })` to count >50ms tasks; a `requestAnimationFrame` delta logger for a rolling FPS meter. Wire behind a debug flag; log during a scripted pointer-drag (see `BoardDnd.test.tsx` for the pointer-event sequence) with a task streaming.
  - **React DevTools Profiler** for the memo verification: record a 3s window with a task streaming; assert `Board` renders 0×/frame after the HIGH #1 fix (baseline today: ~1 render/frame).
- **Metrics to track before/after:**
  - Board renders-per-streamed-frame (DevTools Profiler) — target 0 after fix.
  - Long tasks during a cross-column drag (PerformanceObserver) — target 0 >50ms.
  - Frame time p95 during drawer open/close and view switch — target ≤16.6ms.
  - Bundle: main chunk delta from motion — target ≤ ~18KB gzip via LazyMotion+domAnimation (vs ~34KB full).

## Pre-requisite fixes BEFORE animations vs. safe CONCURRENTLY

**BEFORE (land first, on the surfaces they gate):**
1. Memoize the 4 appearance/auto-commit handlers in `useAppShell` + stabilize per-column `onClear` — restores `Board`'s memo (`AppShell.tsx:219-250`, `Board.tsx:277`). Gates ALL board-surface animation.
2. Establish the motion baseline as a convention artifact: `<LazyMotion features={domAnimation} strict>` + `<MotionConfig reducedMotion="user">` at `AppShell` root, above `TaskStreamContext.Provider`. Gates every subsequent motion PR (prevents `layout`/`domMax` and unguarded reduced-motion from ever landing).

**SAFE CONCURRENTLY (no dependency on the above):**
- Toast enter/exit via `AnimatePresence` (`Toast.tsx`) — isolated, few nodes, not streaming/virtualized.
- View/drawer transitions (`AppShell.tsx:257-346`) — provided `AnimatePresence` sits inside the view boundary, not around `<Suspense>`.
- RunProgress `width`→`scaleX` swap (`RunProgress.tsx:88`) — pure quick win.
- Static-panel micro-interactions (Settings, Modal, KindPicker, etc.) — off the hot path entirely.

**Do NOT do (hard rules):**
- `layout`/`layoutId`/`AnimatePresence`-layout on `Column` rows or `TaskCard` (`Column.tsx:94-125`, `TaskCard.tsx:121-128`).
- Motion components that consume `TaskStreamContext` or animate off raw token state (`TaskDetail.hooks.ts:17`, `ActivityLog.tsx:37-47`).
- Permanent `will-change` on any card/row/toast.
- Re-implementing drag movement with motion — the existing `<DragOverlay>` + `opacity-40` source (`BoardDnd.tsx:38-42`, `TaskCard.tsx:125`) is already the correct transform-driven pattern.

## Note on "controls shrinking at small window sizes" (UI's lens; perf angle only)
Board columns are fixed-width inline styles with horizontal scroll (`Column.tsx:59`, `Board.tsx:252`); the header uses `flex-wrap`. There's no JS relayout-on-resize on the board EXCEPT the virtualizer's per-visible-row `measureElement` ResizeObservers (`Column.hooks.ts:55`), which is correctly bounded to visible rows. Perf-relevant implication: a window resize already fires a remeasure across every visible row simultaneously — so adding `layout` animation to rows would turn each resize into a simultaneous FLIP-reflow storm across all visible cards. This reinforces the "no layout animation on rows" rule; the responsive sizing fix itself is kirei-ui's.
