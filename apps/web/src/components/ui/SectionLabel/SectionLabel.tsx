/** The shared uppercase mono section/field label used across the run + settings forms. */
import type { ReactNode } from 'react';

/** The canonical section-label class — mono, micro (10px), uppercase, wide-tracked,
 *  muted. Exported for the section headings that need a different element (an
 *  `<h4>`, a decorative flex row with an icon) or compose extra layout classes. */
export const SECTION_LABEL_CLASS =
  'font-mono text-3xs uppercase tracking-[0.1em] text-muted-foreground';

/** A small uppercase mono section/field label (e.g. "Run config", "Mode",
 *  "Reasoning effort"). Renders a `<span>`; pass `className` for extra layout. */
export function SectionLabel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <span className={`${SECTION_LABEL_CLASS} ${className ?? ''}`}>{children}</span>;
}
