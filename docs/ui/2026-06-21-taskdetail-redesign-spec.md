# TaskDetail Redesign — Build Spec

**Date:** 2026-06-21
**Agent:** kirei-ui
**Stack:** React 19 (Tauri webview), Tailwind v4 `@theme` tokens, cosmic-dark DS (`apps/web/src/styles.css`)
**Scope:** `apps/web/src/components/board/TaskDetail/*` + the `SessionStream` data model in `apps/web/src/components/board/session-stream.ts` and its consumers.

> Direction is locked. This spec makes the two decided changes precise and buildable: **(A)** a unified chronological **activity timeline** replacing the split Tools + Transcript sections, and **(B)** a collapsible **Session card** that demotes metadata so content leads. Every class/token below is exact and matches existing siblings — hand straight to an implementation agent.

---

## 1. Final section order (top → bottom of the scroll body)

The scroll body is `div.flex.flex-1.flex-col.gap-4.overflow-auto.px-4.py-4` (TaskDetail.tsx:167). New order, content-first:

1. **Permission prompts** — unchanged (TaskDetail.tsx:168-180). Always first; they are blocking and time-sensitive.
2. **Proposed plan** — unchanged (TaskDetail.tsx:292-301). Conditional on `planParked && task.plan`. Stays high because it gates the footer Approve/Refine/Reject actions.
3. **ReviewPanel** — unchanged (TaskDetail.tsx:303-308). Reviewer verdict gates footer actions.
4. **GauntletResults** — unchanged (TaskDetail.tsx:310-316). Conditional on `isVerifiedColumn`.
5. **Description** — moved UP (was TaskDetail.tsx:318-327). The task's intent should sit directly above its activity. Unchanged markup.
6. **Activity timeline** (§3) — the merged Tools + Transcript. Has `flex-1` so it owns the remaining height and scroll.
7. **Session card** (§2) — collapsed by default, sits at the BOTTOM of the body. Rationale: post-run it is read-only reference data; pre-run the user sets it once in NewTaskForm and rarely re-edits. Placing it last (not first) is the core of decision B — content leads, config trails.

Rationale for plan/review/gauntlet staying above content: they are **action gates** wired to the footer, not reference metadata. Only the five flat "Kind / Run mode / Permission / Model & effort / Limits" sections (TaskDetail.tsx:182-290) collapse into the Session card.

---

## 2. Decision B — the collapsible **Session** card

### 2.1 Anatomy

A single bordered card replacing the five stacked `<section>`s (TaskDetail.tsx:182-290). Two states: **collapsed** (default) shows a one-line summary; **expanded** reveals the existing pickers (editable) or read-only pills (post-run), reusing them verbatim.

```
┌─ collapsed ───────────────────────────────────────────────┐
│ ⚙  Build · Worktree · Bypass · Opus 4.8·high · ∞ turns  ⌄ │   ← summary line, button
└────────────────────────────────────────────────────────────┘

┌─ expanded ────────────────────────────────────────────────┐
│ ⚙  Session                                              ⌃ │   ← header row
│ ──────────────────────────────────────────────────────── │
│  Kind            [KindPicker compact]                      │
│  Run mode        [WorkModePicker]                          │
│  Permission      [PermissionModePicker]                    │
│  Model & effort  [ModelEffortPicker]                       │
│  Limits          [LimitField][LimitField]                  │
└────────────────────────────────────────────────────────────┘
```

### 2.2 Container

```tsx
<section className="rounded-[10px] border border-border bg-white/[0.02]">
```

`bg-white/[0.02]` matches the unselected picker card surface (WorkModePicker.tsx) so the Session card reads as a config container, distinct from the `bg-card` header/footer and `bg-popover` drawer.

### 2.3 Collapsed summary line (the trigger button)

The whole collapsed row IS the toggle button — full-width, keyboard-focusable.

