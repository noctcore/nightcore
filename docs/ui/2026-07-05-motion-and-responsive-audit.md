# UI/UX Audit — Motion Layer + Responsive Squish Bugs

**Date:** 2026-07-05
**Agent:** kirei-ui (kirei-chain, alongside kirei-perf + kirei-arch)
**Stack:** React 19 · Tailwind CSS v4 (`@tailwindcss/vite`) · lucide-react · Vite · Tauri WKWebView
**Scope:** (1) design-system read + missing motion tokens, (2) responsive "shrinking control" bug class, (3) animation opportunity map for `motion/react`, (4) prefers-reduced-motion strategy, (5) phased plan. RESEARCH ONLY — no code changed.

## Summary
The design system is a single, well-structured token file (`apps/web/src/styles.css`, 463 lines): a full oklch color set bound into Tailwind v4 `@theme`, one radius token, two font families, and a set of CSS `@keyframes` used ad-hoc. Component hygiene is strong — 117 uses of the shared `<Button>` vs only 3 hand-rolled bg-primary buttons — and the shared primitives (RunLifecycleShell, RunProgress, Toast, Modal) already practice `min-w-0`/`shrink-0` discipline. Two systemic gaps: **(A) there are no motion/duration/easing tokens** — every animation hardcodes `cubic-bezier(.22,1,.36,1)` and a scattered set of durations inline; and **(B) the atomic controls (`Button`, `IconButton`, `Segmented`, `Pill`) lack `shrink-0`/`whitespace-nowrap`, and the Board header toolbar is a hand-rolled, unwrapped flex row — this is the exact cause of the reported "buttons squish when the window isn't maximized."** For animation, the biggest quality lever is **exit choreography**: every overlay (Modal, Toast, Menu, drawer, splash) animates on enter but hard-cuts on unmount. `motion/react` + `AnimatePresence` closes that gap, and `<MotionConfig reducedMotion="user">` is required because the existing CSS reduced-motion guard cannot neutralize JS-driven motion.

---

## 1. Design-System Read

### Tokens that exist today (`apps/web/src/styles.css`)
- **Color** (`:root` lines 63–97 → Tailwind `@theme` 102–133): background/foreground/card/popover/primary (`oklch(78% .22 290)`)/secondary/muted/accent/border/input/ring/sidebar, plus semantic status `--nc-destructive/--nc-success/--nc-warning/--nc-info` (88–92) and glow tokens `--nc-glow-1/2` (84–85). All exposed as utilities (`bg-primary`, `text-muted-foreground`, `border-border`, …).
- **Radius:** one token `--nc-radius: 0.625rem` → `--radius-nc` (94, 132). Note: components mostly bypass it with ad-hoc `rounded-[9px]`, `rounded-[14px]`, `rounded-[13px]`, `rounded-lg` — a minor consistency drift, not the focus here.
- **Type:** `--font-sans` (DM Sans), `--font-mono` (JetBrains Mono) (129–130), self-hosted variable fonts.
- **Spacing:** no custom scale — relies on Tailwind v4's default 4px/`0.25rem` grid. Usage is mostly on-grid with frequent arbitrary values (`px-[22px]`, `py-[18px]`, `gap-2.5`); acceptable.
- **Motion (today):** CSS `@keyframes` only — `nc-pulse`, `nc-spin`, `nc-bar`, `nc-rise`, `nc-slide`, `nc-sheet-in`, `nc-glow`, `nc-skeleton` (193–264); helper classes `.nc-drawer-enter` (266), `.nc-skeleton` (272); reduced-motion media query (275–284).

### Missing motion tokens (add these)
There is **no duration or easing token**. The signature entrance curve `cubic-bezier(.22,1,.36,1)` (= easeOutQuint) is copy-pasted inline in Splash, Modal, Toast, Menu, Sidebar, and durations are scattered (`.14s`, `.18s`, `.22s`, `.26s`, `.5s`, `150ms`, `.7s`, `1.15s`, `1.3s`, `1.4s`, `4s`). Add to `:root` + `@theme`:

