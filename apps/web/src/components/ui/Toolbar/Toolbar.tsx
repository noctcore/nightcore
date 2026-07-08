/** A responsive, wrapping control row. */

import type { ToolbarProps } from './Toolbar.types';

/** A safe control row: `flex flex-wrap items-center gap-2` with every direct child
 *  pinned `shrink-0`, so controls wrap to the next line instead of squishing their
 *  text/geometry when the window is narrow. This replaces hand-rolled unguarded flex
 *  rows — the root cause of the "controls squish when the window isn't full-screen"
 *  bug. A genuinely flexible child (e.g. a search box) opts out of the pin with
 *  `min-w-0 grow basis-0` (grow + zero basis, never relying on shrink). */
export function Toolbar({ children, label, className }: ToolbarProps) {
  return (
    <div
      role={label !== undefined ? 'group' : undefined}
      aria-label={label}
      className={`flex min-w-0 flex-wrap items-center gap-2 [&>*]:shrink-0 ${className ?? ''}`}
    >
      {children}
    </div>
  );
}