```tsx
<button
  type="button"
  aria-expanded={open}
  aria-controls="session-card-body"
  onClick={() => setOpen((v) => !v)}
  className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2.5 text-left transition-colors hover:bg-white/[0.03] focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
>
  <BoltIcon size={13} className="shrink-0 text-muted-foreground" />
  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
    {summary}
  </span>
  <ChevronDownIcon
    size={14}
    className={`shrink-0 text-muted-foreground transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
  />
</button>
```

- `BoltIcon` (lucide `Zap`, already aliased in icons.tsx:30) signals "run configuration". When expanded, the same row keeps the icon but swaps the summary text for the literal label `Session` (font-mono, same classes) so the expanded header reads as a titled card.
- The chevron is the single collapse affordance. It rotates 180° on expand — no separate caret/plus.

**Summary format** — built by a pure helper `summarizeSession(task)` (new, in `TaskDetail.hooks.ts`), middot-joined, reusing existing label maps from `../status`:

```
{KIND_LABEL[kind]} · {RUN_MODE_LABEL[runMode]} · {permissionLabel} · {modelEffort} · {limits}
```

| Segment | Source | Inherit / empty rendering |
|---|---|---|
| kind | `KIND_LABEL[task.kind]` | always present |
| run mode | `RUN_MODE_LABEL[task.runMode]` | always present |
| permission | `task.permissionMode ? PERMISSION_MODE_LABEL[…] : 'Inherit'` | `Inherit` |
| model·effort | `modelDisplayName(task.model)` + (`task.effort ? '·'+effort : ''`) | model helper never returns null; omit effort when null |
| limits | `task.maxTurns ?? '∞'` + ` turns` | `∞ turns` when null; budget appended only when set: ` · $5` |

Drop the budget segment entirely when `maxBudgetUsd === null` to keep the line short (it's the least-changed field). The summary is informational only; the full editable/read-only detail lives in the expanded body, so truncation via `truncate` (the row already `truncate`s) is acceptable.

### 2.4 Expanded body

```tsx
<div id="session-card-body" hidden={!open}>
  {open && (
    <div className="grid gap-3 border-t border-border px-3 pb-3 pt-3">
      {/* one labeled row per control */}
    </div>
  )}
</div>
```

Each control row keeps the existing `<h3>` label styling so nothing visually regresses:

```tsx
<div className="grid grid-cols-[5.5rem_1fr] items-start gap-x-3 gap-y-1">
  <h3 className="pt-1 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">Kind</h3>
  <div>{/* picker OR read-only pill — IDENTICAL to current branches */}</div>
</div>
```

> The two-column `[5.5rem_1fr]` grid is the one new layout choice — it tightens the five formerly-stacked sections into a compact form. If the implementer prefers minimal diff, the existing stacked `<section>` markup (label above control) may be moved verbatim into the body with `className="space-y-3"`; both are acceptable. The grid is preferred for density.

**Reuse, do not duplicate.** The expanded body renders the EXACT conditional from TaskDetail.tsx:186-289 — `kindEditable && onChangeX ? <Picker/> : <pill/>` — for all five controls. No picker is re-implemented. `LimitField` (TaskDetail.tsx:37-92) stays in the same file, unchanged. The only change is wrapping these five blocks in the card's grid rows instead of top-level `<section>`s.

### 2.5 Default-open exception

Collapsed by default. Open automatically when `kindEditable` is true AND the task has never run, so a fresh `backlog`/`ready` task surfaces its editable config without a click:

```ts
const [open, setOpen] = useState(kindEditable);
```

Post-run (`!kindEditable`) it starts collapsed — read-only pills stay out of the way. The default is computed once at mount via `useState`'s initializer (not synced) so toggling is never fought by re-renders.

### 2.6 Motion

Reuse the existing `nc-rise` keyframe (styles.css:196-205) on the body — the same entrance Menu.tsx:100 uses, so it matches the app's disclosure vocabulary:

```tsx
<div id="session-card-body" hidden={!open}
     style={open ? { animation: 'nc-rise .16s cubic-bezier(.22,1,.36,1)' } : undefined}>