```css
/* Easing */
--ease-out-quint:  cubic-bezier(0.22, 1, 0.36, 1);   /* app signature entrance */
--ease-out-quart:  cubic-bezier(0.25, 1, 0.5, 1);    /* softer entrance */
--ease-standard:   cubic-bezier(0.4, 0, 0.2, 1);     /* hover/color micro-interactions */
--ease-in-out-quart: cubic-bezier(0.76, 0, 0.24, 1); /* symmetric cross-fades */

/* Duration */
--dur-instant: 80ms;   /* press feedback */
--dur-fast:    140ms;  /* popovers, menus, toasts-in  (was .14s/.18s) */
--dur-base:    220ms;  /* modals, drawers            (was .22s/.26s) */
--dur-slow:    320ms;  /* view/route + splash cross-fade */
--dur-slower:  480ms;  /* progress-bar sweeps */
```
Because `motion/react` needs JS values (numbers + arrays), mirror the same constants once in a TS module (`apps/web/src/lib/motion.ts`) so CSS keyframes and JS motion never drift:
```ts
export const EASE = { outQuint: [0.22, 1, 0.36, 1], standard: [0.4, 0, 0.2, 1] } as const;
export const DUR  = { instant: 0.08, fast: 0.14, base: 0.22, slow: 0.32, slower: 0.48 } as const;
// + shared variants: fadeRise, drawerSlide, popover, toastSlide
```
(Home for this file is an **arch decision** — see handoff. Note: kirei-arch recommends `ui/motion/tokens.ts` inside the `ui/` module rather than `lib/motion.ts`, because `lib/**` is the framework-neutral leaf and should not import a rendering lib. This is a resolved conflict — see combined doc.)

---

## 2. Responsive / Layout Bug Audit — the "shrinking control" class

**Root cause pattern:** flex items default to `flex-shrink: 1` + `min-width: auto`, so any control in a flex row with more content than space *squishes its text/geometry instead of wrapping or scrolling*. The atomic controls don't defend against this, and the Board header is a hand-rolled unguarded row.

### Worst offender — Board header toolbar (the reported bug)
`apps/web/src/components/board/Board/Board.tsx:126` — `ml-auto flex items-center gap-2.5`. **Verified: no `flex-wrap`, no `shrink-0`, no `whitespace-nowrap` anywhere in lines 126–202.** Children that squish when the window is narrower than full-screen:
- concurrency box `:127` (holds `input[type=range]` fixed `w-[84px]` `:139`) — no `shrink-0`
- Auto Mode button `:143` (text "Auto Mode" + toggle pill)
- `AutoModeOptions` `:171`
- background icon button `:175`
- Provider button `:184` (text "Provider")
- New task button `:193` (text + `<Kbd>`)

The outer wrapper `:106` is `flex flex-wrap` — but wrapping the *toolbar as one block* doesn't help, because the toolbar's own children still shrink inside it. **Fix:** add `flex-wrap` to the toolbar and `shrink-0` to each control; give the range box `shrink-0`. Better: rebuild the toolbar from `<Button>` primitives + a shared Toolbar convention (below). This header is also the one place that bypasses the `<Button>` primitive with fully inline styles — a consistency debt.

### Systemic — atomic controls miss shrink guards
- **`ui/Button.tsx:34`** — class string has no `shrink-0`, no `whitespace-nowrap`. Every one of the 117 `<Button>` usages can squish in a tight flex row. **Highest-leverage single fix.**
- **`ui/IconButton.tsx:21`** — no `shrink-0`; icon buttons compress in dense rows.
- **`ui/Segmented.tsx:18` (group) + `:26` (segments)** — no `shrink-0`; segment labels squish.
- **`ui/Pill.tsx:7`** — no `shrink-0`, no `whitespace-nowrap`; path/version pills squish and wrap.

### Other confirmed offenders
- **ProjectsView grid** `projects/ProjectsView/ProjectsView.tsx:50` — `grid-cols-[repeat(auto-fill,minmax(320px,1fr))]`: the fixed 320px track **overflows the container below ~380px window width**. Fix: `minmax(min(320px,100%),1fr)`.
- **ProjectsView header** `:29` `flex items-center gap-3.5` (no wrap) + `<Button className="ml-auto">` `:36` — fixed once Button gets `shrink-0`.
- **Board breaker banner** `board/Board/Board.tsx:227` — `flex items-center gap-3`; Resume `:232` (`ml-auto`) and dismiss `:240` lack `shrink-0`, message span lacks `min-w-0`; the message can shove the buttons. Add `min-w-0` to message, `shrink-0` to actions.
- **TaskDetail drawer** `board/TaskDetail/TaskDetail.tsx:185` — fixed `w-[28rem] shrink-0`. With sidebar (244px) + drawer (448px) = 692px, the board content compresses toward zero on narrow windows. Consider `w-[min(28rem,60vw)]` or a max cap. (Not a squish-of-text bug, but the same "no room" family.)
- **TaskCard delete icon button** `board/TaskCard/TaskCard.tsx:397` — no `shrink-0`; low risk (fixed-width card, siblings are `flex-1`) but add for safety.
- **ProviderConfigPanel** header buttons hand-rolled (`board/ProviderConfigPanel/ProviderConfigPanel.tsx:336`) — no `shrink-0`.

