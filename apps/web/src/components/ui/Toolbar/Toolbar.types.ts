import type { ReactNode } from 'react';

/** Props for {@link Toolbar}. */
export interface ToolbarProps {
  children: ReactNode;
  /** Optional accessible name for the control group. When set, the row becomes a
   *  labelled `role="group"`; otherwise it's a plain presentational container. */
  label?: string;
  className?: string;
}