```

Plus the 200ms chevron `rotate-180` (CSS transform transition, GPU-cheap). Do **not** animate `height: auto` (jank/measure cost); the `nc-rise` translateY+fade is the established pattern and degrades gracefully under `prefers-reduced-motion` if a media query is later added. No new keyframe needed.

### 2.7 New primitive? — **No.**

A generic `<Collapsible>` is **not warranted** here. There is exactly one disclosure surface in this redesign; the summary-line composition (icon + middot summary + read-only/editable body) is bespoke to the Session card and would push most logic into props anyway. Build it **inline** in `TaskDetail.tsx` as a local `SessionCard` sub-component (sibling to `LimitField`), receiving `task`, `kindEditable`, and the `onChange*` handlers. If a second collapsible appears later (e.g. a collapsible raw-log view), extract then. Inline now, YAGNI on the abstraction.

---

## 3. Decision A — the unified **activity timeline**

Replaces both the Tools section (TaskDetail.tsx:329-351) and the Transcript section (TaskDetail.tsx:353-373) with one chronologically-interleaved list.

### 3.1 Data-model change — `session-stream.ts`

The blob `answer: string` + parallel `tools: ToolLine[]` becomes a single ordered `entries` array. Replace the types:

```ts
export interface TextEntry {
  kind: 'text';
  /** Accumulated assistant markdown for one contiguous speaking turn. */
  markdown: string;
}

export interface ToolEntry {
  kind: 'tool';
  id: number;
  toolName: string;
  input?: Record<string, unknown>;
}

export type TimelineEntry = TextEntry | ToolEntry;

export interface SessionStream {
  entries: TimelineEntry[];
  costUsd: number | null;
  error: string | null;
  /** Whether the active turn streamed partial deltas, so the final
   *  whole-message block (partial: false) can be suppressed. */
  streamedPartial: boolean;
  toolSeq: number;
}

export const EMPTY_STREAM: SessionStream = {
  entries: [],
  costUsd: null,
  error: null,
  streamedPartial: false,
  toolSeq: 0,
};
```

Keep `ToolLine` exported as a deprecated alias for one release if any test imports it; otherwise delete. `streamedPartial` and `toolSeq` are retained — same dedup/sequence roles.

### 3.2 Fold rules — `foldSession`

The open/close discipline: deltas append to a **trailing open text entry**; a tool-use **closes** the open text entry (so the next delta starts a fresh one) and pushes a tool entry. This reconstructs arrival order, and because `read_transcript` replays events in order (AppShell.hooks.ts:342 `events.reduce(foldSession, …)`), the reseed path rebuilds the identical timeline with **zero changes to the reseed call site**.

```ts
/** Append assistant text to the trailing open text entry, creating one if the
 *  last entry is a tool (or the list is empty). */
function appendText(entries: TimelineEntry[], text: string): TimelineEntry[] {
  const last = entries[entries.length - 1];
  if (last !== undefined && last.kind === 'text') {
    const updated: TextEntry = { kind: 'text', markdown: last.markdown + text };
    return [...entries.slice(0, -1), updated];
  }
  return [...entries, { kind: 'text', markdown: text }];
}