### Things that are already correct (don't touch)
- Board columns are fixed-width + `shrink-0` and scroll horizontally (`Column.tsx:56,59`; `Board.tsx:252` `overflow-x-auto`). Good.
- AppShell main region uses `min-w-0 flex-1` correctly (`AppShell.tsx:188,192,193`).
- RunLifecycleShell header (`min-w-0` title + `shrink-0` actions, `:40,46`) and RunProgress rows (`shrink-0`/`truncate`/`min-w-0`, throughout) are model responsive citizens.
- Toast row already uses `min-w-0 flex-1` + `shrink-0` icons (`Toast.tsx:30,31,52`).

### Systemic fix (prescription)
1. Bake `shrink-0 whitespace-nowrap` into `Button`, `IconButton`, `Segmented`, `Pill` — these are atomic controls that should *never* squish.
2. Add a `ui/Toolbar` primitive (folder-per-component) encoding the safe convention: `flex flex-wrap items-center gap-2`, every direct child `shrink-0`, and the one flexible element (e.g. search) explicitly `min-w-0 flex-1`. Rebuild the Board header on `<Button>` + `<Toolbar>`.
3. Replace `minmax(320px,1fr)` with `minmax(min(320px,100%),1fr)`.
4. Cap the drawer width and add `min-w-0`/`shrink-0` to the breaker banner.

---

## 3. Animation Opportunity Map (motion/react)

Perf rule for every item: **animate `transform` + `opacity` only**; anything animating width/height/box-shadow is flagged for kirei-perf.

### P0 — Exit choreography (the current gap; highest polish-per-effort)
| Surface | File | Animation | Primitive | Safe property |
|---|---|---|---|---|
| **Modal + every dialog** (ConfirmDialog, NewTaskForm, NewProjectDialog, CreatePRDialog, McpServers modal…) | `ui/Modal/Modal.tsx:58` | backdrop opacity + panel scale/`y` enter **and exit** (enter-only today via `nc-rise`) | `AnimatePresence` + `motion.div` | transform + opacity |
| **TaskDetail drawer** | `board/TaskDetail/TaskDetail.tsx:185` + mount in `AppShell.tsx:257` | slide `translateX(100%→0)` + fade, **exit reverses** (today `nc-drawer-enter`, instant unmount) | `AnimatePresence` (in AppShell) | transform + opacity (never width) |
| **Toast** | `ui/Toast/Toast.tsx:44` | slide-in-right + fade; **exit** slide-out; remaining toasts settle up | `AnimatePresence` + `layout` | transform + opacity |
| **Menu + Sidebar switcher popover** | `ui/Menu.tsx:108`, `app/Sidebar/Sidebar.tsx:99` | scale+opacity from trigger origin, exit reverses | `AnimatePresence` | transform + opacity |

Modal is a shared primitive, so one `AnimatePresence` conversion fans out to every dialog. **Arch caveat:** dialogs are mounted as `{cond && <Modal/>}` at call sites; for `AnimatePresence` to see the exit, Modal likely needs an `open` prop (presence owned by Modal) rather than conditional mount — an API change touching every call site (arch handoff).

