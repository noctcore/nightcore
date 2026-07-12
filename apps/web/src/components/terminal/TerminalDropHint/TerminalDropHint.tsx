import { useDropHint } from './TerminalDropHint.hooks';
import type { TerminalDropHintProps } from './TerminalDropHint.types';

/** The drag-over drop-hint overlay (round-2 PR C, § C.2): rendered over the pane under a
 *  dragged file so the drop target is unmistakable. `pointer-events-none` so it never
 *  intercepts the position hit-test (`elementFromPoint` skips pointer-events:none
 *  elements) or the xterm surface — it is purely visual. Dropping types the file's
 *  shell-escaped absolute path at the prompt (the user then presses Enter). Attached to
 *  the pane's CONTAINER div, never the moved-between-parents xterm host (§ C.4). */
export function TerminalDropHint({ className }: TerminalDropHintProps) {
  const { label, ariaLabel } = useDropHint();
  return (
    <div
      role="status"
      aria-label={ariaLabel}
      className={`pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-md border-2 border-dashed border-primary/80 bg-primary/10 backdrop-blur-[1px] ${className ?? ''}`}
    >
      <span className="rounded-md bg-primary px-2.5 py-1 text-2xs font-semibold text-primary-foreground shadow-lg">
        {label}
      </span>
    </div>
  );
}