export function foldSession(prev: SessionStream, event: NcEvent): SessionStream {
  switch (event.type) {
    case 'session-started':
    case 'session-ready':
      return { ...EMPTY_STREAM };

    case 'assistant-delta': {
      if (event.partial) {
        return {
          ...prev,
          streamedPartial: true,
          entries: appendText(prev.entries, event.text),
        };
      }
      // Whole-message block: suppress when partials already streamed this turn
      // (the trailing open text entry already holds the full text).
      if (prev.streamedPartial) return prev;
      return { ...prev, entries: appendText(prev.entries, event.text) };
    }

    case 'tool-use-requested': {
      const nextSeq = prev.toolSeq + 1;
      // A tool use CLOSES the current text turn: the next delta opens a fresh
      // text entry. We push the tool; appendText handles the reopen implicitly.
      return {
        ...prev,
        streamedPartial: false,
        toolSeq: nextSeq,
        entries: [
          ...prev.entries,
          { kind: 'tool', id: nextSeq, toolName: event.toolName, input: event.input },
        ],
      };
    }

    case 'session-completed':
      return { ...prev, costUsd: event.costUsd };
    case 'session-failed':
      return { ...prev, error: `${event.reason}: ${event.message}` };
    default:
      return prev;
  }
}
```

Key invariants, preserved from the current fold:
- **Partial dedup unchanged.** `streamedPartial` flips true on the first partial delta and false on each tool-use; a `partial: false` whole-message block is dropped while `streamedPartial` holds. Identical to lines 41-51 today, just writing into `entries` instead of `answer`.
- **Text segmentation = tool boundaries.** Two assistant turns separated by a tool call land in two distinct `TextEntry`s → they render as visually separated markdown blocks (the run-on problem). Within one turn, consecutive partials concatenate into one entry (correct — markdown must stay contiguous to parse).
- **Reseed correctness.** `read_transcript` replays the same event order; `reduce(foldSession, …)` rebuilds the same `entries`. No transcript-format change. `tool-result` / `permission-required` / `session-status` remain in `default` (dropped) exactly as today.

### 3.3 View-model — `TaskDetail.hooks.ts`

`deriveTaskDetailView` (TaskDetail.hooks.ts:26-44) changes its `answer`/`tools` outputs to a single `entries`. The persisted-fallback for a closed task that has a `task.summary` but no live stream must still render: wrap the summary as a single synthetic text entry.

```ts
export interface TaskDetailView {
  isRunning: boolean;
  isVerifying: boolean;
  cost: number | null;
  error: string | null;
  entries: TimelineEntry[];
  reviewParked: boolean;
  planParked: boolean;
  kindEditable: boolean;
  isVerifiedColumn: boolean;
}

// inside deriveTaskDetailView:
const fallbackEntries: TimelineEntry[] =
  task.summary !== null && task.summary.trim().length > 0
    ? [{ kind: 'text', markdown: task.summary }]
    : [];
return {
  // …unchanged fields…
  entries: stream?.entries ?? fallbackEntries,
  // remove `answer` and `tools`
};
```

This preserves the current behavior at TaskDetail.hooks.ts:37 (`stream?.answer ?? task.summary ?? ''`): a `done`/`failed` task reopened with no live stream shows its stored summary as the single timeline text block.

### 3.4 Render treatment — the timeline section

Replace TaskDetail.tsx:329-373 (both sections) with one. Build a local `Timeline` sub-component (sibling to `SessionCard`).

```tsx
<section aria-label="Activity" className="flex-1">
  <h3 className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
    <LogsIcon size={11} />
    {isRunning ? 'Live activity' : 'Activity'}
  </h3>

  {error !== null ? (
    /* error state — unchanged styling */
    <pre className="whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/[0.12] px-3 py-2 font-mono text-xs text-destructive">
      {error}
    </pre>
  ) : entries.length > 0 ? (
    <ol className="space-y-2.5">
      {entries.map((entry, i) =>
        entry.kind === 'text' ? (
          <li key={`t${i}`} className="text-foreground">
            <Markdown>{entry.markdown}</Markdown>
            {isRunning && i === entries.length - 1 && (
              <span className="ml-0.5 inline-block w-[2px] animate-[nc-pulse_1s_ease-in-out_infinite] align-text-bottom text-primary">▌</span>
            )}
          </li>
        ) : (
          <li
            key={`x${entry.id}`}
            className="flex items-start gap-1.5 rounded-md border border-border bg-white/[0.02] px-2 py-1 font-mono text-xs text-primary/80"
          >
            <TerminalIcon size={12} className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">
              <span className="font-semibold">{entry.toolName}</span>
              {entry.input !== undefined && (
                <span className="text-muted-foreground"> · {summarizeInput(entry.input)}</span>
              )}
            </span>
          </li>
        ),
      )}
    </ol>
  ) : (
    <p className="text-sm text-muted-foreground">
      {isRunning
        ? 'Waiting for first token…'
        : 'No activity yet — run this task to stream its transcript.'}
    </p>
  )}