### P1 — Delight / high visibility
- **Splash entrance + exit** `app/Splash/Splash.tsx` + `AppShell.tsx:119` — stagger brand→wordmark→loader via `variants`/`staggerChildren`, and **cross-fade the splash→board handoff** (today it's a hard cut at 119–121). Single most "alive" upgrade. Property: opacity + scale.
- **Route/view transitions** `AppShell.tsx:191–347` — each `view===X` block swaps instantly; wrap the `<main>` view region in `AnimatePresence` keyed on `view` for an 8px-`y` + opacity cross-fade. Keep Suspense fallbacks instant; coordinate with lazy chunks (arch). RunLifecycleShell already cross-fades *phases* (`usePhaseFade`) — same intent, one level up.
- **Button/action press+hover** `ui/Button.tsx`, `board/TaskCard/TaskCard.tsx` action buttons — `whileTap={{scale:0.97}}`, subtle `whileHover={{y:-1}}`. Today only `active:translate-y-px`. Transform only, high tactile payoff.

### P2 — Board (must not fight virtualization/dnd — perf boundary)
- **Card drag pickup/drop** — @dnd-kit already drives drag transforms. **Do NOT put `layout`/`motion` on the virtualized rows** (`Column.tsx:94–105` positions rows with `transform: translateY`; virtualizer mounts/unmounts on scroll → any layout/stagger replays on scroll and fights dnd-kit). Animate **only the `<DragOverlay>` card** (scale-up + shadow lift on pickup). List-stagger inside virtualized columns is explicitly unsafe.
- **Status transition glow** `TaskCard.tsx:33–48` — running→verifying→done border/glow currently swaps via `transition-[border-color,box-shadow,background]` (`:28`). Box-shadow animation is a perf smell; a brief transform/opacity pulse on status change is nicer — flag the box-shadow approach to perf.

### P3 — Progress reveal
- **RunProgress** `ui/RunProgress/RunProgress.tsx` — stagger category-row entrance (`AnimatePresence` + `staggerChildren`), pop the per-row "done" check (scale). The overall bar animates `transition-[width]` (`:88`) — a **layout property**; prefer `scaleX` transform (perf handoff).

### Micro-interactions
- **Segmented active pill** `ui/Segmented.tsx` — `layoutId` shared-layout so the highlight *slides* between segments instead of hard-cutting. Transform only. Classic delight.
- **Keep as CSS (do not migrate to JS):** `StatusDot` pulse (`StatusDot.tsx:19`), `Spinner` (`Spinner.tsx:18`), `Skeleton` shimmer — CSS keyframes are cheaper than rAF/WAAPI for infinite loops.

---

## 4. Accessibility — prefers-reduced-motion strategy

- **Today:** global CSS media query (`styles.css:275–284`) zeroes CSS `animation`/`transition` durations. This is a solid baseline **but it cannot neutralize `motion/react`** animations — those animate inline `transform`/`opacity` via WAAPI/rAF, not CSS transitions.
- **Add:** `<MotionConfig reducedMotion="user">` at the app root (`App.tsx`, wrapping `AppShell`). `"user"` auto-disables transform/layout animations and keeps only opacity for users with the OS setting — the recommended default. Use `useReducedMotion()` where bespoke logic must swap a slide/scale for a plain fade or skip a stagger.
- **Keep both layers:** do NOT delete the CSS media query — it still governs the remaining CSS-keyframe animations (StatusDot/Spinner/Skeleton/nc-bar shimmers). CSS query = CSS keyframes; MotionConfig = JS motion. They are complementary.
- **Tauri/WKWebView:** `prefers-reduced-motion` maps to macOS System Settings → Accessibility → Display → **Reduce Motion**; WKWebView honors it. No CDP needed — test by toggling the OS setting, or add a dev-only `reducedMotion="always"` toggle. (`bun run dogfood:ui` drives the mock web at :5173 for visual checks.)
- **Focus & exit:** the focus-visible ring (`styles.css:153`) must never be animated away. Because `AnimatePresence` keeps nodes mounted during exit, ensure Modal's focus-restore (`Modal.hooks`) returns focus on **exit-start**, not exit-end, so keyboard users aren't stranded on an exiting dialog (interaction detail — verify during impl).

---

## 5. Phased Implementation Outline (respects folder-per-component + no-cross-feature-imports)

**Phase 0 — Tokens & foundation (no visual change).** Add motion tokens to `styles.css` (`:root` + `@theme`); add the TS mirror (EASE, DUR, shared variants); install `motion`; mount `<MotionConfig reducedMotion="user">` in `App.tsx`.

**Phase 1 — Responsive fix (ship first; no motion dep).** `shrink-0 whitespace-nowrap` into Button/IconButton/Segmented/Pill; add `ui/Toolbar` primitive; rebuild Board header on `<Button>` + `<Toolbar>`; fix ProjectsView grid track; cap drawer width; fix breaker banner. Pure Tailwind — validate with `bun run lint` + Storybook a11y.

**Phase 2 — Shared `ui/` motion primitives (one change fans out).** Modal→`AnimatePresence` (drives every dialog); Toast→`AnimatePresence`+`layout`; Menu→`AnimatePresence`; Segmented→`layoutId` highlight; Button/IconButton→`whileHover`/`whileTap`. Each stays in its own `ui/` folder and imports from the shared motion module.

**Phase 3 — Per-feature surfaces.** Splash exit cross-fade + route `AnimatePresence` in `app/`; TaskDetail drawer presence (lives in AppShell); DragOverlay pickup animation only in `board/`; RunProgress row stagger in `ui/`.

**Phase 4 — polish & a11y verification.** Reduced-motion pass, focus-on-exit check, Storybook stories per animated state, screenshot baselines, `bun run lint` + typecheck + tests.

## Recommended Fix Order
1. **A11y/robustness first:** `MotionConfig` wiring + keep CSS reduced-motion guard.
2. **Responsive squish (Phase 1)** — fixes the user's reported bug with zero motion risk; can ship independently.
3. **Motion tokens (Phase 0)** — unblocks everything else.
4. **Shared `ui/` exit choreography (Phase 2)** — biggest polish-per-effort.
5. **Feature surfaces (Phase 3)** — splash/route/drawer/drag.
6. **Polish (Phase 4).**
