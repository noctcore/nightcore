/** Presentational sub-parts of the terminal tab bar, lifted out of `TerminalTabs.tsx`
 *  (the sanctioned `.parts.tsx` pattern) so that file stays under the 400-line ratchet.
 *  These are the three right-pinned TOOLBAR controls — self-contained widgets with no
 *  shared state, each driven purely by props. The per-tab glyphs (identity dot,
 *  attention badge, ungoverned bolt, branch chip) stay beside the `Tab` they decorate. */
import { BellIcon, BroadcastIcon, GridIcon, Kbd, TabsIcon } from '@/components/ui';

import type { TerminalViewMode } from '../terminal-layout';
import { formatShortcut } from '../terminal-platform';
import { broadcastToggleLabel, broadcastToggleTitle } from '../terminal-shared';

/** The tabs⇄grid view-mode toggle (decision 1, PR 2): a single button that flips to
 *  the OTHER mode, showing the target mode's glyph + a ⌘⇧E hint (the zoom shortcut
 *  lives in grid mode). Pinned to the right of the tab strip. */
export function ViewModeToggle({
  viewMode,
  onToggleViewMode,
}: {
  viewMode: TerminalViewMode;
  onToggleViewMode: () => void;
}) {
  const toGrid = viewMode === 'tabs';
  const label = toGrid ? 'Grid view' : 'Tabs view';
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={!toGrid}
      title={`${label}${toGrid ? ' — arrange every terminal at once' : ''}`}
      onClick={onToggleViewMode}
      className="my-0.5 flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-2xs font-medium text-muted-foreground transition-colors hover:bg-white/[0.08] hover:text-foreground"
    >
      {toGrid ? <GridIcon size={13} aria-hidden /> : <TabsIcon size={13} aria-hidden />}
      <span>{label}</span>
      {!toGrid && <Kbd>{formatShortcut('E', { shift: true })}</Kbd>}
    </button>
  );
}

/** The broadcast-input toggle (round-2 PR B, § B.3): a grid-only control that arms
 *  "type once, run everywhere" — every keystroke fans out to every visible pane. LOUD
 *  when armed (warning fill + ring + a pulsing dot) since broadcasting to N shells is a
 *  footgun; disabled (with an explanatory title) until there are 2+ visible panes. */
export function BroadcastToggle({
  armed,
  eligible,
  onToggle,
}: {
  armed: boolean;
  eligible: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={broadcastToggleLabel(armed)}
      aria-pressed={armed}
      title={broadcastToggleTitle(armed, eligible)}
      disabled={!eligible && !armed}
      onClick={onToggle}
      className={`my-0.5 flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-2xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        armed
          ? 'bg-warning/20 text-warning ring-1 ring-warning/70'
          : 'text-muted-foreground hover:bg-white/[0.08] hover:text-foreground'
      }`}
    >
      <BroadcastIcon size={13} aria-hidden />
      <span>{armed ? 'Broadcasting' : 'Broadcast'}</span>
      {armed && (
        <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-warning" />
      )}
    </button>
  );
}

/** The "jump to next waiting terminal" affordance (T11): shown in the toolbar only
 *  when one or more sessions are in the needs-attention state. LOUD (warning fill +
 *  a pulsing bell) so a backgrounded terminal that finished/asked is never missed;
 *  clicking cycles to the next waiting session and selects it. */
export function JumpAttentionButton({ count, onJump }: { count: number; onJump: () => void }) {
  const label = `Jump to the next of ${count} waiting terminal${count === 1 ? '' : 's'}`;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onJump}
      className="my-0.5 flex shrink-0 items-center gap-1.5 rounded-md bg-warning/15 px-2 py-1 text-2xs font-semibold text-warning ring-1 ring-warning/40 transition-colors hover:bg-warning/25"
    >
      <span
        aria-hidden
        className="flex animate-[nc-pulse_1.4s_ease-in-out_infinite] items-center"
      >
        <BellIcon size={13} />
      </span>
      <span>{count}</span>
    </button>
  );
}