</section>
```

Per-entry render contract:

| Entry | Element | Treatment |
|---|---|---|
| **text** | `<li>` → `<Markdown>` | Full prose via the existing `.nc-markdown` scope. Each text entry is its own `<li>` with `space-y-2.5` between siblings → **distinct turns are visually separated** (fixes the run-on). No extra border — markdown reads as the panel's primary content. |
| **tool** | `<li>` boxed line | `icon + bold toolName + · summarizeInput(input)`. Now boxed (`border-border bg-white/[0.02]`) so a tool call is visually a discrete "step" inline between prose, not a wall-of-text line. Reuses `summarizeInput` (summarize.ts:15) verbatim. |

State handling:
- **Live cursor**: the `▌` renders only on the LAST entry when `isRunning`, and only if it's a text entry (a trailing tool entry means the model is mid-tool — no cursor; the running header label `Live activity` + the card's pulsing status dot already signal activity). Use `nc-pulse` (styles.css:172-182) so it breathes instead of a static glyph.
- **Error**: unchanged destructive `<pre>` (TaskDetail.tsx:357-360). Errors replace the timeline (terminal failure).
- **Empty / waiting**: unchanged copy and styling (TaskDetail.tsx:366-372), now the single empty branch for the merged section.

Cost stays in the header (TaskDetail.tsx:152-156) — untouched. The section is `flex-1` so it absorbs remaining drawer height and scrolls within the existing `overflow-auto` body.

---

## 4. Spacing / typography / hierarchy (cosmic-dark tokens)

- **Body rhythm**: keep the body's `gap-4` (1rem) between top-level sections; the timeline uses `space-y-2.5` (0.625rem) between entries — tighter than section gap so a run reads as one stream, looser than the old `space-y-1` so turns breathe.
- **Labels**: every section heading keeps `font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground` (the established `<h3>` token). The Session summary line uses `text-[11px]` mono to match the header's cost/status meta scale.
- **Surfaces**: `bg-popover` drawer → `bg-card` header/footer → `bg-white/[0.02]` Session card and tool lines → `bg-white/[0.04]` read-only pills (unchanged). This three-step elevation keeps config visually subordinate to prose (`text-foreground`).
- **Borders/radius**: `border-border` (the `oklch(100% 0 0 / 0.07)` token) and `rounded-[10px]` for the card (matches Menu/picker cards), `rounded-md` for tool lines and pills (matches current).
- **Color discipline**: tool lines `text-primary/80`, tool args `text-muted-foreground`, prose `text-foreground/90` (via `.nc-markdown`), cursor `text-primary`, errors `text-destructive`. No new colors; all are existing tokens.

Visual hierarchy after the change, top to bottom of attention: **assistant prose** (largest, `text-foreground`) > **action gates** (plan/review/gauntlet, colored borders) > **tool steps** (mono, dimmed, boxed) > **Session config** (collapsed, mono, muted). Content out-weighs config — the decision-B goal.

---

## 5. Accessibility

- **Session toggle**: `<button type="button">` with `aria-expanded={open}` and `aria-controls="session-card-body"`; body has matching `id` and is `hidden` when closed (removes it from the a11y tree and tab order, not just visually). Chevron is decorative (no label needed — the summary text is the accessible name). Focus ring via `focus-visible:ring-1 focus-visible:ring-ring` (the `--nc-ring` primary token) — consistent with focusable controls.
- **Timeline semantics**: render as an `<ol>` (ordered — chronology is meaningful) with `aria-label="Activity"` on the section. Each entry is an `<li>`. Tool lines are non-interactive text (no click handlers) → no role needed; the icon is decorative. Assistant markdown keeps its sanitized `.nc-markdown` container.
- **Live region**: the running timeline should announce new content for screen readers without spamming. Add `aria-live="polite"` + `aria-atomic="false"` to the `<ol>` ONLY while `isRunning` (toggle the attribute), so completed transcripts aren't re-announced on open. The cursor `▌` must be `aria-hidden="true"` (decorative).
- **Focus**: opening the Session card does not steal focus (it's user-initiated; focus stays on the toggle). No focus trap needed (non-modal). The drawer's existing close button and footer actions keep their order; moving the Session card to the bottom does not change footer focus.
- **Reduced motion**: `nc-rise` and the chevron rotate are sub-200ms and translate/fade only. Acceptable as-is; if the project later adds a global `prefers-reduced-motion` guard, both honor it via a single `@media` block in styles.css (out of scope here).

---

## 6. Blast radius — `SessionStream.answer` / `.tools` removal

Grep-confirmed consumers of the fields being replaced:

| File:line | Use today | Required change |
|---|---|---|
| `apps/web/src/components/board/session-stream.ts` | defines `answer`/`tools`/`ToolLine` | **Rewrite** per §3.1–§3.2 → `entries: TimelineEntry[]`. |
| `apps/web/src/components/board/TaskDetail/TaskDetail.hooks.ts:37-38` | `answer: stream?.answer ?? …`, `tools: stream?.tools ?? []` | **Rewrite** per §3.3 → single `entries` with summary fallback. |
| `apps/web/src/components/board/TaskDetail/TaskDetail.tsx:329-373` | renders `tools` + `answer` in two sections | **Rewrite** per §3.4 → one timeline. |
| `apps/web/src/components/app/AppShell/AppShell.hooks.ts:606-612` | `logCounts[id] = stream.tools.length` | **Change** to count tool entries: `counts[id] = stream.entries.filter((e) => e.kind === 'tool').length;`. This keeps the TaskCard "Logs" badge (TaskCard.tsx:258, fed via Board→Column `logCounts`) showing tool-call count, unchanged semantics. |
| `apps/web/src/components/app/AppShell/AppShell.hooks.ts:323,342,631` | `foldSession` / `EMPTY_STREAM` call sites | **No change** — signatures preserved; reseed `reduce(foldSession, …)` still correct (§3.2). |
| `apps/web/src/components/board/index.ts:46-48` | re-exports `EMPTY_STREAM`/`foldSession`/`SessionStream` | **No change** — same exports. Add `TimelineEntry` export if consumed elsewhere. |
| `apps/web/src/components/board/TaskDetail/TaskDetail.stories.tsx:65,184` | spreads `...EMPTY_STREAM` then sets `answer`/`tools` | **Update** fixtures to set `entries: [{kind:'text',markdown:…}, {kind:'tool',…}]`. Add a story showing interleaved text↔tool↔text to prove separation, plus a collapsed/expanded Session-card story pair. |
| `apps/web/src/components/board/TaskDetail/TaskDetail.test.tsx:63,69` | builds stream, asserts `view.answer === 'live'` | **Update** to assert `view.entries` shape (e.g. `entries[0]` is a text entry with `markdown:'live'`). |

**`logCounts` is the only cross-component consumer** (it flows Board.tsx:199 → Column.tsx:85 → TaskCard.tsx:258 as a count, never touching `answer`/`tools` shape directly). The badge semantics ("number of tool calls streamed") are preserved by the filter-and-length change above. No column-card or board code reads `answer`. Tests at Column.test.tsx pass `logCounts={{}}` literally — unaffected.

Add a focused unit test for the new fold proving interleaving + partial dedup + reseed:
- `text(partial) → tool → text(partial)` ⇒ `[text, tool, text]` with correct markdown.
- partial deltas then a `partial:false` whole-message ⇒ single text entry, no duplication.
- `events.reduce(foldSession, EMPTY_STREAM)` over a recorded sequence reproduces the live `entries` (reseed parity).

---

## KIREI HANDOFF

**Decision:** SIMPLE → `kirei-build`. Contained to TaskDetail + one data model + one derived count; no new primitive, no contract/IPC change, render-only event handling preserved.

**Files to change**
1. `apps/web/src/components/board/session-stream.ts` — replace `answer`/`tools`/`ToolLine` with `TimelineEntry`/`entries`; rewrite `foldSession` with `appendText` open/close discipline (§3.1–§3.2). Export `TimelineEntry`, `TextEntry`, `ToolEntry`.
2. `apps/web/src/components/board/TaskDetail/TaskDetail.hooks.ts` — `deriveTaskDetailView` → emit `entries` with summary fallback; add pure `summarizeSession(task)` helper (§2.3, §3.3). Update `TaskDetailView` type.
3. `apps/web/src/components/board/TaskDetail/TaskDetail.tsx` — add local `SessionCard` sub-component (§2); add local `Timeline` sub-component (§3.4); reorder body to §1; delete the five flat config `<section>`s and the split Tools + Transcript sections. Keep `LimitField` as-is. Import `BoltIcon`, `ChevronDownIcon`, `LogsIcon` from `@/components/ui`.
4. `apps/web/src/components/app/AppShell/AppShell.hooks.ts` — `logCounts` (line 609) → count tool entries via filter (§6).
5. `apps/web/src/components/board/index.ts` — add `TimelineEntry` (and friends) to the re-export if any external consumer needs it.
6. `apps/web/src/components/board/TaskDetail/TaskDetail.stories.tsx` — migrate fixtures to `entries`; add interleaved-timeline story + Session-card collapsed/expanded stories.
7. `apps/web/src/components/board/TaskDetail/TaskDetail.test.tsx` — assert `entries` shape instead of `answer`.
8. `apps/web/src/components/board/session-stream.test.ts` (new or existing) — fold interleaving + dedup + reseed-parity tests (§6).

**Build checklist**
- [ ] `entries` model + fold rewrite; partial-dedup and `toolSeq` invariants preserved.
- [ ] Reseed path (`AppShell.hooks.ts:342`) untouched and verified to rebuild identical `entries`.
- [ ] `logCounts` switched to tool-entry count; TaskCard Logs badge unchanged at runtime.
- [ ] Section order: prompts → plan → review → gauntlet → description → timeline → Session card.
- [ ] Session card: collapsed by default (open-on-`kindEditable` exception), `aria-expanded`/`aria-controls`, chevron rotate, `nc-rise` body, middot summary, reuses all five existing pickers + `LimitField` with no duplication.
- [ ] Timeline: `<ol>`, per-entry text(`<Markdown>`)/tool(boxed line) treatment, `space-y-2.5` separation, live `nc-pulse` cursor on trailing text entry only, error `<pre>` and empty/waiting copy preserved, `aria-live="polite"` while running, cursor `aria-hidden`.
- [ ] All `answer`/`tools` references removed (grep clean): `grep -rn "\.answer\b\|\.tools\b" apps/web/src/components/board apps/web/src/components/app` returns only the new `entries`/filter usage.
- [ ] `bun run typecheck` clean.
- [ ] `bun run test:web` green (updated TaskDetail + new fold tests).
- [ ] `bun run lint` clean.
- [ ] Storybook: interleaved timeline + Session collapsed/expanded render correctly; run `polish-ui` checklist on the drawer.

**Impeccable passes to run during implementation**
- `impeccable:arrange` — Session-card two-column grid + body section rhythm.
- `impeccable:harden` — timeline empty/waiting/error states and the trailing-tool no-cursor edge.
- `impeccable:polish` — final spacing/alignment pass on the drawer before done.
